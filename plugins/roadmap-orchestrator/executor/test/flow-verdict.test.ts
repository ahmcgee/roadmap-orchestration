// M4b step A2: verdicts (plan "Verdicts", G8, G9). Window samples and close, the before-window XmR test on the after-mean
// (log for lead), inconclusive below 3 samples, and the guards' absolute floors; the pressure metric (M4b rev 3, RC-12).
// Pure.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { laneId, obligationId, stationId, unitId } from '../src/core/ids.ts';
import { type IsoTime, isoTime } from '../src/core/values.ts';
import type { FlowMetric, FlowPoint, SuiteRun } from '../src/flow/types.ts';
import { type MetricSample, afterOf, beforeOf, closeWindow, guardBreaches, verdictOf, windowSamples } from '../src/flow/verdict.ts';

const at = (min: number): IsoTime => isoTime(new Date(Date.UTC(2026, 9, 8, 0, 0) + min * 60_000).toISOString());
const OPENED = at(600);
const LEAD: FlowMetric = { type: 'lead' };
const SUITE: FlowMetric = { type: 'suite-run', lane: laneId('unit') };

let n = 0;
function point(admitted: number, merged: number, extra: Partial<FlowPoint> = {}): FlowPoint {
  const leadMin = merged - admitted;
  return { unit: unitId(`u${++n}`), admittedAt: at(admitted), mergedAt: at(merged), leadMin, minutes: { [stationId('stage:build')]: leadMin }, costUsd: null, rework: 0, firstRunReds: 0, pressure: null, stationPressure: {}, ...extra };
}
const run = (min: number, minutes: number, lane = 'unit'): SuiteRun => ({ lane: laneId(lane), at: at(min), minutes, shape: 'lane', red: false, pressure: null });
const samples = (...xs: readonly [number, number][]): MetricSample[] => xs.map(([t, m]) => ({ at: at(t), minutes: m }));

describe('window samples', () => {
  it('before: the last 5 completed at or before the revision; after: units admitted after it; a straddling unit is neither', () => {
    const before = [0, 50, 100, 150, 200, 250].map((t) => point(t, t + 40));
    const straddle = point(560, 650);
    const after = [point(610, 700), point(620, 720)];
    const w = windowSamples(LEAD, OPENED, { points: [...before, straddle, ...after].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt)), suiteRuns: [] });
    assert.deepEqual(w.beforePoints, before.slice(1));
    assert.deepEqual(w.afterPoints, after);
    assert.deepEqual(w.after, samples([700, 90], [720, 100]));
    const wait = windowSamples({ type: 'wait', station: stationId('wait:slot:integration') }, OPENED, { points: [point(610, 700, { minutes: { [stationId('wait:slot:integration')]: 30, [stationId('stage:build')]: 60 } }), point(620, 700)], suiteRuns: [] });
    assert.deepEqual(wait.after.map((s) => s.minutes), [30, 0], 'a unit that never waited there waited 0');
  });

  it('a suite lane\'s per-run service: runs of that lane only, after the revision', () => {
    const w = windowSamples(SUITE, OPENED, { points: [], suiteRuns: [run(500, 6), run(590, 6.2), run(600, 6.1), run(610, 6, 'lint'), run(620, 2.1)] });
    assert.deepEqual(w.before.map((s) => s.minutes), [6, 6.2, 6.1]);
    assert.deepEqual(w.after, samples([620, 2.1]));
  });
});

describe('the pressure metric (RC-12)', () => {
  const PRESSURE: FlowMetric = { type: 'pressure' };
  it('samples the units\' interval pressure on each side; a unit without one is no sample; lead stays a guard', () => {
    const before = [0, 50, 100, 150, 200, 250, 300].map((t, i) => point(t, t + 40, { pressure: [0.4, 0.41, 0.42, 0.43, 0.44, null, 0.46][i] ?? null }));
    const after = [point(610, 700, { pressure: 0.1 }), point(620, 710, { pressure: null }), point(630, 720, { pressure: 0.12 }), point(640, 730, { pressure: 0.09 })];
    const w = windowSamples(PRESSURE, OPENED, { points: [...before, ...after], suiteRuns: [] });
    assert.deepEqual(w.before.map((s) => s.minutes), [0.41, 0.42, 0.43, 0.44, 0.46], 'the last five measured');
    assert.deepEqual(w.after.map((s) => s.minutes), [0.1, 0.12, 0.09]);
    assert.deepEqual(w.beforePoints, before.slice(2), 'the guards read the last five merged');
    const b = beforeOf(PRESSURE, w.before);
    assert.ok(Math.abs(b.centre - 0.432) < 1e-9, 'on the raw scale');
    assert.equal(verdictOf(PRESSURE, b, afterOf(w.after, { at: Date.parse(at(800)), reason: 'samples' }), []), 'improved');
    const slow = [point(610, 800), point(620, 900), point(630, 690)];
    assert.deepEqual(guardBreaches({ metric: PRESSURE, beforePoints: [], afterPoints: slow, leadUcl: Math.log(120), unheld: [] }).map((g) => g.guard), ['lead']);
  });
});

describe('the window closes', () => {
  const five = samples([610, 1], [620, 1], [630, 1], [640, 1], [650, 1], [660, 1]);
  it('at the fifth sample, taking at most 5', () => {
    const close = closeWindow(OPENED, at(700), five, [], null);
    assert.deepEqual(close, { at: Date.parse(at(650)), reason: 'samples' });
    assert.deepEqual(afterOf(five, close!).samples.length, 5);
    assert.equal(closeWindow(OPENED, at(645), five, [], null), null, 'open before the fifth');
  });

  it('after 6 h of non-idle time: a drain stops the clock, an ongoing one holds the window open', () => {
    const two = samples([610, 1], [620, 1]);
    assert.deepEqual(closeWindow(OPENED, at(600 + 361), two, [], null), { at: Date.parse(at(960)), reason: 'time' });
    const drained = [{ from: at(700), to: at(820) }, { from: at(500), to: at(610) }];
    assert.equal(closeWindow(OPENED, at(1000), two, drained, null), null, '6 h minus 130 idle minutes not yet over');
    assert.deepEqual(closeWindow(OPENED, at(1100), two, drained, null), { at: Date.parse(at(1090)), reason: 'time' });
    assert.equal(closeWindow(OPENED, at(5000), two, [{ from: at(700), to: null }], null), null);
  });

  it('at arc-completed, with what it has; samples after the close are not taken', () => {
    const three = samples([610, 1], [620, 1], [640, 1]);
    const close = closeWindow(OPENED, at(700), three, [], at(630));
    assert.deepEqual(close, { at: Date.parse(at(630)), reason: 'arc-completed' });
    assert.deepEqual(afterOf(three, close!), { samples: [1, 1] });
  });
});

describe('the verdict', () => {
  // Before: 6.0, 6.2, 6.1, 5.9, 6.0 → centre 6.04, mR̄ 0.15; for n = 3 the limits are 6.04 ∓ 0.230.
  const before = beforeOf(SUITE, samples([1, 6], [2, 6.2], [3, 6.1], [4, 5.9], [5, 6]));
  it('improved, worse or no-effect by the after-mean against centre ∓ 2.66·mR̄/√n', () => {
    assert.ok(Math.abs(before.centre - 6.04) < 1e-9 && Math.abs(before.mrBar - 0.15) < 1e-9);
    assert.equal(verdictOf(SUITE, before, { samples: [2.1, 2.2, 2.0] }, []), 'improved', 'the plant: 6 min → 2 min');
    assert.equal(verdictOf(SUITE, before, { samples: [6.4, 6.3, 6.3] }, []), 'worse');
    assert.equal(verdictOf(SUITE, before, { samples: [5.9, 6.0, 6.1] }, []), 'no-effect');
    assert.equal(verdictOf(SUITE, before, { samples: [5.85, 5.85, 5.85] }, []), 'no-effect', 'inside 6.04 − 0.230');
  });

  it('lead is tested on the log scale', () => {
    const lead = beforeOf(LEAD, samples([1, 100], [2, 120], [3, 80], [4, 110], [5, 90]));
    assert.ok(Math.abs(lead.centre - [100, 120, 80, 110, 90].map(Math.log).reduce((a, b) => a + b) / 5) < 1e-12);
    // Mean of the raw after-samples (85) is below the raw before-mean (100), but on log 40/130/85 is no signal.
    assert.equal(verdictOf(LEAD, lead, { samples: [40, 130, 85] }, []), 'no-effect');
    assert.equal(verdictOf(LEAD, lead, { samples: [40, 45, 50] }, []), 'improved');
  });

  it('below 3 samples inconclusive; any guard breach worse, whatever the samples', () => {
    assert.equal(verdictOf(SUITE, before, { samples: [2, 2] }, []), 'inconclusive');
    assert.equal(verdictOf(SUITE, before, { samples: [] }, []), 'inconclusive');
    // M4b B1: a before-window of fewer than 3 samples (an undefined or single moving range) is inconclusive too; empty reads as 0, 0.
    const thin = beforeOf(SUITE, samples([1, 6], [2, 6.2]));
    assert.equal(verdictOf(SUITE, thin, { samples: [2.1, 2.2, 2.0] }, []), 'inconclusive');
    assert.deepEqual(beforeOf(SUITE, []), { samples: [], centre: 0, mrBar: 0 });
    assert.equal(verdictOf(SUITE, beforeOf(SUITE, []), { samples: [2.1, 2.2, 2.0] }, [{ guard: 'cost', detail: 'd' }]), 'worse', 'a breach still decides');
    assert.equal(verdictOf(SUITE, before, { samples: [2] }, [{ guard: 'rework', detail: 'd' }]), 'worse');
    assert.equal(verdictOf(SUITE, before, { samples: [2.1, 2.2, 2.0] }, [{ guard: 'obligation', detail: 'd' }]), 'worse');
  });
});

describe('guards', () => {
  const base = (afterPoints: readonly FlowPoint[], beforePoints: readonly FlowPoint[] = [point(0, 60), point(10, 70), point(20, 80)]) =>
    ({ metric: SUITE, beforePoints, afterPoints, leadUcl: Math.log(120), unheld: [] });
  it('none on a calm window', () => assert.deepEqual(guardBreaches(base([point(610, 670), point(620, 700), point(630, 760)])), []));

  it('lead beyond its upper limit on 2 samples, only when lead is not the metric', () => {
    const slow = [point(610, 800), point(620, 900), point(630, 690)];
    assert.deepEqual(guardBreaches(base(slow)).map((g) => g.guard), ['lead']);
    assert.deepEqual(guardBreaches({ ...base(slow), metric: LEAD }), [], 'lead is the metric itself');
    assert.deepEqual(guardBreaches(base([point(610, 800), point(630, 690)])), [], 'one sample over');
  });

  it('rework and first-run reds: one more per three merges', () => {
    const after = [point(610, 670, { rework: 1, firstRunReds: 1 }), point(620, 680), point(630, 690)];
    assert.deepEqual(guardBreaches(base(after)).map((g) => g.guard), ['rework', 'first-run-reds']);
    assert.deepEqual(guardBreaches(base([...after, point(640, 700)])), [], 'one per four is under the floor');
    const before = [point(0, 60, { rework: 1 }), point(10, 70), point(20, 80)];
    assert.deepEqual(guardBreaches(base(after, before)).map((g) => g.guard), ['first-run-reds'], 'rework as before');
  });

  it('an obligation un-held, and cost per merge above the before-window\'s upper limit, in FLOW_GUARDS order', () => {
    const costly = (c: number) => (t: number) => point(t, t + 60, { costUsd: c });
    const before = [0, 10, 20, 30].map((t, i) => point(t, t + 60, { costUsd: [1.0, 1.2, 0.9, 1.1][i] ?? null }));
    const breaches = guardBreaches({ ...base([610, 620, 630].map(costly(3)), before), unheld: [obligationId('I-4')] });
    assert.deepEqual(breaches.map((g) => g.guard), ['obligation', 'cost']);
    assert.deepEqual(guardBreaches(base([610, 620, 630].map(costly(1.1)), before)), [], 'within the limit');
    assert.deepEqual(guardBreaches(base([610, 620].map(costly(9)))), [], 'no before-window cost: no cost guard');
  });
});
