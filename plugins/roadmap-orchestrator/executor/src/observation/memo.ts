// What a long-lived observer remembers across captures: the answers of git commands that name only object ids, the
// write-once records of a run directory, and parsed content-addressed inputs. A one-shot reader (`roadmap status`, the CLI's
// local fallback) and the executor run without one and read every record and git answer, as before.
//
// Memory is bounded by bytes, not by how much evidence or history an arc has: git answers by GIT_BYTES and records by
// RECORD_BYTES, each least recently used first, and neither keeps one entry heavier than an eighth of its bound (it would
// flush every other entry and then itself). A record the capture under way has used is never dropped for another, so a
// capture that reads more than RECORD_BYTES keeps a stable set and reads only the rest again. Parsed values, and values fixed
// by a git object id (an arc ref's digest), are kept only while captures ask for them (`settle`). The stamps of records read
// are not bounded by bytes: they are what the integrity sweep re-checks, one short string per record read. Without a memo,
// parsed content-addressed inputs are still parsed once per slot (`parsedOnce`): the executor asks for them every tick.
import { lstatSync } from 'node:fs';

/** A git command's answer, as the memo keeps it. */
export type Spawned = Readonly<{ code: number; stdout: string | Buffer }>;
/** What the memo did, counted since it was made: `recordReads` counts records found and read. Product telemetry: the console reports it per capture. */
export type MemoWork = { gitSpawns: number; gitHits: number; recordReads: number; recordHits: number };

const GIT_BYTES = 64 * 1024 * 1024;
/** The weighed bytes of remembered records (see `weightOf`). */
export const RECORD_BYTES = 128 * 1024 * 1024;
/** What the memo holds, for the console's heap reports. */
export type MemoSizes = Readonly<{ records: number; recordBytes: number; recordEvictions: number; recordOverflow: number; gitAnswers: number; gitBytes: number; stamps: number; parsed: number }>;
const OBJECT = /^[0-9a-f]{40}(\^\{tree\}|:.*)?$/;
const COMMANDS = new Set(['diff-tree', 'ls-tree', 'cat-file', 'log', 'merge-base', 'rev-parse']);
/** Options that make a command read refs, reflogs or the repository's layout, so its answer can change. */
const MUTABLE_OPTION = /^(--(all|branches|tags|remotes|glob|exclude|fork-point|reflog|walk-reflogs|bisect|decorate|source|git-dir|git-common-dir|absolute-git-dir|show-|is-|local-env|resolve-git-dir|symbolic|abbrev-ref|default)|-g$)/;
const OBJECT_TYPES = new Set(['blob', 'tree', 'commit', 'tag']);

/**
 * Whether a git command's answer is fixed by its arguments: one of the read commands above, with no option that reads refs,
 * and every revision argument (and every stdin line) a full object id, optionally with `^{tree}` or `:path`. A ref name is
 * never memoized: it moves.
 */
export function immutableGit(args: readonly string[], input: string | Uint8Array | undefined): boolean {
  const [command, ...rest] = args;
  if (command === undefined || !COMMANDS.has(command)) return false;
  let revisions = 0;
  for (const arg of rest) {
    if (arg.startsWith('-')) {
      if (MUTABLE_OPTION.test(arg) || /%[dDS]/.test(arg)) return false;
      continue;
    }
    if (command === 'cat-file' && OBJECT_TYPES.has(arg)) continue;
    if (!OBJECT.test(arg)) return false;
    revisions++;
  }
  if (input !== undefined) {
    const lines = (typeof input === 'string' ? input : Buffer.from(input).toString('utf8')).split('\n').filter((l) => l !== '');
    if (lines.length === 0 || !lines.every((l) => OBJECT.test(l))) return false;
    return true;
  }
  return revisions > 0;
}

export class RecordMemo {
  readonly work: MemoWork = { gitSpawns: 0, gitHits: 0, recordReads: 0, recordHits: 0 };
  #git = new Map<string, Spawned>();
  #gitBytes = 0;
  /** Remembered records by `form\0path`, least recently used first, with each one's weight. */
  #records = new Map<string, { readonly value: unknown; readonly path: string; readonly bytes: number; used: number }>();
  /** Counts captures (`beginCapture`): a record used in the capture under way is never dropped for another. */
  #generation = 0;
  #recordBytes = 0;
  #recordEvictions = 0;
  /** Records read but not kept because the capture under way already used every kept one. */
  #recordOverflow = 0;
  /** Each path's kept forms (their keys in `#records`). */
  #forms = new Map<string, string[]>();
  /** Each write-once record read, with its stamp taken before the read: what the integrity sweep re-checks. */
  #stamps = new Map<string, string>();
  #parsed = new Map<string, unknown>();
  #objects = new Map<string, unknown>();
  /** Parsed and object values asked for since the last `settle`. */
  #asked = new Set<string>();
  /** Answers of commands that can move, for the capture under way (`withRecordMemo` starts one). */
  #capture = new Map<string, Spawned>();
  /** A new capture: what moving commands answered in the last one is asked again. */
  beginCapture(): void { this.#capture.clear(); this.#generation++; }
  /**
   * The answer of an immutable git command (`key` names it), run once; `key` null: a command that is run every time. Only a
   * success is remembered, or an answer `settled` says is final: an object missing now can be fetched later.
   */
  git<T extends Spawned>(key: string | null, run: () => T, settled: (answer: T) => boolean = (a) => a.code === 0, moving: string | null = null): T {
    if (key !== null) {
      const hit = this.#git.get(key);
      if (hit !== undefined) { this.#git.delete(key); this.#git.set(key, hit); this.work.gitHits++; return hit as T; }
    }
    // A command whose answer can move (a ref lookup) is answered once per capture: one capture reads one value of each ref.
    if (moving !== null) {
      const hit = this.#capture.get(moving);
      if (hit !== undefined) { this.work.gitHits++; return hit as T; }
    }
    this.work.gitSpawns++;
    const answer = run();
    if (moving !== null) this.#capture.set(moving, answer);
    if (key === null || !settled(answer) || answer.stdout.length > GIT_BYTES / 8) return answer;
    this.#git.set(key, answer); this.#gitBytes += answer.stdout.length;
    for (const [old, value] of this.#git) {
      if (this.#gitBytes <= GIT_BYTES) break;
      this.#git.delete(old); this.#gitBytes -= value.stdout.length;
    }
    return answer;
  }
  /**
   * A write-once record, kept from its second read on: a record read once (a settled invocation's launch record, read for its
   * row) is not held for nothing. Absence is never remembered: the record may land later. A hit makes it the most recently used;
   * past RECORD_BYTES the least recently used that this capture has not used are dropped (their stamps stay: the record was read,
   * and the sweep re-checks it).
   */
  record<T>(form: string, path: string, read: () => T | null): T | null {
    // Readers keep different forms of one file (its text, its parsed record): each is kept under its own key.
    const key = `${form}\0${path}`;
    const hit = this.#records.get(key);
    if (hit !== undefined) { hit.used = this.#generation; this.#records.delete(key); this.#records.set(key, hit); this.work.recordHits++; return hit.value as T; }
    const seen = this.#stamps.get(path), stamp = seen ?? stampOf(path);
    const value = read();
    // A record found absent costs a stat, and is looked for again.
    if (value === null) return value;
    this.work.recordReads++;
    if (seen === undefined) { this.#stamps.set(path, stamp); return value; }
    // Stamped missing (the record landed between its stat and its read): the sweep finds it changed and it is read again.
    if (seen === 'missing') return value;
    const bytes = weightOf(value, seen);
    if (bytes > RECORD_BYTES / 8) return value;
    // Room is made from records no read of this capture used. When every kept record was used in it, this one is not kept: a
    // capture that reads more than RECORD_BYTES keeps a stable set and reads the rest again, never the whole set.
    for (const [old, kept] of this.#records) {
      if (this.#recordBytes + bytes <= RECORD_BYTES || kept.used === this.#generation) break;
      this.#drop(old, kept.path); this.#recordEvictions++;
    }
    if (this.#recordBytes + bytes > RECORD_BYTES) { this.#recordOverflow++; return value; }
    this.#records.set(key, { value, path, bytes, used: this.#generation }); this.#recordBytes += bytes;
    this.#forms.set(path, [...(this.#forms.get(path) ?? []), key]);
    return value;
  }
  #drop(key: string, path: string): void {
    const kept = this.#records.get(key);
    if (kept === undefined) return;
    this.#records.delete(key); this.#recordBytes -= kept.bytes;
    const forms = this.#forms.get(path)!.filter((k) => k !== key);
    if (forms.length === 0) this.#forms.delete(path); else this.#forms.set(path, forms);
  }
  /** A write-once record read past the memo (runner.json, rewritten once while open): the sweep re-checks it from now on. */
  track(path: string): void { if (!this.#stamps.has(path)) { const stamp = stampOf(path); if (stamp !== 'missing') this.#stamps.set(path, stamp); } }
  /** The records the sweep re-checks, with the stamp each had when read. */
  stamped(): ReadonlyMap<string, string> { return this.#stamps; }
  /** A value parsed from content-addressed bytes (`key` carries their hash), parsed once while captures keep asking for it. */
  parsed<T>(key: string, parse: () => T): T {
    this.#asked.add(key);
    if (this.#parsed.has(key)) return this.#parsed.get(key) as T;
    const value = parse();
    this.#parsed.set(key, value);
    return value;
  }
  /**
   * A value fixed by a git object id (`key` carries it: an arc ref's digest at one commit), computed once while captures keep
   * asking for it. No record of the run directory can change it, so `forget` leaves it.
   */
  object<T>(key: string, read: () => T): T {
    this.#asked.add(key);
    if (this.#objects.has(key)) return this.#objects.get(key) as T;
    const value = read();
    this.#objects.set(key, value);
    return value;
  }
  /** Drops every parsed or object value not asked for since the previous `settle`: the observer calls it after each full capture. */
  settle(): void {
    for (const held of [this.#parsed, this.#objects]) for (const key of held.keys()) if (!this.#asked.has(key)) held.delete(key);
    this.#asked.clear();
  }
  sizes(): MemoSizes {
    return { records: this.#records.size, recordBytes: this.#recordBytes, recordEvictions: this.#recordEvictions, recordOverflow: this.#recordOverflow, gitAnswers: this.#git.size,
      gitBytes: this.#gitBytes, stamps: this.#stamps.size, parsed: this.#parsed.size + this.#objects.size };
  }
  /**
   * Forgets these records (found rewritten or removed). When one of them was a record this memo had read, every parsed value
   * goes too: it may rest on it. A path the memo never read (the schedule, an open invocation's output) forgets nothing.
   */
  forget(paths: readonly string[]): void {
    let read = false;
    for (const path of paths) { for (const key of this.#forms.get(path) ?? []) this.#drop(key, path); if (this.#stamps.delete(path)) read = true; }
    if (read) for (const key of this.#parsed.keys()) { this.#parsed.delete(key); this.#asked.delete(key); }
  }
}

let ambient: RecordMemo | null = null;
/** Runs `read` with the memo call sites (git, runner records, evidence records, kept inputs) answered from `memo`. */
export function withRecordMemo<T>(memo: RecordMemo, read: () => T): T {
  const previous = ambient;
  ambient = memo; memo.beginCapture();
  try { return read(); } finally { ambient = previous; }
}
/** Runs `read` without the ambient memo: for records that can still change (an open invocation's, which its runner writes). */
export function withoutRecordMemo<T>(read: () => T): T {
  const previous = ambient;
  ambient = null;
  try { return read(); } finally { ambient = previous; }
}
/** The memo the current read runs under, or null for a one-shot reader. */
export const recordMemo = (): RecordMemo | null => ambient;
/** `read` of a write-once record at `path`, through the ambient memo when there is one. */
export const writeOnce = <T>(form: string, path: string, read: () => T | null): T | null => ambient === null ? read() : ambient.record(form, path, read);
/** Outside an ambient memo, the latest parse of each slot (see `parsedOnce`), for the life of the process. */
const latestParsed = new Map<string, Readonly<{ key: string; value: unknown }>>();
/**
 * `parse` of content-addressed bytes named by `key` (`<slot>:<hash>`: its last part the bytes' hash, what precedes it the
 * slot, e.g. `plan`, `spec:<unit>`), through the ambient memo when there is one. Without one (the executor, a one-shot
 * reader) the latest parse of each slot is kept: the bytes named by a hash never change, so asking again for the same key
 * parses nothing, and a new revision's key replaces its slot's predecessor.
 */
export const parsedOnce = <T>(key: string, parse: () => T): T => {
  if (ambient !== null) return ambient.parsed(key, parse);
  const at = key.lastIndexOf(':');
  if (at <= 0) throw new Error(`parsedOnce: key ${key} names no slot`);
  const slot = key.slice(0, at);
  const hit = latestParsed.get(slot);
  if (hit?.key === key) return hit.value as T;
  const value = parse();
  latestParsed.set(slot, { key, value });
  return value;
};
/** `read` of a value fixed by the git object id in `key`, through the ambient memo when there is one. */
export const objectOnce = <T>(key: string, read: () => T): T => ambient === null ? read() : ambient.object(key, read);

/** A record's weight: a string's or a Buffer's length, anything else the size of the file it was read from (from its stamp). */
function weightOf(value: unknown, stamp: string): number {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value.length;
  const size = stamp.split(':')[2];
  if (size === undefined) throw new Error(`memo: record stamp ${stamp} carries no size`);
  return Number(size);
}

/** A file's identity and version, or `missing` (the same stamp as src/observation/changes.ts `fileStamp`). */
export function stampOf(path: string): string {
  try { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw e; }
}
/** Tracks a record read past the memo for the sweep, when there is a memo. */
export const trackOnce = (path: string): void => { ambient?.track(path); };
