// The obligation transition table (§2.8; plan "Witnesses, observations, the transition table"; frozen in M3 step
// 0a, B1 builds the observations it reads). Pure and total: `obligationEffect` maps every case to one effect, and
// test/m3-schemas.test.ts (`table.total`) enumerates every case, split parents included (H14).
//
// | Obligation    | Case                                          | Effect                                                     |
// |---------------|-----------------------------------------------|------------------------------------------------------------|
// | future        | not completing `deliveredBy`                  | measured                                                   |
// | future        | completing, held                              | latch (on publication)                                     |
// | future        | completing, otherwise                         | red                                                        |
// | must-hold     | held on this tree or validly reused           | discharged                                                 |
// | must-hold     | otherwise                                     | red                                                        |
// | split parent  | never witnessed directly                      | red when a selected child is red; discharged when every    |
// |               |                                               | non-exempt child is discharged; else measured              |
// | any           | waived, deferred or retired                   | exempt                                                     |
//
// "Held" is an observation verdict of `held` on the evaluated tree, or a valid reuse (all four keys and the records'
// hash match); `not-held`, `partial`, `unwitnessed`, skip, zero-selected, stale or missing are "otherwise". A latched
// future obligation is must-hold from its latch on (the caller passes its effective activation).
import type { ObligationId, UnitId } from '../core/ids.ts';
import { type ObligationDef, type ObservationVerdict, type WitnessRef, isExempt } from './types.ts';

export const OBLIGATION_EFFECTS = ['measured', 'latch', 'red', 'discharged', 'exempt'] as const;
export type ObligationEffect = (typeof OBLIGATION_EFFECTS)[number];

/** One obligation's situation on the evaluated tree, as the caller derives it from the obligation and its observation. */
export type ObligationCase =
  /** Waived, deferred or retired: only a disposition ruling exempts an obligation. */
  | Readonly<{ type: 'exempt' }>
  /** `completing`: the candidate completes the obligation's `deliveredBy`. `verdict`: null when not observed. */
  | Readonly<{ type: 'future'; completing: boolean; verdict: ObservationVerdict | null }>
  /** `verdict`: this tree's observation, or a validly reused one; null when neither exists. */
  | Readonly<{ type: 'must-hold'; verdict: ObservationVerdict | null }>
  /** A split parent is never witnessed directly: its children's effects decide (each marked selected or not). */
  | Readonly<{ type: 'split'; children: readonly Readonly<{ effect: ObligationEffect; selected: boolean }>[] }>;

/** The effect of one case: the table above, total. */
export function obligationEffect(c: ObligationCase): ObligationEffect {
  switch (c.type) {
    case 'exempt':
      return 'exempt';
    case 'future':
      if (!c.completing) return 'measured';
      return c.verdict === 'held' ? 'latch' : 'red';
    case 'must-hold':
      return c.verdict === 'held' ? 'discharged' : 'red';
    case 'split': {
      if (c.children.some((ch) => ch.selected && ch.effect === 'red')) return 'red';
      return c.children.filter((ch) => ch.effect !== 'exempt').every((ch) => ch.effect === 'discharged') ? 'discharged' : 'measured';
    }
  }
}

/** The brake (§2.8): a candidate is green only with its suite green and no selected obligation's effect `red`. */
export const brakes = (effects: readonly ObligationEffect[]): boolean => effects.includes('red');

// ---------------------------------------------------------------------------------------------------
// The table over an obligations file (B1): each obligation's case, derived from its definition, its latch, the
// candidate's selection and completion, and its observation on the evaluated tree.

/** What `obligationEffects` reads. */
export type EffectsInput = Readonly<{
  obligations: readonly ObligationDef[];
  /** The candidate's selection, split closure applied (impact.ts). */
  selected: ReadonlySet<ObligationId>;
  /** Future obligations latched by an earlier publication: must-hold from their latch on. */
  latched: ReadonlySet<ObligationId>;
  /** Future obligations whose `deliveredBy` this candidate completes (`completes`). */
  completing: ReadonlySet<ObligationId>;
  /** A witnessed obligation's verdict on the evaluated tree, or a validly reused one; null when neither exists. */
  verdict: (obligation: ObligationDef, witness: WitnessRef) => ObservationVerdict | null;
}>;

/**
 * Whether a candidate publishing `units` completes a future obligation's `deliveredBy`: every delivering unit is
 * then published, and at least one of them by this candidate.
 */
export function completes(o: ObligationDef, published: ReadonlySet<UnitId>, units: readonly UnitId[]): boolean {
  return o.deliveredBy.some((u) => units.includes(u)) && o.deliveredBy.every((u) => published.has(u) || units.includes(u));
}

/** Every obligation's effect (the table, total); a split parent's from its children's, recursively (H14). */
export function obligationEffects(input: EffectsInput): ReadonlyMap<ObligationId, ObligationEffect> {
  const defs = new Map(input.obligations.map((o) => [o.id, o]));
  const out = new Map<ObligationId, ObligationEffect>();
  const effectOf = (id: ObligationId): ObligationEffect => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const o = defs.get(id);
    if (o === undefined) throw new Error(`obligation ${id} is not in the obligations file`);
    const effect = obligationEffect(caseOf(o));
    out.set(id, effect);
    return effect;
  };
  const caseOf = (o: ObligationDef): ObligationCase => {
    if (isExempt(o)) return { type: 'exempt' };
    if (o.state.type === 'split') return { type: 'split', children: o.state.children.map((c) => ({ effect: effectOf(c), selected: input.selected.has(c) })) };
    if (o.witness === null) throw new Error(`obligation ${o.id} is active with no witness`);
    const verdict = input.verdict(o, o.witness);
    if (o.activation === 'must-hold' || input.latched.has(o.id)) return { type: 'must-hold', verdict };
    return { type: 'future', completing: input.completing.has(o.id), verdict };
  };
  for (const o of input.obligations) effectOf(o.id);
  return out;
}

/** The obligations a publication latches: its `latch` effects, ascending (`obligation-latched` after `ff{published}`). */
export const latches = (effects: ReadonlyMap<ObligationId, ObligationEffect>): readonly ObligationId[] =>
  [...effects].filter(([, e]) => e === 'latch').map(([id]) => id).sort();

/** The brake over a selection: any selected obligation's effect `red`. */
export function brakesOn(effects: ReadonlyMap<ObligationId, ObligationEffect>, selected: ReadonlySet<ObligationId>): boolean {
  return brakes([...selected].map((id) => {
    const e = effects.get(id);
    if (e === undefined) throw new Error(`selected obligation ${id} is not in the obligations file`);
    return e;
  }));
}
