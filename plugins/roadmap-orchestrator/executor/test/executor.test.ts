// The executor process (src/executor.ts) through the real CLI as child processes, fake-backed: startup, the
// command loop, pause/stop/resume, needs-user waits, a crash and restart, and the startup refusals that
// `status` explains. Named tests: executor.start-to-complete, executor.refused-writes-rejection,
// executor.pause-holds-then-resume, executor.stop-releases-lock, executor.restart-clears-stop-not-pause,
// executor.blocking-needs-user-waits, executor.crash-restart-continues, startup.resource-command-unrunnable.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { sha } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { EXIT_REASON_FILE, REJECTION_FILE } from '../src/executor.ts';
import { snapshotRef, verifySnapshot } from '../src/git/snapshot.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { reached, release } from './helpers/barrier.ts';
import { git } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { MUL, U1, codexStep, gateStep, mulBuild, outcomes } from './fixtures/unit-common.ts';
import {
  EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, cli, hostFile, hostLockHeld, journalOf, reasonOf, setupExec, startExec, statusOf, until,
} from './fixtures/exec-common.ts';

const T = { timeout: EXEC_TIMEOUT_MS };
const WAIT_MS = 60_000;
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

test('executor.start-to-complete: roadmap start runs one unit to complete; main is the ff merge, the snapshot ref verifies, exit.reason.json says complete', T, async () => {
  const r = setupExec({ steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
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

test('executor.refused-writes-rejection: a 0.x .roadmap/ layout is refused with exit 78, and status explains it', T, async () => {
  const r = setupExec({ steps: [] });
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

test('startup.resource-command-unrunnable: a probe or teardown command that cannot run refuses start (resource variant of spec-lane-unrunnable)', T, async () => {
  const r = setupExec({ steps: [] });
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

test('executor.pause-holds-then-resume: a pause mid-build interrupts it (held, uncharged); resume re-runs the build as a new attempt and the unit completes', T, async () => {
  const r = setupExec({ steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1', false), mulBuild(), gateStep({ decision: 'approve' })] });
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

test('executor.stop-releases-lock: a stop mid-build cancels it, cleans its resources, releases the host and exits stop', T, async () => {
  const r = setupExec({ resource: true, steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1', false)] });
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
  assert.deepEqual([...resourceTable(view)].map(([name, e]) => [name, e.status.state]), [['db', 'free']], 'the build\'s resource is released');
  const toolCalls = readFileSync(join(r.stateDir, 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(toolCalls.map((l) => l.split(' ').slice(0, 2).join(' ')), ['probe db', 'teardown db'], 'probed before the build, torn down after the cancel');
  const s = await statusOf(r);
  assert.equal(s.run.owner.state, 'none');
  assert.equal(s.run.state, 'no-owner');
});

test('executor.restart-clears-stop-not-pause: a restart after pause and stop clears the stop, keeps the pause (it waits), and resume lets it finish', T, async () => {
  const blockedCheck = planCheckStep({ decision: 'approve' });
  const r = setupExec({
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

test('executor.blocking-needs-user-waits: a parked unit\'s blocking needs-user keeps the executor in its loop; ack lets it finish with the terminal summary', T, async () => {
  const r = setupExec({ steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' })] });
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

test('executor.crash-restart-continues: SIGKILL mid-build; the restart adopts or reconciles the build, the unit completes and publishes once', T, async () => {
  const r = setupExec({
    steps: [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), blockedBuild('build1', true),
      ...SMOKE_DEFAULT, codexStep([], { argv: ['exec', '-C'] }), gateStep({ decision: 'approve' }),
    ],
  });
  const base = git(r.repo, 'rev-parse', 'main');
  const first = startExec(r);
  await reached(r.scenarioDir, 'build1', WAIT_MS);
  first.child.kill('SIGKILL');
  const killed = await first.exit;
  assert.equal(killed.signal, 'SIGKILL');
  assert.ok(hostLockHeld(r), 'a crash leaves the claim for takeover');
  assert.ok(!existsSync(hostFile(r, EXIT_REASON_FILE)), 'a crash writes no exit reason');

  const second = startExec(r);
  await until(() => started(r).length === 2, WAIT_MS, 'the restart');
  release(r.scenarioDir, 'build1');
  const exit = await second.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });

  const { view, events } = journalOf(r);
  const builds = view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  assert.equal(builds.length, 2, 'the crashed build and the re-run of its stage');
  const crashed = view.doneOf(builds[0]!.op);
  assert.ok(crashed !== null && crashed.kind === 'proc.spawn' && crashed.outcome.kind === 'result', `the crashed build closed with its result: ${JSON.stringify(crashed)}`);
  assert.ok(crashed.recoveredBy === 'adopted' || crashed.recoveredBy === 'reconciled' || crashed.recoveredBy === 'redone', `recovered, not live: ${crashed.recoveredBy}`);
  assert.deepEqual(outcomes(r), STRAIGHT, 'the crashed attempt left no outcome; the stage re-ran once');
  const u = view.unit(U1);
  assert.equal(u.counters.chargeableFailures, 0);
  assert.equal(u.counters.attempts, STRAIGHT.length + 2, 'every stage once, the crashed build attempt, and retire');

  const ff = view.opsOf('integration.ff');
  assert.equal(ff.length, 1, 'published exactly once');
  const published = events.filter((e) => e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published');
  assert.equal(published.length, 1);
  assert.deepEqual(parentsOf(r.repo, git(r.repo, 'rev-parse', 'main')), [base, git(r.repo, 'rev-parse', `refs/heads/roadmap/${r.arc}/u1`)]);
  // Smokes are metered with no unit; the unit's build invocations each have exactly one fact.
  const usage = facts(r).filter((f) => (f.kind === 'meter' || f.kind === 'usage-unavailable') && f.role === 'build' && f.unit !== null);
  assert.equal(usage.length, 2, 'one usage fact per build invocation, the adopted one included');
  assert.deepEqual(started(r), [1, 2]);
  assert.ok(readCalls(r.scenarioPath).every((c) => c.step !== null));
});
