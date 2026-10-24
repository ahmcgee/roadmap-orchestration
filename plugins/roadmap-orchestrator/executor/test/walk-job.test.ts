// dev.13 (plan §2–§4, §7 "Integrated"): the milestone walk job over a real arc (real git, real processes, the fake claude
// and codex answering by unit and job, a tiny fake product: a node http server and a CLI). Named tests:
// walk.loop (milestone reached → walk → a P1 keeps the node unpassed while an unrelated unit runs → a repair lands → round
// 2 passes the node → the descendant becomes ready), walk.bring-up-failed (code's P1, no model call; a bring-up edit walks the round again, its report dismissing the P1), walk.repair-turn
// (a report citing evidence outside the evidence dir takes the one repair turn), walk.rounds-bound (the last round's
// proposals dropped; a settled milestone unpassed escalates), and the walk crash cells (walk.crash.<label>).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { readJournal } from '../src/core/log.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { specFacts } from '../src/pipeline/reproduce.ts';
import { recover } from '../src/recover/recover.ts';
import { ready } from '../src/schedule/ready.ts';
import { status } from '../src/status.ts';
import { checkpointMilestonesRemaining, checkpointPending, runCheckpoint } from '../src/holistic/checkpoint.ts';
import { milestoneWaits } from '../src/walk/node.ts';
import { milestoneProgress, walkItemsDue } from '../src/walk/milestones.ts';
import { runWalk, settleWalks, walkEvidenceDir } from '../src/walk/walk.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { WALK_JOB, crashCells } from './matrix.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { moduleFiles, unitSteps } from './fixtures/audit-common.ts';
import { applyPlanEdit, checkpointContext, completedAudit } from './fixtures/checkpoint-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, codexStep, contextFor, gateStep } from './fixtures/unit-common.ts';
import { admitSpecWire, checkpointAnswer, checkpointStep, noteLensStep, lensStep } from './helpers/holistic.ts';
import { BROKEN_WALK, milestoneJson, GREETING, J1_EVIDENCE, PRODUCT, unitInForce, walkAnswer, walkArc, walkContext, walkStep } from './fixtures/walk-common.ts';
import { repairUnits } from '../src/pipeline/reproduce.ts';
import { milestonesOf } from '../src/input/plan.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS * 2 };

type Json = Record<string, unknown>;
const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const factsOf = <K extends Fact['kind']>(r: ArcRun, kind: K) => facts(r).filter((f): f is Extract<Fact, { kind: K }> => f.kind === kind);
const planOf = (r: ArcRun) => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;

/** Steering reads the plan in force after applies, as the scheduler does. */
function steeringContext(r: ArcRun) {
  const { ctx, w } = checkpointContext(r);
  return { ctx: { ...ctx, plan: () => planOf(r) }, w };
}

/** The ready units' ids now (the scheduler's readiness, src/schedule/ready.ts). */
function readyNow(r: ArcRun): readonly string[] {
  const { ctx } = walkContext(r);
  return ready({
    view: r.journal.view, plan: planOf(r), blocking: [], drains: [], tripped: [], pressure: { ticks: [], nowMs: Date.now() },
    routing: (u) => ctx.routing(u).table, spec: specFacts(ctx),
  }).map((x) => x.unit.id);
}

/** Runs unit `id` of the plan in force through its pipeline to its merge, the arbiter ticking. */
async function merge(r: ArcRun, id: string): Promise<void> {
  const { w } = walkContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    assert.deepEqual(await runUnit(w.stage, unitInForce(r, id), admitAll), { kind: 'merged' }, `unit ${id} merges`);
  } finally {
    clearInterval(tick);
  }
}

/** Runs the walk due now, the arbiter ticking. */
async function walk(r: ArcRun) {
  const { ctx, w } = walkContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    return await runWalk(ctx);
  } finally {
    clearInterval(tick);
  }
}

/** Adds repair unit `r1` (repairs F-1, scope the product) and its spec, and applies it: the scripted checkpoint's admit. */
async function admitRepair(r: ArcRun): Promise<void> {
  const planDir = join(r.d.planPath, '..');
  const spec = JSON.parse(readFileSync(join(planDir, 'u1.json'), 'utf8')) as Json;
  writeFileSync(join(planDir, 'r1.json'), JSON.stringify({ ...spec, unit: 'r1', rev: 1, repairs: ['F-1'], scope: ['product/**', 'src/**', 'test/**'] }));
  const { w } = walkContext(r);
  await applyPlanEdit(r, w as never, (plan) => {
    (plan['units'] as Json[]).push({ id: 'r1', spec: 'r1.json', risk: 'med', scope: ['product/**', 'src/**', 'test/**'], resources: [], origin: 'repair' });
  });
}

const r1Steps = (): readonly Step[] => [
  { ...planCheckStep({ decision: 'approve' }), unit: 'r1' },
  { ...codexStep([{ type: 'commit', message: 'configure the greeting', files: GREETING }], { argv: ['exec', '-C'] }), unit: 'r1' },
  { ...gateStep({ decision: 'approve' }), unit: 'r1' },
];

describe('the milestone walk (dev.13)', () => {
  for (const everyMilestones of [undefined, 1]) {
    test(`checkpoint.milestone-boundary: K=${everyMilestones ?? 'default 2'} counts retired milestones after their walks, folds audit and nonblocking walk findings, and resets only at a milestone checkpoint`, T, async () => {
      const deviation = walkAnswer({ findings: [{ class: 'deviates', journey: 'J-1', claim: 'The error omits its remedy', cause: 'error text', against: { type: 'design', path: 'design/README.md', anchor: '#errors' }, paths: ['product/server.js'] }] });
      const d = walkArc({ steps: [
        ...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')),
        noteLensStep('audit-1'), walkStep('walk-1', deviation),
        walkStep('walk-2', walkAnswer({ journeys: [{ journey: 'J-3', outcome: 'completed' }, { journey: 'J-4', outcome: 'completed' }] })),
      ] });
      appendSteps(d, [
        { ...checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })), expect: { stdinContains: [`${d.runDir}/evidence/jobs/walk-1`] } },
        checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' })),
      ]);
      const r = contextFor(d);
      const { ctx, w } = steeringContext(r);
      const tick = setInterval(() => w.arbiter.wake(), 50);
      try {
        await applyPlanEdit(r, w, (plan) => {
          const second = milestoneJson({ id: 'MS-2', units: ['u2'] });
          second['journeys'] = (second['journeys'] as Json[]).map((j, i) => ({ ...j, id: `J-${i + 3}` }));
          (plan['milestones'] as Json[]).push(second);
          if (everyMilestones !== undefined) (plan['holistic'] as Json)['checkpoint'] = { everyMilestones };
        });
        const K = everyMilestones ?? 2;
        assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), K);
        await completedAudit(r, ctx);
        assert.equal(checkpointPending(ctx), false, 'a completed audit with a P3 folds into the milestone checkpoint');
        assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
        await merge(r, 'u1');
        assert.equal(checkpointPending(ctx), false, 'retired units alone: the milestone still owes its walk');
        await walk(r);
        assert.equal(milestoneProgress(r.journal.view, ctx.plan(), milestonesOf(ctx.plan())[0]!, []).kind, 'settled', 'a nonblocking finding can await the steering checkpoint');
        assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), K - 1);
        if (K === 1) assert.equal((await runCheckpoint(ctx)).kind, 'decided');
        else assert.equal(checkpointPending(ctx), false, 'one of two milestones is retired');
        await merge(r, 'u2');
        assert.equal(checkpointPending(ctx), false, 'the K-th milestone still owes its walk');
        await walk(r);
        assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), 0);
        const out = await runCheckpoint(ctx);
        assert.ok(out.kind === 'decided' && out.trigger.type === 'milestone', JSON.stringify(out));
        const captures = factsOf(r, 'checkpoint-inputs');
        assert.deepEqual(captures.map((c) => c.trigger), K === 1
          ? [{ type: 'milestone', milestones: ['MS-1'] }, { type: 'milestone', milestones: ['MS-2'] }]
          : [{ type: 'milestone', milestones: ['MS-1', 'MS-2'] }]);
        assert.deepEqual(captures[0]!.findings, ['F-1', 'F-2'], 'the boundary weighs both the audit and walk findings');
        assert.equal(captures[0]!.generation, factsOf(r, 'audit-started')[0]!.generation, 'a boundary uses the latest recorded generation');
        assert.equal(checkpointPending(ctx), false);
        assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), K, 'count starts afresh; old audits do not wake it');
        assert.equal(status(r.ctx.runDir, r.journal.view.arc, r.ctx.hostDir).audit!.checkpointMilestonesRemaining, K);
      } finally {
        clearInterval(tick);
        r.journal.close();
      }
    });
  }

  test('checkpoint.milestone-equal-snapshot: an immediate blocking walk checkpoint consumes no milestones; its equal milestone boundary is skipped and settles once', T, async () => {
    const d = walkArc({ steps: [...unitSteps('u1', moduleFiles('mul', '*')), walkStep('walk-1', BROKEN_WALK), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))] });
    const r = contextFor(d);
    const { ctx, w } = steeringContext(r);
    const tick = setInterval(() => w.arbiter.wake(), 50);
    try {
      await applyPlanEdit(r, w, (plan) => { (plan['holistic'] as Json)['checkpoint'] = { everyMilestones: 1 }; });
      await merge(r, 'u1');
      await walk(r);
      const immediate = await runCheckpoint(ctx);
      assert.ok(immediate.kind === 'decided' && immediate.trigger.type === 'walk', JSON.stringify(immediate));
      assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), 0, 'the walk escape hatch did not reset the count');
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'not-needed', trigger: { type: 'milestone', milestones: ['MS-1'] }, carried: ['F-1'] });
      assert.equal(checkpointPending(ctx), false);
      assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), 1);
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
      assert.equal(readCalls(d.scenarioPath).filter((c) => c.unit?.startsWith('ckpt-')).length, 1);
    } finally {
      clearInterval(tick);
      r.journal.close();
    }
  });

  test('checkpoint.final-before-quorum: the final audit gets its checkpoint when fewer than K milestones retired', T, async () => {
    const d = walkArc({ steps: [
      ...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')), ...unitSteps('u3', moduleFiles('sub', '-')),
      walkStep('walk-1', walkAnswer()), lensStep('audit-1', 'vision'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
    ] });
    const r = contextFor(d);
    const { ctx, w } = steeringContext(r);
    const tick = setInterval(() => w.arbiter.wake(), 50);
    try {
      await merge(r, 'u1');
      await walk(r);
      assert.equal(checkpointPending(ctx), false, 'one retired milestone is below K=2');
      await merge(r, 'u2');
      await merge(r, 'u3');
      await completedAudit(r, ctx);
      assert.ok(factsOf(r, 'audit-started')[0]!.triggers.some((t) => t.type === 'final'));
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.trigger.type === 'audit', JSON.stringify(out));
      assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), 1, 'the final checkpoint does not reset the milestone count');
      assert.equal(checkpointPending(ctx), false);
    } finally {
      clearInterval(tick);
      r.journal.close();
    }
  });

  test('checkpoint.final-capture-before-retirement: an ordinary audit covering the final head waits for the last walk, then checkpoints its findings even below K', T, async () => {
    const d = walkArc({ steps: [
      lensStep('audit-1', 'vision'), ...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')), ...unitSteps('u3', moduleFiles('sub', '-')),
      walkStep('walk-1', walkAnswer({ findings: [{ class: 'deviates', journey: 'J-1', claim: 'The error omits its remedy', cause: 'error text', against: { type: 'design', path: 'design/README.md', anchor: '#errors' }, paths: ['product/server.js'] }] })),
      checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
    ] });
    const r = contextFor(d);
    const { ctx, w } = steeringContext(r);
    const tick = setInterval(() => w.arbiter.wake(), 50);
    try {
      await completedAudit(r, ctx);
      const initial = factsOf(r, 'audit-started')[0]!;
      await merge(r, 'u1');
      await merge(r, 'u2');
      await merge(r, 'u3');
      // What an audit starting in the last ff's window records: it covered the final head, but the retirement
      // fact had not arrived, so its trigger was ordinary. Its late completion must not strand close-out.
      const head = git(d.repo, 'rev-parse', 'main') as typeof initial.integrationSha;
      r.journal.fact({ ...initial, job: 'audit-2' as never, integrationSha: head, generation: 2, highWater: r.journal.view.highWater(), triggers: [{ type: 'cadence' }] });
      r.journal.fact({ kind: 'audit-ended', job: 'audit-2' as never, outcome: 'completed', covered: [{ lens: 'vision', from: initial.integrationSha, to: head }], findings: [], suppressed: 0 });
      assert.equal(checkpointPending(ctx), false, 'the final audit checkpoint waits for the last milestone walk');
      await walk(r);
      assert.equal(checkpointPending(ctx), true);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.trigger.type === 'audit' && out.trigger.job === 'audit-2', JSON.stringify(out));
      assert.deepEqual(factsOf(r, 'checkpoint-inputs')[0]!.findings, ['F-1'], 'the final steering decision includes the last walk');
      assert.equal(checkpointPending(ctx), false);
    } finally {
      clearInterval(tick);
      r.journal.close();
    }
  });

  test('checkpoint.audit-p1-escape: a milestone arc checkpoints an unweighed audit P1 immediately, before any milestone retires', T, async () => {
    const d = walkArc({ auditLenses: ['invariants'], steps: [lensStep('audit-1', 'invariants', [{ severity: 'P1', claim: 'The invariant is broken', cause: 'invariant failure', obligation: 'I-1' }]), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))] });
    const r = contextFor(d);
    const { ctx, w } = steeringContext(r);
    const tick = setInterval(() => w.arbiter.wake(), 50);
    try {
      await completedAudit(r, ctx);
      assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), 2);
      assert.equal(checkpointPending(ctx), true);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.trigger.type === 'audit', JSON.stringify(out));
      assert.equal(checkpointPending(ctx), false, 'the audit P1 was weighed');
      assert.equal(checkpointMilestonesRemaining(r.journal.view, ctx.plan()), 2, 'an escape hatch does not reset milestone cadence');
    } finally {
      clearInterval(tick);
      r.journal.close();
    }
  });

  test('walk.loop: milestone reached → walk → P1 holds the node while an unrelated unit runs → repair lands → round 2 passes → the descendant is ready', T, async () => {
    const d = walkArc({
      steps: [
        ...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u3', moduleFiles('div', '/')), ...r1Steps(), ...unitSteps('u2', moduleFiles('sub', '-')),
        walkStep('walk-1', BROKEN_WALK), walkStep('walk-2', walkAnswer()),
      ],
    });
    const r = contextFor(d);
    try {
      // Before u1 merges MS-1 is building: u2 waits on u1 (an after edge), nothing is walked.
      assert.deepEqual([...readyNow(r)].sort(), ['u1', 'u3']);
      assert.deepEqual(await walk(r), { kind: 'none' });
      await merge(r, 'u1');
      // The publication that retired MS-1's last unit made round 1 due; u2's dependency is merged, but MS-1's node is not passed.
      assert.deepEqual(milestoneWaits(r.journal.view, planOf(r)).get('u2' as never), ['MS-1']);
      assert.deepEqual(readyNow(r), ['u3']);

      const w1 = await walk(r);
      assert.deepEqual(w1, { kind: 'ended', job: 'walk-1', outcome: 'reported', passed: false });
      const [started] = factsOf(r, 'walk-started');
      assert.equal(started!.sha, git(d.repo, 'rev-parse', 'main'), 'walked on the integration head captured under the fence');
      assert.deepEqual(Object.keys(started!.ports), ['web']);
      const [opened] = factsOf(r, 'finding-opened');
      assert.deepEqual([opened!.id, opened!.lens, opened!.severity, opened!.milestone, opened!.obligation, opened!.source], ['F-1', 'walkthrough', 'P1', 'MS-1', null, { type: 'job', job: 'walk-1' }]);
      assert.equal(opened!.cause, 'GET /: server error when no greeting is configured', 'a walkthrough finding keeps its cause for the next walk');
      assert.deepEqual(factsOf(r, 'walk-ended').map((f) => [f.job, f.outcome, f.findings, f.proposals, f.dropped]), [['walk-1', 'reported', ['F-1'], [], []]]);
      // The fake used the product it was given: the server answered 500, which the evidence keeps; the logs are in the evidence dir.
      const evidence = walkEvidenceDir(r.ctx, 'walk-1' as never);
      assert.match(readFileSync(join(evidence, J1_EVIDENCE), 'utf8'), /^500 boom/);
      assert.match(readFileSync(join(evidence, 'server', 'serve.web.stdout'), 'utf8'), /^listening on /);
      // Bring-up: setup, the serve process (torn down), the seed; each a bring-up spawn, the serve one killed for teardown.
      const spawns = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'bring-up').map((i) => (i.expect.subject as { step: string }).step);
      assert.deepEqual(spawns, ['setup[0]', 'serve.web', 'seed[0]']);
      assert.deepEqual(r.journal.view.opsOf('proc.kill').map((k) => k.expect.reason), ['teardown']);
      assert.equal(git(d.repo, 'worktree', 'list', '--porcelain').includes('walk-1.'), false, 'the walk checkout is removed');
      assert.deepEqual(r.journal.view.openIntents(), []);

      // The P1 keeps the node unpassed: u2 waits while the unrelated u3 runs and merges.
      assert.deepEqual(readyNow(r), ['u3']);
      await merge(r, 'u3');
      assert.deepEqual(readyNow(r), []);
      assert.equal(milestoneProgress(r.journal.view, planOf(r), milestonesOf(planOf(r))[0]!, repairUnits(walkContext(r).ctx)).kind, 'round-open', 'round 1 waits for its checkpoint');
      const s1 = status(r.ctx.runDir, r.journal.view.arc, r.ctx.hostDir);
      assert.deepEqual(s1.milestones.map((m) => [m.id, m.state, m.passed, m.findings]), [['MS-1', 'blocked', false, ['F-1']]]);
      assert.deepEqual(s1.edges.filter((e) => e.type === 'milestone'), [{ type: 'milestone', unit: 'u2', milestone: 'MS-1', passed: false }]);
      assert.deepEqual(s1.units.find((u) => u.unit === 'u2')?.waitingFor?.milestones, ['MS-1']);

      // The repair (the scripted checkpoint's admit) lands; round 2 is due and passes the node.
      await admitRepair(r);
      await merge(r, 'r1');
      assert.equal(r.journal.view.holistic().findings.find((f) => f.id === 'F-1')?.state, 'resolved');
      const w2 = await walk(r);
      assert.deepEqual(w2, { kind: 'ended', job: 'walk-2', outcome: 'reported', passed: true });
      assert.deepEqual(factsOf(r, 'walk-started').map((f) => [f.job, f.round]), [['walk-1', 1], ['walk-2', 2]]);
      assert.deepEqual(factsOf(r, 'milestone-passed'), [{ kind: 'milestone-passed', milestone: 'MS-1', job: 'walk-2' }]);
      assert.match(readFileSync(join(walkEvidenceDir(r.ctx, 'walk-2' as never), J1_EVIDENCE), 'utf8'), /^200 hello/);

      // The descendant dispatches now.
      assert.deepEqual(readyNow(r), ['u2']);
      await merge(r, 'u2');
      // Round 2 admitted nothing: MS-1 settles, passed.
      const s2 = status(r.ctx.runDir, r.journal.view.arc, r.ctx.hostDir);
      assert.deepEqual(s2.milestones.map((m) => [m.id, m.state, m.passed, m.round]), [['MS-1', 'settled', true, 2]]);
      assert.deepEqual(await walk(r), { kind: 'none' });
      assert.deepEqual(readCalls(d.scenarioPath).filter((c) => c.step === null), [], 'every backend call matched its step');
    } finally {
      r.journal.close();
    }
  });

  test('walk.bring-up-failed: a setup command that fails opens code\'s P1 citing its log, with no model call; once the environment is fixed, a bring-up edit walks the round again and its report dismisses the P1', T, async () => {
    const d = walkArc({ steps: [...unitSteps('u1', moduleFiles('mul', '*')), walkStep('walk-2', walkAnswer())] });
    const r = contextFor(d);
    try {
      await merge(r, 'u1');
      // Break the bring-up: the setup command now fails (exit 1), by committing a failing setup script onto main.
      writeFileSync(join(d.repo, 'product', 'setup.js'), "process.stderr.write('setup: missing toolchain\\n'); process.exit(1);\n");
      git(d.repo, 'commit', '--quiet', '-am', 'break the setup');
      const out = await walk(r);
      assert.deepEqual(out, { kind: 'ended', job: 'walk-1', outcome: 'bring-up-failed', passed: false });
      const [opened] = factsOf(r, 'finding-opened');
      assert.deepEqual([opened!.lens, opened!.severity, opened!.milestone], ['walkthrough', 'P1', 'MS-1']);
      assert.match(opened!.claim, /setup\[0\] failed \(exit 1\)/);
      const log = opened!.evidence.find((e) => e.path.endsWith('setup[0].stderr'));
      assert.ok(log !== undefined && readFileSync(log.path, 'utf8').includes('missing toolchain'), JSON.stringify(opened!.evidence));
      assert.deepEqual(factsOf(r, 'walk-ended').map((f) => [f.outcome, f.findings]), [['bring-up-failed', ['F-1']]]);
      assert.deepEqual(readCalls(d.scenarioPath).filter((c) => c.unit === 'walk-1'), [], 'no model call');
      assert.deepEqual(r.journal.view.openIntents(), []);

      // The environment is fixed outside any unit (the setup passes again); an apply edits MS-1's bring-up: round 1 is due again.
      writeFileSync(join(d.repo, 'product', 'setup.js'), PRODUCT['product/setup.js']!);
      git(d.repo, 'commit', '--quiet', '-am', 'fix the setup');
      const { w } = walkContext(r);
      await applyPlanEdit(r, w as never, (plan) => {
        const [m] = plan['milestones'] as Json[];
        m!['bringUp'] = { ...(m!['bringUp'] as Json), env: { ...((m!['bringUp'] as Json)['env'] as Json), GREETER_FIXED: '1' } };
      });
      assert.deepEqual(milestoneProgress(r.journal.view, planOf(r), milestonesOf(planOf(r))[0]!, []), { kind: 'walk-due', round: 1 });
      assert.deepEqual(await walk(r), { kind: 'ended', job: 'walk-2', outcome: 'reported', passed: true });
      assert.deepEqual(factsOf(r, 'walk-started').map((f) => [f.job, f.round]), [['walk-1', 1], ['walk-2', 1]]);
      const f1 = r.journal.view.holistic().findings.find((f) => f.id === 'F-1');
      assert.deepEqual(f1?.last, { state: 'ruled', disposition: 'dismissed', by: { type: 'code', reason: 'not-reproduced' } }, 'the bring-up P1 no longer holds');
    } finally {
      r.journal.close();
    }
  });

  test('walk.repair-turn: a report citing a file outside its evidence dir takes the one repair turn, resumed, told why', T, async () => {
    const outside = walkAnswer({ journeys: [{ journey: 'J-1', outcome: 'completed', evidence: ['/etc/hostname'] }, { journey: 'J-2', outcome: 'completed' }] });
    const d = walkArc({
      steps: [
        ...unitSteps('u1', moduleFiles('mul', '*')),
        walkStep('walk-1', outside),
        {
          as: 'claude', unit: 'walk-1',
          expect: { argv: ['--resume'], argvLacks: ['--session-id'], stdinContains: ['Your answer was refused: ', 'outside the evidence dir'] },
          acts: [{ type: 'emit', value: walkAnswer() }],
        },
      ],
    });
    const r = contextFor(d);
    try {
      await merge(r, 'u1');
      const out = await walk(r);
      assert.deepEqual(out, { kind: 'ended', job: 'walk-1', outcome: 'reported', passed: true });
      assert.equal(readCalls(d.scenarioPath).filter((c) => c.unit === 'walk-1' && c.step !== null).length, 2);
      assert.deepEqual(factsOf(r, 'milestone-passed').map((f) => f.job), ['walk-1']);
    } finally {
      r.journal.close();
    }
  });

  test('walk.rounds-bound: the last round\'s proposals are dropped, and a milestone settled unpassed escalates', T, async () => {
    const d = walkArc({ steps: unitSteps('u1', moduleFiles('mul', '*')), walkRounds: 1 });
    const u1Spec = JSON.parse(readFileSync(join(d.planPath, '..', 'u1.json'), 'utf8')) as Json;
    const broken = walkAnswer({
      journeys: [{ journey: 'J-1', outcome: 'blocked' }, { journey: 'J-2', outcome: 'completed' }],
      findings: [{ class: 'breaks', journey: 'J-1', claim: 'GET / answers 500', cause: 'GET /: server error', against: { type: 'journey' } }],
      polish: [{
        journey: 'J-2', text: 'The CLI error could name the fix.',
        unit: { id: 'x-cli-error', scope: ['design/**', 'product/**'], spec: admitSpecWire({ ...u1Spec, unit: 'x-cli-error', rev: 1, scope: ['design/**', 'product/**'] }) },
      }],
    });
    appendSteps(d, [walkStep('walk-1', broken)]);
    const r = contextFor(d);
    try {
      await merge(r, 'u1');
      const out = await walk(r);
      assert.deepEqual(out, { kind: 'ended', job: 'walk-1', outcome: 'reported', passed: false });
      const [proposed] = factsOf(r, 'polish-proposed');
      assert.deepEqual([proposed!.id, proposed!.job, proposed!.milestone, proposed!.journey, proposed!.unit.id], ['X-1', 'walk-1', 'MS-1', 'J-2', 'x-cli-error']);
      assert.deepEqual(factsOf(r, 'walk-ended').map((f) => [f.proposals, f.dropped]), [[['X-1'], ['X-1']]], 'round 1 of 1: its proposals are dropped');
      // A checkpoint decides nothing for F-1 (a no-op after the walk): the round admitted nothing, so MS-1 settles unpassed.
      const visionSha256 = r.journal.view.planApplied()!.visionSha256!;
      r.journal.fact({
        kind: 'checkpoint-inputs', job: 'ckpt-1' as never, trigger: { type: 'audit', job: 'audit-9' as never }, generation: 1,
        vector: { plan: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, visionSha256, contracts: [] }, headSha: git(d.repo, 'rev-parse', 'main') as never, visionSha256,
        findings: ['F-1' as never], observations: [],
      });
      r.journal.fact({ kind: 'bundle-decided', job: 'ckpt-1' as never, outcome: { kind: 'no-op' } as never });
      const plan = planOf(r);
      const m = milestonesOf(plan)[0]!;
      const repairs = repairUnits(walkContext(r).ctx);
      assert.equal(milestoneProgress(r.journal.view, plan, m, repairs).kind, 'settled');
      const items = walkItemsDue(r.journal.view, plan, repairs, new Date());
      assert.equal(items.length, 1);
      assert.equal(items[0]!.job, 'walk-1');
      assert.equal(items[0]!.content.reason, 'finding-p1-escalated');
      assert.match(items[0]!.content.summary, /MS-1/);
      assert.deepEqual(readyNow(r), ['u3'], 'u2 stays held by the unpassed node');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash cells: each label of the walk job, then recovery and a resumed walk, which converges on one walk and one pass.

describe(`matrix row ${WALK_JOB}`, () => {
  for (const { label } of crashCells(WALK_JOB)) {
    test(`walk.crash.${label}: the resumed walk ends once, passes the node once, asks the model once`, T, async () => {
      const d = walkArc({ steps: [...unitSteps('u1', moduleFiles('mul', '*')), walkStep('walk-1', walkAnswer())] });
      const setup = contextFor(d);
      try {
        await merge(setup, 'u1');
      } finally {
        setup.journal.close();
      }
      const trigger = writeTrigger(tmpDir('walk-crash'), { label, occurrence: 1 });
      const exit = await runFixture('walk-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      const { ctx, w } = walkContext(r);
      try {
        await recover({ stage: ctx, commands: w.commands });
        settleWalks(ctx);
        const out = await walk(r);
        if (label === 'walk.after-ended' || label === 'walk.after-passed') assert.deepEqual(out, { kind: 'none' });
        else assert.deepEqual(out, { kind: 'ended', job: 'walk-1', outcome: 'reported', passed: true });
        assert.deepEqual(factsOf(r, 'walk-started').map((f) => f.job), ['walk-1']);
        assert.deepEqual(factsOf(r, 'walk-ended').map((f) => [f.job, f.outcome]), [['walk-1', 'reported']]);
        assert.deepEqual(factsOf(r, 'milestone-passed').map((f) => f.job), ['walk-1']);
        assert.equal(readCalls(d.scenarioPath).filter((c) => c.unit === 'walk-1').length, 1, 'the model was asked once');
        assert.deepEqual(r.journal.view.openIntents(), []);
        assert.equal(git(d.repo, 'worktree', 'list', '--porcelain').includes('walk-1.'), false, 'no walk checkout left');
        assert.equal(existsSync(join(walkEvidenceDir(r.ctx, 'walk-1' as never), J1_EVIDENCE)), true);
      } finally {
        r.journal.close();
      }
    });
  }
});
