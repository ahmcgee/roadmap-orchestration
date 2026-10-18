// dev.13 agent D (plan §4, §7 "Integrated"): fix units and the polish loop over a real arc (real git, real processes, the
// fake claude and codex answering by unit and job, the tiny fake product of test/fixtures/walk-common.ts). Named tests:
// polish.loop (a walk proposes four tweaks → code applies three as one revision and refuses one → each builds and is
// approved, its candidate held for its compare → the judge keeps one and drops another (cut `polish-dropped`), code drops
// the one whose diff leaves the reference untouched → the kept tweak lands → round 2 sees it and the milestone settles at
// the bound), polish.classify (the classifier's polish rows), checkpoint.walk-trigger (a walk with an unweighed finding is
// a checkpoint trigger whose session reads the walk's evidence; one with nothing new is none), and the polish and compare
// crash cells (polish.crash.<label>, compare.crash.<label>).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import type { UnitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { evaluateRevision } from '../src/commands/apply.ts';
import { inForceFiles, requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { milestonesOf, parsePlan } from '../src/input/plan.ts';
import { repairUnits } from '../src/pipeline/reproduce.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import type { Gate } from '../src/pipeline/unit.ts';
import { holisticContexts } from '../src/schedule/scheduler.ts';
import { compareEvidenceDir, runCompare, tweakOf } from '../src/walk/compare.ts';
import { milestoneProgress } from '../src/walk/milestones.ts';
import { applyPolish } from '../src/walk/polish.ts';
import { runWalk } from '../src/walk/walk.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { checkpointAnswer } from './helpers/holistic.ts';
import { checkpointPending, runCheckpoint } from '../src/holistic/checkpoint.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { moduleFiles, unitSteps } from './fixtures/audit-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, contextFor } from './fixtures/unit-common.ts';
import { ACTING_ARGV, KEEP_FILES, SCOPE, polishSteps, proposal, unitInForce, walkAnswer, walkArc, walkContext, walkStep } from './fixtures/walk-common.ts';
import { COMPARE_JOB, POLISH_REVISION, crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS * 3 };

type Json = Record<string, unknown>;
const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const factsOf = <K extends Fact['kind']>(r: ArcRun, kind: K) => facts(r).filter((f): f is Extract<Fact, { kind: K }> => f.kind === kind);
const planOf = (r: ArcRun) => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;

/** The polish and compare context (the checkpoint's: a walk's plus the fenced commit's) over the run's one arbiter. */
function polishContext(r: ArcRun) {
  const { w } = walkContext(r);
  return { h: holisticContexts(w).checkpoint, w };
}

async function ticking<T>(r: ArcRun, f: (h: ReturnType<typeof polishContext>['h']) => Promise<T>): Promise<T> {
  const { h, w } = polishContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    return await f(h);
  } finally {
    clearInterval(tick);
  }
}

/** Admission as the scheduler gives it a polish unit: everything but a candidate its compare has not kept. */
const polishGate = (r: ArcRun, unit: string): Gate => (next) =>
  Promise.resolve(!(next.kind === 'admission' && next.stage === 'candidate' && tweakOf(r.journal.view, unit as UnitId)?.decision !== 'keep'));

/** Runs unit `id` of the plan in force through its pipeline under `gate`. */
async function run(r: ArcRun, id: string, gate: Gate) {
  const { w } = walkContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    return await runUnit(w.stage, unitInForce(r, id), gate);
  } finally {
    clearInterval(tick);
  }
}

/** The polish judge of compare `job`: it fetches both instances' entries into its evidence dir, then decides. */
function judgeStep(job: string, decision: 'keep' | 'drop'): Step {
  return {
    as: 'claude', unit: job,
    expect: { argv: ACTING_ARGV, argvLacks: ['--mcp-config', '--resume'], stdinContains: ['<before>', '<after>', '<tweak_diff>', 'design reference design/README.md (after)'] },
    acts: [
      { type: 'fetchFromPrompt', pattern: '<before>[\\s\\S]*?entry: (http://\\S+)', dirPattern: '<evidence_dir>([^<]+)</evidence_dir>', file: 'before.txt' },
      { type: 'fetchFromPrompt', pattern: '<after>[\\s\\S]*?entry: (http://\\S+)', dirPattern: '<evidence_dir>([^<]+)</evidence_dir>', file: 'after.txt' },
      { type: 'emit', value: { final: true, decision, evidence: ['before.txt', 'after.txt'], reasons: [`scripted ${decision}`], premises: [] } },
    ],
  };
}

const DROP_FILES = { 'design/README.md': '# Greeter design\n\nShout.\n', 'product/greeting.txt': 'HELLO\n' };
const NOREF_FILES = { 'product/greeting.txt': 'hi\n' };

describe('fix units and the polish loop (dev.13 agent D)', () => {
  test('polish.loop: four proposals → three admitted by code, one refused → compare keeps one, drops one (cut), code drops the reference-untouched one → the kept tweak lands → settled at the bound', T, async () => {
    const d = walkArc({ steps: unitSteps('u1', moduleFiles('mul', '*')), walkRounds: 2 });
    const round1 = walkAnswer({
      polish: [
        proposal(d, 'tw-keep', 'Configure the greeting and say so in the reference.'),
        proposal(d, 'tw-drop', 'Shout the greeting.'),
        proposal(d, 'tw-noref', 'A shorter greeting.'),
        // Its spec declares an obligation the arc does not hold: the classifier refuses its unit admitted alone.
        proposal(d, 'tw-bad', 'A tweak with a broken spec.', { obligations: ['I-9'] }),
      ],
    });
    appendSteps(d, [
      walkStep('walk-1', round1),
      ...polishSteps('tw-keep', KEEP_FILES), ...polishSteps('tw-drop', DROP_FILES), ...polishSteps('tw-noref', NOREF_FILES),
      judgeStep('compare-1', 'keep'), judgeStep('compare-2', 'drop'),
      { ...walkStep('walk-2', walkAnswer()), expect: { argv: ACTING_ARGV, argvLacks: ['--mcp-config', '--resume'], stdinContains: ['<evidence_dir>', 'X-1 (unit tw-keep): Configure the greeting'] } },
    ]);
    const r = contextFor(d);
    try {
      const u1 = await run(r, 'u1', () => Promise.resolve(true));
      assert.deepEqual(u1, { kind: 'merged' });
      const { ctx, w } = walkContext(r);
      const tick = setInterval(() => w.arbiter.wake(), 50);
      const w1 = await runWalk(ctx).finally(() => clearInterval(tick));
      assert.deepEqual(w1, { kind: 'ended', job: 'walk-1', outcome: 'reported', passed: true });
      assert.deepEqual(factsOf(r, 'walk-ended').map((f) => [f.proposals, f.dropped]), [[['X-1', 'X-2', 'X-3', 'X-4'], []]]);
      assert.equal(checkpointPending(polishContext(r).h), false, 'walk-1 opened nothing: its trigger has nothing new, no checkpoint');
      const m = milestonesOf(planOf(r))[0]!;
      const pending = milestoneProgress(r.journal.view, planOf(r), m, repairUnits(ctx));
      assert.ok(pending.kind === 'round-open' && pending.round.pending === 'polish', JSON.stringify(pending));

      // The polish revision: one revision admitting three units, the fourth refused with the classifier's reason.
      const applied = await ticking(r, applyPolish);
      assert.deepEqual(applied, { kind: 'applied', admitted: ['tw-keep', 'tw-drop', 'tw-noref'], refused: ['X-4'] });
      const [refusal] = factsOf(r, 'polish-refused');
      assert.equal(refusal!.proposal, 'X-4');
      assert.match(refusal!.reasons.join(' '), /I-9/);
      const revisions = factsOf(r, 'plan-applied').filter((f) => f.source.type === 'walk');
      assert.deepEqual(revisions.map((f) => f.source), [{ type: 'walk', job: 'walk-1' }]);
      for (const [id, x] of [['tw-keep', 'X-1'], ['tw-drop', 'X-2'], ['tw-noref', 'X-3']] as const) {
        const u = unitInForce(r, id);
        assert.deepEqual([u.origin, u.polish, u.risk, u.after, [...u.scope]], ['polish', { milestone: 'MS-1', proposal: x }, 'high', [], SCOPE], id);
      }
      assert.deepEqual(await ticking(r, applyPolish), { kind: 'none' }, 'nothing left to settle');

      // Each builds and is approved; its candidate waits for its compare.
      for (const id of ['tw-keep', 'tw-drop', 'tw-noref']) {
        assert.deepEqual(await run(r, id, polishGate(r, id)), { kind: 'held', needsUser: null }, `${id} waits at its candidate`);
        assert.equal(r.journal.view.unit(id as UnitId).decided?.outcome, 'approve');
      }

      // compare-1 keeps tw-keep: both instances up on their own ports, the judge walked both.
      assert.deepEqual(await ticking(r, runCompare), { kind: 'judged', unit: 'tw-keep', decision: 'keep', reason: 'judged' });
      const [c1] = factsOf(r, 'compare-started');
      assert.deepEqual([c1!.job, c1!.unit, c1!.before, c1!.after], ['compare-1', 'tw-keep', git(d.repo, 'rev-parse', 'main'), r.journal.view.unit('tw-keep' as UnitId).approval!.fingerprint.unitCommit]);
      assert.notEqual(c1!.ports.before['web' as never], c1!.ports.after['web' as never]);
      const ev1 = compareEvidenceDir(r.ctx, 'compare-1' as never);
      assert.match(readFileSync(join(ev1, 'before.txt'), 'utf8'), /^500 boom/, 'before: the integration tip has no greeting');
      assert.match(readFileSync(join(ev1, 'after.txt'), 'utf8'), /^200 hello/, 'after: the tweak configures it');
      assert.ok(existsSync(join(ev1, 'server-before', 'serve.web.stdout')) && existsSync(join(ev1, 'server-after', 'serve.web.stdout')));
      assert.deepEqual(r.journal.view.opsOf('proc.kill').filter((k) => k.expect.reason === 'teardown').length, 3, 'walk-1\'s serve and both compare instances torn down');

      // compare-2 drops tw-drop, which is cut `polish-dropped` by the compare's revision; nothing of it lands.
      assert.deepEqual(await ticking(r, runCompare), { kind: 'judged', unit: 'tw-drop', decision: 'drop', reason: 'judged' });
      assert.deepEqual(unitInForce(r, 'tw-drop').cut, { reason: 'polish-dropped' });
      assert.equal(r.journal.view.unit('tw-drop' as UnitId).status, 'cut');
      assert.deepEqual(factsOf(r, 'plan-applied').filter((f) => f.source.type === 'compare').map((f) => f.source), [{ type: 'compare', unit: 'tw-drop' }]);

      // tw-noref's diff leaves design/ untouched: code drops it, no compare job, no call.
      assert.deepEqual(await ticking(r, runCompare), { kind: 'judged', unit: 'tw-noref', decision: 'drop', reason: 'reference-untouched' });
      assert.equal(r.journal.view.unit('tw-noref' as UnitId).status, 'cut');
      assert.deepEqual(factsOf(r, 'compare-started').map((f) => f.job), ['compare-1', 'compare-2']);
      assert.deepEqual(factsOf(r, 'tweak-judged').map((f) => [f.unit, f.decision, f.reason]), [['tw-keep', 'keep', 'judged'], ['tw-drop', 'drop', 'judged'], ['tw-noref', 'drop', 'reference-untouched']]);
      assert.deepEqual(await ticking(r, runCompare), { kind: 'none' });

      // The kept tweak lands; round 2 is due (round 1 admitted three, one landed) and is shown the kept tweak.
      assert.deepEqual(await run(r, 'tw-keep', polishGate(r, 'tw-keep')), { kind: 'merged' });
      assert.equal(git(d.repo, 'show', 'main:product/greeting.txt'), 'hello');
      assert.deepEqual(milestoneProgress(r.journal.view, planOf(r), m, repairUnits(ctx)), { kind: 'walk-due', round: 2 });
      const tick2 = setInterval(() => w.arbiter.wake(), 50);
      const w2 = await runWalk(walkContext(r).ctx).finally(() => clearInterval(tick2));
      assert.deepEqual(w2, { kind: 'ended', job: 'walk-2', outcome: 'reported', passed: true });
      assert.equal(milestoneProgress(r.journal.view, planOf(r), m, repairUnits(ctx)).kind, 'settled', 'round 2 of 2: settled at the bound');
      assert.deepEqual(r.journal.view.openIntents(), []);
      assert.equal(/compare-[0-9]+\./.test(git(d.repo, 'worktree', 'list', '--porcelain')), false, 'no compare checkout left');
      assert.deepEqual(readCalls(d.scenarioPath).filter((c) => c.step === null), [], 'every backend call matched its step');
      assert.equal(readCalls(d.scenarioPath).filter((c) => c.unit === 'tw-noref' && c.step !== null).length, 3, 'tw-noref: plan-check, build, gate; no judge');
    } finally {
      r.journal.close();
    }
  });

  test('polish.classify: a polish unit only from the walk whose proposal it carries; the polish revision and the compare\'s cut change nothing else', T, async () => {
    const d = walkArc({ steps: unitSteps('u1', moduleFiles('mul', '*')), walkRounds: 2 });
    appendSteps(d, [walkStep('walk-1', walkAnswer({ polish: [proposal(d, 'tw-a', 'A tweak.')] }))]);
    const r = contextFor(d);
    try {
      await run(r, 'u1', () => Promise.resolve(true));
      const { ctx, w } = walkContext(r);
      const tick = setInterval(() => w.arbiter.wake(), 50);
      await runWalk(ctx).finally(() => clearInterval(tick));
      const view = r.journal.view;
      const inForce = requirePlanInForce(r.ctx.runDir, view);
      const current = inForceFiles(r.ctx.runDir, view, inForce, revisionInForce(r.ctx.runDir, inForce), w.commands.planFile, r.ctx.repo);
      const [x1] = factsOf(r, 'polish-proposed');
      const specPath = join(d.planPath, '..', 'tw-a.json') as never;
      const filesWith = (edit: (plan: Json & { units: Json[] }) => void) => {
        const raw = JSON.parse(current.planBytes.toString('utf8')) as Json & { units: Json[] };
        edit(raw);
        const planBytes = Buffer.from(JSON.stringify(raw));
        const plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
        return { ...current, plan, planBytes, specs: new Map([...current.specs, ['tw-a' as UnitId, { path: specPath, bytes: Buffer.from(x1!.unit.spec) }]]) };
      };
      const entry = (polish: Json): Json => ({ id: 'tw-a', spec: 'tw-a.json', risk: 'high', scope: SCOPE, resources: [], after: [], origin: 'polish', polish });
      const rctx = { runDir: r.ctx.runDir, view, hostDir: r.ctx.hostDir, planFile: w.commands.planFile, routingBase: w.commands.routingBase, laneEnv: w.commands.laneEnv };
      const reasons = (files: ReturnType<typeof filesWith>, proposer: Parameters<typeof evaluateRevision>[2]): string => {
        const v = evaluateRevision(rctx, files, proposer);
        return v.kind === 'rejected' ? v.reasons.join(' | ') : v.kind;
      };
      const good = filesWith((p) => p.units.push(entry({ milestone: 'MS-1', proposal: 'X-1' })));
      assert.equal(reasons(good, { type: 'walk', job: 'walk-1' as never }), 'accepted');
      assert.match(reasons(good, { type: 'apply' }), /tw-a is a polish unit: only the executor admits one, from a walkthrough's proposal, not a apply/);
      assert.match(reasons(good, { type: 'walk', job: 'walk-2' as never }), /carries proposal X-1, which is no proposal of walk-2/);
      assert.match(reasons(filesWith((p) => p.units.push({ ...entry({ milestone: 'MS-1', proposal: 'X-1' }), scope: ['design/**'] })), { type: 'walk', job: 'walk-1' as never }), /is not the unit proposal X-1 names/);
      const more = filesWith((p) => {
        p.units.push(entry({ milestone: 'MS-1', proposal: 'X-1' }));
        (p.units.find((u) => u['id'] === 'u3') as Json)['priority'] = 'high';
      });
      assert.match(reasons(more, { type: 'walk', job: 'walk-1' as never }), /only admits its polish units; it also changes .*unit-priority/);
      // The compare's cut: only of a unit judged drop, with the polish-dropped reason, and nothing else.
      const cutU3 = filesWith((p) => {
        (p.units.find((u) => u['id'] === 'u3') as Json)['cut'] = { reason: 'polish-dropped' };
      });
      assert.match(reasons(cutU3, { type: 'compare', unit: 'u3' as never }), /a compare cuts only a tweak it judged drop/);
    } finally {
      r.journal.close();
    }
  });
});

describe('the compare brake (lead ruling 2026-10-18)', () => {
  test('compare.abandoned-twice: a compare whose before does not come up is abandoned and retried once; the second abandonment drops the tweak (abandoned) and cuts it, with no model call', T, async () => {
    const d = await proposedArc(polishSteps('tw-keep', KEEP_FILES));
    const r = contextFor(d);
    try {
      await ticking(r, applyPolish);
      assert.deepEqual(await run(r, 'tw-keep', polishGate(r, 'tw-keep')), { kind: 'held', needsUser: null });
      // The integration tip's setup now fails, so the before instance never comes up.
      writeFileSync(join(d.repo, 'product', 'setup.js'), "process.stderr.write('setup: missing toolchain\\n'); process.exit(1);\n");
      git(d.repo, 'commit', '--quiet', '-am', 'break the setup');
      const first = await ticking(r, runCompare);
      assert.equal(first.kind, 'abandoned', JSON.stringify(first));
      assert.equal(tweakOf(r.journal.view, 'tw-keep' as UnitId), null, 'one retry left');
      assert.deepEqual(await ticking(r, runCompare), { kind: 'judged', unit: 'tw-keep', decision: 'drop', reason: 'abandoned' });
      assert.deepEqual(factsOf(r, 'compare-started').map((f) => f.job), ['compare-1', 'compare-2']);
      assert.deepEqual(factsOf(r, 'compare-abandoned').map((f) => [f.job, f.interrupted ?? false]), [['compare-1', false], ['compare-2', false]]);
      assert.deepEqual(unitInForce(r, 'tw-keep').cut, { reason: 'polish-dropped' });
      assert.equal(r.journal.view.unit('tw-keep' as UnitId).status, 'cut');
      assert.deepEqual(await ticking(r, runCompare), { kind: 'none' });
      assert.deepEqual(readCalls(d.scenarioPath).filter((c) => c.unit?.startsWith('compare-')), [], 'no judge was asked');
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The checkpoint's walk trigger (plan §4 "Class 1 and 2 go through the checkpoint")

describe('the checkpoint\'s walk trigger (dev.13 agent D)', () => {
  test('checkpoint.walk-trigger: a walk P1 nobody weighed triggers the checkpoint, its evidence dir readable and named; once weighed, nothing is due', T, async () => {
    const broken = walkAnswer({
      journeys: [{ journey: 'J-1', outcome: 'blocked' }, { journey: 'J-2', outcome: 'completed' }],
      findings: [{ class: 'breaks', journey: 'J-1', claim: 'GET / answers 500', cause: 'GET /: server error', against: { type: 'journey' }, paths: ['product/server.js'] }],
    });
    const d = walkArc({ steps: unitSteps('u1', moduleFiles('mul', '*')) });
    appendSteps(d, [
      walkStep('walk-1', broken),
      {
        as: 'claude', unit: 'ckpt-1',
        // The evidence dir lies under the run dir, which every judgment's read surface holds (judgmentReadDirs).
        expect: { argv: ['--add-dir', d.runDir], stdinContains: ['the walkthrough walk-1 of milestone MS-1 (round 1)', 'F-1', `${d.runDir}/evidence/jobs/walk-1`] },
        acts: [{ type: 'emit', value: checkpointAnswer({ decision: 'no-op' }) }],
      },
    ]);
    const r = contextFor(d);
    try {
      await run(r, 'u1', () => Promise.resolve(true));
      const { ctx, w } = walkContext(r);
      const tick = setInterval(() => w.arbiter.wake(), 50);
      try {
        await runWalk(ctx);
        const h = holisticContexts(w);
        assert.equal(checkpointPending(h.checkpoint), true, 'the walk\'s P1 is unweighed');
        const out = await runCheckpoint(h.checkpoint);
        assert.equal(out.kind, 'decided', JSON.stringify(out));
        const [captured] = factsOf(r, 'checkpoint-inputs');
        assert.deepEqual(captured!.trigger, { type: 'walk', job: 'walk-1' });
        assert.equal(checkpointPending(h.checkpoint), false, 'weighed: no checkpoint due');
        const m = milestonesOf(planOf(r))[0]!;
        assert.equal(milestoneProgress(r.journal.view, planOf(r), m, repairUnits(ctx)).kind, 'settled', 'the checkpoint decided nothing: the round admitted nothing');
      } finally {
        clearInterval(tick);
      }
      assert.deepEqual(readCalls(d.scenarioPath).filter((c) => c.step === null), [], 'every backend call matched its step');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash cells

/** An arc whose walk-1 proposed X-1 (tw-keep) and ended: the polish revision is due. */
async function proposedArc(steps: readonly Step[] = []) {
  const d = walkArc({ steps: unitSteps('u1', moduleFiles('mul', '*')), walkRounds: 2 });
  appendSteps(d, [walkStep('walk-1', walkAnswer({ polish: [proposal(d, 'tw-keep', 'Configure the greeting.')] })), ...steps]);
  const r = contextFor(d);
  try {
    await run(r, 'u1', () => Promise.resolve(true));
    const { ctx, w } = walkContext(r);
    const tick = setInterval(() => w.arbiter.wake(), 50);
    await runWalk(ctx).finally(() => clearInterval(tick));
  } finally {
    r.journal.close();
  }
  return d;
}

async function crashChild(d: ReturnType<typeof walkArc>, what: 'polish' | 'compare', label: string): Promise<void> {
  const trigger = writeTrigger(tmpDir(`${what}-crash`), { label, occurrence: 1 });
  const exit = await runFixture('polish-child.ts', [JSON.stringify(d), what], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
  assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
  assertFired(trigger);
}

async function recovered(d: ReturnType<typeof walkArc>): Promise<ArcRun> {
  const r = contextFor(d);
  const { ctx, w } = walkContext(r);
  await recover({ stage: ctx, commands: w.commands });
  return r;
}

describe(`matrix row ${POLISH_REVISION}`, () => {
  for (const { label } of crashCells(POLISH_REVISION)) {
    test(`polish.crash.${label}: the resumed polish revision settles every proposal once`, T, async () => {
      // tw-bad (X-2) is refused, tw-keep (X-1) admitted: both labels occur once.
      const d = walkArc({ steps: unitSteps('u1', moduleFiles('mul', '*')), walkRounds: 2 });
      appendSteps(d, [walkStep('walk-1', walkAnswer({ polish: [proposal(d, 'tw-keep', 'Configure the greeting.'), proposal(d, 'tw-bad', 'Broken.', { obligations: ['I-9'] })] }))]);
      const setup = contextFor(d);
      try {
        await run(setup, 'u1', () => Promise.resolve(true));
        const { ctx, w } = walkContext(setup);
        const tick = setInterval(() => w.arbiter.wake(), 50);
        await runWalk(ctx).finally(() => clearInterval(tick));
      } finally {
        setup.journal.close();
      }
      await crashChild(d, 'polish', label);
      const r = await recovered(d);
      try {
        const out = await ticking(r, applyPolish);
        if (label === 'polish.after-revision') assert.deepEqual(out, { kind: 'none' });
        else assert.deepEqual(out, { kind: 'applied', admitted: ['tw-keep'], refused: [] });
        assert.deepEqual(factsOf(r, 'polish-refused').map((f) => f.proposal), ['X-2']);
        assert.deepEqual(factsOf(r, 'plan-applied').filter((f) => f.source.type === 'walk').length, 1);
        assert.equal(unitInForce(r, 'tw-keep').origin, 'polish');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});

describe(`matrix row ${COMPARE_JOB}`, () => {
  for (const { label } of crashCells(COMPARE_JOB)) {
    test(`compare.crash.${label}: the resumed compare judges once, asks once, cuts once`, T, async () => {
      // The judge drops tw-keep, so every label (start, judged, cut) occurs once.
      const d = await proposedArc([...polishSteps('tw-keep', KEEP_FILES), judgeStep('compare-1', 'drop')]);
      const setup = contextFor(d);
      try {
        await ticking(setup, applyPolish);
        assert.deepEqual(await run(setup, 'tw-keep', polishGate(setup, 'tw-keep')), { kind: 'held', needsUser: null });
      } finally {
        setup.journal.close();
      }
      await crashChild(d, 'compare', label);
      const r = await recovered(d);
      try {
        const out = await ticking(r, runCompare);
        if (label === 'compare.after-cut') assert.deepEqual(out, { kind: 'none' });
        else if (label === 'compare.after-judged') assert.deepEqual(out, { kind: 'cut', unit: 'tw-keep', committed: true });
        else assert.deepEqual(out, { kind: 'judged', unit: 'tw-keep', decision: 'drop', reason: 'judged' });
        assert.deepEqual(await ticking(r, runCompare), { kind: 'none' });
        assert.deepEqual(factsOf(r, 'compare-started').map((f) => f.job), ['compare-1']);
        assert.deepEqual(factsOf(r, 'tweak-judged').map((f) => [f.unit, f.decision]), [['tw-keep', 'drop']]);
        assert.deepEqual(factsOf(r, 'plan-applied').filter((f) => f.source.type === 'compare').length, 1);
        assert.equal(r.journal.view.unit('tw-keep' as UnitId).status, 'cut');
        assert.equal(readCalls(d.scenarioPath).filter((c) => c.unit === 'compare-1').length, 1, 'the judge was asked once');
        assert.deepEqual(r.journal.view.openIntents(), []);
        assert.equal(/compare-1\./.test(git(d.repo, 'worktree', 'list', '--porcelain')), false, 'no compare checkout left');
        assert.equal(existsSync(join(compareEvidenceDir(r.ctx, 'compare-1' as never), 'after.txt')), true);
      } finally {
        r.journal.close();
      }
    });
  }
});

