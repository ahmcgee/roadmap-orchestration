// Re-derivation at Phase 0 (LR-b, R2; DESIGN-1.0.md §2.8; M3 step A1): the previous arc's published obligations,
// the JSON block of the baseline tree's `.roadmap/invariants.md`, diffed by I-nn against the new obligations file.
// The startup row `obligation-dropped` (A2) refuses every previous id that is missing or weakened (the classifier's
// test, `weakeningsOf`) with no Phase-0 ruling dispositioning it. A split parent is present; a retired one may
// leave; new ids are free; no block (a first arc) means nothing to diff. Pure. In a corpus arc the census is diffed
// against the pin too (`censusProblems`, M4a step C1).
import { type CorpusPin, activeRules } from '../corpus/types.ts';
import { parseInvariantsBlock } from '../docs/invariants.ts';
import type { Phase0Problem } from '../phase0/types.ts';
import { dispositionRuling, weakeningsOf } from './obligations.ts';
import { type CensusEntry, type Obligations, type RulingSidecar, isExempt, obligationSource } from './types.ts';

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

/**
 * The census diff of a corpus arc (M4a, DESIGN §2.8 "Re-derivation"): every active `T-n` of the pin has its one census
 * state (`census-incomplete`), no entry names a rule the pin does not hold active (`census-dangling`), and every
 * non-exempt obligation's `{T-n, textSha256}` resolves to an active rule of the pin (`obligation-rule-unresolved`). An
 * exempt (waived, deferred, retired) obligation binds nothing and may keep an anchor the pin no longer holds. Pure.
 */
export function censusProblems(o: Obligations & Readonly<{ census: readonly CensusEntry[] }>, pin: CorpusPin): readonly Phase0Problem[] {
  const active = activeRules(pin);
  const named = new Set(o.census.map((e) => e.rule));
  const out: Phase0Problem[] = [];
  const incomplete = pin.rules.filter((r) => !named.has(r.id)).map((r) => r.id);
  if (incomplete.length > 0) out.push({ type: 'census-incomplete', rules: incomplete });
  const dangling = o.census.filter((e) => !active.has(e.rule)).map((e) => e.rule);
  if (dangling.length > 0) out.push({ type: 'census-dangling', rules: dangling });
  for (const ob of o.obligations) {
    const src = obligationSource(ob);
    if (src.kind !== 'rule' || isExempt(ob)) continue;
    if (active.get(src.rule.id)?.textSha256 !== src.rule.textSha256) out.push({ type: 'obligation-rule-unresolved', obligation: ob.id });
  }
  return out;
}
