// A diff attached to a prompt within a byte budget (the lens-range fix, 2026-10-16; the gate since 1.0.0-dev.12): the one
// way a judgment is shown a diff that can grow with the repository, so no diff is ever too large for its call. The gate
// attaches its unit's diff with it (src/pipeline/gate.ts), a lens its range chunk and the owners' branch diffs
// (src/holistic/audit.ts); src/prompts/inputs.ts `boundedDiffText` renders it as `<orientation>`, `<diff>` and
// `<not_inlined>`.
//
// - Representation. Renames are detected (`-M`): a file moved unchanged is one move line in the orientation and has no
//   diff; one moved and edited is diffed as a rename. A deleted file is never inlined: the orientation names it with its
//   line count, labelled against the spec's `removes` when the caller has a spec (each entry matches the deleted path
//   itself, a directory above it, or the file's name without its extension), unexpected deletions first. Inlined diffs
//   have one line of context (`-U1`). A file whose line diff has a changed line over `LONG_LINE` characters (a
//   regenerated golden, minified output) is inlined as a word diff instead (`--word-diff=porcelain`, words being runs of
//   letters, digits and `_` or single other characters), its unchanged runs cut to their ends (`WORD_CONTEXT`).
// - Order and budget. Candidates go by kind (`DIFF_KINDS`: new source, modified source, tests, fixtures and other), then
//   path; each is inlined while it fits what remains (one that does not fit is skipped, a later smaller one may still
//   fit). A plan-declared derived output (regenerated from sources the diff also changes) is never inlined, nor a file
//   whose blobs together exceed four budgets (never diffed in memory). The orientation and the `<not_inlined>` listing
//   each keep within an eighth of the budget; the inlined diffs take what is left.
// - The orientation: the stat (the shortstat when the full one is over a sixteenth of the budget), the moves, the
//   deletions, the spread of files and lines per package (a top-level directory, or two levels under a monorepo
//   container such as `packages/`), and the recurring identifier substitutions mined from the removed and added words of
//   the changed files: a pointer list for the reviewer, never verification. Lists past their share are counted.
// - Readable files. A judgment has no shell (Read, Grep, Glob and read-only subagents: src/backends/argv.ts
//   JUDGMENT_TOOLS), so what is not inlined is written under the attachment's directory, inside the run dir its read
//   surface holds (src/pipeline/dispatch.ts `judgmentSurface`):
//   `files/<path>.diff` holds the whole `git diff -M` of each file not inlined, each deleted file and each file inlined
//   as a word diff (streamed by git, whatever its size); `stat.txt`, `moves.txt`, `deletions.txt` and `not-inlined.txt`
//   the full lists.
// Everything here reads git objects only, so the same diff and budget give the same attachment.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { Sha } from '../core/ids.ts';
import { type AbsPath, type RepoPath, type RepoPattern, absPath, matchesPattern, repoPath } from '../core/values.ts';
import { git } from './git.ts';

/** What a changed file is, in inlining priority order (fixtures and other files share a rank); derived outputs never inline. */
export const DIFF_KINDS = ['new-source', 'modified-source', 'test', 'fixture', 'other', 'derived'] as const;
export type DiffKind = (typeof DIFF_KINDS)[number];
const RANK: { readonly [K in DiffKind]: number } = { 'new-source': 0, 'modified-source': 1, test: 2, fixture: 3, other: 3, derived: 4 };

/** A changed line longer than this makes its file a word diff: a regenerated golden or minified output, not reviewable by line. */
export const LONG_LINE = 1_000;
/** In a word diff, an unchanged run longer than twice this keeps only its first and last `WORD_CONTEXT` characters. */
export const WORD_CONTEXT = 60;

/** A file inlined: its kind, its diff as `line` or `word` diff, and (a word diff) the file holding its whole line diff. */
export type InlinedFile = Readonly<{ path: RepoPath; kind: DiffKind; representation: 'line' | 'word'; full: AbsPath | null }>;
/** A file with changed content not inlined: a derived output, or over what the budget left; `diff` holds its whole diff. */
export type OmittedFile = Readonly<{ path: RepoPath; kind: DiffKind; why: 'derived' | 'size'; bytes: number; diff: AbsPath }>;
export type Move = Readonly<{ from: RepoPath; to: RepoPath }>;
/** A deleted file: its line count (null: binary), the spec `removes` entry it matches (null: none), and its whole diff. */
export type Deletion = Readonly<{ path: RepoPath; lines: number | null; removes: string | null; diff: AbsPath }>;
export type PackageSpread = Readonly<{ name: string; files: number; added: number; deleted: number }>;
export type Substitution = Readonly<{ from: string; to: string; count: number }>;
/** A list cut to its share: the entries shown, and how many more the full list (a file in the attachment's dir) holds. */
export type Listed<T> = Readonly<{ shown: readonly T[]; more: number }>;

export type Orientation = Readonly<{
  /** `full` false: the shortstat, the full stat in `dir`/stat.txt. */
  stat: Readonly<{ text: string; full: boolean }>;
  moves: Listed<Move>;
  /** Unexpected deletions first. `labelled` false: no spec to label them against (a lens's diffs). */
  deletions: Listed<Deletion> & Readonly<{ labelled: boolean }>;
  packages: Listed<PackageSpread>;
  substitutions: readonly Substitution[];
}>;

/** A diff attached within a byte budget (see the header). `notInlined` names every file with changed content not inlined. */
export type BoundedDiff = Readonly<{
  from: Sha;
  to: Sha;
  dir: AbsPath;
  orientation: Orientation;
  inlined: readonly InlinedFile[];
  /** The inlined diffs, in order. */
  text: string;
  omitted: Listed<OmittedFile>;
  notInlined: readonly RepoPath[];
}>;

export type BoundedDiffOptions = Readonly<{
  budget: number;
  derived: readonly RepoPattern[];
  /** The spec's `removes` the deletions are labelled against; null when the diff has no one spec (a lens's). */
  removes: readonly string[] | null;
  /** Where what is not inlined is written; replaced whole. */
  dir: AbsPath;
}>;

/** One changed file from `git diff --raw -M` and `--numstat -M`, joined. */
type Changed = Readonly<{
  path: RepoPath; from: RepoPath | null; status: 'A' | 'D' | 'M' | 'R' | 'T'; similarity: number; bytes: number;
  /** null: binary. */
  added: number | null; deleted: number | null;
}>;

const ZERO = /^0+$/;
const byPath = (a: RepoPath, b: RepoPath): number => (a < b ? -1 : a > b ? 1 : 0);
const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');
const spec = (p: RepoPath): string => `:(literal)${p}`;
const renames = ['diff', '--no-color', '-M'];

function changedFiles(repo: AbsPath, from: Sha, to: Sha): readonly Changed[] {
  const raw = git(repo, [...renames, '--raw', '--no-abbrev', '-z', from, to]).split('\0');
  const entries: { path: RepoPath; from: RepoPath | null; status: Changed['status']; similarity: number; blobs: string[] }[] = [];
  for (let i = 0; i < raw.length - 1;) {
    const meta = raw[i]!;
    if (!meta.startsWith(':')) throw new Error(`git diff --raw ${from} ${to}: unexpected record ${JSON.stringify(meta)}`);
    const [oldMode, newMode, oldSha, newSha, status] = meta.slice(1).split(' ');
    const letter = status!.charAt(0);
    if (letter !== 'A' && letter !== 'D' && letter !== 'M' && letter !== 'R' && letter !== 'T') throw new Error(`git diff --raw ${from} ${to}: status ${status}`);
    const two = letter === 'R';
    const blobs = [[oldMode, oldSha], [newMode, newSha]].flatMap(([mode, s]) => (mode === '160000' || s === undefined || ZERO.test(s) ? [] : [s]));
    entries.push({ path: repoPath(raw[i + (two ? 2 : 1)]!), from: two ? repoPath(raw[i + 1]!) : null, status: letter, similarity: two ? Number(status!.slice(1)) : 0, blobs });
    i += two ? 3 : 2;
  }
  const numstat = git(repo, [...renames, '--numstat', '-z', from, to]).split('\0');
  const lines = new Map<string, { added: number | null; deleted: number | null }>();
  for (let i = 0; i < numstat.length - 1;) {
    const [a, d, path] = numstat[i]!.split('\t');
    const count = (s: string | undefined): number | null => (s === '-' ? null : Number(s));
    // A rename's record names no path; its old and new paths follow.
    const dest = path === '' ? numstat[i + 2]! : path!;
    lines.set(dest, { added: count(a), deleted: count(d) });
    i += path === '' ? 3 : 1;
  }
  const shas = [...new Set(entries.flatMap((e) => e.blobs))];
  const sizes = new Map<string, number>();
  if (shas.length > 0) {
    const out = git(repo, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: `${shas.join('\n')}\n` }).split('\n').filter((l) => l !== '');
    for (const line of out) {
      const [name, size] = line.split(' ');
      sizes.set(name!, Number(size));
    }
  }
  return entries.map((e) => {
    const n = lines.get(e.path);
    if (n === undefined) throw new Error(`git diff --numstat ${from} ${to}: no line counts for ${e.path}`);
    return { path: e.path, from: e.from, status: e.status, similarity: e.similarity, bytes: e.blobs.reduce((s, b) => s + (sizes.get(b) ?? 0), 0), ...n };
  }).sort((a, b) => byPath(a.path, b.path));
}

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift',
  'm', 'mm', 'sh', 'bash', 'sql', 'vue', 'svelte', 'lua', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'dart', 'r', 'pl',
]);
const FIXTURE = /(^|\/)(fixtures?|__fixtures__|__snapshots__|snapshots|goldens?|testdata|test-data)\/|\.(snap|golden)$/;
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e)\//;
const TEST_NAME = /\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|exs?)$/;

/** A file's kind (see `DIFF_KINDS`): a derived output, a fixture, a test, source (new or modified), or anything else. */
export function diffKind(path: RepoPath, added: boolean, derived: readonly RepoPattern[]): DiffKind {
  if (derived.some((p) => matchesPattern(path, p))) return 'derived';
  if (FIXTURE.test(path)) return 'fixture';
  const source = SOURCE_EXTENSIONS.has(extname(path).slice(1).toLowerCase());
  if (TEST_NAME.test(path) || (TEST_DIR.test(path) && source)) return 'test';
  if (TEST_DIR.test(path)) return 'fixture';
  if (source) return added ? 'new-source' : 'modified-source';
  return 'other';
}

/** The `removes` entry a deleted path matches: the path itself, a directory above it, or its file name without the extension. */
export function removesMatch(path: RepoPath, removes: readonly string[]): string | null {
  const name = basename(path, extname(path));
  return removes.find((r) => {
    const e = r.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
    return e !== '' && (path === e || path.startsWith(`${e}/`) || name === e);
  }) ?? null;
}

const CONTAINERS = new Set(['packages', 'apps', 'libs', 'services', 'crates', 'modules', 'plugins', 'components']);
/** A path's package: its top-level directory, or two levels under a monorepo container; `.` for a file at the root. */
export function packageOf(path: RepoPath): string {
  const parts = path.split('/');
  if (parts.length === 1) return '.';
  return CONTAINERS.has(parts[0]!) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/** The diff file of `path` in an attachment's directory. */
export const diffFileOf = (dir: AbsPath, path: RepoPath): AbsPath => absPath(join(dir, 'files', `${path}.diff`));

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** How many recurring substitutions the orientation names, and how often one must recur to be named. */
const SUBSTITUTIONS = 12;
const RECURS = 2;

/**
 * The identifier substitutions the word diff of `from..to` shows outside the derived outputs (a removed identifier
 * directly replaced by an added one; an added or deleted file has only one side, so adds none), most frequent first,
 * recurring at least `RECURS` times. The derived outputs are excluded as git globs, so the argv stays small however many
 * files the diff has.
 */
function substitutions(repo: AbsPath, from: Sha, to: Sha, derived: readonly RepoPattern[]): readonly Substitution[] {
  const exclude = derived.flatMap((p) => [`:(exclude,glob)${p.replace(/\/+$/, '')}`, `:(exclude,glob)${p.replace(/\/+$/, '')}/**`]);
  const out = git(repo, [...renames, '-U0', '--word-diff=porcelain', '--word-diff-regex=[A-Za-z_$][A-Za-z0-9_$]*', from, to, '--', '.', ...exclude]).split('\n');
  const counts = new Map<string, number>();
  let inHunk = false;
  for (let i = 0; i + 1 < out.length; i++) {
    const line = out[i]!;
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    if (!inHunk || !line.startsWith('-')) continue;
    const next = out[i + 1]!;
    const [a, b] = [line.slice(1), next.slice(1)];
    if (next.startsWith('+') && a !== b && IDENT.test(a) && IDENT.test(b)) counts.set(`${a}\0${b}`, (counts.get(`${a}\0${b}`) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= RECURS)
    .map(([k, count]) => {
      const [a, b] = k.split('\0');
      return { from: a!, to: b!, count };
    })
    .sort((x, y) => y.count - x.count || (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0))
    .slice(0, SUBSTITUTIONS);
}

/** A run of `s` over twice `keep` characters, cut to its ends with how much was cut. */
const cut = (s: string, keep: number): string => (s.length <= 2 * keep ? s : `${s.slice(0, keep)}…[${s.length - 2 * keep} chars]…${s.slice(-keep)}`);

/** A file's word diff, its unchanged runs cut to their ends and its changed runs to eight times that. */
function wordDiff(repo: AbsPath, from: Sha, to: Sha, paths: readonly string[]): string {
  const out = git(repo, [...renames, '-U1', '--word-diff=porcelain', '--word-diff-regex=[A-Za-z0-9_]+|[^[:space:]]', from, to, '--', ...paths]).split('\n');
  let inHunk = false;
  return out.map((line) => {
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    if (!inHunk) return line;
    const mark = line.charAt(0);
    return mark === ' ' ? ` ${cut(line.slice(1), WORD_CONTEXT)}` : mark === '-' || mark === '+' ? `${mark}${cut(line.slice(1), 4 * WORD_CONTEXT)}` : line;
  }).join('\n');
}

/** Whether a line diff changes a line over `LONG_LINE` characters. */
const hasLongLine = (text: string): boolean => text.split('\n').some((l) => (l.startsWith('+') || l.startsWith('-')) && l.length > LONG_LINE + 1 && !l.startsWith('+++ ') && !l.startsWith('--- '));

/** The entries of `all` that fit `share` bytes, each costing `size`; the rest counted. */
function within<T>(all: readonly T[], share: number, size: (t: T) => number): Listed<T> {
  let used = 0;
  let n = 0;
  for (const t of all) {
    used += size(t);
    if (used > share) break;
    n += 1;
  }
  return { shown: all.slice(0, n), more: all.length - n };
}

const EMPTY_ORIENTATION: Orientation = {
  stat: { text: '', full: true }, moves: { shown: [], more: 0 }, deletions: { shown: [], more: 0, labelled: false }, packages: { shown: [], more: 0 }, substitutions: [],
};

/**
 * `from..to` attached within `opts.budget` bytes, what it does not inline written under `opts.dir` (see the header).
 * The dir is replaced whole (and made even for an empty diff, so a session can always be given it), so an attachment
 * made again over the same diff leaves exactly what it lists.
 */
export function boundedDiff(repo: AbsPath, from: Sha, to: Sha, opts: BoundedDiffOptions): BoundedDiff {
  const { budget, derived, removes, dir } = opts;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const empty: BoundedDiff = { from, to, dir, orientation: EMPTY_ORIENTATION, inlined: [], text: '', omitted: { shown: [], more: 0 }, notInlined: [] };
  if (from === to) return empty;
  const changed = changedFiles(repo, from, to);
  if (changed.length === 0) return empty;
  const share = Math.floor(budget / 8);
  const writeDiff = (f: Changed): AbsPath => {
    const file = diffFileOf(dir, f.path);
    mkdirSync(dirname(file), { recursive: true });
    git(repo, [...renames, `--output=${file}`, from, to, '--', ...(f.from === null ? [] : [spec(f.from)]), spec(f.path)]);
    return file;
  };

  // The orientation.
  const fullStat = git(repo, [...renames, '--stat=200', from, to]);
  const stat = bytesOf(fullStat) <= budget / 16 ? { text: fullStat, full: true } : { text: git(repo, [...renames, '--shortstat', from, to]), full: false };
  writeFileSync(join(dir, 'stat.txt'), fullStat);
  const moves = changed.flatMap((f): Move[] => (f.status === 'R' && f.similarity === 100 && f.from !== null ? [{ from: f.from, to: f.path }] : []));
  writeFileSync(join(dir, 'moves.txt'), moves.map((m) => `${m.from}\t${m.to}\n`).join(''));
  const deletions = changed.filter((f) => f.status === 'D').map((f): Deletion => ({ path: f.path, lines: f.deleted, removes: removes === null ? null : removesMatch(f.path, removes), diff: writeDiff(f) }));
  // Unexpected first (stable: path order within each).
  const ordered = removes === null ? deletions : [...deletions.filter((d) => d.removes === null), ...deletions.filter((d) => d.removes !== null)];
  writeFileSync(join(dir, 'deletions.txt'), ordered.map((d) => `${d.path}\t${d.lines ?? 'binary'}\t${d.removes ?? (removes === null ? '' : 'unexpected')}\t${d.diff}\n`).join(''));
  const spread = new Map<string, { files: number; added: number; deleted: number }>();
  for (const f of changed) {
    const s = spread.get(packageOf(f.path)) ?? { files: 0, added: 0, deleted: 0 };
    spread.set(packageOf(f.path), { files: s.files + 1, added: s.added + (f.added ?? 0), deleted: s.deleted + (f.deleted ?? 0) });
  }
  const packages = [...spread].map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.added + b.deleted - (a.added + a.deleted) || b.files - a.files || (a.name < b.name ? -1 : 1));
  const contentChanged = changed.filter((f) => f.status !== 'D' && !(f.status === 'R' && f.similarity === 100));
  const kinds = new Map(contentChanged.map((f) => [f.path, diffKind(f.path, f.status === 'A', derived)]));
  const orientation: Orientation = {
    stat,
    moves: within(moves, budget / 32, (m) => bytesOf(m.from) + bytesOf(m.to) + 8),
    deletions: { ...within(ordered, budget / 32, (d) => bytesOf(d.path) + bytesOf(d.diff) + (d.removes === null ? 0 : bytesOf(d.removes)) + 64), labelled: removes !== null },
    packages: within(packages, budget / 64, (p) => bytesOf(p.name) + 40),
    substitutions: substitutions(repo, from, to, derived),
  };
  const orientationBytes = bytesOf(stat.text) + 512
    + orientation.moves.shown.reduce((n, m) => n + bytesOf(m.from) + bytesOf(m.to) + 8, 0)
    + orientation.deletions.shown.reduce((n, d) => n + bytesOf(d.path) + bytesOf(d.diff) + 64, 0)
    + orientation.packages.shown.length * 64 + orientation.substitutions.reduce((n, s) => n + s.from.length + s.to.length + 16, 0);

  // The inlined diffs, by kind then path, within what is left.
  let remaining = budget - orientationBytes - share;
  const inlined: InlinedFile[] = [];
  const parts: string[] = [];
  const omitted: OmittedFile[] = [];
  const candidates = [...contentChanged].sort((a, b) => RANK[kinds.get(a.path)!] - RANK[kinds.get(b.path)!] || byPath(a.path, b.path));
  for (const f of candidates) {
    const kind = kinds.get(f.path)!;
    if (kind === 'derived') {
      omitted.push({ path: f.path, kind, why: 'derived', bytes: f.bytes, diff: writeDiff(f) });
      continue;
    }
    // Added, its diff is at least its blob; too large to diff, it is only listed.
    const paths = f.from === null ? [spec(f.path)] : [spec(f.from), spec(f.path)];
    const tooLarge = f.bytes > 4 * budget || (f.status === 'A' && f.bytes > remaining);
    let text = tooLarge ? null : git(repo, [...renames, '-U1', from, to, '--', ...paths]);
    let representation: InlinedFile['representation'] = 'line';
    let full: AbsPath | null = null;
    if (text !== null && hasLongLine(text)) {
      full = diffFileOf(dir, f.path);
      text = `word diff of ${f.path}; its whole line diff: ${full}\n${wordDiff(repo, from, to, paths)}`;
      representation = 'word';
    }
    if (text !== null && bytesOf(text) <= remaining) {
      if (full !== null) writeDiff(f);
      inlined.push({ path: f.path, kind, representation, full });
      parts.push(text);
      remaining -= bytesOf(text);
      continue;
    }
    omitted.push({ path: f.path, kind, why: 'size', bytes: text === null ? f.bytes : bytesOf(text), diff: writeDiff(f) });
  }
  writeFileSync(join(dir, 'not-inlined.txt'), omitted.map((o) => `${o.path}\t${o.kind}\t${o.why}\t${o.bytes}\t${o.diff}\n`).join(''));
  return {
    from, to, dir, orientation, inlined, text: parts.join(''),
    omitted: within(omitted, share, (o) => bytesOf(o.path) + bytesOf(o.diff) + 64),
    notInlined: [...omitted.map((o) => o.path), ...deletions.map((d) => d.path)].sort(byPath),
  };
}
