// M4b B1: the flow triggers (src/flow/trigger.ts), pure: evidence since the last run's start, coalesced; the 120-minute
// cooldown with one `requested` bypass per window (RC-5); the window rule; the first constraint label at 3 points (OI-1);
// the floor at 10 merges; buffer-red from the frozen chart, a point or a newly red in-flight unit; host-pressure (M4b rev
// 3) from a synthetic tick history.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandId, jobId, laneId, proposalId, sha256, stationId, unitId } from '../src/core/ids.ts';
import { type IsoTime, isoTime } from '../src/core/values.ts';
import type { FlowLog, FlowRun } from '../src/flow/log.ts';
import { type XmrLimits } from '../src/flow/spc.ts';
import { type TriggerInput, cooldownOf, dueTriggers, sustainedPressure } from '../src/flow/trigger.ts';
import type { PressureTick } from '../src/host/pressure.ts';
import type { FlowPoint, FlowWindow } from '../src/flow/types.ts';

const T0 = Date.parse('2026-10-08T09:00:00.000Z');
const at = (min: number): IsoTime => isoTime(new Date(T0 + min * 60_000).toISOString());
const H = sha256('a'.repeat(64));

/** A merged unit at `min` with a lead of `lead` minutes, all of it `station`. */
const point = (min: number, lead = 10, station = 'stage:build', unit = `u${min}`): FlowPoint => ({
  unit: unitId(unit), admittedAt: at(min - lead), mergedAt: at(min), leadMin: lead, minutes: { [stationId(station)]: lead }, costUsd: null, rework: 0, firstRunReds: 0, pressure: null, stationPressure: {},
});
const run = (n: number, min: number, code: { station: string } | null = null): FlowRun => ({
  started: { kind: 'flow-started', job: jobId('flow', n), triggers: ['floor'], inputsSha256: H, at: at(min), seq: n * 10 },
  ended: {
    kind: 'flow-ended', job: jobId('flow', n), outcome: 'done', proposal: null, dropped: null, at: at(min + 1), seq: n * 10 + 1,
    constraint: { code: code === null ? null : { station: stationId(code.station), internal: false, component: null }, judged: { station: stationId('stage:build'), agree: true, reason: 'r' } },
  },
});
const log = (x: Partial<{ runs: FlowRun[]; requests: number[]; verdicts: number[] }> = {}): FlowLog => ({
  runs: x.runs ?? [],
  requests: (x.requests ?? []).map((min, i) => ({ kind: 'flow-requested', command: commandId(`cmd-${String(i + 1).padStart(16, 'a')}`), reason: 'r', at: at(min), seq: 1000 + i })),
  decisions: new Map(), applied: new Map(),
  verdicts: new Map((x.verdicts ?? []).map((min, i) => [proposalId(`flow-${i + 1}.0`), {
    kind: 'flow-verdict', proposal: proposalId(`flow-${i + 1}.0`), metric: { type: 'lead' }, before: { samples: [], centre: 0, mrBar: 0 }, after: { samples: [] }, guards: [],
    verdict: 'inconclusive', preimage: { lever: 'concurrency', cpu: null }, at: at(min), seq: 2000 + i,
  }] as const)),
  series: [], completions: [], proposals: new Map(), accepted: [],
});
const input = (x: Partial<Omit<TriggerInput, 'now'>> & { now: number }): TriggerInput => ({ log: log(), points: [], limits: null, inFlight: [], window: null, pressure: [], ...x, now: at(x.now) });
/** Limits with the centre at 10 minutes and the upper limit at 20. */
const LIMITS: XmrLimits = { centre: Math.log(10), ucl: Math.log(20), mrBar: (Math.log(20) - Math.log(10)) / 2.66 };
const WINDOW: FlowWindow = { proposal: proposalId('flow-1.0'), lever: 'suite-lane', target: stationId('suite:unit'), metric: { type: 'suite-run', lane: laneId('unit') }, openedAt: at(0), samples: 1 };

describe('flow triggers', () => {
  it('nothing without evidence; a request; the floor at 10 merges since the last run', () => {
    assert.deepEqual(dueTriggers(input({ now: 300 })), []);
    assert.deepEqual(dueTriggers(input({ now: 300, log: log({ requests: [10] }) })), ['requested']);
    const ten = Array.from({ length: 10 }, (_, i) => point(200 + i, 10, 'stage:build', `m${i}`));
    assert.deepEqual(dueTriggers(input({ now: 300, points: ten, log: log({ runs: [run(1, 150, { station: 'stage:build' })] }) })), ['floor']);
    assert.deepEqual(dueTriggers(input({ now: 300, points: ten, log: log({ runs: [run(1, 205, { station: 'stage:build' })] }) })), [], 'five since the run');
  });

  it('constraint-shift: the first label once 3 points exist, then a change of the label the last run recorded', () => {
    const two = [point(10), point(20)];
    assert.deepEqual(dueTriggers(input({ now: 300, points: two })), [], 'OI-1: no label below 3 points');
    assert.deepEqual(dueTriggers(input({ now: 300, points: [...two, point(30)] })), ['constraint-shift']);
    const runs = [run(1, 40, { station: 'stage:build' })];
    assert.deepEqual(dueTriggers(input({ now: 300, points: [...two, point(30)], log: log({ runs }) })), [], 'the same label');
    assert.deepEqual(dueTriggers(input({ now: 300, points: [...two, point(30), point(200, 30, 'stage:gate'), point(210, 30, 'stage:gate')], log: log({ runs }) })), ['constraint-shift']);
  });

  it('the cooldown: 120 minutes from the last start; one requested bypass per window, coalescing what is due', () => {
    const points = [point(10), point(20), point(30)];
    const first = [run(1, 100)];
    assert.deepEqual(dueTriggers(input({ now: 150, points, log: log({ runs: first }) })), [], 'the label is due, the cooldown holds it');
    assert.deepEqual(dueTriggers(input({ now: 150, points, log: log({ runs: first, requests: [140] }) })), ['constraint-shift', 'requested'], 'a request bypasses and takes the rest along');
    assert.deepEqual(cooldownOf(log({ runs: first }), at(150)), { until: at(220), bypass: true });
    const bypassed = [run(1, 100), run(2, 150)];
    assert.deepEqual(cooldownOf(log({ runs: bypassed }), at(160)), { until: at(270), bypass: false });
    assert.deepEqual(dueTriggers(input({ now: 160, log: log({ runs: bypassed, requests: [155] }) })), [], 'a second bypass in the window is refused');
    assert.deepEqual(dueTriggers(input({ now: 271, log: log({ runs: bypassed, requests: [155] }) })), ['requested'], 'after the cooldown it fires');
  });

  it('under an open window only verdict-closed, buffer-red and requested fire', () => {
    const points = [point(10), point(20), point(30, 25)];
    const all = dueTriggers(input({ now: 300, points, limits: LIMITS, log: log({ requests: [40], verdicts: [50] }) }));
    assert.deepEqual(all, ['buffer-red', 'constraint-shift', 'verdict-closed', 'requested']);
    assert.deepEqual(dueTriggers(input({ now: 300, points, limits: LIMITS, window: WINDOW, log: log({ requests: [40], verdicts: [50] }) })), ['buffer-red', 'verdict-closed', 'requested']);
  });

  it('buffer-red: the latest point red and merged since; an in-flight unit red now and not at the last start; none without limits', () => {
    const runs = [run(1, 100, { station: 'stage:build' })];
    const red = [point(10), point(20), point(90, 25)];
    assert.deepEqual(dueTriggers(input({ now: 300, points: red, limits: LIMITS, log: log({ runs }) })), [], 'red before the last run');
    assert.deepEqual(dueTriggers(input({ now: 300, points: red, limits: null, inFlight: [{ unit: unitId('x'), ageMin: 400 }] })).includes('buffer-red'), false, 'no limits: no buffer trigger');
    const inFlight = (ageMin: number) => [{ unit: unitId('x'), ageMin }];
    assert.deepEqual(dueTriggers(input({ now: 300, limits: LIMITS, log: log({ runs }), inFlight: inFlight(25) })), ['buffer-red'], '25 min now, 0 at the start');
    assert.deepEqual(dueTriggers(input({ now: 300, limits: LIMITS, log: log({ runs }), inFlight: inFlight(250) })), [], 'red already at the last start (50 min)');
  });
});

describe('flow triggers: host-pressure', () => {
  /** One tick per minute from `from` to `to` (inclusive) at avg60 `avg60`. */
  const ticks = (from: number, to: number, avg60: number): PressureTick[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ atMs: Date.parse(at(from + i)), avg60 }));
  const busy = [{ unit: unitId('x'), ageMin: 5 }];

  it('fires with units in flight once the tick avg60 stays at the threshold or above for 10 minutes; fires before any merge', () => {
    assert.deepEqual(dueTriggers(input({ now: 300, inFlight: busy, pressure: ticks(290, 300, 0.25) })), ['host-pressure']);
    assert.deepEqual(dueTriggers(input({ now: 300, inFlight: busy, pressure: ticks(291, 300, 0.6) })), [], '9 minutes');
    assert.deepEqual(dueTriggers(input({ now: 300, inFlight: [], pressure: ticks(280, 300, 0.6) })), [], 'no unit in flight');
    assert.deepEqual(dueTriggers(input({ now: 300, inFlight: busy, pressure: [] })), [], 'no ticks: a host without PSI');
  });

  it('the run must reach the newest tick unbroken; a dip below the threshold restarts it', () => {
    const dip = [...ticks(280, 294, 0.5), ...ticks(295, 295, 0.1), ...ticks(296, 300, 0.5)];
    assert.equal(sustainedPressure(dip, null), false);
    assert.equal(sustainedPressure([...ticks(280, 299, 0.5), ...ticks(300, 300, 0.24)], null), false, 'calm now');
    assert.equal(sustainedPressure(ticks(280, 300, 0.5), null), true);
  });

  it('only ticks after the last run\'s start count, and the cooldown and an open window hold it like the others', () => {
    const hot = ticks(270, 400, 0.5);
    const since = (min: number) => Date.parse(at(min));
    assert.equal(sustainedPressure(hot, since(395)), false, '5 minutes since the run');
    assert.equal(sustainedPressure(hot, since(380)), true);
    assert.deepEqual(dueTriggers(input({ now: 400, inFlight: busy, pressure: hot, log: log({ runs: [run(1, 350)] }) })), [], 'inside the cooldown');
    assert.deepEqual(dueTriggers(input({ now: 400, inFlight: busy, pressure: hot, log: log({ runs: [run(1, 100)] }) })), ['host-pressure']);
    assert.deepEqual(dueTriggers(input({ now: 400, inFlight: busy, pressure: hot, window: WINDOW })), [], 'suppressed under an open window');
    assert.deepEqual(dueTriggers(input({ now: 400, inFlight: busy, pressure: hot, log: log({ requests: [399] }) })), ['host-pressure', 'requested'], 'coalesced in order');
  });
});
