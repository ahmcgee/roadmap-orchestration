// The executor process (src/executor.ts) through the real CLI as child processes, fake-backed: startup, the
// command loop, pause/stop/resume, needs-user waits, a crash and restart, and the startup refusals that
// `status` explains. Named tests: executor.start-to-complete, executor.refused-writes-rejection,
// executor.pause-holds-then-resume, executor.stop-releases-lock, executor.restart-clears-stop-not-pause,
// executor.blocking-needs-user-waits, executor.crash-restart-continues, startup.resource-command-unrunnable,
// executor.unit-park-does-not-hold-arc, executor.arc-wide-park-holds-arc, executor.park-raised-promptly,
// cli.start-wait-flag, executor.pause-fix-round-continues, executor.paused-unit-never-dispatched.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { arcId, sha, unitId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { EXIT_REASON_FILE, REJECTION_FILE } from '../src/executor.ts';
import { CliError, parseStartArgs } from '../src/input/cli.ts';
import { START_WAIT_MS } from '../src/supervisor.ts';
import { openBlocking, raiseNeedsUser } from '../src/needsuser.ts';
import { snapshotRef, verifySnapshot } from '../src/git/snapshot.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { CONTINUE_DIRECTIVE, NO_SESSION_NOTE } from '../src/pipeline/rounds.ts';
import { reached, release } from './helpers/barrier.ts';
import { runFixture } from './helpers/proc.ts';
import { git } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { MUL, U1, codexStep, gateStep, mulBuild, outcomes } from './fixtures/unit-common.ts';
import {
  EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, cli, execEnv, executorPid, hostFile, hostLockHeld, journalOf, reasonOf, setupExec, startExec, statusOf, until,
} from './fixtures/exec-common.ts';

// Every supervised run a test here started is stopped by its teardown; nothing of them outlives the file.
after(assertNoSurvivors);

const T = { timeout: EXEC_TIMEOUT_MS };
const WAIT_MS = 60_000;
const U2 = unitId('u2');
const STRAIGHT = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];
const AFTER_BUILD = STRAIGHT.slice(1);

const parentsOf = (repo: string, commit: string): readonly string[] => git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
const facts = (r: ExecRun): readonly Fact[] => journalOf(r).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const started = (r: ExecRun): readonly number[] => facts(r).flatMap((f) => (f.kind === 'executor-started' ? [f.generation] : []));
const has = (r: ExecRun, outcome: string): boolean => outcomes(r).includes(outcome);
const killsOf = (r: ExecRun) => journalOf(r).view.opsOf('proc.kill').map((k) => k.expect.reason);

/** A build that commits mul, then parks at barrier `name` until released or killed. */
function blockedBuild(name: string, commit: boolean): Step {
  return codexStep([
    ...(commit ? [{ type: 'commit', message: 'add mul', files: MUL } as const] : []),
    { type: 'barrier', name, timeoutMs: 120_000 },
  ], { argv: ['exec', '-C'] });
}

test('executor.start-to-complete: roadmap start runs one unit to complete; main is the ff merge, the snapshot ref verifies, exit.reason.json says complete', T, async (t) => {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const base = git(r.repo, 'rev-parse', 'main');
  const exit = await startExec(r).exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.deepEqual(outcomes(r), STRAIGHT);

  const head = git(r.repo, 'rev-parse', 'main');
  const unitCommit = git(r.repo, 'rev-parse', `refs/heads/roadmap/${r.arc}/u1`);
  assert.deepEqual(parentsOf(r.repo, head), [base, unitCommit], 'main is the candidate: first parent the old tip, second the unit');
  assert.match(git(r.repo, 'log', '--format=%s', '-n', '1', 'main'), /u1/);
  const snap = verifySnapshot(absPath(r.repo), sha(git(r.repo, 'rev-parse', snapshotRef(r.arc as never))));
  assert.equal(snap.kind, 'verified', JSON.stringify(snap));

  const reason = JSON.parse(readFileSync(hostFile(r, EXIT_REASON_FILE), 'utf8')) as { reason: string; generation: number };
  assert.equal(reason.reason, 'complete');
  assert.equal(reason.generation, 1);
  assert.ok(!hostLockHeld(r), 'the host lock is released');
  assert.deepEqual(started(r), [1]);
  assert.ok(readCalls(r.scenarioPath).every((c) => c.step !== null), 'every backend call matched its step');
  assert.equal((await statusOf(r)).run.state, 'complete');
});

test('executor.refused-writes-rejection: a 0.x .roadmap/ layout is refused with exit 78, and status explains it', T, async (t) => {
  const r = setupExec(t, { steps: [] });
  mkdirSync(join(r.repo, '.roadmap'), { recursive: true });
  writeFileSync(join(r.repo, '.roadmap', 'state.json'), '{}\n');
  const exit = await startExec(r).exit;
  assert.equal(exit.code, 78, exit.stderr);
  const reason = reasonOf(exit);
  assert.ok(reason.kind === 'refused');
  assert.deepEqual(reason.rejections.map((x) => x.kind), ['legacy-roadmap-dir']);
  assert.ok(existsSync(join(r.runDir, REJECTION_FILE)), 'the rejection is in the run dir');
  assert.ok(!hostLockHeld(r), 'refused before the host claim');
  const s = await statusOf(r);
  assert.equal(s.run.state, 'refused');
  assert.deepEqual(s.rejection?.rejections, [{ kind: 'legacy-roadmap-dir', path: join(r.repo, '.roadmap'), unexpected: ['state.json'] }]);
  assert.equal(readCalls(r.scenarioPath).length, 0, 'no backend was called');
});

test('startup.resource-command-unrunnable: a probe or teardown command that cannot run refuses start (resource variant of spec-lane-unrunnable)', T, async (t) => {
  const r = setupExec(t, { steps: [] });
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as Record<string, unknown>;
  plan['resources'] = [{
    name: 'db',
    probe: { argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH', 'ROADMAP_TEST_NEVER_SET'] } },
    teardown: { argv: ['no-such-teardown-tool'], cwd: '.', env: { set: {}, pass: ['PATH'] } },
  }];
  writeFileSync(r.planPath, JSON.stringify(plan));
  const exit = await startExec(r).exit;
  assert.equal(exit.code, 78, exit.stderr);
  const reason = reasonOf(exit);
  assert.ok(reason.kind === 'refused');
  assert.deepEqual(reason.rejections, [
    { kind: 'spec-lane-unrunnable', resource: 'db', command: 'probe', problem: { type: 'env-missing', name: 'ROADMAP_TEST_NEVER_SET' } },
    { kind: 'spec-lane-unrunnable', resource: 'db', command: 'teardown', problem: { type: 'argv0-unresolvable', argv0: 'no-such-teardown-tool' } },
  ]);
  assert.deepEqual((await statusOf(r)).rejection?.rejections, reason.rejections, 'status reads the same rows back');
});

test('executor.pause-holds-then-resume: a pause mid-build interrupts it (held, uncharged); resume re-runs the build as a new attempt and the unit completes', T, async (t) => {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1', false), mulBuild(), gateStep({ decision: 'approve' })] });
  const run = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  await cli(r, ['pause', 'u1']);
  await until(() => has(r, 'build:interrupted'), WAIT_MS, 'the build to be interrupted');
  const held = journalOf(r).view.unit(U1);
  assert.equal(held.status, 'held');
  assert.equal(held.counters.chargeableFailures, 0);
  assert.deepEqual(killsOf(r), ['pause'], 'the build was cancelled by proc.kill{pause}');
  // The executor waits in its command loop, alive and holding the host.
  await sleep(2_500);
  assert.equal(run.child.exitCode, null, 'the executor is still running');
  assert.ok(hostLockHeld(r));
  const s = await statusOf(r);
  assert.equal(s.run.state, 'held');
  assert.equal(s.run.owner.state, 'alive');
  assert.equal(readCalls(r.scenarioPath).length, 4, 'nothing dispatched while paused');

  await cli(r, ['resume', 'u1']);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.deepEqual(outcomes(r), ['plan-check:approve', 'build:interrupted', ...AFTER_BUILD]);
  const builds = journalOf(r).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.stage === 'build' ? [e.fact.attempt] : []));
  assert.equal(builds.length, 2);
  assert.notEqual(builds[0], builds[1], 'the resumed build is a new attempt');
  assert.equal(journalOf(r).view.unit(U1).counters.chargeableFailures, 0, 'the interruption charged nothing');
});

test('executor.stop-releases-lock: a stop mid-build cancels it, cleans its resources, releases the host and exits stop', T, async (t) => {
  const r = setupExec(t, { resource: true, steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1', false)] });
  const run = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  assert.equal(journalOf(r).view.unit(U1).stage, 'build');
  await cli(r, ['stop']);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'stop', cause: 'command', needsUser: null });
  assert.ok(!hostLockHeld(r), 'the host lock is released');
  assert.equal((JSON.parse(readFileSync(hostFile(r, EXIT_REASON_FILE), 'utf8')) as { reason: string }).reason, 'stop');
  assert.equal(outcomes(r).at(-1), 'build:interrupted');
  assert.deepEqual(killsOf(r), ['stop']);
  const { view } = journalOf(r);
  assert.deepEqual(view.openIntents(), [], 'nothing left open');
  // An M2 arc's build also holds `@cpu` tokens (A3), released with it.
  const table = [...resourceTable(view)].map(([name, e]) => [name, e.status.state]);
  assert.deepEqual(table.filter(([name]) => !name!.startsWith('@cpu#')), [['db', 'free']], 'the build\'s resource is released');
  assert.ok(table.every(([, state]) => state === 'free'), JSON.stringify(table));
  const toolCalls = readFileSync(join(r.stateDir, 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(toolCalls.map((l) => l.split(' ').slice(0, 2).join(' ')), ['probe db', 'teardown db'], 'probed before the build, torn down after the cancel');
  const s = await statusOf(r);
  assert.equal(s.run.owner.state, 'none');
  assert.equal(s.run.state, 'no-owner');
});

test('executor.restart-clears-stop-not-pause: a restart after pause and stop clears the stop, keeps the pause (it waits), and resume lets it finish', T, async (t) => {
  const blockedCheck = planCheckStep({ decision: 'approve' });
  const r = setupExec(t, {
    steps: [
      ...SMOKE_DEFAULT, { ...blockedCheck, acts: [{ type: 'barrier', name: 'check1', timeoutMs: 120_000 }, ...blockedCheck.acts] } as Step,
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
    ],
  });
  const first = startExec(r);
  await reached(r.scenarioDir, 'check1', WAIT_MS);
  await cli(r, ['pause', '--all']);
  await until(() => has(r, 'plan-check:interrupted'), WAIT_MS, 'the plan-check to be interrupted');
  await cli(r, ['stop']);
  const stopped = await first.exit;
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(reasonOf(stopped).kind, 'stop');
  const ended = journalOf(r).view.control();
  assert.ok(ended.stop !== null && ended.pausedAll, 'the stop and pause markers are both set when the first run ends');

  const second = startExec(r);
  await until(() => started(r).length === 2, WAIT_MS, 'the second start');
  // The smoke runs after executor-started and recovery (lead ruling 14c): wait for it, then for anything more.
  await until(() => readCalls(r.scenarioPath).length === 5, WAIT_MS, 'the second smoke');
  await sleep(2_500);
  const c = journalOf(r).view.control();
  assert.deepEqual([c.stop, c.pausedAll], [null, true], 'the restart cleared the stop and kept the pause');
  assert.equal(second.child.exitCode, null, 'the executor waits instead of exiting');
  assert.equal(readCalls(r.scenarioPath).length, 5, 'only the second smoke ran: nothing dispatched while paused');
  assert.equal((await statusOf(r)).run.state, 'held');

  await cli(r, ['resume']);
  const exit = await second.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.deepEqual(outcomes(r), ['plan-check:interrupted', ...STRAIGHT]);
  assert.deepEqual(started(r), [1, 2]);
});

test('executor.blocking-needs-user-waits: a parked unit\'s blocking needs-user keeps the executor in its loop; ack lets it finish with the terminal summary', T, async (t) => {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' })] });
  const run = startExec(r);
  let id = '';
  await until(async () => {
    const s = await statusOf(r);
    id = s.needsUser[0]?.id ?? '';
    return s.run.state === 'parked';
  }, WAIT_MS, 'the arc to wait on its needs-user');
  const s = await statusOf(r);
  assert.deepEqual(s.needsUser, [{ id, reason: 'escalation', blocking: true }]);
  assert.equal(run.child.exitCode, null, 'the executor waits');
  const raise = journalOf(r).view.opsOf('needsuser.raise');
  assert.equal(raise.length, 1, 'raised once, though the loop re-reads the arc every poll');
  assert.deepEqual(raise[0]!.parent, { type: 'stage', unit: 'u1', stage: 'plan-check', attempt: 2 }, 'parented by the attempt that parked the unit');

  await cli(r, ['ack', id]);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'parked', needsUser: id }] });
  assert.equal(journalOf(r).view.opsOf('needsuser.raise').length, 1);
  assert.equal((await statusOf(r)).run.state, 'complete');
});

test('executor.crash-restart-continues: SIGKILL of the executor mid-build; the supervisor restarts it, which adopts or settles the build and consumes it (never re-run); the unit completes and publishes once', T, async (t) => {
  const r = setupExec(t, {
    steps: [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1', true),
      ...SMOKE_DEFAULT, gateStep({ decision: 'approve' }),
    ],
  });
  const base = git(r.repo, 'rev-parse', 'main');
  const run = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  process.kill(executorPid(r), 'SIGKILL');
  await until(() => started(r).length === 2, WAIT_MS, 'the supervisor\'s restart');
  assert.ok(hostLockHeld(r), 'the supervisor keeps the claim across the crash');
  assert.ok(!existsSync(hostFile(r, EXIT_REASON_FILE)), 'the crash wrote no exit reason');
  release(r.scenarioDir, 'build1');
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });

  const { view, events } = journalOf(r);
  const builds = view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  assert.equal(builds.length, 1, 'the crashed build is the only build: its result was consumed, not re-dispatched');
  const crashed = view.doneOf(builds[0]!.op);
  assert.ok(crashed !== null && crashed.kind === 'proc.spawn' && crashed.outcome.kind === 'result', `the crashed build closed with its result: ${JSON.stringify(crashed)}`);
  assert.ok(crashed.recoveredBy === 'adopted' || crashed.recoveredBy === 'reconciled' || crashed.recoveredBy === 'redone', `recovered, not live: ${crashed.recoveredBy}`);
  assert.deepEqual(outcomes(r), STRAIGHT, 'the crashed attempt\'s outcome was recorded from its result; every stage once');
  const parent = builds[0]!.parent;
  assert.ok(parent.type === 'stage');
  const buildOutcome = facts(r).find((f) => f.kind === 'stage-outcome' && f.stage === 'build');
  assert.ok(buildOutcome?.kind === 'stage-outcome' && buildOutcome.attempt === parent.attempt, 'recorded at the crashed attempt');
  const u = view.unit(U1);
  assert.equal(u.counters.chargeableFailures, 0);
  assert.equal(u.counters.attempts, STRAIGHT.length + 1, 'every stage once, and retire');
  assert.equal(readCalls(r.scenarioPath).filter((c) => c.as === 'codex').length, 3, 'two smokes and one build: the backend built once');

  const ff = view.opsOf('integration.ff');
  assert.equal(ff.length, 1, 'published exactly once');
  const published = events.filter((e) => e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published');
  assert.equal(published.length, 1);
  assert.deepEqual(parentsOf(r.repo, git(r.repo, 'rev-parse', 'main')), [base, git(r.repo, 'rev-parse', `refs/heads/roadmap/${r.arc}/u1`)]);
  // Smokes are charged to their backend, not a seat; the build invocation has exactly one fact.
  const usage = facts(r).filter((f) => (f.kind === 'meter' || f.kind === 'usage-unavailable') && f.subject.type === 'seat' && f.subject.role === 'build');
  assert.equal(usage.length, 1, 'one usage fact for the adopted build');
  assert.deepEqual(started(r), [1, 2]);
  assert.ok(readCalls(r.scenarioPath).every((c) => c.step !== null));
});

test('executor.park-raised-promptly: a unit that parks has its needs-user raised while another unit runs, not when the arc returns; status says running', T, async (t) => {
  const check = planCheckStep({ decision: 'approve' });
  // u1 and u2 are independent, so they run at once (an M2 arc schedules a DAG): each unit's calls take its own steps.
  const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
  const r = setupExec(t, {
    units: [{ id: 'u1' }, { id: 'u2' }],
    steps: [
      ...SMOKE_DEFAULT, ...of('u1', [planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' })]),
      ...of('u2', [{ ...check, acts: [{ type: 'barrier', name: 'u2check', timeoutMs: 120_000 }, ...check.acts] } as Step, mulBuild(), gateStep({ decision: 'approve' })]),
    ],
  });
  const run = startExec(r);
  await reached(r.scenarioDir, 'u2check', WAIT_MS);
  await until(() => openBlocking(journalOf(r).view).length === 1, WAIT_MS, 'u1 to park, u2 still at its plan-check');
  const view = journalOf(r).view;
  const [item] = openBlocking(view);
  assert.ok(item !== undefined, 'u1\'s needs-user is raised while u2\'s plan-check is in flight');
  const raise = view.opsOf('needsuser.raise');
  assert.equal(raise.length, 1);
  assert.deepEqual(raise[0]!.parent, { type: 'stage', unit: 'u1', stage: 'plan-check', attempt: 2 });
  assert.deepEqual(view.unit(U2).decided, null, 'u2 has decided nothing yet');
  const s = await statusOf(r);
  assert.equal(s.run.state, 'running', 'a unit-scoped park with a later unit running is running, not parked');
  assert.deepEqual(s.needsUser, [{ id: item, reason: 'escalation', blocking: true }]);

  release(r.scenarioDir, 'u2check');
  await until(() => journalOf(r).view.unit(U2).status === 'retired', WAIT_MS, 'u2 to merge');
  assert.equal(journalOf(r).view.opsOf('needsuser.raise').length, 1, 'raised once, not again when the arc returned');
  await cli(r, ['ack', item]);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'parked', needsUser: item }, { unit: 'u2', result: 'merged' }] });
});

test('cli.start-wait-flag: start waits 240 s for readiness by default; --wait overrides it, and a start that stops waiting leaves the run going', T, async (t) => {
  assert.equal(START_WAIT_MS, 240_000, 'past the smoke\'s 180 s deadline');
  assert.equal(parseStartArgs(['--repo', '.', '--plan', 'p', '--wait', '5000']).waitMs, 5000);
  assert.equal(parseStartArgs(['--repo', '.', '--plan', 'p']).waitMs, null);
  for (const bad of ['0', '-5', '1.5', 'soon', '']) assert.throws(() => parseStartArgs(['--repo', '.', '--plan', 'p', '--wait', bad]), CliError, bad);

  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const exit = await runFixture('exec-cli.ts', [r.hostDir, 'start', '--repo', r.repo, '--plan', r.planPath, '--wait', '1'], { env: execEnv(r), timeoutMs: 30_000 });
  assert.equal(exit.code, 70, exit.stdout + exit.stderr);
  const line = JSON.parse(exit.stdout.trim()) as { kind: string; waitedMs: number };
  assert.deepEqual([line.kind, line.waitedMs], ['timeout', 1]);
  await until(() => existsSync(hostFile(r, EXIT_REASON_FILE)) && !hostLockHeld(r), WAIT_MS, 'the run to end on its own');
  assert.equal((JSON.parse(readFileSync(hostFile(r, EXIT_REASON_FILE), 'utf8')) as { reason: string }).reason, 'complete');
  assert.equal((await statusOf(r)).run.state, 'complete');
});

test('executor.unit-park-does-not-hold-arc, executor.paused-unit-never-dispatched: with u1 parked on an open blocking unit-scoped needs-user, the arc waits at paused u2 without dispatching it; resumed, u2 runs; the run completes once the item is acknowledged', T, async (t) => {
  const escalate = planCheckStep({ decision: 'escalate' });
  const r = setupExec(t, {
    units: [{ id: 'u1' }, { id: 'u2' }],
    steps: [
      ...SMOKE_DEFAULT, { ...escalate, acts: [{ type: 'barrier', name: 'u1check', timeoutMs: 120_000 }, ...escalate.acts] } as Step, escalate,
      planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
    ],
  });
  // u2 is paused from the start: once u1 has parked the arc reaches u2 and waits at it, with u1's item raised
  // and open. Resuming u2 must dispatch it with that item still open.
  mkdirSync(r.runDir, { recursive: true });
  await cli(r, ['pause', 'u2']);
  const run = startExec(r);
  await reached(r.scenarioDir, 'u1check', WAIT_MS);
  assert.equal((await statusOf(r)).run.state, 'running', 'u1 is in flight: a pause of another unit does not hold the run (arc-1 feedback item 24b)');
  release(r.scenarioDir, 'u1check');
  await until(() => existsSync(join(r.runDir, 'events.jsonl')) && openBlocking(journalOf(r).view).length === 1, WAIT_MS, 'u1 parked');
  const [item] = openBlocking(journalOf(r).view);
  assert.ok(item !== undefined);
  assert.equal(journalOf(r).view.unit(U1).status, 'park-pending');
  await sleep(2_500);
  // A paused unit is never dispatched: no dispatch fact pinned, no stage started, no backend called (arc-1 feedback item 16).
  const view = journalOf(r).view;
  assert.equal(view.dispatchOf(U2), null, 'no dispatch fact for the paused unit');
  assert.deepEqual(outcomes(r, 'u2'), []);
  assert.equal(view.unit(U2).counters.attempts, 0, 'no stage of u2 started');
  assert.equal(readCalls(r.scenarioPath).length, 4, 'the two smoke calls and u1\'s two plan-checks only');
  const s = await statusOf(r);
  assert.equal(s.run.state, 'held', 'nothing can proceed: the next unit is paused');
  await cli(r, ['resume', 'u2']);
  await until(() => journalOf(r).view.unit(U2).status === 'retired', WAIT_MS, 'u2 to merge');
  assert.equal(journalOf(r).view.ackOf(item), null, 'u2 ran and merged while u1\'s blocking item was open');
  await sleep(1_500);
  assert.equal(run.child.exitCode, null, 'the executor waits on u1\'s item');
  assert.equal((await statusOf(r)).run.state, 'parked');

  await cli(r, ['ack', item]);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'parked', needsUser: item }, { unit: 'u2', result: 'merged' }] });
  assert.deepEqual(outcomes(r, 'u2'), STRAIGHT);
});

test('executor.arc-wide-park-holds-arc: an open arc-wide needs-user (recovery-required, naming u2) holds u1 too; its ack lets both run', T, async (t) => {
  const r = setupExec(t, {
    units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }],
    steps: [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
      planCheckStep({ decision: 'approve' }), mulBuild({ 'src/two.js': 'export const two = 2;\n' }), gateStep({ decision: 'approve' }),
    ],
  });
  mkdirSync(r.runDir, { recursive: true });
  const journal = openJournal(absPath(r.runDir), arcId(r.arc));
  const item = raiseNeedsUser(journal, absPath(r.runDir), {
    blocking: true, subject: { type: 'unit', unit: U2 }, reason: 'recovery-required', summary: 'seeded', recommendation: 'ack it', options: [], evidence: [],
  }, { type: 'arc' });
  journal.close();

  const run = startExec(r);
  await until(() => started(r).length === 1, WAIT_MS, 'the executor to start');
  // The smoke runs after executor-started and recovery (lead ruling 14c): wait for it, then for anything more.
  await until(() => readCalls(r.scenarioPath).length === 2, WAIT_MS, 'the smoke');
  await sleep(3_000);
  assert.equal(readCalls(r.scenarioPath).length, 2, 'only the smoke ran: u1 is held by the arc-wide item that names u2');
  assert.equal(run.child.exitCode, null);
  assert.deepEqual(outcomes(r, 'u1'), []);

  await cli(r, ['ack', item]);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });
});

test('executor.pause-fix-round-continues: a pause while a fix round is live (its tree dirtied) holds the unit; resume continues that round in the dirty worktree and the unit completes', T, async (t) => {
  const thread = '00000000-0000-4000-8000-00000000f1f1';
  const broken = { ...MUL, 'src/mul.js': 'export function mul(a, b) {\n  return a + b;\n}\n' };
  const r = setupExec(t, {
    steps: [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }),
      { ...codexStep([{ type: 'commit', message: 'add mul', files: broken }], { argv: ['exec', '-C'] }), threadId: thread } as Step,
      codexStep([{ type: 'dirty', files: { 'src/mul.js': MUL['src/mul.js'] } }, { type: 'barrier', name: 'fix1', timeoutMs: 120_000 }], { argv: ['exec', 'resume', thread] }),
      codexStep([], { argv: ['exec', 'resume', thread], stdinContains: [CONTINUE_DIRECTIVE] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const run = startExec(r);
  await reached(r.scenarioDir, 'fix1', WAIT_MS);
  await cli(r, ['pause', 'u1']);
  await until(() => has(r, 'build:interrupted'), WAIT_MS, 'the fix round to be interrupted');
  await cli(r, ['resume', 'u1']);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.deepEqual(started(r), [1], 'the executor never crashed');
  assert.deepEqual(outcomes(r), [...STRAIGHT.slice(0, 6), 'lanes:red', 'build:interrupted', ...AFTER_BUILD]);
  const continued = readCalls(r.scenarioPath).filter((c) => c.stdin.includes(CONTINUE_DIRECTIVE));
  assert.equal(continued.length, 1);
  assert.ok(!continued[0]!.stdin.includes(NO_SESSION_NOTE), 'the continued session is not told it is fresh');
  // The continue only reported: the fix it made before the pause, left uncommitted, is what merged.
  assert.equal(git(r.repo, 'show', 'main:src/mul.js') + '\n', MUL['src/mul.js']);
  assert.equal(journalOf(r).view.unit(U1).counters.chargeableFailures, 1, 'the red series alone charged');
});
