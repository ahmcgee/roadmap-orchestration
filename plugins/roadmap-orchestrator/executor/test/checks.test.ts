// M4a rev 3 step N3: the executable checks before the gate (D1 witness presence, D2 mutation smoke) through the unit
// driver in a corpus arc (real processes, real git, fake backends; test/fixtures/checks-common.ts). Named tests:
// witnesscheck.*, e2e.gate-after-d1, smoke.*, mutant.corrupt-distinct, gate.no-spec-lanes-after-smoke and
// gate.unverified-reruns-lanes (paid M4a run 11), and the crash rows WITNESS_FILES, WITNESS_CHECK
// and MUTATION_SMOKE (labels witnesscheck.after-lane-files, witnesscheck.after-witnessed, smoke.after-patch-kept,
// smoke.after-apply, smoke.after-witnessed, smoke.after-ran-before-outcome).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact, IntentOf } from '../src/core/events.ts';
import { arcId, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { ROADMAP_BIN } from '../src/pipeline/witnesscheck.ts';
import { step } from '../src/pipeline/unit.ts';
import { unitTip } from '../src/pipeline/gate.ts';
import { verificationWorktree } from '../src/pipeline/dispatch.ts';
import { removeVerificationTree, seriesTree } from '../src/pipeline/lanes.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { fixture, runFixture } from './helpers/proc.ts';
import { barrierDir, reached, release } from './helpers/barrier.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { type TreePlan, scriptTree } from './helpers/witness.ts';
import { treeWith } from './fixtures/repair-common.ts';
import { patchedTree } from '../src/git/mutant.ts';
import { type ChecksArc, type ChecksOptions, checksArc, outcomeFacts } from './fixtures/checks-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, MUL, codexStep, contextFor, gateStep, isGateCall, mulBuild, outcomes, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const PRE_LANES = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released'];
const MERGED = ['gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

const facts = (d: ArcDescriptor): readonly Fact[] => readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const spawns = (d: ArcDescriptor): readonly IntentOf<'proc.spawn'>[] => readJournal(absPath(d.runDir), arcId(d.arc)).events
  .filter((e): e is typeof e & IntentOf<'proc.spawn'> => e.type === 'intent' && e.kind === 'proc.spawn');
/** The journey spawns a lanes attempt made (D1's witness lanes). */
const journeyRuns = (d: ArcDescriptor, attempt?: number) => spawns(d).filter((i) => i.expect.subject.purpose === 'journey' && i.parent.type === 'stage'
  && i.parent.stage === 'lanes' && (attempt === undefined || i.parent.attempt === attempt));
const smokeRuns = (d: ArcDescriptor) => spawns(d).filter((i) => i.expect.subject.purpose === 'mutant');
const lanesFacts = (d: ArcDescriptor) => outcomeFacts(d).filter((f) => f.stage === 'lanes');
const gateCalls = (d: ArcDescriptor) => readCalls(d.scenarioPath).filter(isGateCall);

/** Runs u1 until its lanes stage decides; returns the run (journal open: close it). */
async function toLanes(a: ChecksArc): Promise<ArcRun> {
  const r = contextFor(a.d);
  await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
  return r;
}

/** Lays out the arc and runs u1 until its lanes stage decides. */
async function lanesOf(opts: ChecksOptions): Promise<Readonly<{ a: ChecksArc; r: ArcRun }>> {
  const a = await checksArc(opts);
  return { a, r: await toLanes(a) };
}


const FIX = codexStep([{ type: 'commit', message: 'more tests', files: { 'test/more.test.js': '// more\n' } }], { argv: ['exec', 'resume'] });
/** A fix round that changes nothing. */
const NOOP_FIX = codexStep([], { argv: ['exec', 'resume'] });

describe('D1 witness presence', () => {
  test('witnesscheck.missing-fails-fast: a required witness absent on the salvage SHA is witnesses-missing; no gate call; the fix round names the id and what requires it', T, async () => {
    const { a, r } = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), FIX], trees: { '*': { outcomes: { t2: 'pass' } } } });
    try {
      const f = lanesFacts(a.d).at(-1)!;
      assert.equal(f.outcome, 'witnesses-missing');
      assert.equal(f.chargeable, false);
      assert.equal(f.unchargedLanesReds, 1);
      assert.deepEqual(f.detail, { kind: 'witnesses-missing', missing: [{ lane: 'journey', testId: 't1' }], failed: [] });
      assert.equal(journeyRuns(a.d, f.attempt).length, 1, 'the witness lane ran once at the salvage SHA');
      assert.equal(gateCalls(a.d).length, 0, 'the gate is not called');
      // The fix round resumes the build with the id, its source and the witness lane's evidence.
      await step(r.ctx, r.unit('u1'));
      const fix = readCalls(a.d.scenarioPath).at(-1)!;
      assert.match(fix.stdin, /Missing: test "t1" on lane journey, which witnesses I-1 \(a must-hold this unit keeps\)/);
      assert.match(fix.stdin, /-candidate\/journey\/arc-journey-/, 'the witness run\'s evidence dir is listed');
    } finally {
      r.journal.close();
    }
  });

  test('witnesscheck.plan-defect-unreachable: a missing witness whose declared file is gone at the salvage SHA and outside the unit\'s scope parks it uncharged with the defect named; no fix round, no gate', T, async () => {
    // Phase 0 passed (the file was at the tip); then the tip lost it, out of the unit's reach.
    const a = await checksArc({
      steps: [planCheckStep({ decision: 'approve' }), mulBuild()], testPaths: ['e2e'], files: ['e2e/i1.test.js'], tipFiles: { 'e2e/i1.test.js': '// I-1\n' },
      trees: { '*': { outcomes: { t2: 'pass' } } },
    });
    const r = contextFor(a.d);
    try {
      git(a.d.repo, 'rm', '-q', 'e2e/i1.test.js');
      git(a.d.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'the e2e suite moves away');
      await stepUntil(r, 'u1', (x) => x.stage === 'lanes');
      const f = lanesFacts(a.d).at(-1)!;
      assert.deepEqual([f.outcome, f.class, f.chargeable, f.park], ['plan-defect', 'park', false, { class: 'operator', kind: 'env' }]);
      assert.deepEqual(f.detail, { kind: 'plan-defect', defects: [{ type: 'witness-file-unreachable', obligation: 'I-1', file: 'e2e/i1.test.js', units: ['u1'] }] });
      const u = r.journal.view.unit(unitId('u1'));
      assert.deepEqual([u.status, u.counters.chargeableFailures], ['park-pending', 0]);
      assert.equal(gateCalls(a.d).length, 0, 'the gate is not called');
      assert.equal(readCalls(a.d.scenarioPath).length, 2, 'no fix round: plan-check and the build only');
    } finally {
      r.journal.close();
    }
    // Inside the unit's scope the file is the build's to add: the charged fix round, as before.
    const own = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()], testPaths: ['test'], files: ['test/add.test.js'], trees: { '*': { outcomes: { t2: 'pass' } } } });
    try {
      assert.equal(lanesFacts(own.a.d).at(-1)!.outcome, 'witnesses-missing');
    } finally {
      own.r.journal.close();
    }
  });

  test('witnesscheck.failed-and-zero-selected: a failing required id is failed, a zero-selected one missing', T, async () => {
    const { a, r } = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()], testIds: ['t1', 't2'], trees: { '*': { outcomes: { t1: 'fail', t2: 'zero-selected' } } } });
    try {
      assert.deepEqual(lanesFacts(a.d).at(-1)!.detail, { kind: 'witnesses-missing', missing: [{ lane: 'journey', testId: 't2' }], failed: [{ lane: 'journey', testId: 't1' }] });
    } finally {
      r.journal.close();
    }
  });

  test('witnesscheck.malformed-is-missing: a witness record that does not parse leaves every required id of its lane missing', T, async () => {
    const { a, r } = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()], trees: { '*': { outcomes: { t1: 'pass' }, malformed: true } } });
    try {
      assert.deepEqual(lanesFacts(a.d).at(-1)!.detail, { kind: 'witnesses-missing', missing: [{ lane: 'journey', testId: 't1' }], failed: [] });
    } finally {
      r.journal.close();
    }
  });

  test('witnesscheck.multi-deliverer-not-yet-complete: a future obligation another unpublished unit also delivers is not required yet; alone it is', T, async () => {
    const shared = await lanesOf({
      steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })], activation: 'future', deliveredBy: ['u1', 'u2'], more: ['u2'],
      trees: { '*': { outcomes: {} } },
    });
    try {
      const f = lanesFacts(shared.a.d).at(-1)!;
      assert.equal(f.outcome, 'green', 'nothing required: I-1 is not complete while u2 has not published');
      assert.deepEqual(journeyRuns(shared.a.d), []);
    } finally {
      shared.r.journal.close();
    }
    const alone = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()], activation: 'future', deliveredBy: ['u1'], trees: { '*': { outcomes: {} } } });
    try {
      assert.deepEqual(lanesFacts(alone.a.d).at(-1)!.detail, { kind: 'witnesses-missing', missing: [{ lane: 'journey', testId: 't1' }], failed: [] }, 'u1 completes I-1: a target');
    } finally {
      alone.r.journal.close();
    }
  });

  test('witnesscheck.latch-after-cut: an obligation another unit latched after this unit was cut is not required on its tree; its candidate grades it (paid M4b run 3)', T, async () => {
    // u2 delivers future I-1 and u1 declares it. u1 is cut and built first; u2 then publishes, latching I-1, whose test u1's
    // tree cannot hold. Before the fix u1's lanes demanded it: witnesses-missing, chargeable, on every rebuild of the same base.
    const a = await checksArc({
      steps: [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/u1.js': 'export const u1 = 1;\n' }), planCheckStep({ decision: 'approve' }), mulBuild({ 'src/u2.js': 'export const u2 = 2;\n' }), gateStep({ decision: 'approve' }), gateStep({ decision: 'approve' })],
      activation: 'future', deliveredBy: ['u2'], more: ['u2'],
    });
    const r = contextFor(a.d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'teardown');
      const u1Tip = unitTip(r.ctx, unitId('u1'));
      scriptTree(a.control, git(a.d.repo, 'rev-parse', `${u1Tip}^{tree}`), { outcomes: {} });
      await stepUntil(r, 'u2', (f) => f.stage === 'snapshot');
      const latch = facts(a.d).find((f) => f.kind === 'obligation-latched');
      assert.deepEqual(latch === undefined ? null : [latch.obligation, latch.unit], ['I-1', 'u2'], 'u2\'s publication latched I-1');
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
      const f = lanesFacts(a.d).at(-1)!;
      assert.deepEqual([f.outcome, f.chargeable], ['green', false], 'u2\'s latch is not in u1\'s tree: nothing required at the lanes stage');
      assert.deepEqual(journeyRuns(a.d, f.attempt).filter((i) => i.parent.type === 'stage' && i.parent.unit === 'u1'), []);
      await stepUntil(r, 'u1', (x) => x.stage === 'snapshot');
      assert.deepEqual(outcomes(a.d), [...PRE_LANES, 'lanes:green', ...MERGED]);
      const graded = spawns(a.d).filter((i) => i.expect.subject.purpose === 'journey' && i.parent.type === 'stage' && i.parent.unit === 'u1' && i.parent.stage === 'candidate');
      assert.equal(graded.length, 1, 'the candidate, u1 merged onto the tip holding u2, ran I-1\'s witness lane');
    } finally {
      r.journal.close();
    }
  });

  test('witnesscheck.dirty-is-not-certified: a witness lane that dirties its own checkout is not-certified; the fix round names the path', T, async () => {
    const { a, r } = await lanesOf({
      steps: [planCheckStep({ decision: 'approve' }), mulBuild(), FIX],
      argv: (w) => ['sh', '-c', `"${w}"; s=$?; echo x > lane-dirt.txt; exit $s`],
    });
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'not-certified');
      assert.equal(gateCalls(a.d).length, 0);
      await step(r.ctx, r.unit('u1'));
      assert.match(readCalls(a.d.scenarioPath).at(-1)!.stdin, /The lanes changed these paths in a clean checkout of your commit: lane-dirt\.txt/);
    } finally {
      r.journal.close();
    }
  });

  test('witnesscheck.blocked-and-interrupted-distinct: a witness lane without a verdict is blocked; a pause during it is interrupted', T, async () => {
    const blocked = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()], argv: () => ['/nonexistent/witness-lane'] });
    try {
      assert.equal(lanesFacts(blocked.a.d).at(-1)!.outcome, 'blocked');
    } finally {
      blocked.r.journal.close();
    }
    // A pause while the spec series' lane runs: the series ends green, and the witness lane's reservation wait is cancelled.
    const dir = barrierDir();
    const a = await checksArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()], specLane: [process.execPath, fixture('pm-lane-barrier.ts'), dir, 'spec'] });
    const r = contextFor(a.d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'teardown');
      const pause = new AbortController();
      const lanes = step({ ...r.ctx, signal: pause.signal }, r.unit('u1'));
      await reached(dir, 'spec', SCENARIO_TIMEOUT_MS);
      pause.abort('pause');
      release(dir, 'spec');
      await lanes;
      const f = lanesFacts(a.d).at(-1)!;
      assert.deepEqual([f.outcome, f.class], ['interrupted', 'hold']);
      assert.deepEqual(journeyRuns(a.d), [], 'the witness lane never started');
    } finally {
      r.journal.close();
    }
  });

  test('witnesscheck.architecture-doc-arc-skipped / e2e.gate-after-d1: green certified witnesses go on to the gate, which reads its own verification checkout and the required witnesses', T, async () => {
    const { a, r } = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green');
      assert.equal(journeyRuns(a.d).length, 1);
      await stepUntil(r, 'u1', (f) => f.stage === 'snapshot');
      assert.deepEqual(outcomes(a.d), [...PRE_LANES, 'lanes:green', ...MERGED]);
      const gate = gateCalls(a.d)[0]!;
      assert.match(gate.stdin, /<executable_checks>\nWitness presence: 1 required witness test on the arc lanes at this head\./);
      // dev.13: the gate runs in its own checkout, made at the commit of the spec series' checkout (not the witness check's).
      assert.match(gate.cwd, /u1\.gate-[0-9]+$/);
      assert.deepEqual(checkoutOf(r, gate.cwd), checkoutOf(r, verifyOf(r, lanesFacts(a.d).at(-1)!.attempt)), 'at the spec series\' commit');
    } finally {
      r.journal.close();
    }
  });
});

/** The checkout a `worktree.create` of `path` made (dev.13: the gate's own is made at the verification checkout's commit). */
function checkoutOf(r: ArcRun, path: string): unknown {
  const created = r.journal.view.opsOf('worktree.create').find((i) => i.expect.path === path);
  assert.ok(created !== undefined, `no worktree.create of ${path}`);
  return created.expect.checkout;
}
const verifyOf = (r: ArcRun, attempt: number): string =>
  verificationWorktree(r.ctx.plan().worktreeRoot, r.ctx.plan().arc, unitId('u1'), attempt);

describe('the build\'s witness checks (R56)', () => {
  test('build.witness-lane-files: the fast required lane\'s file is published write-once under the evidence dir and its command given to the build', T, async () => {
    const { a, r } = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()] });
    try {
      const build = readCalls(a.d.scenarioPath)[1]!;
      const m = /witness-check --lane-file (\S+)/.exec(build.stdin);
      assert.ok(m !== null, 'the build prompt names the command');
      assert.match(build.stdin, new RegExp(`${ROADMAP_BIN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} witness-check --lane-file`));
      const file = m[1]!;
      assert.match(file, /\/work\/u1\/[0-9]+-build\/witness\/journey\.json$/);
      const lane = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      assert.deepEqual([lane['lane'], lane['required'], lane['reporter']], ['journey', ['t1'], 'jsonl']);
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// D2 mutation smoke

/** u1 delivers I-1 (a future obligation, so a target), the journey lane's test files are `test/**`. */
const SMOKED: Omit<ChecksOptions, 'steps'> = { activation: 'future', deliveredBy: ['u1'], testPaths: ['test/**'] };
/** The tree mutation smoke makes of a salvaged commit adding MUL: the tip with only mul's test (src/mul.js reverted). */
const mutantTreeOf = (a: ChecksArc, files: Readonly<Record<string, string>> = { 'test/mul.test.js': MUL['test/mul.test.js'] }): string => treeWith(a.d.repo, 'main', files, null);
const smokeRan = (d: ArcDescriptor) => facts(d).filter((f): f is Extract<Fact, { kind: 'smoke-ran' }> => f.kind === 'smoke-ran');
const smokeApplies = (d: ArcDescriptor) => readJournal(absPath(d.runDir), arcId(d.arc)).events.filter((e) => e.type === 'intent' && e.kind === 'mutant.apply');

/** Lays out a smoked arc, scripts the mutant tree (`mutant`) over every other tree passing t1, and runs u1 to its lanes. */
async function smoked(steps: ChecksOptions['steps'], mutant: TreePlan | null, over: Partial<ChecksOptions> = {}): Promise<Readonly<{ a: ChecksArc; r: ArcRun }>> {
  const a = await checksArc({ steps, ...SMOKED, ...over });
  if (mutant !== null) scriptTree(a.control, mutantTreeOf(a), mutant);
  return { a, r: await toLanes(a) };
}

describe('D2 mutation smoke', () => {
  test('smoke.killed-green: the target fails with the production change reverted: killed, green, and the gate reads it', T, async () => {
    const { a, r } = await smoked([planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })], { outcomes: { t1: 'fail' } });
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green');
      const [ran] = smokeRan(a.d);
      assert.deepEqual(ran?.verdict, { killed: [{ lane: 'journey', testId: 't1' }], survived: [], inconclusive: [] });
      const [m] = smokeRuns(a.d);
      const subject = m!.expect.subject;
      assert.deepEqual(subject.purpose === 'mutant' && 'of' in subject ? subject.of : null, { type: 'smoke', unit: 'u1', attempt: lanesFacts(a.d).at(-1)!.attempt });
      const w = facts(a.d).filter((f) => f.kind === 'witnessed' && f.purpose === 'mutant');
      assert.equal(w.length, 1, 'the smoke run is witnessed under purpose mutant (never certifying)');
      await stepUntil(r, 'u1', (f) => f.stage === 'gate');
      assert.match(gateCalls(a.d)[0]!.stdin, /- killed: journey t1\n- survived: none\n- inconclusive: none/);
    } finally {
      r.journal.close();
    }
  });

  test('smoke.survivor-one-round-then-gate / smoke.allowance-reused-same-key: a survivor is one charged fix round; an unchanged unit reuses the verdict; then the gate decides with it', T, async () => {
    const { a, r } = await smoked([planCheckStep({ decision: 'approve' }), mulBuild(), NOOP_FIX, gateStep({ decision: 'approve' })], null);
    try {
      const f = lanesFacts(a.d).at(-1)!;
      assert.deepEqual([f.outcome, f.class, f.chargeable], ['smoke-survived', 'smoke', true]);
      assert.deepEqual(f.detail, { kind: 'smoke-survived', obligations: ['I-1'], testIds: [{ lane: 'journey', testId: 't1' }] });
      await step(r.ctx, r.unit('u1'));
      assert.match(readCalls(a.d.scenarioPath).at(-1)!.stdin, /Survived: test "t1" on lane journey, which witnesses I-1 \(what this unit delivers or repairs\)/);
      await stepUntil(r, 'u1', (x) => x.stage === 'snapshot');
      assert.deepEqual(lanesFacts(a.d).map((x) => [x.outcome, x.class]), [['smoke-survived', 'smoke'], ['smoke-survived', 'advance']], 'past the bound the survivors go to the gate');
      assert.equal(smokeApplies(a.d).length, 1, 'the second attempt reused the first verdict by key: one execution');
      const [first, second] = smokeRan(a.d);
      assert.equal(first!.key, second!.key);
      assert.match(gateCalls(a.d)[0]!.stdin, /- survived: journey t1/);
    } finally {
      r.journal.close();
    }
  });

  test('smoke.tests-only-fix-reruns: a fix round after a survivor that edits only test files changes the key; the mutant runs again', T, async () => {
    // Paid M4b run (unit confirm-by-text): the key left the tests out, so a tests-only fix reused the stale `survived`.
    const { a, r } = await smoked([planCheckStep({ decision: 'approve' }), mulBuild(), FIX, gateStep({ decision: 'approve' })], null);
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'smoke-survived');
      await stepUntil(r, 'u1', (x) => x.stage === 'snapshot');
      assert.deepEqual(lanesFacts(a.d).map((x) => [x.outcome, x.class]), [['smoke-survived', 'smoke'], ['smoke-survived', 'advance']]);
      assert.equal(smokeApplies(a.d).length, 2, 'the second attempt ran its own mutant');
      const [first, second] = smokeRan(a.d);
      assert.notEqual(first!.key, second!.key);
    } finally {
      r.journal.close();
    }
  });

  test('gate.no-spec-lanes-after-smoke (paid M4a run 11): a unit whose spec declares no lanes, its D1 witness journey and a surviving smoke, one fix round, then the gate finds the last lanes attempt\'s own checkout and the unit merges', T, async () => {
    // Run 11 (witness-hardening, seq 1585-1641): no spec lane ran, so no verification checkout existed; the only checkout of
    // the attempt was D1's witness journey's, removed before its certificate; the gate threw on every restart.
    // The plan's suite lanes are estate lanes, as run 11's suite ran at the candidate only: no lane at all runs at the lanes
    // stage (no fast suite, stages.ts `fastSuite`, either).
    const estateSuite = (p: Record<string, unknown>): void => {
      const suite = p['suite'] as { lanes: Record<string, unknown>[] };
      p['suite'] = { ...suite, lanes: suite.lanes.map((l) => ({ ...l, tier: 'estate' })) };
    };
    const { a, r } = await smoked([planCheckStep({ decision: 'approve' }), mulBuild(), NOOP_FIX, gateStep({ decision: 'approve' })], null, { noSpecLanes: true, plan: estateSuite });
    try {
      assert.deepEqual(spawns(a.d).filter((i) => i.expect.subject.purpose === 'lane'), [], 'no spec lane exists');
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'smoke-survived');
      await stepUntil(r, 'u1', (x) => x.stage === 'snapshot');
      assert.deepEqual(lanesFacts(a.d).map((x) => [x.outcome, x.class]), [['smoke-survived', 'smoke'], ['smoke-survived', 'advance']]);
      assert.deepEqual(outcomes(a.d).filter((o) => o.startsWith('gate:')), ['gate:approve'], 'the gate judged once, never unverified');
      const last = lanesFacts(a.d).at(-1)!.attempt;
      // dev.13: the gate's own checkout is made at the commit of lanes attempt `last`'s own checkout.
      assert.deepEqual(checkoutOf(r, gateCalls(a.d)[0]!.cwd), checkoutOf(r, verifyOf(r, last)), `the gate judges lanes attempt ${last}'s checkout: ${gateCalls(a.d)[0]!.cwd}`);
      const certified = facts(a.d).filter((f) => f.kind === 'series-certified' && f.parent.type === 'stage' && f.parent.attempt === last).map((f) => f.kind === 'series-certified' && f.checkout);
      assert.ok(certified.some((c) => typeof c === 'string' && c.endsWith(`/u1.verify-${last}`)), 'the empty spec series certified its checkout');
    } finally {
      r.journal.close();
    }
  });

  test('gate.unverified-reruns-lanes: a gate whose spec series\' checkout is gone records unverified, uncharged; the lanes run again and the gate then judges', T, async () => {
    const { a, r } = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
    try {
      const green = lanesFacts(a.d).at(-1)!;
      assert.equal(green.outcome, 'green');
      const parent = { type: 'stage', unit: green.unit, stage: 'lanes', attempt: green.attempt } as const;
      const tree = seriesTree(r.journal.view, parent, verificationWorktree(r.ctx.plan().worktreeRoot, r.ctx.plan().arc, green.unit, green.attempt))!;
      await removeVerificationTree(r.ctx, tree, parent);
      await step(r.ctx, r.unit('u1'));
      const gate = outcomeFacts(a.d).at(-1)!;
      assert.deepEqual([gate.stage, gate.outcome, gate.class, gate.chargeable], ['gate', 'unverified', 'advance', false]);
      assert.equal(gateCalls(a.d).length, 0, 'nothing judged without a checkout');
      await stepUntil(r, 'u1', (x) => x.stage === 'snapshot');
      assert.deepEqual(outcomes(a.d), [...PRE_LANES, 'lanes:green', 'gate:unverified', 'lanes:green', ...MERGED]);
      assert.equal(gateCalls(a.d).length, 1);
    } finally {
      r.journal.close();
    }
  });

  test('smoke.allowance-cap: past `smokeRuns` executions the smoke does not run and the gate is told why', T, async () => {
    const steps = [
      planCheckStep({ decision: 'approve' }), mulBuild(),
      codexStep([{ type: 'commit', message: 'touch mul', files: { 'src/mul.js': `${MUL['src/mul.js']}// v2\n` } }], { argv: ['exec', 'resume'] }),
      gateStep({ decision: 'approve' }),
    ];
    const { a, r } = await smoked(steps, null, { plan: (p) => { p.units[0]!['limits'] = { smokeRuns: 1 }; } });
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'smoke-survived');
      await stepUntil(r, 'u1', (x) => x.stage === 'gate');
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green', 'a new production diff, but the allowance is spent');
      assert.equal(smokeApplies(a.d).length, 1);
      assert.match(gateCalls(a.d)[0]!.stdin, /Mutation smoke did not run: the unit's smoke allowance is spent\./);
    } finally {
      r.journal.close();
    }
  });

  test('smoke.missing-is-inconclusive: a target the reverted tree does not report is inconclusive, advisory: green', T, async () => {
    const { a, r } = await smoked([planCheckStep({ decision: 'approve' }), mulBuild()], { outcomes: {} });
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green');
      assert.deepEqual(smokeRan(a.d)[0]?.verdict, { killed: [], survived: [], inconclusive: [{ lane: 'journey', testId: 't1' }] });
    } finally {
      r.journal.close();
    }
  });

  test('smoke.preservation-not-target: a declared must-hold is required (D1) but never smoked', T, async () => {
    const { a, r } = await lanesOf({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })], testPaths: ['test/**'] });
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green');
      assert.equal(journeyRuns(a.d).length, 1, 'D1 ran it');
      assert.deepEqual([smokeRuns(a.d), smokeRan(a.d)], [[], []]);
      await stepUntil(r, 'u1', (x) => x.stage === 'gate');
      assert.match(gateCalls(a.d)[0]!.stdin, /Mutation smoke did not run: the unit has no target witness tests\./);
    } finally {
      r.journal.close();
    }
  });

  test('smoke.binary-inconclusive: a binary production path makes every target inconclusive; nothing is applied', T, async () => {
    const { a, r } = await smoked([planCheckStep({ decision: 'approve' }), mulBuild({ 'src/blob.bin': 'a\u0000b\u0000c' })], null);
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green');
      assert.deepEqual(smokeRan(a.d)[0]?.verdict, { killed: [], survived: [], inconclusive: [{ lane: 'journey', testId: 't1' }] });
      assert.deepEqual(smokeApplies(a.d), []);
    } finally {
      r.journal.close();
    }
  });

  test('smoke.rename-inconclusive: a renamed production path makes every target inconclusive; nothing is applied', T, async () => {
    const sub = 'export function sub(a, b) {\n  return a - b;\n}\n// a module long enough for rename detection to pair it with its new name\n';
    const a = await checksArc({
      steps: [planCheckStep({ decision: 'approve' }), codexStep([{ type: 'commit', message: 'rename sub', files: { ...MUL, 'src/sub.js': null, 'src/minus.js': sub } }], { argv: ['exec', '-C'] })],
      ...SMOKED,
    });
    // The tip gains src/sub.js first, so the unit's change is a pure rename of it.
    writeFileSync(join(a.d.repo, 'src', 'sub.js'), sub);
    git(a.d.repo, 'add', '.');
    git(a.d.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub');
    const r = await toLanes(a);
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green');
      assert.deepEqual(smokeRan(a.d)[0]?.verdict.inconclusive, [{ lane: 'journey', testId: 't1' }]);
      assert.deepEqual(smokeApplies(a.d), []);
    } finally {
      r.journal.close();
    }
  });

  test('smoke.colocated-test-file: a test file beside the code (testPaths `src/**/*.test.js`) is kept; only production code is reverted', T, async () => {
    const files = { 'src/mul.js': MUL['src/mul.js'], 'src/mul.test.js': MUL['test/mul.test.js'] };
    const a = await checksArc({
      steps: [planCheckStep({ decision: 'approve' }), codexStep([{ type: 'commit', message: 'add mul', files }], { argv: ['exec', '-C'] })], ...SMOKED, testPaths: ['src/**/*.test.js'],
      specLane: ['node', '--test', 'src/mul.test.js'],
    });
    scriptTree(a.control, mutantTreeOf(a, { 'src/mul.test.js': MUL['test/mul.test.js'] }), { outcomes: { t1: 'fail' } });
    const r = await toLanes(a);
    try {
      assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green');
      assert.deepEqual(smokeRan(a.d)[0]?.verdict.killed, [{ lane: 'journey', testId: 't1' }], 'the mutant tree is exactly the tip plus the kept test file');
    } finally {
      r.journal.close();
    }
  });

  const NOT_RUN: readonly (readonly [string, Partial<ChecksOptions>, ChecksOptions['steps'], string])[] = [
    ['smoke.tests-only-diff-not-run', { tipFiles: { 'src/mul.js': MUL['src/mul.js'] } }, [planCheckStep({ decision: 'approve' }), codexStep([{ type: 'commit', message: 'tests', files: { 'test/mul.test.js': MUL['test/mul.test.js'] } }], { argv: ['exec', '-C'] }), gateStep({ decision: 'approve' })], 'the change touches test files only'],
    ['smoke.low-risk-not-run', { risk: 'low' }, [planCheckStep({ decision: 'approve', risk: 'low' }), mulBuild(), gateStep({ decision: 'approve' })], "the unit's risk floor is low"],
    ['smoke.no-testpaths-not-run', { testPaths: undefined }, [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })], 'a target lane declares no testPaths'],
  ];
  for (const [name, over, steps, why] of NOT_RUN) {
    test(`${name}: the smoke does not run, and the gate is told why`, T, async () => {
      const a = await checksArc({ steps, ...SMOKED, ...over });
      const r = await toLanes(a);
      try {
        assert.equal(lanesFacts(a.d).at(-1)!.outcome, 'green');
        assert.deepEqual([smokeApplies(a.d), smokeRan(a.d)], [[], []]);
        await stepUntil(r, 'u1', (x) => x.stage === 'gate');
        assert.match(gateCalls(a.d)[0]!.stdin, new RegExp(`Mutation smoke did not run: ${why}`));
      } finally {
        r.journal.close();
      }
    });
  }

  test('mutant.corrupt-distinct: a patch git cannot parse is corrupt (its stderr kept), one that parses but does not apply inapplicable', () => {
    const repo = tmpDir('corrupt-repo');
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
    const at = git(repo, 'rev-parse', 'HEAD') as never;
    const corrupt = join(repo, 'corrupt.patch');
    writeFileSync(corrupt, 'diff --git a/a.txt b/a.txt\n@@ nonsense @@\n');
    const stale = join(repo, 'stale.patch');
    writeFileSync(stale, 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-two\n+three\n');
    const c = patchedTree(absPath(repo), at, absPath(corrupt));
    assert.equal(c.kind, 'corrupt');
    assert.match(c.kind === 'corrupt' ? c.detail : '', /the patch is corrupt: .+/);
    const s = patchedTree(absPath(repo), at, absPath(stale));
    assert.equal(s.kind, 'inapplicable');
    assert.match(s.kind === 'inapplicable' ? s.detail : '', /does not apply to .* \(git apply exited 1: [\s\S]+\)/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash rows (identical replay)

async function crashThenResume(a: ChecksArc, label: string, occurrence = 1): Promise<void> {
  const trigger = writeTrigger(tmpDir('checks-crash'), { label, occurrence, unit: 'u1' });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const first = await runFixture('unit-child.ts', [JSON.stringify(a.d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(first.signal, 'SIGKILL', `killed at ${label}: ${first.stderr}`);
  assertFired(trigger);
  const second = await runFixture('stage-child.ts', [JSON.stringify(a.d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });
}

const GREEN_STEPS = [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })];

describe('crash rows', () => {
  test('witnesscheck.uncertified-observation-reruns / crash WITNESS_CHECK (lanes.after-census-before-certified in D1): no certificate, so the restart runs the witness lane again', T, async () => {
    const a = await checksArc({ steps: GREEN_STEPS });
    // Occurrence 1 is the spec series' own census; 2 the fast suite's (stages.ts `fastSuite`); 3 is the witness check's.
    await crashThenResume(a, 'lanes.after-census-before-certified', 3);
    assert.deepEqual(outcomes(a.d), [...PRE_LANES, 'lanes:green', ...MERGED], 'the same outcomes as an uncrashed run');
    assert.equal(journeyRuns(a.d).length, 2, 'uncertified: run again');
    assert.equal(readCalls(a.d.scenarioPath).length, 3, 'no backend call twice');
  });

  test('crash WITNESS_CHECK (witnesscheck.after-witnessed): the certified observation is reused by the restart, never run twice', T, async () => {
    const a = await checksArc({ steps: GREEN_STEPS });
    await crashThenResume(a, 'witnesscheck.after-witnessed');
    assert.deepEqual(outcomes(a.d), [...PRE_LANES, 'lanes:green', ...MERGED]);
    assert.equal(journeyRuns(a.d).length, 1, 'certified: reused');
  });

  test('crash WITNESS_FILES (witnesscheck.after-lane-files): the restarted build attempt publishes the same lane file and calls once', T, async () => {
    const a = await checksArc({ steps: GREEN_STEPS });
    await crashThenResume(a, 'witnesscheck.after-lane-files');
    assert.deepEqual(outcomes(a.d), [...PRE_LANES, 'lanes:green', ...MERGED]);
    const builds = readCalls(a.d.scenarioPath).filter((c) => c.as === 'codex');
    assert.equal(builds.length, 1, 'one build call');
  });

  // MUTATION_SMOKE: before `smoke-ran` the crashed execution counts against the allowance and the smoke runs again; after
  // it the verdict is found by key and nothing runs. Every replay ends as an uncrashed run does (killed, green, merged).
  for (const [label, applies] of [['smoke.after-patch-kept', 1], ['smoke.after-apply', 2], ['smoke.after-witnessed', 2], ['smoke.after-ran-before-outcome', 1]] as const) {
    test(`crash MUTATION_SMOKE (${label}): identical replay, ${applies} smoke execution${applies === 1 ? '' : 's'}`, T, async () => {
      const a = await checksArc({ steps: GREEN_STEPS, ...SMOKED });
      scriptTree(a.control, mutantTreeOf(a), { outcomes: { t1: 'fail' } });
      await crashThenResume(a, label);
      assert.deepEqual(outcomes(a.d), [...PRE_LANES, 'lanes:green', ...MERGED]);
      assert.equal(smokeApplies(a.d).length, applies);
      const ran = smokeRan(a.d);
      assert.ok(ran.length >= 1 && ran.every((f) => f.verdict.killed.length === 1));
    });
  }
});

