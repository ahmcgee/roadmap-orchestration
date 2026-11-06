// M2 build rounds (src/pipeline/rounds.ts): a re-entry's fresh resolve round and the session-never-persisted rerun.
// Integrated over real git and the fake backends where a round runs. Named tests: rounds.fresh-resolve,
// rounds.session-unrecoverable. A stalled fix round stays on its seat (dev.17 retired D4): stage-m2's rounds.no-escalation.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type UnitId, invocationId, laneId, opIdOf, resourceName, sha, unitId } from '../src/core/ids.ts';
import { absPath, isoTimeOf, repoPath } from '../src/core/values.ts';
import { mergeHead } from '../src/git/mergein.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { implementerDispatch, pinDispatch, unitBranch, unitWorktree, workDir } from '../src/pipeline/dispatch.ts';
import type { LaneDef } from '../src/core/records.ts';
import { type LaneRecord, lastLaneSeriesCost } from '../src/pipeline/lanes.ts';
import { prepare } from '../src/pipeline/prepare.ts';
import { type RoundInput, callRound, laneFixRound, prepareRound } from '../src/pipeline/rounds.ts';
import { NO_SESSION_NOTE, RESOLVE_DIRECTIVE } from '../src/prompts/directives.ts';
import { type LanesDone, at, build, buildRead, evidence, lanes, loadUnitSpec, preBuild, quiesce, record, salvage, start, teardown } from '../src/pipeline/stages.ts';
import { laneCommand } from '../src/prompts/inputs.ts';
import { promptFor } from '../src/prompts/index.ts';
import { commitAll, git, writeFiles } from './helpers/repo.ts';
import { type CodexAct, type Expect, type Step, readCalls } from './helpers/scenario.ts';
import { BUILD_REPORT, DB, SCENARIO_TIMEOUT_MS, type StageRun, U1, launchOf, outcomeFacts, planCheckStep, seated, setupUnit, spawnIntents, started } from './fixtures/stage-common.ts';
import { contextFor, setupArc, unitWorktreePath } from './fixtures/unit-common.ts';

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
