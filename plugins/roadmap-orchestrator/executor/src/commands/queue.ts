// The durable command queue (DESIGN §2.3, plan "Commands"): files in the run dir, never state.
//
//   commands/incoming/<id>.json             written once by the CLI (`submitCommand`), atomically (temp + link)
//   commands/receipts/<id>.<state>.json     written once each by the executor, atomically too: `accepted` at pickup, then
//                                           exactly one of `applied` (naming the `command.apply` op and the
//                                           postconditions it verified) or `rejected{reason}`
//
// The executor polls every POLL_MS (`pollCommands`): each incoming command without a terminal receipt is
// pending, and gets its `accepted` receipt on first sight. An accepted command is not done; only the
// terminal receipt is. Ids are minted time-ordered (`newCommandId`), so id order is submission order.
//
// M4a (K9, R26, H21): `brief --ack` enqueues its `ack` commands under deterministic ids (`ackCommandId`: the pending
// marker's `at` and each item's ordinal), idempotently (`enqueueCommand`): a rerun after a crash finds its own files.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AlreadyExistsError, durableMkdir, exclusivePublish } from '../core/fsx.ts';
import { type ArcId, type CommandId, type Sha256Hex, commandId, sha256 } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import {
  CONTROL_COMMANDS, type CommandBody, type CommandFile, type Receipt, commandFile, receipt,
} from '../core/records.ts';
import { type AbsPath, type IsoTime, absPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';

/** How often the executor looks for new commands. */
export const POLL_MS = 1_000;

export const COMMANDS_DIR = 'commands';
const INCOMING = 'incoming';
const RECEIPTS = 'receipts';
const INCOMING_NAME = /^(cmd-[0-9a-f]{16})\.json$/;

export type ReceiptState = Receipt['state'];

const incomingDir = (runDir: AbsPath): AbsPath => absPath(join(runDir, COMMANDS_DIR, INCOMING));
const receiptsDir = (runDir: AbsPath): AbsPath => absPath(join(runDir, COMMANDS_DIR, RECEIPTS));
export const incomingPath = (runDir: AbsPath, id: CommandId): AbsPath => absPath(join(incomingDir(runDir), `${id}.json`));
export const receiptPath = (runDir: AbsPath, id: CommandId, state: ReceiptState): AbsPath => absPath(join(receiptsDir(runDir), `${id}.${state}.json`));

export const isControl = (body: CommandBody): boolean => (CONTROL_COMMANDS as readonly string[]).includes(body.type);

/**
 * `cmd-` + 12 hex of the millisecond clock + 4 random hex: ids sort in submission order (to the
 * millisecond), and two CLIs submitting in the same millisecond still get distinct ids.
 */
export function newCommandId(): CommandId {
  return commandId(`cmd-${Date.now().toString(16).padStart(12, '0')}${randomBytes(2).toString('hex')}`);
}

/** The ordinals an ack command id can carry (4 hex). */
export const MAX_ACK_ITEMS = 0x1_0000;

/**
 * R26 (K9, H21): the id of a brief ack's command: `cmd-` + 12 hex of the pending marker's `at` (ms) + 4 hex of the item's
 * ordinal (0-based) in the marker's sorted unique item list. It keeps `newCommandId`'s form and submission order, and two
 * items of one marker never collide; more than `MAX_ACK_ITEMS` items fail loud.
 */
export function ackCommandId(at: IsoTime, ordinal: number): CommandId {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= MAX_ACK_ITEMS) throw new Error(`ack command ordinal ${ordinal} outside 0..${MAX_ACK_ITEMS - 1} (one brief acks at most ${MAX_ACK_ITEMS} items)`);
  return commandId(`cmd-${Date.parse(at).toString(16).padStart(12, '0')}${ordinal.toString(16).padStart(4, '0')}`);
}

const commandBytes = (file: CommandFile): string => canonicalJson(commandFile(JSON.parse(canonicalJson(file)), 'command'));

/** CLI side: writes one command, atomically and write-once. The run dir must exist (a started arc). */
export function submitCommand(runDir: AbsPath, arc: ArcId, body: CommandBody): CommandFile {
  if (!existsSync(runDir)) throw new Error(`run dir ${runDir} does not exist; has arc ${arc} been started on this repo?`);
  const file: CommandFile = { v: SCHEMA_VERSION, id: newCommandId(), arc, at: isoTimeOf(new Date()), body };
  durableMkdir(incomingDir(runDir));
  exclusivePublish(incomingPath(runDir, file.id), commandBytes(file));
  return file;
}

/**
 * Writes a command whose id and `at` the caller fixed (a brief ack's, R26), idempotently: an incoming file with these
 * exact bytes is already enqueued; one with other bytes under the id is a bug and fails loud. Returns whether it wrote.
 */
export function enqueueCommand(runDir: AbsPath, file: CommandFile): boolean {
  if (!existsSync(runDir)) throw new Error(`run dir ${runDir} does not exist; has arc ${file.arc} been started on this repo?`);
  const bytes = commandBytes(file);
  const path = incomingPath(runDir, file.id);
  durableMkdir(incomingDir(runDir));
  try {
    exclusivePublish(path, bytes);
    return true;
  } catch (error) {
    if (!(error instanceof AlreadyExistsError)) throw error;
    if (readFileSync(path, 'utf8') !== bytes) throw new Error(`${path} exists with other bytes than the command ${file.id} enqueued again`);
    return false;
  }
}

export type IncomingCommand = Readonly<{ file: CommandFile; sha256: Sha256Hex }>;

/** One incoming command and the sha256 of its exact bytes (what `command.apply` records). */
export function readCommand(runDir: AbsPath, id: CommandId, arc: ArcId): IncomingCommand {
  const path = incomingPath(runDir, id);
  const bytes = readFileSync(path);
  const file = commandFile(JSON.parse(bytes.toString('utf8')), `${INCOMING}/${id}.json`);
  if (file.id !== id) throw new Error(`${path} carries id ${file.id}`);
  if (file.arc !== arc) throw new Error(`${path} is a command for arc ${file.arc}, in the run dir of arc ${arc}`);
  return { file, sha256: sha256(sha256Hex(bytes)) };
}

export function readReceipt(runDir: AbsPath, id: CommandId, state: ReceiptState): Receipt | null {
  const path = receiptPath(runDir, id, state);
  if (!existsSync(path)) return null;
  const r = receipt(JSON.parse(readFileSync(path, 'utf8')), `${RECEIPTS}/${id}.${state}.json`);
  if (r.command !== id || r.state !== state) throw new Error(`${path} holds a ${r.state} receipt of ${r.command}`);
  return r;
}

/** The terminal receipt (`applied` or `rejected`), or null while the command is pending. */
export function terminalReceipt(runDir: AbsPath, id: CommandId): Receipt | null {
  const applied = readReceipt(runDir, id, 'applied');
  const rejected = readReceipt(runDir, id, 'rejected');
  if (applied !== null && rejected !== null) throw new Error(`command ${id} has both an applied and a rejected receipt`);
  return applied ?? rejected;
}

/**
 * Writes a receipt once, atomically (a `status` read never sees it empty), and returns the sha256 of its
 * bytes. A second write of any state is a bug.
 */
export function writeReceipt(runDir: AbsPath, r: Receipt): Sha256Hex {
  const bytes = canonicalJson(receipt(JSON.parse(canonicalJson(r)), 'receipt'));
  durableMkdir(receiptsDir(runDir));
  exclusivePublish(receiptPath(runDir, r.command, r.state), bytes);
  return sha256(sha256Hex(bytes));
}

export const receiptSha256 = (runDir: AbsPath, id: CommandId, state: ReceiptState): Sha256Hex =>
  sha256(sha256Hex(readFileSync(receiptPath(runDir, id, state))));

/** The ids of the incoming commands without a terminal receipt, in id order; read-only (`roadmap gc` reads it too). */
export function pendingCommandIds(runDir: AbsPath): readonly CommandId[] {
  const dir = incomingDir(runDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const m = INCOMING_NAME.exec(name);
    return m === null ? [] : [commandId(m[1])];
  }).sort().filter((id) => terminalReceipt(runDir, id) === null);
}

/**
 * Every pending command (no terminal receipt), in id order. A command seen for the first time gets its
 * `accepted` receipt here. Re-polling returns the same pending set and writes nothing new.
 */
export function pollCommands(runDir: AbsPath, arc: ArcId): readonly CommandFile[] {
  const pending: CommandFile[] = [];
  for (const id of pendingCommandIds(runDir)) {
    const { file } = readCommand(runDir, id, arc);
    if (readReceipt(runDir, id, 'accepted') === null) {
      writeReceipt(runDir, { v: SCHEMA_VERSION, command: id, state: 'accepted', at: isoTimeOf(new Date()) });
    }
    pending.push(file);
  }
  return pending;
}
