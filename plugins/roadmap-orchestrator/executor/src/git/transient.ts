// The unit diff and the two candidate validations that run on it in code (DESIGN §3 "Merge"):
//
// - `diffBase(T, branch)` is the one diff base everyone uses: `merge-base(T, branch)`. It is recomputed on
//   every call, so after a merge-in (whose commit has T as a parent) it is T itself.
// - The transient check refuses a unit diff that touches run state or evidence, files only the executor
//   writes, or in-tree `.roadmap/` (H15): any `.roadmap/` path and any path outside the unit's pinned scope.
//   Nothing transient may reach a candidate, so the tested head is the published head and the
//   PR diff stays product-only. A violation is a scope-growth finding for a normal fix round, never a
//   silent drop.
// - The docs check (G17) confines a docs publication's diff to the `.roadmap/` files it renders and its
//   contract ops' paths.
// - The prefix-collision guard refuses a candidate whose new paths would collide on a case-insensitive
//   filesystem. Collisions already present at T are grandfathered.
import type { LaneId, Sha } from '../core/ids.ts';
import { type DispatchRecord, type SpecM1, effectiveScope } from '../core/records.ts';
import { type AbsPath, type RepoPath, type RepoPattern, matchesPattern, repoPath } from '../core/values.ts';
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

export type TransientRule =
  /** Under `.roadmap/`. */
  | 'roadmap-dir'
  /** A path no pattern of the unit's pinned scope matches. */
  | 'out-of-scope'
  /** The docs check: a path that is neither a rendered `.roadmap/` file nor a contract op's path. */
  | 'not-docs'
  /** A run dir (`roadmap-runtime/`, `.roadmap-runtime/`) or a scratch dir (`__preview/`, `__codex/`). */
  | 'run-state'
  /** Top-level `evidence/`. */
  | 'evidence'
  /** A declared lane `evidenceGlobs` match: the violation names the lane and the entry. */
  | 'lane-evidence'
  /** A file only the executor writes: the event log and its fragments, or a runner file in an invocation dir. */
  | 'executor-file';

export type TransientViolation =
  | Readonly<{ path: RepoPath; rule: Exclude<TransientRule, 'lane-evidence'> }>
  | Readonly<{ path: RepoPath; rule: 'lane-evidence'; lane: LaneId; glob: RepoPattern }>;

/** One `evidenceGlobs` entry of a spec lane. */
export type LaneEvidenceGlob = Readonly<{ lane: LaneId; glob: RepoPattern }>;

/**
 * H15: no `.roadmap/` path, and every path inside `scope`, the dispatch record's effective scope (its pinned scope,
 * re-pinned on a ruled growth, and its derived outputs). `evidenceGlobs`: the spec's declared lane `evidenceGlobs` (every lane's, active or not), in spec order.
 */
export type TransientRules = Readonly<{ evidenceGlobs: readonly LaneEvidenceGlob[]; scope: readonly RepoPattern[] }>;

/** Every `evidenceGlobs` entry of a spec's lanes, active or not, in spec order. */
export const laneEvidenceGlobs = (spec: SpecM1): readonly LaneEvidenceGlob[] =>
  spec.lanes.flatMap((l) => l.evidenceGlobs.map((glob) => ({ lane: l.id, glob })));

/** The rules of a unit's candidate from its latest dispatch record and its spec in force. */
export function unitTransientRules(dispatch: DispatchRecord, spec: SpecM1): TransientRules {
  return { evidenceGlobs: laneEvidenceGlobs(spec), scope: effectiveScope(dispatch) };
}

const RUN_STATE_SEGMENTS: ReadonlySet<string> = new Set(['roadmap-runtime', '.roadmap-runtime', '__preview', '__codex']);
const RUNNER_FILES: ReadonlySet<string> = new Set(['launch.json', 'runner.json', 'cancel.json', 'exit.json', 'result.json', 'reads.json', 'stdout', 'stderr', 'runner.log']);
/** `<seq>-<ordinal>`: the name of an invocation dir under the run dir's `inv/`. */
const INVOCATION_DIR = /^[1-9][0-9]*-[1-9][0-9]*$/;

function violationOf(rules: TransientRules, path: RepoPath): TransientViolation | null {
  const segments = path.split('/');
  if (segments[0] === '.roadmap') return { path, rule: 'roadmap-dir' };
  if (segments.some((s) => RUN_STATE_SEGMENTS.has(s))) return { path, rule: 'run-state' };
  if (segments[0] === 'evidence') return { path, rule: 'evidence' };
  const declared = rules.evidenceGlobs.find((g) => matchesPattern(path, g.glob));
  if (declared !== undefined) return { path, rule: 'lane-evidence', lane: declared.lane, glob: declared.glob };
  const name = segments[segments.length - 1]!;
  if (name === 'events.jsonl' || name.startsWith('events.torn.')) return { path, rule: 'executor-file' };
  const parent = segments[segments.length - 2];
  if (parent !== undefined && INVOCATION_DIR.test(parent) && RUNNER_FILES.has(name)) return { path, rule: 'executor-file' };
  if (!rules.scope.some((p) => matchesPattern(path, p))) return { path, rule: 'out-of-scope' };
  return null;
}

const byPath = (a: TransientViolation, b: TransientViolation): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The violations in a list of paths, sorted by path. Empty means the diff passes. */
export function transientViolations(rules: TransientRules, paths: readonly RepoPath[]): readonly TransientViolation[] {
  return paths.flatMap((path) => violationOf(rules, path) ?? []).sort(byPath);
}

/**
 * The docs check (G17): a docs publication's diff paths may be only `allowed`, the files it publishes (its
 * renders, the vision files among them, and a corpus arc's `debt.md`) plus its contract ops' paths. Every other path
 * is a `not-docs` violation, sorted by path.
 */
export function docsTransientViolations(paths: readonly RepoPath[], allowed: readonly RepoPath[]): readonly TransientViolation[] {
  const ok = new Set<string>(allowed);
  return paths.filter((p) => !ok.has(p)).map((path): TransientViolation => ({ path, rule: 'not-docs' })).sort(byPath);
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

