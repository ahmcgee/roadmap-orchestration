// Checkpoint admit classes (M4a rev 3, OR-A1, LR-k; B "Checkpoint admits"): `classifyAdmits` gives each `admit` op of a
// bundle its class (repair, oversight, opportunity) by R45's nine-row table, or converts it (unrelated, over-budget,
// follow-up-overrun), and lists the invalid repair refs as reasons. Pure; runs once inside `decide`, under the fence, and
// its result is persisted in the decision record (Q4). Corpus arcs only (LR-h).
// PLACEHOLDER (step N0, H3): step N2 replaces this module in place.
import { notYet } from '../core/notyet.ts';
import type { ClassifiedAdmit, Conversion } from './types.ts';

export type AdmitClassification = Readonly<{ classes: readonly ClassifiedAdmit[]; conversions: readonly Conversion[]; reasons: readonly string[] }>;

export function classifyAdmits(): AdmitClassification {
  return notYet('classifyAdmits', 'N2');
}
