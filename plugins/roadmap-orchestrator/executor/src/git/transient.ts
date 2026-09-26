// The unit diff and the two candidate validations that run on it in code (DESIGN §3 "Merge"):
//
// - `diffBase(T, branch)` is the one diff base everyone uses: `merge-base(T, branch)`. It is recomputed on
//   every call, so after a merge-in (whose commit has T as a parent) it is T itself.
// - The transient check refuses a unit diff that touches in-tree `.roadmap/` outside the published
//   allowlist, run state or evidence, or files only the executor writes. Nothing transient may reach a
//   candidate, so the tested head is the published head and the PR diff stays product-only. A violation is
//   a scope-growth finding for a normal fix round, never a silent drop.
// - The prefix-collision guard refuses a candidate whose new paths would collide on a case-insensitive
//   filesystem. Collisions already present at T are grandfathered.
import { matchesGlob } from 'node:path';
import type { Sha } from '../core/ids.ts';
import { type AbsPath, type RepoPath, type RepoPattern, repoPath } from '../core/values.ts';
import { git, lsTree, mergeBase } from './git.ts';

export class DiffBaseError extends Error {
  constructor(tip: Sha, branch: Sha) {
    super(`no merge base between integration tip ${tip} and ${branch}: the unit does not descend from the baseline`);
    this.name = 'DiffBaseError';
  }
}

/** `merge-base(T, branch)`: the base of every unit diff. A unit always shares history with integration. */
export function diffBase(repo: AbsPath, tip: Sha, branch: Sha): Sha {
  const base = mergeBase(repo, tip, branch);
  if (base === null) throw new DiffBaseError(tip, branch);
  return base;
}

/** Every path the unit diff `diffBase(T, branch)..branch` adds, modifies or deletes (renames split in two). */
export function unitDiffPaths(repo: AbsPath, tip: Sha, branch: Sha): readonly RepoPath[] {
  const base = diffBase(repo, tip, branch);
  const out = git(repo, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', base, branch]);
  return out.split('\0').filter((s) => s !== '').map((p) => repoPath(p)).sort();
}

// ---------------------------------------------------------------------------------------------------
// Transient check

/** The in-tree `.roadmap/` entries publication owns (DESIGN §2.9). Everything else under `.roadmap/` is refused. */
export const ROADMAP_ALLOWLIST = ['contracts/', 'constraints.md', 'invariants.md', 'debt.md', 'config.json'] as const;

export type TransientRule =
  /** Under `.roadmap/` but not in ROADMAP_ALLOWLIST. */
  | 'roadmap-dir'
  /** A run dir (`roadmap-runtime/`, `.roadmap-runtime/`) or a scratch dir (`__preview/`, `__codex/`). */
  | 'run-state'
  /** Top-level `evidence/`, or a declared lane `evidenceGlobs` match. */
  | 'evidence'
  /** A file only the executor writes: the event log and its fragments, or a runner file in an invocation dir. */
  | 'executor-file';

export type TransientViolation = Readonly<{ path: RepoPath; rule: TransientRule }>;

export type TransientRules = Readonly<{
  /** The spec's declared lane `evidenceGlobs` (every lane's, active or not). */
  evidenceGlobs: readonly RepoPattern[];
}>;

const RUN_STATE_SEGMENTS: ReadonlySet<string> = new Set(['roadmap-runtime', '.roadmap-runtime', '__preview', '__codex']);
const RUNNER_FILES: ReadonlySet<string> = new Set(['launch.json', 'runner.json', 'cancel.json', 'exit.json', 'result.json', 'reads.json', 'stdout', 'stderr', 'runner.log']);
/** `<seq>-<ordinal>`: the name of an invocation dir under the run dir's `inv/`. */
const INVOCATION_DIR = /^[1-9][0-9]*-[1-9][0-9]*$/;

function roadmapAllowed(rest: string): boolean {
  return ROADMAP_ALLOWLIST.some((entry) => (entry.endsWith('/') ? rest.startsWith(entry) : rest === entry));
}

function transientRule(rules: TransientRules, path: RepoPath): TransientRule | null {
  const segments = path.split('/');
  if (segments[0] === '.roadmap') return roadmapAllowed(segments.slice(1).join('/')) ? null : 'roadmap-dir';
  if (segments.some((s) => RUN_STATE_SEGMENTS.has(s))) return 'run-state';
  if (segments[0] === 'evidence') return 'evidence';
  if (rules.evidenceGlobs.some((g) => matchesGlob(path, g) || matchesGlob(path, `${g.replace(/\/+$/, '')}/**`))) return 'evidence';
  const name = segments[segments.length - 1]!;
  if (name === 'events.jsonl' || name.startsWith('events.torn.')) return 'executor-file';
  const parent = segments[segments.length - 2];
  if (parent !== undefined && INVOCATION_DIR.test(parent) && RUNNER_FILES.has(name)) return 'executor-file';
  return null;
}

/** The violations in a list of paths, sorted by path. Empty means the diff passes. */
export function transientViolations(rules: TransientRules, paths: readonly RepoPath[]): readonly TransientViolation[] {
  return paths.flatMap((path) => {
    const rule = transientRule(rules, path);
    return rule === null ? [] : [{ path, rule }];
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The transient check over the unit diff `diffBase(T, branch)..branch`. */
export function transientCheck(repo: AbsPath, rules: TransientRules, tip: Sha, branch: Sha): readonly TransientViolation[] {
  return transientViolations(rules, unitDiffPaths(repo, tip, branch));
}

// ---------------------------------------------------------------------------------------------------
// Prefix-collision guard

export type PrefixCollision = Readonly<{
  /** The path the candidate adds. */
  path: RepoPath;
  /** The candidate-tree path it collides with. */
  existing: RepoPath;
  /** `case-fold-equal`: the same path ignoring case; `directory-prefix`: one is a directory the other needs as a file. */
  kind: 'case-fold-equal' | 'directory-prefix';
}>;

/** Case folding for path comparison: NFC (so composed and decomposed accents meet), then upper-then-lower. */
const fold = (s: string): string => s.normalize('NFC').toUpperCase().toLowerCase();

const dirsOf = (path: string): string[] => {
  const segments = path.split('/');
  return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join('/'));
};

/**
 * Collisions between the paths the candidate adds (in `candidate`'s tree, absent from `tip`'s) and every
 * other path of the candidate tree. Pairs where both paths exist at T are never reported (grandfathered),
 * since only added paths are checked; a case-only rename (the old spelling deleted) does not collide.
 */
export function prefixCollisions(repo: AbsPath, tip: Sha, candidateTree: Sha): readonly PrefixCollision[] {
  const atTip = new Set(lsTree(repo, tip).map((e) => e.path));
  const paths = lsTree(repo, candidateTree).map((e) => e.path);
  const byFold = new Map<string, RepoPath[]>();
  const dirByFold = new Map<string, RepoPath>();
  for (const p of paths) {
    const f = fold(p);
    byFold.set(f, [...(byFold.get(f) ?? []), p]);
    for (const d of dirsOf(p)) if (!dirByFold.has(fold(d))) dirByFold.set(fold(d), p);
  }
  const out: PrefixCollision[] = [];
  for (const path of paths.filter((p) => !atTip.has(p))) {
    const f = fold(path);
    const equal = (byFold.get(f) ?? []).find((p) => p !== path);
    if (equal !== undefined) {
      out.push({ path, existing: equal, kind: 'case-fold-equal' });
      continue;
    }
    // The new path names, ignoring case, a directory some other path lies under.
    const under = dirByFold.get(f);
    if (under !== undefined) {
      out.push({ path, existing: under, kind: 'directory-prefix' });
      continue;
    }
    // A directory the new path needs is, ignoring case, another path's file.
    const file = dirsOf(path).map((d) => byFold.get(fold(d))?.[0]).find((p) => p !== undefined);
    if (file !== undefined) out.push({ path, existing: file, kind: 'directory-prefix' });
  }
  return out;
}

