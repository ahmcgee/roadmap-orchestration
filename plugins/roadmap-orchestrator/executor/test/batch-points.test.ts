// dev.17 lane topology: the batch points (src/pipeline/batchlanes.ts `runBatchPoint`), where a holistic plan's `batch` suite
// lanes run, over real arcs (real git, real processes, the fake claude answering walk and lens calls by job). Named tests:
// batch.walk-red (code's walkthrough P1 naming the lane, in the walk's findings, the node held), batch.walk-green,
// batch.walk-skips-green-input (round 2 on an unchanged input runs no batch lane), batch.audit-red (a witness P1 over no
// obligation), batch.closeout-nothing-to-change (red refuses, green passes; the lane runs each time).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { commandId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { runAudit } from '../src/holistic/audit.ts';
import { publishCloseOut } from '../src/pipeline/publish.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { holisticContexts } from '../src/schedule/scheduler.ts';
import { runWalk } from '../src/walk/walk.ts';
import { lensStep } from './helpers/holistic.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { auditArc, auditContext, moduleFiles, unitSteps } from './fixtures/audit-common.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { applyPlanEdit } from './fixtures/checkpoint-common.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { wired } from './fixtures/sched-m3-common.ts';
import { type LaneJson, SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, SUITE_LANE, codexStep, contextFor, gateStep } from './fixtures/unit-common.ts';
import { BROKEN_WALK, GREETING, unitInForce, walkAnswer, walkArc, walkContext, walkStep } from './fixtures/walk-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS * 2 };
type Json = Record<string, unknown>;

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const factsOf = <K extends Fact['kind']>(r: ArcRun, kind: K) => facts(r).filter((f): f is Extract<Fact, { kind: K }> => f.kind === kind);

/** A batch lane: green while `marker` is absent, red (exit 1) while it exists. */
const batchLane = (marker: string, extra: Partial<LaneJson> = {}): LaneJson => ({
  id: 'batch', cadence: 'batch', argv: ['node', '-e', "process.exit(require('node:fs').existsSync(process.argv[1]) ? 1 : 0)", marker], ...extra,
});
const GREEN = (): string => join(tmpDir('batch-marker'), 'red');
const RED = (): string => {
  const marker = join(tmpDir('batch-marker'), 'red');
  writeFileSync(marker, 'red\n');
  return marker;
};

/** Journey spawns of the batch lane, as [owner job, at]. */
const batchSpawns = (r: ArcRun): readonly (readonly [string, string])[] => intents(r.ctx.runDir, 'proc.spawn').flatMap((i) => {
  if (i.kind !== 'proc.spawn') return [];
  const s = i.expect.subject;
  if (s.purpose === 'lane' && s.lane === 'batch') throw new Error(`the batch lane ran as a series lane under ${JSON.stringify(i.parent)}`);
  return s.purpose === 'journey' && s.lane === 'batch' && s.owner.type === 'job' ? [[s.owner.job as string, s.at as string] as const] : [];
});

/** Runs unit `id` of the plan in force to its merge, the arbiter ticking. */
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

describe('the milestone batch point (dev.17)', () => {
  test('batch.walk-red: a red batch lane opens code\'s walkthrough P1 naming it; the walk goes on, its findings include it, and the node is not passed', T, async () => {
    const d = walkArc({ steps: [...unitSteps('u1', moduleFiles('mul', '*')), walkStep('walk-1', walkAnswer())], suite: [SUITE_LANE, batchLane(RED())] });
    const r = contextFor(d);
    try {
      await merge(r, 'u1');
      assert.deepEqual(batchSpawns(r), [], 'the merge path never runs a batch lane');
      const out = await walk(r);
      assert.deepEqual(out, { kind: 'ended', job: 'walk-1', outcome: 'reported', passed: false });
      const [started] = factsOf(r, 'walk-started');
      assert.deepEqual(batchSpawns(r).map(([job]) => job).filter((j, i, all) => all.indexOf(j) === i), ['walk-1']);
      assert.ok(batchSpawns(r).every(([, at]) => at === started!.sha), 'on the walked SHA');
      const opened = factsOf(r, 'finding-opened');
      assert.equal(opened.length, 1, JSON.stringify(opened));
      const [f] = opened;
      assert.deepEqual([f!.lens, f!.severity, f!.milestone, f!.obligation, f!.lane, f!.source, f!.cause], ['walkthrough', 'P1', 'MS-1', null, 'batch', { type: 'job', job: 'walk-1' }, 'batch lane batch red']);
      assert.deepEqual(factsOf(r, 'walk-ended').map((e) => [e.job, e.findings]), [['walk-1', [f!.id]]]);
      assert.deepEqual(factsOf(r, 'milestone-passed'), [], 'the batch P1 holds the node');
      assert.equal(readCalls(d.scenarioPath).filter((c) => c.unit === 'walk-1').length, 1, 'the walkthrough still ran');
    } finally {
      r.journal.close();
    }
  });

  test('batch.walk-green: a green batch lane opens nothing and the node passes as before', T, async () => {
    const d = walkArc({ steps: [...unitSteps('u1', moduleFiles('mul', '*')), walkStep('walk-1', walkAnswer())], suite: [SUITE_LANE, batchLane(GREEN())] });
    const r = contextFor(d);
    try {
      await merge(r, 'u1');
      assert.deepEqual(await walk(r), { kind: 'ended', job: 'walk-1', outcome: 'reported', passed: true });
      assert.deepEqual(batchSpawns(r).map(([job]) => job), ['walk-1']);
      assert.deepEqual(factsOf(r, 'finding-opened'), []);
      assert.deepEqual(factsOf(r, 'walk-ended').map((e) => [e.job, e.findings]), [['walk-1', []]]);
      assert.deepEqual(factsOf(r, 'milestone-passed'), [{ kind: 'milestone-passed', milestone: 'MS-1', job: 'walk-1' }]);
    } finally {
      r.journal.close();
    }
  });

  test('batch.walk-skips-green-input: round 2, after a repair outside the lane\'s systems, does not run the batch lane green on that input', T, async () => {
    const r1Steps: readonly Step[] = [
      { ...planCheckStep({ decision: 'approve' }), unit: 'r1' },
      { ...codexStep([{ type: 'commit', message: 'configure the greeting', files: GREETING }], { argv: ['exec', '-C'] }), unit: 'r1' },
      { ...gateStep({ decision: 'approve' }), unit: 'r1' },
    ];
    const d = walkArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), walkStep('walk-1', BROKEN_WALK), ...r1Steps, walkStep('walk-2', walkAnswer())],
      suite: [SUITE_LANE, batchLane(GREEN(), { systems: ['math'] })],
      systemsMap: { systems: { math: { paths: ['src/**'], tests: ['test/**'] }, product: { paths: ['product/**'] } }, docs: ['design/**', '*.md'] },
    });
    const r = contextFor(d);
    try {
      await merge(r, 'u1');
      assert.deepEqual(await walk(r), { kind: 'ended', job: 'walk-1', outcome: 'reported', passed: false });
      assert.deepEqual(batchSpawns(r).map(([job]) => job), ['walk-1']);
      assert.deepEqual(factsOf(r, 'finding-opened').map((f) => [f.id, f.lane ?? null]), [['F-1', null]], 'only the walkthrough\'s P1');
      // The repair (the scripted checkpoint's admit) changes only product/**: the batch lane's input is unchanged.
      const planDir = join(d.planPath, '..');
      const spec = JSON.parse(readFileSync(join(planDir, 'u1.json'), 'utf8')) as Json;
      writeFileSync(join(planDir, 'r1.json'), JSON.stringify({ ...spec, unit: 'r1', rev: 1, repairs: ['F-1'], scope: ['product/**', 'src/**', 'test/**'] }));
      await applyPlanEdit(r, walkContext(r).w as never, (plan) => {
        (plan['units'] as Json[]).push({ id: 'r1', spec: 'r1.json', risk: 'med', scope: ['product/**', 'src/**', 'test/**'], resources: [], origin: 'repair' });
      });
      await merge(r, 'r1');
      assert.deepEqual(await walk(r), { kind: 'ended', job: 'walk-2', outcome: 'reported', passed: true });
      const [, second] = factsOf(r, 'walk-started');
      assert.notEqual(second!.sha, factsOf(r, 'walk-started')[0]!.sha, 'round 2 walked a new SHA');
      assert.deepEqual(batchSpawns(r).map(([job]) => job), ['walk-1'], 'round 2 reused the green run on the same input');
      assert.deepEqual(factsOf(r, 'milestone-passed'), [{ kind: 'milestone-passed', milestone: 'MS-1', job: 'walk-2' }]);
    } finally {
      r.journal.close();
    }
  });
});

describe('the audit batch point (dev.17)', () => {
  test('batch.audit-red: in an arc without milestones, a red batch lane opens a witness P1 over no obligation naming it, in the audit\'s findings', T, async () => {
    const { d } = auditArc({
      steps: [lensStep('audit-1', 'vision')], units: [{ id: 'u1' }],
      obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass' } } }, mapping: [], audit: { lenses: ['vision'] },
      suite: [SUITE_LANE, batchLane(RED())],
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const tick = setInterval(() => w.arbiter.wake(), 50);
    try {
      r.journal.fact({ kind: 'audit-requested', command: commandId(`cmd-${'1'.padStart(16, 'b')}`), lenses: ['vision'] });
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      const [started] = factsOf(r, 'audit-started');
      assert.ok(batchSpawns(r).length > 0 && batchSpawns(r).every(([job, at]) => job === 'audit-1' && at === started!.integrationSha), JSON.stringify(batchSpawns(r)));
      const opened = factsOf(r, 'finding-opened');
      assert.equal(opened.length, 1, JSON.stringify(opened));
      const [f] = opened;
      assert.deepEqual([f!.lens, f!.severity, f!.obligation, f!.lane, f!.milestone ?? null, f!.source], ['witness', 'P1', null, 'batch', null, { type: 'job', job: 'audit-1' }]);
      assert.deepEqual(factsOf(r, 'audit-ended').map((e) => [e.job, e.findings]), [['audit-1', [f!.id]]]);
    } finally {
      clearInterval(tick);
      r.journal.close();
    }
  });
});

describe('the close-out batch point (dev.17)', () => {
  test('batch.closeout-nothing-to-change: with the renderings on the head, a red batch lane refuses the close-out and a green one passes it; the lane runs fresh each time', T, async () => {
    const marker = GREEN();
    const { d } = holisticArc({
      steps: [], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: [], trees: { '*': { outcomes: { t1: 'pass' } } },
      suite: [SUITE_LANE, batchLane(marker)],
    });
    const r = contextFor(d);
    const w = wired(r);
    const h = holisticContexts(w);
    const tick = setInterval(() => w.arbiter.wake(), 50);
    try {
      const published = await publishCloseOut(h.docs);
      assert.equal(published.kind, 'published', JSON.stringify(published));
      const ran = batchSpawns(r).length;
      assert.ok(ran > 0, 'the publication ran the batch lane');

      writeFileSync(marker, 'red\n');
      const refused = await publishCloseOut(h.docs);
      assert.ok(refused.kind === 'refused' && /batch lane batch is /.test(refused.reason), JSON.stringify(refused));
      const afterRed = batchSpawns(r).length;
      assert.ok(afterRed > ran, 'the nothing-to-change branch ran the batch lane');

      rmSync(marker);
      assert.equal(existsSync(marker), false);
      const head = git(d.repo, 'rev-parse', 'main');
      const passed = await publishCloseOut(h.docs);
      assert.deepEqual(passed, { kind: 'nothing-to-change', head });
      assert.equal(batchSpawns(r).length, afterRed + 1, 'run fresh on the same head, though a green run there would reuse');
      assert.ok(batchSpawns(r).slice(ran).every(([, at]) => at === head), 'on the head');
    } finally {
      clearInterval(tick);
      r.journal.close();
    }
  });
});
