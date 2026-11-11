// What a long-lived observer remembers across captures: the answers of git commands that name only object ids, the
// write-once records of a run directory, and parsed content-addressed inputs. A one-shot reader (`roadmap status`, the CLI's
// local fallback) runs without one and reads everything, as before.

/** A git command's answer, as the memo keeps it. */
export type Spawned = Readonly<{ code: number; stdout: string | Buffer }>;
/** What the memo did, counted since it was made: `recordReads` counts records found and read. Product telemetry: the console reports it per capture. */
export type MemoWork = { gitSpawns: number; gitHits: number; recordReads: number; recordHits: number };

const GIT_BYTES = 64 * 1024 * 1024;
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
  #records = new Map<string, unknown>();
  #parsed = new Map<string, unknown>();
  /**
   * The answer of an immutable git command (`key` names it), run once; `key` null: a command that is run every time. Only a
   * success is remembered, or an answer `settled` says is final: an object missing now can be fetched later.
   */
  git<T extends Spawned>(key: string | null, run: () => T, settled: (answer: T) => boolean = (a) => a.code === 0): T {
    if (key !== null) {
      const hit = this.#git.get(key);
      if (hit !== undefined) { this.#git.delete(key); this.#git.set(key, hit); this.work.gitHits++; return hit as T; }
    }
    this.work.gitSpawns++;
    const answer = run();
    if (key === null || !settled(answer)) return answer;
    this.#git.set(key, answer); this.#gitBytes += answer.stdout.length;
    for (const [old, value] of this.#git) {
      if (this.#gitBytes <= GIT_BYTES) break;
      this.#git.delete(old); this.#gitBytes -= value.stdout.length;
    }
    return answer;
  }
  /** A write-once record, read once. Absence is never remembered: the record may land later. */
  record<T>(path: string, read: () => T | null): T | null {
    if (this.#records.has(path)) { this.work.recordHits++; return this.#records.get(path) as T; }
    const value = read();
    // A record found absent costs a stat, and is looked for again.
    if (value !== null) { this.work.recordReads++; this.#records.set(path, value); }
    return value;
  }
  /** A value parsed from content-addressed bytes (`key` carries their hash), parsed once. */
  parsed<T>(key: string, parse: () => T): T {
    if (this.#parsed.has(key)) return this.#parsed.get(key) as T;
    const value = parse();
    this.#parsed.set(key, value);
    return value;
  }
  /** Forgets these records (found rewritten or removed) and every parsed value, which may rest on them. */
  forget(paths: readonly string[]): void {
    if (paths.length === 0) return;
    for (const path of paths) this.#records.delete(path);
    this.#parsed.clear();
  }
}

let ambient: RecordMemo | null = null;
/** Runs `read` with the memo call sites (git, runner records, evidence records, kept inputs) answered from `memo`. */
export function withRecordMemo<T>(memo: RecordMemo, read: () => T): T {
  const previous = ambient;
  ambient = memo;
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
export const writeOnce = <T>(path: string, read: () => T | null): T | null => ambient === null ? read() : ambient.record(path, read);
/** `parse` of content-addressed bytes named by `key`, through the ambient memo when there is one. */
export const parsedOnce = <T>(key: string, parse: () => T): T => ambient === null ? parse() : ambient.parsed(key, parse);
