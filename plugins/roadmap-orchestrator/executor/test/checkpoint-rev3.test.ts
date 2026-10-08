// M4a rev 3 step N2 (B, C, H4, H5): a checkpoint's admit classes, conversions, busy deferral, evidence per test, ruling
// stamps and ids, split census moves, input manifest, embedded specs, closeout and issue reuse, over real corpus arcs (real
// git, real processes, the fake claude answering lens and checkpoint calls by job, the fake gh as the forge). Named tests:
// bundle.decision-persists-conversions, bundle.opportunity-joins-advances, bundle.all-converted-no-op,
// bundle.follow-up-overrun-converts-with-debt, bundle.admit-targets-checked,
// bundle.recovery-no-reclassify, admits.architecture-doc-arc-unclassified, bundle.evidence-head-superset-accepted,
// bundle.evidence-equal-results-new-inv, bundle.evidence-outcome-changed-rejected, bundle.evidence-test-removed-rejected,
// bundle.evidence-malformed-or-empty-rejected, bundle.evidence-selection-loss-rejected,
// bundle.evidence-env-or-rev-differs-rejected, bundle.ruling-corpus-consistency-stamped, bundle.ruling-id-leading-zero,
// bundle.split-census-out-of-slice-moved, bundle.split-census-other-state-reason, bundle.busy-live-attempt,
// checkpoint.busy-waits-for-boundary, classify.open-attempt-running-vs-abandoned, checkpoint.capture-waits-for-publication and
// checkpoint.capture-wait-bounded (paid M4a run 10, R-15), checkpoint.manifest-content-addressed,
// checkpoint.specs-embedded-with-occupied-ids, checkpoint.next-ruling-id, checkpoint.closeout-delta-when-unchanged,
// bundle.merged-since-capture-stale, bundle.merged-at-capture-invalid, checkpoint.refused-carried-across-triggers (paid M4a
// run 12), checkpoint.final-always-full, intake.unchanged-capture-reuses-dispositions, intake.changed-ground-relists.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { EnvId, InvocationId, LaneId, LaneRev, Sha, Sha256Hex } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { sha256Hex } from '../src/core/json.ts';
import { evidenceDiffers, numericId, numericRulingIds } from '../src/holistic/bundle.ts';
import { CAPTURE_WAIT_MAX_MIN, publishing, runCheckpoint } from '../src/holistic/checkpoint.ts';
import type { Observation } from '../src/holistic/observe.ts';
import type { WitnessRecord } from '../src/holistic/types.ts';
import { requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { validateCheckpointOutput } from '../src/prompts/schemas.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { withForge } from './helpers/corpusarc.ts';
import { sampleCorpus } from './helpers/corpus.ts';
import { VALID_OP, checkpointAnswer, checkpointStep, intakeOutcome, lensStep } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { admitOp, applyPlanEdit, checkpointArc, checkpointContext, completedAudit, factsOfKind, visionLenses } from './fixtures/checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc, forgeEnv } from './fixtures/corpus-holistic.ts';
import { VISION_PATH } from './fixtures/corpus-unit.ts';
import { followContext, stepTo, unitOf } from './fixtures/route-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, applyBody, contextFor, gateStep, mulBuild } from './fixtures/unit-common.ts';

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
  test('bundle.decision-persists-conversions: an unrelated admit converts beside an applied op: the revision\'s source holds the classes and conversions, the amendment follows', T, async () => {
    const x = await arc([]);
    try {
      appendSteps(x.a.d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [VALID_OP, admitCiting(x, 'aside', ['V-2'])] }))]);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      assert.deepEqual(bundleSources(x.r), [{ type: 'bundle', job: 'ckpt-1', admits: [], conversions: [{ index: 1, unit: 'aside', reason: 'unrelated', opportunity: null }] }]);
      assert.ok(!planInForce(x.r).units.some((u) => u.id === 'aside'), 'the converted admit is dropped');
      assert.equal(planInForce(x.r).limits?.convergenceK, 3, 'the rest applies');
      const [m] = factsOfKind(x.r, 'corpus-amendment').filter((f) => f.source.type === 'admit');
      assert.deepEqual(m?.source, { type: 'admit', job: 'ckpt-1', index: 1, reason: 'unrelated' });
      assert.match(m!.proposal, /^Admit unit aside \(origin checkpoint, risk med/);
    } finally {
      x.r.journal.close();
    }
  });

  test('bundle.opportunity-joins-advances: honest work outside the slice is opportunity O-1; its clause joins holistic.advances in the same revision', T, async () => {
    const x = await arc([]);
    try {
      appendSteps(x.a.d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [admitCiting(x, 'more', ['V-1', 'V-3'])] }))]);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      assert.deepEqual(bundleSources(x.r), [{ type: 'bundle', job: 'ckpt-1', admits: [{ index: 0, unit: 'more', class: { type: 'opportunity', id: 'O-1', clauses: ['V-3'] } }], conversions: [] }]);
      assert.deepEqual(planInForce(x.r).holistic?.advances, ['V-1', 'V-3']);
    } finally {
      x.r.journal.close();
    }
  });

  test('bundle.admit-targets-checked (LR-m): a declared out-of-slice target without an out-of-slice cite is invalid; the honest retry is O-1', T, async () => {
    const x = await arc([]);
    try {
      const withTargets = (cites: readonly string[]): JsonValue => ({ ...(admitCiting(x, 'more', cites) as Json), targets: ['T-2'] } as JsonValue);
      appendSteps(x.a.d, [
        checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [withTargets(['V-1'])] })),
        checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [withTargets(['V-1', 'V-3'])] })),
      ]);
      const first = await run(x);
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'invalid', JSON.stringify(first));
      assert.match(first.decision.detail, /dishonest-citation: it targets out-of-slice rules T-2 and cites no clause outside the owner-selected slice/);
      const second = await run(x);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
      assert.match(callOf(x, 'ckpt-2').stdin, /<prior_attempt>[\s\S]*dishonest-citation/);
      assert.deepEqual(bundleSources(x.r).map((b) => b.admits), [[{ index: 0, unit: 'more', class: { type: 'opportunity', id: 'O-1', clauses: ['V-3'] } }]]);
    } finally {
      x.r.journal.close();
    }
  });

  test('bundle.all-converted-no-op: a bundle whose only op converts is a no-op carrying its conversions; its amendment follows; no revision', T, async () => {
    const x = await arc([]);
    try {
      appendSteps(x.a.d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [admitCiting(x, 'aside', ['V-2'])] }))]);
      const rev = x.r.journal.view.planApplied()!.rev;
      const out = await run(x);
      assert.deepEqual(out.kind === 'decided' ? out.decision : out, { kind: 'no-op', conversions: [{ index: 0, unit: 'aside', reason: 'unrelated', opportunity: null }] });
      assert.equal(x.r.journal.view.planApplied()!.rev, rev);
      assert.deepEqual(factsOfKind(x.r, 'bundle-decided').map((f) => f.outcome), [{ kind: 'no-op', conversions: [{ index: 0, unit: 'aside', reason: 'unrelated', opportunity: null }] }]);
      assert.deepEqual(factsOfKind(x.r, 'corpus-amendment').map((f) => f.source), [{ type: 'admit', job: 'ckpt-1', index: 0, reason: 'unrelated' }]);
    } finally {
      x.r.journal.close();
    }
  });

  test('bundle.recovery-no-reclassify: killed after the commit, then the slice changes: settlement reads the recorded conversion, never classifies again', T, async () => {
    // O-1 takes the budget (V-3); the V-4 admit converts over-budget. After the crash the owner adds V-4 to the slice:
    // classified again, that admit would be an oversight and convert nothing.
    const a = await corpusHolisticArc([lensStep('audit-1', 'vision')], { baseline: { '.roadmap/vision.json': visionWithHorizon() } });
    appendSteps(a.d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [admitStep(a, 'more', ['V-1', 'V-3']), admitStep(a, 'glance', ['V-4'])] }))]);
    {
      const r = contextFor(a.d);
      const { ctx } = checkpointContext(r);
      await completedAudit(r, ctx);
      r.journal.close();
    }
    const trigger = writeTrigger(tmpDir('reclassify-crash'), { label: 'bundle.after-applied', occurrence: 1 });
    const exit = await runFixture('corpus-job-child.ts', [JSON.stringify(a.d), 'checkpoint'], { env: forgeEnv(a, { ROADMAP_TEST_CRASH: trigger }), timeoutMs: 150_000 });
    assert.equal(exit.signal, 'SIGKILL', `the child must crash: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
    assertFired(trigger);
    const r = contextFor(a.d);
    const { ctx, w } = checkpointContext(r);
    try {
      assert.deepEqual(factsOfKind(r, 'corpus-amendment'), [], 'killed before settlement');
      const plan = JSON.parse(readFileSync(a.d.planPath, 'utf8')) as Json & { units: Json[]; holistic: { advances: string[] } };
      const inForce = planInForce(r);
      // The owner widens the slice: the plan in force (with the opportunity's V-3) plus V-4.
      writeFileSync(a.d.planPath, JSON.stringify({ ...plan, units: inForce.units, holistic: { ...plan.holistic, advances: ['V-1', 'V-3', 'V-4'] } }));
      for (const u of inForce.units) if (u.id !== 'u1') writeFileSync(join(a.planDir, `${u.id}.json`), readFileSync(join(r.ctx.runDir, 'inputs', `${requireSpecSha(r, u.id)}.spec.json`)));
      const applied = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(a.d, r.journal.view.planApplied()!.rev)));
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      await recover({ stage: ctx, commands: w.commands });
      assert.deepEqual(await run({ a, r, ctx, w }), { kind: 'none' });
      assert.deepEqual(factsOfKind(r, 'corpus-amendment').map((f) => f.source), [{ type: 'admit', job: 'ckpt-1', index: 1, reason: 'over-budget' }], 'the recorded conversion, once');
    } finally {
      r.journal.close();
    }
  });

  test('bundle.follow-up-overrun-converts-with-debt (LR-k): O-1 merges; a finding on its code; the first repair follows O-1 up, the second converts with an amendment and a debt item naming O-1', T, async () => {
    const repairOf = (a: CorpusHolisticArc, id: string): JsonValue => {
      const op = admitStep(a, id, ['V-3']) as Json & { spec: Json; unit: Json };
      return { ...op, unit: { ...op.unit, origin: 'repair' }, spec: { ...op.spec, repairs: ['F-1'] } } as JsonValue;
    };
    const a = await corpusHolisticArc([lensStep('audit-1', 'vision')], { baseline: { '.roadmap/vision.json': visionWithHorizon() } });
    appendSteps(a.d, [
      checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [admitStep(a, 'opp', ['V-1', 'V-3'])] })),
      planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
      lensStep('audit-2', 'vision', [{ severity: 'P2', visionClauses: ['V-3'], claim: 'mul frees no berth', cause: 'mul: no pool', evidence: [{ path: 'src/mul.js', line: 1 }] }]),
      checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [repairOf(a, 'fix1')] })),
      lensStep('audit-3', 'vision'),
      checkpointStep('ckpt-3', checkpointAnswer({ decision: 'bundle', ops: [repairOf(a, 'fix2')] })),
    ]);
    const r = contextFor(a.d);
    const base = checkpointContext(r);
    const follow = followContext(r);
    // The admitted unit runs: every context reads the plan in force.
    const ctx = { ...base.ctx, plan: follow.plan, routing: follow.routing };
    const { w } = base;
    const x: Arc = { a, r, ctx, w };
    try {
      await completedAudit(r, ctx);
      const first = await run(x);
      assert.ok(first.kind === 'decided' && first.decision.kind === 'applied', JSON.stringify(first));
      assert.deepEqual(await runUnit(follow, unitOf(follow, 'opp'), admitAll), { kind: 'merged' });
      await completedAudit(r, ctx);
      const second = await run(x);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
      await completedAudit(r, ctx);
      const third = await run(x);
      assert.ok(third.kind === 'decided' && third.decision.kind === 'no-op', JSON.stringify(third));
      assert.deepEqual(bundleSources(r).map((s) => [s.job, s.admits?.map((c) => c.class)]), [
        ['ckpt-1', [{ type: 'opportunity', id: 'O-1', clauses: ['V-3'] }]],
        ['ckpt-2', [{ type: 'repair', refs: ['F-1'], followUp: 'O-1' }]],
      ]);
      assert.deepEqual(factsOfKind(r, 'bundle-decided').map((f) => f.outcome), [{ kind: 'no-op', conversions: [{ index: 0, unit: 'fix2', reason: 'follow-up-overrun', opportunity: 'O-1' }] }]);
      assert.deepEqual(factsOfKind(r, 'corpus-amendment').filter((f) => f.source.type === 'admit').map((f) => f.source), [{ type: 'admit', job: 'ckpt-3', index: 0, reason: 'follow-up-overrun' }]);
      const debt = factsOfKind(r, 'debt-banked');
      assert.deepEqual(debt.map((f) => [f.bankReason, f.source, f.opportunity]), [['opportunity-overrun', { type: 'admit', job: 'ckpt-3', index: 0 }, 'O-1']]);
      assert.match(debt[0]!.what, /^Opportunity O-1 needed a second follow-up repair/);
      assert.equal(r.journal.view.holistic().findings.find((f) => f.id === 'F-1')?.state, 'open', 'the repaired finding stays active (correctness never banks)');
    } finally {
      r.journal.close();
    }
  });

  test('admits.architecture-doc-arc-unclassified (LR-h): an architecture-doc arc\'s bundle records no admit classes', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      appendSteps(d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [admitOp(d, 'u2')] }))]);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      assert.deepEqual(bundleSources(r), [{ type: 'bundle', job: 'ckpt-1' }], 'no admits, no conversions: unclassified');
    } finally {
      r.journal.close();
    }
  });
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
    v: 1, lane: LANE, laneRev: (over.laneRev ?? 'aaaaaaaaaaaaaaaa') as LaneRev, envId: (over.envId ?? 'eeeeeeeeeeeeeeee') as EnvId, treeSha: (over.treeSha ?? '1'.repeat(40)) as Sha,
    inv: (over.inv ?? 'arc/1-1') as InvocationId, runner: 'jsonl', purpose: 'witness', records, malformed: over.malformed ?? false,
  } as unknown as WitnessRecord;
  return { key: { treeSha: record.treeSha, lane: LANE, laneRev: record.laneRev, envId: record.envId }, recordsSha256: sha256Hex(JSON.stringify(record)) as Sha256Hex, record, seq: 1 };
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
  children: [{ id: 'I-2', statement: 'A berth is never double-booked.', docRef: null, rule, witness: { lane: 'journey', testIds: ['t1'] }, activation: 'must-hold', deliveredBy: [] }],
});
const census = (r: ArcRun) => revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view)).obligations!.value.census;

describe('rulings and split census (C2–C4)', () => {
  test('bundle.ruling-corpus-consistency-stamped: a checkpoint ruling in a corpus arc carries the pin it read and lands (it was invalid at 5ba750e)', T, async () => {
    const x = await arc([]);
    try {
      appendSteps(x.a.d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-2')], rulings: [ruling('C-2')] }))]);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const sidecar = revisionInForce(x.r.ctx.runDir, requirePlanInForce(x.r.ctx.runDir, x.r.journal.view)).sidecars.get('C-2' as never)!.sidecar;
      assert.equal(sidecar.consistency.judgedRevs.corpusSha256, x.a.pinSha256);
    } finally {
      x.r.journal.close();
    }
  });

  test('bundle.ruling-id-leading-zero: a model\'s C-02 is read as C-2 in the ruling and its rule op; stored output is untouched', T, async () => {
    assert.equal(numericId('C-01'), 'C-1');
    assert.equal(numericId('C-10'), 'C-10');
    const output = validateCheckpointOutput(checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-02')], rulings: [ruling('C-02')] }));
    assert.deepEqual(numericRulingIds(output).ops.map((o) => (o.op === 'rule' ? o.ruling : null)), ['C-2']);
    const x = await arc([]);
    try {
      appendSteps(x.a.d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-02')], rulings: [ruling('C-02')] }))]);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const rev = revisionInForce(x.r.ctx.runDir, requirePlanInForce(x.r.ctx.runDir, x.r.journal.view));
      assert.ok(rev.sidecars.has('C-2' as never), 'the ruling lands as C-2 (the corpus arc\'s ledger holds C-1)');
      assert.ok(!rev.sidecars.has('C-02' as never));
      assert.match(rev.ledger.bytes.toString('utf8'), /^C-2\b/m);
    } finally {
      x.r.journal.close();
    }
  });

  test('bundle.split-census-out-of-slice-moved: a child anchored at an out-of-slice rule, serving the slice, moves that rule\'s census to the child', T, async () => {
    const x = await arc([]);
    try {
      appendSteps(x.a.d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [splitTo('T-2')] }))]);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      assert.deepEqual(census(x.r)?.find((e) => e.rule === 'T-2')?.state, { type: 'obligation', id: 'I-2' });
      assert.deepEqual(census(x.r)?.find((e) => e.rule === 'T-1')?.state, { type: 'obligation', id: 'I-1' });
    } finally {
      x.r.journal.close();
    }
  });

  test('bundle.split-census-other-state-reason: a child anchored at an untestable rule is invalid, naming the rule, its state and the fix', T, async () => {
    const x = await arc([], {
      before: (a) => {
        const file = join(a.planDir, 'obligations.json');
        const o = JSON.parse(readFileSync(file, 'utf8')) as { census: { rule: string; state: Json }[] };
        writeFileSync(file, JSON.stringify({ ...o, census: o.census.map((e) => (e.rule === 'T-3' ? { ...e, state: { type: 'untestable' } } : e)) }));
      },
    });
    try {
      appendSteps(x.a.d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [splitTo('T-3')] }))]);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'invalid', JSON.stringify(out));
      assert.match(out.decision.detail, /child I-2 is anchored at T-3, whose census state is untestable: anchor the child at its parent's rule T-1, or admit it as an opportunity/);
    } finally {
      x.r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// C5: busy

const pcBarrier = { type: 'barrier', name: 'pc', timeoutMs: 120_000 } as const;
const limitsU1: JsonValue = { op: 'limits', unit: 'u1', limits: [{ field: 'chargeable', value: 2 }], cites: ['V-1'], evidence: ['audit-1'] };

describe('busy: a bundle touching a unit mid-stage waits for its boundary (C5, R50)', () => {
  test('bundle.busy-live-attempt / checkpoint.busy-waits-for-boundary / classify.open-attempt-running-vs-abandoned', T, async () => {
    const pc = planCheckStep({ decision: 'approve' });
    const x = await arc([
      { ...pc, acts: [pcBarrier, ...pc.acts] } as Step,
      checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [limitsU1] })),
      checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [limitsU1] })),
    ]);
    try {
      const unit = stepTo(x.ctx, 'u1', (f) => f.stage === 'plan-check');
      await reached(x.a.d.scenarioDir, 'pc', 120_000);
      // R-20 holds the capture while u1 is in plan-check; past the bounded wait it captures, and the bundle is busy.
      assert.deepEqual(await run(x), { kind: 'skipped', reason: 'publishing' });
      const first = await withForge(x.a.forge, () => runCheckpoint({ ...x.ctx, clock: () => CAPTURE_WAIT_MAX_MIN }));
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'busy', JSON.stringify(first));
      assert.deepEqual(first.decision.units, [{ unit: 'u1', stage: 'plan-check', attempt: 1 }]);
      assert.match(first.decision.detail, /u1, which is in plan-check attempt 1/);
      // While the attempt runs, the trigger is not due: no capture, no call (a long stage spans many checkpoint turns).
      for (let i = 0; i < 3; i++) assert.deepEqual(await run(x), { kind: 'none' });
      assert.deepEqual(ckptCalls(x), ['ckpt-1'], 'exactly one paid call before the boundary');
      // An architect's spec edit is refused with the running text (classify.ts via openAttempt).
      const spec = join(x.a.planDir, 'u1.json');
      const was = readFileSync(spec, 'utf8');
      writeFileSync(spec, JSON.stringify({ ...(JSON.parse(was) as Json), rev: 2 }));
      const refused = await applyCommand(x.w.commands, submitCommand(x.r.ctx.runDir, x.r.journal.view.arc, applyBody(x.a.d)));
      assert.equal(refused.kind, 'rejected', JSON.stringify(refused));
      assert.match(JSON.stringify(refused), /unit u1 is running plan-check attempt 1; apply the edit at its stage boundary/);
      writeFileSync(spec, was);
      release(x.a.d.scenarioDir, 'pc');
      await unit;
      const second = await run(x);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
      assert.deepEqual(ckptCalls(x), ['ckpt-1', 'ckpt-2'], 'one call after the boundary');
      assert.deepEqual(decisions(x.r), [['ckpt-1', 'rejected:busy']]);
      assert.deepEqual(bundleSources(x.r).map((b) => b.job), ['ckpt-2']);
    } finally {
      x.r.journal.close();
    }
  });

  test('classify.open-attempt-running-vs-abandoned: an attempt an executor restart found open is refused with the crash text', T, async () => {
    const pc = planCheckStep({ decision: 'approve' });
    const x = await arc([{ ...pc, acts: [pcBarrier, ...pc.acts] } as Step], { audit: false });
    try {
      const unit = stepTo(x.ctx, 'u1', (f) => f.stage === 'plan-check');
      await reached(x.a.d.scenarioDir, 'pc', 120_000);
      x.r.journal.fact({ kind: 'executor-started', generation: 99 });
      const spec = join(x.a.planDir, 'u1.json');
      const was = readFileSync(spec, 'utf8');
      writeFileSync(spec, JSON.stringify({ ...(JSON.parse(was) as Json), rev: 2 }));
      const refused = await applyCommand(x.w.commands, submitCommand(x.r.ctx.runDir, x.r.journal.view.arc, applyBody(x.a.d)));
      assert.match(JSON.stringify(refused), /unit u1 has plan-check attempt 1 cut short by a crash/);
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
  test('checkpoint.capture-waits-for-publication: a due checkpoint captures nothing while a unit is at gate or approved before its candidate; it captures the head the unit published', T, async () => {
    const x = await arc([...toGate(), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))]);
    try {
      const gated = stepTo(x.ctx, 'u1', (f) => f.stage === 'gate');
      await reached(x.a.d.scenarioDir, 'gate', 120_000);
      assert.match(publishing(x.r.journal.view).join('; '), /^u1 at gate attempt \d+$/);
      assert.deepEqual(await run(x), { kind: 'skipped', reason: 'publishing' });
      release(x.a.d.scenarioDir, 'gate');
      await gated;
      assert.match(publishing(x.r.journal.view).join('; '), /^u1 approved at gate attempt \d+$/);
      assert.deepEqual(await run(x), { kind: 'skipped', reason: 'publishing' });
      assert.deepEqual(factsOfKind(x.r, 'checkpoint-inputs'), [], 'nothing captured, nothing asked');
      assert.deepEqual(ckptCalls(x), []);
      assert.deepEqual(await runUnit(x.ctx, unitOf(x.ctx, 'u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(publishing(x.r.journal.view), []);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
      assert.equal(factsOfKind(x.r, 'checkpoint-inputs')[0]!.headSha, git(x.a.d.repo, 'rev-parse', 'main'), 'the capture is the published head');
    } finally {
      x.r.journal.close();
    }
  });

  test('checkpoint.capture-waits-for-plan-check (R-20): a due checkpoint captures nothing while a unit is in plan-check, which may patch a spec it reads; it captures once the plan-check decides', T, async () => {
    const pc = planCheckStep({ decision: 'approve' });
    const x = await arc([{ ...pc, acts: [pcBarrier, ...pc.acts] } as Step, checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))]);
    try {
      const checked = stepTo(x.ctx, 'u1', (f) => f.stage === 'plan-check');
      await reached(x.a.d.scenarioDir, 'pc', 120_000);
      assert.deepEqual(publishing(x.r.journal.view), ['u1 at plan-check attempt 1']);
      assert.deepEqual(await run(x), { kind: 'skipped', reason: 'publishing' });
      assert.deepEqual(factsOfKind(x.r, 'checkpoint-inputs'), [], 'nothing captured, nothing asked');
      assert.deepEqual(ckptCalls(x), []);
      release(x.a.d.scenarioDir, 'pc');
      await checked;
      assert.deepEqual(publishing(x.r.journal.view), []);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
      assert.deepEqual(ckptCalls(x), ['ckpt-1']);
    } finally {
      x.r.journal.close();
    }
  });

  test('checkpoint.capture-wait-bounded: a trigger that has waited CAPTURE_WAIT_MAX_MIN captures with the publication still in flight', T, async () => {
    const x = await arc([...toGate(), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))]);
    try {
      const gated = stepTo(x.ctx, 'u1', (f) => f.stage === 'gate');
      await reached(x.a.d.scenarioDir, 'gate', 120_000);
      assert.deepEqual(await withForge(x.a.forge, () => runCheckpoint({ ...x.ctx, clock: () => CAPTURE_WAIT_MAX_MIN - 1 })), { kind: 'skipped', reason: 'publishing' });
      const out = await withForge(x.a.forge, () => runCheckpoint({ ...x.ctx, clock: () => CAPTURE_WAIT_MAX_MIN }));
      assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
      release(x.a.d.scenarioDir, 'gate');
      await gated;
    } finally {
      x.r.journal.close();
    }
  });
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
  test('checkpoint.manifest-content-addressed / checkpoint.specs-embedded-with-occupied-ids / checkpoint.next-ruling-id', T, async () => {
    const x = await arc([checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))]);
    try {
      const out = await run(x);
      assert.ok(out.kind === 'decided', JSON.stringify(out));
      const stdin = callOf(x, 'ckpt-1').stdin;
      const lines = tagOf(stdin, 'input_manifest').split('\n');
      const kinds = lines.map((l) => /^- (\S+) /.exec(l)![1]);
      for (const k of ['plan', 'spec', 'ledger', 'obligations', 'vision', 'phase0', 'issues']) assert.ok(kinds.includes(k), `the manifest names a ${k}: ${lines.join('\n')}`);
      for (const l of lines) {
        const m = /^- \S+ \S+: (\S+) sha256:([0-9a-f]{64})$/.exec(l);
        assert.ok(m !== null, l);
        assert.equal(sha256Hex(readFileSync(m[1]!)), m[2], `${m[1]} is content-addressed`);
        assert.ok(m[1]!.startsWith(join(x.r.ctx.runDir, 'inputs')), 'a kept input, never roadmap-inputs');
      }
      const specs = tagOf(stdin, 'unit_specs');
      assert.match(specs, /spec of unit u1, revision 1; item ids it holds: [^\n]*A1/);
      assert.match(stdin, /<next_ruling_id>C-2<\/next_ruling_id>/, 'the corpus arc\'s ledger holds C-1');
    } finally {
      x.r.journal.close();
    }
  });

  test('checkpoint.closeout-delta-when-unchanged: after a no-op, a checkpoint on an unchanged arc renders a closeout without findings or specs', T, async () => {
    const x = await arc([
      checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })), lensStep('audit-2', 'vision'), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' })),
    ]);
    try {
      assert.ok((await run(x)).kind === 'decided');
      await completedAudit(x.r, x.ctx);
      const second = await run(x);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'no-op', JSON.stringify(second));
      assert.doesNotMatch(callOf(x, 'ckpt-1').stdin, /<closeout/);
      const stdin = callOf(x, 'ckpt-2').stdin;
      assert.match(stdin, /<closeout since="ckpt-1">/);
      assert.equal(tagOf(stdin, 'unit_specs'), '(no unit specs)');
    } finally {
      x.r.journal.close();
    }
  });

  test('checkpoint.refused-carried-across-triggers (paid M4a run 12): a later trigger\'s checkpoint reads the proposals refused under the plan rev and why; a new plan rev drops them', T, async () => {
    const withTargets = (a: CorpusHolisticArc): JsonValue => ({ ...(admitStep(a, 'more', ['V-1']) as Json), targets: ['T-2'] } as JsonValue);
    for (const replanned of [false, true]) {
      const x = await arc([]);
      try {
        appendSteps(x.a.d, [
          checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [withTargets(x.a)] })),
          checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [withTargets(x.a)] })),
          lensStep('audit-2', 'vision'),
          checkpointStep('ckpt-3', checkpointAnswer({ decision: 'no-op' })),
        ]);
        await run(x);
        await run(x);
        assert.deepEqual(decisions(x.r), [['ckpt-1', 'rejected:invalid'], ['ckpt-2', 'requested']]);
        if (replanned) await applyPlanEdit(x.r, x.w, (plan) => { plan['direction'] = 'Berths first, then the morning view.'; });
        await completedAudit(x.r, x.ctx);
        const third = await run(x);
        assert.ok(third.kind === 'decided' && third.decision.kind === 'no-op', JSON.stringify(third));
        assert.doesNotMatch(callOf(x, 'ckpt-1').stdin, /<refused_proposals>/);
        assert.doesNotMatch(callOf(x, 'ckpt-2').stdin, /<refused_proposals>/, 'ckpt-1 is the retry\'s prior attempt, not repeated');
        const refused = /<refused_proposals>\n([\s\S]*?)\n<\/refused_proposals>/.exec(callOf(x, 'ckpt-3').stdin)?.[1] ?? null;
        if (replanned) {
          assert.equal(refused, null, 'refused against plan rev 1; ckpt-3 captures plan rev 2');
          continue;
        }
        const lines = refused!.split('\n').slice(1);
        assert.equal(lines.length, 2, refused!);
        assert.match(lines[0]!, /^- ckpt-1 \(rejected as invalid\): op 1 \(admit more\): dishonest-citation: it targets out-of-slice rules T-2/);
        assert.match(lines[1]!, /^- ckpt-2 \(sent to the owner: not applicable as proposed\): Checkpoint ckpt-2 proposes a bundle it may not apply by itself: it is invalid a second time \(.*dishonest-citation/);
      } finally {
        x.r.journal.close();
      }
    }
  });

  test('checkpoint.final-always-full: the final audit\'s checkpoint renders in full even after a no-op on an unchanged arc', T, async () => {
    const x = await arc([checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' }))]);
    try {
      assert.ok((await run(x)).kind === 'decided');
      // The final audit, as cadence records one (its lens call is not what this test is about).
      const started = factsOfKind(x.r, 'audit-started')[0]!;
      x.r.journal.fact({ ...started, job: 'audit-2' as never, generation: started.generation + 1, triggers: [{ type: 'final' }] });
      x.r.journal.fact({ kind: 'audit-ended', job: 'audit-2' as never, covered: [], findings: [], suppressed: 0, outcome: 'completed' });
      assert.ok((await run(x)).kind === 'decided');
      const stdin = callOf(x, 'ckpt-2').stdin;
      assert.doesNotMatch(stdin, /<closeout/);
      assert.match(tagOf(stdin, 'unit_specs'), /spec of unit u1/);
    } finally {
      x.r.journal.close();
    }
  });
});

describe('issue reuse (H5, F27)', () => {
  const seed = (a: CorpusHolisticArc) => {
    a.forge.addIssue({ title: 'A berth was double-booked', labels: ['roadmap:bug'], body: 'Berth 4 holds two bookings.', association: 'OWNER', author: 'harbourmaster' });
    a.forge.addIssue({ title: 'Name the tide window', labels: ['roadmap:feedback'], body: 'Every booking should say its tide window.', association: 'OWNER', author: 'harbourmaster' });
  };
  const first = checkpointAnswer({
    decision: 'no-op',
    issueIntake: [{ issue: 'issue-1', outcome: intakeOutcome.none('fixed by I-1') }, { issue: 'issue-2', outcome: intakeOutcome.amendment(['T-2'], 'Name the window.') }],
  });

  test('intake.unchanged-capture-reuses-dispositions: unchanged issues are not listed; the output omits them; their outcomes carry forward', T, async () => {
    const x = await arc([checkpointStep('ckpt-1', first), lensStep('audit-2', 'vision')], { before: seed });
    try {
      assert.ok((await run(x)).kind === 'decided');
      x.a.forge.addComment(1, { body: 'Still seen on berth 4.', association: 'OWNER', author: 'harbourmaster' });
      appendSteps(x.a.d, [checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op', issueIntake: [{ issue: 'issue-1', outcome: intakeOutcome.none('still fixed') }] }))]);
      await completedAudit(x.r, x.ctx);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
      const stdin = callOf(x, 'ckpt-2').stdin;
      assert.match(stdin, /Still seen on berth 4/, 'the changed issue is listed');
      assert.doesNotMatch(stdin, /Every booking should say its tide window/, 'the unchanged one is not');
      assert.match(stdin, /unchanged since checkpoint ckpt-1/);
      const intake = factsOfKind(x.r, 'issue-intake').filter((f) => f.job === 'ckpt-2').map((f) => [f.issue, f.outcome.type]);
      assert.deepEqual(intake.sort(), [['issue-1', 'none'], ['issue-2', 'amendment']], 'issue-2 carried from ckpt-1');
    } finally {
      x.r.journal.close();
    }
  });

  test('intake.changed-ground-relists: a changed ground (the obligations) lists every issue again, and each needs an outcome', T, async () => {
    const x = await arc([checkpointStep('ckpt-1', first), lensStep('audit-2', 'vision'), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op', issueIntake: [{ issue: 'issue-1', outcome: intakeOutcome.none('still fixed') }] }))], { before: seed });
    try {
      assert.ok((await run(x)).kind === 'decided');
      const file = join(x.a.planDir, 'obligations.json');
      writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as Json), cutLine: 'the berth booking ships, and its texts' }));
      const applied = await applyCommand(x.w.commands, submitCommand(x.r.ctx.runDir, x.r.journal.view.arc, applyBody(x.a.d)));
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      await completedAudit(x.r, x.ctx);
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'invalid', JSON.stringify(out));
      assert.match(out.decision.detail, /issueIntake gives issue-2 no outcome/);
      const stdin = callOf(x, 'ckpt-2').stdin;
      assert.match(stdin, /Every booking should say its tide window/);
      assert.doesNotMatch(stdin, /unchanged since checkpoint/);
    } finally {
      x.r.journal.close();
    }
  });
});

describe('a unit merged around the capture (paid M4a run 10)', () => {
  const patchU1: JsonValue = { op: 'patch-spec', unit: 'u1', patch: [{ op: 'cite', contracts: ['contracts/api.md'], rulings: [] }], cites: ['V-1'], evidence: ['audit-1'] };
  const toMerge = (): readonly Step[] => [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })];
  const ckptBarrier = { type: 'barrier', name: 'ckpt', timeoutMs: 120_000 } as const;

  test('bundle.merged-since-capture-stale: a spec op on a unit that merged after the checkpoint captured is stale (naming the unit), not invalid', T, async () => {
    const x = await arc([...toMerge(), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [patchU1] }), [ckptBarrier])]);
    try {
      const running = run(x);
      await reached(x.a.d.scenarioDir, 'ckpt', 120_000);
      assert.deepEqual(await runUnit(x.ctx, unitOf(x.ctx, 'u1'), admitAll), { kind: 'merged' });
      release(x.a.d.scenarioDir, 'ckpt');
      const out = await running;
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'stale', JSON.stringify(out));
      assert.match(out.decision.detail, /unit u1 merged since the checkpoint read it/);
    } finally {
      x.r.journal.close();
    }
  });

  test('bundle.merged-at-capture-invalid: a spec op on a unit already merged at capture stays invalid (the model was shown it merged)', T, async () => {
    const x = await arc([...toMerge(), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [patchU1] }))]);
    try {
      assert.deepEqual(await runUnit(x.ctx, unitOf(x.ctx, 'u1'), admitAll), { kind: 'merged' });
      const out = await run(x);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'invalid', JSON.stringify(out));
      assert.match(out.decision.detail, /unit u1 is merged; its spec is fixed/);
    } finally {
      x.r.journal.close();
    }
  });
});
