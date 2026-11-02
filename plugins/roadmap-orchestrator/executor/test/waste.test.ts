import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Event } from '../src/core/events.ts';
import { laneId, unitId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { parsePlan } from '../src/input/plan.ts';
import { grinding, lowUniqueCatch, redOnUnitGreenOnBase, repeatedExpensiveSuites, raiseWasteFindings, type LaneRun } from '../src/flow/waste.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';

const run = (over: Partial<LaneRun> = {}): LaneRun => ({ lane: laneId('suite'), unit: unitId('u1'), series: 'v1/lanes#1', at: 'unit', set: 'suite', minutes: 6, verdict: 'pass', ...over });
const outcome = (attempt: number, stage = 'build'): Event => ({ type: 'fact', fact: { kind: 'stage-outcome', unit: 'u1', stage, attempt, outcome: 'success', class: 'advance', chargeable: false } }) as Event;

test('waste grinding counts every build and judged stage, with the calibrated 8/20 thresholds', () => {
  assert.deepEqual(grinding(Array.from({ length: 7 }, (_, i) => outcome(i + 1))), []);
  assert.equal(grinding(Array.from({ length: 8 }, (_, i) => outcome(i + 1)))[0]?.detector, 'grinding');
  assert.equal(grinding(Array.from({ length: 20 }, (_, i) => outcome(i + 1, 'gate')))[0]?.unit, 'u1');
  assert.deepEqual(grinding(Array.from({ length: 30 }, (_, i) => outcome(i + 1, 'salvage'))), []);
});
test('waste red on unit / green on base requires the same lane and stage series at different commits', () => {
  const red = run({ verdict: 'fail' });
  assert.equal(redOnUnitGreenOnBase([red, run({ at: 'base' })]).length, 1);
  for (const other of [run(), run({ at: 'base', verdict: 'fail' }), run({ at: 'base', series: 'other' }), run({ at: 'base', lane: laneId('other') })]) assert.deepEqual(redOnUnitGreenOnBase([red, other]), []);
});
test('waste low unique catch needs ten executions; a lone red retains the lane', () => {
  assert.deepEqual(lowUniqueCatch(Array.from({ length: 9 }, () => run())), []);
  assert.equal(lowUniqueCatch(Array.from({ length: 10 }, () => run())).length, 1);
  assert.deepEqual(lowUniqueCatch([...Array.from({ length: 9 }, () => run()), run({ verdict: 'fail' })]), []);
  assert.equal(lowUniqueCatch([...Array.from({ length: 10 }, () => run({ verdict: 'fail' })), run({ lane: laneId('other'), verdict: 'fail' })]).length, 1);
});
test('waste repeated expensive suites excludes reuse and cheap spec lanes', () => {
  assert.equal(repeatedExpensiveSuites([run(), run(), run()], new Set()).length, 1);
  assert.deepEqual(repeatedExpensiveSuites([run(), run()], new Set()), []);
  assert.deepEqual(repeatedExpensiveSuites([run({ minutes: 1 }), run({ minutes: 1 }), run({ minutes: 1 })], new Set()), []);
  assert.equal(repeatedExpensiveSuites([run({ minutes: 1 }), run({ minutes: 1 }), run({ minutes: 1 })], new Set([laneId('suite')])).length, 1);
  assert.deepEqual(repeatedExpensiveSuites([run({ set: 'spec' }), run({ set: 'spec' }), run({ set: 'spec' })], new Set([laneId('suite')])), []);
});
test('waste items are non-blocking and persist only once per detector subject across replay', () => {
  const d = setupArc({ steps: [], units: [{ id: 'u1' }, { id: 'u2' }] }); const r = contextFor(d); let closed = false;
  try {
    for (const unit of ['u1', 'u2']) for (let i = 1; i <= 8; i++) r.journal.fact({ kind: 'stage-outcome', unit: unitId(unit), stage: 'build', attempt: i, outcome: 'success', class: 'advance', chargeable: false });
    const ctx = { journal: r.journal, runDir: absPath(d.runDir), plan: () => parsePlan(JSON.parse(readFileSync(d.planPath, 'utf8'))) };
    raiseWasteFindings(ctx); raiseWasteFindings(ctx);
    const items = r.journal.view.needsUser().map((n) => readNeedsUser(ctx.runDir, n.id)).filter((n) => n?.reason === 'waste-finding');
    assert.equal(items.length, 2);
    assert.deepEqual(r.journal.view.opsOf('needsuser.raise').map((i) => i.parent), [{ type: 'waste', key: 'grinding:u1' }, { type: 'waste', key: 'grinding:u2' }]); assert.equal(items[0]?.blocking, false); assert.equal(r.journal.view.unit(unitId('u1')).status, 'active');
    r.journal.close(); closed = true;
    const replayed = contextFor(d);
    try {
      raiseWasteFindings({ ...ctx, journal: replayed.journal });
      assert.equal(replayed.journal.view.opsOf('needsuser.raise').length, 2);
      assert.equal(replayed.journal.view.needsUser().length, 2);
    } finally { replayed.journal.close(); }
  } finally { if (!closed) r.journal.close(); }
});
