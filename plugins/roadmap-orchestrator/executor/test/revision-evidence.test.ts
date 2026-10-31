// Per-test evidence comparison, root revision concurrency, and audit integration-history coverage.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type EnvId,type InvocationId,type LaneId,type LaneRev,type Sha,type Sha256Hex,arcId,unitId } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { evidenceDiffers,integrationHistory } from '../src/holistic/bundle.ts';
import type { Observation } from '../src/holistic/observe.ts';
import type { WitnessRecord } from '../src/holistic/types.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { status } from '../src/status.ts';
import { checkpointContext, completedAudit, factsOfKind } from './fixtures/checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc } from './fixtures/corpus-holistic.ts';
import { VISION_PATH } from './fixtures/corpus-unit.ts';
import { stepTo, unitOf } from './fixtures/route-common.ts';
import { SCENARIO_TIMEOUT_MS,admitAll,planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, applyBody, contextFor, gateStep, mulBuild } from './fixtures/unit-common.ts';
import { reached,release } from './helpers/barrier.ts';
import { sampleCorpus } from './helpers/corpus.ts';
import { lensStep } from './helpers/holistic.ts';
import { git } from './helpers/repo.ts';
import { type Step } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Json = Record<string, unknown>;

/** The corpus arc's vision with two more world clauses outside the slice (advances = [V-1]): V-3 and V-4. */
function visionWithHorizon(): string {
  const text = sampleCorpus().files[VISION_PATH]!;
  return `${JSON.stringify({
    schema: 'roadmap/vision-m3', rev: 1, confirmation: { ref: `corpus:0005_Vision.md#sha256:${sha256Hex(text)}`, at: '2026-10-01T00:00:00.000Z' },
    clauses: [
      { id: 'V-1', kind: 'world', text: 'Every vessel finds a berth.', rank: null, state: 'active' },
      { id: 'V-2', kind: 'purpose', text: 'A calm harbour.', rank: null, state: 'active' },
      { id: 'V-3', kind: 'world', text: 'A cancelled berth goes back to the pool.', rank: null, state: 'active' },
      { id: 'V-4', kind: 'world', text: 'The harbour master sees the day at a glance.', rank: null, state: 'active' },
    ],
    questions: [],
  }, null, 2)}\n`;
}

type Arc = Readonly<{ a: CorpusHolisticArc; r: ArcRun; ctx: ReturnType<typeof checkpointContext>['ctx']; w: ReturnType<typeof checkpointContext>['w'] }>;

/** A corpus arc with the horizon vision, `steps` after audit-1's vision lens, audit-1 completed; `before` edits the plan dir before revision 1. */
async function arc(steps: readonly Step[], opts: Readonly<{ before?: (a: CorpusHolisticArc) => void; audit?: boolean }> = {}): Promise<Arc> {
  const a = await corpusHolisticArc([lensStep('audit-1', 'vision'), ...steps], { baseline: { '.roadmap/vision.json': visionWithHorizon() } });
  opts.before?.(a);
  const r = contextFor(a.d);
  const { ctx, w } = checkpointContext(r);
  if (opts.audit !== false) await completedAudit(r, ctx);
  return { a, r, ctx, w };
}
// ---------------------------------------------------------------------------------------------------
// C1: the per-test evidence comparator (pure)

const LANE = 'journey' as LaneId;
function observation(records: WitnessRecord['records'], over: Partial<Pick<WitnessRecord, 'laneRev' | 'envId' | 'malformed' | 'inv' | 'treeSha'>> = {}): Observation {
  const record = {
    v: 2, lane: LANE, laneRev: (over.laneRev ?? 'aaaaaaaaaaaaaaaa') as LaneRev, envId: (over.envId ?? 'eeeeeeeeeeeeeeee') as EnvId, treeSha: (over.treeSha ?? '1'.repeat(40)) as Sha,
    inv: (over.inv ?? 'arc/1-1') as InvocationId, runner: 'jsonl', purpose: 'witness', records, malformed: over.malformed ?? false,
  } as unknown as WitnessRecord;
  return {
    key: { treeSha: record.treeSha, lane: LANE, laneRev: record.laneRev, envId: record.envId }, reuse: { inputSha: record.treeSha, lane: LANE, laneRev: record.laneRev, envId: record.envId },
    recordsSha256: sha256Hex(JSON.stringify(record)) as Sha256Hex, record, seq: 1,
  };
}
const t = (testId: string, outcome: 'pass' | 'fail' | 'skip', selected = 1) => ({ testId, outcome, selected });

describe('the evidence base, per test (C1, R58)', () => {
  const cited = observation([t('a', 'pass'), t('b', 'fail')]);

  test('revision.evidence-head-superset-accepted: the head records every cited test with its outcome, and more', () => {
    assert.equal(evidenceDiffers(cited, observation([t('a', 'pass'), t('b', 'fail'), t('c', 'pass')], { treeSha: '2'.repeat(40) as Sha, inv: 'arc/2-1' as InvocationId })), null);
  });

  test('revision.evidence-equal-results-new-inv: equal results under another invocation and tree hold (the records\' hashes differ)', () => {
    const head = observation([t('a', 'pass'), t('b', 'fail')], { treeSha: '2'.repeat(40) as Sha, inv: 'arc/9-1' as InvocationId });
    assert.notEqual(head.recordsSha256, cited.recordsSha256);
    assert.equal(evidenceDiffers(cited, head), null);
  });

  test('revision.evidence-outcome-changed-rejected', () => {
    assert.match(evidenceDiffers(cited, observation([t('a', 'fail'), t('b', 'fail')]))!, /test "a" was pass, is fail on the head/);
  });

  test('revision.evidence-test-removed-rejected', () => {
    assert.match(evidenceDiffers(cited, observation([t('a', 'pass')]))!, /test "b" is not in the head's record/);
  });

  test('revision.evidence-malformed-or-empty-rejected', () => {
    assert.equal(evidenceDiffers(observation([], { malformed: true }), cited), 'is malformed');
    assert.equal(evidenceDiffers(cited, observation([], { malformed: true })), 'is malformed on the head');
    assert.equal(evidenceDiffers(observation([]), cited), 'records no test');
  });

  test('revision.evidence-selection-loss-rejected', () => {
    assert.match(evidenceDiffers(observation([t('a', 'pass', 3)]), observation([t('a', 'pass', 2)]))!, /selected 3, 2 on the head/);
  });

  test('revision.evidence-env-or-rev-differs-rejected', () => {
    assert.match(evidenceDiffers(cited, observation([t('a', 'pass'), t('b', 'fail')], { envId: 'ffffffffffffffff' as EnvId }))!, /in env eeeeeeeeeeeeeeee, the head's under/);
    assert.match(evidenceDiffers(cited, observation([t('a', 'pass'), t('b', 'fail')], { laneRev: 'bbbbbbbbbbbbbbbb' as LaneRev }))!, /ran under lane rev aaaaaaaaaaaaaaaa/);
  });
});

const pcBarrier = {type: 'barrier', name: 'pc', timeoutMs: 120_000} as const;
describe('root apply while an attempt is live or abandoned', () => {

  test('classify.open-attempt-running-vs-abandoned: an attempt an executor restart found open does not refuse an edit (arc feedback 2026-10-15: the startup records it); the revision is pending', T, async () => {
    const pc = planCheckStep({ decision: 'approve' });
    const x = await arc([{ ...pc, acts: [pcBarrier, ...pc.acts] } as Step], { audit: false });
    try {
      const unit = stepTo(x.ctx, 'u1', (f) => f.stage === 'pre-build');
      await reached(x.a.d.scenarioDir, 'pc', 120_000);
      x.r.journal.fact({ kind: 'executor-started', generation: 99 });
      const spec = join(x.a.planDir, 'u1.json');
      const was = readFileSync(spec, 'utf8');
      writeFileSync(spec, JSON.stringify({ ...(JSON.parse(was) as Json), rev: 2 }));
      const applied = await applyCommand(x.w.commands, submitCommand(x.r.ctx.runDir, x.r.journal.view.arc, applyBody(x.a.d)));
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      assert.equal(x.r.journal.view.unit(unitId('u1')).pendingRevision?.rev, 2);
      writeFileSync(spec, was);
      release(x.a.d.scenarioDir, 'pc');
      await unit;
    } finally {
      x.r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('an owner commit on the integration branch (dev.13 arc, audit-24)', () => {
  test('history.unpublished-head-resolves: an audit ending on a commit the owner put on the branch places it at its nearest published ancestor', T, async () => {
    const x = await arc([planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }), lensStep('audit-2', 'invariants')]);
    try {
      assert.deepEqual(await runUnit(x.ctx, unitOf(x.ctx, 'u1'), admitAll), { kind: 'merged' });
      const ref = `refs/heads/${x.ctx.plan().integrationBranch}`;
      const published = git(x.ctx.repo, 'rev-parse', ref);
      const owner = git(x.ctx.repo, 'commit-tree', `${published}^{tree}`, '-p', published, '-m', 'vision rev 2');
      git(x.ctx.repo, 'update-ref', ref, owner, published);
      await completedAudit(x.r, x.ctx);
      const ended = factsOfKind(x.r, 'audit-ended').find((f) => f.job === 'audit-2');
      assert.ok(ended?.covered.some((c) => c.to === owner), 'audit-2 ends on the owner commit');
      const history = integrationHistory(x.r.journal.view, x.ctx.repo, owner as Sha);
      assert.equal(history.positions.get(published as Sha), 1, 'u1 is the first published head');
      assert.deepEqual(history.audits.get('audit-2' as never)?.map((r) => r.to), [1], 'the owner commit sits at u1\'s position');
      status(x.r.ctx.runDir, arcId(x.r.d.arc), x.r.ctx.hostDir);
    } finally {
      x.r.journal.close();
    }
  });
});
