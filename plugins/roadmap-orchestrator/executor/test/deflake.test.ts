// dev.17, the flaky ledger (DESIGN-1.0.md §4 "Flaky ledger"; src/pipeline/deflake.ts, src/pipeline/deflakemint.ts), integrated
// over real processes, real git and the fake backends: units whose spec lane `flaky` is red on its first run and green
// after (a marker file outside the repo; removing it makes the lane flake again), driven by the unit driver behind the
// real admitter, the deflake job run as the scheduler runs it. Named tests: deflake.first-flake (a flake is forgiven to
// the unit in flight and mints one prioritised, milestone-exempt deflake unit with code edges from the units not yet
// started that run the lane; a unit already in flight keeps its one-rerun forgiveness; the deflake's merge releases the
// edges), deflake.reflake (a flake after the deflake merged mints a second, told of the first; one after the second raises
// `flake-recurring` and mints nothing), deflake.park (a parked deflake drops its edges and raises `deflake-parked`),
// deflake.verification-budget (runs × the lane's measured median against the verification budget), deflake.verify-runs (a
// deflake unit's verification runs its lane that many times, every run passing), deflake.stochastic (a k-of-n lane never
// flakes), and the deflake revision's crash cells (deflake.crash.<label>).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { DesignRecord } from '../src/core/design.ts';
import type { Fact } from '../src/core/events.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { type PlanM1, milestonesOfUnit } from '../src/input/plan.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { deflakeDue, deflakeState, flakyLedger, medianLaneMinutes, verificationCap, verificationReasons, verifyRunsOf } from '../src/pipeline/deflake.ts';
import { applyDeflake, deflakeJobPending, raiseDeflakeParked } from '../src/pipeline/deflakemint.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { LANE_DEADLINE_MS, laneOrder, reserveNow, runLaneSeries, seriesLedger, specSeriesRoot } from '../src/pipeline/lanes.ts';
import { pinDispatch, type StageParent } from '../src/pipeline/dispatch.ts';
import { specFacts } from '../src/pipeline/reproduce.ts';
import { lanes, loadUnitSpec } from '../src/pipeline/stages.ts';
import { type Gate, runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { admitter, rankOf } from '../src/schedule/ready.ts';
import { type Admission, compareRank } from '../src/schedule/types.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';
import { deflakeContext, flakyLane, freshMarker, reflake, unitInForce } from './fixtures/deflake-common.ts';
import { SCENARIO_TIMEOUT_MS, U1 as STAGE_U1, keptSpec, planCheckStep, setupUnit, started } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, MUL_LANE, contextFor, gateStep, mulBuild, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';
import { DEFLAKE_REVISION, crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS * 4 };

const PRE_LANES = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released'];
const STRAIGHT = [...PRE_LANES, 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

/** Each step keyed to `unit`. */
const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
/** A unit straight through: approved plan-check, a build committing `files` beside mul, an approving gate. */
const straight = (unit: string, files: Readonly<Record<string, string>>): readonly Step[] =>
  of(unit, [planCheckStep({ decision: 'approve' }), mulBuild(files), gateStep({ decision: 'approve' })]);

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const planOf = (r: ArcRun): PlanM1 => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;

/** The admission the scheduler would give unit `id`'s `stage` now: the real admitter over the plan in force. */
function admission(r: ArcRun, id: string, stage: 'plan-check' | 'build'): Admission {
  const { w } = deflakeContext(r);
  return admitter((u) => r.ctx.routing(u).table, specFacts(w.stage))({
    view: r.journal.view, plan: planOf(r), unit: unitInForce(r, id), stage, blocking: [], drains: [], tripped: [], pressure: { ticks: [], nowMs: 0 },
  });
}

/** A unit driver gate asking the real admitter at every admission boundary; chains always run. */
const admitted = (r: ArcRun, id: string): Gate => (next) => Promise.resolve(next.kind === 'chain' || admission(r, id, next.stage as 'plan-check').kind === 'admit');

/** Runs unit `id` of the plan in force through the driver, over the run's wiring (its arbiter woken meanwhile). */
async function run(r: ArcRun, id: string, gate: Gate = admitted(r, id)) {
  const { w } = deflakeContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    return await runUnit(w.stage, unitInForce(r, id), gate);
  } finally {
    clearInterval(tick);
  }
}

/** The deflake job once, as the scheduler runs it. */
async function mint(r: ArcRun) {
  const { ctx, w } = deflakeContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    return await applyDeflake(ctx);
  } finally {
    clearInterval(tick);
  }
}

const pending = (r: ArcRun): boolean => deflakeJobPending(r.ctx);
const HELD_BY_DEFLAKE_1 = { kind: 'wait', constraints: [{ type: 'deflake', deflake: 'deflake-1', lane: 'flaky' }] };

/** An arc of units each running the flaky lane `flaky` (marker `marker`), and `others` running only mul. */
function flakyArc(marker: string, flaky: readonly string[], others: readonly string[], steps: readonly Step[]): ArcDescriptor {
  return setupArc({ units: [...flaky.map((id) => ({ id, lanes: [flakyLane(marker)] })), ...others.map((id) => ({ id, lanes: [MUL_LANE] }))], steps });
}

describe('the flaky ledger', () => {
  test('deflake.first-flake: the flake is forgiven to the unit in flight and mints one prioritised deflake unit with code edges; a unit in flight keeps its forgiveness; the merge releases the edges', T, async () => {
    const marker = freshMarker();
    const d = flakyArc(marker, ['u1', 'u2', 'u4'], ['u3'], [
      ...straight('u1', {}), ...straight('u4', { 'src/u4.js': 'export const u4 = 4;\n' }),
      ...straight('deflake-1', { 'test/flaky-note.txt': 'deterministic now\n' }), ...straight('u2', { 'src/u2.js': 'export const u2 = 2;\n' }),
    ]);
    const r = contextFor(d);
    try {
      // u1's lane flakes: forgiven (lanes green, uncharged), recorded once.
      assert.deepEqual(await run(r, 'u1'), { kind: 'merged' });
      assert.deepEqual(outcomes(d, 'u1'), STRAIGHT);
      assert.equal(r.journal.view.unit(STAGE_U1).counters.chargeableFailures, 0);
      const first = r.journal.view.flakes().map((x) => x.fact);
      assert.equal(first.length, 1);
      assert.deepEqual([first[0]!.owner, first[0]!.lane, first[0]!.set, first[0]!.forgiven, first[0]!.event.failing], [{ type: 'unit', unit: 'u1' }, 'flaky', 'spec', true, []]);

      // u4 starts (dispatched at plan-check) before the deflake exists: in flight.
      await stepUntil(r, 'u4', (f) => f.stage === 'plan-check');

      // The ledger mints one deflake unit for the lane key.
      assert.equal(pending(r), true);
      assert.deepEqual(await mint(r), { kind: 'applied', admitted: ['deflake-1'], recurring: 0 });
      assert.equal(pending(r), false, 'nothing more is due while the deflake is open');
      const plan = planOf(r);
      const deflake = unitInForce(r, 'deflake-1');
      assert.equal(deflake.origin, 'deflake');
      assert.deepEqual(deflake.deflake, { keys: [{ type: 'lane', lane: 'flaky' }] });
      assert.deepEqual(deflake.after, []);
      assert.deepEqual(milestonesOfUnit(plan, deflake.id), [], 'milestone-exempt');
      assert.deepEqual(deflake.scope, unitInForce(r, 'u1').scope, 'a spec lane\'s deflake takes the scope of the unit whose lane it is');
      const applied = facts(r).filter((f) => f.kind === 'plan-applied').at(-1);
      assert.ok(applied?.kind === 'plan-applied' && applied.source.type === 'deflake');
      const { w } = deflakeContext(r);
      const spec = loadUnitSpec(w.stage, deflake).spec;
      assert.deepEqual(spec.lanes.map((l) => [l.id, l.argv]), [['flaky', [process.execPath, ...flakyLane(marker).argv.slice(1)]]], 'the lane, copied from u1\'s spec');
      assert.match(spec.facts[0]!.text, new RegExp(first[0]!.event.red.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual(flakyLedger(r.journal.view, plan).map((e) => [e.key, e.deflakes]), [[{ type: 'lane', lane: 'flaky' }, ['deflake-1']]]);

      // Prioritised: it ranks with the repair units, before every planned waiter.
      assert.ok(compareRank(rankOf(r.journal.view, plan, deflake.id), rankOf(r.journal.view, plan, unitInForce(r, 'u2').id)) < 0);
      // Code edges: u2 (not started, runs flaky) waits; u3 (mul only) does not; the deflake and the unit in flight do not.
      assert.deepEqual(admission(r, 'u2', 'plan-check'), HELD_BY_DEFLAKE_1);
      assert.deepEqual(admission(r, 'u3', 'plan-check'), { kind: 'admit' });
      assert.deepEqual(admission(r, 'deflake-1', 'plan-check'), { kind: 'admit' });
      assert.deepEqual(admission(r, 'u4', 'build'), { kind: 'admit' });
      assert.deepEqual(await run(r, 'u2'), { kind: 'held', needsUser: null });
      assert.deepEqual(outcomes(d, 'u2'), [], 'held before anything ran');

      // u4, in flight, flakes again while the deflake is open: forgiven, recorded, nothing minted.
      reflake(marker);
      assert.deepEqual(await run(r, 'u4'), { kind: 'merged' });
      assert.deepEqual(r.journal.view.flakes().map((x) => [x.fact.owner, x.fact.forgiven]), [[{ type: 'unit', unit: 'u1' }, true], [{ type: 'unit', unit: 'u4' }, true]]);
      assert.equal(pending(r), false);

      // The deflake merges (its lane green now); the edge is released and u2 runs.
      assert.deepEqual(await run(r, 'deflake-1'), { kind: 'merged' });
      assert.deepEqual(outcomes(d, 'deflake-1'), STRAIGHT);
      assert.equal(deflakeState(r.journal.view, deflake.id), 'merged');
      assert.deepEqual(admission(r, 'u2', 'plan-check'), { kind: 'admit' });
      assert.deepEqual(await run(r, 'u2'), { kind: 'merged' });
      assert.equal(pending(r), false, 'no flake since the deflake merged');
      raiseDeflakeParked(w.stage);
      assert.equal(r.journal.view.opsOf('needsuser.raise').length, 0, 'no item');
    } finally {
      r.journal.close();
    }
  });

  test('deflake.reflake: a flake after the deflake merged mints a second deflake told of the first; one after the second raises flake-recurring and mints nothing', T, async () => {
    const marker = freshMarker();
    const d = flakyArc(marker, ['u1', 'u2', 'u3'], [], [
      ...straight('u1', {}), ...straight('deflake-1', { 'test/a.txt': 'a\n' }), ...straight('u2', { 'src/u2.js': 'export const u2 = 2;\n' }),
      ...straight('deflake-2', { 'test/b.txt': 'b\n' }), ...straight('u3', { 'src/u3.js': 'export const u3 = 3;\n' }),
    ]);
    const r = contextFor(d);
    try {
      await reflakeTwice(r, marker);
      // The second deflake, told of the first.
      const second = unitInForce(r, 'deflake-2');
      assert.deepEqual(second.deflake, { keys: [{ type: 'lane', lane: 'flaky' }] });
      const { w } = deflakeContext(r);
      const told = loadUnitSpec(w.stage, second).spec.facts.map((f) => f.text);
      assert.ok(told.some((t) => /deflake-1/.test(t) && /merged/.test(t)), told.join(' | '));
      assert.deepEqual(flakyLedger(r.journal.view, planOf(r))[0]!.deflakes, ['deflake-1', 'deflake-2']);
      assert.deepEqual(await run(r, 'deflake-2'), { kind: 'merged' });

      // A third flake: an item, no third deflake.
      reflake(marker);
      assert.deepEqual(await run(r, 'u3'), { kind: 'merged' });
      const third = r.journal.view.flakes().at(-1)!.fact;
      assert.equal(pending(r), true);
      assert.deepEqual(await mint(r), { kind: 'applied', admitted: [], recurring: 1 });
      assert.equal(planOf(r).units.filter((u) => u.origin === 'deflake').length, 2, 'no third deflake unit');
      const raises = r.journal.view.opsOf('needsuser.raise');
      assert.equal(raises.length, 1);
      const item = readNeedsUser(r.ctx.runDir, raises[0]!.expect.id);
      assert.ok(item !== null);
      assert.deepEqual([item.reason, item.blocking, item.subject], ['flake-recurring', false, { type: 'arc' }]);
      assert.ok(item.evidence.includes(invocationDir(r.ctx.runDir, third.event.red)));
      assert.match(item.summary, /deflake-1 and deflake-2/);
      // Raised once: nothing is due any more.
      assert.equal(pending(r), false);
      assert.deepEqual(await mint(r), { kind: 'none' });
    } finally {
      r.journal.close();
    }
  });

  test('deflake.park: a parked deflake unit drops its code edges and raises one deflake-parked item; a flake meanwhile mints nothing', T, async () => {
    const marker = freshMarker();
    const d = flakyArc(marker, ['u1', 'u2'], [], [
      ...straight('u1', {}), ...of('deflake-1', [planCheckStep({ decision: 'infeasible', notes: 'the lane needs 8 cpus, it declares 4' })]),
      ...straight('u2', { 'src/u2.js': 'export const u2 = 2;\n' }),
    ]);
    const r = contextFor(d);
    try {
      assert.deepEqual(await run(r, 'u1'), { kind: 'merged' });
      assert.deepEqual(await mint(r), { kind: 'applied', admitted: ['deflake-1'], recurring: 0 });
      assert.deepEqual(admission(r, 'u2', 'plan-check'), HELD_BY_DEFLAKE_1);
      const parked = await run(r, 'deflake-1');
      assert.equal(parked.kind, 'parked');
      assert.equal(deflakeState(r.journal.view, unitInForce(r, 'deflake-1').id), 'parked');
      // The edge dropped.
      assert.deepEqual(admission(r, 'u2', 'plan-check'), { kind: 'admit' });
      const { w } = deflakeContext(r);
      raiseDeflakeParked(w.stage);
      raiseDeflakeParked(w.stage);
      const items = r.journal.view.opsOf('needsuser.raise').map((i) => readNeedsUser(r.ctx.runDir, i.expect.id)!).filter((i) => i.reason === 'deflake-parked');
      assert.equal(items.length, 1, 'one item per park');
      assert.deepEqual([items[0]!.blocking, items[0]!.subject], [false, { type: 'unit', unit: 'deflake-1' }]);
      // u2 runs and flakes: forgiven; the parked deflake still owns the key, so nothing is minted.
      reflake(marker);
      assert.deepEqual(await run(r, 'u2'), { kind: 'merged' });
      assert.equal(r.journal.view.flakes().length, 2);
      assert.equal(pending(r), false);
    } finally {
      r.journal.close();
    }
  });

  test('deflake.verification-budget: runs × the lane\'s measured median against the budget (default 30 lane-minutes, a per-lane override, a batch lane\'s runs); a repeat needs a rationale', T, async () => {
    const marker = freshMarker();
    const d = flakyArc(marker, ['u1'], [], straight('u1', {}));
    const r = contextFor(d);
    try {
      assert.deepEqual(await run(r, 'u1'), { kind: 'merged' });
      assert.deepEqual(await mint(r), { kind: 'applied', admitted: ['deflake-1'], recurring: 0 });
      const plan = planOf(r);
      const unit = unitInForce(r, 'deflake-1');
      const { w } = deflakeContext(r);
      const spec = loadUnitSpec(w.stage, unit).spec;
      const median = medianLaneMinutes(r.ctx.runDir, r.journal.view, plan, unit.deflake!.keys, LANE_DEADLINE_MS);
      assert.ok(median !== null && median > 0 && median < 1, `the lane's runs were measured: ${median}`);
      const design = (verification?: DesignRecord['verification']): DesignRecord => ({
        kind: 'module', changes: [{ system: null, paths: ['test/**' as never], lines: 3 }], interfaces: [], failureModes: [], breaks: { tests: [], docs: [] }, experiments: [],
        ...(verification === undefined ? {} : { verification }),
      });
      const reasons = (dr: DesignRecord | undefined) => verificationReasons(r.ctx, plan, unit, spec, dr, LANE_DEADLINE_MS);
      assert.deepEqual(reasons(undefined), [], 'a record-less answer is the design pass\'s to refuse');
      assert.match(reasons(design()).join(), /verification in the design record: reproduce-then-fix/);
      assert.match(reasons(design({ type: 'repeat', rationale: ' ', runs: 2 })).join(), /needs a rationale/);
      assert.deepEqual(reasons(design({ type: 'reproduce-then-fix', condition: 'run it under taskset -c 0', runs: 3 })), []);
      assert.deepEqual(reasons(design({ type: 'repeat', rationale: 'the race needs real timing', runs: 3 })), []);
      const over = Math.ceil(31 / median);
      assert.match(reasons(design({ type: 'repeat', rationale: 'the race needs real timing', runs: over })).join(), new RegExp(`${over} runs of lane flaky costs [0-9.]+ lane-minutes .* over the verification budget of 30 lane-minutes`));
      // The cap per lane: an override, else a batch lane's runs, else the arc default.
      const limited: PlanM1 = { ...plan, limits: { verification: { laneMinutes: 10, lanes: { [unit.deflake!.keys[0]!.lane]: 1 } } } };
      assert.deepEqual(verificationCap(limited, unit.deflake!.keys[0]!.lane, spec.lanes[0]!), { type: 'minutes', minutes: 1 });
      assert.deepEqual(verificationCap(limited, 'other' as never, null), { type: 'minutes', minutes: 10 });
      assert.deepEqual(verificationCap(plan, 'other' as never, { ...spec.lanes[0]!, cadence: 'batch' }), { type: 'runs', runs: 2 });
      assert.deepEqual(verificationCap(plan, 'other' as never, null), { type: 'minutes', minutes: 30 });
      // The lanes stage's verification runs: a deflake unit's lane, two or more.
      assert.deepEqual([...verifyRunsOf(unit, { type: 'repeat', rationale: 'x', runs: 3 })], [['flaky', 3]]);
      assert.deepEqual([...verifyRunsOf(unit, { type: 'repeat', rationale: 'x', runs: 1 })], []);
      assert.deepEqual([...verifyRunsOf(unitInForce(r, 'u1'), { type: 'repeat', rationale: 'x', runs: 3 })], []);
    } finally {
      r.journal.close();
    }
  });
});

describe('verification runs and stochastic lanes', () => {
  const PARENT: StageParent = { type: 'stage', unit: STAGE_U1, stage: 'lanes', attempt: 1 };
  const rt = (ctx: Parameters<typeof reserveNow>[0]) => ({ acquire: reserveNow(ctx), rank: () => { throw new Error('not ranked'); }, signal: new AbortController().signal, sampleHost: () => ({ load1: 1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 }) });

  test('deflake.verify-runs: a deflake unit\'s verification runs its lane fresh that many times, every run passing; a red run fails it', T, async () => {
    const counter = join(tmpDir('verify-runs'), 'count');
    // Passes, then fails its second run in the second series.
    const lane = { id: 'flaky', argv: ['sh', '-c', `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; [ "$n" -ne 5 ]`] };
    const run = setupUnit({ steps: [], lanes: [lane], unit: { origin: 'deflake', deflake: { keys: [{ type: 'lane', lane: 'flaky' }] } } });
    pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
    const series = (n: number) => {
      const parent: StageParent = { ...PARENT, attempt: n };
      const checkout = { path: absPath(join(tmpDir('verify-tree'), 'tree')), checkout: { type: 'detached', at: run.base } } as const;
      return runLaneSeries(run.ctx, parent, laneOrder(loadUnitSpec(run.ctx, run.unit).spec), 'spec', checkout, specSeriesRoot(run.ctx.runDir, parent), rt(run.ctx), false, new Map(), new Map([['flaky' as never, 3]]));
    };
    const green = await series(1);
    assert.equal(green.end.kind, 'green');
    const spawns = run.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'lane');
    assert.equal(spawns.length, 3, 'three runs');
    assert.ok(spawns.every((i) => i.expect.subject.purpose === 'lane' && i.expect.subject.verify === 3));
    const back = seriesLedger(run.ctx, { ...PARENT, attempt: 1 }, loadUnitSpec(run.ctx, run.unit).spec.lanes, 'spec', run.base, specSeriesRoot(run.ctx.runDir, { ...PARENT, attempt: 1 }));
    assert.deepEqual(back, green.ledger);
    // Runs 4, 5 (red), and no sixth: three passes can no longer be reached.
    const red = await series(2);
    assert.equal(red.end.kind, 'red');
    assert.equal(run.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'lane').length, 5);
    assert.equal(run.journal.view.flakes().length, 0, 'a verification run is never a flake');
  });

  test('deflake.stochastic: a k-of-n lane red then green passes without the red-lane protocol and never enters the ledger', T, async () => {
    const marker = freshMarker();
    const run = setupUnit({ steps: [], lanes: [{ ...flakyLane(marker), stochastic: { runs: 2, minPasses: 1 } }] });
    pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
    const done = started(await lanes(run.ctx, run.unit, run.base));
    assert.equal(done.outcome.kind, 'green');
    assert.equal(existsSync(marker), true, 'it ran red first');
    assert.deepEqual(run.journal.view.flakes(), []);
    assert.deepEqual(deflakeDue(run.journal.view, run.ctx.plan()), { mint: [], recurring: [] });
  });
});

/** u1 flakes and its deflake merges, then u2 flakes again and the second deflake is minted (unmerged). */
async function reflakeTwice(r: ArcRun, marker: string): Promise<void> {
  assert.deepEqual(await run(r, 'u1'), { kind: 'merged' });
  assert.deepEqual(await mint(r), { kind: 'applied', admitted: ['deflake-1'], recurring: 0 });
  assert.deepEqual(await run(r, 'deflake-1'), { kind: 'merged' });
  reflake(marker);
  assert.deepEqual(await run(r, 'u2'), { kind: 'merged' });
  assert.equal(pending(r), true, 'a flake after the deflake merged');
  assert.deepEqual(await mint(r), { kind: 'applied', admitted: ['deflake-2'], recurring: 0 });
}

describe(`matrix row ${DEFLAKE_REVISION}`, () => {
  for (const { label } of crashCells(DEFLAKE_REVISION)) {
    test(`deflake.crash.${label}: the resumed deflake job settles what is due once`, T, async () => {
      const marker = freshMarker();
      const recurring = label === 'deflake.after-recurring';
      const d = flakyArc(marker, ['u1', 'u2', 'u3'], [], [
        ...straight('u1', {}), ...straight('deflake-1', { 'test/a.txt': 'a\n' }), ...straight('u2', { 'src/u2.js': 'export const u2 = 2;\n' }),
        ...straight('deflake-2', { 'test/b.txt': 'b\n' }), ...straight('u3', { 'src/u3.js': 'export const u3 = 3;\n' }),
      ]);
      const setup = contextFor(d);
      try {
        if (recurring) {
          await reflakeTwice(setup, marker);
          assert.deepEqual(await run(setup, 'deflake-2'), { kind: 'merged' });
          reflake(marker);
          assert.deepEqual(await run(setup, 'u3'), { kind: 'merged' });
        } else {
          assert.deepEqual(await run(setup, 'u1'), { kind: 'merged' });
        }
      } finally {
        setup.journal.close();
      }
      const trigger = writeTrigger(tmpDir('deflake-crash'), { label, occurrence: 1 });
      const exit = await runFixture('deflake-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      try {
        const { w } = deflakeContext(r);
        await recover({ stage: w.stage, commands: w.commands });
        assert.deepEqual(await mint(r), { kind: 'none' }, 'nothing is due again');
        const deflakeRevisions = facts(r).filter((f) => f.kind === 'plan-applied' && f.source.type === 'deflake');
        const items = r.journal.view.opsOf('needsuser.raise').map((i) => readNeedsUser(r.ctx.runDir, i.expect.id)!).filter((i) => i.reason === 'flake-recurring');
        assert.deepEqual([deflakeRevisions.length, items.length], recurring ? [2, 1] : [1, 0]);
        assert.equal(planOf(r).units.filter((u) => u.origin === 'deflake').length, recurring ? 2 : 1);
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});
