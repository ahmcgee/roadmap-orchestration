// The serial unit driver (src/pipeline/unit.ts) and arc (src/pipeline/arc.ts), integrated and fake-backed:
// real processes through the runner, real git, the fake codex and claude behind PATH shims. Includes the
// deterministic fixtures of this step (conflict → merge-in → resolve; red candidate → fix → fresh gate →
// green) and the named tests ff.exact-head, snapshot.after-publish, unit.decisions-appended,
// unit.reentrant, arc.serial-terminal, codex.resume-collision-retry, continue.claude-session,
// continue.codex-thread-chain, continue.no-session-fresh.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { invocationId } from '../src/core/ids.ts';
import { EVENTS_FILE, STATE_FILE } from '../src/core/log.ts';
import { snapshotRef, verifySnapshot } from '../src/git/snapshot.ts';
import { runArc } from '../src/pipeline/arc.ts';
import { unitBranch } from '../src/pipeline/dispatch.ts';
import { latestCandidate } from '../src/pipeline/integrate.ts';
import { killWorkload } from '../src/pipeline/invoke.ts';
import { CONTINUE_DIRECTIVE, NO_SESSION_NOTE, RESOLVE_DIRECTIVE } from '../src/pipeline/rounds.ts';
import { type UnitResult, runUnit } from '../src/pipeline/unit.ts';
import { MODEL_IDS } from '../src/routing/types.ts';
import { reached, release } from './helpers/barrier.ts';
import { writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { events, intents } from './fixtures/invoke-specs.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import {
  ADD_BROKEN, ADD_FIXED, type ArcRun, MUL, U1, appendSteps, codexStep, isGateCall, contextFor, gateStep, literal, mulBuild, outcomes, setupArc, stepUntil,
  unitWorktreePath, workDirPattern,
} from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const live = (): AbortSignal => new AbortController().signal;

/** Every stage of a unit that merges first time, in order. */
const STRAIGHT = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

const parentsOf = (repo: string, commit: string): readonly string[] => git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
const gateCalls = (r: ArcRun) => readCalls(r.d.scenarioPath).filter(isGateCall);

describe('unit: one unit merged first time', () => {
  let r: ArcRun;
  let result: UnitResult;
  before(async () => {
    const d = setupArc({ steps: [] });
    const decisions = JSON.stringify({ decisions: [{ id: 'D1', text: 'mul multiplies with the * operator.' }] });
    appendSteps(d, [
      planCheckStep({ decision: 'approve' }),
      mulBuild({}, [{ type: 'writeToPrompt', pattern: workDirPattern(d), file: 'decisions.json', text: decisions }]),
      gateStep({ decision: 'approve' }, { stdinContains: ['mul multiplies with the * operator.', 'src/mul.js'] }),
    ]);
    r = contextFor(d);
    result = await runUnit(r.ctx, r.unit('u1'), live());
  }, T);
  after(() => r.journal.close());

  test('the driver runs every stage once and merges', () => {
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(r.d), STRAIGHT);
    const calls = readCalls(r.d.scenarioPath);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.step !== null), `every call matched: ${calls.map((c) => c.step).join(',')}`);
  });

  test('ff.exact-head: integration head is the tested candidate, its first parent T and its second the approved unit commit', () => {
    const cand = latestCandidate(r.ctx, U1);
    const head = git(r.d.repo, 'rev-parse', 'main');
    assert.equal(head, cand.post.new, 'the published head is the candidate the suite tested');
    const approval = r.journal.view.unit(U1).approval;
    assert.ok(approval !== null);
    assert.deepEqual(parentsOf(r.d.repo, head), [cand.expect.integrationTip, approval.fingerprint.unitCommit]);
    assert.equal(approval.fingerprint.unitCommit, git(r.d.repo, 'rev-parse', unitBranch(r.ctx.plan.arc, U1)), 'the unit branch is kept at the approved commit');
    const ff = intents(r.d.runDir, 'integration.ff');
    assert.equal(ff.length, 1);
    assert.ok(ff[0]!.kind === 'integration.ff');
    assert.deepEqual(ff[0]!.expect.fingerprint, approval.fingerprint, 'the ff intent records the approval fingerprint');
    // The suite ran on exactly that commit.
    const suite = intents(r.d.runDir, 'proc.spawn').filter((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'lane' && i.expect.subject.set === 'suite');
    assert.deepEqual(suite.map((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'lane' && i.expect.subject.at), [head]);
  });

  test('snapshot.after-publish: the ref moved, the tree verifies against its manifest, the high-water mark covers the ff', () => {
    const ref = snapshotRef(r.ctx.plan.arc);
    const at = git(r.d.repo, 'rev-parse', ref);
    const check = verifySnapshot(r.ctx.repo, at as never);
    assert.equal(check.kind, 'verified', JSON.stringify(check));
    assert.ok(check.kind === 'verified');
    const ffDone = events(r.d.runDir).find((e) => e.type === 'done' && e.kind === 'integration.ff');
    assert.ok(ffDone !== undefined);
    assert.ok(check.manifest.highWater >= ffDone.seq, `high-water ${check.manifest.highWater} < ff done ${ffDone.seq}`);
    assert.equal(r.journal.view.unit(U1).status, 'retired');
  });

  test('unit.decisions-appended: decisions.json reaches the spec by an executor patch, and the approval carries the new rev', () => {
    const spec = JSON.parse(readFileSync(join(r.ctx.planDir, 'u1.json'), 'utf8')) as { rev: number; decisions: readonly { id: string; text: string; state: string }[] };
    assert.equal(spec.rev, 2);
    assert.deepEqual(spec.decisions, [{ id: 'D1', text: 'mul multiplies with the * operator.', state: 'active' }]);
    const patches = intents(r.d.runDir, 'spec.patch');
    assert.equal(patches.length, 1);
    const p = patches[0]!;
    assert.ok(p.kind === 'spec.patch' && p.parent.type === 'stage' && p.parent.stage === 'evidence');
    const build = intents(r.d.runDir, 'proc.spawn').find((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
    assert.ok(build !== undefined);
    assert.deepEqual(p.expect.patch.by, { role: 'executor', inv: invocationId(build.op, 1) });
    assert.equal(r.journal.view.unit(U1).approval?.fingerprint.specRev, 2, 'a decision recorded before the gate is what the gate saw');
  });

  test('retire: every worktree of the unit is removed, citing its evidence; the branch and candidate ref stay', () => {
    assert.ok(!existsSync(unitWorktreePath(r)), 'the unit worktree is gone');
    const listed = git(r.d.repo, 'worktree', 'list', '--porcelain');
    assert.ok(!listed.includes(r.ctx.plan.worktreeRoot), `no worktree of the arc is left: ${listed}`);
    const removals = intents(r.d.runDir, 'worktree.remove');
    const retire = removals.filter((i) => i.parent.type === 'stage' && i.parent.stage === 'retire');
    assert.equal(retire.length, 2, 'the verification checkout and the unit worktree');
    git(r.d.repo, 'rev-parse', '--verify', unitBranch(r.ctx.plan.arc, U1));
    git(r.d.repo, 'rev-parse', '--verify', `refs/roadmap-run/${r.ctx.plan.arc}/candidate/u1`);
  });

  test('the gate read the verification checkout and every evidence dir, and nothing written names a model', () => {
    const [call] = gateCalls(r);
    assert.ok(call !== undefined);
    const addDirs = call.argv.flatMap((a, i) => (a === '--add-dir' ? [call.argv[i + 1]!] : []));
    assert.ok(addDirs.some((a) => a.includes('/evidence/u1/') && a.endsWith('/mul')), `lane evidence among ${addDirs.join(', ')}`);
    assert.ok(addDirs.some((a) => a.endsWith('-evidence/build')), `build evidence among ${addDirs.join(', ')}`);
    assert.ok(call.cwd.includes('u1.verify-'), `the gate reads the verification checkout, not ${call.cwd}`);
    for (const text of [readFileSync(join(r.d.runDir, EVENTS_FILE), 'utf8'), readFileSync(join(r.d.runDir, STATE_FILE), 'utf8')]) {
      for (const model of MODEL_IDS) assert.ok(!text.includes(model), `${model} in the log or state`);
    }
  });
});

test('fixture conflict → merge-in → resolve: T moves under the approved unit, the merge-in leaves MERGE_HEAD, the resolved merge is re-gated and published', T, async () => {
  const unitAdd = 'export function add(a, b) {\n  return a + b; // unit u1\n}\n';
  const tipAdd = 'export function add(a, b) {\n  return b + a; // integration\n}\n';
  const resolved = 'export function add(a, b) {\n  return a + b; // resolved\n}\n';
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild({ 'src/add.js': unitAdd }),
      gateStep({ decision: 'approve' }),
      codexStep([{ type: 'commit', message: 'resolve the merge', files: { 'src/add.js': resolved } }], { argv: ['exec', 'resume'], stdinContains: [RESOLVE_DIRECTIVE] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
    const approved = r.journal.view.unit(U1).approval!.fingerprint.unitCommit;
    writeFileSync(join(d.repo, 'src', 'add.js'), tipAdd);
    git(d.repo, 'commit', '--quiet', '-am', 'integration changes add');
    const tip = git(d.repo, 'rev-parse', 'main');

    await stepUntil(r, 'u1', (f) => f.stage === 'candidate');
    assert.equal(outcomes(d).at(-1), 'candidate:conflict');
    const mergein = intents(d.runDir, 'mergein.prepare');
    assert.equal(mergein.length, 1);
    assert.ok(mergein[0]!.kind === 'mergein.prepare' && mergein[0]!.expect.merge.type === 'conflicted');
    assert.equal(git(unitWorktreePath(r), 'rev-parse', 'MERGE_HEAD'), tip, 'the merge-in left MERGE_HEAD = T for the implementer');
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'a conflict is uncharged');

    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(d), [
      ...STRAIGHT.slice(0, 8), 'candidate:conflict',
      'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve',
      'candidate:green', 'ff:published', 'snapshot:published',
    ]);
    const unitCommit = git(d.repo, 'rev-parse', unitBranch(r.ctx.plan.arc, U1));
    assert.deepEqual(parentsOf(d.repo, unitCommit), [approved, tip], 'the implementer committed the merge [old, T]');
    const head = git(d.repo, 'rev-parse', 'main');
    assert.deepEqual(parentsOf(d.repo, head), [tip, unitCommit], 'published onto T, second parent the resolved unit');
    assert.equal(git(d.repo, 'show', 'main:src/add.js') + '\n', resolved);
    const gates = gateCalls(r);
    assert.equal(gates.length, 2);
    assert.notEqual(gates[0]!.argv[gates[0]!.argv.indexOf('--session-id') + 1], gates[1]!.argv[gates[1]!.argv.indexOf('--session-id') + 1], 'the re-gate is a fresh session');
    // After the merge-in the diff base is T: the second gate's diff does not carry the integration's change.
    assert.ok(gates[1]!.stdin.includes(`<diff base="${tip}" head="${unitCommit}">`), "after the merge-in the diff base is T itself");
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('fixture red candidate → fix → fresh gate → green: the suite is red on the candidate and green at T alone', T, async () => {
  const d = setupArc({ steps: [] });
  const suiteOutput = `(${literal(d.runDir)}\\/evidence\\/u1\\/[0-9]+-candidate\\/candidate\\/suite\\/output\\/files)`;
  appendSteps(d, [
    planCheckStep({ decision: 'approve' }),
    mulBuild({ 'src/add.js': ADD_BROKEN }),
    gateStep({ decision: 'approve' }),
    codexStep([
      { type: 'readFromPrompt', pattern: suiteOutput, file: 'stdout', contains: 'ADD-MARKER' },
      { type: 'commit', message: 'fix add', files: { 'src/add.js': ADD_FIXED } },
    ], { argv: ['exec', 'resume'] }),
    gateStep({ decision: 'approve' }),
  ]);
  const r = contextFor(d);
  try {
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(d), [
      ...STRAIGHT.slice(0, 8), 'candidate:red',
      'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve',
      'candidate:green', 'ff:published', 'snapshot:published',
    ]);
    const u = r.journal.view.unit(U1);
    assert.equal(u.counters.candidateReds, 1);
    assert.equal(u.counters.chargeableFailures, 1);
    // The red candidate tested T alone: two suite series in that attempt, the second at T.
    const suites = intents(d.runDir, 'proc.spawn').filter((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'lane' && i.expect.subject.set === 'suite');
    assert.equal(suites.length, 3, 'candidate, T alone, the second candidate');
    assert.equal(intents(d.runDir, 'candidate.merge').length, 2, 'a new candidate after the fix');
    const gates = gateCalls(r);
    assert.equal(gates.length, 2, 'a fresh gate after the fix round');
    assert.ok(gates.every((g) => !g.argv.includes('--resume')));
    assert.equal(git(d.repo, 'show', 'main:src/add.js') + '\n', ADD_FIXED);
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('codex.resume-collision-retry: a resume that collides with a live session is retried once as a new invocation', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      // The fresh build leaves mul wrong, so its lane is red and the fix round resumes the thread.
      codexStep([{ type: 'commit', message: 'add mul', files: { ...MUL, 'src/mul.js': 'export function mul(a, b) {\n  return a + b;\n}\n' } }], { argv: ['exec', '-C'] }),
      { as: 'codex', expect: { argv: ['exec', 'resume', '00000000-0000-4000-8000-000000000001'] }, acts: [{ type: 'resumeCollision' }] },
      codexStep([{ type: 'commit', message: 'fix mul', files: MUL }], { argv: ['exec', 'resume', '00000000-0000-4000-8000-000000000001'] }),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'red');
    await stepUntil(r, 'u1', (f) => f.stage === 'build');
    assert.equal(outcomes(d).at(-1), 'build:success', 'the retried resume succeeded');
    const builds = intents(d.runDir, 'proc.spawn').filter((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
    assert.equal(builds.length, 3, 'fresh, the collided resume, its retry');
    const [, collided, retried] = builds;
    assert.ok(collided!.parent.type === 'stage' && retried!.parent.type === 'stage');
    assert.deepEqual(collided!.parent, retried!.parent, 'both in the fix round\'s one attempt');
    assert.notEqual(collided!.op, retried!.op, 'the retry is a new invocation');
    assert.equal(collided!.deadlineAt, retried!.deadlineAt, 'with the same deadline');
    assert.equal(r.journal.view.unit(U1).counters.retries.build, 0, 'the collision retry is not the stage\'s uncharged retry');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('unit.reentrant: a driver killed between two stages is restarted on the same journal and continues from the fold', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const trigger = writeTrigger(tmpDir('unit-crash'), { label: 'unit.after-stage', occurrence: 7 });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(first.signal, 'SIGKILL', `the first driver died at its crash point: ${first.stderr}`);
  assert.deepEqual(outcomes(d), STRAIGHT.slice(0, 7), 'killed right after the lanes outcome');
  const second = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });
  assert.deepEqual(outcomes(d), STRAIGHT, 'no stage ran twice');
  const calls = readCalls(d.scenarioPath);
  assert.equal(calls.length, 3, 'one plan-check, one build, one gate');
  assert.ok(calls.every((c) => c.step !== null));
});

test('unit.reentrant-mid-stage: a driver killed inside ff after the publication closed reads it back on restart and publishes once', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  // resource.after-done: the slot's reserve, run, clean, release in the candidate stage (1-4), then in ff (5-8).
  const trigger = writeTrigger(tmpDir('unit-crash'), { label: 'resource.after-done', occurrence: 8 });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assert.deepEqual(outcomes(d), STRAIGHT.slice(0, 9), 'killed inside ff, before its outcome');
  const second = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });
  assert.deepEqual(outcomes(d), STRAIGHT);
  assert.equal(intents(d.runDir, 'integration.ff').length, 1, 'published once');
});

test('unit.reentrant-after-mergein: a driver killed after the merge-in, before the conflict was recorded, does not merge in again', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild({ 'src/add.js': 'export function add(a, b) {\n  return a + b; // unit u1\n}\n' }),
      gateStep({ decision: 'approve' }, {}, [{ type: 'barrier', name: 'gate', timeoutMs: 120_000 }]),
      codexStep([{ type: 'commit', message: 'resolve', files: { 'src/add.js': ADD_FIXED } }], { argv: ['exec', 'resume'], stdinContains: [RESOLVE_DIRECTIVE] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  // resource.after-done 4: the candidate stage's slot released after the merge-in, before its outcome.
  const trigger = writeTrigger(tmpDir('unit-crash'), { label: 'resource.after-done', occurrence: 4 });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const running = runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  await reached(d.scenarioDir, 'gate', 60_000);
  writeFileSync(join(d.repo, 'src', 'add.js'), 'export function add(a, b) {\n  return b + a; // integration\n}\n');
  git(d.repo, 'commit', '--quiet', '-am', 'integration changes add');
  release(d.scenarioDir, 'gate');
  const first = await running;
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assert.deepEqual(outcomes(d), STRAIGHT.slice(0, 8), 'killed inside the candidate stage');
  assert.equal(intents(d.runDir, 'mergein.prepare').length, 1);
  const second = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });
  assert.equal(outcomes(d)[8], 'candidate:conflict');
  assert.equal(intents(d.runDir, 'mergein.prepare').length, 1, 'the prepared merge-in was read back, not repeated');
  assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
});

test('arc.serial-terminal: units run in plan order; one merges, one parks with a blocking needs-user, and the arc is terminal', T, async () => {
  const d = setupArc({
    units: [{ id: 'u1' }, { id: 'u2' }],
    steps: [
      planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
      planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' }),
    ],
  });
  const r = contextFor(d);
  try {
    const parkedUnits: string[] = [];
    const result = await runArc(r.ctx, live(), (unit) => parkedUnits.push(unit));
    assert.deepEqual(parkedUnits, ['u2'], 'the park was handed over as it happened');
    assert.equal(result.kind, 'terminal');
    assert.ok(result.kind === 'terminal');
    assert.deepEqual(result.units.map((s) => [s.unit, s.result.kind]), [['u1', 'merged'], ['u2', 'parked']]);
    const parked = result.units[1]!.result;
    assert.ok(parked.kind === 'parked');
    assert.equal(parked.needsUser.blocking, true);
    assert.equal(parked.needsUser.reason, 'escalation');
    assert.deepEqual(parked.needsUser.subject, { type: 'unit', unit: 'u2' });
    assert.deepEqual(outcomes(d, 'u2'), ['plan-check:escalate', 'plan-check:escalate']);
    // A second run finds the arc where the log left it: nothing runs again.
    const calls = readCalls(d.scenarioPath).length;
    const again = await runArc(r.ctx, live(), (unit) => parkedUnits.push(unit));
    assert.ok(again.kind === 'terminal');
    assert.deepEqual(again.units.map((s) => [s.unit, s.result.kind, s.result.kind === 'parked' && s.result.needsUser.reason]), [['u1', 'merged', false], ['u2', 'parked', 'escalation']]);
    assert.equal(readCalls(d.scenarioPath).length, calls);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// A paused build continues its session

/** Runs u1 until a build parks at barrier `name`, then ends that build as the pause command does: the unit holds. */
async function pauseAt(r: ArcRun, name: string): Promise<void> {
  const running = runUnit(r.ctx, r.unit('u1'), live());
  await reached(r.d.scenarioDir, name, 60_000);
  const spawn = r.journal.view.openIntents().find((i) => i.kind === 'proc.spawn');
  assert.ok(spawn !== undefined, 'the build invocation is open');
  await killWorkload(r.ctx, { inv: invocationId(spawn.op, spawn.ordinal), scope: 'invocation', reason: 'pause' });
  assert.deepEqual(await running, { kind: 'held', needsUser: null });
}

const barrier = (name: string) => ({ type: 'barrier', name, timeoutMs: 120_000 } as const);
const implementerCalls = (r: ArcRun) => readCalls(r.d.scenarioPath).filter((c) => c.argv.includes('--permission-mode') || c.as === 'codex');
const flag = (argv: readonly string[], name: string): string | undefined => argv[argv.indexOf(name) + 1];
/** The unit's edits reached integration as the paused session left them. */
const mulMerged = (r: ArcRun): void => {
  for (const [path, text] of Object.entries(MUL)) assert.equal(`${git(r.d.repo, 'show', `main:${path}`)}\n`, text, path);
};

test('continue.claude-session: a pause mid fresh build holds it; resume continues the same Claude session, told only to continue, in the worktree with its uncommitted edits', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve', risk: 'high' }),
      { as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions', '--session-id'] }, acts: [{ type: 'dirty', files: MUL }, barrier('b1')] },
      { as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions', '--resume'], stdinContains: [CONTINUE_DIRECTIVE] }, acts: [{ type: 'emit', value: BUILD_REPORT }] },
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    await pauseAt(r, 'b1');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d), ['plan-check:approve', 'build:interrupted', ...STRAIGHT.slice(1)]);
    const [killed, continued] = implementerCalls(r);
    assert.ok(killed !== undefined && continued !== undefined);
    assert.equal(flag(continued.argv, '--resume'), flag(killed.argv, '--session-id'), 'the session the killed build was launched with');
    assert.ok(!continued.stdin.includes(NO_SESSION_NOTE));
    assert.equal(continued.cwd, unitWorktreePath(r));
    mulMerged(r);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
  } finally {
    r.journal.close();
  }
});

test('continue.codex-thread-chain: a Codex build paused after its thread started, then paused again while continued; each resume continues the thread read from the killed fresh exec\'s stdout', T, async () => {
  const thread = '00000000-0000-4000-8000-0000000c0de1';
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      { as: 'codex', threadId: thread, expect: { argv: ['exec', '-C'] }, acts: [{ type: 'threadStarted' }, { type: 'dirty', files: { 'src/mul.js': MUL['src/mul.js'] } }, barrier('b1')] },
      { as: 'codex', expect: { argv: ['exec', 'resume', thread], stdinContains: [CONTINUE_DIRECTIVE] }, acts: [{ type: 'dirty', files: { 'test/mul.test.js': MUL['test/mul.test.js'] } }, barrier('b2')] },
      codexStep([], { argv: ['exec', 'resume', thread], stdinContains: [CONTINUE_DIRECTIVE] }),
      gateStep({ decision: 'approve' }),
    ] satisfies readonly Step[],
  });
  const r = contextFor(d);
  try {
    await pauseAt(r, 'b1');
    await pauseAt(r, 'b2');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d), ['plan-check:approve', 'build:interrupted', 'build:interrupted', ...STRAIGHT.slice(1)]);
    assert.equal(implementerCalls(r).length, 3);
    mulMerged(r);
  } finally {
    r.journal.close();
  }
});

test('continue.no-session-fresh: a Codex exec killed before its thread started has no session; the continue is a fresh session told so, and the worktree keeps its edits', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexStep([{ type: 'dirty', files: MUL }, barrier('b1')], { argv: ['exec', '-C'] }),
      codexStep([], { argv: ['exec', '-C'], argvLacks: ['resume'], stdinContains: [NO_SESSION_NOTE, CONTINUE_DIRECTIVE] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    await pauseAt(r, 'b1');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d), ['plan-check:approve', 'build:interrupted', ...STRAIGHT.slice(1)]);
    mulMerged(r);
  } finally {
    r.journal.close();
  }
});
