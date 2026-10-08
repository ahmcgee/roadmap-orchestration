// M4a rev 3 step N2, `admits.run9-exact` (B, LR-m, free-tier gate 3): the exact records of paid M4a run 9 replayed through
// `classifyAdmits` (test/helpers/run9.ts over test/fixtures/run9-admits.json, the synthetic Tidewater domain).
//   - Exact: the recorded answers predate `targets` and classify on the structural floor (declared, delivered and
//     repaired obligations' rules, all in-slice here): every admit is a repair, so (a) every in-slice repair stays a
//     repair and (b) the V-5 cancellation chain has no opportunity. Its V-5 work is under-declared, which the brief's
//     drift indicator backstops.
//   - Synthetic: cancel-texts declares targets [T-44] and cites V-5: cancel-texts = O-1, cancel-text-first = its follow-up,
//     cancel-text-staged = converted follow-up-overrun with debt naming O-1.
//   - Ordering: draught-refusal also declares its out-of-slice draught rules [T-13, T-14] citing V-7 and takes O-1
//     first; cancel-texts then converts over-budget, and the later cancel-text units, attributed to no opportunity and
//     targeting no out-of-slice rule on the floor, are plain repairs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Declared, outcomeOf, replayRun9 } from './helpers/run9.ts';

const table = (d: Declared = {}) => replayRun9(undefined, d).map((r) => [r.unit, outcomeOf(r)]);
const CANCEL_TEXTS: Declared = { 'cancel-texts': { targets: ['T-44'], cites: ['V-2', 'V-3', 'V-4', 'V-5'] } };

test('admits.run9-exact: the recorded run-9 admits classify on the structural floor: every in-slice repair stays a repair', () => {
  assert.deepEqual(table(), [
    ['draught-refusal', 'repair'], ['stay-overlap', 'repair'], ['booked-line-first', 'repair'], ['overlap-clarity', 'repair'],
    ['no-phone-witness', 'repair'], ['cancel-own-booking', 'repair'], ['cancel-texts', 'repair'], ['cancel-text-first', 'repair'],
    ['cancel-text-staged', 'repair'],
  ]);
});

test('admits.run9-declared-targets: cancel-texts declaring T-44 (citing V-5) is O-1; cancel-text-first its follow-up; cancel-text-staged converts', () => {
  assert.deepEqual(table(CANCEL_TEXTS).slice(6), [
    ['cancel-texts', 'opportunity O-1 V-5'], ['cancel-text-first', 'repair follow-up O-1'], ['cancel-text-staged', 'converted follow-up-overrun O-1'],
  ]);
  assert.deepEqual(table(CANCEL_TEXTS).slice(0, 6).map(([, o]) => o), Array(6).fill('repair'), 'the units before the chain stay repairs');
});

test('admits.run9-declared-ordering: draught-refusal declaring its out-of-slice draught rules takes O-1 first; cancel-texts converts over-budget', () => {
  assert.deepEqual(table({ ...CANCEL_TEXTS, 'draught-refusal': { targets: ['T-13', 'T-14'], cites: ['V-3', 'V-4', 'V-7'] } }), [
    ['draught-refusal', 'opportunity O-1 V-7'], ['stay-overlap', 'repair'], ['booked-line-first', 'repair'], ['overlap-clarity', 'repair'],
    ['no-phone-witness', 'repair'], ['cancel-own-booking', 'repair'], ['cancel-texts', 'converted over-budget'], ['cancel-text-first', 'repair'],
    ['cancel-text-staged', 'repair'],
  ]);
});
