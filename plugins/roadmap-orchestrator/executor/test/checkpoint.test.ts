// M3 step B6: the checkpoint job and its bundles (src/holistic/{checkpoint,bundle,convergence,divergence}.ts), over real
// arcs: real git, real processes, the fake claude answering lens and checkpoint calls keyed by job, fake witness lanes.
// Named tests: bundle.stale, bundle.partial (with the retry's prior_attempt), bundle.vision-always-read (H3), bundle.partial (A18's literal partial bundle), bundle.no-op,
// noop.interpretation-divergence (H12), bundle.evidence-drop, bundle.draining-request, bundle.nested-owner-only (H10),
// bundle.withdrawn-cite-invalid (H16), bundle.rule-race-stale, bundle.ruling-id-collision-invalid, bundle.admit-widens-obligations, bundle.weakening-applies-with-divergence (OR-V), convergence.bound-k,
// convergence.bound-identity, bundle.compensating, digest.binds-ids (H11), divergence.preimage-no-inverse (H13),
// ckpt.design-park-respec-first (OR-Q1), ckpt.park-cause, bundle.p1-left-to-repair, and the crash cells of the matrix rows CHECKPOINT_JOB and BUNDLE_ACTIVATE.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type DivergenceId, type NeedsUserId, commandId, unitId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { designParkRoute, runCheckpoint } from '../src/holistic/checkpoint.ts';
import { quiescentGenerations } from '../src/holistic/convergence.ts';
import { raiseDigest, uncoveredDivergences } from '../src/holistic/divergence.ts';
import { findingKey } from '../src/holistic/types.ts';
import { keptPayload, requirePlanInForce } from '../src/input/inforce.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { syncRepairs } from '../src/pipeline/reproduce.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { VALID_OP, checkpointAnswer, checkpointStep, interpretationOnlyNoop, lensStep, twoOpBundleSecondInvalid } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { BUNDLE_ACTIVATE, CHECKPOINT_JOB, crashCells } from './matrix.ts';
import {
  type Wired, admitOp, applyPlanEdit, applyVision, checkpointArc, checkpointContext, completedAudit, factsOfKind, limitsOp, visionLenses,
} from './fixtures/checkpoint-common.ts';
import { auditArc, mapped } from './fixtures/audit-common.ts';
import { ruleRecord, submitRule } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep, serialRuntime } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, codexStep, contextFor, gateStep, mulBuild, stepUntil } from './fixtures/unit-common.ts';
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
    const d = checkpointArc([...visionLenses('audit-1'), checkpointStep('ckpt-1', twoOpBundleSecondInvalid()), checkpointStep('ckpt-2', twoOpBundleSecondInvalid())]);
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
      assert.ok(stdin('ckpt-2').includes(`<prior_attempt>\nThe previous checkpoint on this trigger, ckpt-1, decided a bundle the executor rejected as invalid, for these reasons: ${first.decision.detail}\n`), stdin('ckpt-2'));
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
const requirePlan = (r: ArcRun) => JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${r.journal.view.planApplied()!.planSha256}.plan.json`), 'utf8')) as { units: { id: string; origin?: string }[] };

describe('the activation checks', () => {
  test('bundle.evidence-drop: a cited observation with none on the head that moved rejects the bundle on its evidence; its lane is re-witnessed on the head before the re-evaluation, which applies', T, async () => {
    const d = checkpointArc(visionLenses('audit-1'));
    const r = contextFor(d);
    const { ctx, w } = checkpointContext(r);
    try {
      await completedAudit(r, ctx);
      const seen = factsOfKind(r, 'witnessed').at(-1)!;
      const key = { treeSha: seen.treeSha, lane: seen.lane, laneRev: seen.laneRev, envId: seen.envId };
      appendSteps(d, [checkpointStep('ckpt-1', bundle([VALID_OP], { observations: [key] }), [barrier]), checkpointStep('ckpt-2', bundle([VALID_OP]))]);
      const running = runCheckpoint(ctx);
      await reached(d.scenarioDir, 'ckpt', 120_000);
      const ruled = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2')));
      assert.equal(ruled.kind, 'applied', JSON.stringify(ruled));
      const head = git(d.repo, 'rev-parse', 'main');
      assert.notEqual(git(d.repo, 'rev-parse', `${head}^{tree}`), seen.treeSha, 'a docs-only publication moved the head to a tree no lane ran on');
      release(d.scenarioDir, 'ckpt');
      const first = await running;
      assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'evidence', JSON.stringify(first));
      assert.match(first.decision.detail, /has none on the head/);
      assert.equal(planLimits(r), null);
      const second = await runCheckpoint(ctx);
      assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
      const rewitnessed = factsOfKind(r, 'witnessed').find((f) => f.for.type === 'job' && f.for.job === 'ckpt-1');
      assert.equal(rewitnessed?.treeSha, git(d.repo, 'rev-parse', `${head}^{tree}`), 'the cited lane re-witnessed on the head under the rejected job');
      assert.deepEqual(factsOfKind(r, 'checkpoint-inputs')[1]!.observations.map((k) => k.treeSha), [rewitnessed!.treeSha], 'the re-evaluation read it');
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
      appendSteps(d, [checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [ruleOp('C-2'), ruleOp('C-3')], rulings: [checkpointRuling('C-2'), checkpointRuling('C-3')] }))]);
      const rev = r.journal.view.planApplied()!.rev;
      const out = await runCheckpoint(ctx);
      assert.ok(out.kind === 'decided' && out.decision.kind === 'rejected' && out.decision.reason === 'invalid', JSON.stringify(out));
      assert.equal(out.decision.detail, 'C-2 is already in the ledger (a ruling is never edited: supersede it)', 'C-3, checked against the ledger without the invalid C-2, is valid');
      assert.equal(r.journal.view.planApplied()!.rev, rev, 'nothing applied');
    } finally {
      r.journal.close();
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
      appendSteps(d, [checkpointStep('ckpt-1', bundle([{ op: 'limits', unit: null, limits: [{ field: 'retries', value: 2 }], cites: ['V-3'], evidence: ['e'] }]))]);
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
});

describe('convergence', () => {
  test('convergence.bound-k: at K applied bundles one non-blocking convergence-bound is raised; while open the next bundle is a request; acknowledged, bundles apply again', T, async () => {
    const d = checkpointArc([
      ...visionLenses('audit-1', 'audit-2', 'audit-3'),
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
      ...visionLenses('audit-1', 'audit-2'),
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
      ...visionLenses('audit-1', 'audit-2'), checkpointStep('ckpt-1', bundle([limitsOp('retries', 2)])), checkpointStep('ckpt-2', bundle([limitsOp('redirects', 3)])),
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
        checkpointStep('ckpt-1', accepting), checkpointStep('ckpt-2', bundle([repair])),
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
