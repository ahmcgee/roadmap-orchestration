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
import type { ObservationVerdict } from './types.ts';

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
