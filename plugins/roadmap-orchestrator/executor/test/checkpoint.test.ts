// M3 step B6: the checkpoint job and its bundles (src/holistic/{checkpoint,bundle,convergence,divergence}.ts), over real
// arcs: real git, real processes, the fake claude answering lens and checkpoint calls keyed by job, fake witness lanes.
// Named tests: bundle.stale, bundle.vision-always-read (H3), bundle.partial (A18's literal partial bundle), bundle.no-op,
// noop.interpretation-divergence (H12), bundle.evidence-drop, bundle.draining-request, bundle.nested-owner-only (H10),
// bundle.withdrawn-cite-invalid (H16), bundle.weakening-applies-with-divergence (OR-V), convergence.bound-k,
// convergence.bound-identity, bundle.compensating, digest.binds-ids (H11), divergence.preimage-no-inverse (H13),
// ckpt.design-park-respec-first (OR-Q1), and the crash cells of the matrix rows CHECKPOINT_JOB and BUNDLE_ACTIVATE.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type CommandId, type DivergenceId, type NeedsUserId, commandId, unitId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { designParkRoute, runCheckpoint } from '../src/holistic/checkpoint.ts';
import { quiescentGenerations } from '../src/holistic/convergence.ts';
import { raiseDigest, uncoveredDivergences } from '../src/holistic/divergence.ts';
import { keptPayload } from '../src/input/inforce.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { VALID_OP, checkpointAnswer, checkpointStep, interpretationOnlyNoop, twoOpBundleSecondInvalid } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { BUNDLE_ACTIVATE, CHECKPOINT_JOB, crashCells } from './matrix.ts';
import {
  type Wired, admitOp, applyPlanEdit, applyVision, checkpointArc, checkpointContext, completedAudit, factsOfKind, limitsOp, requestAudit, visionLenses,
} from './fixtures/checkpoint-common.ts';
import { ruleRecord, submitRule } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, codexStep, contextFor } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const decisions = (r: ArcRun) => factsOfKind(r, 'bundle-decided').map((f) => [f.job, f.outcome.kind === 'rejected' ? `rejected:${f.outcome.reason}` : f.outcome.kind]);
const bundleRevs = (r: ArcRun) => factsOfKind(r, 'plan-applied').flatMap((f) => (f.source?.type === 'bundle' ? [[f.rev, f.source.job]] : []));
const checkpointCalls = (r: ArcRun) => readCalls(r.d.scenarioPath).filter((c) => c.unit !== null && c.unit.startsWith('ckpt-')).map((c) => c.unit);
const planLimits = (r: ArcRun) => {
  const applied = r.journal.view.planApplied()!;
  return (JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${applied.planSha256}.plan.json`), 'utf8')) as { limits?: unknown }).limits ?? null;
};
const item = (r: ArcRun, id: string) => readNeedsUser(r.ctx.runDir, id as NeedsUserId)!;
const itemsOf = (r: ArcRun, reason: string) => r.journal.view.needsUser().filter((n) => readNeedsUser(r.ctx.runDir, n.id)?.reason === reason);
let acks = 0;
async function ack(w: Wired, r: ArcRun, id: string, choice: string | null = null): Promise<void> {
  const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'ack', needsUser: id as NeedsUserId, choice }));
  assert.equal(out.kind, 'applied', JSON.stringify(out));
  acks += 1;
}
const barrier = { type: 'barrier', name: 'ckpt', timeoutMs: 120_000 } as const;

describe('the checkpoint and its bundle', () => {
  test('bundle.no-op: a no-op decides once, writes no revision, and makes its generation quiescent', T, async () => {
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))]);
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const rev = r.journal.view.planApplied()!.rev;
      const out = await runCheckpoint(ctx);
      assert.deepEqual(out, { kind: 'decided', job: 'ckpt-1', trigger: { type: 'audit', job: 'audit-1' }, decision: { kind: 'no-op' } });
      assert.equal(r.journal.view.planApplied()!.rev, rev, 'no revision');
      assert.deepEqual(decisions(r), [['ckpt-1', 'no-op']]);
      const inputs = factsOfKind(r, 'checkpoint-inputs')[0]!;
      assert.equal(inputs.generation, 1);
      assert.deepEqual([...quiescentGenerations(r.journal.view.holistic(), inputs.visionSha256)], [1]);
      const call = readCalls(d.scenarioPath).find((c) => c.unit === 'ckpt-1')!;
      assert.ok(call.stdin.startsWith('<vision>'), 'the vision first');
      assert.match(call.stdin, /Arithmetic helpers anyone can trust/, 'in full');
      assert.match(call.stdin, /The spec in force of u1, the shape an admit's spec text takes/, 'the admit template');
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' }, 'the trigger is settled');
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      r.journal.close();
    }
  });

  test('noop.interpretation-divergence (H12): an interpretation-only no-op records its divergence (job, 0), no revision, still quiescent; the digest binds it', T, async () => {
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', interpretationOnlyNoop(['V-1'], 'Nothing says how to round.', 'Round half to even.'))]);
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const rev = r.journal.view.planApplied()!.rev;
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
      assert.equal(r.journal.view.planApplied()!.rev, rev);
      const [dv] = factsOfKind(r, 'divergence');
      assert.deepEqual([dv!.id, dv!.job, dv!.index, dv!.type, dv!.cites, dv!.compensation.kind], ['D-1', 'ckpt-1', 0, 'interpretation', ['V-1'], 'none']);
      assert.match(dv!.what, /Round half to even/);
      assert.deepEqual([...quiescentGenerations(r.journal.view.holistic(), factsOfKind(r, 'checkpoint-inputs')[0]!.visionSha256)], [1], 'still quiescent');
      const [digest] = factsOfKind(r, 'divergence-digest');
      assert.deepEqual(digest!.ids, ['D-1']);
      assert.equal(item(r, digest!.needsUser).blocking, false);
    } finally {
      r.journal.close();
    }
  });

  test('bundle.partial (A18): a two-op bundle whose second op is invalid applies neither; the trigger re-evaluates once; a second invalid bundle goes to the owner', T, async () => {
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', twoOpBundleSecondInvalid()), checkpointStep('ckpt-2', twoOpBundleSecondInvalid())]);
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const rev = r.journal.view.planApplied()!.rev;
      const first = await runCheckpoint(ctx);
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'invalid', JSON.stringify(first));
      assert.match(first.decision.detail, /V-999/);
      assert.match(first.decision.detail, /no-such-unit/);
      assert.equal(r.journal.view.planApplied()!.rev, rev, 'the valid first op did not apply either');
      assert.equal(planLimits(r), null);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'requested' && second.decision.reason === 'bundle-request', JSON.stringify(second));
      const n = item(r, second.decision.needsUser);
      assert.deepEqual([n.blocking, n.options], [false, []], 'non-blocking, and nothing to apply as proposed');
      assert.deepEqual(decisions(r), [['ckpt-1', 'rejected:invalid'], ['ckpt-2', 'requested']]);
      assert.equal(r.journal.view.planApplied()!.rev, rev);
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
    } finally {
      r.journal.close();
    }
  });

  test('bundle.stale: an architect apply between capture and activation that changes the plan rejects the plan-touching bundle whole; the re-evaluation applies', T, async () => {
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [VALID_OP] }), [barrier]), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [VALID_OP] }))]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      await applyPlanEdit(r, w, (p) => void (p['direction'] = 'Keep it smaller.'));
      release(d.scenarioDir, 'ckpt');
      const first = await running;
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'stale', JSON.stringify(first));
      assert.match(first.decision.detail, /the plan changed/);
      assert.equal(planLimits(r), null);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
      assert.deepEqual(planLimits(r), { convergenceK: 3 });
      assert.deepEqual(bundleRevs(r), [[r.journal.view.planApplied()!.rev, 'ckpt-2']]);
      assert.deepEqual(checkpointCalls(r), ['ckpt-1', 'ckpt-2']);
    } finally {
      r.journal.close();
    }
  });

  test('bundle.vision-always-read (H3): a vision revision between capture and activation rejects a bundle that touches no vision-derived artifact', T, async () => {
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [VALID_OP] }), [barrier])]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      await applyVision(r, w, [{ id: 'V-2', kind: 'good', text: 'Errors are explicit.', rank: null, state: 'active' }]);
      const planSha = r.journal.view.planApplied()!.planSha256;
      release(d.scenarioDir, 'ckpt');
      const out = await running;
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'stale', JSON.stringify(out));
      assert.equal(out.decision.detail, 'the vision changed since the checkpoint read it', 'the plan it touches did not change: only the vision');
      assert.equal(r.journal.view.planApplied()!.planSha256, planSha);
    } finally {
      r.journal.close();
    }
  });
});
