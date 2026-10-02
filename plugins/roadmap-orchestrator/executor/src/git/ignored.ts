// A lane's ignored output (DESIGN-1.0.md §4, Lanes): the gitignored files a lane created or changed in its
// verification checkout, which no tree state records and the checkout's removal destroys. Every lane gets a
// census of them (`ignored.json`, what the gate's ledger and a fix round show), and a lane that did not pass
// also gets the undeclared ones captured, within caps, into its `ignored` snapshot: the evidence a script
// that writes its own logs leaves when nobody declared `evidenceGlobs` for it.
//
// Detection: `git ls-files --others --ignored --exclude-standard` lists each ignored file (inside ignored
// dirs too); a file counts when its ctime is at or after the lane's start. ctime, not mtime: `cp -p` and tar
// extraction keep an old mtime but set ctime. The checkout is fresh per series, so an earlier lane's files
// are older than this lane's start.
//
// Selection, in path order, each file taking the first reason that applies: declared (already in the
// lane's `tree` snapshot: captured) → not a regular file → under a build-output dir → excluded (the
// default secret list plus the lane's `evidenceExcludes`) → lane passed (`not-declared`) → no exact glob
// → over the per-file cap → over the lane's caps (skipped, and later files still tried) → captured.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { type FileCount, type IgnoredCensus, type IgnoredGroup, type IgnoredReason, IGNORED_REASONS } from '../core/records.ts';
import { type AbsPath, type RepoPath, type RepoPattern, matchesPattern, repoPath, repoPattern } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { literalPattern } from './evidence.ts';
import { git } from './git.ts';

/** A single file this large is a dump or an artefact, not something a fix round reads. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Per lane: bounds the run dir's growth from a lane that fails every round. */
export const MAX_LANE_BYTES = 25 * 1024 * 1024;
/** Per lane: more files than this is a tree, not evidence, and would swell the snapshot's journal intent. */
export const MAX_LANE_FILES = 1000;
/** Census groups kept per lane, largest first; the rest fold into one `(other)` group per reason. */
export const CENSUS_GROUPS = 20;
/** Directory names whose contents are build output at any depth: rebuilt, never evidence. */
const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set(['bin', 'obj', 'dist', 'build', 'target', 'node_modules', '.venv', '__pycache__']);
/**
 * Never captured by default: key material and credentials. A leading `**` also crosses dot directories here
 * (`matchesExclude`), which a glob's own `**` does not; a dotfile needs its own pattern (`.*kubeconfig*`).
 */
export const SECRET_EXCLUDES: readonly RepoPattern[] = [
  '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx', '**/*kubeconfig*', '**/.*kubeconfig*', '**/.kube/**', '**/id_rsa*', '**/id_ed25519*',
  '**/.env', '**/.env.*',
].map((p) => repoPattern(p));

/** One gitignored file the lane wrote: its size (lstat) and whether it is a regular file. */
export type IgnoredWrite = Readonly<{ path: RepoPath; bytes: number; regular: boolean }>;

/** The gitignored, untracked files under `tree` whose ctime is at or after `sinceMs`, in path order. */
export function ignoredWrites(tree: AbsPath, sinceMs: number): readonly IgnoredWrite[] {
  const listed = git(tree, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter((s) => s !== '');
  const out: IgnoredWrite[] = [];
  // A nested repository is listed as its directory, with a trailing slash.
  for (const path of [...new Set(listed.map((p) => p.replace(/\/+$/, '')))].sort()) {
    const st = lstatSync(join(tree, path));
    if (st.ctimeMs >= sinceMs) out.push({ path: repoPath(path), bytes: st.size, regular: st.isFile() });
  }
  return out;
}

/** `pattern` as salvage matches it (a glob or a directory prefix), with a leading `**` also crossing dot dirs. */
function matchesExclude(path: RepoPath, pattern: RepoPattern): boolean {
  if (matchesPattern(path, pattern)) return true;
  if (!pattern.startsWith('**/')) return false;
  const rest = repoPattern(pattern.slice(3));
  const segs = path.split('/');
  return segs.some((_, i) => matchesPattern(repoPath(segs.slice(i).join('/')), rest));
}

const underBuildOutput = (path: RepoPath): boolean => path.split('/').slice(0, -1).some((seg) => BUILD_OUTPUT_DIRS.has(seg));

/** `passed`: the lane's verdict; `declared`: the files its `tree` snapshot captured; `excludes`: its `evidenceExcludes`. */
export type IgnoredRules = Readonly<{ passed: boolean; declared: ReadonlySet<RepoPath>; excludes: readonly RepoPattern[] }>;

/** What to capture (exact globs, for the `ignored` snapshot; empty for a passing lane) and the census. */
export type IgnoredPlan = Readonly<{ capture: readonly RepoPattern[]; census: IgnoredCensus }>;

/** Why `w` is not captured whatever the lane's totals, or null. `pattern` is its exact glob when it has one. */
function fixedReason(w: IgnoredWrite, pattern: RepoPattern | null, rules: IgnoredRules): IgnoredReason | null {
  if (!w.regular) return 'not-regular';
  if (underBuildOutput(w.path)) return 'build-output';
  if ([...SECRET_EXCLUDES, ...rules.excludes].some((p) => matchesExclude(w.path, p))) return 'excluded';
  if (rules.passed) return 'not-declared';
  if (pattern === null) return 'unglobbable';
  if (w.bytes > MAX_FILE_BYTES) return 'over-file-cap';
  return null;
}

export function planIgnored(writes: readonly IgnoredWrite[], rules: IgnoredRules): IgnoredPlan {
  const capture: RepoPattern[] = [];
  const declared = { files: 0, bytes: 0 };
  const taken = { files: 0, bytes: 0 };
  const skipped: Skipped[] = [];
  for (const w of writes) {
    if (rules.declared.has(w.path)) {
      declared.files++;
      declared.bytes += w.bytes;
      continue;
    }
    const pattern = literalPattern(w.path);
    const reason = fixedReason(w, pattern, rules)
      ?? (taken.files + 1 > MAX_LANE_FILES || taken.bytes + w.bytes > MAX_LANE_BYTES ? 'over-lane-cap' : null);
    if (reason !== null) {
      skipped.push({ path: w.path, bytes: w.bytes, reason });
      continue;
    }
    // fixedReason is null only for a write with its exact glob.
    if (pattern === null) throw new Error(`ignored write ${w.path}: captured without an exact glob`);
    capture.push(pattern);
    taken.files++;
    taken.bytes += w.bytes;
  }
  const written = writes.reduce((n, w) => ({ files: n.files + 1, bytes: n.bytes + w.bytes }), { files: 0, bytes: 0 });
  return {
    capture,
    census: {
      v: SCHEMA_VERSION, written,
      captured: { files: declared.files + taken.files, bytes: declared.bytes + taken.bytes },
      uncaptured: groups(skipped),
    },
  };
}

/** A path's directory, at most two segments deep, as a census group names it. */
export function censusDir(path: RepoPath): string {
  const segs = path.split('/');
  return segs.length === 1 ? '(root)' : `${segs.slice(0, Math.min(2, segs.length - 1)).join('/')}/`;
}

type Skipped = Readonly<{ path: RepoPath; bytes: number; reason: IgnoredReason }>;

/** Skipped files grouped by (dir, reason): the CENSUS_GROUPS largest by files, then one `(other)` per reason. */
function groups(skipped: readonly Skipped[]): readonly IgnoredGroup[] {
  const by = new Map<string, IgnoredGroup>();
  for (const s of skipped) {
    const dir = censusDir(s.path);
    const key = `${s.reason}\0${dir}`;
    const g = by.get(key) ?? { dir, reason: s.reason, files: 0, bytes: 0 };
    by.set(key, { ...g, files: g.files + 1, bytes: g.bytes + s.bytes });
  }
  const all = [...by.values()].sort((a, b) => b.files - a.files || b.bytes - a.bytes || cmp(a.dir, b.dir) || cmp(a.reason, b.reason));
  const kept = all.slice(0, CENSUS_GROUPS);
  const other = IGNORED_REASONS.flatMap((reason): IgnoredGroup[] => {
    const rest = all.slice(CENSUS_GROUPS).filter((g) => g.reason === reason);
    if (rest.length === 0) return [];
    const n = rest.reduce<FileCount>((c, g) => ({ files: c.files + g.files, bytes: c.bytes + g.bytes }), { files: 0, bytes: 0 });
    return [{ dir: '(other)', reason, ...n }];
  });
  return [...kept, ...other];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
