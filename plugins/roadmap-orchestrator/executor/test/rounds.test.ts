// M2 build rounds (src/pipeline/rounds.ts): a re-entry's fresh resolve round and the session-never-persisted rerun.
// Integrated over real git and the fake backends where a round runs. Named tests: rounds.fresh-resolve,
// rounds.session-unrecoverable. A stalled fix round stays on its seat (dev.17 retired D4): stage-m2's rounds.no-escalation.
// dev.81 (B4): rounds.fix-failures, rounds.missing-checks, rounds.checks-continuation, rounds.checks-accepted; (B5)
// rounds.after-merge-in-continuation, rounds.after-merge-in-proven.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type UnitId, invocationId, laneId, opIdOf, resourceName, sha, unitId } from '../src/core/ids.ts';
import { absPath, isoTimeOf, repoPath } from '../src/core/values.ts';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { mergeHead } from '../src/git/mergein.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { implementerDispatch, pinDispatch, unitBranch, unitWorktree, workDir } from '../src/pipeline/dispatch.ts';
import type { LaneDef } from '../src/core/records.ts';
import { type LaneRecord, lastLaneSeriesCost } from '../src/pipeline/lanes.ts';
import { prepare } from '../src/pipeline/prepare.ts';
import { FAILURE_EXCERPT_BYTES, FAILURE_EXCERPT_LINES, type RoundInput, callRound, laneFixRound, prepareRound } from '../src/pipeline/rounds.ts';
import { NO_SESSION_NOTE, RESOLVE_DIRECTIVE } from '../src/prompts/directives.ts';
import { type LanesDone, at, build, buildRead, evidence, lanes, loadUnitSpec, missingChecks, preBuild, quiesce, record, salvage, start, teardown } from '../src/pipeline/stages.ts';
import { laneCommand } from '../src/prompts/inputs.ts';
import { promptFor } from '../src/prompts/index.ts';
import { commitAll, git, tmpDir, writeFiles } from './helpers/repo.ts';
import { type CodexAct, type Expect, type Step, readCalls } from './helpers/scenario.ts';
import { BUILD_REPORT, DB, SCENARIO_TIMEOUT_MS, type StageRun, U1, launchOf, outcomeFacts, planCheckStep, seated, setupUnit, spawnIntents, started } from './fixtures/stage-common.ts';
import { commandContextFor, contextFor, setupArc, unitWorktreePath } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const codexBuild = (acts: readonly CodexAct[], expect: Expect = {}): Step => ({ as: 'codex', expect, acts: [...acts, { type: 'emit', value: BUILD_REPORT }] });


/** build → quiesce → evidence → salvage → teardown; returns the salvage SHA. */
async function buildToLanes(run: StageRun, input: RoundInput): Promise<LanesDone['at']> {
  const b = started(await build(run.ctx, run.unit, input));
  assert.ok(b.run !== null, `build ${b.outcome.kind}`);
  quiesce(run.ctx, U1, b.run);
  await evidence(run.ctx, run.unit, b.run);
  const s = await salvage(run.ctx, run.unit, b.run);
  assert.ok(s.sha !== null, `salvage ${s.outcome.kind}`);
  await teardown(run.ctx, U1, b.run);
  return s.sha;
}

const U2: UnitId = unitId('u2');

test('rounds.fresh-resolve: after a re-entry\'s conflicted preparation, the resolve round is a fresh session on the prepared worktree, told so', T, async () => {
  // u1 dispatched, branched and held; u2 re-enters it; integration moved on with a conflicting change.
  const d = setupArc({ steps: [] });
  const r = contextFor(d);
  const u1 = r.unit('u1');
  const { spec, sha256 } = loadUnitSpec(r.ctx, u1);
  seated(pinDispatch(r.ctx, u1, { rev: spec.rev, sha256 }));
  record(r.ctx, at(start(r.ctx, U1, 'pre-build'), 'pre-build'), 'interrupted');
  git(d.repo, 'checkout', '--quiet', '-b', unitBranch(r.ctx.plan().arc, U1).replace(/^refs\/heads\//, ''));
  writeFiles(d.repo, { 'src/add.js': 'export function add(a, b) {\n  return a + b; // u1\n}\n' });
  commitAll(d.repo, 'u1 work');
  git(d.repo, 'checkout', '--quiet', 'main');
  writeFiles(d.repo, { 'src/add.js': 'export function add(a, b) {\n  return b + a; // main\n}\n' });
  commitAll(d.repo, 'integration moves on');
  const planDir = join(d.planPath, '..');
  writeFileSync(join(planDir, 'u2.json'), JSON.stringify({ ...(JSON.parse(readFileSync(join(planDir, 'u1.json'), 'utf8')) as object), unit: 'u2' }));
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as { units: Record<string, unknown>[] };
  plan.units.push({ ...plan.units[0], id: 'u2', spec: 'u2.json', reenters: { unit: 'u1' } });
  writeFileSync(d.planPath, JSON.stringify(plan));
  recordPlan(r.journal, absPath(d.runDir), readInputFiles(absPath(d.planPath), absPath(d.repo)), [
    { type: 'unit-added', unit: U2 }, { type: 'unit-reentered', unit: U2, reenters: U1, reset: false },
  ], { profile: 'default', config: null, arcRoles: 'm4b' });
  r.journal.close();

  const run = contextFor(d);
  try {
    const prepared = await prepare(run.ctx, run.unit('u2'));
    assert.equal(prepared.outcome.kind, 'conflicted');
    assert.ok(prepared.next.kind === 'stage' && prepared.next.stage === 'build' && prepared.next.round === 'resolve');
    const parent = at(start(run.ctx, U2, 'build'), 'build');
    const round = await prepareRound(run.ctx, seated(implementerDispatch(run.ctx, U2)), { kind: 'resolve' }, parent);
    assert.equal(round.session.mode, 'fresh');
    assert.deepEqual(round.fixRound, { failingEvidenceDirs: [], directives: [RESOLVE_DIRECTIVE, NO_SESSION_NOTE] });
    assert.equal(round.fresh, null, 'already fresh');
    assert.equal(round.worktree, unitWorktreePath(run, U2));
    assert.notEqual(mergeHead(round.worktree), null, 'MERGE_HEAD is kept for the resolve');
  } finally {
    run.journal.close();
  }
});

test('rounds.session-unrecoverable: a resumed fix session that dies before printing any JSON re-runs once, uncharged, fresh on the kept worktree', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexBuild([], { argv: ['exec', '-C'] }),
      // The resume dies at once, printing nothing.
      { as: 'codex', expect: { argv: ['exec', 'resume'] }, acts: [{ type: 'exit', code: 1 }] },
      codexBuild([{ type: 'commit', message: 'fix add', files: { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' } }], {
        argv: ['exec', '-C'], argvLacks: ['resume'], stdinContains: ['Fix the add lane.', NO_SESSION_NOTE],
      }),
    ],
  });
  started(await preBuild(run.ctx, run.unit));
  const red = started(await lanes(run.ctx, run.unit, await buildToLanes(run, { kind: 'fresh' })));
  assert.equal(red.outcome.kind, 'red');
  assert.ok(red.fix !== null && red.fix.kind === 'fix');
  const input: RoundInput = { ...red.fix, fix: { ...red.fix.fix, directives: [...red.fix.fix.directives, 'Fix the add lane.'] } };
  const charged = run.journal.view.unit(U1).counters.chargeableFailures;

  // The round as stages.build prepares and calls it (M2 step 7a moves stages.build onto callRound).
  const parent = at(start(run.ctx, U1, 'build'), 'build');
  const dispatch = seated(implementerDispatch(run.ctx, U1));
  const round = await prepareRound(run.ctx, dispatch, input, parent);
  assert.equal(round.session.mode, 'resume');
  assert.ok(round.fresh !== null && round.fresh.session.mode === 'fresh');
  assert.deepEqual(round.fresh.fixRound?.directives, [...input.fix.directives, NO_SESSION_NOTE]);
  const prompt = promptFor('build', dispatch.triple.model);
  const work = workDir(run.ctx.runDir, parent);
  const spec = (call: Parameters<Parameters<typeof callRound>[2]>[0]) => ({
    unit: U1, parent,
    request: { kind: 'implementer', dispatch, session: call.session, evidenceDirs: [work, ...call.evidenceDirs], mcpConfig: null } as const,
    system: prompt.system, prompt: null, rendered: JSON.stringify(call.fixRound), schema: prompt.schema, cwd: round.worktree, deadlineAt: round.deadlineAt,
  });
  const called = await callRound(run.ctx, round, spec);
  const done = await buildRead(run.ctx, run.unit, parent, 'fix', called, null);
  assert.equal(done.outcome.kind, 'success');

  // Two invocations of the one attempt: the resume, then the fresh session; one outcome, nothing charged.
  const builds = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build' && i.parent.type === 'stage' && i.parent.attempt === parent.attempt);
  assert.equal(builds.length, 2);
  const sessions = builds.map((b) => {
    const t = launchOf(run, b).terminal;
    return t.type === 'backend' && t.purpose === 'backend' && 'session' in t ? t.session.mode : null;
  });
  assert.deepEqual(sessions, ['resume', 'fresh']);
  assert.deepEqual(outcomeFacts(run).filter((f) => (f.kind === 'stage-outcome' && 'unit' in f) && f.attempt === parent.attempt).map((f) => (f.kind === 'stage-outcome' && 'unit' in f) && f.outcome), ['success']);
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, charged);
  const calls = readCalls(run.scenario.path);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.step !== null), `every call matched: ${calls.map((c) => c.step).join(',')}`);
  assert.equal(calls[3]!.cwd, round.worktree, 'the fresh session runs on the kept worktree');
});

test('rounds.last-series-cost: builds receive elapsed time through the diagnostic rerun and actual reserved resources', T, async () => {
  const run = setupUnit({
    steps: [planCheckStep({ decision: 'approve' }), codexBuild([]), codexBuild([])],
    lanes: [{ id: 'red', resources: [DB], argv: ['sh', '-c', 'echo "deploy assertion failed" >&2; exit 1'] }], resources: [DB],
  });
  started(await preBuild(run.ctx, run.unit));
  assert.equal(lastLaneSeriesCost(run.ctx, U1), null);
  const done = started(await lanes(run.ctx, run.unit, await buildToLanes(run, { kind: 'fresh' })));
  assert.ok(done.fix?.kind === 'fix');
  const lane = done.ledger[0]!;
  assert.ok(lane.diagnostic !== null);
  const cost = lastLaneSeriesCost(run.ctx, U1);
  assert.ok(cost !== null);
  assert.equal(cost.durationMs, Date.parse(lane.diagnostic.endedAt) - Date.parse(lane.at));
  assert.ok(cost.resources.some((r) => r === DB));
  assert.ok(cost.resources.some((r) => r.startsWith('@cpu#')));
  await buildToLanes(run, done.fix);
  const builds = readCalls(run.scenario.path).filter((c) => c.argv[0] === 'exec');
  assert.equal(builds.length, 2);
  assert.doesNotMatch(builds[0]!.stdin, /<last_lane_series>\{/);
  const rendered = builds[1]!.stdin.match(/<last_lane_series>(.*?)<\/last_lane_series>/)?.[1];
  assert.ok(rendered !== undefined);
  assert.deepEqual(JSON.parse(rendered), cost);
});

test('rounds.fresh-directives: a build without an earlier session keeps its decided directives', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve' })] });
  started(await preBuild(run.ctx, run.unit));
  const parent = at(start(run.ctx, U1, 'build'), 'build');
  const directives = ['Recorded checkout blocker'];
  const round = await prepareRound(run.ctx, seated(implementerDispatch(run.ctx, U1)), { kind: 'fresh', directives }, parent);
  assert.equal(round.session.mode, 'fresh');
  assert.deepEqual(round.fixRound, { failingEvidenceDirs: [], directives });
});


test('rounds.required-checks: failing local lanes retain their exact command at any cadence; executor-only and green lanes are excluded', () => {
  const local: LaneDef = {
    id: laneId('typecheck-tests'), argv: ['npx', 'tsc', '-p', 'tsconfig.test.json'], cwd: repoPath('packages/app'),
    env: { set: { CI: '1' }, pass: ['PATH'] }, expectedExit: 0, cadence: 'unit',
    resources: [], evidenceGlobs: [], evidenceExcludes: [],
  };
  const definitions: readonly LaneDef[] = [
    local,
    { ...local, id: laneId('environment'), environment: resourceName('estate') },
    { ...local, id: laneId('resource'), resources: [resourceName('db')] },
    { ...local, id: laneId('green'), cadence: 'build' },
  ];
  const ledger: readonly LaneRecord[] = definitions.map((l) => ({
    lane: l.id, argv: l.argv, expectedExit: l.expectedExit, exitCode: l.id === 'green' ? 0 : 1,
    verdict: l.id === 'green' ? 'pass' : 'fail', evidenceDir: absPath(`/ev/${l.id}`), ignored: null,
    inv: invocationId(opIdOf('arc-1/9'), 1), at: isoTimeOf(new Date(0)), endedAt: isoTimeOf(new Date(1)), fixDirs: [absPath(`/ev/${l.id}/output/files`)],
    host: null, signatures: [], voided: null, diagnostic: null, flaky: false, reused: null, redRev: 2, pressure: null, failure: null, repeat: null, hostSuspected: null,
  }));
  const round = laneFixRound(ledger, [], sha('a'.repeat(40)), definitions);
  assert.equal(round.kind, 'fix');
  if (round.kind !== 'fix') return;
  assert.deepEqual(round.fix.requiredChecks, [local]);
  assert.deepEqual(round.fix.failingEvidenceDirs, ['/ev/typecheck-tests/output/files', '/ev/environment/output/files', '/ev/resource/output/files']);
});


test('rounds.required-checks-dispatch: a non-build lane reaches the repair builder with its own worktree cwd', T, async () => {
  const run = setupUnit({
    steps: [planCheckStep({ decision: 'approve' }), codexBuild([]), codexBuild([])],
    lanes: [{ id: 'typecheck-tests', cadence: 'unit', cwd: 'src', argv: ['sh', '-c', 'echo "test typecheck failed" >&2; exit 1'] }],
  });
  started(await preBuild(run.ctx, run.unit));
  const done = started(await lanes(run.ctx, run.unit, await buildToLanes(run, { kind: 'fresh' })));
  assert.ok(done.fix?.kind === 'fix');
  const definition = loadUnitSpec(run.ctx, run.unit).spec.lanes[0]!;
  assert.deepEqual(done.fix.fix.requiredChecks, [definition]);
  await buildToLanes(run, done.fix);
  const repair = readCalls(run.scenario.path).filter((c) => c.argv[0] === 'exec')[1]!;
  const checks = repair.stdin.match(/<fix_round>[\s\S]*?<required_checks>([\s\S]*?)<\/required_checks>/)?.[1];
  assert.ok(checks !== undefined);
  assert.ok(checks.includes(laneCommand(unitWorktree(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1), definition)));
});

// ---------------------------------------------------------------------------------------------------
// dev.81 (B4): a fix round's failure text, and the final report's proof that it re-ran the required checks

/** A red lane record whose output snapshot dir holds `stderr` and `stdout` (absent when undefined). */
function redRecord(id: string, out: Readonly<{ stderr?: string; stdout?: string }>): LaneRecord {
  const dir = tmpDir(`rounds-red-${id}`);
  const files = join(dir, 'output', 'files');
  mkdirSync(files, { recursive: true });
  if (out.stderr !== undefined) writeFileSync(join(files, 'stderr'), out.stderr);
  if (out.stdout !== undefined) writeFileSync(join(files, 'stdout'), out.stdout);
  return {
    lane: laneId(id), argv: ['make', id], expectedExit: 0, exitCode: 1, verdict: 'fail', evidenceDir: absPath(dir), ignored: null,
    inv: invocationId(opIdOf('arc-1/9'), 1), at: isoTimeOf(new Date(0)), endedAt: isoTimeOf(new Date(1)), fixDirs: [absPath(files)],
    host: null, signatures: [], voided: null, diagnostic: null, flaky: false, reused: null, redRev: 2, pressure: null, failure: null, repeat: null, hostSuspected: null,
  };
}

test('rounds.fix-failures: each failing lane\'s signature line and stderr tail reach the fix round, capped; stdout when stderr is empty; nothing for a silent lane', () => {
  const tail = Array.from({ length: 30 }, (_, i) => `at frame ${i}`);
  const unit = redRecord('unit', { stderr: ['npm ERR! the wrapper', ...tail, 'AssertionError: expected 3, got 4 in add.test.js', 'npm ERR! code 1', ''].join('\n'), stdout: 'ok 1\n' });
  const quiet = redRecord('quiet', { stderr: '', stdout: 'not ok 2 - mul handles zero\n# fail 1\n' });
  const silent = redRecord('silent', {});
  const huge = redRecord('huge', { stderr: Array.from({ length: 20 }, (_, i) => `${i}:${'x'.repeat(400)}`).join('\n') });
  const round = laneFixRound([unit, quiet, silent, huge], [], sha('a'.repeat(40)), []);
  assert.ok(round.kind === 'fix');
  const failures = round.fix.failures ?? [];
  assert.deepEqual(failures.map((f) => f.lane), ['unit', 'quiet', 'huge'], 'a lane that printed nothing has no entry');
  const [u, q, h] = failures;
  assert.equal(u!.signature, 'AssertionError: expected 3, got 4 in add.test.js');
  assert.equal(u!.specific, true);
  assert.equal(u!.excerpt.length, FAILURE_EXCERPT_LINES);
  assert.equal(u!.excerpt.at(-1), 'AssertionError: expected 3, got 4 in add.test.js');
  assert.ok(!u!.excerpt.some((l) => l.startsWith('npm ERR!')), 'wrapper lines are left out');
  assert.equal(q!.signature, 'not ok 2 - mul handles zero');
  assert.deepEqual(q!.excerpt, ['not ok 2 - mul handles zero', '# fail 1'], 'stdout when stderr has nothing');
  assert.ok(Buffer.byteLength(h!.excerpt.join('\n')) <= FAILURE_EXCERPT_BYTES, 'the byte cap holds');
  assert.equal(h!.excerpt.at(-1), `19:${'x'.repeat(400)}`, 'the newest lines are kept');
  assert.ok(h!.excerpt.length < 20);
});

test('rounds.missing-checks: a required lane is proven by a checks row at HEAD with its expected exit; a report that does not parse owes nothing', () => {
  const head = sha('c'.repeat(40));
  const lane = (id: string, expectedExit = 0): LaneDef => ({ id: laneId(id), argv: ['true'], cwd: repoPath('.'), env: { set: {}, pass: [] }, expectedExit, cadence: 'unit', resources: [], evidenceGlobs: [], evidenceExcludes: [] });
  const owed = [lane('a'), lane('b'), lane('c', 3), lane('d'), lane('a')];
  const report = { ...BUILD_REPORT, checks: [
    { lane: 'a', head, exit: 0 }, { lane: 'b', head: 'd'.repeat(40), exit: 0 }, { lane: 'c', head, exit: 0 }, { lane: 'e', head, exit: 0 },
  ] };
  assert.deepEqual(missingChecks(report, owed, head), [
    { lane: 'b', expectedExit: 0, why: 'other-head' }, { lane: 'c', expectedExit: 3, why: 'other-exit' }, { lane: 'd', expectedExit: 0, why: 'no-row' },
  ]);
  assert.deepEqual(missingChecks(report, [], head), [], 'a round that owes nothing');
  assert.deepEqual(missingChecks({ summary: 'not a report' }, owed, head), [], 'buildRead reads it as malformed');
});

const ADD_FIX = { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' };

test('rounds.checks-continuation: a fix round\'s final report without a row at HEAD for its required check goes back once, uncharged, as a new invocation of the attempt; the next report is read', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexBuild([], { argv: ['exec', '-C'] }),
      { as: 'codex', expect: { argv: ['exec', 'resume'] }, acts: [{ type: 'commit', message: 'fix add', files: ADD_FIX }, { type: 'emit', value: { ...BUILD_REPORT, checks: [{ lane: 'unit', head: 'f'.repeat(40), exit: 0 }] } }] },
      codexBuild([], { argv: ['exec', 'resume'], stdinContains: ['does not prove these required lanes ran on your final tree: unit (its checks row names another commit'] }),
    ],
  });
  started(await preBuild(run.ctx, run.unit));
  const red = started(await lanes(run.ctx, run.unit, await buildToLanes(run, { kind: 'fresh' })));
  assert.ok(red.fix !== null && red.fix.kind === 'fix');
  assert.deepEqual(red.fix.fix.requiredChecks?.map((l) => l.id), ['unit']);
  const charged = run.journal.view.unit(U1).counters.chargeableFailures;
  const b = started(await build(run.ctx, run.unit, red.fix));
  assert.equal(b.outcome.kind, 'success');
  const builds = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build').map((i) => i.parent);
  assert.equal(builds.length, 3, 'the fresh build, the fix round\'s report and its one continuation');
  assert.deepEqual(builds[1], builds[2], 'the continuation is a new invocation of the fix round\'s attempt');
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, charged);
  const calls = readCalls(run.scenario.path);
  assert.ok(calls.every((c) => c.step !== null), `every call matched: ${calls.map((c) => c.step).join(',')}`);
  assert.match(calls[2]!.stdin, /<failing_lanes>- unit: /, 'the fix round quotes the failing lane');
});

test('rounds.checks-accepted: a fix round whose report proves every required check at HEAD is read at once; a fresh build owes no checks', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'emit', value: { ...BUILD_REPORT, checks: [] } }] },
      // The fake reports a row per <required_checks> lane at its HEAD (test/fakes/fake-backend.ts `withBuildChecks`).
      codexBuild([{ type: 'commit', message: 'fix add', files: ADD_FIX }], { argv: ['exec', 'resume'] }),
    ],
  });
  started(await preBuild(run.ctx, run.unit));
  const red = started(await lanes(run.ctx, run.unit, await buildToLanes(run, { kind: 'fresh' })));
  assert.ok(red.fix !== null && red.fix.kind === 'fix');
  const b = started(await build(run.ctx, run.unit, red.fix));
  assert.equal(b.outcome.kind, 'success');
  const builds = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  assert.equal(builds.length, 2, 'the fresh build and the fix round, no continuation');
  assert.equal(readCalls(run.scenario.path).length, 3);
});

// ---------------------------------------------------------------------------------------------------
// dev.81 (B5): the first build after a clean merge-in into the kept worktree

const SMOKE_SUITE = { id: 'smoke', argv: ['node', '-e', '0'] } as const;
const STALE_OUTPUT = 'dist/stale.js';

/**
 * u1 built once; then the integration tip moves on with a file u1 never touches, stale ignored build output sits in u1's
 * worktree (ignored through the repository's exclude file), and `roadmap merge-in u1` merges the tip in cleanly: the kept
 * worktree's HEAD is the merge, and no build has built on it. The merge-in entry runs the lanes there, red (u1's build changed
 * nothing): the fix round that follows is the first build after the merge-in.
 */
async function cleanMergedIn(run: StageRun): Promise<RoundInput> {
  started(await preBuild(run.ctx, run.unit));
  await buildToLanes(run, { kind: 'fresh' });
  writeFiles(run.repo, { 'docs/elsewhere.md': 'integration moves on\n' });
  commitAll(run.repo, 'integration moves on');
  const worktree = unitWorktree(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1);
  const exclude = git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude').trim();
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, 'dist/\n');
  mkdirSync(join(worktree, 'dist'), { recursive: true });
  writeFileSync(join(worktree, STALE_OUTPUT), 'stale\n');
  const file = submitCommand(run.ctx.runDir, run.ctx.plan().arc, { type: 'merge-in', unit: U1 });
  // commandContextFor reads only the stage context it is given.
  const outcome = await applyCommand(commandContextFor(null as never, run.ctx), file);
  assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
  const merged = run.journal.view.opsOf('mergein.prepare').at(-1);
  assert.ok(merged !== undefined && merged.post.type === 'clean-merged' && git(worktree, 'rev-parse', 'HEAD').trim() === merged.post.new);
  const red = started(await lanes(run.ctx, run.unit, merged.post.new));
  assert.ok(red.fix !== null && red.fix.kind === 'fix', red.outcome.kind);
  return red.fix;
}

for (const proven of [false, true]) {
  test(`rounds.after-merge-in-${proven ? 'proven' : 'continuation'}: the first build after a clean merge-in removes the stale build output and re-runs the suite lanes; a report ${proven ? 'proving them is read at once' : 'without their checks goes back once, uncharged'}`, T, async () => {
    const report: Step = proven
      // The fake reports a row per <after_merge_in> lane at its HEAD (test/fakes/fake-backend.ts `withBuildChecks`).
      ? codexBuild([], { argv: ['exec', 'resume'] })
      : { as: 'codex', expect: { argv: ['exec', 'resume'] }, acts: [{ type: 'emit', value: { ...BUILD_REPORT, checks: [] } }] };
    const run = setupUnit({
      suite: [SMOKE_SUITE],
      steps: [
        planCheckStep({ decision: 'approve' }),
        codexBuild([], { argv: ['exec', '-C'] }),
        report,
        ...(proven ? [] : [codexBuild([], { argv: ['exec', 'resume'], stdinContains: ['smoke (no checks row)'] })]),
      ],
    });
    const fix = await cleanMergedIn(run);
    const worktree = unitWorktree(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1);
    assert.ok(existsSync(join(worktree, STALE_OUTPUT)));
    const charged = run.journal.view.unit(U1).counters.chargeableFailures;
    const b = started(await build(run.ctx, run.unit, fix));
    assert.equal(b.outcome.kind, 'success');
    assert.equal(existsSync(join(worktree, STALE_OUTPUT)), false, 'the stale build output is removed before the round');
    const calls = readCalls(run.scenario.path);
    assert.ok(calls.every((c) => c.step !== null), `every call matched: ${calls.map((c) => c.step).join(',')}`);
    const after = calls[2]!.stdin.match(/<after_merge_in>\n([\s\S]*?)<\/after_merge_in>/)?.[1];
    assert.ok(after !== undefined, 'the round is told of the merge-in');
    assert.ok(after.includes('removed the ignored build output dist') && after.includes('- smoke (expects exit 0'), `cleaned dirs and the suite lane to re-run: ${after}`);
    assert.doesNotMatch(calls[1]!.stdin, /<after_merge_in>\n/, 'the build before the merge-in has none');
    const builds = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build').map((i) => i.parent);
    assert.equal(builds.length, proven ? 2 : 3);
    if (!proven) assert.deepEqual(builds[1], builds[2], 'the continuation is a new invocation of the same attempt');
    assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, charged, 'nothing is charged');
  });
}
