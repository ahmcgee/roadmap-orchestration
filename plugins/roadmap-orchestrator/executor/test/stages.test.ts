// The unit stages from plan-check through lanes (src/pipeline/stages.ts), integrated and fake-backed: real
// processes through the runner, real git, the fake codex and claude behind PATH shims. Includes the two
// deterministic fixtures of this step (redirect then approve; red lane → fix round reading the evidence
// dir) and the named tests session.judgment-never-resumes, redirect.no-widen, backend.usage-limit,
// stages.interrupted-holds, stages.contract-touched-promotes, stages.counters-from-fold, stages.no-model-ids,
// rounds.fix-without-session-starts-fresh, rounds.resume-without-session-starts-fresh.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { invocationId, resourceName } from '../src/core/ids.ts';
import { EVENTS_FILE, STATE_FILE, openJournal } from '../src/core/log.ts';
import { implementerDispatch, judgmentDispatch } from '../src/pipeline/dispatch.ts';
import { invocationDir, killWorkload } from '../src/pipeline/invoke.ts';
import { NO_SESSION_NOTE, RESUME_DIRECTIVE, type RoundInput, gateReviseRound } from '../src/pipeline/rounds.ts';
import { runnerFiles } from '../src/runner/files.ts';
import {
  type BuildDone, type BuildRun, type LanesDone, build, evidence, lanes, planCheck, quiesce, salvage, teardown,
} from '../src/pipeline/stages.ts';
import type { Next } from '../src/pipeline/transitions.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { MODEL_IDS } from '../src/routing/types.ts';
import { reached } from './helpers/barrier.ts';
import { git } from './helpers/repo.ts';
import { type CodexAct, type Expect, type Step, readCalls } from './helpers/scenario.ts';
import {
  BUILD_REPORT, DB, SCENARIO_TIMEOUT_MS, type StageRun, U1, facts, headOf, laneEvidencePattern, launchOf, outcomeFacts,
  planCheckStep, seated, setupUnit, spawnIntents, worktreeOf,
} from './fixtures/stage-common.ts';
import { events, intents } from './fixtures/invoke-specs.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

/** `stage[/round]@seat`, `park:<reason>`, `hold`: the Next, compactly. */
function show(n: Next): string {
  switch (n.kind) {
    case 'park':
    case 'stop':
      return `${n.kind}:${n.needsUser.reason}`;
    case 'hold':
    case 'retire':
      return n.kind;
    case 'stage':
      if (n.stage === 'build') return `build/${n.round}@${n.seat}`;
      return n.seat === null ? n.stage : `${n.stage}@${n.seat}`;
  }
}

/** build → quiesce → evidence → salvage → teardown, each advancing; returns the salvage SHA. */
async function buildToLanes(run: StageRun, input: RoundInput): Promise<Readonly<{ run: BuildRun; sha: string }>> {
  return afterBuild(run, await build(run.ctx, run.unit, input));
}

/** quiesce → evidence → salvage → teardown after build `b`, each advancing; returns the salvage SHA. */
async function afterBuild(run: StageRun, b: BuildDone): Promise<Readonly<{ run: BuildRun; sha: string }>> {
  assert.equal(show(b.next), 'quiesce', `build ${b.outcome.kind}`);
  assert.ok(b.run !== null);
  assert.equal(show(quiesce(run.ctx, U1, b.run).next), 'evidence');
  assert.equal(show((await evidence(run.ctx, run.unit, b.run)).next), 'salvage');
  const s = await salvage(run.ctx, run.unit, b.run);
  assert.equal(show(s.next), 'teardown', `salvage ${s.outcome.kind}`);
  assert.ok(s.sha !== null);
  assert.equal(show((await teardown(run.ctx, U1, b.run)).next), 'lanes');
  return { run: b.run, sha: s.sha };
}

const codexBuild = (acts: readonly CodexAct[], expect: Expect = {}): Step => ({ as: 'codex', expect, acts: [...acts, { type: 'emit', value: BUILD_REPORT }] });

test('stages.redirect-then-approve: a redirect patches the spec (rev+1), a fresh session re-checks and approves', T, async () => {
  const patch = [{ op: 'add', section: 'decisions', item: { id: 'D1', text: 'add returns the sum a + b.' } }];
  const run = setupUnit({ steps: [planCheckStep({ decision: 'redirect', patch }), planCheckStep({ decision: 'approve' })] });

  const first = await planCheck(run.ctx, run.unit);
  assert.equal(first.outcome.kind, 'redirect');
  assert.equal(show(first.next), 'plan-check@med');
  const spec = JSON.parse(readFileSync(run.specPath, 'utf8')) as { rev: number; decisions: readonly { id: string; state: string }[] };
  assert.equal(spec.rev, 2);
  assert.deepEqual(spec.decisions.map((d) => [d.id, d.state]), [['D1', 'active']]);
  const patches = intents(run.runDir, 'spec.patch');
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.kind === 'spec.patch' && patches[0]!.post.newRev, 2);

  const second = await planCheck(run.ctx, run.unit);
  assert.equal(second.outcome.kind, 'approve');
  assert.equal(second.specRev, 2, 'only the patched spec is graded');
  assert.equal(show(second.next), 'build/fresh@med');

  const calls = readCalls(run.scenario.path);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.step !== null), 'every call matched its step');
  const sessions = calls.map((c) => c.argv[c.argv.indexOf('--session-id') + 1]);
  assert.deepEqual(sessions, [first.session, second.session]);
  assert.notEqual(first.session, second.session, 'two fresh judgment sessions');
  assert.match(calls[1]!.stdin, /revision 2/);
  assert.match(calls[1]!.stdin, /D1/);
  assert.deepEqual(outcomeFacts(run).map((f) => f.kind === 'stage-outcome' && [f.stage, f.outcome, f.class, f.chargeable]), [
    ['plan-check', 'redirect', 'redirect', false], ['plan-check', 'approve', 'advance', false],
  ]);
  assert.equal(run.journal.view.unit(U1).counters.redirects, 1);
});

test('session.judgment-never-resumes: every judgment call is a new --session-id, a retry included', T, async () => {
  const malformed = { ...planCheckStep({ decision: 'approve' }), acts: [{ type: 'malformed' }] } as const;
  const run = setupUnit({ steps: [malformed, planCheckStep({ decision: 'approve' })] });
  const first = await planCheck(run.ctx, run.unit);
  assert.equal(first.outcome.kind, 'malformed');
  assert.equal(show(first.next), 'plan-check@med', 'the uncharged retry');
  const second = await planCheck(run.ctx, run.unit);
  assert.equal(second.outcome.kind, 'approve');
  assert.notEqual(first.session, second.session);
  for (const call of readCalls(run.scenario.path)) {
    assert.ok(!call.argv.includes('--resume'), 'a judgment never resumes');
    assert.ok(call.argv.includes('--no-session-persistence'));
  }
  for (const intent of spawnIntents(run)) {
    const t = launchOf(run, intent).terminal;
    assert.ok(t.type === 'backend' && t.role === 'planCheck' && t.session.backend === 'claude' && t.session.mode === 'fresh');
  }
});

test('redirect.no-widen: a redirect that widens the envelope or lowers the risk is refused and routes up', T, async () => {
  const widening = [{
    op: 'add', section: 'lanes',
    item: { id: 'db-lane', argv: ['true'], cwd: '.', env: { set: [], pass: [] }, expectedExit: 0, tier: 'estate', resources: [DB], evidenceGlobs: [] },
  }];
  const run = setupUnit({ steps: [planCheckStep({ decision: 'redirect', patch: widening }), planCheckStep({ decision: 'approve', risk: 'low' })] });
  const widened = await planCheck(run.ctx, run.unit);
  assert.equal(widened.outcome.kind, 'scope-widened');
  assert.equal(show(widened.next), 'plan-check@escalation', 'refused → escalate: the role\'s escalation seat');
  assert.equal(JSON.parse(readFileSync(run.specPath, 'utf8')).rev, 1, 'the spec is not patched');
  assert.deepEqual(intents(run.runDir, 'spec.patch'), []);
  assert.equal(seated(judgmentDispatch(run.ctx, U1, 'plan-check')).tier, 'escalation');

  const lowered = await planCheck(run.ctx, run.unit);
  assert.equal(lowered.outcome.kind, 'risk-lowered');
  assert.equal(show(lowered.next), 'park:escalation', 'refused again at the escalation seat: park');
  const dispatches = facts(run).filter((f) => f.kind === 'dispatch');
  assert.equal(dispatches.length, 1, 'the dispatch record is never re-pinned lower');
  assert.equal(run.journal.view.dispatchOf(U1)?.riskFloor, 'med');
  const calls = readCalls(run.scenario.path);
  assert.ok(calls[1]!.argv.includes('claude-fable-5-1'), 'the routed-up check ran on the escalation seat');
});

test('stages.red-lane-fix-round: the resumed implementer reads the failing evidence dir, commits the fix, the next series is green', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve' }), codexBuild([], { argv: ['exec', '-C'] })] });
  // The fix step matches the run's own evidence dir, so it is added once setupUnit has made the run dir.
  appendStep(run, {
    as: 'codex',
    expect: { argv: ['exec', 'resume'] },
    acts: [
      { type: 'readFromPrompt', pattern: laneEvidencePattern(run, 'unit'), file: 'stdout', contains: 'ADD-MARKER' },
      { type: 'commit', message: 'fix add', files: { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' } },
      { type: 'emit', value: BUILD_REPORT },
    ],
  });
  assert.equal(show((await planCheck(run.ctx, run.unit)).next), 'build/fresh@med');
  const first = await buildToLanes(run, { kind: 'fresh' });
  const red = await lanes(run.ctx, run.unit, first.sha as LanesDone['at']);
  assert.equal(red.outcome.kind, 'red');
  assert.equal(show(red.next), 'build/fix@med');
  assert.equal(red.verification, null, 'the failed series\' checkout is removed');
  assert.ok(red.fix !== null && red.fix.kind === 'fix');
  const failing = red.fix.fix.failingEvidenceDirs;
  assert.deepEqual(failing, [join(red.ledger[0]!.evidenceDir, 'output', 'files')]);
  assert.match(readFileSync(join(failing[0]!, 'stdout'), 'utf8'), /ADD-MARKER/);
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 1);

  const second = await buildToLanes(run, red.fix);
  assert.notEqual(second.sha, first.sha, 'the fix is a new commit on the unit branch');
  const green = await lanes(run.ctx, run.unit, second.sha as LanesDone['at']);
  assert.equal(green.outcome.kind, 'green');
  assert.equal(show(green.next), 'gate@med');
  assert.ok(green.verification !== null, 'the green checkout is kept for the gate');

  const calls = readCalls(run.scenario.path);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.step !== null), `every call matched: ${calls.map((c) => c.step).join(',')}`);
  const fresh = calls[1]!;
  const resumed = calls[2]!;
  assert.equal(resumed.argv[2], '00000000-0000-4000-8000-000000000001', 'the fix resumes the fresh build\'s thread');
  assert.equal(resumed.cwd, worktreeOf(run));
  assert.equal(fresh.cwd, worktreeOf(run));
  assert.ok(resumed.stdin.includes(failing[0]!), 'the failing evidence dir is in the resumed prompt');
  // The fix round's deadline is the measured series plus the edit allowance, not the fresh build's.
  const builds = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  const deadline = (i: (typeof builds)[number]) => new Date(launchOf(run, i).deadlineAt).getTime() - new Date(i.at).getTime();
  assert.ok(deadline(builds[1]!) < deadline(builds[0]!));
  assert.ok(deadline(builds[1]!) >= 60 * 60_000 && deadline(builds[1]!) < 65 * 60_000, `fix window ${deadline(builds[1]!)} ms`);
});

/** The implementer's build launched as a fresh session: its launch.json names no session to resume. */
function launchedFresh(run: StageRun): boolean {
  const builds = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  const terminal = launchOf(run, builds.at(-1)!).terminal;
  return terminal.type === 'backend' && terminal.purpose === 'backend' && 'session' in terminal && terminal.session.mode === 'fresh';
}

test('rounds.fix-without-session-starts-fresh: after a build lost with tree effects, the fix round starts a fresh session with the failing evidence and the no-session note', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'dirty', files: { 'NOTES.md': 'Started.\n' } }, { type: 'barrier', name: 'lost', timeoutMs: 120_000 }] },
    ],
  });
  appendStep(run, {
    as: 'codex',
    expect: { argv: ['exec', '-C'], argvLacks: ['resume'], stdinContains: [NO_SESSION_NOTE] },
    acts: [
      { type: 'readFromPrompt', pattern: laneEvidencePattern(run, 'unit'), file: 'stdout', contains: 'ADD-MARKER' },
      { type: 'commit', message: 'fix add', files: { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' } },
      { type: 'emit', value: BUILD_REPORT },
    ],
  });
  await planCheck(run.ctx, run.unit);
  const building = build(run.ctx, run.unit, { kind: 'fresh' });
  await reached(run.scenario.dir, 'lost', 60_000);
  // The runner dies mid-call, after the implementer changed the tree: no session was ever reported.
  const spawn = run.journal.view.openIntents().find((i) => i.kind === 'proc.spawn');
  assert.ok(spawn !== undefined, 'the build invocation is open');
  const inv = invocationId(spawn.op, spawn.ordinal);
  const runner = runnerFiles(invocationDir(run.runDir, inv), inv).read('runner.json');
  assert.ok(runner !== null);
  process.kill(runner.runner.pid, 'SIGKILL');
  const lost = await building;
  assert.equal(lost.outcome.kind, 'lost-tree-effects');
  const first = await afterBuild(run, lost);
  const red = await lanes(run.ctx, run.unit, first.sha as LanesDone['at']);
  assert.equal(red.outcome.kind, 'red');
  assert.ok(red.fix !== null && red.fix.kind === 'fix');

  const fixed = await build(run.ctx, run.unit, red.fix);
  assert.equal(fixed.outcome.kind, 'success');
  assert.ok(launchedFresh(run), 'the fix round\'s launch.json records a fresh session');
  const calls = readCalls(run.scenario.path);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.step !== null), `every call matched: ${calls.map((c) => c.step).join(',')}`);
  assert.ok(calls[2]!.stdin.includes(red.fix.fix.failingEvidenceDirs[0]!), 'the failing evidence dir is in the fresh session\'s prompt');
});

test('rounds.resume-without-session-starts-fresh: after a malformed fresh build that reported no session, the resume round starts a fresh session with the resume directive and the no-session note', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'exitZeroNoop' }] },
      codexBuild([], { argv: ['exec', '-C'], argvLacks: ['resume'], stdinContains: [RESUME_DIRECTIVE, NO_SESSION_NOTE] }),
    ],
  });
  await planCheck(run.ctx, run.unit);
  const malformed = await build(run.ctx, run.unit, { kind: 'fresh' });
  assert.equal(malformed.outcome.kind, 'malformed');
  assert.equal(show(malformed.next), 'build/resume@med');
  const b = await build(run.ctx, run.unit, { kind: 'resume' });
  assert.equal(b.outcome.kind, 'success');
  assert.ok(launchedFresh(run), 'the resume round\'s launch.json records a fresh session');
  const calls = readCalls(run.scenario.path);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.step !== null), `every call matched: ${calls.map((c) => c.step).join(',')}`);
});

test('rounds.gate-revise: the verification checkout is removed first, then the session resumes with the directives', T, async () => {
  const fixed = { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' };
  const directive = 'Name the parameters augend and addend.';
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexBuild([{ type: 'commit', message: 'add', files: fixed }], { argv: ['exec', '-C'] }),
      codexBuild([], { argv: ['exec', 'resume', '00000000-0000-4000-8000-000000000001'], stdinContains: [directive] }),
    ],
  });
  await planCheck(run.ctx, run.unit);
  const first = await buildToLanes(run, { kind: 'fresh' });
  const green = await lanes(run.ctx, run.unit, first.sha as LanesDone['at']);
  assert.equal(green.outcome.kind, 'green');
  assert.ok(green.verification !== null);
  // The gate (step 12) revised: its directives go to a fix round over the green series.
  const revise = gateReviseRound([directive], green.ledger, green.verification, green.at);
  const b = await build(run.ctx, run.unit, revise);
  assert.equal(b.outcome.kind, 'success');
  assert.ok(!existsSync(green.verification.path), 'the verification checkout is gone');
  const removal = events(run.runDir).filter((e) => e.type === 'intent' && e.kind === 'worktree.remove');
  assert.equal(removal.length, 1);
  const removed = removal[0]!;
  assert.ok(removed.type === 'intent' && removed.parent.type === 'stage' && removed.parent.stage === 'build' && removed.parent.attempt === b.attempt);
  assert.ok(removed.seq < spawnIntents(run).at(-1)!.seq, 'removed before the round\'s invocation');
  assert.ok(readCalls(run.scenario.path).every((c) => c.step !== null));
});

test('stages.salvage-unmerged-parks: an unmerged index parks the unit with the tree preserved and the build\'s resources released', T, async () => {
  const run = setupUnit({ resources: [DB], steps: [planCheckStep({ decision: 'approve' }), codexBuild([])] });
  await planCheck(run.ctx, run.unit);
  const b = await build(run.ctx, run.unit, { kind: 'fresh' });
  assert.ok(b.run !== null);
  // What an implementer could leave behind: a merge stopped on a conflict.
  const wt = worktreeOf(run);
  git(run.repo, 'branch', 'side', run.base);
  git(run.repo, 'worktree', 'add', '--quiet', join(run.scratch, 'side'), 'side');
  writeFileSync(join(run.scratch, 'side', 'src', 'add.js'), 'export const add = (a, b) => b + a;\n');
  git(join(run.scratch, 'side'), 'commit', '--quiet', '-am', 'side');
  writeFileSync(join(wt, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
  git(wt, 'commit', '--quiet', '-am', 'mine');
  assert.throws(() => git(wt, 'merge', '--quiet', 'side'));
  const before = readFileSync(join(wt, 'src', 'add.js'), 'utf8');
  assert.match(before, /<<<<<<</);

  quiesce(run.ctx, U1, b.run);
  await evidence(run.ctx, run.unit, b.run);
  const s = await salvage(run.ctx, run.unit, b.run);
  assert.equal(s.outcome.kind, 'unmerged');
  assert.equal(show(s.next), 'park:salvage-failed');
  assert.equal(s.sha, null);
  assert.equal(readFileSync(join(wt, 'src', 'add.js'), 'utf8'), before, 'the tree is preserved');
  assert.deepEqual(intents(run.runDir, 'salvage.commit'), [], 'refused before any intent');
  assert.equal(resourceTable(run.journal.view).get(resourceName(DB))?.status.state, 'free');
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 0);
});

/** Appends a step to the run's scenario file, before any call (the fake reads it on every call). */
function appendStep(run: StageRun, step: Step): void {
  const file = JSON.parse(readFileSync(run.scenario.path, 'utf8')) as { steps: Step[] };
  file.steps.push(step);
  writeFileSync(run.scenario.path, `${JSON.stringify(file, null, 2)}\n`);
}

test('backend.usage-limit: a usage-limit error parks the backend arc-wide and holds the unit, uncharged', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve' }), { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'usageLimit' }] }] });
  await planCheck(run.ctx, run.unit);
  const before = run.journal.view.unit(U1).counters;
  const b = await build(run.ctx, run.unit, { kind: 'fresh' });
  assert.equal(b.outcome.kind, 'interrupted');
  assert.equal(show(b.next), 'hold');
  assert.equal(b.run, null);
  assert.ok(b.needsUser !== null);
  assert.equal(b.needsUser.reason, 'usage-limit');
  assert.deepEqual(b.needsUser.subject, { type: 'arc' });
  assert.match(b.needsUser.recommendation, /resume --backend codex/);
  const park = facts(run).filter((f) => f.kind === 'backend-park');
  assert.deepEqual(park.map((f) => f.kind === 'backend-park' && [f.backend, f.class]), [['codex', 'usage-limit']]);
  assert.deepEqual(run.journal.view.parkedBackends(), ['codex']);
  const after = run.journal.view.unit(U1);
  assert.equal(after.status, 'held');
  assert.equal(after.counters.chargeableFailures, before.chargeableFailures);
  assert.deepEqual(after.counters.retries, before.retries);
  const fact = outcomeFacts(run).at(-1)!;
  assert.ok(fact.kind === 'stage-outcome' && fact.class === 'hold' && !fact.chargeable);
});

test('stages.interrupted-holds: a pause mid-build holds the unit, moves no counter and releases the build\'s resources', T, async () => {
  const run = setupUnit({
    resources: [DB],
    steps: [planCheckStep({ decision: 'approve' }), { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'barrier', name: 'mid-build', timeoutMs: 120_000 }] }],
  });
  await planCheck(run.ctx, run.unit);
  const before = run.journal.view.unit(U1).counters;
  const building = build(run.ctx, run.unit, { kind: 'fresh' });
  await reached(run.scenario.dir, 'mid-build', 60_000);
  const spawn = run.journal.view.openIntents().find((i) => i.kind === 'proc.spawn');
  assert.ok(spawn !== undefined, 'the build invocation is open');
  // The pause command's control action: kill the live invocation for `pause`.
  await killWorkload(run.ctx, { inv: invocationId(spawn.op, spawn.ordinal), scope: 'invocation', reason: 'pause' });
  const b = await building;
  assert.equal(b.outcome.kind, 'interrupted');
  assert.equal(show(b.next), 'hold');
  assert.equal(b.needsUser, null, 'a pause raises nothing');
  const after = run.journal.view.unit(U1);
  assert.equal(after.status, 'held');
  assert.equal(after.stage, 'build');
  assert.deepEqual({ ...after.counters, attempts: 0 }, { ...before, attempts: 0 }, 'no counter but attempts moves');
  assert.equal(resourceTable(run.journal.view).get(resourceName(DB))?.status.state, 'free', 'the build\'s resources are released');
  assert.deepEqual(run.journal.view.parkedBackends(), []);
});

test('stages.contract-touched-promotes: a contract path in the round\'s commits promotes the next judgment dispatch only', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexBuild([{ type: 'commit', message: 'touch the contract', files: { 'contracts/api.md': '# API contract\n\nChanged.\n', 'src/add.js': 'export const add = (a, b) => a + b;\n' } }]),
    ],
  });
  await planCheck(run.ctx, run.unit);
  const b = await build(run.ctx, run.unit, { kind: 'fresh' });
  assert.ok(b.run !== null);
  quiesce(run.ctx, U1, b.run);
  await evidence(run.ctx, run.unit, b.run);
  const s = await salvage(run.ctx, run.unit, b.run);
  assert.equal(s.outcome.kind, 'committed-contract-touched');
  assert.equal(show(s.next), 'teardown');
  assert.equal(s.sha, headOf(worktreeOf(run)));
  assert.equal(run.journal.view.unit(U1).promotion, true);
  assert.equal(seated(judgmentDispatch(run.ctx, U1, 'gate')).tier, 'escalation', 'the next judgment dispatch sits on the escalation seat');
  assert.equal(seated(implementerDispatch(run.ctx, U1)).tier, 'med', 'the implementer keeps its seat');
  const fact = outcomeFacts(run).at(-1)!;
  assert.ok(fact.kind === 'stage-outcome' && fact.class === 'trigger' && !fact.chargeable);
});

test('stages.counters-from-fold: attempts and counters are the log\'s, identical after a reopen', T, async () => {
  const malformed = { ...planCheckStep({ decision: 'approve' }), acts: [{ type: 'malformed' }] } as const;
  const run = setupUnit({ steps: [malformed, planCheckStep({ decision: 'approve' }), codexBuild([])] });
  const a = await planCheck(run.ctx, run.unit);
  const b = await planCheck(run.ctx, run.unit);
  const c = await build(run.ctx, run.unit, { kind: 'fresh' });
  assert.deepEqual([a.attempt, b.attempt, c.attempt], [1, 2, 3], 'each stage start is the next attempt of the unit');
  const live = run.journal.view.unit(U1);
  assert.equal(live.counters.attempts, 3);
  assert.equal(live.counters.retries['plan-check'], 1);
  assert.deepEqual(outcomeFacts(run).map((f) => f.kind === 'stage-outcome' && `${f.stage}#${f.attempt}`), ['plan-check#1', 'plan-check#2', 'build#3']);
  run.journal.close();
  const reopened = openJournal(run.runDir, run.ctx.plan.arc);
  try {
    assert.deepEqual(reopened.view.unit(U1), live, 'a restarted executor derives the same unit state');
  } finally {
    reopened.close();
  }
});

test('stages.no-model-ids: events, the state cache, dispatch facts and needs-user content never name a model; launch.json argv does', T, async () => {
  const run = setupUnit({
    resources: [DB],
    steps: [
      planCheckStep({ decision: 'approve', risk: 'high' }),
      { as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions', '--session-id'] }, acts: [{ type: 'emit', value: BUILD_REPORT }] },
      { as: 'claude', expect: { argv: ['--resume'] }, acts: [{ type: 'usageLimit' }] },
    ],
  });
  await planCheck(run.ctx, run.unit);
  const first = await buildToLanes(run, { kind: 'fresh' });
  const red = await lanes(run.ctx, run.unit, first.sha as LanesDone['at']);
  assert.equal(red.outcome.kind, 'red');
  assert.ok(red.fix !== null);
  const held = await build(run.ctx, run.unit, red.fix);
  assert.equal(held.outcome.kind, 'interrupted');
  assert.ok(held.needsUser !== null);

  const written = [
    readFileSync(join(run.runDir, EVENTS_FILE), 'utf8'),
    readFileSync(join(run.runDir, STATE_FILE), 'utf8'),
    JSON.stringify(held.needsUser),
    JSON.stringify(red),
  ];
  for (const text of written) for (const model of MODEL_IDS) assert.ok(!text.includes(model), `${model} in ${text.slice(0, 120)}`);
  assert.ok(facts(run).some((f) => f.kind === 'dispatch' && f.record.riskFloor === 'high'), 'the raised dispatch fact is among them');
  const launches = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'backend').map((i) => launchOf(run, i));
  assert.ok(launches.length >= 3);
  for (const l of launches) {
    assert.ok(MODEL_IDS.some((m) => l.argv.includes(m)), 'the backend argv names its model');
    assert.ok(!MODEL_IDS.some((m) => JSON.stringify({ ...l, argv: [] }).includes(m)), 'only inside argv');
    assert.equal(l.env['RESOURCE_OWNER'], `${run.ctx.plan.arc}/${U1}`);
    assert.deepEqual(Object.keys(l.env).sort(), ['HOME', 'PATH', 'RESOURCE_OWNER'].concat(['CLAUDE_CONFIG_DIR', 'CODEX_HOME'].filter((k) => process.env[k] !== undefined)).sort());
  }
});
