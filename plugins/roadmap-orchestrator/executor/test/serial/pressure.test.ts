// M4b rev 3 (RC-11, step H2): charging under real host pressure, integrated (real processes, real git, fake backends,
// this host's PSI). CPU burners (2 × availableParallelism busy loops) saturate the host, so PSI `some` is at or above
// PRESSURE_SATURATED over every launch. Unit u1 runs through the unit driver:
//   1. its plan-check call (deadline: the unit's `limits.judgmentDeadlineMin` of 1 minute) hangs and is killed by its
//      deadline under pressure: `starved`, a `host-pressure` hold: not chargeable, no retry, no park, and the real
//      admitter holds the re-run while the host stays saturated;
//   2. driven on past the hold (the test's gate admits), its plan-check, build and lanes run under pressure; lane
//      `flaky` is red on its first run (green on its diagnostic rerun): red under pressure, held for its one rerun,
//      uncharged, no fix round;
//   3. the burners stop; once a PSI reading shows avg60 below the threshold the admitter releases the hold, the lanes
//      re-run green, and u1 merges with nothing charged.
// The burners are killed in `after` whatever happens. This file must run alone (the serial tier): it loads the host.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, test } from 'node:test';
import type { StageOutcomeFact } from '../../src/core/events.ts';
import { arcId, invocationId, unitId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { PRESSURE_SATURATED, pressureNowOf, readPressure } from '../../src/host/pressure.ts';
import { spawnPressureOf } from '../../src/core/upgrade.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { specFacts } from '../../src/pipeline/reproduce.ts';
import { type Gate, runUnit } from '../../src/pipeline/unit.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { admitter } from '../../src/schedule/ready.ts';
import type { Admission } from '../../src/schedule/types.ts';
import { intents } from '../fixtures/invoke-specs.ts';
import { editUnit } from '../fixtures/route-common.ts';
import { planCheckStep } from '../fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, MUL_LANE, contextFor, gateStep, mulBuild, outcomes, setupArc } from '../fixtures/unit-common.ts';
import { tmpDir } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';

const U1 = unitId('u1');
/** Bounded: two judgment deadlines' worth of a saturated host, the pipeline under it, and the PSI decay after. */
const T = { timeout: 15 * 60_000 };
/** How long the test waits for avg60 to fall below the threshold once the burners stop (it decays over ~1.5 min). */
const CALM_MS = 6 * 60_000;

const burners: ChildProcess[] = [];
function startBurners(): void {
  for (let i = 0; i < 2 * availableParallelism(); i++) burners.push(spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
}
function stopBurners(): void {
  for (const b of burners.splice(0)) b.kill('SIGKILL');
}
after(stopBurners);

/** The admission the scheduler would give `stage` of u1 now, with this host's PSI read as its tick. */
const admission = (r: ArcRun, stage: 'plan-check' | 'lanes'): Admission => admitter((u) => r.ctx.routing(u).table, specFacts(r.ctx))({
  view: r.journal.view, plan: r.ctx.plan(), unit: r.unit('u1'), stage, blocking: [], drains: [], tripped: [], pressure: pressureNowOf(readPressure(), Date.now()),
});
/** The real admitter at every admission boundary; chains always run. */
const admitted = (r: ArcRun): Gate => (next) => Promise.resolve(next.kind === 'chain' || admission(r, next.stage as 'lanes').kind === 'admit');
const admitAll: Gate = () => Promise.resolve(true);

const outcomeFacts = (d: ArcDescriptor): readonly StageOutcomeFact[] =>
  readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === 'u1' ? [e.fact] : []));

/** The interval pressure and exit cause of spawn `inv`, from its done record and exit.json. */
function spawnEnd(r: ArcRun, inv: string): Readonly<{ pressure: number | null; cause: string | undefined }> {
  const spawned = intents(r.d.runDir, 'proc.spawn').find((i) => invocationId(i.op, i.ordinal) === inv);
  assert.ok(spawned !== undefined, `${inv} is a spawn`);
  const done = r.journal.view.doneOf(spawned.op);
  assert.ok(done !== null && done.kind === 'proc.spawn' && done.outcome.kind === 'result', `${inv} closed with a result`);
  const id = invocationId(spawned.op, spawned.ordinal);
  return { pressure: spawnPressureOf(done.outcome), cause: runnerFiles(invocationDir(r.ctx.runDir, id), id).read('exit.json')?.cause };
}

describe('host pressure (RC-11)', () => {
  test('pressure.starved-uncharged / pressure.red-rerun / pressure.hold-released: a call its deadline killed on a saturated host is starved, a red lane on it reruns once, both held uncharged; the hold releases once the host calms, and the unit merges uncharged', T, async () => {
    assert.notEqual(readPressure(), 'unavailable', 'this host reports PSI cpu (the premise of the test)');
    const state = tmpDir('pressure-state');
    mkdirSync(state, { recursive: true });
    // Red the first time it ever runs, green after: its diagnostic rerun is green (flaky), and so is the held rerun.
    const flaky = { id: 'flaky', argv: ['sh', '-c', '[ -e "$STATE/ran" ] && exit 0; touch "$STATE/ran"; exit 1'], env: { set: { STATE: state }, pass: ['PATH'] } };
    const answer = planCheckStep({ decision: 'approve' });
    if (answer.as !== 'claude') throw new Error('a plan-check is a Claude judgment');
    const hung: Step = { ...answer, acts: [{ type: 'hang', ms: 180_000 }, ...answer.acts] };
    const d = setupArc({
      units: [{ id: 'u1', lanes: [MUL_LANE, flaky] }],
      steps: [hung, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
    });
    editUnit(d, 'u1', (u) => void (u['limits'] = { judgmentDeadlineMin: 1 }));
    const r = contextFor(d);
    try {
      startBurners();
      await sleep(2_000);

      // 1. The plan-check call outlives its 1-minute deadline under pressure: starved.
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r)), { kind: 'held', needsUser: null });
      assert.deepEqual(outcomes(d), ['plan-check:interrupted']);
      const starved = outcomeFacts(d).at(-1)!;
      assert.equal(starved.cause?.type, 'host-pressure');
      assert.ok(starved.cause?.type === 'host-pressure');
      const call = spawnEnd(r, starved.cause.inv);
      assert.equal(call.cause, 'deadline', 'the runner\'s deadline ended the call');
      assert.ok(call.pressure !== null && call.pressure >= PRESSURE_SATURATED, `the call's interval pressure ${call.pressure} is saturated`);
      assert.deepEqual([starved.class, starved.chargeable, starved.park], ['hold', false, undefined], 'starved: a hold, not chargeable, no park');
      const u = r.journal.view.unit(U1);
      assert.deepEqual([u.status, u.counters.chargeableFailures, u.counters.retries['plan-check'], u.pressureHolds], ['active', 0, 0, 1], 'no retry spent');
      assert.deepEqual(admission(r, 'plan-check'), { kind: 'wait', constraints: [{ type: 'host-pressure', inv: starved.cause.inv }] }, 'held while the host is saturated');

      // 2. On under pressure: the red lane is held for its one rerun, uncharged, no fix round.
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'held', needsUser: null });
      assert.deepEqual(outcomes(d), [
        'plan-check:interrupted', 'plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:interrupted',
      ]);
      const red = outcomeFacts(d).at(-1)!;
      assert.ok(red.cause?.type === 'host-pressure');
      assert.deepEqual([red.class, red.chargeable], ['hold', false]);
      const lane = spawnEnd(r, red.cause.inv);
      assert.equal(lane.cause, 'exited', 'the lane ran red on its own');
      assert.ok(lane.pressure !== null && lane.pressure >= PRESSURE_SATURATED, `the red run's interval pressure ${lane.pressure} is saturated`);
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
      assert.equal(r.journal.view.unit(U1).pressureHolds, 2);

      // 3. The host calms: the hold releases, the lanes re-run green and only that verdict counts.
      stopBurners();
      const deadline = Date.now() + CALM_MS;
      while (admission(r, 'lanes').kind !== 'admit') {
        assert.ok(Date.now() < deadline, `the host's avg60 stayed at or above ${PRESSURE_SATURATED} for ${CALM_MS} ms after the burners stopped`);
        await sleep(5_000);
      }
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r)), { kind: 'merged' });
      assert.deepEqual(outcomes(d).slice(8), ['lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published']);
      const done = r.journal.view.unit(U1);
      assert.deepEqual([done.counters.chargeableFailures, done.pressureHold, done.pressureHolds], [0, null, 2]);
    } finally {
      stopBurners();
      r.journal.close();
    }
  });
});
