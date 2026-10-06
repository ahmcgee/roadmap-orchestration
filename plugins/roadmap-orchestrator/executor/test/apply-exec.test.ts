// `roadmap apply` against a running executor, through the real CLI as child processes, fake-backed (the
// executor tests' harness): a mutation applies once the units in its scope are idle or at an admission
// boundary (A12), never by killing what runs; the plan in force changes what the arc does next. Named tests: apply.exec-add-unit-mid-build,
// apply.exec-revision-in-flight, apply.exec-routing-parks, apply.exec-resume-at-boundary,
// apply.exec-respawn-ignores-unapplied-edit; the crash cells of the matrix row "start: a later start whose files
// change the plan".
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Event, Fact } from '../src/core/events.ts';
import { type CommandId, commandId, unitId } from '../src/core/ids.ts';
import { terminalReceipt } from '../src/commands/queue.ts';
import { absPath } from '../src/core/values.ts';
import { CONTINUE_DIRECTIVE, RESPEC_DIRECTIVE } from '../src/prompts/directives.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { type CodexAct, type Step, readCalls } from './helpers/scenario.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { tmpDir } from './helpers/repo.ts';
import { PLAN_START, crashCells } from './matrix.ts';
import { type Scenario, finalReason, layout, supervisedRun } from './fixtures/pm-common.ts';
import { stateOf } from './fixtures/sup-common.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { MUL, appendSteps, codexStep, gateStep, mulBuild, outcomes, workDirPattern } from './fixtures/unit-common.ts';
import {
  EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, cli, executorPid, journalOf, reasonOf, setupExec, startExec, statusOf, until,
} from './fixtures/exec-common.ts';

after(assertNoSurvivors);

const T = { timeout: EXEC_TIMEOUT_MS };
const WAIT_MS = 60_000;
const U1 = unitId('u1');
const STRAIGHT = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

type Json = Record<string, unknown>;
const specPath = (r: ExecRun, unit: string): string => join(r.planPath, '..', `${unit}.json`);

function editPlan(r: ExecRun, edit: (plan: Json & { units: Json[] }) => void): void {
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as Json & { units: Json[] };
  edit(plan);
  writeFileSync(r.planPath, JSON.stringify(plan));
}

function editSpec(r: ExecRun, unit: string, edit: (spec: Json) => void): void {
  const spec = JSON.parse(readFileSync(specPath(r, unit), 'utf8')) as Json;
  edit(spec);
  writeFileSync(specPath(r, unit), JSON.stringify(spec));
}

/** Adds unit `id` after the others in plan order (and, with `after`, after those units in the graph), its spec a copy of u1's. */
function addUnit(r: ExecRun, id: string, after: readonly string[] = []): void {
  const spec = JSON.parse(readFileSync(specPath(r, 'u1'), 'utf8')) as Json;
  writeFileSync(specPath(r, id), JSON.stringify({ ...spec, unit: id, rev: 1 }));
  editPlan(r, (p) => void p.units.push({ ...p.units[0]!, id, spec: `${id}.json`, ...(after.length > 0 ? { after } : {}) }));
}

/** `roadmap apply`: the id of the command it queued. */
async function apply(r: ExecRun): Promise<CommandId> {
  const line = JSON.parse((await cli(r, ['apply'])).stdout) as { command: string; type: string };
  assert.equal(line.type, 'apply');
  return commandId(line.command);
}

const receiptOf = (r: ExecRun, id: CommandId) => terminalReceipt(absPath(r.runDir), id);
const events = (r: ExecRun): readonly Event[] => journalOf(r).events;
const seqOf = (r: ExecRun, match: (f: Fact) => boolean): number => {
  const e = events(r).find((x) => x.type === 'fact' && match(x.fact));
  if (e === undefined) throw new Error('no such fact in the log');
  return e.seq;
};
const outcomeSeq = (r: ExecRun, unit: string, stage: string, n = 1): number => {
  const all = events(r).filter((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === unit && e.fact.stage === stage);
  const e = all[n - 1];
  if (e === undefined) throw new Error(`no ${stage} outcome #${n} of ${unit}`);
  return e.seq;
};
const kills = (r: ExecRun) => journalOf(r).view.opsOf('proc.kill');

/** A build that commits mul (after `acts`), then waits at barrier `name`. */
function blockedBuild(name: string, threadId?: string, acts: readonly CodexAct[] = []): Step {
  const step = codexStep([...acts, { type: 'commit', message: 'add mul', files: MUL }, { type: 'barrier', name, timeoutMs: 120_000 }], { argv: ['exec', '-C'] });
  return threadId === undefined ? step : ({ ...step, threadId } as Step);
}


test('apply.exec-add-unit-mid-build: a unit added while a build runs is applied at once (its scope is the new unit, which is idle; A12), nothing killed; the arc dispatches it after u1, the `after` it names', T, async (t) => {
  const r = setupExec(t, {
    steps: [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1'), gateStep({ decision: 'approve' }),
      planCheckStep({ decision: 'approve' }), mulBuild({ 'src/extra.js': 'export const extra = 1;\n' }), gateStep({ decision: 'approve' }),
    ],
  });
  const run = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  addUnit(r, 'u2', ['u1']);
  const id = await apply(r);
  await until(() => receiptOf(r, id) !== null, WAIT_MS, 'the apply to apply while u1 still builds');
  assert.equal(journalOf(r).view.unit(U1).decided?.stage, 'plan-check', 'u1\'s build has recorded nothing yet');
  release(r.scenarioDir, 'build1');
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });
  assert.equal(receiptOf(r, id)?.state, 'applied');
  assert.deepEqual(kills(r), [], 'no proc.kill: the running build was not interrupted');
  const fact = seqOf(r, (f) => f.kind === 'plan-applied' && f.command === id);
  assert.ok(fact < outcomeSeq(r, 'u1', 'build'), 'applied while the build ran');
  assert.ok(outcomeSeq(r, 'u1', 'snapshot') < outcomeSeq(r, 'u2', 'plan-check'), 'u2 dispatched once u1 merged');
  assert.deepEqual(outcomes(r, 'u1'), STRAIGHT);
  assert.deepEqual(outcomes(r, 'u2'), STRAIGHT);
  const s = await statusOf(r);
  assert.deepEqual([s.plan?.rev, s.units.map((u) => u.unit)], [2, ['u1', 'u2']]);
  assert.ok(readCalls(r.scenarioPath).every((c) => c.step !== null));
});

test('apply.exec-revision-in-flight: rev + 1 of a held unit\'s spec (paused mid-build: idle, so the apply lands at once, A12) is held to a boundary that allows re-entry (before lanes), past the continued build, then the unit re-enters plan-check on it, keeping its implementer session; the build\'s decisions are not patched onto the spec meanwhile', T, async (t) => {
  const thread = '00000000-0000-4000-8000-0000000a9917';
  const r = setupExec(t, { steps: [] });
  const decisions = JSON.stringify({ decisions: [{ id: 'D1', text: 'mul multiplies with the * operator.' }] });
  const write = { type: 'writeToPrompt', pattern: workDirPattern(r), file: 'decisions.json', text: decisions } as const;
  appendSteps(r, [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }),
      // The thread is reported first, so the paused exec's continue resumes it.
      blockedBuild('build1', thread, [{ type: 'threadStarted' }, write]),
      codexStep([write], { argv: ['exec', 'resume', thread], stdinContains: [CONTINUE_DIRECTIVE] }),
      planCheckStep({ decision: 'approve' }),
      codexStep([], { argv: ['exec', 'resume', thread], stdinContains: [RESPEC_DIRECTIVE, 'mul(0, 5) is 0'] }),
      gateStep({ decision: 'approve' }),
  ]);
  const run = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  editSpec(r, 'u1', (s) => {
    s['acceptance'] = [...(s['acceptance'] as Json[]), { id: 'A2', clause: 'mul(0, 5) is 0', failLoudIfUndelivered: true, state: 'active' }];
    s['rev'] = 2;
  });
  await cli(r, ['pause', 'u1']);
  await until(() => outcomes(r).includes('build:interrupted'), WAIT_MS, 'the build to be interrupted');
  const id = await apply(r);
  await until(() => receiptOf(r, id) !== null, WAIT_MS, 'the apply to land while u1 is held');
  assert.equal(receiptOf(r, id)?.state, 'applied');
  assert.equal(journalOf(r).view.unit(U1).pendingRevision?.rev, 2, 'held pending: a continued build does not re-enter');
  await cli(r, ['resume', 'u1']);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.deepEqual(kills(r).map((k) => k.expect.reason), ['pause']);
  // The continued build's chain (quiesce → teardown) ran on rev 1; the unit re-entered before its lanes.
  assert.deepEqual(outcomes(r), ['plan-check:approve', 'build:interrupted', ...STRAIGHT.slice(1, 6), ...STRAIGHT]);
  const applied = seqOf(r, (f) => f.kind === 'plan-applied' && f.command === id);
  const reopened = seqOf(r, (f) => f.kind === 'reopened' && f.command === id && f.specRev === 2);
  assert.ok(outcomeSeq(r, 'u1', 'build') < applied && applied < outcomeSeq(r, 'u1', 'build', 2), 'applied while the unit was held');
  assert.ok(outcomeSeq(r, 'u1', 'teardown') < reopened && reopened < outcomeSeq(r, 'u1', 'plan-check', 2), 're-opened at the boundary before lanes');
  const { view } = journalOf(r);
  assert.equal(view.unit(U1).approval?.fingerprint.specRev, 2, 'approved on the revision');
  assert.deepEqual(view.opsOf('spec.patch'), [], 'no executor patch of a spec whose revision is pending');
  assert.ok(readCalls(r.scenarioPath).every((c) => c.step !== null), 'the build after the re-entry resumed the session, told the spec was amended');
});

test('apply.exec-routing-parks: a routing apply that moves the building unit\'s implementer seat parks it routing-changed at its next dispatch', T, async (t) => {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1')] });
  const run = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  editPlan(r, (p) => void (p['routing'] = { build: { med: 'frontier' } }));
  const id = await apply(r);
  release(r.scenarioDir, 'build1');
  await until(() => journalOf(r).view.unit(U1).status === 'park-pending', WAIT_MS, 'u1 to park');
  assert.equal(receiptOf(r, id)?.state, 'applied');
  const u = journalOf(r).view.unit(U1);
  assert.deepEqual([u.decided?.stage, u.decided?.outcome], ['gate', 'routing-changed']);
  assert.deepEqual(outcomes(r).slice(0, 7), STRAIGHT.slice(0, 7), 'the build\'s chain and lanes ran; the gate dispatch parked');
  await until(async () => (await statusOf(r)).needsUser.some((n) => n.reason === 'routing-changed'), WAIT_MS, 'the routing-changed needs-user');
  assert.deepEqual(kills(r), []);
  await cli(r, ['stop']);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(reasonOf(exit).kind, 'stop');
});

test('apply.exec-resume-at-boundary: a pause and a resume of an idle unit (u2, after u1) apply while another unit builds: their scope is u2 alone (A12), not a boundary of u1', T, async (t) => {
  const r = setupExec(t, {
    units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }],
    steps: [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1'), gateStep({ decision: 'approve' }),
      planCheckStep({ decision: 'approve' }), mulBuild({ 'src/extra.js': 'export const extra = 1;\n' }), gateStep({ decision: 'approve' }),
    ],
  });
  const run = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  await cli(r, ['pause', 'u2']);
  await until(() => journalOf(r).view.control().pausedUnits.includes(unitId('u2')), WAIT_MS, 'u2 paused');
  await cli(r, ['resume', 'u2']);
  await until(() => journalOf(r).events.some((e) => e.type === 'fact' && e.fact.kind === 'resumed'), WAIT_MS, 'u2 resumed, u1 still building');
  release(r.scenarioDir, 'build1');
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });
  const resumed = seqOf(r, (f) => f.kind === 'resumed');
  assert.ok(resumed < outcomeSeq(r, 'u1', 'build'), 'the resume applied while u1\'s build ran');
  assert.deepEqual(kills(r), [], 'the pause of u2 killed nothing of u1');
});

test('apply.exec-respawn-ignores-unapplied-edit: after an executor crash the respawn runs the plan in force, not a plan.json edited meanwhile (dropping the building unit); a start of that edit is refused', T, async (t) => {
  const r = setupExec(t, {
    steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1'), ...SMOKE_DEFAULT, gateStep({ decision: 'approve' })],
  });
  const run = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  // The edit a crash-restart used to load: u1 (open intents, mid-build) gone, u9 in its place.
  addUnit(r, 'u9');
  editPlan(r, (p) => void p.units.shift());
  process.kill(executorPid(r), 'SIGKILL');
  await until(() => journalOf(r).events.filter((e) => e.type === 'fact' && e.fact.kind === 'executor-started').length === 2, WAIT_MS, 'the respawn');
  release(r.scenarioDir, 'build1');
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.deepEqual(outcomes(r), STRAIGHT);
  assert.deepEqual(journalOf(r).view.plannedUnits(), ['u1'], 'the edit was never applied');
  assert.deepEqual(outcomes(r, 'u9'), []);

  const again = await startExec(r).exit;
  assert.equal(again.code, 78, again.stderr);
  const reason = reasonOf(again);
  assert.ok(reason.kind === 'refused');
  assert.deepEqual(reason.rejections, [{
    kind: 'plan-change-refused',
    // An M2 arc (a DAG) keeps only the started units' relative order (G3), which dropping u1 leaves intact.
    reasons: ['unit u1 has started; it cannot be removed'],
  }]);
});

for (const cell of crashCells(PLAN_START)) {
  test(`apply.exec-start-crash ${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async (t) => {
    const straight: Scenario = {
      arc: () => ({}),
      steps: () => [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
      hooks: () => [],
    };
    const laid = layout(t, straight);
    const { r } = laid;
    await supervisedRun(laid);
    assert.deepEqual(finalReason(r), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });

    // Stopped (complete), edited, started again: the start's first executor dies before its revision's fact.
    addUnit(r, 'u2');
    appendSteps(r, [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/extra.js': 'export const extra = 1;\n' }), gateStep({ decision: 'approve' })]);
    const trigger = writeTrigger(tmpDir('start-crash'), { label: cell.label, occurrence: 1 });
    await supervisedRun(laid, { trigger });
    assertFired(trigger);
    assert.equal(stateOf(r).crashes.length, 1, 'one executor crash, which the supervisor restarted');
    assert.deepEqual(finalReason(r), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] }, 'the edit was not dropped');
    const revisions = events(r).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [[e.fact.rev, e.fact.command, e.fact.changes]] : []));
    assert.deepEqual(revisions, [[1, null, []], [2, null, [{ type: 'unit-added', unit: 'u2' }]]], 'the revision recorded once');
    assert.deepEqual(outcomes(r, 'u2'), STRAIGHT);
  });
}
