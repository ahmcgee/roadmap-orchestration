// M4a rev 3 step N2 (B, C, H4, H5): a checkpoint's admit classes, conversions, busy deferral, evidence per test, ruling
// stamps and ids, split census moves, input manifest, embedded specs and closeout, over real corpus arcs (real git, real
// processes, the fake claude answering lens and checkpoint calls by job, the fake gh as the forge). Named tests:
// bundle.decision-persists-conversions, bundle.opportunity-joins-advances, bundle.opportunity-unwitnessed-converts, bundle.all-converted-no-op,
// bundle.follow-up-overrun-converts-with-debt, bundle.admit-targets-checked,
// bundle.recovery-no-reclassify, admits.architecture-doc-arc-unclassified, bundle.evidence-head-superset-accepted,
// bundle.evidence-equal-results-new-inv, bundle.evidence-outcome-changed-rejected, bundle.evidence-test-removed-rejected,
// bundle.evidence-malformed-or-empty-rejected, bundle.evidence-selection-loss-rejected,
// bundle.evidence-env-or-rev-differs-rejected, bundle.ruling-corpus-consistency-stamped, bundle.ruling-id-leading-zero,
// bundle.split-census-out-of-slice-moved, bundle.split-census-other-state-reason, bundle.busy-live-attempt,
// checkpoint.busy-waits-for-boundary (arc feedback 2026-10-24: the held bundle re-decided with no call),
// checkpoint.busy-redecide-stale-falls-back, classify.open-attempt-running-vs-abandoned, checkpoint.capture-waits-for-publication and
// checkpoint.capture-wait-bounded (paid M4a run 10, R-15), checkpoint.manifest-content-addressed,
// checkpoint.specs-embedded-with-occupied-ids, checkpoint.next-ruling-id, checkpoint.closeout-delta-when-unchanged,
// bundle.merged-since-capture-stale, bundle.merged-at-capture-invalid, checkpoint.refused-carried-across-triggers (paid M4a
// run 12), checkpoint.final-unchanged-skipped, checkpoint.resumed-equal-capture, checkpoint.skipped-nothing-new (arc feedback 2026-10-16), checkpoint.schema-closed-ids
// (paid M4b run 5).
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type EnvId,type InvocationId,type LaneId,type LaneRev,type Sha,type Sha256Hex,arcId,unitId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { sha256Hex } from '../src/core/json.ts';
import { evidenceDiffers,integrationHistory } from '../src/holistic/bundle.ts';
import { runCheckpoint } from '../src/holistic/checkpoint.ts';
import type { Observation } from '../src/holistic/observe.ts';
import type { WitnessRecord } from '../src/holistic/types.ts';
import { requirePlanInForce,revisionInForce } from '../src/input/inforce.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { status } from '../src/status.ts';
import { admitOp, checkpointContext, completedAudit, factsOfKind } from './fixtures/checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc } from './fixtures/corpus-holistic.ts';
import { VISION_PATH } from './fixtures/corpus-unit.ts';
import { stepTo, unitOf } from './fixtures/route-common.ts';
import { SCENARIO_TIMEOUT_MS,admitAll,planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, applyBody, contextFor, gateStep, mulBuild } from './fixtures/unit-common.ts';
import { reached,release } from './helpers/barrier.ts';
import { sampleCorpus } from './helpers/corpus.ts';
import { withForge } from './helpers/corpusarc.ts';
import { lensStep } from './helpers/holistic.ts';
import { git } from './helpers/repo.ts';
import { type Step,readCalls } from './helpers/scenario.ts';

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
const run = (x: Arc) => withForge(x.a.forge, () => runCheckpoint(x.ctx));
const decisions = (r: ArcRun) => factsOfKind(r, 'bundle-decided').map((f) => [f.job, f.outcome.kind === 'rejected' ? `rejected:${f.outcome.reason}` : f.outcome.kind]);
const callOf = (x: Arc, job: string) => {
  const c = readCalls(x.a.d.scenarioPath).find((y) => y.unit === job);
  assert.ok(c !== undefined, `${job} was called`);
  return c;
};
const ckptCalls = (x: Arc) => readCalls(x.a.d.scenarioPath).flatMap((c) => (c.unit?.startsWith('ckpt-') ? [c.unit] : []));
const planInForce = (r: ArcRun) => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
const bundleSources = (r: ArcRun) => factsOfKind(r, 'plan-applied').flatMap((f) => (f.source.type === 'bundle' ? [f.source] : []));

/** An admit of `id` (u1's spec renamed), citing `cites`. */
const admitCiting = (x: Arc, id: string, cites: readonly string[]): JsonValue => ({ ...(admitOp(x.a.d, id) as Json), cites: [...cites] } as JsonValue);
/** The same, before the arc is contextualised (a step scripted at setup). */
const admitStep = (a: CorpusHolisticArc, id: string, cites: readonly string[]): JsonValue => ({ ...(admitOp(a.d, id) as Json), cites: [...cites] } as JsonValue);

describe('admit classes and conversions in a corpus arc (B)', () => {
});

function requireSpecSha(r: ArcRun, unit: string): string {
  const sha = r.journal.view.planApplied()!.specs[unit as never];
  assert.ok(sha !== undefined, `${unit} has a spec in force`);
  return sha;
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

  test('bundle.evidence-head-superset-accepted: the head records every cited test with its outcome, and more', () => {
    assert.equal(evidenceDiffers(cited, observation([t('a', 'pass'), t('b', 'fail'), t('c', 'pass')], { treeSha: '2'.repeat(40) as Sha, inv: 'arc/2-1' as InvocationId })), null);
  });

  test('bundle.evidence-equal-results-new-inv: equal results under another invocation and tree hold (the records\' hashes differ)', () => {
    const head = observation([t('a', 'pass'), t('b', 'fail')], { treeSha: '2'.repeat(40) as Sha, inv: 'arc/9-1' as InvocationId });
    assert.notEqual(head.recordsSha256, cited.recordsSha256);
    assert.equal(evidenceDiffers(cited, head), null);
  });

  test('bundle.evidence-outcome-changed-rejected', () => {
    assert.match(evidenceDiffers(cited, observation([t('a', 'fail'), t('b', 'fail')]))!, /test "a" was pass, is fail on the head/);
  });

  test('bundle.evidence-test-removed-rejected', () => {
    assert.match(evidenceDiffers(cited, observation([t('a', 'pass')]))!, /test "b" is not in the head's record/);
  });

  test('bundle.evidence-malformed-or-empty-rejected', () => {
    assert.equal(evidenceDiffers(observation([], { malformed: true }), cited), 'is malformed');
    assert.equal(evidenceDiffers(cited, observation([], { malformed: true })), 'is malformed on the head');
    assert.equal(evidenceDiffers(observation([]), cited), 'records no test');
  });

  test('bundle.evidence-selection-loss-rejected', () => {
    assert.match(evidenceDiffers(observation([t('a', 'pass', 3)]), observation([t('a', 'pass', 2)]))!, /selected 3, 2 on the head/);
  });

  test('bundle.evidence-env-or-rev-differs-rejected', () => {
    assert.match(evidenceDiffers(cited, observation([t('a', 'pass'), t('b', 'fail')], { envId: 'ffffffffffffffff' as EnvId }))!, /in env eeeeeeeeeeeeeeee, the head's under/);
    assert.match(evidenceDiffers(cited, observation([t('a', 'pass'), t('b', 'fail')], { laneRev: 'bbbbbbbbbbbbbbbb' as LaneRev }))!, /ran under lane rev aaaaaaaaaaaaaaaa/);
  });
});

// ---------------------------------------------------------------------------------------------------
// C2–C4: rulings and split census

/** A checkpoint ruling's JSON text `id` (the executor stamps `ruledBy` and `consistency`). */
const ruling = (id: string): string => JSON.stringify({
  schema: 'roadmap/ruling-m3', id, statement: `A berth is held until its window closes (${id}).`, kind: 'decision', trigger: 'checkpoint',
  supersedes: [], condition: null, docRefs: [{ path: 'docs/corpus/0010_Overview.md', anchor: 'Scope', quotedText: 'berth', relation: 'consistent' }], contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: ['V-1'],
  evidence: ['audit-1'], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
});
const ruleOp = (id: string): JsonValue => ({ op: 'rule', ruling: id, cites: ['V-1'], evidence: ['audit-1'] });

const splitTo = (rule: string): JsonValue => ({
  op: 'obligation-split', obligation: 'I-1', cites: ['V-1'], evidence: ['audit-1 found I-1 too coarse'],
  children: [{ id: 'I-2', statement: 'A berth is never double-booked.', docRef: null, rule, witness: { lane: 'journey', testIds: ['t1'], files: [] }, activation: 'must-hold', deliveredBy: [] }],
});
const census = (r: ArcRun) => revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view)).obligations!.value.census;

describe('rulings and split census (C2–C4)', () => {
});

// ---------------------------------------------------------------------------------------------------
// C5: busy

const pcBarrier = { type: 'barrier', name: 'pc', timeoutMs: 120_000 } as const;
const limitsU1: JsonValue = { op: 'limits', unit: 'u1', limits: [{ field: 'chargeable', value: 2 }], cites: ['V-1'], evidence: ['audit-1'] };

describe('busy: a bundle touching a unit mid-stage waits for its boundary (C5, R50)', () => {

  test('classify.open-attempt-running-vs-abandoned: an attempt an executor restart found open does not refuse an edit (arc feedback 2026-10-15: the startup records it); the revision is pending', T, async () => {
    const pc = planCheckStep({ decision: 'approve' });
    const x = await arc([{ ...pc, acts: [pcBarrier, ...pc.acts] } as Step], { audit: false });
    try {
      const unit = stepTo(x.ctx, 'u1', (f) => f.stage === 'plan-check');
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
// R-15 (paid M4a run 10): the capture waits at the publication boundary

const gateBarrier = { type: 'barrier', name: 'gate', timeoutMs: 120_000 } as const;
const toGate = (): readonly Step[] => [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }, {}, [gateBarrier])];

describe('the capture waits for a publication in flight (R-15)', () => {
});

// ---------------------------------------------------------------------------------------------------
// H4, H5: the checkpoint's inputs

/** The text of a tag in a prompt. */
const tagOf = (stdin: string, tag: string): string => {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(stdin);
  assert.ok(m !== null, `the prompt has <${tag}>`);
  return m[1]!;
};

describe('the checkpoint\'s inputs (H4, H5)', () => {

});

describe('a unit merged around the capture (paid M4a run 10)', () => {
  const patchU1: JsonValue = { op: 'patch-spec', unit: 'u1', patch: [{ op: 'cite', contracts: ['contracts/api.md'], rulings: [] }], cites: ['V-1'], evidence: ['audit-1'] };
  const toMerge = (): readonly Step[] => [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })];
  const ckptBarrier = { type: 'barrier', name: 'ckpt', timeoutMs: 120_000 } as const;
});

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
