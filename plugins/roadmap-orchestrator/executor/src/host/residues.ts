// The host residue index, `residues.jsonl`: what a failed cleanup left behind, keyed per resource
// `(arc, unit | job, inv, resource)` (R11, G4), and how each residue was disposed of. It outlives arcs (a residue
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
// `isolated` or `transferred` (a needs-user choice) free a residue.
//
// Compaction (M3; src/host/compact.ts) archives the whole index and rewrites it as a `compacted` head followed
// by the lines it keeps. The head continues the archived file's chain: its seq follows the archive's last seq and
// its `prev` is that line's hash, which the head also records (`prevSeq`, `prevHash`) beside the archive's name.
// A head is only ever the first line; archives chain back the same way through their own heads.
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { type ChainEnvelope, type ResidueLine, parseChainLine, prevHash, serializeChainLine } from '../core/events.ts';
import { appendSync, durableWrite, exclusiveCreate } from '../core/fsx.ts';
import { type Sha256Hex, sha256 } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { LogCorruptError } from '../core/log.ts';
import { type ResidueKey, type ResidueRecord, residueOwner, residueRecord } from '../core/records.ts';
import { type Read, SchemaError, literal, object, positive, str, tagged } from '../core/validate.ts';
import { type AbsPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { StartupCheck } from '../preflight/startup.ts';
import { RESIDUES, hostPath } from './hostdir.ts';

export type ResidueEntry = Extract<ResidueRecord, { type: 'residue' }>;
export type DispositionEntry = Extract<ResidueRecord, { type: 'disposition' }>;

export const residueFragmentName = (offset: number, digest: Sha256Hex): string => `residues.torn.${offset}.${digest.slice(0, 8)}`;

/** An archive's file name in the host dir: the archived index's last seq and the first 8 hex of that line's hash. */
export const residueArchiveName = (prevSeq: number, prevHash: Sha256Hex): string => `residues.archive.${prevSeq}.${prevHash.slice(0, 8)}.jsonl`;
export const RESIDUE_ARCHIVE = /^residues\.archive\.[1-9][0-9]*\.[0-9a-f]{8}\.jsonl$/;

/** The head of a compacted index: `archive` (in the host dir) holds the whole index it replaced, which ends at `prevSeq`. */
export type CompactedHead = Readonly<{ type: 'compacted'; archive: string; prevSeq: number; prevHash: Sha256Hex }>;
export type CompactedLine = ChainEnvelope & CompactedHead;
const compactedHead: Read<CompactedHead> = object((f): CompactedHead => {
  const head: CompactedHead = {
    type: f.get('type', literal('compacted')),
    archive: f.get('archive', str),
    prevSeq: f.get('prevSeq', positive),
    prevHash: f.get('prevHash', (v, p) => sha256(v, p)),
  };
  if (head.archive !== residueArchiveName(head.prevSeq, head.prevHash)) {
    throw new SchemaError(`${f.path}.archive`, residueArchiveName(head.prevSeq, head.prevHash), head.archive);
  }
  return head;
});
type IndexRecord = ResidueRecord | CompactedHead;
const indexRecord: Read<IndexRecord> = tagged<'compacted' | 'residue' | 'disposition', IndexRecord>('type', {
  compacted: compactedHead, residue: residueRecord, disposition: residueRecord,
});

/** A key's identity in the index: its canonical JSON. */
export const residueKeyText = (key: ResidueKey): string => canonicalJson(key);
const keyOf = residueKeyText;

class RuleError extends Error {}

/**
 * The index folded: its compacted head (if any), every other line, and per key its residue and disposition.
 * `lastSeq` and `lastHash` are the last line's (the head's when no line follows it; 0 and null when empty).
 */
class ResidueFold {
  head: CompactedLine | null = null;
  readonly lines: ResidueLine[] = [];
  readonly residues = new Map<string, ResidueEntry>();
  readonly dispositions = new Map<string, DispositionEntry>();
  lastSeq = 0;
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

  apply(line: ResidueLine | CompactedLine, hash: Sha256Hex): void {
    if (line.type === 'compacted') {
      if (this.lastSeq !== 0) throw new RuleError(`a compacted head after seq ${this.lastSeq}: a head is only ever the first line`);
      if (line.seq !== line.prevSeq + 1 || line.prev !== line.prevHash) {
        throw new RuleError(`compacted head (seq ${line.seq}, prev ${line.prev}) does not continue its archive (seq ${line.prevSeq}, hash ${line.prevHash})`);
      }
      this.head = line;
    } else {
      if (line.seq !== this.lastSeq + 1) throw new RuleError(`seq ${line.seq} after seq ${this.lastSeq}`);
      if (line.prev !== this.lastHash) throw new RuleError(`prev ${line.prev} does not chain to ${this.lastHash}`);
      const record = bodyOf(line);
      this.check(record);
      const k = keyOf(record.key);
      if (record.type === 'residue') this.residues.set(k, record);
      else this.dispositions.set(k, record);
      this.lines.push(line);
    }
    this.lastSeq = line.seq;
    this.lastHash = hash;
  }
}

/** A line's record, without its chain envelope. */
export function bodyOf(line: ResidueLine): ResidueRecord {
  const { v: _v, seq: _s, prev: _p, at: _a, ...record } = line;
  return record as ResidueRecord;
}

const parseIndexLine = (text: string): ResidueLine | CompactedLine => parseChainLine<IndexRecord>(text, indexRecord, 'residue') as ResidueLine | CompactedLine;

/**
 * Folds `bytes`, the index file at `path`. Returns the fold and where its unterminated suffix begins
 * (`bytes.length` when it ends in `\n`). Refuses an invalid complete line (LogCorruptError).
 */
function foldBytes(path: AbsPath, bytes: Buffer): Readonly<{ fold: ResidueFold; end: number }> {
  const fold = new ResidueFold();
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let start = 0;
  for (let nl = bytes.indexOf(0x0a, start); nl !== -1; nl = bytes.indexOf(0x0a, start)) {
    const line = bytes.subarray(start, nl + 1);
    try {
      fold.apply(parseIndexLine(utf8.decode(line.subarray(0, -1))), prevHash(line));
    } catch (error) {
      if (error instanceof SchemaError || error instanceof RuleError || error instanceof TypeError) {
        throw new LogCorruptError(path, start, error.message);
      }
      throw error;
    }
    start = nl + 1;
  }
  return { fold, end: start };
}

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
  if (!existsSync(path)) return new ResidueFold();
  const bytes = readFileSync(path);
  const { fold, end } = foldBytes(path, bytes);
  if (mode === 'owner' && end < bytes.length) discardTail(dir, path, bytes.subarray(end), end);
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

/** Every residue and disposition line of the index (not its compacted head), after verification and the tail rule. */
export function readResidues(dir: AbsPath): readonly ResidueLine[] {
  return load(dir, 'owner').lines;
}

/** The index folded, as compaction reads it. */
export type ResidueIndex = Readonly<{
  head: CompactedLine | null;
  lines: readonly ResidueLine[];
  residues: ReadonlyMap<string, ResidueEntry>;
  dispositions: ReadonlyMap<string, DispositionEntry>;
  lastSeq: number;
  lastHash: Sha256Hex | null;
}>;

/** The whole index after verification and the tail rule. Host-lock holders only. */
export function readResidueIndex(dir: AbsPath): ResidueIndex {
  return load(dir, 'owner');
}

/** Verifies `bytes` as a whole index file for `dir`, every line complete: what a rewrite must pass before it is written. */
export function verifyIndexBytes(dir: AbsPath, bytes: Buffer): ResidueIndex {
  const { fold, end } = foldBytes(hostPath(dir, RESIDUES), bytes);
  if (end !== bytes.length) throw new Error(`an index rewrite of ${bytes.length} bytes ends in an unterminated line at byte ${end}`);
  return fold;
}

function append(dir: AbsPath, fold: ResidueFold, record: ResidueRecord): void {
  const path = hostPath(dir, RESIDUES);
  if (!existsSync(path)) exclusiveCreate(path, '');
  fold.check(record);
  const envelope: ChainEnvelope = { v: SCHEMA_VERSION, seq: fold.lastSeq + 1, prev: fold.lastHash, at: isoTimeOf(new Date()) };
  const text = serializeChainLine<ResidueRecord>({ ...envelope, ...record } as ResidueLine);
  // What we write must be what the next read accepts.
  const bytes = Buffer.from(text, 'utf8');
  fold.apply(parseIndexLine(text.slice(0, -1)), prevHash(bytes));
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

/**
 * A9: whether the arc whose log `view` is owns the residue `key`, so the residue does not refuse that arc's start
 * or respawn. Ownership is proven by a `resource.transition{fail}` intent of this arc, open or done (never an
 * aborted one), held by the key's owner (a stage of its unit, or its job, G4), whose residues name the key's
 * resource with its teardown invocation. The
 * intent is durable before any residue (reserve.ts), so this holds across the whole lifecycle (F2): the residue
 * appended while `fail` is still open, `cleanup-failed`, a retry's reclaim (`cleaning`), and a teardown passed
 * before the disposition. Another arc's residue is never owned. The startup row reads the log read-only
 * (`readJournal`) before the claim.
 */
export function ownArcResidue(view: JournalView, key: ResidueKey): boolean {
  if (key.arc !== view.arc) return false;
  const owner = residueOwner(key);
  const open = new Set(view.openIntents().map((i) => i.op));
  return view.opsOf('resource.transition').some((i) => {
    const { holder, edge } = i.expect;
    if (edge.type !== 'fail') return false;
    if (owner.type === 'unit' ? holder.type !== 'stage' || holder.unit !== owner.unit : holder.type !== 'job' || holder.job !== owner.job) return false;
    if (!open.has(i.op) && view.doneOf(i.op) === null) return false;
    return edge.residues.some((r) => r.resource === key.resource && r.teardown === key.inv);
  });
}
