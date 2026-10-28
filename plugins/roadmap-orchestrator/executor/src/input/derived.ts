// Derived files (derived exclusion, 2026-10-27; 1.0.0-dev.26): the one place a unit's effective scope widening is computed. A plan's
// `derived` entries name files the build regenerates from others (`{sources, outputs}`, src/input/plan.ts). A unit whose
// scope may reach a source pattern (`mayOverlap`, prefix-conservative) takes that entry's outputs: its dispatch record
// pins them as `derived` (src/pipeline/dispatch.ts), and salvage, the gate, the transient check and recovery read
// the record's `effectiveScope` (src/core/records.ts). Outputs without a covered source are excluded from the write set;
// Phase 0 keeps outputs off the corpus (src/phase0/rows.ts).
//
// Regenerate checks (dev.12): an entry declaring `regenerate` becomes a fast lane, `regenerateLane`, which the lanes stage
// runs first among the fast suite lanes (src/pipeline/stages.ts `fastSuite`) for a unit whose diff touches one of the
// entry's sources or outputs. The lane runs the executor's own check (src/pipeline/regenerate.ts) in the clean checkout
// of the unit's commit: the generator runs, and every output must come out byte-identical to what the commit holds. So a
// hand edit hidden in a regenerated file is a red lane, with the same red-lane protocol, evidence, base check and fix
// round as any fast suite lane, before any gate reads the diff.
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../core/json.ts';
import { type AbsPath, type RepoPath, type RepoPattern, absPath, matchesPattern, repoPath } from '../core/values.ts';
import { resolveArgv0 } from '../preflight/argv0.ts';
import type { BuildLane } from '../prompts/inputs.ts';
import { mayOverlap } from './classify.ts';
import { patternExcluded } from './envelope.ts';
import { type DerivedFiles, type PlanM1, derivedOf, regenerateLaneId } from './plan.ts';

/** Whether a scope may reach one of an entry's sources. */
export const coversSource = (scope: readonly RepoPattern[], entry: DerivedFiles): boolean =>
  scope.some((s) => entry.sources.some((src) => mayOverlap(s, src)));

/** The outputs a unit of scope `scope` takes in, ascending, each once, none it already names. */
export function derivedWidening(plan: PlanM1, scope: readonly RepoPattern[]): readonly RepoPattern[] {
  const out = new Set(derivedOf(plan).filter((d) => coversSource(scope, d)).flatMap((d) => d.outputs));
  return [...out].filter((p) => !scope.includes(p)).sort();
}

/**
 * Outputs the scope may reach without covering a source, ascending, once each (derived exclusion, 2026-10-27; 1.0.0-dev.26).
 * Inclusion wins across entries: covering a source of any entry permits writing its outputs, even when another entry
 * excludes the same output. Use all included outputs here, including those already named by the plan scope.
 */
export function derivedExclusions(plan: PlanM1, scope: readonly RepoPattern[]): readonly RepoPattern[] {
  const included = new Set(derivedOf(plan).filter((d) => coversSource(scope, d)).flatMap((d) => d.outputs));
  return [...new Set(derivedOf(plan).filter((d) => !coversSource(scope, d)).flatMap((d) => d.outputs))]
    .filter((p) => !included.has(p) && scope.some((s) => mayOverlap(s, p))).sort();
}

/** Why a proposed pattern would remain excluded after growth, or null when it can be written (dev.26). */
export function derivedGrowthReason(plan: PlanM1, grownScope: readonly RepoPattern[], pattern: RepoPattern): string | null {
  const excluded = derivedExclusions(plan, grownScope).filter((o) => patternExcluded(pattern, [o]));
  if (excluded.length === 0) return null;
  const sources = [...new Set(derivedOf(plan).filter((d) => d.outputs.some((o) => excluded.includes(o))).flatMap((d) => d.sources))].sort();
  return `a derived output generated from ${sources.join(', ')}: grow a source instead`;
}

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
