// The host residue index, `residues.jsonl`: what a failed cleanup left behind, keyed per resource
// `(arc, unit, inv, resource)` (R11), and how each residue was disposed of. It outlives arcs (a residue
// blocks every later start on this host until disposed), which is why it lives in the host directory and
// not in a run's event log.
//
// Lines follow the event log's rules: canonical JSON chained by the sha256 of the previous line's bytes
// (`parseChainLine`, `prevHash` from events.ts), appended with a full write and fsync. The tail rule is
// the log's: after verifying the valid prefix, only a terminal suffix without `\n` may be discarded. It
// is saved durably as `residues.torn.<offset>.<sha8>` and truncated away, by a host-lock holder only; the
// pre-claim startup check reads read-only and leaves such a suffix alone. The index has no fact record,
// so the saved fragment file itself is the record of the discard. Any invalid complete line refuses
// (LogCorruptError, reported as `log-corrupt`).
//
// Record rules (checked on read and before every append): one `residue` per key; a `disposition` only for
// a key with a residue, at most once. A needs-user `ack` is not a disposition: only `cleaned` (a sweep),
// `isolated` or `transferred` (a needs-user choice) free a residue. Compaction is M3.
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { type ChainEnvelope, type ResidueLine, parseChainLine, prevHash, serializeChainLine } from '../core/events.ts';
import { appendSync, durableWrite, exclusiveCreate } from '../core/fsx.ts';
import { type Sha256Hex, sha256 } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { LogCorruptError } from '../core/log.ts';
import { type ResidueKey, type ResidueRecord, residueRecord } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import type { StartupCheck } from '../preflight/startup.ts';
import { RESIDUES, hostPath } from './hostdir.ts';

export type ResidueEntry = Extract<ResidueRecord, { type: 'residue' }>;
export type DispositionEntry = Extract<ResidueRecord, { type: 'disposition' }>;

export const residueFragmentName = (offset: number, digest: Sha256Hex): string => `residues.torn.${offset}.${digest.slice(0, 8)}`;

const keyOf = (key: ResidueKey): string => canonicalJson(key);

class RuleError extends Error {}

/** The index folded: every line, and per key its residue and disposition. */
class ResidueFold {
  readonly lines: ResidueLine[] = [];
  readonly residues = new Map<string, ResidueEntry>();
  readonly dispositions = new Map<string, DispositionEntry>();
  lastHash: Sha256Hex | null = null;

  /** Throws RuleError when `record` may not follow what is already folded. */
  check(record: ResidueRecord): void {
    const k = keyOf(record.key);
    if (record.type === 'residue') {
      if (this.residues.has(k)) throw new RuleError(`a second residue for key ${k}`);
      return;
    }
    if (!this.residues.has(k)) throw new RuleError(`a disposition for key ${k}, which has no residue`);
    if (this.dispositions.has(k)) throw new RuleError(`a second disposition for key ${k}`);
  }

  apply(line: ResidueLine, hash: Sha256Hex): void {
    if (line.seq !== this.lines.length + 1) throw new RuleError(`seq ${line.seq} after seq ${this.lines.length}`);
    if (line.prev !== this.lastHash) throw new RuleError(`prev ${line.prev} does not chain to ${this.lastHash}`);
    const record = bodyOf(line);
    this.check(record);
    const k = keyOf(record.key);
    if (record.type === 'residue') this.residues.set(k, record);
    else this.dispositions.set(k, record);
    this.lines.push(line);
    this.lastHash = hash;
  }
}

function bodyOf(line: ResidueLine): ResidueRecord {
  const { v: _v, seq: _s, prev: _p, at: _a, ...record } = line;
  return record as ResidueRecord;
}

const parseResidueLine = (text: string): ResidueLine => parseChainLine(text, residueRecord, 'residue');

/**
 * Verifies the index and returns the fold. An absent file is an empty index. `owner` (a caller holding the
 * host lock, about to append or acting on the index) applies the tail rule. `read-only` (a reader that may
 * run beside a live executor, such as the startup check before the host claim) treats a terminal suffix
 * without `\n` as an append in flight: not yet written, left out, never saved or truncated. The file is
 * read once, so a line completing during the read is wholly in or wholly out. Both refuse an invalid
 * complete line.
 */
function load(dir: AbsPath, mode: 'owner' | 'read-only'): ResidueFold {
  const path = hostPath(dir, RESIDUES);
  const fold = new ResidueFold();
  if (!existsSync(path)) return fold;
  const bytes = readFileSync(path);
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let start = 0;
  for (let nl = bytes.indexOf(0x0a, start); nl !== -1; nl = bytes.indexOf(0x0a, start)) {
    const line = bytes.subarray(start, nl + 1);
    try {
      fold.apply(parseResidueLine(utf8.decode(line.subarray(0, -1))), prevHash(line));
    } catch (error) {
      if (error instanceof SchemaError || error instanceof RuleError || error instanceof TypeError) {
        throw new LogCorruptError(path, start, error.message);
      }
      throw error;
    }
    start = nl + 1;
  }
  if (mode === 'owner' && start < bytes.length) discardTail(dir, path, bytes.subarray(start), start);
  return fold;
}

function discardTail(dir: AbsPath, path: AbsPath, fragment: Buffer, offset: number): void {
  // Content-addressed: a crash before the truncate rewrites the same file at the next read.
  durableWrite(hostPath(dir, residueFragmentName(offset, sha256(sha256Hex(fragment)))), fragment);
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Every line of the index, after verification and the tail rule. */
export function readResidues(dir: AbsPath): readonly ResidueLine[] {
  return load(dir, 'owner').lines;
}

function append(dir: AbsPath, fold: ResidueFold, record: ResidueRecord): void {
  const path = hostPath(dir, RESIDUES);
  if (!existsSync(path)) exclusiveCreate(path, '');
  fold.check(record);
  const envelope: ChainEnvelope = { v: SCHEMA_VERSION, seq: fold.lines.length + 1, prev: fold.lastHash, at: isoTimeOf(new Date()) };
  const text = serializeChainLine<ResidueRecord>({ ...envelope, ...record } as ResidueLine);
  // What we write must be what the next read accepts.
  const bytes = Buffer.from(text, 'utf8');
  fold.apply(parseResidueLine(text.slice(0, -1)), prevHash(bytes));
  const fd = openSync(path, 'a');
  try {
    appendSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends `residue` unless its key already has one (then it must be the same record, or this throws).
 * Returns once the line is durable. Idempotent, so a reconciler may re-run it after a crash.
 */
export function recordResidue(dir: AbsPath, residue: ResidueEntry): 'appended' | 'present' {
  const fold = load(dir, 'owner');
  const existing = fold.residues.get(keyOf(residue.key));
  if (existing !== undefined) {
    if (canonicalJson(existing) !== canonicalJson(residue)) {
      throw new Error(`residue ${keyOf(residue.key)} is already recorded differently: ${canonicalJson(existing)}`);
    }
    return 'present';
  }
  append(dir, fold, residue);
  return 'appended';
}

/** Appends a disposition; the same disposition again is a no-op, a different one throws. */
export function recordDisposition(dir: AbsPath, disposition: DispositionEntry): 'appended' | 'present' {
  const fold = load(dir, 'owner');
  const existing = fold.dispositions.get(keyOf(disposition.key));
  if (existing !== undefined) {
    if (canonicalJson(existing) !== canonicalJson(disposition)) {
      throw new Error(`residue ${keyOf(disposition.key)} is already disposed of differently: ${canonicalJson(existing)}`);
    }
    return 'present';
  }
  append(dir, fold, disposition);
  return 'appended';
}

const openKeys = (fold: ResidueFold): readonly ResidueKey[] =>
  [...fold.residues.entries()].filter(([k]) => !fold.dispositions.has(k)).map(([, r]) => r.key);

/** Residues neither `cleaned` nor `isolated | transferred`, in the order they were recorded. Host-lock holders only. */
export function undispositioned(dir: AbsPath): readonly ResidueKey[] {
  return openKeys(load(dir, 'owner'));
}

/**
 * Startup row `undispositioned-residue`: any undisposed residue on this host refuses the start. It runs
 * before the host claim, beside whatever executor may own the host, so it reads the index read-only.
 */
export const undispositionedResidueCheck: StartupCheck<'undispositioned-residue'> = {
  kind: 'undispositioned-residue',
  check: async (context) => {
    const residues = openKeys(load(context.hostDir, 'read-only'));
    return residues.length === 0 ? [] : [{ kind: 'undispositioned-residue', residues }];
  },
};
