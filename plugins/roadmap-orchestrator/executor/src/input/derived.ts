import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../core/json.ts';
import { type AbsPath, type RepoPath, type RepoPattern, absPath, matchesPattern, repoPath } from '../core/values.ts';
import { resolveArgv0 } from '../preflight/argv0.ts';
import type { BuildLane } from '../prompts/inputs.ts';
import { type DerivedFiles, type PlanM1, derivedOf, regenerateLaneId } from './plan.ts';

/** The check a regenerate lane runs (src/entry/regenerate.ts over src/pipeline/regenerate.ts): `node <entry> <git> <request json>`. */
export const REGENERATE_ENTRY: AbsPath = absPath(fileURLToPath(new URL('../entry/regenerate.ts', import.meta.url)));

/** What the check reads from its one argument: the generator's argv and cwd, and the outputs it must reproduce. */
export type RegenerateRequest = Readonly<{ argv: readonly string[]; cwd: RepoPath; outputs: readonly RepoPattern[] }>;

/** The executor's own git, at its real path: the check reads the checkout with it whatever PATH the generator declares. */
function executorGit(): string {
  const git = resolveArgv0({ argv: ['git'], env: { set: {}, pass: ['PATH'] } }, process.env);
  if (git.kind !== 'program') throw new Error(`the executor's PATH has no git (${process.env['PATH'] ?? 'unset'})`);
  return git.realpath;
}

/**
 * An entry's regenerate check as a fast lane (null when it declares no `regenerate`): the executor's node running the
 * check from the checkout's root with the executor's git, under the generator's declared env, expecting exit 0. No
 * resources, the build cadence's `@cpu`, no evidence globs (the check's stdout names each differing output and its
 * difference), no systems (it reads the whole tree).
 */
export function regenerateLane(entry: DerivedFiles): BuildLane | null {
  const r = entry.regenerate;
  if (r === undefined) return null;
  const request: RegenerateRequest = { argv: r.argv, cwd: r.cwd, outputs: entry.outputs };
  return {
    id: regenerateLaneId(entry), argv: [process.execPath, REGENERATE_ENTRY, executorGit(), canonicalJson(request)], cwd: repoPath('.'), env: r.env, expectedExit: 0,
    cadence: 'build', resources: [], evidenceGlobs: [], evidenceExcludes: [],
  };
}

/** Every regenerate lane of the plan, in entry order: what a series' ledger is read back with. */
export const regenerateLanes = (plan: PlanM1): readonly BuildLane[] => derivedOf(plan).flatMap((d) => regenerateLane(d) ?? []);

/** Whether a diff of `paths` touches one of the entry's sources or outputs. */
export const touchesEntry = (paths: readonly RepoPath[], entry: DerivedFiles): boolean =>
  paths.some((p) => [...entry.sources, ...entry.outputs].some((pattern) => matchesPattern(p, pattern)));

/** The regenerate lanes a unit diff of `paths` runs: the entries it touches that declare `regenerate`, in entry order. */
export const unitRegenerateLanes = (plan: PlanM1, paths: readonly RepoPath[]): readonly BuildLane[] =>
  derivedOf(plan).filter((d) => touchesEntry(paths, d)).flatMap((d) => regenerateLane(d) ?? []);
