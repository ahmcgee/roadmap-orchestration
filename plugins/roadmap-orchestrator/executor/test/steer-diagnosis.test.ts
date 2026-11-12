// dev.70, the field crash loop of 2026-11-12: a build runs the unit's M4 diagnosis (8 builds or 20 judged attempts) under a
// pre-build attempt of its own, inside the build's step (src/pipeline/stages.ts `build`). Up to dev.69 that attempt closed
// `approve`, which the fold refuses while a steer entry names the build: the executor crashed recording it, its fault
// containment hit the same refusal, and every restart then refused the open attempt (unit.ts `consumeRecorded`: "the open
// attempt N is at pre-build, but the unit's next stage is build"). Integrated: real processes, real git, fake backends.
//
//   steer-diagnosis.live      the field sequence: lanes interrupted (hold), steer --resume, the diagnosis, the steered build
//   steer-diagnosis.recovery  the journal a crash leaves mid-diagnosis under a steer entry, per closure of its call
//                             (done live, with and without its review recorded; reconciled; lost), adopted at startup
//   steer-diagnosis.decided   the same without a steer: the decided round survives the diagnosis
//   steer-diagnosis.fault     an executor fault during the diagnosis parks the unit under its steer entry
//   steer-diagnosis.startup   a recorded attempt that cannot be read parks its unit; the startup goes on
//   steer-diagnosis.fold      what the fold admits under a steer entry
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact,StageOutcomeFact } from '../src/core/events.ts';
import { invocationId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { CommandBody } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { consumeRecovered } from '../src/executor.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { invocationDir,killWorkload } from '../src/pipeline/invoke.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { STEER_DIRECTIVE } from '../src/prompts/directives.ts';
import { recover } from '../src/recover/recover.ts';
import { faultUnit } from '../src/schedule/fault.ts';
import { bytesSha256 } from '../src/spec/spec.ts';
import { recoveryContext } from './fixtures/rec-common.ts';
import { BUILD_REPORT,SCENARIO_TIMEOUT_MS,admitAll,planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor,type ArcRun,MUL_LANE,U1,commandContextFor,contextFor,gateStep,mulBuild,outcomes,setupArc,stepUntil } from './fixtures/unit-common.ts';
import { barrierDir,reached,release } from './helpers/barrier.ts';
import { assertFired,writeTrigger } from './helpers/crash.ts';
import { fixture,runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Step,readCalls } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const BRIEF = 'STEER-BRIEF-MARKER: find the cause and fix it.';
const NOTE = 'DIAGNOSIS-NOTE-MARKER: the repeated red needs a narrow restart experiment.';
const TO_PARK: readonly Step[] = [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' })];
/** The verifier's diagnosis call, then the steer round (a diagnosed unit's builds are Claude's), then the pass's gate. */
const diagnosis = gateStep({ decision: 'approve', reasons: [NOTE] });
const steerRound: Step = { as: 'claude', expect: { argvLacks: ['--resume'], stdinContains: [STEER_DIRECTIVE, BRIEF, NOTE] }, acts: [{ type: 'emit', value: BUILD_REPORT }] };

/** The unit's M4 diagnosis is due: no fixture arc reaches 8 builds or 20 judged attempts by itself (as test/agent-surface.test.ts). */
const due = (r: ArcRun): void => void Object.assign(r.journal.view, { attemptCounts: () => ({ builds: 8, judged: 20 }) });

function steerBody(resume: boolean): CommandBody {
  const path = absPath(join(tmpDir('steer-brief'), 'brief.md'));
  writeFileSync(path, BRIEF);
  return { type: 'steer', unit: U1, brief: { path, sha256: bytesSha256(Buffer.from(BRIEF)) }, budgetMin: 5, class: null, resume };
}
const command = async (r: ArcRun, body: CommandBody): Promise<void> => {
  const out = await applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.journal.view.arc, body));
  assert.equal(out.kind, 'applied', JSON.stringify(out));
};
const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const outcomeFacts = (r: ArcRun) => facts(r).flatMap((f) => (f.kind === 'stage-outcome' && 'unit' in f ? [f as StageOutcomeFact] : []));
const reviews = (r: ArcRun) => r.journal.view.surfaceFacts().filter((f) => f.kind === 'review-completed' && f.mode === 'diagnosis');
const counters = (r: ArcRun) => {
  const c = r.journal.view.unit(U1).counters;
  return { chargeableFailures: c.chargeableFailures, reviseRounds: c.reviseRounds, candidateReds: c.candidateReds, retries: c.retries };
};
const diagnosisCalls = (d: ArcDescriptor) => readCalls(d.scenarioPath).filter((c) => c.stdin.includes('<mode>diagnosis</mode>'));

/** u1 parked by two gate escalations, then steered (`--resume`): a steer entry at build, nothing open. */
async function parkedAndSteered(steps: readonly Step[]): Promise<ArcRun> {
  const r = contextFor(setupArc({ steps: [...TO_PARK, ...steps] }));
  const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
  assert.equal(parked.kind, 'parked', JSON.stringify(parked));
  await command(r, steerBody(true));
  assert.deepEqual([r.journal.view.unit(U1).entry?.kind, r.journal.view.unit(U1).open], ['steer', null]);
  return r;
}

/** Where the child driver dies: at a crash point (its `occurrence`-th for u1 in the child), or killed while its diagnosis call waits at barrier `b1`. */
type Crash = Readonly<{ label: string; occurrence: number }> | 'mid-call';

/**
 * `setup`'s driver run on in a child with the diagnosis due and killed at `crash`, then the executor's startup up to
 * `consumeRecovered`: a new `executor-started` and recovery (which adopts a runner that outlived the child).
 */
async function crashedInDiagnosis(setup: ArcRun, crash: Crash): Promise<Readonly<{ r: ArcRun; attempt: number; before: ReturnType<typeof counters> }>> {
  const before = counters(setup);
  const attempt = setup.journal.view.unit(U1).counters.attempts + 1;
  const d = setup.d;
  setup.journal.close();
  if (crash === 'mid-call') {
    const child = spawn(process.execPath, [fixture('diagnosis-child.ts'), JSON.stringify(d), 'u1'], { env: process.env, stdio: 'ignore' });
    const exited = once(child, 'close');
    await reached(d.scenarioDir, 'b1', 60_000);
    child.kill('SIGKILL');
    await exited;
  } else {
    const trigger = writeTrigger(tmpDir('diagnosis-crash'), { ...crash, unit: 'u1' });
    const exit = await runFixture('diagnosis-child.ts', [JSON.stringify(d), 'u1'], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: SCENARIO_TIMEOUT_MS });
    assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${crash.label}: code ${exit.code}, stderr ${exit.stderr}`);
    assertFired(trigger);
  }
  const r = contextFor(d);
  due(r);
  const u = r.journal.view.unit(U1);
  assert.deepEqual([u.open?.stage, u.open?.attempt], ['pre-build', attempt], 'an open pre-build attempt, while the unit\'s next stage is its build');
  assert.equal(outcomeFacts(r).some((f) => f.attempt === attempt), false, 'no outcome of the attempt');
  r.journal.fact({ kind: 'executor-started', pressure: 'unavailable', generation: 1 });
  const recovering = recover(recoveryContext(r));
  if (crash === 'mid-call') release(d.scenarioDir, 'b1');
  await recovering;
  return { r, attempt, before };
}

/** The steered build ran exactly as after a steer at a clean boundary; the diagnosis was called once and charged nothing. */
async function assertSteeredBuildRuns(r: ArcRun, attempt: number, before: ReturnType<typeof counters>, closed: 'diagnosed' | 'interrupted'): Promise<void> {
  const u = r.journal.view.unit(U1);
  assert.deepEqual([u.status, u.open, u.entry?.kind, u.steering?.resume, u.interrupted], ['active', null, 'steer', true, null], 'the entry survives; nothing is open or held');
  const closing = outcomeFacts(r).at(-1);
  assert.deepEqual(closing, {
    kind: 'stage-outcome', unit: 'u1', stage: 'pre-build', attempt, outcome: closed, class: 'hold', chargeable: false, ...(closed === 'interrupted' ? { cause: { type: 'recovery' } } : {}),
  });
  assert.deepEqual(counters(r), before, 'uncharged');
  assert.deepEqual([...r.journal.view.resources()].filter(([, e]) => e.status.state !== 'free').map(([n]) => n), [], 'the dead attempt holds nothing');
  assert.deepEqual(r.journal.view.openIntents(), [], 'nothing of it is open');
  const recorded = outcomeFacts(r).length;
  await consumeRecovered(r.ctx);
  assert.equal(outcomeFacts(r).length, recorded, 'a second startup records nothing more');
  assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
  assert.deepEqual(outcomes(r.d).slice(outcomes(r.d).indexOf(`pre-build:${closed}`)), [
    `pre-build:${closed}`, 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published',
  ]);
  const build = outcomeFacts(r).find((f) => f.stage === 'build' && f.attempt > attempt);
  assert.equal(build?.attempt, attempt + 1, 'the steered build is the next attempt');
  assert.equal(diagnosisCalls(r.d).length, closed === 'diagnosed' ? 1 : 0, 'the diagnosis is never dispatched again');
  assert.deepEqual(counters(r), before, 'the steer pass charges nothing');
  assert.ok(readCalls(r.d.scenarioPath).every((c) => c.step !== null), 'every call matched its step');
}

test('steer-diagnosis.live: lanes held by a pause, then steer --resume: the build\'s M4 diagnosis closes `diagnosed` under the steer entry, and the steered round runs on the brief with the diagnosis note', T, async () => {
  const dir = barrierDir();
  const slow = { id: 'slow', argv: [process.execPath, fixture('pm-lane-barrier.ts'), dir, 'lane'] };
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), diagnosis, steerRound, gateStep({ decision: 'approve' })], units: [{ id: 'u1', lanes: [MUL_LANE, slow] }] });
  const r = contextFor(d);
  try {
    // The scheduler's pause of a steered unit: its task's signal aborted, its live lane killed (`interrupt`).
    const abort = new AbortController();
    const running = runUnit({ ...r.ctx, signal: abort.signal }, r.unit('u1'), admitAll);
    await reached(dir, 'lane', 60_000);
    const lane = r.journal.view.openIntents().find((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'lane');
    assert.ok(lane !== undefined && lane.kind === 'proc.spawn', 'the lane invocation is open');
    abort.abort('pause');
    await killWorkload(r.ctx, { inv: invocationId(lane.op, lane.ordinal), scope: 'invocation', reason: 'pause' });
    assert.deepEqual(await running, { kind: 'held', needsUser: null });
    const held = outcomeFacts(r).at(-1);
    assert.deepEqual([held?.stage, held?.outcome, held?.class, held?.chargeable], ['lanes', 'interrupted', 'hold', false], 'the field\'s lanes#48');
    writeFileSync(join(dir, 'lane.release'), '');

    const before = counters(r);
    await command(r, steerBody(true));
    const attempt = r.journal.view.unit(U1).counters.attempts + 1;
    due(r);
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    assert.deepEqual(outcomes(d).slice(outcomes(d).indexOf('lanes:interrupted')), [
      'lanes:interrupted', 'pre-build:diagnosed', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve',
      'candidate:green', 'ff:published', 'snapshot:published',
    ]);
    const closing = outcomeFacts(r).find((f) => f.outcome === 'diagnosed');
    assert.deepEqual(closing, { kind: 'stage-outcome', unit: 'u1', stage: 'pre-build', attempt, outcome: 'diagnosed', class: 'hold', chargeable: false });
    assert.equal(reviews(r).length, 1);
    assert.equal(diagnosisCalls(d).length, 1);
    assert.deepEqual(counters(r), before, 'uncharged');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null), 'every call matched its step: the steer round carried the brief and the diagnosis note');
  } finally {
    r.journal.close();
  }
});

describe('steer-diagnosis.recovery: an open diagnosis attempt under a steer entry is adopted at startup', () => {
  const steps = [diagnosis, steerRound, gateStep({ decision: 'approve' })];

  test('steer-diagnosis.recovery field shape: the review recorded and its resources released, no outcome: closed `diagnosed`, then the steered build', T, async () => {
    // The attempt's last release: reserve, run, cleaning, released are its four resource transitions.
    const { r, attempt, before } = await crashedInDiagnosis(await parkedAndSteered(steps), { label: 'resource.after-done', occurrence: 4 });
    try {
      assert.equal(r.journal.view.unit(U1).entry?.kind, 'steer');
      assert.equal(reviews(r).length, 1, 'review-completed is in the journal, as at the field\'s seq 24210');
      await consumeRecovered(r.ctx);
      assert.equal(reviews(r).length, 1, 'the review is recorded once');
      await assertSteeredBuildRuns(r, attempt, before, 'diagnosed');
    } finally {
      r.journal.close();
    }
  });

  test('steer-diagnosis.recovery call done live, its review unrecorded: the result is consumed (review-completed, the note kept), closed `diagnosed`', T, async () => {
    const { r, attempt, before } = await crashedInDiagnosis(await parkedAndSteered(steps), { label: 'spawn.after-done', occurrence: 1 });
    try {
      assert.equal(reviews(r).length, 0);
      const spawn = r.journal.view.opsOfUnit('proc.spawn', U1).at(-1)!;
      assert.equal(r.journal.view.doneOf(spawn.op)?.recoveredBy, null, 'the call was closed live');
      await consumeRecovered(r.ctx);
      assert.deepEqual(reviews(r).map((f) => f.kind === 'review-completed' && [f.inv, f.note !== null]), [[invocationId(spawn.op, spawn.ordinal), true]]);
      await assertSteeredBuildRuns(r, attempt, before, 'diagnosed');
    } finally {
      r.journal.close();
    }
  });

  for (const [how, crash] of [['redone', { label: 'spawn.after-runner-exit', occurrence: 1 }], ['reconciled', { label: 'spawn.after-result', occurrence: 1 }], ['adopted', 'mid-call']] as const) {
    test(`steer-diagnosis.recovery call closed by recovery (${how}): its result is consumed, closed \`diagnosed\``, T, async () => {
      const call = how === 'adopted' ? gateStep({ decision: 'approve', reasons: [NOTE] }, {}, [{ type: 'barrier', name: 'b1', timeoutMs: 120_000 }]) : diagnosis;
      const { r, attempt, before } = await crashedInDiagnosis(await parkedAndSteered([call, steerRound, gateStep({ decision: 'approve' })]), crash);
      try {
        const spawned = r.journal.view.opsOfUnit('proc.spawn', U1).at(-1)!;
        assert.equal(r.journal.view.doneOf(spawned.op)?.recoveredBy, how);
        await consumeRecovered(r.ctx);
        assert.equal(reviews(r).length, 1);
        await assertSteeredBuildRuns(r, attempt, before, 'diagnosed');
      } finally {
        r.journal.close();
      }
    });
  }

  test('steer-diagnosis.recovery call lost: nothing to consume, the attempt takes the recovery hold and the steered build runs without a diagnosis', T, async () => {
    const { r, attempt, before } = await crashedInDiagnosis(
      await parkedAndSteered([{ ...steerRound, expect: { argvLacks: ['--resume'], stdinContains: [STEER_DIRECTIVE, BRIEF] } }, gateStep({ decision: 'approve' })]), { label: 'spawn.after-intent', occurrence: 1 });
    try {
      const spawn = r.journal.view.opsOfUnit('proc.spawn', U1).at(-1)!;
      assert.equal(r.journal.view.doneOf(spawn.op)?.outcome.kind, 'lost');
      await consumeRecovered(r.ctx);
      assert.equal(reviews(r).length, 0);
      await assertSteeredBuildRuns(r, attempt, before, 'interrupted');
    } finally {
      r.journal.close();
    }
  });
});

test('steer-diagnosis.fault: an executor fault during the diagnosis parks the unit `executor-fault` at that attempt, under its steer entry, which ends with the park', T, async () => {
  const { r, attempt } = await crashedInDiagnosis(await parkedAndSteered([diagnosis]), { label: 'resource.after-done', occurrence: 4 });
  try {
    const parked = await faultUnit(r.ctx, r.unit('u1'), new Error('a fault while the diagnosis attempt is open'));
    assert.equal(parked?.kind, 'parked');
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.status, u.open, u.entry, u.steering], ['park-pending', null, null, null]);
    const f = outcomeFacts(r).at(-1);
    assert.deepEqual([f?.stage, f?.attempt, f?.outcome, f?.class, f?.chargeable], ['pre-build', attempt, 'executor-fault', 'park', false]);
  } finally {
    r.journal.close();
  }
});

test('steer-diagnosis.decided: without a steer, a crash in the diagnosis of a decided fix round is adopted the same way, and the round the gate decided still runs', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'revise', directives: ['REVISE-DIRECTIVE-MARKER'] }), diagnosis] });
  const setup = contextFor(d);
  await stepUntil(setup, 'u1', (f) => f.stage === 'gate' && f.outcome === 'revise');
  const { r, attempt } = await crashedInDiagnosis(setup, { label: 'resource.after-done', occurrence: 4 });
  try {
    await consumeRecovered(r.ctx);
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.status, u.open, u.entry, u.interrupted], ['active', null, null, null]);
    assert.deepEqual([u.decided?.stage, u.decided?.outcome, u.decided?.class], ['gate', 'revise', 'revise'], 'the gate\'s decision still names the next stage: its fix round');
    assert.deepEqual(outcomeFacts(r).at(-1), { kind: 'stage-outcome', unit: 'u1', stage: 'pre-build', attempt, outcome: 'diagnosed', class: 'hold', chargeable: false });
    assert.equal(reviews(r).length, 1);
  } finally {
    r.journal.close();
  }
});

test('steer-diagnosis.fold: under a steer entry the fold still refuses a deciding pre-build outcome, and `diagnosed` is a hold by schema', T, async () => {
  const r = await parkedAndSteered([]);
  try {
    const attempt = r.journal.view.unit(U1).counters.attempts + 1;
    const base = { kind: 'stage-outcome', unit: U1, stage: 'pre-build', attempt, chargeable: false } as const;
    assert.throws(() => r.journal.fact({ ...base, outcome: 'approve', class: 'advance' }), /pre-build#\d+ while its steer entry is at build/);
    assert.throws(() => r.journal.fact({ ...base, outcome: 'diagnosed', class: 'advance' }), /hold exactly for an interrupted outcome, a split or a diagnosis/);
    assert.equal(r.journal.view.unit(U1).entry?.kind, 'steer');
  } finally {
    r.journal.close();
  }
});

test('steer-diagnosis.startup: a recorded attempt that cannot be read parks its unit with an item; the startup goes on to the next unit', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()], units: [{ id: 'u1' }, { id: 'u2' }] });
  // u1's build call done, its outcome unrecorded (the second spawn of u1: its pre-build's is the first).
  const trigger = writeTrigger(tmpDir('startup-crash'), { label: 'spawn.after-done', occurrence: 2, unit: 'u1' });
  const exit = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(exit.signal, 'SIGKILL', exit.stderr);
  assertFired(trigger);
  const r = contextFor(d);
  try {
    const spawn = r.journal.view.opsOfUnit('proc.spawn', U1).at(-1)!;
    // The call's result is gone: what the journal says was recorded cannot be read back.
    rmSync(join(invocationDir(r.ctx.runDir, invocationId(spawn.op, spawn.ordinal)), 'result.json'));
    r.journal.fact({ kind: 'executor-started', pressure: 'unavailable', generation: 1 });
    await recover(recoveryContext(r));
    await consumeRecovered(r.ctx);
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.status, u.open, u.decided?.stage, u.decided?.outcome, u.decided?.chargeable], ['park-pending', null, 'build', 'executor-fault', false]);
    const item = r.journal.view.needsUser().map((n) => readNeedsUser(r.ctx.runDir, n.id)).find((n) => n?.reason === 'executor-fault');
    assert.ok(item !== undefined && item !== null && item.subject.type === 'unit' && item.subject.unit === 'u1', 'the park\'s item names the unit');
    assert.match(item.summary, /without its backend result/);
    assert.equal(r.journal.view.unit(r.unit('u2').id).status, 'active', 'the other unit is untouched and the startup returned');
  } finally {
    r.journal.close();
  }
});
