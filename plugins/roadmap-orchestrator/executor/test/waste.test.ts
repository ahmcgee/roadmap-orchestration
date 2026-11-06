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

test('waste indexes preserve finding order, repeated lanes, distinct commits and minute sums', () => {
  const runs = Array.from({ length: 600 }, (_, i) => run({ lane: laneId(`lane-${i % 7}`), unit: unitId(`u${i % 5 + 1}`),
    series: `series-${i % 11}`, at: `commit-${i % 3}`, verdict: ['fail', 'pass', 'timeout', 'stall'][i % 4]!, minutes: i / 53 }));
  // The pre-optimization definitions, retained as a parity oracle over interleaved series and duplicate reds.
  const reds = new Map<string, unknown>();
  for (const r of runs) if (r.unit !== null && ['fail', 'stall', 'timeout'].includes(r.verdict)
    && runs.find((b) => b.series === r.series && b.lane === r.lane && b.at !== r.at && b.verdict === 'pass')) {
    const key = `red-on-unit-green-on-base:${r.unit}:${r.lane}`;
    reds.set(key, { key, detector: 'red-on-unit-green-on-base', unit: r.unit, summary: `${r.unit}: ${r.lane} red on the unit, green on its base; inspect the fix rounds.` });
  }
  assert.deepEqual(redOnUnitGreenOnBase(runs), [...reds.values()]);
  const lanes = new Map<string, { runs: number; unique: number }>();
  for (const r of runs) {
    const n = lanes.get(r.lane) ?? { runs: 0, unique: 0 }; n.runs++;
    if (r.verdict === 'fail' && !runs.some((b) => b.series === r.series && b.at === r.at && b.lane !== r.lane && b.verdict === 'fail')) n.unique++;
    lanes.set(r.lane, n);
  }
  assert.deepEqual(lowUniqueCatch(runs), [...lanes].flatMap(([lane, n]) => n.runs >= 10 && n.unique === 0 ? [{ key: `low-unique-catch:${lane}`, detector: 'low-unique-catch', unit: null, summary: `${lane}: ${n.runs} executions, no unique red series; review its coverage and cadence.` }] : []));
  const expensive = new Set([laneId('lane-0')]);
  const groups = new Map<string, LaneRun[]>();
  for (const r of runs) if (r.set === 'suite' && (expensive.has(r.lane) || r.minutes >= 5)) { const rs = groups.get(r.lane) ?? []; rs.push(r); groups.set(r.lane, rs); }
  assert.deepEqual(repeatedExpensiveSuites(runs, expensive), [...groups].flatMap(([lane, rs]) => rs.length >= 3 ? [{ key: `repeated-expensive-suite:${lane}`, detector: 'repeated-expensive-suite', unit: null, summary: `${lane}: ${rs.length} expensive suite executions (${rs.reduce((n, r) => n + r.minutes, 0).toFixed(1)} min); review reuse and cadence.` }] : []));
});

test('waste kernels cost under 15x thread CPU for 10x lane runs (minimum of alternating repeats)', (t) => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => run({ series: `series-${i % 128}`, lane: laneId(i % 2 ? 'red' : 'green'), verdict: i % 2 ? 'fail' : 'pass', minutes: 1 }));
  const small = make(2_000), large = make(20_000), expensive = new Set([laneId('red'), laneId('green')]);
  const kernels = [redOnUnitGreenOnBase, lowUniqueCatch, (rs: readonly LaneRun[]) => repeatedExpensiveSuites(rs, expensive)];
  for (const [k, kernel] of kernels.entries()) {
    const measure = (rs: readonly LaneRun[], batch: number) => {
      const began = process.threadCpuUsage(); let count = 0;
      for (let i = 0; i < batch; i++) count += kernel(rs).length;
      const cpu = process.threadCpuUsage(began);
      assert.equal(count, batch * (k === 2 ? 2 : k === 1 ? 1 : 0));
      return (cpu.user + cpu.system) / 1000;
    };
    measure(small, 1); measure(large, 1);
    // Calibrate outside the comparison, so a regressed quadratic kernel still fails in seconds.
    let batch = 1;
    while (measure(small, batch) < 20 && batch < 1_024) batch *= 2;
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < 2; i++) { a.push(measure(small, batch)); b.push(measure(large, batch)); }
    const ratio = Math.min(...b) / Math.min(...a);
    t.diagnostic(`kernel ${k} (${batch} calls): ${a.map(Math.round)} / ${b.map(Math.round)} ms CPU; ratio ${ratio.toFixed(2)}`);
    assert.ok(ratio < 15, `waste kernel ${k}: 10x runs cost ${ratio.toFixed(2)}x CPU`);
  }
});
