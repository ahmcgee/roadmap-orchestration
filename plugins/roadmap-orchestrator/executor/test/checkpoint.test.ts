// M3 step B6: the checkpoint job and its bundles (src/holistic/{checkpoint,bundle,convergence,divergence}.ts), over real
// arcs: real git, real processes, the fake claude answering lens and checkpoint calls keyed by job, fake witness lanes.
// Named tests: bundle.stale, bundle.partial (with the retry's prior_attempt), bundle.vision-always-read (H3), bundle.partial (A18's literal partial bundle), bundle.no-op,
// noop.interpretation-divergence (H12), bundle.evidence-drift-witnessed, bundle.evidence-drop, bundle.draining-request, bundle.nested-owner-only (H10),
// bundle.withdrawn-cite-invalid (H16), bundle.rule-race-stale, bundle.ruling-id-collision-invalid, bundle.admit-widens-obligations, bundle.weakening-applies-with-divergence (OR-V), convergence.bound-k,
// convergence.bound-identity, bundle.compensating, digest.binds-ids (H11), divergence.preimage-no-inverse (H13), divergence.patch-of-introduced-unit, bundle.fault-decided,
// ckpt.design-park-respec-first (OR-Q1), ckpt.park-cause, bundle.p1-left-to-repair, and the crash cells of the matrix rows CHECKPOINT_JOB and BUNDLE_ACTIVATE.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { readReceipt, submitCommand } from '../src/commands/queue.ts';
import { type DivergenceId, type NeedsUserId, arcId, commandId, jobIdOf, unitId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { status } from '../src/status.ts';
import type { JsonValue } from '../src/core/json.ts';
import { designParkRoute, outputOf, runCheckpoint } from '../src/holistic/checkpoint.ts';
import { quiescentGenerations } from '../src/holistic/convergence.ts';
import { raiseDigest, uncoveredDivergences } from '../src/holistic/divergence.ts';
import { findingKey } from '../src/holistic/types.ts';
import { SPEC_INPUT, inputPath, keptPayload, requirePlanInForce } from '../src/input/inforce.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { syncRepairs } from '../src/pipeline/reproduce.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { VALID_OP, checkpointAnswer, jobRepairStep, checkpointStep, interpretationOnlyNoop, lensStep, twoOpBundleSecondInvalid } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { BUNDLE_ACTIVATE, CHECKPOINT_JOB, crashCells } from './matrix.ts';
import {
  type Wired, admitOp, applyPlanEdit, applyVision, checkpointArc, checkpointContext, completedAudit, factsOfKind, limitsOp, noteLenses, visionLenses,
} from './fixtures/checkpoint-common.ts';
import { auditArc, mapped } from './fixtures/audit-common.ts';
import { ruleRecord, submitRule } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep, serialRuntime } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, applyBody, codexStep, contextFor, gateStep, mulBuild, stepUntil } from './fixtures/unit-common.ts';
import { candidateTree } from './fixtures/brake-common.ts';
import { scriptTree } from './helpers/witness.ts';

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
async function ack(w: Wired, r: ArcRun, id: string, choice: string | null = null): Promise<void> {
  const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'ack', needsUser: id as NeedsUserId, choice }));
  assert.equal(out.kind, 'applied', JSON.stringify(out));
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
      assert.deepEqual([...quiescentGenerations(r.journal.view, inputs.visionSha256)], [1]);
      const call = readCalls(d.scenarioPath).find((c) => c.unit === 'ckpt-1')!;
      assert.ok(call.stdin.startsWith('<vision>'), 'the vision first');
      assert.match(call.stdin, /Arithmetic helpers anyone can trust/, 'in full');
      assert.match(call.stdin, /<unit_specs>[\s\S]*spec of unit u1, revision 1; item ids it holds: [^\n]*/, 'every spec embedded with its item ids (H4)');
      assert.match(call.stdin, /<input_manifest>\n- plan plan: /, 'the input manifest (H4)');
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
      assert.deepEqual([...quiescentGenerations(r.journal.view, factsOfKind(r, 'checkpoint-inputs')[0]!.visionSha256)], [1], 'still quiescent');
      const [digest] = factsOfKind(r, 'divergence-digest');
      assert.deepEqual(digest!.ids, ['D-1']);
      assert.equal(item(r, digest!.needsUser).blocking, false);
    } finally {
      r.journal.close();
    }
  });

  test('bundle.partial (A18): a two-op bundle whose second op is invalid applies neither; the trigger re-evaluates once; a second invalid bundle goes to the owner', T, async () => {
    // 2026-10-15: each job's invalid bundle takes its repair turn (here repeating it) before it is decided.
    const d = checkpointArc([
      ...visionLenses('audit-1'), checkpointStep('ckpt-1', twoOpBundleSecondInvalid()), jobRepairStep('ckpt-1', twoOpBundleSecondInvalid(), ['V-999', 'no-such-unit']),
      checkpointStep('ckpt-2', twoOpBundleSecondInvalid()), jobRepairStep('ckpt-2', twoOpBundleSecondInvalid()),
    ]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
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
      assert.deepEqual([n.blocking, n.options.map((o) => o.id)], [false, ['acknowledge', 'decline']], 'non-blocking, nothing to apply as proposed: acknowledge or decline (run 10, E)');
      // The retry read the first attempt's invalid reasons verbatim (paid m3 run 9: ckpt-3 repeated ckpt-2's mistakes).
      const stdin = (job: string) => readCalls(d.scenarioPath).find((c) => c.unit === job)!.stdin;
      assert.doesNotMatch(stdin('ckpt-1'), /<prior_attempt>/);
      assert.ok(stdin('ckpt-2').includes(`<prior_attempt>\nEarlier checkpoints on this trigger decided what the executor rejected, oldest first:\n- ckpt-1, rejected as invalid, for these reasons: ${first.decision.detail}\n  Correct each reason; do not repeat it.\nThis is the last attempt: a second invalid decision goes to the owner as a request.\n</prior_attempt>`), stdin('ckpt-2'));
      assert.deepEqual(decisions(r), [['ckpt-1', 'rejected:invalid'], ['ckpt-2', 'requested']]);
      assert.equal(r.journal.view.planApplied()!.rev, rev);
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
      const vision = factsOfKind(r, 'checkpoint-inputs')[0]!.visionSha256;
      assert.deepEqual([...quiescentGenerations(r.journal.view, vision)], [], 'an unanswered request holds its generation open');
      await ack(w, r, second.decision.needsUser);
      assert.deepEqual([...quiescentGenerations(r.journal.view, vision)], [1], 'answered without apply: the trigger\'s decision ends, the generation is quiescent');
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

  test('apply.warns-running-checkpoint (dev.17, arc feedback 2026-10-23 item 8): an apply while a checkpoint runs is applied, never blocked, and its receipt warns that the checkpoint\'s bundle goes stale and its spend is wasted; with none running, no warning', T, async () => {
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [VALID_OP] }), [barrier]), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' }))]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    const editAndApply = async (direction: string) => {
      const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(d.planPath, JSON.stringify({ ...plan, direction }));
      const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(d)));
      assert.equal(out.kind, 'applied', JSON.stringify(out));
      return readReceipt(r.ctx.runDir, commandIdOf(r), 'applied');
    };
    const commandIdOf = (x: ArcRun) => x.journal.view.planApplied()!.command!;
    try {
      await completedAudit(r, ctx);
      const rev = r.journal.view.planApplied()!.rev;
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      const during = await editAndApply('Keep it smaller.');
      assert.ok(during?.state === 'applied', JSON.stringify(during));
      const warnings = during.verified.filter((l) => l.startsWith('warning:'));
      assert.equal(warnings.length, 1, JSON.stringify(during.verified));
      assert.match(warnings[0]!, new RegExp(`^warning: checkpoint ckpt-1 is running on plan rev ${rev}; .*rejected stale.*spend is wasted`));
      release(d.scenarioDir, 'ckpt');
      const first = await running;
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'stale', JSON.stringify(first));
      const after = await editAndApply('Keep it smaller still.');
      assert.ok(after?.state === 'applied');
      assert.deepEqual(after.verified.filter((l) => l.startsWith('warning:')), [], 'no checkpoint runs: no warning');
    } finally {
      r.journal.close();
    }
  });

  test('checkpoint.superseded-by-plan-revision (paid M4b run 3, ckpt-7): an apply that changes the plan cancels the call in flight, which never finishes; the job decides stale and the re-capture on the new rev reads why', T, async () => {
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [VALID_OP] }), [barrier]), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [VALID_OP] }))]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      const capturedRev = factsOfKind(r, 'checkpoint-inputs')[0]!.vector.plan;
      await applyPlanEdit(r, w, (p) => void (p['direction'] = 'Keep it smaller.'));
      // The barrier is never released: only the cancel ends the call.
      const first = await running;
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'stale', JSON.stringify(first));
      assert.equal(first.decision.detail, `the plan changed since plan rev ${capturedRev}`);
      const kills = r.journal.view.opsOf('proc.kill').filter((k) => k.expect.reason === 'supersede');
      assert.equal(kills.length, 1, 'the call was cancelled for the revision');
      assert.ok(r.journal.view.doneOf(kills[0]!.op) !== null);
      assert.equal(planLimits(r), null);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
      assert.notEqual(factsOfKind(r, 'checkpoint-inputs')[1]!.vector.plan, capturedRev, 'captured again on the new rev');
      const stdin = readCalls(d.scenarioPath).find((c) => c.unit === 'ckpt-2')!.stdin;
      assert.ok(stdin.includes(`- ckpt-1, rejected as stale: ${first.decision.detail}\n  What it read changed after its capture: decide again from the inputs below.\n</prior_attempt>`), stdin);
      assert.deepEqual(r.journal.view.openIntents(), []);
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
      await applyVision(r, w, [{ id: 'V-3', kind: 'good', text: 'Errors are explicit.', rank: null, state: 'active' }]);
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

/** A P2 vision finding over no obligation, opened by audit `job` (as its lens would). */
function openVisionFinding(r: ArcRun, job: string, cause: string): string {
  const id = r.journal.view.nextFindingId();
  r.journal.fact({
    kind: 'finding-opened', id, key: findingKey('vision', null, cause), lens: 'vision', severity: 'P2', obligation: null, visionClauses: ['V-1' as never],
    claim: cause, evidence: [], mutant: null, source: { type: 'job', job: job as never }, gateHadPassed: false,
  });
  return id;
}
/** `id` resolved by u1's publication, as the executor moves it (`syncFindings`: owned, fixed on branch, resolved). */
function resolveMidCall(r: ArcRun, id: string): void {
  for (const to of [{ state: 'owned', unit: 'u1' }, { state: 'fixed-on-branch', unit: 'u1' }, { state: 'resolved' }]) {
    r.journal.fact({ kind: 'finding-transition', id: id as never, to: to as never });
  }
}
/** A bundle answer of `ops` (a no-op when empty), optionally citing observations, dismissing findings, with one interpretation. */
function bundle(ops: readonly JsonValue[], extra: Readonly<{ observations?: readonly JsonValue[]; dispose?: readonly string[]; interpretations?: boolean }> = {}): JsonValue {
  const a = checkpointAnswer({
    decision: ops.length === 0 ? 'no-op' : 'bundle', ops,
    findingDispositions: (extra.dispose ?? []).map((finding) => ({ finding, disposition: 'dismissed' as const, reason: 'not a defect' })),
    ...(extra.interpretations === true ? { interpretations: [{ clauses: ['V-1'], situation: 'The vision is silent on rounding.', reading: 'Round half to even.' }] } : {}),
  }) as Record<string, JsonValue>;
  return { ...a, cites: { vision: ['V-1'], observations: [...(extra.observations ?? [])], findings: [...(extra.dispose ?? [])] } };
}
/** A checkpoint ruling's JSON text `id` (the executor stamps `ruledBy` and `consistency`), and its `rule` op. */
const checkpointRuling = (id: string): string => JSON.stringify({
  schema: 'roadmap/ruling-m3', id, statement: `Helpers reject non-finite input (${id}).`, kind: 'decision', trigger: 'checkpoint',
  supersedes: [], condition: null, docRefs: [{ path: 'contracts/api.md', anchor: '#api-contract', quotedText: 'returns the sum', relation: 'consistent' }],
  contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: ['V-1'],
  evidence: ['the vision asks for helpers anyone can trust'], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
});
const ruleOp = (id: string): JsonValue => ({ op: 'rule', ruling: id, cites: ['V-1'], evidence: ['the vision asks for helpers anyone can trust'] });
const requirePlan = (r: ArcRun) => JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${r.journal.view.planApplied()!.planSha256}.plan.json`), 'utf8')) as { units: { id: string; origin?: string; reenters?: { fixes?: string } }[] };

describe('the activation checks', () => {
  test('bundle.finding-closed-moot (paid M4b run 5, ckpt-2): a finding a publication resolves during the call leaves its disposition moot; the bundle applies, the finding stays resolved', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const finding = openVisionFinding(r, 'audit-1', 'helpers round');
      const answer = bundle([VALID_OP]) as Record<string, JsonValue>;
      appendSteps(d, [checkpointStep('ckpt-1', { ...answer, findingDispositions: [{ finding, disposition: 'dismissed', reason: 'owned by u1, which is about to publish' }] }, [barrier])]);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      resolveMidCall(r, finding);
      release(d.scenarioDir, 'ckpt');
      const out = await running;
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      assert.equal(factsOfKind(r, 'checkpoint-inputs')[0]!.findings.includes(finding as never), true, 'the checkpoint was shown it');
      assert.equal(r.journal.view.holistic().findings.find((f) => f.id === finding)!.state, 'resolved', 'the moot disposition settled as nothing');
      assert.deepEqual(checkpointCalls(r), ['ckpt-1']);
    } finally {
      r.journal.close();
    }
  });

  test('bundle.finding-closed-rests-on-stale: a decision whose op names a finding resolved during the call is stale; the next job reads why', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const finding = openVisionFinding(r, 'audit-1', 'helpers round');
      appendSteps(d, [
        checkpointStep('ckpt-1', bundle([limitsOp('retries', 2, [`${finding} needs a second try`])]), [barrier]), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' })),
      ]);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      resolveMidCall(r, finding);
      release(d.scenarioDir, 'ckpt');
      const first = await running;
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'stale', JSON.stringify(first));
      assert.equal(first.decision.detail, `finding ${finding} is resolved since the checkpoint read it, and the decision rests on it`);
      assert.equal(planLimits(r), null);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'no-op', JSON.stringify(second));
      assert.match(readCalls(d.scenarioPath).find((c) => c.unit === 'ckpt-2')!.stdin, /- ckpt-1, rejected as stale: finding F-\d+ is resolved since the checkpoint read it/);
    } finally {
      r.journal.close();
    }
  });

  test('bundle.evidence-drift-witnessed (paid M4b run 3, ckpt-4): the head moves under the call to a tree no lane ran on; the cited lane is witnessed there before the activation, which applies the same decision with no second call', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const seen = factsOfKind(r, 'witnessed').at(-1)!;
      const key = { treeSha: seen.treeSha, lane: seen.lane, laneRev: seen.laneRev, envId: seen.envId };
      appendSteps(d, [checkpointStep('ckpt-1', bundle([VALID_OP], { observations: [key] }), [barrier])]);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      const ruled = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2')));
      assert.equal(ruled.kind, 'applied', JSON.stringify(ruled));
      const head = git(d.repo, 'rev-parse', 'main');
      assert.notEqual(git(d.repo, 'rev-parse', `${head}^{tree}`), seen.treeSha, 'a docs-only publication moved the head to a tree no lane ran on');
      release(d.scenarioDir, 'ckpt');
      const first = await running;
      assert.ok(first.kind === 'decided' && first.decision.kind === 'applied', JSON.stringify(first));
      assert.deepEqual(planLimits(r), { convergenceK: 3 });
      const rewitnessed = factsOfKind(r, 'witnessed').find((f) => f.for.type === 'job' && f.for.job === 'ckpt-1');
      assert.equal(rewitnessed?.treeSha, git(d.repo, 'rev-parse', `${head}^{tree}`), 'the cited lane witnessed on the new head under the deciding job');
      assert.deepEqual(decisions(r), [], 'no rejection was decided');
      assert.deepEqual(checkpointCalls(r), ['ckpt-1'], 'one paid call');
      assert.deepEqual(r.journal.view.openIntents(), []);
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
    } finally {
      r.journal.close();
    }
  });

  test('bundle.evidence-drop: a cited observation the moved head contradicts still rejects the bundle on its evidence; each later job of the trigger reads every rejection before it, with its reason and detail (paid M4b run 3)', T, async () => {
    const { d, control } = auditArc({
      steps: visionLenses('audit-1'), units: [{ id: 'u1' }], obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass' } } }, mapping: [],
      audit: { lenses: ['vision'] },
    });
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const seen = factsOfKind(r, 'witnessed').at(-1)!;
      const key = { treeSha: seen.treeSha, lane: seen.lane, laneRev: seen.laneRev, envId: seen.envId };
      appendSteps(d, [
        checkpointStep('ckpt-1', bundle([VALID_OP], { observations: [key] }), [barrier]), checkpointStep('ckpt-2', twoOpBundleSecondInvalid()), checkpointStep('ckpt-3', bundle([VALID_OP])),
      ]);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      const ruled = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2')));
      assert.equal(ruled.kind, 'applied', JSON.stringify(ruled));
      const head = git(d.repo, 'rev-parse', 'main');
      const tree = git(d.repo, 'rev-parse', `${head}^{tree}`);
      scriptTree(control, tree, { outcomes: { t1: 'fail' } });
      release(d.scenarioDir, 'ckpt');
      const first = await running;
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'evidence', JSON.stringify(first));
      assert.match(first.decision.detail, /differs on the head .*: test "t1" was pass, is fail on the head/);
      assert.equal(planLimits(r), null);
      assert.equal(factsOfKind(r, 'witnessed').filter((f) => f.for.type === 'job' && f.for.job === 'ckpt-1' && f.treeSha === tree).length, 1, 'witnessed on the head before the activation');
      // Paid M4b run 3 (ckpt-5 re-ran blind to ckpt-4's evidence rejection): every rejection of the trigger is fed back.
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'rejected' && second.decision.reason === 'invalid', JSON.stringify(second));
      assert.equal(factsOfKind(r, 'witnessed').filter((f) => f.for.type === 'job' && f.for.job === 'ckpt-1' && f.treeSha === tree).length, 1, 'the re-witness before the next capture reused it');
      assert.deepEqual(factsOfKind(r, 'checkpoint-inputs')[1]!.observations.map((k) => k.treeSha), [tree], 'the re-evaluation read the head\'s observation');
      const third = await runCheckpoint(ctx);
      assert.ok(third.kind === 'decided' && third.decision.kind === 'applied', JSON.stringify(third));
      const stdin = (job: string) => readCalls(d.scenarioPath).find((c) => c.unit === job)!.stdin;
      const header = '<prior_attempt>\nEarlier checkpoints on this trigger decided what the executor rejected, oldest first:\n';
      const evidenceLine = `- ckpt-1, rejected on its evidence: ${first.decision.detail}\n  The lanes it cited were witnessed again on the head: cite the observations given below, not the ones it cited.`;
      const invalidLine = `- ckpt-2, rejected as invalid, for these reasons: ${second.decision.detail}\n  Correct each reason; do not repeat it.`;
      assert.ok(stdin('ckpt-2').includes(`${header}${evidenceLine}\n</prior_attempt>`), stdin('ckpt-2'));
      assert.ok(stdin('ckpt-3').includes(`${header}${evidenceLine}\n${invalidLine}\nThis is the last attempt: a second invalid decision goes to the owner as a request.\n</prior_attempt>`), stdin('ckpt-3'));
      assert.doesNotMatch(stdin('ckpt-3'), /<refused_proposals>/, 'the trigger\'s own rejections are not repeated as refused proposals');
    } finally {
      r.journal.close();
    }
  });

  test('bundle.rule-race-stale (paid M4a run 1): a `rule` landing C-2 during the checkpoint call, whose bundle lands C-2 and C-3, rejects the bundle stale, never crashing; the re-evaluation lands C-3', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      appendSteps(d, [
        checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-2'), ruleOp('C-3')], rulings: [checkpointRuling('C-2'), checkpointRuling('C-3')] }), [barrier]),
        checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-3')], rulings: [checkpointRuling('C-3')] })),
      ]);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      const ruled = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2')));
      assert.equal(ruled.kind, 'applied', JSON.stringify(ruled));
      release(d.scenarioDir, 'ckpt');
      const first = await running;
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'stale', JSON.stringify(first));
      assert.match(first.decision.detail, /the rulings ledger changed since the checkpoint read it/);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
      assert.deepEqual(decisions(r), [['ckpt-1', 'rejected:stale']]);
      assert.deepEqual(bundleRevs(r), [[r.journal.view.planApplied()!.rev, 'ckpt-2']]);
      assert.deepEqual(Object.keys(keptPayload(r.ctx.runDir, r.journal.view.planApplied()!.payloadSha256!).manifest.rulings.sidecars).sort(), ['C-2', 'C-3'], 'the owner\'s C-2 and the re-evaluation\'s C-3 (C-1 is a ledger line without a sidecar)');
    } finally {
      r.journal.close();
    }
  });

  test('bundle.ruling-id-collision-invalid (paid M4a run 1): a bundle landing C-2, which the ledger already holds, and C-3 is rejected invalid with the collision as its reason, never crashing', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const ruled = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2')));
      assert.equal(ruled.kind, 'applied', JSON.stringify(ruled));
      const colliding = checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-2'), ruleOp('C-3')], rulings: [checkpointRuling('C-2'), checkpointRuling('C-3')] });
      appendSteps(d, [checkpointStep('ckpt-1', colliding), jobRepairStep('ckpt-1', colliding, ['C-2 is already in the ledger'])]);
      const rev = r.journal.view.planApplied()!.rev;
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'invalid', JSON.stringify(out));
      assert.equal(out.decision.detail, 'C-2 is already in the ledger (a ruling is never edited: supersede it)', 'C-3, checked against the ledger without the invalid C-2, is valid');
      assert.equal(r.journal.view.planApplied()!.rev, rev, 'nothing applied');
    } finally {
      r.journal.close();
    }
  });

  // 2026-10-15 (arc feedback #3): the checkpoint's own output is never refused on bookkeeping it can correct.
  test('bundle.repair-turn-applies: an invalid bundle goes back once to the same session with every reason; the corrected answer applies, no invalid decision recorded', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      appendSteps(d, [
        checkpointStep('ckpt-1', twoOpBundleSecondInvalid()),
        jobRepairStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [VALID_OP] }), ['V-999', 'no-such-unit']),
      ]);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      assert.deepEqual(decisions(r), [], 'the applied revision is the decision: nothing was rejected');
      assert.deepEqual(planLimits(r), { convergenceK: 3 });
      const [fresh, repair] = readCalls(d.scenarioPath).filter((c) => c.unit === 'ckpt-1');
      assert.equal(repair!.argv[repair!.argv.indexOf('--resume') + 1], fresh!.argv[fresh!.argv.indexOf('--session-id') + 1], 'the repair turn resumes the refused answer\'s session');
      assert.equal(repair!.argv[repair!.argv.indexOf('--json-schema') + 1], fresh!.argv[fresh!.argv.indexOf('--json-schema') + 1], 'with the call\'s own schema');
      assert.equal(repair!.cwd, fresh!.cwd, 'in the checkout of the captured head, made again');
      assert.ok(!fresh!.argv.includes('--no-session-persistence'), 'the checkpoint\'s fresh session persists for its repair turn');
      assert.deepEqual(outputOf(ctx, jobIdOf('ckpt-1'))?.output.ops.map((o) => o.op), ['limits'], 'the job acts on the repaired answer');
    } finally {
      r.journal.close();
    }
  });

  test('bundle.repair-turn-schema: a ruling missing a field is off the answer\'s schema; the repair turn is told which, and the completed ruling lands', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const full = JSON.parse(checkpointRuling('C-2')) as Record<string, JsonValue>;
      const { trigger: _t, ...missing } = full;
      const answer = (ruling: JsonValue): JsonValue => ({ ...(checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-2')], rulings: [checkpointRuling('C-2')] }) as Record<string, JsonValue>), rulings: [ruling] });
      appendSteps(d, [checkpointStep('ckpt-1', answer(missing)), jobRepairStep('ckpt-1', answer(full), ['malformed: ', '$.rulings[0]'])]);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      assert.deepEqual(Object.keys(keptPayload(r.ctx.runDir, r.journal.view.planApplied()!.payloadSha256!).manifest.rulings.sidecars), ['C-2']);
    } finally {
      r.journal.close();
    }
  });

  test('bundle.duplicate-bookkeeping: a ruling listed twice and its rule op given twice, both exactly, land once; two different rule ops of one ruling are a reason', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const twice = checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-2'), ruleOp('C-2')], rulings: [checkpointRuling('C-2'), checkpointRuling('C-2')] });
      appendSteps(d, [checkpointStep('ckpt-1', twice)]);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const ledger = keptPayload(r.ctx.runDir, r.journal.view.planApplied()!.payloadSha256!).manifest.rulings;
      assert.deepEqual(Object.keys(ledger.sidecars), ['C-2']);
    } finally {
      r.journal.close();
    }
    const e = checkpointArc(visionLenses('audit-1'));
    const s = contextFor(e);
    const { ctx: ctx2 } = checkpointContext(s);
    try {
      await completedAudit(s, ctx2);
      const differing = checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-2'), { ...(ruleOp('C-2') as Record<string, JsonValue>), evidence: ['another reading'] }], rulings: [checkpointRuling('C-2')] });
      const reason = 'ops 1 and 2 both land ruling C-2, differently: land it through one `rule` op';
      appendSteps(e, [checkpointStep('ckpt-1', differing), jobRepairStep('ckpt-1', differing, [reason])]);
      const out = await runCheckpoint(ctx2);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'invalid', JSON.stringify(out));
      assert.equal(out.decision.detail, reason);
    } finally {
      s.journal.close();
    }
  });

  test('bundle.draining-request: while draining, a bundle that admits becomes a non-blocking bundle request; acknowledged `apply`, the next job enacts it without asking again', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      appendSteps(d, [checkpointStep('ckpt-1', bundle([admitOp(d, 'u2')]))]);
      await completedAudit(r, ctx);
      r.journal.fact({ kind: 'admissions-closed', command: commandId('cmd-dddddddddddddddd') });
      const rev = r.journal.view.planApplied()!.rev;
      const first = await runCheckpoint(ctx);
      assert.ok(first.kind === 'decided' && first.decision.kind === 'requested' && first.decision.reason === 'bundle-request', JSON.stringify(first));
      const n = item(r, first.decision.needsUser);
      assert.deepEqual([n.blocking, n.options.map((o) => o.id)], [false, ['apply', 'reject']]);
      assert.equal(r.journal.view.planApplied()!.rev, rev, 'nothing applied');
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' }, 'the request waits for the owner');
      await ack(w, r, first.decision.needsUser, 'apply');
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.job === 'ckpt-2' && second.decision.kind === 'applied', JSON.stringify(second));
      assert.equal(requirePlan(r).units.find((u) => u.id === 'u2')?.origin, 'checkpoint');
      assert.deepEqual(checkpointCalls(r), ['ckpt-1'], 'the enactment asked nothing');
      assert.deepEqual(factsOfKind(r, 'divergence').map((x) => [x.job, x.type]), [['ckpt-2', 'plan-departed']]);
    } finally {
      r.journal.close();
    }
  });

  test('bundle.nested-owner-only (H10): an admit whose lane runs a program no lane in force runs and passes a new env prerequisite raises one blocking owner request; nothing applies', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      const lane = { id: 'py', argv: ['python3', 'check.py'], cwd: '.', env: { set: {}, pass: ['PATH', 'SECRET_TOKEN'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], state: 'active' };
      appendSteps(d, [checkpointStep('ckpt-1', bundle([limitsOp('retries', 2), admitOp(d, 'u2', [lane])]))]);
      await completedAudit(r, ctx);
      const rev = r.journal.view.planApplied()!.rev;
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'requested' && out.decision.reason === 'owner-request', JSON.stringify(out));
      const n = item(r, out.decision.needsUser);
      assert.equal(n.blocking, true);
      assert.match(n.summary, /\[lane-program\] lane py runs "python3"/);
      assert.match(n.summary, /\[env-prerequisite\] lane py passes SECRET_TOKEN/);
      assert.equal(r.journal.view.planApplied()!.rev, rev, 'nothing applied, the valid limits op included');
      assert.deepEqual(factsOfKind(r, 'divergence'), []);
      const vision = factsOfKind(r, 'checkpoint-inputs')[0]!.visionSha256;
      await ack(w, r, out.decision.needsUser);
      assert.deepEqual([...quiescentGenerations(r.journal.view, vision)], [1], 'the owner answered: the generation is quiescent');
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
    } finally {
      r.journal.close();
    }
  });

  test('bundle.withdrawn-cite-invalid (H16): an op citing a withdrawn clause is invalid', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await applyVision(r, w, [{ id: 'V-3', kind: 'good', text: 'Errors are silent.', rank: null, state: 'withdrawn' }]);
      const withdrawn = bundle([{ op: 'limits', unit: null, limits: [{ field: 'retries', value: 2 }], cites: ['V-3'], evidence: ['e'] }]);
      appendSteps(d, [checkpointStep('ckpt-1', withdrawn), jobRepairStep('ckpt-1', withdrawn, ['cites V-3, which is withdrawn'])]);
      await completedAudit(r, ctx);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'invalid', JSON.stringify(out));
      assert.match(out.decision.detail, /cites V-3, which is withdrawn/);
      assert.equal(planLimits(r), null);
    } finally {
      r.journal.close();
    }
  });

  test('bundle.admit-widens-obligations (lead ruling, paid M3 run 5): a checkpoint admit whose spec omits an obligation the mapping selects for its scope applies, its declaration completed by code', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'), { units: [{ id: 'u1', obligations: ['I-1'] }], mapping: mapped(['I-1']) });
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      const op = admitOp(d, 'u2') as Record<string, JsonValue>;
      const spec = op['spec'] as Record<string, JsonValue>;
      appendSteps(d, [checkpointStep('ckpt-1', bundle([{ ...op, spec: { ...spec, obligations: [] } }]))]);
      await completedAudit(r, ctx);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const sha = r.journal.view.planApplied()!.specs[unitId('u2')]!;
      const kept = JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${sha}.spec.json`), 'utf8')) as { obligations?: readonly string[] };
      assert.deepEqual(kept.obligations, ['I-1'], 'declared ∪ mapping-selected');
    } finally {
      r.journal.close();
    }
  });

  test('bundle.weakening-applies-with-divergence (OR-V): a ruling waiving an obligation, citing an active clause, applies without asking and records an obligation-departed divergence', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      const ruling = JSON.stringify({
        schema: 'roadmap/ruling-m3', id: 'C-2', statement: 'I-1 is waived while the helpers are rewritten.', kind: 'disposition', trigger: 'checkpoint',
        supersedes: [], condition: null, docRefs: [{ path: 'contracts/api.md', anchor: '#api-contract', quotedText: 'returns the sum', relation: 'consistent' }],
        contractRefs: [], contractOps: [], obligations: ['I-1'], obligationDispositions: [{ id: 'I-1', disposition: 'waived' }], cites: ['V-1'],
        evidence: ['I-1 blocks the rewrite the vision asks for'], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
      });
      const ops = [
        { op: 'rule', ruling: 'C-2', cites: ['V-1'], evidence: ['I-1 blocks the rewrite'] },
        { op: 'obligation-dispose', obligation: 'I-1', disposition: 'waived', ruling: 'C-2', cites: ['V-1'], evidence: ['I-1 blocks the rewrite'] },
      ];
      appendSteps(d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops, rulings: [ruling] }))]);
      await completedAudit(r, ctx);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const applied = r.journal.view.planApplied()!;
      assert.deepEqual(applied.source, { type: 'bundle', job: 'ckpt-1' });
      assert.ok(applied.changes.some((c) => c.type === 'obligation' && c.id === 'I-1' && c.edit === 'disposed'), JSON.stringify(applied.changes));
      const obligations = JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${applied.obligationsSha256}.obligations.json`), 'utf8')) as { obligations: { id: string; state: unknown }[] };
      assert.deepEqual(obligations.obligations.find((o) => o.id === 'I-1')!.state, { type: 'waived', ruling: 'C-2' });
      const sidecar = keptPayload(r.ctx.runDir, applied.payloadSha256!).manifest.rulings.sidecars['C-2' as never];
      const kept = JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${sidecar}.ruling.json`), 'utf8')) as { ruledBy: unknown; consistency: { by: { role: string } } };
      assert.deepEqual(kept.ruledBy, { type: 'checkpoint', job: 'ckpt-1' }, 'the executor stamped who ruled');
      assert.equal(kept.consistency.by.role, 'checkpoint');
      assert.deepEqual(factsOfKind(r, 'divergence').map((x) => [x.type, x.from, x.cites, x.compensation.kind]), [['obligation-departed', 'I-1 rev 1', ['V-1'], 'restore-revision']]);
      assert.deepEqual([...itemsOf(r, 'owner-request'), ...itemsOf(r, 'bundle-request')], [], 'nobody was asked');
    } finally {
      r.journal.close();
    }
  });

  test('bundle.lane-unrunnable-invalid (paid M4b run 3, OP-3): an admit whose lane cannot resolve its argv[0] on its own PATH is invalid through the apply core\'s lane row; nothing applies', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      // The program every lane in force runs (so no owner-only lane-program request), on a PATH that does not hold it.
      const lane = { id: 'u2', argv: ['node', '--test'], cwd: '.', env: { set: { PATH: tmpDir('empty-path') }, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], state: 'active' };
      const unrunnable = bundle([admitOp(d, 'u2', [lane])]);
      appendSteps(d, [checkpointStep('ckpt-1', unrunnable), jobRepairStep('ckpt-1', unrunnable, ['spec-lane-unrunnable'])]);
      await completedAudit(r, ctx);
      const rev = r.journal.view.planApplied()!.rev;
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'invalid', JSON.stringify(out));
      assert.match(out.decision.detail, /"kind":"spec-lane-unrunnable","lane":"u2","problem":\{"argv0":"node","type":"argv0-unresolvable"\},"unit":"u2"/);
      assert.equal(r.journal.view.planApplied()!.rev, rev, 'nothing applied');
    } finally {
      r.journal.close();
    }
  });

  test('bundle.ruling-for-admitted-unit (paid M4b run 3, OP-2): a ruling applying to a unit the same bundle admits lands, its docs publication included', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      const ruling = JSON.stringify({
        schema: 'roadmap/ruling-m3', id: 'C-2', statement: 'u2 keeps the helpers pure.', kind: 'decision', trigger: 'checkpoint',
        supersedes: [], condition: null, docRefs: [{ path: 'contracts/api.md', anchor: '#api-contract', quotedText: 'returns the sum', relation: 'consistent' }],
        contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: ['V-1'],
        evidence: ['the repair needs a rule of its own'], appliesTo: { type: 'units', units: ['u2'] }, lifetime: 'arc', status: 'active',
      });
      const ops = [admitOp(d, 'u2'), { op: 'rule', ruling: 'C-2', cites: ['V-1'], evidence: ['the repair needs a rule of its own'] }];
      appendSteps(d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops, rulings: [ruling] }))]);
      await completedAudit(r, ctx);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const applied = r.journal.view.planApplied()!;
      assert.ok(applied.publication !== undefined, 'published through its docs publication');
      assert.deepEqual(Object.keys(keptPayload(r.ctx.runDir, applied.payloadSha256!).manifest.rulings.sidecars), ['C-2']);
      assert.equal(requirePlan(r).units.find((u) => u.id === 'u2')?.origin, 'checkpoint');
    } finally {
      r.journal.close();
    }
  });
});

describe('convergence', () => {
  test('convergence.bound-k: at K applied bundles one non-blocking convergence-bound is raised; while open the next bundle is a request; acknowledged, bundles apply again', T, async () => {
    const d = checkpointArc([
      // Each later audit finds something new, so each has its checkpoint (an audit with nothing new has none).
      ...visionLenses('audit-1'), ...noteLenses('audit-2', 'audit-3'),
      checkpointStep('ckpt-1', bundle([limitsOp('candidateReds', 2)])), checkpointStep('ckpt-2', bundle([limitsOp('retries', 2)])),
      checkpointStep('ckpt-3', bundle([limitsOp('redirects', 3)])),
    ]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await applyPlanEdit(r, w, (p) => void (p['limits'] = { convergenceK: 1 }));
      await completedAudit(r, ctx);
      const first = await runCheckpoint(ctx);
      assert.ok(first.kind === 'decided' && first.decision.kind === 'applied', JSON.stringify(first));
      const [bound] = itemsOf(r, 'convergence-bound');
      assert.equal(bound?.blocking, false);
      await completedAudit(r, ctx);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'requested' && second.decision.reason === 'bundle-request', JSON.stringify(second));
      assert.match(item(r, second.decision.needsUser).summary, /a convergence brake is open/);
      await ack(w, r, bound!.id);
      await completedAudit(r, ctx);
      const third = await runCheckpoint(ctx);
      assert.ok(third.kind === 'decided' && third.decision.kind === 'applied', JSON.stringify(third));
      assert.deepEqual(bundleRevs(r).map(([, job]) => job), ['ckpt-1', 'ckpt-3']);
      assert.equal(itemsOf(r, 'convergence-bound').length, 2, 'the counter restarted at the acknowledgement and reached K again');
    } finally {
      r.journal.close();
    }
  });

  test('convergence.bound-identity: a second material change of one causal identity (F-1 @ arc) becomes a bundle request and raises convergence-identity; units are not held', T, async () => {
    const d = checkpointArc([
      ...visionLenses('audit-1'), ...noteLenses('audit-2'),
      checkpointStep('ckpt-1', bundle([limitsOp('candidateReds', 2, ['F-1 asks for another candidate round'])])),
      checkpointStep('ckpt-2', bundle([limitsOp('retries', 2, ['F-1 still fails'])])),
    ]);
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      openVisionFinding(r, 'audit-1', 'candidates flake');
      assert.equal((await runCheckpoint(ctx)).kind, 'decided');
      assert.deepEqual(bundleRevs(r).map(([, job]) => job), ['ckpt-1']);
      await completedAudit(r, ctx);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'requested', JSON.stringify(second));
      const [identity] = itemsOf(r, 'convergence-identity');
      assert.equal(identity?.blocking, false);
      assert.match(item(r, identity!.id).summary, /F-1@arc/);
      assert.deepEqual(bundleRevs(r).map(([, job]) => job), ['ckpt-1'], 'the second change did not apply');
      assert.deepEqual(r.journal.view.needsUser().filter((n) => n.blocking), [], 'nothing blocks a unit');
    } finally {
      r.journal.close();
    }
  });
});

describe('divergences', () => {
  test('bundle.compensating: `reverse` of an applied bundle\'s divergence restores the plan it departed from, through the apply core', T, async () => {
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', bundle([limitsOp('retries', 2)]))]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const before = r.journal.view.planApplied()!;
      assert.equal((await runCheckpoint(ctx)).kind, 'decided');
      assert.deepEqual(planLimits(r), { retries: 2 });
      const [dv] = factsOfKind(r, 'divergence');
      assert.deepEqual([dv!.type, dv!.preimage.planRev, dv!.compensation.kind], ['plan-departed', before.rev, 'restore-revision']);
      const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'reverse', divergence: dv!.id as DivergenceId }));
      assert.equal(out.kind, 'applied', JSON.stringify(out));
      assert.equal(planLimits(r), null);
      assert.equal(r.journal.view.planApplied()!.planSha256, before.planSha256, 'the compensating revision restores the preimage plan');
    } finally {
      r.journal.close();
    }
  });

  test('digest.binds-ids (H11): a digest binds the ids uncovered when raised; later divergences wait while it is open; its acknowledgement covers exactly its ids and the next digest binds the rest', T, async () => {
    const d = checkpointArc([
      ...visionLenses('audit-1'), ...noteLenses('audit-2'), checkpointStep('ckpt-1', bundle([limitsOp('retries', 2)])), checkpointStep('ckpt-2', bundle([limitsOp('redirects', 3)])),
    ]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      await runCheckpoint(ctx);
      await completedAudit(r, ctx);
      await runCheckpoint(ctx);
      assert.deepEqual(factsOfKind(r, 'divergence').map((x) => x.id), ['D-1', 'D-2']);
      const digests = () => factsOfKind(r, 'divergence-digest').map((x) => x.ids);
      assert.deepEqual(digests(), [['D-1']], 'D-2 waits while the first digest is open');
      await ack(w, r, factsOfKind(r, 'divergence-digest')[0]!.needsUser);
      assert.deepEqual(uncoveredDivergences(r.journal.view).map((x) => x.id), ['D-2'], 'the acknowledgement covers exactly D-1');
      raiseDigest({ journal: r.journal, runDir: r.ctx.runDir });
      assert.deepEqual(digests(), [['D-1'], ['D-2']]);
      assert.deepEqual(uncoveredDivergences(r.journal.view).map((x) => x.id), ['D-2']);
      assert.equal(raiseDigest({ journal: r.journal, runDir: r.ctx.runDir }), null, 'one open digest at a time');
    } finally {
      r.journal.close();
    }
  });

  test('divergence.preimage-no-inverse (H13): a spec patch\'s divergence records the spec rev it departed from and a hint, no inverse; `reverse` builds the compensation fresh', T, async () => {
    const cite = { op: 'patch-spec', unit: 'u1', patch: [{ op: 'cite', contracts: ['contracts/api.md'], rulings: ['C-1'] }], cites: ['V-1'], evidence: ['u1 must cite the api'] };
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', bundle([cite]))]);
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const before = r.journal.view.planApplied()!;
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const [dv] = factsOfKind(r, 'divergence');
      assert.deepEqual(Object.keys(dv!).sort(), ['cites', 'compensation', 'evidence', 'from', 'id', 'index', 'job', 'kind', 'preimage', 'type', 'what']);
      assert.deepEqual(dv!.preimage, { planRev: before.rev, specs: { u1: 1 }, obligationsSha256: null, ledgerSha256: null, contracts: [] });
      assert.deepEqual([dv!.from, dv!.compensation.kind], ['spec of u1 rev 1', 'restore-revision']);
      assert.notEqual(r.journal.view.planApplied()!.specs[unitId('u1')], before.specs[unitId('u1')]);
      const reversed = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'reverse', divergence: dv!.id as DivergenceId }));
      assert.equal(reversed.kind, 'applied', JSON.stringify(reversed));
      assert.equal(r.journal.view.planApplied()!.specs[unitId('u1')], before.specs[unitId('u1')], 'u1\'s spec as the preimage recorded it');
    } finally {
      r.journal.close();
    }
  });

  test('divergence.patch-of-introduced-unit (a real arc\'s crash loop): a bundle re-entering u1 as u1-r2 and patching u1-r2\'s spec applies; the patch departs from the plan rev, as the re-entry does', T, async () => {
    const cite = { op: 'patch-spec', unit: 'u1-r2', patch: [{ op: 'cite', contracts: ['contracts/api.md'], rulings: ['C-1'] }], cites: ['V-1'], evidence: ['u1-r2 must cite the api'] };
    const empty: readonly Step[] = [{ ...planCheckStep({ decision: 'approve' }), unit: 'u1' }, { ...codexStep([], { argv: ['exec', '-C'] }), unit: 'u1' }];
    const d = checkpointArc(empty, { units: [{ id: 'u1', lanes: [] }] });
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      assert.equal((await runUnit(ctx, r.unit('u1'), admitAll)).kind, 'parked');
      const park = r.journal.view.unit(unitId('u1')).decided!;
      const reenter = { op: 'reenter', unit: 'u1-r2', reenters: 'u1', enterAt: null, reset: null, fixes: `u1/${park.stage}#${park.attempt}`, cites: ['V-1'], evidence: ['u1 must start over'] };
      appendSteps(d, [checkpointStep('ckpt-1', bundle([reenter, cite]))]);
      const before = r.journal.view.planApplied()!;
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const pre = { planRev: before.rev, specs: {}, obligationsSha256: null, ledgerSha256: null, contracts: [] };
      assert.deepEqual(factsOfKind(r, 'divergence').map((x) => [x.index, x.type, x.from, x.preimage]), [[0, 'plan-departed', `plan rev ${before.rev}`, pre], [1, 'plan-departed', `plan rev ${before.rev}`, pre]]);
      assert.match(factsOfKind(r, 'divergence')[1]!.what, /^patches u1-r2's spec: cite \(a unit this bundle introduces\)$/);
      assert.equal(r.journal.view.planApplied()!.specs[unitId('u1-r2')] !== undefined, true);
    } finally {
      r.journal.close();
    }
  });

  test('ckpt.park-diagnosis-and-unchanged-reentry (arc feedback 2026-10-16; dev.12): a park checkpoint reads the lineage\'s failures with their references; a re-entry naming no failure is refused, and the repair turn that cites the design park applies the re-entry unchanged', T, async () => {
    const empty: readonly Step[] = [{ ...planCheckStep({ decision: 'approve' }), unit: 'u1' }, { ...codexStep([], { argv: ['exec', '-C'] }), unit: 'u1' }];
    const d = checkpointArc(empty, { units: [{ id: 'u1', lanes: [] }] });
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      assert.equal((await runUnit(ctx, r.unit('u1'), admitAll)).kind, 'parked');
      const park = r.journal.view.unit(unitId('u1')).decided!;
      const ref = `u1/${park.stage}#${park.attempt}`;
      const reenter = { op: 'reenter', unit: 'u1-r2', reenters: 'u1', enterAt: null, reset: null, fixes: ref, cites: ['V-1'], evidence: [`${ref} parked u1`] };
      appendSteps(d, [
        checkpointStep('ckpt-1', bundle([{ ...reenter, fixes: null }])),
        jobRepairStep('ckpt-1', bundle([reenter]), [`unit u1-r2 re-enters u1 without \`fixes\`: name the failure it fixes, one of ${ref}`]),
      ]);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const stdin = readCalls(d.scenarioPath).find((c) => c.unit === 'ckpt-1')!.stdin;
      const diagnosis = /<\/trigger>\n\n<diagnosis>\n([^]*?)<\/diagnosis>/.exec(stdin)?.[1] ?? assert.fail(stdin);
      assert.match(diagnosis, new RegExp(`\\nUnit u1:\\n- ${ref}: ${park.stage} attempt ${park.attempt} ended ${park.outcome}[^\\n]*, parked design\\n$`));
      assert.equal(requirePlan(r).units.find((u) => u.id === 'u1-r2')?.reenters?.fixes, ref, 'the citation is in the plan in force');
    } finally {
      r.journal.close();
    }
  });
});

describe('executor faults', () => {
  test('bundle.fault-decided: an exception judging a bundle is decided invalid, naming the fault, never crashing; the recorded output is not judged again and the trigger re-evaluates', T, async () => {
    const d = checkpointArc([
      ...visionLenses('audit-1'), checkpointStep('ckpt-1', bundle([limitsOp('retries', 2)]), [barrier]), checkpointStep('ckpt-2', bundle([limitsOp('retries', 2)])),
    ]);
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      // A kept input that no longer hashes to its name: a condition that never happens, so judging it throws.
      const spec = inputPath(r.ctx.runDir, r.journal.view.planApplied()!.specs[unitId('u1')]!, SPEC_INPUT);
      const bytes = readFileSync(spec);
      writeFileSync(spec, 'corrupt');
      release(d.scenarioDir, 'ckpt');
      const first = await running;
      writeFileSync(spec, bytes);
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'invalid', JSON.stringify(first));
      assert.match(first.decision.detail, /^the executor failed judging it \(an executor fault, not the bundle's\): .* does not hash to its name$/);
      assert.equal(planLimits(r), null);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.job === 'ckpt-2' && second.decision.kind === 'applied', JSON.stringify(second));
      assert.deepEqual(decisions(r), [['ckpt-1', 'rejected:invalid']]);
      assert.deepEqual(bundleRevs(r).map(([, job]) => job), ['ckpt-2']);
      assert.deepEqual(planLimits(r), { retries: 2 });
    } finally {
      r.journal.close();
    }
  });
});

describe('design parks (OR-Q1)', () => {
  test('ckpt.design-park-respec-first: a design park goes to the checkpoint first (its item held back); the respec applies; a second design park on the lineage raises respec-second', T, async () => {
    const empty = (): readonly Step[] => [{ ...planCheckStep({ decision: 'approve' }), unit: 'u1' }, { ...codexStep([], { argv: ['exec', '-C'] }), unit: 'u1' }];
    const cite = { op: 'patch-spec', unit: 'u1', patch: [{ op: 'cite', contracts: ['contracts/api.md'], rulings: ['C-1'] }], cites: ['V-1'], evidence: ['u1 parked on an empty diff'] };
    const d = checkpointArc([...empty(), checkpointStep('ckpt-1', bundle([cite])), ...empty()], { units: [{ id: 'u1', lanes: [] }] });
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      const parked = await runUnit(ctx, r.unit('u1'), admitAll);
      assert.equal(parked.kind, 'parked');
      assert.deepEqual(designParkRoute(ctx, unitId('u1')), { kind: 'checkpoint' }, 'the park item waits for the checkpoint');
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.trigger.type === 'park' && out.decision.kind === 'applied', JSON.stringify(out));
      assert.deepEqual(designParkRoute(ctx, unitId('u1')), { kind: 'respecified', planRev: r.journal.view.planApplied()!.rev });
      const resumed = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'resume', target: { type: 'unit', unit: unitId('u1') } }));
      assert.equal(resumed.kind, 'applied', JSON.stringify(resumed));
      assert.equal((await runUnit(ctx, r.unit('u1'), admitAll)).kind, 'parked', 'the respecified unit parks on its design again');
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' }, 'the second park is not the checkpoint\'s');
      assert.deepEqual(designParkRoute(ctx, unitId('u1')), { kind: 'respec-second' });
      const [second] = itemsOf(r, 'respec-second');
      assert.equal(second?.blocking, true);
      assert.deepEqual(checkpointCalls(r), ['ckpt-1']);
    } finally {
      r.journal.close();
    }
  });
});

describe('P1s and their repair (paid m3 run 9)', () => {
  test('bundle.p1-left-to-repair: a checkpoint accepting a P1 is invalid; left undispositioned and named in an admitted repair\'s repairs, the bundle applies, the repair owns it, merges and resolves it', T, async () => {
    const p1 = { severity: 'P1' as const, obligation: 'I-1', claim: 'I-1 is witnessed too weakly' };
    const d = checkpointArc([lensStep('audit-1', 'invariants', [p1]), lensStep('audit-1', 'vision')], {
      units: [{ id: 'u1', obligations: ['I-1'] }], mapping: mapped(['I-1']), audit: { lenses: ['invariants', 'vision'] },
    });
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      const op = admitOp(d, 'r1') as Record<string, JsonValue>;
      const spec = { ...(op['spec'] as Record<string, JsonValue>), repairs: ['F-1'] };
      const repair = { ...op, unit: { ...(op['unit'] as Record<string, JsonValue>), origin: 'repair' }, spec };
      const accepting = checkpointAnswer({ decision: 'bundle', ops: [repair], findingDispositions: [{ finding: 'F-1', disposition: 'accepted', reason: 'handled by r1' }] });
      appendSteps(d, [
        checkpointStep('ckpt-1', accepting), jobRepairStep('ckpt-1', accepting, ['finding F-1 is a P1: P1s never bank']), checkpointStep('ckpt-2', bundle([repair])),
        { ...planCheckStep({ decision: 'approve' }), unit: 'r1' }, { ...mulBuild(), unit: 'r1' }, { ...gateStep({ decision: 'approve' }), unit: 'r1' },
      ]);
      await completedAudit(r, ctx);
      const finding = () => r.journal.view.holistic().findings.find((f) => f.id === 'F-1')!;
      assert.deepEqual([finding().severity, finding().obligation, finding().state], ['P1', 'I-1', 'open']);
      const first = await runCheckpoint(ctx);
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'invalid', JSON.stringify(first));
      assert.match(first.decision.detail, /finding F-1 is a P1: P1s never bank/);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
      assert.deepEqual(requirePlan(r).units.find((u) => u.id === 'r1')?.origin, 'repair');
      // The executor's context follows the plan in force (this test's own does not follow a revision).
      const plan = () => requirePlanInForce(ctx.runDir, r.journal.view).plan;
      const live = { ...ctx, plan, ...serialRuntime({ ...ctx, plan }) };
      syncRepairs(live);
      assert.deepEqual([finding().state, finding().owner], ['owned', 'r1'], 'the admitted repair owns it');
      const r1 = live.plan().units.find((u) => u.id === 'r1')!;
      assert.deepEqual(await runUnit(live, r1, admitAll), { kind: 'merged' });
      assert.equal(finding().state, 'resolved', 'its repair published: the P1 is resolved, never banked');
    } finally {
      r.journal.close();
    }
  });
});

describe('the convergence tail (dev.13, src/holistic/tail.ts)', () => {
  test('tail.settled-brake-arc: with every planned unit merged (no milestones), a repair admitted for a P2 converts settled-brake; the P2 is released by code; the checkpoint was shown the brake; status counts both', T, async () => {
    const p2 = { severity: 'P2' as const, obligation: null, claim: 'The mul test could also check negative zero.', cause: 'mul test: no negative zero' };
    const d = checkpointArc([
      { ...planCheckStep({ decision: 'approve' }), unit: 'u1' }, { ...mulBuild(), unit: 'u1' }, { ...gateStep({ decision: 'approve' }), unit: 'u1' },
      lensStep('audit-1', 'vision', [p2]),
    ]);
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      const plan = () => requirePlanInForce(ctx.runDir, r.journal.view).plan;
      const live = { ...ctx, plan, ...serialRuntime({ ...ctx, plan }) };
      assert.deepEqual(await runUnit(live, live.plan().units.find((u) => u.id === 'u1')!, admitAll), { kind: 'merged' });
      const op = admitOp(d, 'r1') as Record<string, JsonValue>;
      const repair = { ...op, unit: { ...(op['unit'] as Record<string, JsonValue>), origin: 'repair' }, spec: { ...(op['spec'] as Record<string, JsonValue>), repairs: ['F-1'] } };
      appendSteps(d, [{ ...checkpointStep('ckpt-1', bundle([repair])), expect: { stdinContains: ['<brakes>\nThe arc is at the settled point', 'Findings below a brake: F-1 (settled)'] } }]);
      await completedAudit(r, ctx);
      const rev = r.journal.view.planApplied()!.rev;
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
      assert.deepEqual(out.decision, { kind: 'no-op', conversions: [{ index: 0, unit: 'r1', reason: 'settled-brake', opportunity: null }] });
      assert.equal(r.journal.view.planApplied()!.rev, rev, 'nothing applied: r1 is never admitted');
      const f = r.journal.view.holistic().findings.find((x) => x.id === 'F-1')!;
      assert.deepEqual([f.state, f.last], ['ruled', { state: 'ruled', disposition: 'released', by: { type: 'release', job: 'ckpt-1', reason: 'settled' } }]);
      assert.deepEqual(factsOfKind(r, 'corpus-amendment'), [], 'a brake\'s conversion is never an amendment');
      const s = status(absPath(d.runDir), arcId(d.arc), absPath(d.hostDir));
      assert.deepEqual([s.findings.released.settled, s.findings.refusedAdmits], [1, { regress: 0, settled: 1 }]);
      assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
    } finally {
      r.journal.close();
    }
  });
  test('tail.repaired-accepted-arc: a P2 named in an admitted repair\'s repairs and disposed accepted in the same decision is not ruled; the repair owns it and resolves it when it publishes (m5 run 6, F-18)', T, async () => {
    const p2 = { severity: 'P2' as const, obligation: null, claim: 'The mul command prints no unit.', cause: 'mul output: no unit' };
    const d = checkpointArc([lensStep('audit-1', 'vision', [p2])]);
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      const op = admitOp(d, 'r1') as Record<string, JsonValue>;
      const repair = { ...op, unit: { ...(op['unit'] as Record<string, JsonValue>), origin: 'repair' }, spec: { ...(op['spec'] as Record<string, JsonValue>), repairs: ['F-1'] } };
      appendSteps(d, [
        checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [repair], findingDispositions: [{ finding: 'F-1', disposition: 'accepted', reason: 'r1 repairs it' }] })),
        { ...planCheckStep({ decision: 'approve' }), unit: 'r1' }, { ...mulBuild(), unit: 'r1' }, { ...gateStep({ decision: 'approve' }), unit: 'r1' },
      ]);
      await completedAudit(r, ctx);
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
      const finding = () => r.journal.view.holistic().findings.find((f) => f.id === 'F-1')!;
      assert.deepEqual([finding().state, finding().last], ['open', null], 'the accepted disposition is not written');
      const plan = () => requirePlanInForce(ctx.runDir, r.journal.view).plan;
      const live = { ...ctx, plan, ...serialRuntime({ ...ctx, plan }) };
      syncRepairs(live);
      assert.deepEqual([finding().state, finding().owner], ['owned', 'r1']);
      assert.deepEqual(await runUnit(live, live.plan().units.find((u) => u.id === 'r1')!, admitAll), { kind: 'merged' });
      assert.equal(finding().state, 'resolved', 'its repair published');
    } finally {
      r.journal.close();
    }
  });
});

describe('park causes (paid m3 run 7)', () => {
  test('ckpt.park-cause: a candidate-red park reaches the checkpoint as an executor-side cause, with the spent bound and the obligation its candidate left red, never as a design question', T, async () => {
    const { d, control } = auditArc({
      steps: [
        { ...planCheckStep({ decision: 'approve' }), unit: 'u1' }, { ...mulBuild(), unit: 'u1' }, { ...gateStep({ decision: 'approve' }), unit: 'u1' },
        // The fix round changes nothing: the same candidate tree, red again.
        { ...codexStep([], { argv: ['exec', 'resume'], stdinContains: ['Obligation I-1 must hold on the candidate'] }), unit: 'u1' },
        { ...gateStep({ decision: 'approve' }), unit: 'u1' },
        checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
      ],
      units: [{ id: 'u1' }], obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass' } } }, mapping: [], audit: { lenses: ['vision'] },
    });
    const r = contextFor(d);
    const { ctx } = checkpointContext(r);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      scriptTree(control, candidateTree(d, 'u1'), { outcomes: { t1: 'fail' } });
      assert.equal((await runUnit(ctx, r.unit('u1'), admitAll)).kind, 'parked');
      const park = r.journal.view.unit(unitId('u1')).decided!;
      assert.deepEqual([park.stage, park.outcome], ['candidate', 'red']);
      assert.deepEqual(designParkRoute(ctx, unitId('u1')), { kind: 'checkpoint' });
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.trigger.type === 'park' && out.decision.kind === 'no-op', JSON.stringify(out));
      const stdin = readCalls(d.scenarioPath).find((c) => c.unit === 'ckpt-1')!.stdin;
      const seq = r.journal.view.decidedSeq(unitId('u1'));
      assert.ok(stdin.includes(`This checkpoint runs because unit u1 parked (log seq ${seq}) on an executor-side cause, not a design question: its candidate attempt ${park.attempt} ended red and the executor parked it (candidate-red). Its candidate was red again after 1 fix round: the candidate-red bound is spent. Obligation I-1 must hold on the candidate and does not (red)`), stdin);
      assert.doesNotMatch(stdin, /parked on a design question/);
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash: the checkpoint job and the bundle's activation (the matrix rows CHECKPOINT_JOB and BUNDLE_ACTIVATE)

// Each label once per checkpoint (counted with test/fixtures/pm-record.ts), so each cell is crashed at the arc's first
// checkpoint and at its second (`#2`): ckpt-1 applied in setup with its divergence D-1 and its digest open, then audit-2
// and the crashed ckpt-2. The second resumes as ckpt-2 from its own inputs, numbers its divergences on from D-1 keyed
// (ckpt-2, i), and raises no second digest while D-1's is open.
for (const row of [CHECKPOINT_JOB, BUNDLE_ACTIVATE]) {
  describe(`matrix row ${row}`, () => {
    for (const cell of crashCells(row)) for (const second of [false, true]) {
      test(`checkpoint crashed at ${cell.boundary} ${cell.label}${second ? '#2 (the arc\'s second checkpoint)' : ''}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
        const noop = cell.label === 'bundle.after-decided';
        const job = second ? 'ckpt-2' : 'ckpt-1';
        const audit = second ? 'audit-2' : 'audit-1';
        const d = second ? checkpointArc([...visionLenses('audit-1', 'audit-2'), checkpointStep('ckpt-1', bundle([limitsOp('retries', 2)]))]) : checkpointArc(visionLenses('audit-1'));
        const setup = contextFor(d);
        const { ctx: sctx } = checkpointContext(setup);
        await completedAudit(setup, sctx);
        if (second) {
          const first = await runCheckpoint(sctx);
          assert.ok(first.kind === 'decided' && first.job === 'ckpt-1' && first.decision.kind === 'applied', JSON.stringify(first));
          assert.deepEqual(factsOfKind(setup, 'divergence-digest').map((x) => x.ids), [['D-1']]);
          await completedAudit(setup, sctx);
        }
        const finding = openVisionFinding(setup, audit, 'helpers round');
        appendSteps(d, [checkpointStep(job, bundle(noop ? [] : [VALID_OP], { dispose: [finding], interpretations: true }))]);
        setup.journal.close();
        const trigger = writeTrigger(tmpDir('checkpoint-crash'), { label: cell.label, occurrence: 1 });
        const exit = await runFixture('checkpoint-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
        assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
        assertFired(trigger);
        const r = contextFor(d);
        const { ctx, w } = checkpointContext(r);
        try {
          await recover({ stage: ctx, commands: w.commands });
          const out = await runCheckpoint(ctx);
          if (cell.label.startsWith('bundle.')) assert.deepEqual(out, { kind: 'none' });
          else assert.ok(out.kind === 'decided' && out.job === job && out.decision.kind === 'applied', JSON.stringify(out));
          const jobs = second ? ['ckpt-1', 'ckpt-2'] : ['ckpt-1'];
          assert.deepEqual(factsOfKind(r, 'checkpoint-inputs').map((x) => x.job), jobs, 'one capture per checkpoint');
          assert.deepEqual(checkpointCalls(r), jobs, 'asked once');
          const decided = [...decisions(r), ...bundleRevs(r).map(([, j]) => [j, 'applied'])].sort();
          assert.deepEqual(decided, [...(second ? [['ckpt-1', 'applied']] : []), [job, noop ? 'no-op' : 'applied']], 'decided once');
          const dv = factsOfKind(r, 'divergence').map((x) => [x.id, x.job, x.index, x.type]);
          const own = noop ? [[job, 0, 'interpretation']] : [[job, 0, 'plan-departed'], [job, 1, 'interpretation']];
          const expected = [...(second ? [['ckpt-1', 0, 'plan-departed']] : []), ...own].map((x, i) => [`D-${i + 1}`, ...x]);
          assert.deepEqual(dv, expected, 'each divergence once, keyed (job, index), numbered on');
          assert.deepEqual(factsOfKind(r, 'finding-transition').map((x) => [x.id, x.to.state]), [[finding, 'ruled']], 'the disposition written once');
          const digests = () => factsOfKind(r, 'divergence-digest').map((x) => x.ids);
          assert.deepEqual(digests(), second ? [['D-1']] : [expected.map(([id]) => id)], 'one digest: the second checkpoint\'s divergences wait while D-1\'s is open');
          assert.deepEqual(r.journal.view.openIntents(), []);
          assert.equal(git(d.repo, 'worktree', 'list', '--porcelain').includes('ckpt-'), false, 'no checkpoint checkout left');
          assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
          assert.equal(digests().length, 1, 'settling again writes nothing');
        } finally {
          r.journal.close();
        }
      });
    }
  });
}

// The dev.14 arc's ckpt-14: a checkpoint whose call died twice. Its checkout path is the job's own (`<job>.checkpoint`),
// so the second attempt removed the first's checkout and made it again at the same path; that earlier removal must not
// hide the second checkout, or the third attempt finds the path taken (`already exists`) and every restart crashes.
test('checkpoint.checkout-reused-after-two-crashes: a checkpoint killed in its call twice is asked a third time on a checkout made afresh', T, async () => {
  const d = checkpointArc(visionLenses('audit-1'));
  const setup = contextFor(d);
  const { ctx: sctx } = checkpointContext(setup);
  await completedAudit(setup, sctx);
  appendSteps(d, [checkpointStep('ckpt-1', bundle([VALID_OP]))]);
  setup.journal.close();
  for (const n of [1, 2]) {
    const trigger = writeTrigger(tmpDir(`checkpoint-twice-${n}`), { label: 'spawn.after-intent', occurrence: 1 });
    const exit = await runFixture('checkpoint-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
    assert.equal(exit.signal, 'SIGKILL', `crash ${n} must fire: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
    assertFired(trigger);
    const between = contextFor(d);
    const { ctx, w } = checkpointContext(between);
    try {
      await recover({ stage: ctx, commands: w.commands });
    } finally {
      between.journal.close();
    }
  }
  const r = contextFor(d);
  const { ctx, w } = checkpointContext(r);
  try {
    await recover({ stage: ctx, commands: w.commands });
    const creates = r.journal.view.opsOf('worktree.create').filter((i) => i.expect.path.endsWith('ckpt-1.checkpoint'));
    assert.equal(creates.length, 2, 'two attempts made the checkout at the same path');
    const out = await runCheckpoint(ctx);
    assert.ok(out.kind === 'decided' && out.job === 'ckpt-1' && out.decision.kind === 'applied', JSON.stringify(out));
    assert.deepEqual(r.journal.view.openIntents(), []);
    assert.equal(git(d.repo, 'worktree', 'list', '--porcelain').includes('ckpt-'), false, 'no checkpoint checkout left');
  } finally {
    r.journal.close();
  }
});
