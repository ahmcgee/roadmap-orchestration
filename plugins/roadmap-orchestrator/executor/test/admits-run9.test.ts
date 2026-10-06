// M4a rev 3 step N2, `admits.run9-exact` (B, free-tier gate 3): the exact records of paid M4a run 9 replayed through
// `classifyAdmits` (test/helpers/run9.ts over test/fixtures/run9-admits.json, the synthetic Tidewater domain).
//
// GATE MISS, reported to the lead (N2 report): the plan expects cancel-texts = O-1, cancel-text-first = O-1 follow-up,
// cancel-text-staged = converted with debt naming O-1. The binding rules (R44–R48, Q1) give something else on these
// records, pinned below so a rule change shows here:
//   - Lens findings carry horizon world clauses as context (F-1 [V-3,V-4,V-7], F-5 and F-9 with V-6, F-13 with V-6).
//     Q1 keeps a mixed finding's out-of-slice clauses, so the first repair of one (draught-refusal, ckpt-1) touches V-7:
//     dishonest-citation, and its honest retry takes O-1 {V-7}; stay-overlap and overlap-clarity then convert over-budget.
//   - cancel-texts implements T-44 (census out-of-slice, serving V-5 in the corpus), but its only code-visible inputs
//     (cites V-2..V-4, F-20 over V-2..V-4, no delivered obligation) are in the slice: repair{followUp: null}.
//   - So cancel-text-first and cancel-text-staged (F-25..F-29 carry V-5) have no opportunity lineage: dishonest-citation,
//     then over-budget after the honest retry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outcomeOf, replayRun9 } from './helpers/run9.ts';

test('admits.run9-exact: the run-9 admits, replayed exactly with honest-citation retries, classify as the binding rules say (gate miss: see the header)', () => {
  const replayed = replayRun9();
  assert.deepEqual(replayed.map((r) => [r.job, r.unit, outcomeOf(r)]), [
    ['ckpt-1', 'draught-refusal', 'opportunity O-1 V-7'],
    ['ckpt-4', 'stay-overlap', 'converted over-budget'],
    ['ckpt-7', 'booked-line-first', 'repair'],
    ['ckpt-9', 'overlap-clarity', 'converted over-budget'],
    ['ckpt-11', 'no-phone-witness', 'repair'],
    ['ckpt-13', 'cancel-own-booking', 'repair'],
    ['ckpt-15', 'cancel-texts', 'repair'],
    ['ckpt-17', 'cancel-text-first', 'converted over-budget'],
    ['ckpt-19', 'cancel-text-staged', 'converted over-budget'],
  ]);
  const retried = replayed.filter((r) => r.retry !== null).map((r) => [r.unit, r.first.reasons.map((x) => /dishonest-citation: (V-\d+)/.exec(x)?.[1]).join(',')]);
  assert.deepEqual(retried, [
    ['draught-refusal', 'V-7'], ['stay-overlap', 'V-6'], ['overlap-clarity', 'V-6'], ['cancel-text-first', 'V-5'], ['cancel-text-staged', 'V-5'],
  ], 'the honest-citation retries: each first answer cited in-slice clauses only');
});
