// Re-derivation at Phase 0 (LR-b, R2; DESIGN-1.0.md §2.8; M3 step A1): the previous arc's published obligations,
// the JSON block of the baseline tree's `.roadmap/invariants.md`, diffed by I-nn against the new obligations file.
// The startup row `obligation-dropped` (A2) refuses every previous id that is missing or weakened (the classifier's
// test, `weakeningsOf`) with no Phase-0 ruling dispositioning it. A split parent is present; a retired one may
// leave; new ids are free; no block (a first arc) means nothing to diff. Pure.
import { parseInvariantsBlock } from '../docs/invariants.ts';
import { dispositionRuling, weakeningsOf } from './obligations.ts';
import type { Obligations, RulingSidecar } from './types.ts';

/** Why the new obligations drop or weaken a published one silently; empty when nothing is dropped. */
export function rederive(baselineInvariants: string | null, next: Obligations | null, rulings: readonly RulingSidecar[]): readonly string[] {
  const previous = baselineInvariants === null ? null : parseInvariantsBlock(baselineInvariants);
  if (previous === null) return [];
  return previous.obligations.flatMap((p) => {
    const n = next?.obligations.find((o) => o.id === p.id);
    return weakeningsOf(p, n).flatMap((w) => (dispositionRuling(rulings, p.id, w) === null
      ? [`obligation-dropped: ${p.id} (${w.what}) has no Phase-0 ruling naming it ${w.disposition}`]
      : []));
  });
}
