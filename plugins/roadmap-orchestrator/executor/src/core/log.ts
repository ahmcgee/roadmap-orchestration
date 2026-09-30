// The journal: the one writer of `events.jsonl`, the executor's authoritative write-ahead log.
//
// Append: validate the record through the fold, write the canonical line, fsync, and only then return, so
// no caller acts on an intent that is not durable ("no act until fsync returns"). Everything here is
// synchronous, which is what serialises writers: JavaScript cannot interleave two appends, and the host
// lock guarantees one executor process per host.
//
// Open: stream the file, verifying every complete line (canonical record, contiguous seq, intact chain,
// fold invariants). The tail rule: only a terminal suffix without a `\n` (a torn last write, or the
// zero-filled tail some filesystems leave after a crash) may be discarded. It is saved durably as
// `events.torn.<offset>.<sha8>`, the log is truncated and fsynced, and a `tail-discarded` fact records it.
// A saved fragment without its fact (a crash between truncate and fact) gets the fact at the next open.
// Any invalid complete line is corruption: LogCorruptError, which startup reports as `log-corrupt`.
import {
  closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { crashPoint } from './crash.ts';
import {
  type AbortCode, type Event, type Fact, type IntentOf, type IntentRecord, type LogRecord, type OpKind, type OpOutcome,
  type RecoveredBy, parseEventLine, prevHash, recordUnit, serializeEvent,
} from './events.ts';
import { CounterRegressionError, appendSync, durableWrite, exclusiveCreate } from './fsx.ts';
import { type ArcId, type InvocationId, type OpId, type Sha256Hex, invocationId, opId, sha256 } from './ids.ts';
import type { Durable, IntentBody, Journal, JournalView, NewIntent } from './interfaces.ts';
import { sha256Hex } from './json.ts';
import { type DerivedState, Fold, FoldInvariantError, type TailDiscarded, writeStateCache } from './state.ts';
import { SchemaError } from './validate.ts';
import { type AbsPath, absPath, isoTime } from './values.ts';
import { SCHEMA_VERSION } from './version.ts';

export const EVENTS_FILE = 'events.jsonl';
export const STATE_FILE = 'state.json';
const FRAGMENT = /^events\.torn\.(0|[1-9][0-9]*)\.([0-9a-f]{8})$/;

export function fragmentName(offset: number, digest: Sha256Hex): string {
  return `events.torn.${offset}.${digest.slice(0, 8)}`;
}

/** An invalid complete line (or a fragment file that does not match its name): refuse, never repair. */
export class LogCorruptError extends Error {
  readonly file: AbsPath;
  readonly offset: number;
  readonly detail: string;
  constructor(file: AbsPath, offset: number, detail: string) {
    super(`${file} is corrupt at byte ${offset}: ${detail}`);
    this.name = 'LogCorruptError';
    this.file = file;
    this.offset = offset;
    this.detail = detail;
  }
}

export interface OpenJournal extends Journal {
  /** The fold of everything appended so far (what `state.json` caches). */
  derived(): DerivedState;
  close(): void;
}

/**
 * Opens (creating if absent) `<runDir>/events.jsonl` for `arc`: verifies it, applies the tail rule,
 * records any fragment that lacks its fact, and refreshes `state.json`. Throws LogCorruptError on corruption.
 */
export function openJournal(runDir: AbsPath, arc: ArcId): OpenJournal {
  const path = absPath(join(runDir, EVENTS_FILE));
  if (!existsSync(path)) exclusiveCreate(path, '');
  const fold = new Fold(arc);
  const { validEnd, size } = verify(path, fold);
  if (validEnd < size) discardTail(runDir, path, validEnd, size);
  const journal = new FileJournal(path, absPath(join(runDir, STATE_FILE)), fold);
  for (const fact of unrecordedFragments(runDir, fold)) journal.fact(fact);
  journal.refreshStateCache();
  return journal;
}

export type LogSnapshot = Readonly<{ view: JournalView; events: readonly Event[] }>;

/**
 * Reads a run's log without opening it for append: no lock, no tail repair, no fact, no state cache. For
 * readers beside a live executor (`roadmap status`, a previous arc's run dir at takeover). An absent log
 * is empty. Every complete line is verified and folded; a terminal suffix without `\n` is an append in
 * flight (the writer's two-part write, or a torn tail only the owner's open may repair), so it is "not yet
 * written" and left out, never raised, saved or truncated. The file is read once, so a line that completes
 * during the read is either wholly in the snapshot or wholly absent. Throws LogCorruptError on an invalid
 * complete line, as `openJournal` would.
 */
export function readJournal(runDir: AbsPath, arc: ArcId): LogSnapshot {
  const path = absPath(join(runDir, EVENTS_FILE));
  const fold = new Fold(arc);
  const events: Event[] = [];
  if (!existsSync(path)) return { view: fold, events };
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const bytes = readFileSync(path);
  let start = 0;
  for (let nl = bytes.indexOf(0x0a, start); nl !== -1; nl = bytes.indexOf(0x0a, start)) {
    events.push(verifyLine(path, fold, utf8, bytes.subarray(start, nl + 1), start));
    start = nl + 1;
  }
  return { view: fold, events };
}

// ---------------------------------------------------------------------------------------------------
// Verification

const READ_CHUNK = 1 << 20;

/**
 * Folds every complete line, reading in chunks. Returns where the unterminated suffix begins (`validEnd`,
 * equal to `size` when the file ends in `\n`).
 */
function verify(path: AbsPath, fold: Fold): { validEnd: number; size: number } {
  // fatal: invalid UTF-8 is corruption; ignoreBOM: a BOM stays in the text, so the line fails to parse.
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const chunk = Buffer.alloc(READ_CHUNK);
    let carry = Buffer.alloc(0);
    let carryOffset = 0;
    let pos = 0;
    while (pos < size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (n === 0) throw new Error(`${path}: read returned 0 bytes at ${pos} of ${size}; the file shrank while opening`);
      pos += n;
      const buf = carry.length === 0 ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      let start = 0;
      for (let nl = buf.indexOf(0x0a, start); nl !== -1; nl = buf.indexOf(0x0a, start)) {
        verifyLine(path, fold, utf8, buf.subarray(start, nl + 1), carryOffset + start);
        start = nl + 1;
      }
      carry = Buffer.from(buf.subarray(start));
      carryOffset += start;
    }
    return { validEnd: carryOffset, size };
  } finally {
    closeSync(fd);
  }
}

/** Parses and folds one complete line (its `\n` included); any failure is LogCorruptError at `offset`. */
function verifyLine(path: AbsPath, fold: Fold, utf8: TextDecoder, line: Buffer, offset: number): Event {
  try {
    const event = parseEventLine(utf8.decode(line.subarray(0, -1)));
    fold.apply(event, prevHash(line));
    return event;
  } catch (error) {
    // Exactly the failures a bad line produces: invalid UTF-8 (TypeError from the fatal decoder or a
    // non-finite number in canonicalJson), a schema or canonical-form failure, a fold invariant.
    if (error instanceof SchemaError || error instanceof FoldInvariantError || error instanceof CounterRegressionError || error instanceof TypeError) {
      throw new LogCorruptError(path, offset, error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// Tail rule

/** Save the unterminated suffix durably, then truncate it away. Its fact is recorded by `unrecordedFragments`. */
function discardTail(runDir: AbsPath, path: AbsPath, offset: number, size: number): void {
  const fragment = Buffer.alloc(size - offset);
  const rfd = openSync(path, 'r');
  try {
    let got = 0;
    while (got < fragment.length) {
      const n = readSync(rfd, fragment, got, fragment.length - got, offset + got);
      if (n === 0) throw new Error(`${path}: read returned 0 bytes at ${offset + got} of ${size}`);
      got += n;
    }
  } finally {
    closeSync(rfd);
  }
  // Content-addressed name: a crash before the truncate rewrites the same file at the next open.
  durableWrite(join(runDir, fragmentName(offset, sha256(sha256Hex(fragment)))), fragment);
  crashPoint('log.open.after-fragment-save');
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  crashPoint('log.open.after-truncate');
}

/** `tail-discarded` facts for saved fragments the log does not yet record, by ascending offset. */
function unrecordedFragments(runDir: AbsPath, fold: Fold): TailDiscarded[] {
  const recorded = fold.derived().tailDiscarded;
  const out: TailDiscarded[] = [];
  for (const name of readdirSync(runDir)) {
    const m = FRAGMENT.exec(name);
    if (m === null) continue;
    const offset = Number(m[1]);
    const file = absPath(join(runDir, name));
    const bytes = readFileSync(file);
    const digest = sha256(sha256Hex(bytes));
    if (digest.slice(0, 8) !== m[2]) throw new LogCorruptError(file, offset, `fragment content hashes to ${digest}, not its name's ${m[2]}`);
    const fact: TailDiscarded = { kind: 'tail-discarded', offset, length: bytes.length, sha256: digest };
    if (!recorded.some((r) => r.offset === offset && r.length === fact.length && r.sha256 === digest)) out.push(fact);
  }
  return out.sort((a, b) => a.offset - b.offset);
}

// ---------------------------------------------------------------------------------------------------
// Append

class FileJournal implements OpenJournal {
  readonly #path: AbsPath;
  readonly #statePath: AbsPath;
  readonly #fold: Fold;
  #fd: number | null;
  /** Set while a body callback or an append runs: a body that appends would corrupt seq allocation. */
  #busy = false;
  /** Set when a write failed midway: the fold is ahead of the file, so this journal must not append again. */
  #broken = false;

  constructor(path: AbsPath, statePath: AbsPath, fold: Fold) {
    this.#path = path;
    this.#statePath = statePath;
    this.#fold = fold;
    this.#fd = openSync(path, 'a');
  }

  get view(): JournalView {
    return this.#fold;
  }

  derived(): DerivedState {
    return this.#fold.derived();
  }

  refreshStateCache(): void {
    writeStateCache(this.#statePath, this.#fold.derived());
  }

  close(): void {
    if (this.#fd === null) throw new Error(`journal ${this.#path} is already closed`);
    closeSync(this.#fd);
    this.#fd = null;
  }

  begin<K extends OpKind>(intent: NewIntent<K>): Durable {
    return this.#exclusive(() => {
      const seq = this.#fold.highWater() + 1;
      const op = opId(this.#fold.arc, seq);
      const inv = invocationId(op, 1);
      const body = intent.body(op, inv);
      const record: IntentOf<K> = {
        type: 'intent', op, kind: intent.kind, key: intent.key, parent: intent.parent, ordinal: 1,
        deadlineAt: intent.deadlineAt, expect: body.expect, post: body.post,
      };
      return { op, inv, seq: this.#append(record as IntentRecord) };
    });
  }

  retry<K extends OpKind>(op: OpId, kind: K, body: (inv: InvocationId) => IntentBody<K>): Durable {
    return this.#exclusive(() => {
      const prev = this.#fold.latestIntent(op);
      const ordinal = prev.ordinal + 1;
      const inv = invocationId(op, ordinal);
      const { expect, post } = body(inv);
      // Key, parent and deadline are inherited, never passed; the fold refuses a kind change or a retry
      // of an ordinal that is still open or closed by anything but lost/abort.
      const record: IntentOf<K> = {
        type: 'intent', op, kind, key: prev.key, parent: prev.parent, ordinal, deadlineAt: prev.deadlineAt, expect, post,
      };
      return { op, inv, seq: this.#append(record as IntentRecord) };
    });
  }

  done<K extends OpKind>(op: OpId, kind: K, outcome: OpOutcome[K], recoveredBy: RecoveredBy): number {
    return this.#exclusive(() => this.#append({ type: 'done', op, kind, outcome, recoveredBy } as LogRecord));
  }

  abort(op: OpId, code: AbortCode, detail: string): number {
    return this.#exclusive(() => this.#append({ type: 'abort', op, reason: { code, detail } }));
  }

  fact(fact: Fact): number {
    return this.#exclusive(() => this.#append({ type: 'fact', fact }));
  }

  #exclusive<T>(fn: () => T): T {
    if (this.#busy) throw new Error(`journal ${this.#path}: re-entrant append (an intent body must not touch the journal)`);
    this.#busy = true;
    try {
      return fn();
    } finally {
      this.#busy = false;
    }
  }

  /** Writes one line durably and returns its seq. Throws before writing anything if the record is illegal. */
  #append(record: LogRecord): number {
    if (this.#fd === null) throw new Error(`journal ${this.#path} is closed`);
    if (this.#broken) throw new Error(`journal ${this.#path}: an earlier write failed; reopen to recover`);
    const seq = this.#fold.highWater() + 1;
    const draft = { v: SCHEMA_VERSION, seq, prev: this.#fold.lastHash(), at: isoTime(new Date().toISOString()), arc: this.#fold.arc, ...record } as Event;
    const line = serializeEvent(draft);
    // The line must be one the next open accepts: canonical and schema-valid, then legal under the fold.
    const event = parseEventLine(line.slice(0, -1));
    const bytes = Buffer.from(line, 'utf8');
    this.#fold.apply(event, prevHash(bytes));
    const unit = recordUnit(event, (op) => this.#fold.latestIntent(op));
    this.#broken = true;
    crashPoint('log.append.before-write', unit);
    // Two writes so a crash test can stop between them and leave a torn line. The first half's fsync is
    // one extra fsync per append; appends are rare enough that this costs nothing that matters.
    const half = bytes.length >> 1;
    appendSync(this.#fd, bytes.subarray(0, half));
    crashPoint('log.append.after-partial-write', unit);
    appendSync(this.#fd, bytes.subarray(half));
    this.#broken = false;
    crashPoint('log.append.after-fsync', unit);
    this.refreshStateCache();
    return seq;
  }
}
