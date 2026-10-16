// What a lens is shown of a range (DESIGN-1.0.md §2.5 "Run"; the lens-range fix, 2026-10-16): a lens's outstanding range
// is reviewed in chunks by publication, each attached within one byte budget, so no range is ever too large for a lens
// call and every audit converges.
//
// - The budget (`LENS_DIFF_BUDGET`) bounds each attachment: the range's, and the owners' branch diffs together. The
//   attachment itself is src/git/boundeddiff.ts, the one bounded diff the gate shares.
// - A chunk (`chunkEnd`): from the lens's watermark to the furthest integration-line (first-parent) commit that is a
//   published head (or the audited SHA) whose diff fits whole, found by bisection over those heads; at least the first
//   of them, so a single publication bigger than the budget is a chunk of its own, attached bounded. Fitting whole is
//   the 1.0.0-dev.11 measure, unchanged so a resumed audit finds the same chunks again (`fitsWhole`): the `--stat` of the
//   range within an eighth of the budget, and every per-file diff not derived (no rename detection, three lines of
//   context, path order) within what the stat and an eighth for the listing leave, the derived outputs' listing within
//   that eighth. The attachment's own representation (renames collapsed, one line of context, deletions only named) is
//   smaller than that measure for all but the smallest diffs, so a chunk that fits whole is in practice attached whole;
//   when not, it is still attached bounded, the rest readable.
// Everything here reads git objects and the recorded inputs only, so a resumed audit finds the same chunks again.
import type { Sha } from '../core/ids.ts';
import { type AbsPath, type RepoPattern, matchesPattern, repoPath } from '../core/values.ts';
import { git } from '../git/git.ts';

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

/** Whether `from..to` fits whole within `budget` by the 1.0.0-dev.11 measure (see the header). */
function fitsWhole(repo: AbsPath, from: Sha, to: Sha, budget: number, derived: readonly RepoPattern[]): boolean {
  if (from === to) return true;
  const share = Math.floor(budget / 8);
  const stat = git(repo, ['diff', '--no-color', '--no-renames', '--stat=200', from, to]);
  if (stat.length > share) return false;
  let remaining = budget - stat.length - share;
  let listing = 0;
  for (const f of changedFiles(repo, from, to)) {
    if (isDerived(f.path, derived)) {
      // dev.11 listed each derived output (its path twice in a command, 160 bytes of fixed text) within the share.
      listing += 2 * f.path.length + 160;
      if (listing > share) return false;
      continue;
    }
    // Added or deleted, its diff is at least its blob.
    if (f.bytes > 4 * budget || ((f.status === 'A' || f.status === 'D') && f.bytes > remaining)) return false;
    const text = git(repo, ['diff', '--no-color', '--no-renames', from, to, '--', `:(literal)${f.path}`]);
    if (text.length > remaining) return false;
    remaining -= text.length;
  }
  return true;
}

/**
 * The end of the chunk a lens reviews next from `from` towards the audited SHA `to` (see the header): `heads` are the
 * published integration heads (any order); the candidates are the first-parent commits of `from..to` among them, and `to`.
 */
export function chunkEnd(repo: AbsPath, from: Sha, to: Sha, budget: number, derived: readonly RepoPattern[], heads: ReadonlySet<Sha>): Sha {
  if (from === to || fitsWhole(repo, from, to, budget, derived)) return to;
  const line = git(repo, ['rev-list', '--first-parent', '--reverse', to, `^${from}`]).split('\n').filter((l) => l !== '') as Sha[];
  const candidates = line.filter((c) => c === to || heads.has(c));
  if (candidates.at(-1) !== to) throw new Error(`${to} is not on its own first-parent line from ${from}`);
  // The largest candidate before `to` that fits, by bisection (a later revert can only make the found chunk shorter); the first at least.
  let lo = 0;
  let hi = candidates.length - 2;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fitsWhole(repo, from, candidates[mid]!, budget, derived)) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidates[found]!;
}
