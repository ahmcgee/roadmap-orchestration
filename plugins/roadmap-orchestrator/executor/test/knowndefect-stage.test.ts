// M4a rev 3 (F4, R49): plan known defects through the unit driver, integrated (real processes, real git, fake backends).
// Two units: u1, held by known defect K-1, and its fixer u2. Each unit is driven by `runUnit` behind the real admitter
// (src/schedule/ready.ts), as the scheduler gates it. Named tests: knowndefect.lane-hold-uncharged,
// knowndefect.output-match-uncharged, knowndefect.release-prepare-merges, knowndefect.release-conflict-resolves,
// knowndefect.consumed-after-fixer-merged, and the crash row "Prepare `known-defect`" (label
// prepare.known-defect-after-mergein). The predicate-level knowndefect.* tests are in test/ready.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StageOutcomeFact } from '../src/core/events.ts';
import { arcId, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { unitBranch } from '../src/pipeline/dispatch.ts';
import { specFacts } from '../src/pipeline/reproduce.ts';
import { type Gate, runUnit } from '../src/pipeline/unit.ts';
import { RESOLVE_DIRECTIVE } from '../src/prompts/directives.ts';
import { admitter } from '../src/schedule/ready.ts';
import type { Admission } from '../src/schedule/types.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import {
  type ArcDescriptor, type ArcRun, type UnitSpecJson, MUL, codexStep, contextFor, gateStep, mulBuild, outcomes, setupArc, stepUntil,
} from './fixtures/unit-common.ts';
import { editPlan } from './fixtures/route-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const U1 = unitId('u1');

const PRE_LANES = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released'];
const MERGED = ['gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];
const STRAIGHT = [...PRE_LANES, 'lanes:green', ...MERGED];

/** The output a known-buggy lane prints, and the `contains` of the output defect that names it. */
const BUG = 'KNOWN-BUG-42: the vendored parser chokes on CRLF';
/** u1's spec lane `mul` failing with BUG on stderr, every time. */
const BUGGY_LANE = { id: 'mul', argv: ['sh', '-c', `echo 'some noise'; echo '${BUG}' >&2; exit 1`] } as const;

/** What u1 adds beside mul (the fixer adds mul too: without it u1's diff from the merged tip would be empty). */
const U1_OWN = { 'src/u1.js': 'export const u1 = true;\n' };

type Match = Readonly<{ type: 'lane'; lane: string }> | Readonly<{ type: 'output'; lane: string; contains: string }>;

/** Each step keyed to `unit`: its calls take only these, in order. */
const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));

/** u1 and its fixer u2 (default lanes: `mul`), plan known defect K-1 (`match`, fixUnit u2). */
function defectArc(match: Match, steps: readonly Step[], u1: Partial<UnitSpecJson> = {}): ArcDescriptor {
  const d = setupArc({ units: [{ id: 'u1', ...u1 }, { id: 'u2' }], steps });
  editPlan(d, (p) => {
    p['knownDefects'] = [{ id: 'K-1', match, fixUnit: 'u2' }];
  });
  return d;
}

/** The admission the scheduler would give `unit`'s `stage` now (the real admitter over the plan in force). */
function admission(r: ArcRun, unit: string, stage: 'prepare'): Admission {
  return admitter((u) => r.ctx.routing(u).table, specFacts(r.ctx))({
    view: r.journal.view, plan: r.ctx.plan(), unit: r.unit(unit), stage, blocking: [], drains: [], tripped: [],
  });
}

/** A unit driver gate that asks the real admitter at every admission boundary; chains always run. */
const admitted = (r: ArcRun, unit: string): Gate => (next) => Promise.resolve(next.kind === 'chain' || admitter((u) => r.ctx.routing(u).table, specFacts(r.ctx))({
  view: r.journal.view, plan: r.ctx.plan(), unit: r.unit(unit), stage: next.stage, blocking: [], drains: [], tripped: [],
}).kind === 'admit');

const outcomeFacts = (d: ArcDescriptor, unit: string): readonly StageOutcomeFact[] =>
  readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === unit ? [e.fact] : []));
const lanesFacts = (d: ArcDescriptor, unit: string) => outcomeFacts(d, unit).filter((f) => f.stage === 'lanes');
/** The lane spawns of `unit`'s lanes attempt `attempt`. */
const laneSpawns = (d: ArcDescriptor, unit: string, attempt: number) => intents(d.runDir, 'proc.spawn')
  .filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'lanes' && i.parent.attempt === attempt);
/** The merge-ins of `unit`'s prepare attempts. */
const prepareMergeins = (d: ArcDescriptor, unit: string) => intents(d.runDir, 'mergein.prepare')
  .filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'prepare');
const parentsOf = (repo: string, commit: string): readonly string[] => git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
const HELD_BY_K1 = { kind: 'wait', constraints: [{ type: 'known-defect', id: 'K-1', fixUnit: 'u2' }] };

/** Asserts u1's latest lanes outcome is K-1's, uncharged, and that admission holds its prepare under K-1. */
function assertHeld(r: ArcRun): StageOutcomeFact {
  const f = lanesFacts(r.d, 'u1').at(-1)!;
  assert.equal(f.outcome, 'known-defect');
  assert.deepEqual(f.detail, { kind: 'known-defect', id: 'K-1', match: r.ctx.plan().knownDefects?.[0]?.match });
  assert.equal(f.chargeable, false, 'a known defect is uncharged');
  assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
  assert.deepEqual(admission(r, 'u1', 'prepare'), HELD_BY_K1, 'admission holds prepare while the fixer is unmerged');
  return f;
}

describe('known defect matched by lane', () => {
  test('knowndefect.lane-hold-uncharged / knowndefect.release-prepare-merges: u1 records known-defect before any lane runs, waits uncharged at prepare while u2 is unmerged; once u2 merges, prepare merges the tip in, then clean-verify, lanes, and u1 merges', T, async () => {
    const d = defectArc({ type: 'lane', lane: 'mul' }, [
      ...of('u1', [planCheckStep({ decision: 'approve' }), mulBuild(U1_OWN), gateStep({ decision: 'approve' })]),
      ...of('u2', [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/fix.js': 'export const fixed = true;\n' }), gateStep({ decision: 'approve' })]),
    ]);
    const r = contextFor(d);
    try {
      // lane-hold-uncharged: the driver stops at the prepare boundary, held (no needs-user).
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r, 'u1')), { kind: 'held', needsUser: null });
      assert.deepEqual(outcomes(d, 'u1'), [...PRE_LANES, 'lanes:known-defect']);
      const held = assertHeld(r);
      assert.deepEqual(laneSpawns(d, 'u1', held.attempt), [], 'no lane ran');
      assert.equal(admission(r, 'u2', 'prepare').kind, 'admit', 'the fixer is never held by its own defect');
      // A second driver call while the fixer is unmerged: still held, nothing recorded.
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r, 'u1')), { kind: 'held', needsUser: null });
      assert.deepEqual(outcomes(d, 'u1'), [...PRE_LANES, 'lanes:known-defect']);

      // The fixer declares the same lane and runs it: it is not held.
      assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), admitted(r, 'u2')), { kind: 'merged' });
      assert.deepEqual(outcomes(d, 'u2'), STRAIGHT);
      const tip = git(d.repo, 'rev-parse', 'main');

      // release-prepare-merges.
      assert.deepEqual(admission(r, 'u1', 'prepare'), { kind: 'admit' }, 'the fixer merged: released');
      const before = git(d.repo, 'rev-parse', unitBranch(r.ctx.plan().arc, U1));
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r, 'u1')), { kind: 'merged' });
      assert.deepEqual(outcomes(d, 'u1'), [...PRE_LANES, 'lanes:known-defect', 'prepare:clean-verify', 'lanes:green', ...MERGED]);
      const merges = prepareMergeins(d, 'u1');
      assert.equal(merges.length, 1, 'prepare merged the tip in once');
      const unitCommit = git(d.repo, 'rev-parse', unitBranch(r.ctx.plan().arc, U1));
      assert.deepEqual(parentsOf(d.repo, unitCommit), [before, tip], 'the unit branch holds the merge of the fixer\'s tip');
      assert.equal(git(d.repo, 'show', 'main:src/fix.js'), 'export const fixed = true;');
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
      assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null), 'every backend call matched its step');
    } finally {
      r.journal.close();
    }
  });

  test('knowndefect.release-conflict-resolves: the tip the fixer merged conflicts with u1: prepare is conflicted, a resolve round commits the merge, and u1 merges', T, async () => {
    const fixedMul = 'export function mul(a, b) {\n  return b * a; // the fixer\'s\n}\n';
    const d = defectArc({ type: 'lane', lane: 'mul' }, [
      ...of('u1', [
        planCheckStep({ decision: 'approve' }), mulBuild(),
        codexStep([{ type: 'commit', message: 'resolve the merge', files: { 'src/mul.js': MUL['src/mul.js'] } }], { argv: ['exec'], stdinContains: [RESOLVE_DIRECTIVE] }),
        gateStep({ decision: 'approve' }),
      ]),
      ...of('u2', [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/mul.js': fixedMul }), gateStep({ decision: 'approve' })]),
    ]);
    const r = contextFor(d);
    try {
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r, 'u1')), { kind: 'held', needsUser: null });
      assertHeld(r);
      assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), admitted(r, 'u2')), { kind: 'merged' });
      const tip = git(d.repo, 'rev-parse', 'main');
      const before = git(d.repo, 'rev-parse', unitBranch(r.ctx.plan().arc, U1));
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r, 'u1')), { kind: 'merged' });
      assert.deepEqual(outcomes(d, 'u1'), [
        ...PRE_LANES, 'lanes:known-defect', 'prepare:conflicted',
        'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', ...MERGED,
      ]);
      const merges = prepareMergeins(d, 'u1');
      assert.equal(merges.length, 1);
      assert.ok(merges[0]!.kind === 'mergein.prepare' && merges[0]!.expect.merge.type === 'conflicted', 'the prepare merge-in conflicted');
      const unitCommit = git(d.repo, 'rev-parse', unitBranch(r.ctx.plan().arc, U1));
      assert.deepEqual(parentsOf(d.repo, unitCommit), [before, tip], 'the implementer committed the merge [old, T]');
      assert.equal(`${git(d.repo, 'show', 'main:src/mul.js')}\n`, MUL['src/mul.js']);
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'the conflict is uncharged too');
    } finally {
      r.journal.close();
    }
  });
});

describe('known defect matched by output', () => {
  test('knowndefect.output-match-uncharged / knowndefect.consumed-after-fixer-merged: a red lane whose stderr tail contains `contains` is K-1, uncharged; after the fixer merged the same red is charged normally and the unit goes to a fix round, not back to prepare', T, async () => {
    const fix = codexStep([{ type: 'commit', message: 'try again', files: { 'src/other.js': 'export const other = 1;\n' } }], { argv: ['exec', 'resume'] });
    const d = defectArc({ type: 'output', lane: 'mul', contains: 'KNOWN-BUG-42' }, [
      ...of('u1', [planCheckStep({ decision: 'approve' }), mulBuild(), fix]),
      ...of('u2', [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/fix.js': 'export const fixed = true;\n' }), gateStep({ decision: 'approve' })]),
    ], { lanes: [BUGGY_LANE] });
    const r = contextFor(d);
    try {
      // output-match-uncharged: the lane ran red, its output names K-1.
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r, 'u1')), { kind: 'held', needsUser: null });
      assert.deepEqual(outcomes(d, 'u1'), [...PRE_LANES, 'lanes:known-defect']);
      const held = assertHeld(r);
      assert.ok(laneSpawns(d, 'u1', held.attempt).length >= 1, 'the lane ran');

      assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), admitted(r, 'u2')), { kind: 'merged' });
      assert.deepEqual(admission(r, 'u1', 'prepare'), { kind: 'admit' });

      // consumed-after-fixer-merged: prepare once, then the persistent red is charged.
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
      assert.deepEqual(outcomes(d, 'u1'), [...PRE_LANES, 'lanes:known-defect', 'prepare:clean-verify', 'lanes:red']);
      const red = lanesFacts(d, 'u1').at(-1)!;
      assert.equal(red.chargeable, true, 'the exemption is consumed: the red is charged');
      assert.equal(red.detail, undefined);
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 1);
      assert.deepEqual(admission(r, 'u1', 'prepare'), { kind: 'admit' });
      // The next stage is the fix round, never prepare again.
      await stepUntil(r, 'u1', () => true);
      assert.equal(outcomes(d, 'u1').at(-1), 'build:success');
      assert.equal(outcomes(d, 'u1').filter((o) => o.startsWith('prepare:')).length, 1, 'no loop through prepare');
      assert.equal(prepareMergeins(d, 'u1').length, 1);
    } finally {
      r.journal.close();
    }
  });
});

describe('crash row: prepare known-defect', () => {
  test('crash prepare.known-defect-after-mergein: killed after the merge-in, the restart reads it back (no second merge-in) and replays identically', T, async () => {
    const d = defectArc({ type: 'lane', lane: 'mul' }, [
      ...of('u1', [planCheckStep({ decision: 'approve' }), mulBuild(U1_OWN), gateStep({ decision: 'approve' })]),
      ...of('u2', [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/fix.js': 'export const fixed = true;\n' }), gateStep({ decision: 'approve' })]),
    ]);
    const r = contextFor(d);
    let before: string;
    let tip: string;
    try {
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted(r, 'u1')), { kind: 'held', needsUser: null });
      assertHeld(r);
      assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), admitted(r, 'u2')), { kind: 'merged' });
      before = git(d.repo, 'rev-parse', unitBranch(r.ctx.plan().arc, U1));
      tip = git(d.repo, 'rev-parse', 'main');
    } finally {
      r.journal.close();
    }
    const trigger = writeTrigger(tmpDir('knowndefect-crash'), { label: 'prepare.known-defect-after-mergein', occurrence: 1, unit: 'u1' });
    const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
    const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
    assert.equal(first.signal, 'SIGKILL', `killed at the label: ${first.stderr}`);
    assertFired(trigger);
    assert.deepEqual(outcomes(d, 'u1'), [...PRE_LANES, 'lanes:known-defect'], 'killed inside prepare, before its outcome');
    assert.equal(prepareMergeins(d, 'u1').length, 1);

    const second = await runFixture('stage-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });
    assert.deepEqual(outcomes(d, 'u1'), [...PRE_LANES, 'lanes:known-defect', 'prepare:clean-verify', 'lanes:green', ...MERGED], 'the outcomes of an uncrashed run');
    assert.equal(prepareMergeins(d, 'u1').length, 1, 'the merge-in was read back, not repeated');
    const unitCommit = git(d.repo, 'rev-parse', unitBranch(arcId(d.arc), U1));
    assert.deepEqual(parentsOf(d.repo, unitCommit), [before, tip]);
    const calls = readCalls(d.scenarioPath);
    assert.ok(calls.every((c) => c.step !== null), 'every backend call matched its step');
    assert.equal(calls.length, 6, 'no backend call twice');
  });
});
