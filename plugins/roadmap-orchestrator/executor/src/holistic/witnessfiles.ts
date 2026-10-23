// Witness files against their lane (plan defects, 2026-10-16): the one predicate Phase 0 (src/phase0/rows.ts) and the
// lanes stage's diagnosis of missing witnesses (src/pipeline/witnesscheck.ts) share. A witness declares the files that
// hold its test ids (`WitnessRef.files`): no reporter maps a test id to its file (a node-test id is a name path, a go id
// a test name, a wrapper's id its own), so the files are declared and checked, never inferred.
//
// A file is in its lane when both hold:
//   - test paths   a pattern of the lane's `testPaths` matches it (`matchesPattern`).
//   - argv         when the lane's argv names test paths, one of them reaches it. An argv element names a test path when
//                  it is no flag (`-…`), resolves inside the repo against the lane's `cwd`, and is the repo root or may
//                  overlap one of the lane's `testPaths` (`mayOverlap`); a go package pattern's `/...` reads as its
//                  directory. It reaches the file when it is the root, the file itself, a directory above it, or a glob
//                  matching it (`matchesPattern`). An argv that names no test path (`npm test`, a bare `node --test`)
//                  leaves selection to the runner: `testPaths` alone decides.
// A lane without `testPaths` (inputs recorded before 2026-10-16) decides nothing here.
import { posix } from 'node:path';
import { type LaneDef, cadenceAtOrBefore } from '../core/records.ts';
import type { RepoPath, RepoPattern } from '../core/values.ts';
import { matchesPattern, repoPattern } from '../core/values.ts';
import { mayOverlap } from '../input/classify.ts';
import type { ArcLaneDef } from './types.ts';

/** The repo patterns a lane's argv names test files by (empty: the runner selects). */
export function argvTestPaths(lane: ArcLaneDef, testPaths: readonly RepoPattern[]): readonly RepoPattern[] {
  return lane.argv.slice(1).flatMap((arg) => {
    if (arg === '' || arg.startsWith('-')) return [];
    const dir = arg === '...' ? '.' : arg.endsWith('/...') ? arg.slice(0, -4) || '.' : arg;
    if (posix.isAbsolute(dir)) return [];
    const resolved = posix.normalize(posix.join(lane.cwd, dir)).replace(/\/+$/, '') || '.';
    if (resolved === '..' || resolved.startsWith('../')) return [];
    if (resolved !== '.' && !testPaths.some((t) => mayOverlap(resolved, t))) return [];
    return [repoPattern(resolved)];
  });
}

/**
 * Why a lane would never run a test: its file outside the lane's `testPaths` or not named by its argv (`laneMisses`); or
 * (dev.17, design pass: `laneUnreachable`) the lane runs only after the unit's proof point and is not forced (`cadence`), or
 * its systems are not ones the unit's change selects it by (`systems`).
 */
export type LaneMiss = 'test-paths' | 'argv' | 'cadence' | 'systems';

/** Why `lane` would never run `file`: outside its `testPaths`, or not named by an argv that names test paths; null when it runs it. */
export function laneMisses(lane: ArcLaneDef, file: RepoPath): Extract<LaneMiss, 'test-paths' | 'argv'> | null {
  const testPaths = lane.testPaths;
  if (testPaths === undefined) return null;
  if (!testPaths.some((t) => matchesPattern(file, t))) return 'test-paths';
  const named = argvTestPaths(lane, testPaths);
  if (named.length > 0 && !named.some((p) => p === '.' || matchesPattern(file, p))) return 'argv';
  return null;
}

/**
 * dev.17 (design pass): why a test in `lane` would never run for the unit before its proof point (the candidate merge, the
 * last run before it merges): the lane's cadence is `batch` (never in the merge path) and the unit's spec does not force it
 * (`cadence`); or the lane lists systems and `selected` (the unit's change selects it, src/input/systems.ts `laneSelected` over
 * the design record's systems) is false (`systems`). Null when the test runs at or before that point.
 */
export function laneUnreachable(lane: Pick<LaneDef, 'cadence' | 'systems'>, forced: boolean, selected: boolean): Extract<LaneMiss, 'cadence' | 'systems'> | null {
  if (forced) return null;
  if (!cadenceAtOrBefore(lane.cadence, 'candidate')) return 'cadence';
  return selected ? null : 'systems';
}
