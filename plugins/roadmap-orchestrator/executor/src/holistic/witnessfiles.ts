// Witness files against their lane (plan defects, 2026-10-16): the one predicate Phase 0 (src/phase0/rows.ts) and the
// lanes stage's diagnosis of missing witnesses (src/pipeline/witnesscheck.ts) share. A witness declares the files that
// hold its test ids (`WitnessRef.files`): no reporter maps a test id to its file (a node-test id is a name path, a go id
// a test name, a wrapper's id its own), so the files are declared and checked, never inferred.
//
// A file is in its lane when both hold:
//   - test paths   when the lane declares `testPaths`, a pattern of them matches it (`matchesPattern`).
//   - argv         when the lane's argv names test paths, one of them reaches it. Two kinds of argv word name test paths,
//                  each no flag (`-…`, so a flag's `=value` never counts) and resolving inside the repo against the lane's
//                  `cwd`:
//                    - a test file (dev.59 pass 6, nu-119813: `isTestFileName`, the bounded diff's name rule), whatever the
//                      lane's `testPaths`; the whole argv is read, so a file list behind any number of wrapper layers
//                      (`lane.mjs … -- node guard.mjs <files>`) is the list the runner gets;
//                    - with `testPaths` declared, a directory or glob that is the repo root or may overlap one of them
//                      (`mayOverlap`); a go package pattern's `/...` reads as its directory. A word naming another file (an
//                      extension, no glob: a wrapper script, a config) names no test path.
//                  It reaches the file when it is the root, the file itself, a directory above it, or a glob matching it
//                  (`matchesPattern`). An argv that names no test path (`npm test`, a bare `node --test`, a wrapper
//                  around a bare runner) leaves selection to the runner: `testPaths` alone decides. dev.59 (item 6): a
//                  shell's command string (`sh|bash|dash|zsh -c '<script>'`) is read as the words of its script, so an
//                  explicit file list in it names test paths like one in argv.
// A lane without `testPaths` (inputs recorded before 2026-10-16) is checked by its argv's test files alone; Phase 0 refuses
// a fresh start's, and (dev.59) a revision's new one (src/phase0/rows.ts `witnessDefects`). A file list behind a package
// script (`pnpm test:x`) is out of sight here: the builder reports a witness its lane never selects as `specWrong`.
//
// dev.59 pass 7 (nu-119813, C-351): a spec witness item (`WitnessItemDef`) declares no files. Its file is derived from its
// `testId` (`specWitnessFile`): the first segment before " > ", against the lane's `cwd`, and only where that segment is a
// test file name (`isTestFileName`): a vitest or jsonl id leads with its file, a node-test id is a name path and derives
// nothing, so the item goes unchecked rather than guessed at. The derived file then meets the same `laneMisses`.
import { posix } from 'node:path';
import { type LaneDef, cadenceAtOrBefore } from '../core/records.ts';
import type { RepoPath, RepoPattern } from '../core/values.ts';
import { isTestFileName, matchesPattern, repoPath, repoPattern } from '../core/values.ts';
import { mayOverlap } from '../input/classify.ts';
import type { ArcLaneDef } from './types.ts';

/**
 * The repo patterns a lane's argv names test files by (empty: the runner selects): its test files, and with `testPaths`
 * declared its directories and globs that may overlap them.
 */
export function argvTestPaths(lane: ArcLaneDef, testPaths: readonly RepoPattern[] | undefined): readonly RepoPattern[] {
  return argvWords(lane.argv).flatMap((arg) => {
    if (arg === '' || arg.startsWith('-')) return [];
    const dir = arg === '...' ? '.' : arg.endsWith('/...') ? arg.slice(0, -4) || '.' : arg;
    if (posix.isAbsolute(dir)) return [];
    const resolved = posix.normalize(posix.join(lane.cwd, dir)).replace(/\/+$/, '') || '.';
    if (resolved === '..' || resolved.startsWith('../')) return [];
    if (isTestFileName(resolved)) return [repoPattern(resolved)];
    if (testPaths === undefined || namesOtherFile(resolved) || (resolved !== '.' && !testPaths.some((t) => mayOverlap(resolved, t)))) return [];
    return [repoPattern(resolved)];
  });
}

/** A word naming a file that is no test file (a wrapper script such as `scripts/lane.mjs`, a config): no glob, and an extension. */
const namesOtherFile = (path: string): boolean => !/[*?[{]/.test(path) && /\.[A-Za-z0-9]+$/.test(posix.basename(path));

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh']);

/**
 * The words after the program that may name test paths: argv's, or (dev.59) for a shell running a command string (`-c`, or
 * a flag cluster holding `c` such as `-ec`), the script's words, split on whitespace with quotes dropped. The words after
 * the script are `$0` and the positional parameters, which name nothing the lane runs.
 */
function argvWords(argv: readonly string[]): readonly string[] {
  const rest = argv.slice(1);
  if (!SHELLS.has(posix.basename(argv[0] ?? ''))) return rest;
  const flag = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
  const script = flag === -1 ? undefined : rest[flag + 1];
  return script === undefined ? rest : script.split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, '')).filter((w) => w !== '');
}

/**
 * The file a spec witness item's `testId` names (dev.59 pass 7): its first segment before " > ", resolved against the lane's
 * `cwd`, when that is a test file name inside the repo; null otherwise (nothing is derived, so nothing is checked).
 */
export function specWitnessFile(lane: Pick<ArcLaneDef, 'cwd'>, testId: string): RepoPath | null {
  const first = testId.split(' > ')[0]!.trim();
  if (first === '' || posix.isAbsolute(first) || !isTestFileName(first)) return null;
  const resolved = posix.normalize(posix.join(lane.cwd, first));
  return resolved === '..' || resolved.startsWith('../') ? null : repoPath(resolved);
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
  if (testPaths !== undefined && !testPaths.some((t) => matchesPattern(file, t))) return 'test-paths';
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
