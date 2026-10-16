// A diff attached to a prompt within a byte budget (the lens-range fix, 2026-10-16; the gate since 1.0.0-dev.12): the one
// way a judgment is shown a diff that can grow with the repository, so no diff is ever too large for its call.
//
// - The attachment (`boundedDiff`): the `--stat` of the whole diff (its `--shortstat` when the full stat is over an eighth
//   of the budget), then the per-file diffs in path order, each inlined while it fits what remains (a file that does not
//   fit is skipped, a later smaller one may still fit). A file is never inlined when it is a plan-declared derived output
//   (regenerated from sources the diff also changes), or when its blobs together exceed four budgets (never diffed in
//   memory). Every file not inlined is listed by path with why, while the listing fits an eighth of the budget; any
//   further ones are counted (`unlisted`).
// - What was not inlined is written to the attachment's directory, which the caller makes readable to the session (a
//   judgment has Read, Grep and Glob only, no shell, src/backends/argv.ts JUDGMENT_TOOLS, so a git command it is told to
//   run is one it cannot): `files/<path>.diff` holds each such file's whole diff (`git diff --output`, streamed by git,
//   whatever its size), `stat.txt` the full stat when only the shortstat is attached, and `not-inlined.txt` every file
//   not inlined, listed or counted, one per line: `<path>\t<derived|size>\t<its diff file>`.
// Everything here reads git objects only, so the same diff and budget give the same attachment (a resumed audit finds the
// same chunks again: src/holistic/lensdiff.ts).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Sha } from '../core/ids.ts';
import { type AbsPath, type RepoPath, type RepoPattern, absPath, matchesPattern, repoPath } from '../core/values.ts';
import { git } from './git.ts';

/** A file of a diff not inlined: a plan-declared derived output, or over what the budget left; `diff` holds its whole diff. */
export type OmittedFile = Readonly<{ path: RepoPath; why: 'derived' | 'size'; diff: AbsPath }>;

/**
 * A diff attached within a byte budget (`boundedDiff`): the stat of the whole diff (`full` false: its shortstat, the full one
 * over its share, then in `dir`/stat.txt), the per-file diffs inlined (`inlinedPaths` names them), the files not inlined
 * as far as the listing's share allows, and how many more were not inlined (`unlisted`; `dir`/not-inlined.txt lists all).
 */
export type BoundedDiff = Readonly<{
  from: Sha;
  to: Sha;
  stat: Readonly<{ text: string; full: boolean }>;
  inlined: string;
  inlinedPaths: readonly RepoPath[];
  omitted: readonly OmittedFile[];
  unlisted: number;
  /** Where the files not inlined are written (see the header). */
  dir: AbsPath;
}>;

/** One changed file: its path and its blobs' total size, from `git diff --raw`. */
type Changed = Readonly<{ path: RepoPath; status: string; bytes: number }>;

const ZERO = /^0+$/;

/** The files `from..to` changes, in path order, with their blobs' sizes. */
function changedFiles(repo: AbsPath, from: Sha, to: Sha): readonly Changed[] {
  const fields = git(repo, ['diff', '--raw', '--no-renames', '--no-abbrev', '-z', from, to]).split('\0');
  const entries: { path: RepoPath; status: string; blobs: string[] }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!;
    if (!meta.startsWith(':')) throw new Error(`git diff --raw ${from} ${to}: unexpected record ${JSON.stringify(meta)}`);
    const [oldMode, newMode, oldSha, newSha, status] = meta.slice(1).split(' ');
    const blobs = [[oldMode, oldSha], [newMode, newSha]].flatMap(([mode, s]) => (mode === '160000' || s === undefined || ZERO.test(s) ? [] : [s]));
    entries.push({ path: repoPath(fields[i + 1]!), status: status!, blobs });
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
  return entries
    .map((e) => ({ path: e.path, status: e.status, bytes: e.blobs.reduce((n, s) => n + (sizes.get(s) ?? 0), 0) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const isDerived = (path: RepoPath, derived: readonly RepoPattern[]): boolean => derived.some((p) => matchesPattern(path, p));

/** The diff file of `path` in an attachment's directory. */
export const diffFileOf = (dir: AbsPath, path: RepoPath): AbsPath => absPath(join(dir, 'files', `${path}.diff`));

type Plan = Readonly<{
  stat: BoundedDiff['stat'];
  fullStat: string;
  inlined: readonly Readonly<{ path: RepoPath; text: string }>[];
  omitted: readonly Readonly<{ path: RepoPath; why: 'derived' | 'size' }>[];
}>;

/** What `from..to` attaches within `budget` (see the header); `stopAtFirstOmission` stops at the first file omitted for size. */
function plan(repo: AbsPath, from: Sha, to: Sha, budget: number, derived: readonly RepoPattern[], stopAtFirstOmission: boolean): Plan {
  const share = Math.floor(budget / 8);
  const fullStat = git(repo, ['diff', '--no-color', '--no-renames', '--stat=200', from, to]);
  const stat = fullStat.length <= share ? { text: fullStat, full: true } : { text: git(repo, ['diff', '--no-color', '--no-renames', '--shortstat', from, to]), full: false };
  let remaining = budget - stat.text.length - share;
  const inlined: { path: RepoPath; text: string }[] = [];
  const omitted: { path: RepoPath; why: 'derived' | 'size' }[] = [];
  for (const f of changedFiles(repo, from, to)) {
    if (isDerived(f.path, derived)) {
      omitted.push({ path: f.path, why: 'derived' });
      continue;
    }
    // Added or deleted, its diff is at least its blob; too large to diff, it is only listed.
    const tooLarge = f.bytes > 4 * budget || ((f.status === 'A' || f.status === 'D') && f.bytes > remaining);
    const text = tooLarge ? null : git(repo, ['diff', '--no-color', '--no-renames', from, to, '--', `:(literal)${f.path}`]);
    if (text !== null && text.length <= remaining) {
      inlined.push({ path: f.path, text });
      remaining -= text.length;
      continue;
    }
    omitted.push({ path: f.path, why: 'size' });
    if (stopAtFirstOmission) break;
  }
  return { stat, fullStat, inlined, omitted };
}

/**
 * Whether `from..to` attaches whole within `budget`: the full stat, every file not derived inlined. Writes nothing (the
 * lens chunk search, src/holistic/lensdiff.ts).
 */
export function attachesWhole(repo: AbsPath, from: Sha, to: Sha, budget: number, derived: readonly RepoPattern[]): boolean {
  if (from === to) return true;
  const p = plan(repo, from, to, budget, derived, true);
  return p.stat.full && p.omitted.every((o) => o.why === 'derived');
}

/**
 * `from..to` attached within `budget` bytes, what it does not inline written under `dir` (see the header). `dir` is
 * replaced whole, so an attachment made again over the same diff leaves exactly what it lists.
 */
export function boundedDiff(repo: AbsPath, from: Sha, to: Sha, budget: number, derived: readonly RepoPattern[], dir: AbsPath): BoundedDiff {
  rmSync(dir, { recursive: true, force: true });
  if (from === to) return { from, to, stat: { text: '', full: true }, inlined: '', inlinedPaths: [], omitted: [], unlisted: 0, dir };
  const p = plan(repo, from, to, budget, derived, false);
  mkdirSync(dir, { recursive: true });
  const omitted: OmittedFile[] = p.omitted.map((o) => {
    const diff = diffFileOf(dir, o.path);
    mkdirSync(dirname(diff), { recursive: true });
    git(repo, ['diff', '--no-color', '--no-renames', `--output=${diff}`, from, to, '--', `:(literal)${o.path}`]);
    return { ...o, diff };
  });
  if (!p.stat.full) writeFileSync(join(dir, 'stat.txt'), p.fullStat);
  writeFileSync(join(dir, 'not-inlined.txt'), omitted.map((o) => `${o.path}\t${o.why}\t${o.diff}\n`).join(''));
  // The listing: each line about the path, its diff file and the fixed text, within its share.
  const share = Math.floor(budget / 8);
  let listed = 0;
  let used = 0;
  for (const o of omitted) {
    used += o.path.length + o.diff.length + 80;
    if (used > share) break;
    listed += 1;
  }
  return {
    from, to, stat: p.stat, inlined: p.inlined.map((i) => i.text).join(''), inlinedPaths: p.inlined.map((i) => i.path),
    omitted: omitted.slice(0, listed), unlisted: omitted.length - listed, dir,
  };
}

/** Every file of an attachment not inlined, listed or not, from its `not-inlined.txt`, in path order. */
export function notInlined(d: BoundedDiff): readonly Readonly<{ path: RepoPath; why: 'derived' | 'size' }>[] {
  if (d.from === d.to) return [];
  return d.unlisted === 0 ? d.omitted.map(({ path, why }) => ({ path, why })) : notInlinedAt(d.dir);
}

/** The files `not-inlined.txt` under `dir` lists. */
function notInlinedAt(dir: AbsPath): readonly Readonly<{ path: RepoPath; why: 'derived' | 'size' }>[] {
  const text = readFileSync(join(dir, 'not-inlined.txt'), 'utf8');
  return text.split('\n').filter((l) => l !== '').map((l) => {
    const [path, why] = l.split('\t');
    if (why !== 'derived' && why !== 'size') throw new Error(`${dir}/not-inlined.txt: a line without its reason: ${JSON.stringify(l)}`);
    return { path: repoPath(path!), why };
  });
}

