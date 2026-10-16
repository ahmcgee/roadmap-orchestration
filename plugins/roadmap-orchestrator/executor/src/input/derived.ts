// Derived files (plan defects, 2026-10-16): the one place a unit's effective scope widening is computed. A plan's
// `derived` entries name files the build regenerates from others (`{sources, outputs}`, src/input/plan.ts). A unit whose
// scope may reach a source pattern (`mayOverlap`, prefix-conservative) takes that entry's outputs: its dispatch record
// pins them as `derived` (src/pipeline/dispatch.ts), and salvage, the gate, the transient check and recovery read
// the record's `effectiveScope` (src/core/records.ts). Phase 0 keeps outputs off the corpus and out of the scope of a
// unit that covers none of the entry's sources (src/phase0/rows.ts).
import type { RepoPattern } from '../core/values.ts';
import { mayOverlap } from './classify.ts';
import { type DerivedFiles, type PlanM1, derivedOf } from './plan.ts';

/** Whether a scope may reach one of an entry's sources. */
export const coversSource = (scope: readonly RepoPattern[], entry: DerivedFiles): boolean =>
  scope.some((s) => entry.sources.some((src) => mayOverlap(s, src)));

/** The outputs a unit of scope `scope` takes in, ascending, each once, none it already names. */
export function derivedWidening(plan: PlanM1, scope: readonly RepoPattern[]): readonly RepoPattern[] {
  const out = new Set(derivedOf(plan).filter((d) => coversSource(scope, d)).flatMap((d) => d.outputs));
  return [...out].filter((p) => !scope.includes(p)).sort();
}
