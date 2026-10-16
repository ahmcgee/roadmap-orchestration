// What a lens is shown of a range (DESIGN-1.0.md §2.5 "Run"; the lens-range fix, 2026-10-16): a lens's outstanding range
// is reviewed in chunks by publication, each attached within one byte budget, so no range is ever too large for a lens
// call and every audit converges.
//
// - The budget (`LENS_DIFF_BUDGET`) bounds each attachment: the range's, and the owners' branch diffs together.
// - An attachment (`boundedDiff`): the `--stat` of the whole range (its `--shortstat` when the full stat is over an
//   eighth of the budget), then the per-file diffs in path order, each inlined while it fits what remains (a file that
//   does not fit is skipped, a later smaller one may still fit). A file is never inlined when it is a plan-declared
//   derived output (regenerated from sources the range also changes), or when its blobs together exceed four budgets
//   (never diffed at all). Every file not inlined is listed by path with why, while the listing fits an eighth of the
//   budget; any further ones are counted (`unlisted`), and `git diff --name-only <from> <to>` names them.
// - A chunk (`chunkEnd`): from the lens's watermark to the furthest integration-line (first-parent) commit that is a
//   published head (or the audited SHA) whose attachment inlines every file not derived, found by bisection over
//   those heads; at least the first of them, so a single publication bigger than the budget is a chunk of its own,
//   attached bounded.
// Everything here reads git objects and the recorded inputs only, so a resumed audit finds the same chunks again.
import type { Sha } from '../core/ids.ts';
import { type AbsPath, type RepoPattern, matchesPattern, repoPath } from '../core/values.ts';
import { git } from '../git/git.ts';
import type { BoundedDiff, OmittedFile } from '../prompts/inputs.ts';

/**
 * The byte budget of a lens's attached diffs (the range's; the owners' together): the lens seat is the efficient class,
 * Sonnet 5.5 (src/routing/profiles.ts), whose 1M-token window must also hold the vision, contracts, architecture doc and
 * the session's own reads, so the two attachments (≤ 2 × 128 KiB, about 75K tokens) fit even a 200K-token window.
 */
export const LENS_DIFF_BUDGET = 131_072;

/** One changed file: its path and its blobs' total size, from `git diff --raw`. */
type Changed = Readonly<{ path: string; status: string; bytes: number }>;

const ZERO = /^0+$/;

/** The files `from..to` changes, in path order, with their blobs' sizes. */
function changedFiles(repo: AbsPath, from: Sha, to: Sha): readonly Changed[] {
  const fields = git(repo, ['diff', '--raw', '--no-renames', '--no-abbrev', '-z', from, to]).split('\0');
  const entries: { path: string; status: string; blobs: string[] }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!;
    if (!meta.startsWith(':')) throw new Error(`git diff --raw ${from} ${to}: unexpected record ${JSON.stringify(meta)}`);
    const [oldMode, newMode, oldSha, newSha, status] = meta.slice(1).split(' ');
    const blobs = [[oldMode, oldSha], [newMode, newSha]].flatMap(([mode, s]) => (mode === '160000' || s === undefined || ZERO.test(s) ? [] : [s]));
    entries.push({ path: fields[i + 1]!, status: status!, blobs });
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

const isDerived = (path: string, derived: readonly RepoPattern[]): boolean => derived.some((p) => matchesPattern(repoPath(path), p));

/**
 * `from..to` attached within `budget` bytes (see the header). `stopAtFirstOmission`: stop at the first file omitted for
 * size (the chunk search only asks whether everything fits).
 */
export function boundedDiff(repo: AbsPath, from: Sha, to: Sha, budget: number, derived: readonly RepoPattern[], stopAtFirstOmission = false): BoundedDiff {
  if (from === to) return { from, to, stat: { text: '', full: true }, inlined: '', omitted: [], unlisted: 0 };
  const share = Math.floor(budget / 8);
  const fullStat = git(repo, ['diff', '--no-color', '--no-renames', '--stat=200', from, to]);
  const stat = fullStat.length <= share ? { text: fullStat, full: true } : { text: git(repo, ['diff', '--no-color', '--no-renames', '--shortstat', from, to]), full: false };
  let remaining = budget - stat.text.length - share;
  const parts: string[] = [];
  const omitted: OmittedFile[] = [];
  for (const f of changedFiles(repo, from, to)) {
    if (isDerived(f.path, derived)) {
      omitted.push({ path: f.path, why: 'derived' });
      continue;
    }
    // Added or deleted, its diff is at least its blob; too large to diff, it is only listed.
    const tooLarge = f.bytes > 4 * budget || ((f.status === 'A' || f.status === 'D') && f.bytes > remaining);
    const text = tooLarge ? null : git(repo, ['diff', '--no-color', '--no-renames', from, to, '--', `:(literal)${f.path}`]);
    if (text !== null && text.length <= remaining) {
      parts.push(text);
      remaining -= text.length;
      continue;
    }
    omitted.push({ path: f.path, why: 'size' });
    if (stopAtFirstOmission) break;
  }
  // The listing: each line about the path plus the command's fixed text, within its share.
  let listed = 0;
  let used = 0;
  for (const o of omitted) {
    used += 2 * o.path.length + 160;
    if (used > share) break;
    listed += 1;
  }
  return { from, to, stat, inlined: parts.join(''), omitted: omitted.slice(0, listed), unlisted: omitted.length - listed };
}

/** Whether `from..to` attaches whole: the full stat, every file not derived inlined. */
const fits = (repo: AbsPath, from: Sha, to: Sha, budget: number, derived: readonly RepoPattern[]): boolean => {
  const d = boundedDiff(repo, from, to, budget, derived, true);
  return d.stat.full && d.unlisted === 0 && d.omitted.every((o) => o.why === 'derived');
};

/**
 * The end of the chunk a lens reviews next from `from` towards the audited SHA `to` (see the header): `heads` are the
 * published integration heads (any order); the candidates are the first-parent commits of `from..to` among them, and `to`.
 */
export function chunkEnd(repo: AbsPath, from: Sha, to: Sha, budget: number, derived: readonly RepoPattern[], heads: ReadonlySet<Sha>): Sha {
  if (from === to || fits(repo, from, to, budget, derived)) return to;
  const line = git(repo, ['rev-list', '--first-parent', '--reverse', to, `^${from}`]).split('\n').filter((l) => l !== '') as Sha[];
  const candidates = line.filter((c) => c === to || heads.has(c));
  if (candidates.at(-1) !== to) throw new Error(`${to} is not on its own first-parent line from ${from}`);
  // The largest candidate before `to` that fits, by bisection (a later revert can only make the found chunk shorter); the first at least.
  let lo = 0;
  let hi = candidates.length - 2;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(repo, from, candidates[mid]!, budget, derived)) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidates[found]!;
}
