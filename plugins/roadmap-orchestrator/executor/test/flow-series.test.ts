// M4b A1: the flow series (src/flow/series.ts) over synthetic arc logs: the disjoint station partition summing to the lead
// time, held time out of the waits, the four suite-run shapes (the T-alone rerun as rework), batch merges out of the
// points but in T, the accounting, in-flight ages; the points' and the station table's pressure (M4b rev 3); and the
// reader of other arcs' series (src/flow/history.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArcRef } from '../src/chain.ts';
import { arcId, sha256 } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import { completedRefs, seriesOfRef } from '../src/flow/history.ts';
import { flowSeries, inFlightAges, stationTable } from '../src/flow/series.ts';
import { FLOW_SERIES_V, type FlowPoint, type FlowSeries, parseFlowSeries } from '../src/flow/types.ts';
import {
  ARC, CAND, FlowLog, HOST, TIP, arcLaneDef, atMin, commandAt, inputs, laneDef, obligationsOf, planOf, stageOf,
} from './helpers/flowlog.ts';

const PLAN = planOf({});
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const sum = (p: FlowPoint): number => Object.values(p.minutes).reduce((a, b) => a + b, 0);
const minutes = (p: FlowPoint): Readonly<Record<string, number>> => Object.fromEntries(Object.entries(p.minutes).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));
/** The series, through its own reader (which refuses a partition not summing to lead). */
const series = (log: FlowLog, plan = PLAN, obligations: ReturnType<typeof obligationsOf> | null = null): FlowSeries =>
  parseFlowSeries(JSON.parse(JSON.stringify(flowSeries(ARC, log.events, inputs(plan, obligations)))));

/** The reference unit: every kind of step, with known waits and services. */
function reference(log: FlowLog, unit = 'u1'): void {
  log.dispatch(0, unit);
  log.step(1, 3, unit, 'plan-check', 1, 'approve'); // wait 1, service 2
  log.step(4, 10, unit, 'build', 2, 'success'); // wait 1, service 6
  log.step(null, 10, unit, 'quiesce', 3, 'empty'); // no op: 0
  log.step(12, 15, unit, 'lanes', 4, 'green'); // wait 2, service 3
  log.step(15, 17, unit, 'gate', 5, 'approve'); // service 2
  log.candidateStart(20, unit, 6); // slot wait 3
  log.suiteLane(21, 25, unit, 6, 'suite', CAND); // suite 4
  log.outcome(26, unit, 'candidate', 6, 'green'); // candidate-rest 2
  log.outcome(26.5, unit, 'ff', 7, 'published');
  log.outcome(27, unit, 'snapshot', 8, 'published', 'retire');
}

describe('flow series: the station partition', () => {
  it('cuts a merged unit\'s lead into disjoint waits, services and slot components summing to it', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    reference(log);
    const [p] = series(log).points;
    assert.equal(p!.leadMin, 27);
    assert.equal(p!.admittedAt, atMin(0));
    assert.equal(p!.mergedAt, atMin(27));
    assert.deepEqual(minutes(p!), {
      'wait:plan-check': 1, 'stage:plan-check': 2, 'wait:build': 1, 'stage:build': 6, 'wait:lanes': 2, 'stage:lanes': 3, 'stage:gate': 2,
      'wait:slot:integration': 3, 'suite:suite': 4, 'candidate-rest': 2, ff: 0.5, snapshot: 0.5,
    });
    assert.ok(near(sum(p!), p!.leadMin));
  });

  it('an attempt a restart cut short is service of the next one; its stray ops after an outcome start nothing', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    log.dispatch(0, 'u1');
    log.op(2, 'u1', 'build', 1); // cut short, no outcome
    log.step(5, 9, 'u1', 'build', 2, 'success'); // the redo
    log.op(9.5, 'u1', 'build', 2); // after its outcome: the previous attempt's op, not the gate's start
    log.step(11, 12, 'u1', 'gate', 3);
    log.candidateStart(12, 'u1', 4);
    log.outcome(13, 'u1', 'candidate', 4, 'green');
    log.outcome(13, 'u1', 'ff', 5, 'published');
    log.outcome(13, 'u1', 'snapshot', 6, 'published', 'retire');
    assert.deepEqual(minutes(series(log).points[0]!), { 'wait:build': 2, 'stage:build': 7, 'wait:gate': 2, 'stage:gate': 1, 'candidate-rest': 1 });
  });

  it('holds the partition summing to lead over random logs (pauses, parks, drains, reruns)', () => {
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 60; n++) {
      const log = new FlowLog();
      log.applied(0, 1);
      let t = rnd() * 3;
      log.dispatch(t, 'u1');
      let attempt = 1;
      const steps = 2 + Math.floor(rnd() * 6);
      for (let i = 0; i < steps; i++) {
        const stage = (['plan-check', 'build', 'lanes', 'gate'] as const)[Math.floor(rnd() * 4)]!;
        if (rnd() < 0.2) log.fact(t + rnd(), { kind: 'paused', command: commandAt(t), target: { type: 'all' } });
        if (rnd() < 0.2) log.fact(t + 1 + rnd(), { kind: 'resumed', command: commandAt(t), target: { type: 'all' } });
        const opAt = rnd() < 0.2 ? null : t + rnd() * 5;
        t = (opAt ?? t) + rnd() * 10;
        log.step(opAt, t, 'u1', stage, attempt++, 'x', rnd() < 0.15 ? 'park' : 'advance');
        if (rnd() < 0.2) log.applied(t, 2, { command: commandAt(t - rnd() * 20), changes: [{ type: 'suite' }] });
      }
      log.candidateStart(t + rnd() * 4, 'u1', attempt);
      log.suiteLane(t + 4, t + 5, 'u1', attempt, 'suite', CAND, 'fail');
      log.suiteLane(t + 5, t + 6, 'u1', attempt, 'suite', TIP);
      t += 7;
      log.outcome(t, 'u1', 'candidate', attempt++, 'green');
      log.outcome(t + rnd(), 'u1', 'ff', attempt++, 'published');
      log.outcome(t + 1, 'u1', 'snapshot', attempt, 'published', 'retire');
      const [p] = series(log).points; // the reader refuses a partition not summing to lead
      assert.ok(Object.values(p!.minutes).every((m) => m >= 0));
      assert.ok(near(sum(p!), p!.leadMin), `log ${n}`);
    }
  });
});

describe('flow series: held time', () => {
  it('a pause, a stop until the next start and an ARC-scope drain are held inside waits, never inside service', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    log.started(0);
    log.dispatch(0, 'u1');
    log.fact(0.5, { kind: 'paused', command: commandAt(0.5), target: { type: 'all' } }); // wait:build 0..2: held 0.5..1.5
    log.fact(1.5, { kind: 'resumed', command: commandAt(1.5), target: { type: 'all' } });
    log.op(2, 'u1', 'build', 1);
    log.fact(3, { kind: 'paused', command: commandAt(3), target: { type: 'unit', unit: 'u1' } }); // in service: not held
    log.fact(4, { kind: 'resumed', command: commandAt(4), target: { type: 'all' } });
    log.outcome(6, 'u1', 'build', 1, 'success');
    log.fact(6.5, { kind: 'stop-requested', command: commandAt(6.5) }); // wait:gate 6..9: held 6.5..7.5
    log.started(7.5);
    log.step(9, 10, 'u1', 'gate', 2);
    log.applied(13, 2, { command: commandAt(11), changes: [{ type: 'suite' }] }); // wait:slot 10..14: held 11..13
    log.applied(13.5, 3, { command: commandAt(12), changes: [{ type: 'unit-priority', unit: 'u1' }] }); // no drain
    log.candidateStart(14, 'u1', 3);
    log.outcome(15, 'u1', 'candidate', 3, 'green');
    log.outcome(15, 'u1', 'ff', 4, 'published');
    log.outcome(15, 'u1', 'snapshot', 5, 'published', 'retire');
    assert.deepEqual(minutes(series(log).points[0]!), {
      held: 4, 'wait:build': 1, 'stage:build': 4, 'wait:gate': 2, 'stage:gate': 1, 'wait:slot:integration': 2, 'candidate-rest': 1,
    });
  });

  it('the whole wait after a hold or park outcome is held; another unit\'s pause is not', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    log.dispatch(0, 'u1');
    log.step(0, 2, 'u1', 'plan-check', 1, 'escalate', 'park');
    log.fact(3, { kind: 'paused', command: commandAt(3), target: { type: 'unit', unit: 'u2' } });
    log.step(30, 32, 'u1', 'plan-check', 2, 'approve'); // 2..30 held
    log.step(33, 34, 'u1', 'build', 3, 'interrupted', 'hold');
    log.step(40, 41, 'u1', 'build', 4, 'success'); // 34..40 held
    log.candidateStart(41, 'u1', 5);
    log.outcome(42, 'u1', 'candidate', 5, 'green');
    log.outcome(42, 'u1', 'ff', 6, 'published');
    log.outcome(42, 'u1', 'snapshot', 7, 'published', 'retire');
    assert.deepEqual(minutes(series(log).points[0]!), {
      'stage:plan-check': 4, held: 34, 'wait:build': 1, 'stage:build': 2, 'candidate-rest': 1,
    });
  });

  it('in flight: a parked or paused unit\'s clock stops, a stuck one\'s runs on', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    log.dispatch(0, 'parked');
    log.step(1, 5, 'parked', 'plan-check', 1, 'escalate', 'park');
    log.dispatch(0, 'stuck');
    log.op(1, 'stuck', 'build', 1);
    log.fact(10, { kind: 'paused', command: commandAt(10), target: { type: 'all' } }); // stuck's service: not held; waiting's wait: held
    log.fact(12, { kind: 'resumed', command: commandAt(12), target: { type: 'all' } });
    log.dispatch(0, 'waiting');
    log.fact(20, { kind: 'paused', command: commandAt(20), target: { type: 'unit', unit: 'waiting' } }); // its wait: held 20..
    log.dispatch(0, 'cut');
    log.applied(1, 2, { command: commandAt(1), changes: [{ type: 'unit-cut', unit: 'cut' }] });
    const ages = inFlightAges(log.events, atMin(60), inputs(PLAN));
    assert.deepEqual(ages.map((a) => [a.unit, Math.round(a.ageMin * 1e6) / 1e6]), [['parked', 5], ['stuck', 60], ['waiting', 18]]);
  });
});

describe('flow series: the finding wait', () => {
  /** An approval of `unit` selecting `obligations` (the fingerprint fields the series reads). */
  const approval = (log: FlowLog, min: number, unit: string, attempt: number, obligations: readonly string[]): void => {
    log.fact(min, { kind: 'approval', unit, attempt, fingerprint: { obligationRevs: obligations.map((id) => ({ id, rev: 1 })) } });
  };
  const p1 = (log: FlowLog, min: number, id: string, obligation: string, severity = 'P1'): void => {
    log.fact(min, { kind: 'finding-opened', id, severity, obligation });
  };

  it('splits the candidate wait: an active P1 over a selected obligation is wait:finding, held time stays held, the rest the slot\'s', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    log.dispatch(0, 'u1');
    log.step(0, 2, 'u1', 'gate', 1);
    approval(log, 2, 'u1', 1, ['I-1', 'I-2']);
    p1(log, 1, 'F-1', 'I-1'); // active 1..20: covers the wait 2..20
    log.fact(4, { kind: 'paused', command: commandAt(4), target: { type: 'all' } }); // held 4..6 inside it
    log.fact(6, { kind: 'resumed', command: commandAt(6), target: { type: 'all' } });
    p1(log, 3, 'F-2', 'I-9'); // not selected: no wait
    p1(log, 3, 'F-3', 'I-2', 'P2'); // not a P1: no wait
    log.fact(20, { kind: 'finding-transition', id: 'F-1', to: { state: 'resolved' } });
    log.candidateStart(26, 'u1', 2); // slot wait 20..26
    log.outcome(27, 'u1', 'candidate', 2, 'green');
    log.outcome(27, 'u1', 'ff', 3, 'published');
    log.outcome(27, 'u1', 'snapshot', 4, 'published', 'retire');
    const [p] = series(log).points;
    assert.deepEqual(minutes(p!), { 'stage:gate': 2, held: 2, 'wait:finding': 16, 'wait:slot:integration': 6, 'candidate-rest': 1 });
    assert.ok(near(sum(p!), p!.leadMin));
  });

  it('a unit owning the finding repairs it and is never held by it; a ruling ends it; no approval selects nothing', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    p1(log, 0, 'F-1', 'I-1');
    for (const u of ['owner', 'other', 'unapproved']) {
      log.dispatch(0, u);
      log.step(0, 1, u, 'gate', 1);
      if (u !== 'unapproved') approval(log, 1, u, 1, ['I-1']);
    }
    log.fact(2, { kind: 'finding-transition', id: 'F-1', to: { state: 'owned', unit: 'owner' } });
    log.fact(5, { kind: 'finding-transition', id: 'F-1', to: { state: 'ruled', disposition: 'dismissed', by: { type: 'ruling', ruling: 'C-1' } } });
    for (const u of ['owner', 'other', 'unapproved']) {
      log.candidateStart(9, u, 2);
      log.outcome(10, u, 'candidate', 2, 'green');
      log.outcome(10, u, 'ff', 3, 'published');
      log.outcome(10, u, 'snapshot', 4, 'published', 'retire');
    }
    const byUnit = new Map(series(log).points.map((p) => [p.unit as string, minutes(p)]));
    assert.deepEqual(byUnit.get('owner'), { 'stage:gate': 1, 'wait:slot:integration': 8, 'candidate-rest': 1 });
    assert.deepEqual(byUnit.get('other'), { 'stage:gate': 1, 'wait:finding': 4, 'wait:slot:integration': 4, 'candidate-rest': 1 });
    assert.deepEqual(byUnit.get('unapproved'), { 'stage:gate': 1, 'wait:slot:integration': 8, 'candidate-rest': 1 });
  });
});

describe('flow series: suite runs', () => {
  const STAND_IN = arcLaneDef('unit-tests', ['node', '--test']); // identical to the suite lane `suite`
  const GOLDEN = arcLaneDef('golden', ['node', 'journey.js']);
  const OBLIGATIONS = obligationsOf([STAND_IN, GOLDEN]);

  it('a red candidate\'s T-alone rerun is rework in the candidate\'s rest, never suite service; stand-ins are suite service, other journeys arc lanes', () => {
    const log = new FlowLog();
    log.applied(0, 1, { obligations: 'o' });
    log.dispatch(0, 'u1');
    log.step(0, 1, 'u1', 'gate', 1);
    log.candidateStart(1, 'u1', 2);
    log.suiteLane(1, 3, 'u1', 2, 'suite', CAND, 'fail');
    log.suiteLane(3, 4, 'u1', 2, 'suite', CAND, 'fail'); // the red-lane protocol's diagnostic rerun: service, not a first run
    log.suiteLane(4, 6, 'u1', 2, 'suite', TIP); // the T-alone rerun
    log.outcome(6, 'u1', 'candidate', 2, 'red', 'candidate-red');
    log.step(6, 7, 'u1', 'build', 3);
    log.step(7, 8, 'u1', 'gate', 4);
    log.candidateStart(8, 'u1', 5);
    log.journey(8, 10, stageOf('u1', 'candidate', 5), { type: 'unit', unit: 'u1' }, 'unit-tests', CAND); // stands in for `suite`
    log.journey(10, 11, stageOf('u1', 'candidate', 5), { type: 'unit', unit: 'u1' }, 'golden', CAND); // the brake's arc lane
    log.spawn(11, 11.5, stageOf('u1', 'candidate', 5), { purpose: 'mutant', of: { type: 'finding', finding: 'F-1' }, lane: 'golden', laneRev: '0123456789abcdef', tree: CAND });
    log.outcome(12, 'u1', 'candidate', 5, 'green');
    log.outcome(12, 'u1', 'ff', 6, 'published');
    log.outcome(12, 'u1', 'snapshot', 7, 'published', 'retire');
    const s = series(log, PLAN, OBLIGATIONS);
    const [p] = s.points;
    assert.deepEqual(minutes(p!), { 'stage:gate': 2, 'stage:build': 1, 'suite:suite': 5, 'candidate-rest': 2.5, 'arc-lanes': 1.5 });
    assert.equal(p!.rework, 2, 'the T-alone rerun and the candidate-red round');
    assert.equal(p!.firstRunReds, 1);
    assert.deepEqual(s.suiteRuns.map((r) => [r.lane, r.shape, r.minutes, r.red, r.at]), [
      ['suite', 'lane', 2, true, atMin(1)], ['suite', 'lane', 1, true, atMin(3)], ['suite', 'rerun', 2, false, atMin(4)], ['suite', 'stand-in', 2, false, atMin(8)],
    ]);
  });

  it('a repair batch\'s suite runs are `batch` on its candidate and `rerun` on the tip; its members are out of the points and in T', () => {
    const log = new FlowLog();
    log.applied(0, 1, { obligations: 'o' });
    for (const u of ['m1', 'm2']) {
      log.dispatch(0, u);
      log.step(0, 1, u, 'gate', 1);
    }
    const job = { type: 'job', job: 'batch-1' };
    log.intent(2, 'candidate.merge', job, { integrationTip: TIP, batch: { job: 'batch-1', members: [{ unit: 'm1' }, { unit: 'm2' }], chain: [] } }, { new: CAND });
    log.journey(2, 4, job, job, 'suite', CAND, 'fail');
    log.journey(4, 5, job, job, 'unit-tests', CAND); // a stand-in for `suite`
    log.journey(5, 6, job, job, 'golden', CAND); // an arc lane
    log.journey(6, 9, job, job, 'suite', TIP);
    log.journey(9, 10, { type: 'job', job: 'docs-1' }, { type: 'job', job: 'docs-1' }, 'suite', CAND); // a docs publication's: not a shape
    log.spawn(10, 11, job, { purpose: 'journey', lane: 'suite', laneRev: '0123456789abcdef', at: CAND, owner: job }, 'cancelled'); // no verdict
    const ff = log.intent(11, 'integration.ff', job, { subject: { type: 'batch', job: 'batch-1' } });
    log.done(11, ff, 'integration.ff', { kind: 'published' });
    const end = log.straight(12, 'u1');
    const s = series(log, PLAN, OBLIGATIONS);
    assert.deepEqual(s.points.map((p) => p.unit), ['u1']);
    assert.deepEqual(s.suiteRuns.map((r) => [r.lane, r.shape, r.minutes, r.red]), [
      ['suite', 'batch', 2, true], ['suite', 'batch', 1, false], ['suite', 'rerun', 3, false], ['suite', 'lane', 1, false],
    ]);
    assert.ok(near(s.accounting.tUnits, 3 / (end / 60)), 'two batch members and u1 per hour of the log');
  });
});

describe('flow series: accounting and host', () => {
  it('splits first-held obligations by the advances they serve; T, WIP and OE per hour of the log', () => {
    const log = new FlowLog();
    log.applied(0, 1, { vision: true, obligations: 'o' });
    log.started(0);
    log.fact(0, { kind: 'meter', inv: 'arc-f/1#1', routingRev: '0123456789abcdef', subject: { type: 'smoke', backend: 'claude' }, usage: { costUsd: 3 } });
    log.straight(0, 'u1');
    log.fact(5, { kind: 'obligation-latched', obligation: 'O-1', unit: 'u1', treeSha: CAND });
    log.fact(5, { kind: 'obligation-latched', obligation: 'O-2', unit: 'u1', treeSha: CAND });
    log.fact(5, { kind: 'obligation-latched', obligation: 'O-1', unit: 'u1', treeSha: CAND });
    log.dispatch(10, 'u2');
    log.fact(30, { kind: 'meter', inv: 'arc-f/2#1', routingRev: '0123456789abcdef', subject: { type: 'seat', role: 'build', tier: 'med', unit: 'u2', attempt: 1 }, usage: { costUsd: 1.5 } });
    const plan = planOf({
      advances: ['V-1'],
      units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3', after: ['u1'] }, { id: 'u4', after: ['u2'] }, { id: 'u5', cut: true }, { id: 'u6', reenters: 'u7' }, { id: 'u7' }],
    });
    const s = series(log, plan, obligationsOf([], { 'O-1': ['V-1'], 'O-2': ['V-2'] }));
    // The log spans 30 minutes: rates double.
    assert.deepEqual(s.accounting, { tAdvances: 2, tOther: 2, tUnits: 2, wip: 1 + 2, oeUsdPerHour: 9 });
    assert.deepEqual(s.host, HOST);
    assert.equal(s.points[0]!.costUsd, 0);
  });

  it('a non-holistic arc has no T split; a log no start fingerprinted has no host', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    log.started(0, null);
    log.straight(0, 'u1');
    const s = series(log);
    assert.equal(s.accounting.tAdvances, null);
    assert.equal(s.accounting.tOther, null);
    assert.equal(s.host, null);
  });

  it('a unit\'s cost is its seat calls\', null when one reported none', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    const seat = (unit: string, costUsd: number | null): object => ({ kind: 'meter', inv: 'arc-f/1#1', routingRev: '0123456789abcdef', subject: { type: 'seat', role: 'build', tier: 'med', unit, attempt: 1 }, usage: { costUsd } });
    log.fact(0, seat('u1', 1.25));
    log.fact(0, seat('u1', 0.5));
    log.fact(0, seat('u2', 1));
    log.fact(0, seat('u2', null));
    log.straight(0, 'u1');
    log.straight(10, 'u2');
    assert.deepEqual(series(log).points.map((p) => p.costUsd), [1.75, null]);
  });
});

describe('flow series: the station table', () => {
  it('lists each leaf and the slot\'s sum, means over the points, largest first; the leaves\' shares sum to one', () => {
    const log = new FlowLog();
    log.applied(0, 1);
    log.straight(0, 'u1', 1);
    log.straight(10, 'u2', 3);
    const rows = stationTable(series(log).points);
    assert.deepEqual(rows.map((r) => [r.station, r.meanMin]), [['slot:integration', 3], ['suite:suite', 2], ['snapshot', 1], ['stage:build', 1], ['stage:gate', 1]]);
    assert.ok(near(rows.filter((r) => r.station !== 'slot:integration').reduce((a, r) => a + r.share, 0), 1));
  });
});

describe('flow series: pressure (M4b rev 3)', () => {
  const GOLDEN = arcLaneDef('golden', ['node', 'journey.js']);
  /** u1: a build, a lane run, a suite run and an arc lane, each with a known interval pressure; u2: a suite run without one. */
  function pressured(): FlowLog {
    const log = new FlowLog();
    log.applied(0, 1, { obligations: 'o' });
    log.dispatch(0, 'u1');
    log.spawn(1, 4, stageOf('u1', 'build', 1), { purpose: 'build', unit: 'u1' }, 'pass', 0.2);
    log.outcome(4, 'u1', 'build', 1, 'success');
    log.spawn(5, 6, stageOf('u1', 'lanes', 2), { purpose: 'lane', unit: 'u1', lane: 'unit', set: 'spec', at: CAND }, 'pass', 0.5);
    log.outcome(6, 'u1', 'lanes', 2, 'green');
    log.candidateStart(7, 'u1', 3);
    log.suiteLane(7, 9, 'u1', 3, 'suite', CAND, 'pass', 0.8);
    log.spawn(9, 10, stageOf('u1', 'candidate', 3), { purpose: 'journey', lane: 'golden', laneRev: '0123456789abcdef', at: CAND, owner: { type: 'unit', unit: 'u1' } }, 'pass', 0.4);
    log.outcome(10, 'u1', 'candidate', 3, 'green');
    log.outcome(10, 'u1', 'ff', 4, 'published');
    log.outcome(10.5, 'u1', 'snapshot', 5, 'published', 'retire');
    log.straight(20, 'u2');
    return log;
  }

  it('a point\'s pressure is the time-weighted mean of its service intervals, per station too; one unmeasured interval nulls it', () => {
    const [p1, p2] = series(pressured(), PLAN, obligationsOf([GOLDEN])).points;
    assert.ok(near(p1!.pressure!, (0.2 * 3 + 0.5 * 1 + 0.8 * 2 + 0.4 * 1) / 7), String(p1!.pressure));
    assert.deepEqual(p1!.stationPressure, { 'arc-lanes': 0.4, 'stage:build': 0.2, 'stage:lanes': 0.5, 'suite:suite': 0.8 });
    assert.equal(p2!.pressure, null, 'a spawn closed without pressure');
    assert.deepEqual(p2!.stationPressure, { 'suite:suite': null });
    const lost = new FlowLog();
    lost.applied(0, 1);
    lost.dispatch(0, 'u1');
    lost.spawn(1, 2, stageOf('u1', 'build', 1), { purpose: 'build', unit: 'u1' }, null);
    lost.spawn(2, 4, stageOf('u1', 'build', 1), { purpose: 'build', unit: 'u1' }, 'pass', 0.3);
    lost.outcome(4, 'u1', 'build', 1, 'success');
    lost.outcome(4, 'u1', 'snapshot', 2, 'published', 'retire');
    assert.equal(series(lost).points[0]!.pressure, null, 'a lost run measured nothing');
  });

  it('the station table weighs each point\'s station pressure by its minutes; the slot by its components; null when any is', () => {
    const [p1, p2] = series(pressured(), PLAN, obligationsOf([GOLDEN])).points;
    const one = new Map(stationTable([p1!]).map((r) => [r.station as string, r.pressure]));
    assert.ok(near(one.get('slot:integration')!, (0.8 * 2 + 0.4 * 1) / 3));
    assert.ok(near(one.get('stage:build')!, 0.2));
    assert.equal(one.get('wait:lanes'), null, 'no spawn serves a wait');
    const both = new Map(stationTable([p1!, p2!]).map((r) => [r.station as string, r.pressure]));
    assert.equal(both.get('suite:suite'), null);
    assert.equal(both.get('slot:integration'), null);
    assert.ok(near(both.get('stage:build')!, 0.2), 'only u1 ran a build spawn');
    assert.ok(near(both.get('arc-lanes')!, 0.4));
  });
});

describe('flow history: other arcs\' series', () => {
  const PLAN_JSON = {
    schema: 'roadmap/plan-m1', arc: 'arc-a', integrationBranch: 'integration/arc-a', baseline: 'a'.repeat(40), worktreeRoot: '/var/tmp/roadmap-wt',
    contracts: [], rulings: 'rulings.jsonl', architectureDoc: 'docs/architecture.md', direction: 'Converge.',
    suite: { lanes: [{ id: 'suite', argv: ['npm', 'test'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] }] },
    resources: [], units: [{ id: 'u1', spec: 'specs/u1.json', risk: 'med', scope: ['src/**'], resources: [] }],
  };
  /** The arc's ref; `completedAt`: the minute of its `arc-completed` (null: none). */
  const ref = (log: FlowLog, kept: Readonly<Record<string, unknown>> | null, completedAt: number | null): ArcRef => {
    const keptSha = sha256('e'.repeat(64));
    const completed = completedAt !== null;
    if (kept !== null) log.fact(completedAt ?? 100, { kind: 'flow-series', sha256: keptSha, highWater: log.events.length });
    if (completed) log.fact(completedAt, { kind: 'arc-completed', planRev: 1, head: CAND, highWater: log.events.length, units: [] });
    const seq = log.events.length;
    return {
      arc: log.arc, events: log.events,
      view: { holistic: () => ({ completion: completed ? { seq, active: true } : null }), lastWorkSeq: () => seq } as unknown as JournalView,
      input: (sha: string, ext: string): Buffer => {
        if (sha === keptSha && ext === 'flow-series.json') return Buffer.from(JSON.stringify(kept));
        if (ext === 'plan.json') return Buffer.from(JSON.stringify(PLAN_JSON));
        throw new Error(`no ${sha}.${ext}`);
      },
    } as unknown as ArcRef;
  };
  const arcLog = (arc: string): FlowLog => {
    const log = new FlowLog(arcId(arc));
    log.applied(0, 1);
    log.started(0);
    log.straight(0, 'u1');
    return log;
  };

  it('reads the kept series when its v is this release\'s, else recomputes from the ref\'s events', () => {
    const keptSeries = { v: FLOW_SERIES_V, arc: 'arc-a', host: HOST, points: [], suiteRuns: [], accounting: { tAdvances: null, tOther: null, tUnits: 0, wip: 0, oeUsdPerHour: 0 } };
    assert.deepEqual(seriesOfRef(ref(arcLog('arc-a'), keptSeries, 100)).points, []);
    assert.deepEqual(seriesOfRef(ref(arcLog('arc-a'), { ...keptSeries, v: FLOW_SERIES_V + 1 }, 100)).points.map((p) => p.unit), ['u1']);
    const dev7 = new FlowLog(arcId('arc-a'));
    dev7.applied(0, 1);
    dev7.started(0, null);
    dev7.straight(0, 'u1');
    const recomputed = seriesOfRef(ref(dev7, null, 100));
    assert.deepEqual([recomputed.points.length, recomputed.host], [1, null]);
  });

  it('seeds only from completed arcs, newest completion first', () => {
    const refs = [ref(arcLog('arc-a'), null, 100), ref(arcLog('arc-b'), null, 200), ref(arcLog('arc-c'), null, null)];
    assert.deepEqual(completedRefs(refs).map((r) => r.arc), ['arc-b', 'arc-a']);
  });
});
