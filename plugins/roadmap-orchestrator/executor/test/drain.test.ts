// Real executor/supervisor, git, backends and lanes; barriers hold a stage until control is durable.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { after, test } from 'node:test';
import { type NeedsUserId, arcId, unitId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { reached, release } from './helpers/barrier.ts';
import { fixture } from './helpers/proc.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Step } from './helpers/scenario.ts';
import { EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, cli, executorPid, journalOf, reasonOf, setupExec, startExec, statusOf, until } from './fixtures/exec-common.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { MUL, U1, codexStep, gateStep, outcomes } from './fixtures/unit-common.ts';

after(assertNoSurvivors);
const T = { timeout: EXEC_TIMEOUT_MS };
const WAIT = 60_000;
const STOP = { kind: 'stop', cause: 'command', needsUser: null };
const buildAt = (name: string): Step => codexStep([
  { type: 'commit', message: 'add mul', files: MUL },
  { type: 'barrier', name, timeoutMs: 120_000 },
], { argv: ['exec', '-C'] });
const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));

/** u2 becomes ready when its item is acknowledged during drain, after u1 is already building. */
function holdSecond(r: ExecRun): NeedsUserId {
  mkdirSync(r.runDir, { recursive: true });
  const j = openJournal(absPath(r.runDir), arcId(r.arc));
  try {
    return raiseNeedsUser(j, absPath(r.runDir), {
      blocking: true, subject: { type: 'unit', unit: unitId('u2') }, reason: 'lane-blocked',
      summary: 'Hold second unit until the test releases admission', recommendation: 'ack', options: [{ id: 'ready', label: 'Ready' }], evidence: [],
    }, { type: 'arc' });
  } finally { j.close(); }
}

for (const stage of ['build', 'lanes'] as const) {
  test(`drain finishes an in-flight ${stage}, records its outcome, and admits neither its next stage nor a second ready unit`, T, async (t) => {
    const laneDir = tmpDir('drain-lane');
    const r = setupExec(t, {
      units: [{ id: 'u1', ...(stage === 'lanes' ? { lanes: [{ id: 'wait', argv: [process.execPath, fixture('pm-lane-barrier.ts'), laneDir, 'lane'] }] } : {}) }, { id: 'u2' }],
      steps: [...SMOKE_DEFAULT, ...of('u1', [planCheckStep({ decision: 'approve' }), buildAt('build')])],
    });
    const item = holdSecond(r);
    const running = startExec(r);
    await reached(r.scenarioDir, 'build', WAIT);
    if (stage === 'lanes') {
      release(r.scenarioDir, 'build');
      await reached(laneDir, 'lane', WAIT);
    }
    await cli(r, ['stop', '--drain', '--within', '5']);
    await until(() => journalOf(r).view.control().stopOptions.mode === 'drain', WAIT, 'drain applied');
    const status = await statusOf(r);
    assert.equal(status.run.state, 'draining');
    assert.equal(status.run.stop?.mode, 'drain');
    assert.ok(Date.parse(status.run.stop!.deadline!) > Date.now());
    await cli(r, ['ack', item, '--choice', 'ready']);
    await until(() => journalOf(r).view.ackOf(item) !== null, WAIT, 'u2 made ready');
    assert.deepEqual(outcomes(r, 'u2'), [], 'u2 is ready but drain admits no task');
    if (stage === 'build') release(r.scenarioDir, 'build');
    else release(laneDir, 'lane');
    const exit = await running.exit;
    assert.equal(exit.code, 0, exit.stderr);
    assert.deepEqual(reasonOf(exit), STOP);
    const out = outcomes(r);
    assert.ok(out.includes('build:success'), out.join(' '));
    assert.equal(out.at(-1), stage === 'build' ? 'teardown:released' : 'lanes:green');
    assert.deepEqual(outcomes(r, 'u2'), []);
    const view = journalOf(r).view;
    assert.deepEqual(view.opsOf('proc.kill'), [], 'drain never kills the work');
    assert.ok([...view.resources().values()].every((r) => r.status.state === 'free'));
  });
}

for (const escalation of ['deadline', 'plain-stop'] as const) {
  test(`drain escalates to abort on ${escalation}`, T, async (t) => {
    const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), buildAt('overrun')] });
    const running = startExec(r);
    await reached(r.scenarioDir, 'overrun', WAIT);
    await cli(r, ['stop', '--drain', ...(escalation === 'deadline' ? ['--within', '0.05'] : [])]);
    if (escalation === 'plain-stop') {
      await until(() => journalOf(r).view.control().stopOptions.mode === 'drain', WAIT, 'drain applied before escalation');
      await cli(r, ['stop']);
    }
    const exit = await running.exit;
    assert.equal(exit.code, 0, exit.stderr);
    assert.deepEqual(reasonOf(exit), STOP);
    assert.ok(outcomes(r).includes('build:interrupted'), outcomes(r).join(' '));
    assert.ok(journalOf(r).view.opsOf('proc.kill').some((i) => i.expect.reason === 'stop'));
  });
}

test('a supervisor restart during drain keeps its journaled deadline and admits no next stage', T, async (t) => {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), buildAt('crash')] });
  const running = startExec(r);
  await reached(r.scenarioDir, 'crash', WAIT);
  await cli(r, ['stop', '--drain', '--within', '5']);
  await until(() => journalOf(r).view.control().stopOptions.mode === 'drain', WAIT, 'drain applied before crash');
  const before = journalOf(r).view.control();
  process.kill(executorPid(r), 'SIGKILL');
  release(r.scenarioDir, 'crash');
  const exit = await running.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), STOP);
  const after = journalOf(r);
  assert.equal(after.events.filter((e) => e.type === 'fact' && e.fact.kind === 'executor-started').length, 2);
  assert.deepEqual(after.view.control(), before);
  assert.equal(after.view.unit(U1).stage, 'teardown');
  assert.ok(outcomes(r).includes('build:success'));
  assert.equal(outcomes(r).at(-1), 'teardown:released');
});

test('a fresh start after completed drain adopts the arc at its next clean stage', T, async (t) => {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), buildAt('update'), ...SMOKE_DEFAULT, gateStep({ decision: 'approve' })] });
  const first = startExec(r);
  await reached(r.scenarioDir, 'update', WAIT);
  await cli(r, ['stop', '--drain']);
  await until(() => journalOf(r).view.control().stopOptions.mode === 'drain', WAIT, 'drain applied');
  release(r.scenarioDir, 'update');
  assert.deepEqual(reasonOf(await first.exit), STOP);
  assert.equal(outcomes(r).at(-1), 'teardown:released');
  const second = await startExec(r).exit;
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(reasonOf(second), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.equal(journalOf(r).view.control().stop, null);
  assert.equal(outcomes(r).filter((o) => o === 'build:success').length, 1, 'the completed build is adopted');
  assert.equal(outcomes(r).at(-1), 'snapshot:published');
});

for (const escalation of ['deadline', 'plain-stop'] as const) {
  test(`recovery of a live runner during drain still honors ${escalation}`, T, async (t) => {
    const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), buildAt('recover-overrun')] });
    const running = startExec(r);
    await reached(r.scenarioDir, 'recover-overrun', WAIT);
    await cli(r, ['stop', '--drain', ...(escalation === 'deadline' ? ['--within', '0.12'] : [])]);
    await until(() => journalOf(r).view.control().stopOptions.mode === 'drain', WAIT, 'drain applied');
    process.kill(executorPid(r), 'SIGKILL');
    await until(() => journalOf(r).events.filter((e) => e.type === 'fact' && e.fact.kind === 'executor-started').length === 2, WAIT, 'recovery to adopt the live build');
    if (escalation === 'plain-stop') await cli(r, ['stop']);
    const exit = await running.exit;
    assert.equal(exit.code, 0, exit.stderr);
    assert.deepEqual(reasonOf(exit), STOP);
    assert.ok(outcomes(r).includes('build:interrupted'), outcomes(r).join(' '));
    assert.ok(!outcomes(r).some((o) => o.startsWith('lanes:')));
  });
}
