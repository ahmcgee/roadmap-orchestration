// M2 build rounds (src/pipeline/rounds.ts): stalled fix rounds and the D4 escalation to `build.high` (A11, G1),
// a re-entry's fresh resolve round, and the session-never-persisted rerun. Integrated over real git and the
// fake backends where a round runs. Named tests: rounds.d4-decide, rounds.fresh-resolve,
// rounds.session-unrecoverable. The through-driver version (rounds.d4-through-driver) is M2 step 7a/7b's.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { type UnitId, sha, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { mergeHead } from '../src/git/mergein.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { implementerDispatch, pinDispatch, unitBranch, workDir } from '../src/pipeline/dispatch.ts';
import { prepare } from '../src/pipeline/prepare.ts';
import {
  NO_SESSION_NOTE, RESOLVE_DIRECTIVE, type RoundInput, callRound, escalateImplementer, escalation, prepareRound, stalledRounds,
} from '../src/pipeline/rounds.ts';
import { type LanesDone, at, build, buildRead, evidence, lanes, loadUnitSpec, planCheck, quiesce, record, salvage, start, teardown } from '../src/pipeline/stages.ts';
import { type StageOutcome, outcomeFact } from '../src/pipeline/transitions.ts';
import { promptFor } from '../src/prompts/index.ts';
import { commitAll, git, writeFiles } from './helpers/repo.ts';
import { type CodexAct, type Expect, type Step, readCalls } from './helpers/scenario.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, type StageRun, U1, launchOf, outcomeFacts, planCheckStep, seated, setupUnit, spawnIntents, started } from './fixtures/stage-common.ts';
import { contextFor, setupArc, unitWorktreePath } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const codexBuild = (acts: readonly CodexAct[], expect: Expect = {}): Step => ({ as: 'codex', expect, acts: [...acts, { type: 'emit', value: BUILD_REPORT }] });

/** Records the unit's next stage attempt with `outcome`, as its stage would; returns the attempt. */
function decide(run: StageRun, outcome: StageOutcome): number {
  const u = run.journal.view.unit(U1);
  const fact = outcomeFact(u, outcome, u.counters.attempts + 1);
  run.journal.fact(fact);
  return fact.attempt;
}

const FIX: RoundInput = { kind: 'fix', fix: { failingEvidenceDirs: [], directives: ['Fix it.'] }, ledger: [], verification: null, salvage: sha('0'.repeat(40)) };
const escalatedFacts = (run: StageRun): readonly Fact[] => readJournal(run.runDir, run.journal.view.arc).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'implementer-escalated' ? [e.fact] : []));

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

test('rounds.d4-decide: a fix round after a stalled one escalates to build.high once, journaled before its seat is chosen', T, async () => {
  // The gate revised, a fix round ran, the gate revised again: that fix round stalled.
  const run = setupUnit({ steps: [] });
  pinDispatch(run.ctx, run.unit, { rev: loadUnitSpec(run.ctx, run.unit).spec.rev, sha256: loadUnitSpec(run.ctx, run.unit).sha256 });
  decide(run, { stage: 'plan-check', kind: 'approve' });
  decide(run, { stage: 'build', kind: 'success' });
  decide(run, { stage: 'lanes', kind: 'green' });
  decide(run, { stage: 'gate', kind: 'revise' });
  const fix = decide(run, { stage: 'build', kind: 'success' });
  decide(run, { stage: 'lanes', kind: 'green' });
  assert.deepEqual(stalledRounds(readJournal(run.runDir, run.journal.view.arc), U1), [], 'no verdict on the fix round yet');
  decide(run, { stage: 'gate', kind: 'revise' });
  const log = readJournal(run.runDir, run.journal.view.arc);
  assert.deepEqual(stalledRounds(log, U1), [fix]);
  assert.equal(log.view.unit(U1).counters.chargeableFailures, 2, 'inside the bound');

  // Pure: only a fix round escalates, only when build.<tier> is not build.high's triple.
  const routing = run.ctx.routing(null);
  assert.deepEqual(escalation(log, routing, U1, FIX), { kind: 'escalate', from: 'med', stalled: fix });
  assert.deepEqual(escalation(log, routing, U1, { kind: 'resume' }), { kind: 'none', why: 'not-a-fix-round' });
  const sameHigh = { ...routing, table: { ...routing.table, build: { ...routing.table.build, med: routing.table.build.high } } };
  assert.deepEqual(escalation(log, sameHigh, U1, FIX), { kind: 'none', why: 'same-triple' });

  // Journaled: the fact, then the fold's build tier; a second decision escalates nothing.
  const attempt = run.journal.view.unit(U1).counters.attempts + 1;
  assert.equal(escalateImplementer(run.ctx, U1, attempt, FIX), 'high');
  assert.deepEqual(escalatedFacts(run), [{ kind: 'implementer-escalated', unit: U1, attempt, from: 'med', to: 'high', stalled: fix }]);
  assert.equal(run.journal.view.unit(U1).buildTier, 'high');
  assert.equal(run.journal.view.unit(U1).risk, 'med', 'the risk floor is unchanged');
  assert.equal(escalateImplementer(run.ctx, U1, attempt, FIX), 'high');
  assert.equal(escalatedFacts(run).length, 1);
  assert.deepEqual(escalation(readJournal(run.runDir, run.journal.view.arc), routing, U1, FIX), { kind: 'none', why: 'already-high' });

  // Not stalled: a revise, then a fix round whose lanes were not certified (no lane failed twice).
  const other = setupUnit({ steps: [] });
  pinDispatch(other.ctx, other.unit, { rev: loadUnitSpec(other.ctx, other.unit).spec.rev, sha256: loadUnitSpec(other.ctx, other.unit).sha256 });
  decide(other, { stage: 'plan-check', kind: 'approve' });
  decide(other, { stage: 'build', kind: 'success' });
  decide(other, { stage: 'lanes', kind: 'green' });
  decide(other, { stage: 'gate', kind: 'revise' });
  decide(other, { stage: 'build', kind: 'success' });
  decide(other, { stage: 'lanes', kind: 'not-certified' });
  const otherLog = readJournal(other.runDir, other.journal.view.arc);
  assert.deepEqual(stalledRounds(otherLog, U1), []);
  assert.equal(escalateImplementer(other.ctx, U1, otherLog.view.unit(U1).counters.attempts + 1, FIX), 'med');
  assert.deepEqual(escalatedFacts(other), []);

  // A lane that fails before and after a fix round, on real lanes: the unit's own test lane fails until add is
  // fixed, and the fix round commits something else.
  const lanesRun = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }), codexBuild([], { argv: ['exec', '-C'] }),
      codexBuild([{ type: 'commit', message: 'not the fix', files: { 'src/notes.md': 'Tried.\n' } }], { argv: ['exec', 'resume'] }),
    ],
  });
  started(await planCheck(lanesRun.ctx, lanesRun.unit));
  const red1 = started(await lanes(lanesRun.ctx, lanesRun.unit, await buildToLanes(lanesRun, { kind: 'fresh' })));
  assert.equal(red1.outcome.kind, 'red');
  assert.ok(red1.fix !== null);
  const fixAttempt = lanesRun.journal.view.unit(U1).counters.attempts + 1;
  assert.equal(escalateImplementer(lanesRun.ctx, U1, fixAttempt, red1.fix), 'med', 'the first fix round follows no stalled round');
  const red2 = started(await lanes(lanesRun.ctx, lanesRun.unit, await buildToLanes(lanesRun, red1.fix)));
  assert.equal(red2.outcome.kind, 'red');
  assert.ok(red2.fix !== null);
  const lanesLog = readJournal(lanesRun.runDir, lanesRun.journal.view.arc);
  assert.deepEqual(stalledRounds(lanesLog, U1), [fixAttempt]);
  const next = lanesLog.view.unit(U1).counters.attempts + 1;
  assert.equal(escalateImplementer(lanesRun.ctx, U1, next, red2.fix), 'high');
  assert.deepEqual(escalatedFacts(lanesRun), [{ kind: 'implementer-escalated', unit: U1, attempt: next, from: 'med', to: 'high', stalled: fixAttempt }]);
  assert.equal(readCalls(lanesRun.scenario.path).length, 3);
});

const U2: UnitId = unitId('u2');

test('rounds.fresh-resolve: after a re-entry\'s conflicted preparation, the resolve round is a fresh session on the prepared worktree, told so', T, async () => {
  // u1 dispatched, branched and held; u2 re-enters it; integration moved on with a conflicting change.
  const d = setupArc({ steps: [] });
  const r = contextFor(d);
  const u1 = r.unit('u1');
  const { spec, sha256 } = loadUnitSpec(r.ctx, u1);
  seated(pinDispatch(r.ctx, u1, { rev: spec.rev, sha256 }));
  record(r.ctx, at(start(r.ctx, U1, 'plan-check'), 'plan-check'), 'interrupted');
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
  ], { profile: 'default', config: null });
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
  started(await planCheck(run.ctx, run.unit));
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
    request: { kind: 'implementer', dispatch, session: call.session, evidenceDirs: [work, ...call.evidenceDirs] } as const,
    system: prompt.system, rendered: JSON.stringify(call.fixRound), schema: prompt.schema, cwd: round.worktree, deadlineAt: round.deadlineAt,
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
  assert.deepEqual(outcomeFacts(run).filter((f) => f.kind === 'stage-outcome' && f.attempt === parent.attempt).map((f) => f.kind === 'stage-outcome' && f.outcome), ['success']);
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, charged);
  const calls = readCalls(run.scenario.path);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.step !== null), `every call matched: ${calls.map((c) => c.step).join(',')}`);
  assert.equal(calls[3]!.cwd, round.worktree, 'the fresh session runs on the kept worktree');
});
