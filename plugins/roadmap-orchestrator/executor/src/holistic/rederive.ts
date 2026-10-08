// Re-derivation at Phase 0 (LR-b, R2; DESIGN-1.0.md §2.8; M3 step A1): the previous arc's published obligations,
// the JSON block of the baseline tree's `.roadmap/invariants.md`, diffed by I-nn against the new obligations file.
// The startup row `obligation-dropped` (A2) refuses every previous id that is missing or weakened (the classifier's
// test, `weakeningsOf`) with no Phase-0 ruling dispositioning it. A split parent is present; a retired one may
// leave; new ids are free; no block (a first arc) means nothing to diff. Pure. In a corpus arc the census is diffed
// against the pin too (`censusProblems`, M4a step C1), and the specs against the census (`specCensusMismatches`).
import { type CorpusPin, activeRules } from '../corpus/types.ts';
import { parseInvariantsBlock } from '../docs/invariants.ts';
import type { ClauseId, RuleId, WitnessItemId } from '../core/ids.ts';
import { type SpecM1, specObligations, specWitnesses } from '../core/records.ts';
import type { Phase0Problem } from '../phase0/types.ts';
import { dispositionRuling, ruleAnchorResolves, weakeningsOf } from './obligations.ts';
import { type CensusEntry, type CensusState, type ObligationDef, type Obligations, type RulingSidecar, obligationSource } from './types.ts';

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
 * obligation's `{T-n, textSha256}` resolves in the pin (`obligation-rule-unresolved`, `ruleAnchorResolves`): a binding
 * one's to an active rule, an exempt (waived, deferred, retired) one's to an active or a retired one (LR-C1-2). Pure.
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
    if (obligationSource(ob).kind === 'rule' && !ruleAnchorResolves(ob, pin)) out.push({ type: 'obligation-rule-unresolved', obligation: ob.id });
  }
  return out;
}

const RULE_MENTION = /(?<![A-Za-z0-9-])T-[1-9][0-9]*(?![0-9])/g;

/**
 * The specs against the census (M4a rev 3, H3, F07; `spec-census-mismatch`), one predicate for every place it holds: the
 * Phase-0 rows of `start`, `apply` and `phase0 check` (src/phase0/rows.ts) and, since run 10 (C), the classifier of every
 * revision (src/input/classify.ts), so a bundle or an apply cannot break it after the start. Each is an obligation a spec
 * declares whose rule has a census state other than `obligation` naming it or its split ancestor (the reader makes that
 * hold for a binding one, so in practice an exempt obligation on a rule the census puts out of slice, untestable,
 * prod-only or on another obligation; an exempt one on a retired rule has no state), or an active acceptance clause or
 * (run 10) witness item (its test id or skeleton) naming (`T-n`) an out-of-slice rule. Pure.
 */
export function specCensusMismatches(specs: readonly SpecM1[], obligations: Obligations, census: readonly CensusEntry[]): readonly Extract<Phase0Problem, { type: 'spec-census-mismatch' }>[] {
  const stateOf = new Map<RuleId, CensusState>(census.map((e) => [e.rule, e.state]));
  const byId = new Map(obligations.obligations.map((o) => [o.id, o]));
  const out: Extract<Phase0Problem, { type: 'spec-census-mismatch' }>[] = [];
  for (const spec of specs) {
    for (const id of specObligations(spec)) {
      const o = byId.get(id);
      if (o === undefined) continue;
      const source = obligationSource(o);
      if (source.kind !== 'rule') continue;
      const rule = source.rule.id;
      const state = stateOf.get(rule);
      if (state === undefined) continue;
      let named = false;
      for (let at: ObligationDef | undefined = o; at !== undefined && !named; at = at.parent === undefined ? undefined : byId.get(at.parent)) {
        named = state.type === 'obligation' && state.id === at.id;
      }
      if (!named) out.push({ type: 'spec-census-mismatch', unit: spec.unit, item: id, rule, state: state.type });
    }
    const cited: readonly Readonly<{ id: ClauseId | WitnessItemId; text: string }>[] = [
      ...spec.acceptance.filter((a) => a.state === 'active').map((a) => ({ id: a.id, text: a.clause })),
      ...specWitnesses(spec).filter((w) => w.state === 'active').map((w) => ({ id: w.id, text: `${w.testId} ${w.skeleton}` })),
    ];
    for (const item of cited) {
      for (const mention of new Set(item.text.match(RULE_MENTION) ?? [])) {
        const rule = mention as RuleId;
        if (stateOf.get(rule)?.type === 'out-of-slice') out.push({ type: 'spec-census-mismatch', unit: spec.unit, item: item.id, rule, state: 'out-of-slice' });
      }
    }
  }
  return out;
}
