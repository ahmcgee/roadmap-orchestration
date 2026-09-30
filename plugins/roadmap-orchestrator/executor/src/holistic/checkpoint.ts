// The checkpoint job (M3 step B6; DESIGN-1.0.md §2.8; plan "Checkpoint and bundles", OR-V, OR-Q1, H2, H3): one durable
// job `ckpt-<n>` at a time, the one seat that steers the arc as a whole. It runs after every completed audit and for
// every operator-design park (OR-Q1), reads the arc with the vision first and in full, and decides one bundle, which
// src/holistic/bundle.ts activates all or nothing. It writes nothing itself.
//
// A run (`runCheckpoint`, one call per scheduler turn):
//   0. Settle what a crash may have cut short after the latest decision (`settleDecided`), and raise `respec-second`
//      for a design park on a lineage the checkpoint already respecified (OR-Q1: the second goes to the owner).
//   1. A running job (captured, undecided) resumes from its recorded inputs. Otherwise the first due trigger, parks
//      first (they hold units), then completed audits in order. A trigger is due while it has no job, or its latest job
//      was rejected (`stale` or `evidence`: re-evaluated whole; `invalid`: once, the second goes to the owner), or its
//      latest job's bundle request was acknowledged `apply` (the next job enacts that bundle: no call, the brakes and
//      draining skipped, staleness and the rest checked as ever). A due job is skipped, writing nothing, while the
//      checkpoint seat's backend is parked or the arc is paused or stopped.
//   2. Before the capture: for an audit's trigger, its cited P1s re-witnessed on the head (B5's `rewitnessP1s`, the
//      race of §2.5); after an evidence rejection, the lanes of the observations it cited re-witnessed on the head.
//   3. The capture (H2, A19), under the revision fence in one synchronous step: `checkpoint-inputs{job, trigger,
//      generation, vector, headSha, visionSha256, findings, observations}`. The vector is the plan rev, every unit's
//      spec rev, the obligations', ledger's and vision's bytes, and the blob of every plan contract and the
//      architecture doc at the head. The generation is the trigger audit's (a park's: the latest recorded, else 1).
//   4. The call: a fresh session on the checkpoint seat (`callArcRole`, `arc-backend{role: checkpoint}`, metered to the
//      job), `@cpu`×1 under the job, in a detached checkout `<job>.checkpoint` of the captured head, the prompt rendered
//      from the recorded inputs alone: the vision first and in full (by its kept bytes), the trigger and head, vision
//      coverage, the findings, the obligations with their observations on the head, the uncovered divergences, the plan
//      in force at the captured rev (units with state, edges, limits and routing, and one unit's spec in force as the
//      shape an `admit`'s spec takes), the contracts at the head, the rulings, the direction. A resumed job consumes a
//      call it made; a call interrupted (a pause, a stop, a backend park) leaves the job running and a later run asks
//      again as the next attempt. A refusal, malformed answer or fault is an invalid decision.
//   5. The activation (src/holistic/bundle.ts): `plan-applied{source: bundle{job}}` or `bundle-decided`.
//
// OR-Q1: `designParkRoute` tells the scheduler what a design park waits for: the checkpoint (its park item is held
// back), the owner (`respec-second`, raised here), or its own park item (the checkpoint decided nothing applicable).
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { Parent } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { canonicalJson } from '../core/json.ts';
import { type InvocationId, type JobId, type LaneId, type Sha, type UnitId, parseInvocationId } from '../core/ids.ts';
import { BACKEND_PARK_CLASSES } from '../core/events.ts';
import { DEFAULT_BOUNDS } from '../core/records.ts';
import type { CheckpointState } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { git, revParse } from '../git/git.ts';
import { OBLIGATIONS_INPUT, PLAN_INPUT, RULING_INPUT, RULINGS_INPUT, SPEC_INPUT, VISION_INPUT, inForceFiles, keptInput, keptPayload, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { DEFAULT_CONVERGENCE_K, type PlanM1, parsePlan } from '../input/plan.ts';
import { raiseNeedsUser, raisedFor, readNeedsUser } from '../needsuser.ts';
import {
  type BackendCallOutcome, type JobParent, arcSeat, callArcRole, minutesMs, recordedArcCall, runOp, verdictOf,
} from '../pipeline/dispatch.ts';
import { arcJourneyLane, laneEnvId, observations, observedViews, removeJobCheckouts, runJourneySeries } from '../pipeline/lanes.ts';
import { architecture, docAt, inMs, ledgerDir, ledgerPath } from '../pipeline/stages.ts';
import { promptFor } from '../prompts/index.ts';
import type { CheckpointInputs, FindingView } from '../prompts/inputs.ts';
import { type CheckpointOutput, validateCheckpointOutput } from '../prompts/schemas.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { parseRulings } from '../spec/rulings.ts';
import { parseSpec } from '../spec/spec.ts';
import { removeCheckout, rewitnessP1s, withCpu } from './audit.ts';
import { type Activation, type BundleDecision, type Captured, type CheckpointContext, activate, raiseOnce, settleDecided, vectorAt } from './bundle.ts';
import { integrationHeadNow } from './cadence.ts';
import type { AppliedBundle } from './convergence.ts';
import { uncoveredDivergences } from './divergence.ts';
import { isActive } from './findings.ts';
import { keyOf } from './observe.ts';
import { type CheckpointTrigger, type Obligations, type Vision, observationKeyText, parseObligations, parseRulingSidecar, parseVision } from './types.ts';
import { visionCoverage } from './vision.ts';

export type { CheckpointContext } from './bundle.ts';

export type CheckpointOutcome =
  /** Nothing is due. */
  | Readonly<{ kind: 'none' }>
  /** Due, but not asked: the checkpoint backend is parked, or the arc is paused or stopped. */
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' }>
  /** The call was interrupted (a pause, a stop, a backend park): the job stays running and resumes at a later call. */
  | Readonly<{ kind: 'interrupted'; job: JobId; detail: string }>
  | Readonly<{ kind: 'decided'; job: JobId; trigger: CheckpointTrigger; decision: BundleDecision }>;

const jobParent = (job: JobId): JobParent => ({ type: 'job', job });
const triggerKey = (t: CheckpointTrigger): string => canonicalJson(t);
const checkoutOf = (ctx: CheckpointContext, job: JobId, what: 'checkpoint' | 'rewitness'): AbsPath =>
  absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.${what}`));

// ---------------------------------------------------------------------------------------------------
// Consumed calls

/** Whether a recorded call was already read as an interruption (a pause, a stop, a backend park): a later run asks again. */
function interruptedCall(called: BackendCallOutcome): boolean {
  if (called.kind !== 'result') return false;
  const { outcome, backendErrors } = called.result;
  return outcome.kind === 'cancelled' || (outcome.kind !== 'success' && backendErrors.some((e) => (BACKEND_PARK_CLASSES as readonly string[]).includes(e.class)));
}

/** The previous job of the same trigger as `job`, or null. */
function previousOf(ctx: CheckpointContext, job: JobId): CheckpointState | null {
  const fold = ctx.journal.view.holistic();
  const mine = fold.checkpoints.find((c) => c.inputs.job === job);
  if (mine === undefined) throw new Error(`${job} is no checkpoint job`);
  return fold.checkpoints.filter((c) => triggerKey(c.inputs.trigger) === triggerKey(mine.inputs.trigger) && c.inputs.seq < mine.inputs.seq).at(-1) ?? null;
}

/** Whether `c` decided a bundle request its owner acknowledged `apply`: the next job of its trigger enacts it. */
function approved(ctx: CheckpointContext, c: CheckpointState | null): boolean {
  if (c?.decided?.kind !== 'requested') return false;
  const id = c.decided.needsUser as Parameters<typeof readNeedsUser>[1];
  return readNeedsUser(ctx.runDir, id)?.reason === 'bundle-request' && ctx.journal.view.ackOf(id)?.choice === 'apply';
}

/**
 * The output a decided or running job acts on, and the call that produced it: its own last successful call, or (an
 * enactment, which makes none) the requesting job's. Null while it has none.
 */
export function outputOf(ctx: CheckpointContext, job: JobId): Readonly<{ output: CheckpointOutput; inv: InvocationId }> | null {
  let found: Readonly<{ output: CheckpointOutput; inv: InvocationId }> | null = null;
  for (let attempt = 1; ; attempt++) {
    const called = recordedArcCall(ctx, job, 'checkpoint', attempt);
    if (called === null) break;
    if (called.kind !== 'result' || called.result.outcome.kind !== 'success') continue;
    try {
      found = { output: validateCheckpointOutput(called.result.outcome.value), inv: called.inv };
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
    }
  }
  if (found !== null) return found;
  const prev = previousOf(ctx, job);
  return approved(ctx, prev) ? outputOf(ctx, prev!.inputs.job) : null;
}

/** Every applied bundle so far, in log order: its job, its revision.commit's seq, its ops. */
function appliedBundles(ctx: CheckpointContext): readonly AppliedBundle[] {
  const view = ctx.journal.view;
  return view.opsOf('revision.commit').flatMap((commit) => {
    if (commit.expect.source.type !== 'bundle' || view.doneOf(commit.op) === null) return [];
    const job = commit.expect.source.job;
    const out = outputOf(ctx, job);
    if (out === null) throw new Error(`${job} applied a bundle, but its output is not recorded`);
    return [{ job, seq: Number(commit.op.slice(commit.op.lastIndexOf('/') + 1)), ops: out.output.ops }];
  });
}

// ---------------------------------------------------------------------------------------------------
// Triggers (OR-Q1: parks first)

/** A unit's lineage root (itself when it re-enters none). */
const rootOf = (ctx: CheckpointContext, unit: UnitId): UnitId => ctx.journal.view.unit(unit).lineage?.root ?? unit;

/** The operator-design parks of the plan in force: unit and park seq. */
function designParks(ctx: CheckpointContext): readonly Readonly<{ unit: UnitId; seq: number }>[] {
  const view = ctx.journal.view;
  return requirePlanInForce(ctx.runDir, view).plan.units.flatMap((u) => {
    const s = view.unit(u.id);
    const p = s.park;
    return s.status === 'park-pending' && p !== null && p.park.class === 'operator' && p.park.kind === 'design' ? [{ unit: u.id, seq: p.seq }] : [];
  });
}

/** The park checkpoints of `unit`'s lineage for another park than `seq` (OR-Q1: one respec per lineage). */
function earlierRespecs(ctx: CheckpointContext, unit: UnitId, seq: number): readonly CheckpointState[] {
  const root = rootOf(ctx, unit);
  return ctx.journal.view.holistic().checkpoints.filter((c) => c.inputs.trigger.type === 'park' && c.inputs.trigger.seq !== seq && rootOf(ctx, c.inputs.trigger.unit) === root);
}

export type DesignParkRoute =
  /** The checkpoint has it (due or running): the park's own item waits. */
  | Readonly<{ kind: 'checkpoint' }>
  /** A second design park on the lineage: `respec-second` goes to the owner instead of its item. */
  | Readonly<{ kind: 'respec-second' }>
  /** The checkpoint applied a revision for it (the scheduler re-opens the unit on its respecified spec). */
  | Readonly<{ kind: 'respecified'; planRev: number }>
  /** The checkpoint decided nothing that applies to it (a no-op, a request): its own park item is raised now. */
  | Readonly<{ kind: 'park-item' }>;

/** OR-Q1: what a unit's design park waits for; null when the unit is not design-parked or the arc is not holistic. */
export function designParkRoute(ctx: CheckpointContext, unit: UnitId): DesignParkRoute | null {
  const view = ctx.journal.view;
  if (!view.holistic().on) return null;
  const park = designParks(ctx).find((p) => p.unit === unit);
  if (park === undefined) return null;
  if (earlierRespecs(ctx, unit, park.seq).length > 0) return { kind: 'respec-second' };
  const key = triggerKey({ type: 'park', unit, seq: park.seq });
  const last = view.holistic().checkpoints.filter((c) => triggerKey(c.inputs.trigger) === key).at(-1);
  if (last === undefined || last.decided === null) return { kind: 'checkpoint' };
  switch (last.decided.kind) {
    case 'applied':
      return { kind: 'respecified', planRev: last.decided.planRev };
    case 'rejected':
      return { kind: 'checkpoint' };
    case 'requested':
      return approved(ctx, last) ? { kind: 'checkpoint' } : { kind: 'park-item' };
    case 'no-op':
      return { kind: 'park-item' };
  }
}

/** OR-Q1: a second design park on a lineage the checkpoint already respecified goes to the owner (raised once per park). */
function raiseRespecSecond(ctx: CheckpointContext): void {
  const view = ctx.journal.view;
  if (!view.holistic().on) return;
  for (const p of designParks(ctx)) {
    const earlier = earlierRespecs(ctx, p.unit, p.seq);
    if (earlier.length === 0) continue;
    const decided = view.unit(p.unit).decided;
    if (decided === null) throw new Error(`unit ${p.unit} is parked without its decided outcome`);
    const parent: Parent = { type: 'stage', unit: p.unit, stage: decided.stage, attempt: decided.attempt };
    if (raisedFor(view, parent) !== null) continue;
    raiseNeedsUser(ctx.journal, ctx.runDir, {
      blocking: true,
      subject: { type: 'unit', unit: p.unit },
      reason: 'respec-second',
      summary: `Unit ${p.unit} parked on a design question (${decided.stage} ${decided.outcome}) again, after the checkpoint already respecified its lineage (${earlier.map((c) => c.inputs.job).join(', ')}). OR-Q1: the second goes to the owner.`,
      recommendation: `Decide the unit's course: revise its spec and \`roadmap apply\` then \`roadmap resume ${p.unit}\`, re-enter it with a new unit, or cut it; then acknowledge this item.`,
      options: [],
      evidence: [],
    }, parent);
  }
}

type Due = Readonly<{ trigger: CheckpointTrigger; generation: number; prev: CheckpointState | null }>;

/** The latest generation any audit or checkpoint recorded (1 before any). */
function latestGeneration(ctx: CheckpointContext): number {
  const fold = ctx.journal.view.holistic();
  return Math.max(1, ...fold.audits.map((a) => a.started.generation), ...fold.checkpoints.map((c) => c.inputs.generation));
}

/** Whether a trigger whose latest job is `last` is due again (see the header). */
function dueAgain(ctx: CheckpointContext, last: CheckpointState | undefined): boolean {
  if (last === undefined) return true;
  const d = last.decided;
  if (d === null) throw new Error(`${last.inputs.job} is running; it resumes before any trigger is due`);
  if (d.kind === 'rejected') return true;
  return approved(ctx, last);
}

/** The first due trigger, parks first; null when none is. */
function dueTrigger(ctx: CheckpointContext): Due | null {
  const fold = ctx.journal.view.holistic();
  const latest = (t: CheckpointTrigger): CheckpointState | undefined => fold.checkpoints.filter((c) => triggerKey(c.inputs.trigger) === triggerKey(t)).at(-1);
  const parks = designParks(ctx).filter((p) => earlierRespecs(ctx, p.unit, p.seq).length === 0)
    .map((p) => ({ trigger: { type: 'park', unit: p.unit, seq: p.seq } as CheckpointTrigger, generation: latestGeneration(ctx) }));
  const audits = fold.audits.filter((a) => a.ended?.outcome === 'completed')
    .map((a) => ({ trigger: { type: 'audit', job: a.started.job } as CheckpointTrigger, generation: a.started.generation }));
  for (const t of [...parks, ...audits]) {
    const last = latest(t.trigger);
    if (dueAgain(ctx, last)) return { ...t, prev: last ?? null };
  }
  return null;
}

/** Why a due checkpoint does not start now, or null. */
export function checkpointSkip(ctx: CheckpointContext): 'backend-parked' | 'paused' | null {
  const view = ctx.journal.view;
  const control = view.control();
  if (control.stop !== null || control.pausedAll) return 'paused';
  return view.parkedBackends().includes(arcSeat(ctx, 'checkpoint').triple.backend) ? 'backend-parked' : null;
}

/** Whether a checkpoint is running or due now (the scheduler's question before it calls `runCheckpoint`). */
export function checkpointPending(ctx: CheckpointContext): boolean {
  const fold = ctx.journal.view.holistic();
  if (!fold.on) return false;
  return fold.checkpoints.some((c) => c.decided === null) || dueTrigger(ctx) !== null;
}

// ---------------------------------------------------------------------------------------------------
// The capture (H2)

/** `checkpoint-inputs` of `due`, captured synchronously under the revision fence. */
function capture(ctx: CheckpointContext, due: Due): Captured {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce, ctx.planFile);
  const files = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile);
  const head = integrationHeadNow(ctx);
  const vector = vectorAt(ctx, inForce, revision, files, head);
  const tree = revParse(ctx.repo, `${head}^{tree}`);
  const store = observations(ctx);
  const lanes = revision.obligations?.value.lanes ?? [];
  const shown = lanes.flatMap((l) => {
    const key = keyOf(tree, l, laneEnvId(ctx, l));
    return store.has(observationKeyText(key)) ? [key] : [];
  }).sort((a, b) => (observationKeyText(a) < observationKeyText(b) ? -1 : 1));
  const job = view.nextJobId('ckpt');
  const fact = {
    kind: 'checkpoint-inputs' as const, job, trigger: due.trigger, generation: due.generation, vector, headSha: head, visionSha256: vector.visionSha256,
    findings: view.holistic().findings.filter(isActive).map((f) => f.id).sort(),
    observations: shown,
  };
  const seq = ctx.journal.fact(fact);
  const { kind: _k, ...inputs } = fact;
  return { ...inputs, seq };
}

// ---------------------------------------------------------------------------------------------------
// The prompt, from the recorded inputs

type Recorded = Readonly<{ vision: Vision; obligations: Obligations | null; ledgerText: string; plan: PlanM1; planRev: number }>;

function kept(ctx: CheckpointContext, sha: Parameters<typeof keptInput>[1], ext: string): Buffer {
  const bytes = keptInput(ctx.runDir, sha, ext);
  if (bytes === null) throw new Error(`the checkpoint's inputs name ${ext} ${sha}, which is not kept`);
  return bytes;
}

/** The payload of plan rev `rev` (a holistic revision always has one). */
function payloadAt(ctx: CheckpointContext, rev: number) {
  const view = ctx.journal.view;
  const commit = view.opsOf('revision.commit').find((c) => c.expect.rev === rev && view.doneOf(c.op) !== null);
  if (commit === undefined) throw new Error(`plan rev ${rev} has no applied revision.commit`);
  return keptPayload(ctx.runDir, commit.expect.payloadSha256);
}

function recorded(ctx: CheckpointContext, s: Captured): Recorded {
  const payload = payloadAt(ctx, s.vector.plan);
  if (s.vector.ledgerSha256 === null) throw new Error(`${s.job}: a holistic revision keeps its ledger`);
  return {
    vision: parseVision(JSON.parse(kept(ctx, s.visionSha256, VISION_INPUT).toString('utf8'))),
    obligations: s.vector.obligationsSha256 === null ? null : parseObligations(JSON.parse(kept(ctx, s.vector.obligationsSha256, OBLIGATIONS_INPUT).toString('utf8'))),
    ledgerText: kept(ctx, s.vector.ledgerSha256, RULINGS_INPUT).toString('utf8'),
    plan: parsePlan(JSON.parse(kept(ctx, payload.manifest.planSha256, PLAN_INPUT).toString('utf8'))),
    planRev: s.vector.plan,
  };
}

/**
 * The plan in force at the captured rev, rendered: each unit with its state, edges, limits and routing layer, the arc's
 * limits, and one unit's spec in force as the shape an `admit`'s spec text takes (B4 carry-forward).
 */
function renderPlan(ctx: CheckpointContext, s: Captured, r: Recorded): string {
  const view = ctx.journal.view;
  const payload = payloadAt(ctx, r.planRev);
  const lines = r.plan.units.map((u) => {
    const st = view.unit(u.id);
    const parts = [
      `risk ${u.risk}`, `origin ${u.origin ?? 'planned'}`, `status ${st.status}${st.decided === null ? '' : ` (last ${st.decided.stage} ${st.decided.outcome})`}`,
      `spec rev ${s.vector.specs[u.id] ?? '?'}`, `scope ${u.scope.join(', ')}`,
      ...(u.after.length === 0 ? [] : [`after ${u.after.join(', ')}`]),
      ...(u.reenters === undefined ? [] : [`re-enters ${u.reenters.unit}`]),
      ...(u.cut === undefined ? [] : [`cut: ${u.cut.reason}`]),
      ...(u.limits === undefined ? [] : [`limits ${canonicalJson(u.limits)}`]),
      ...(u.routing === undefined ? [] : [`routing ${canonicalJson(u.routing)}`]),
    ];
    return `- ${u.id}: ${parts.join('; ')}`;
  });
  const example = r.plan.units[0];
  const exampleSha = example === undefined ? undefined : payload.manifest.specs[example.id];
  const shape = example === undefined || exampleSha === undefined
    ? 'No unit spec is in force to show as an example.'
    : `The spec in force of ${example.id}, the shape an admit's spec text takes (a new unit's spec is rev 1 and names its own unit id; a repair unit lists what it repairs in repairs):\n${JSON.stringify(parseSpec(kept(ctx, exampleSha, SPEC_INPUT), absPath(join(ctx.planFile, '..', example.spec))), null, 2)}`;
  return [
    `Plan rev ${r.planRev}. Units, in plan order:`,
    ...lines,
    `Arc limits: ${canonicalJson(r.plan.limits ?? {})} (convergenceK ${r.plan.limits?.convergenceK ?? DEFAULT_CONVERGENCE_K}).`,
    '',
    shape,
  ].join('\n');
}

function findingViews(ctx: CheckpointContext, ids: readonly Captured['findings'][number][]): readonly FindingView[] {
  const findings = ctx.journal.view.holistic().findings;
  return ids.map((id) => {
    const f = findings.find((x) => x.id === id);
    if (f === undefined) throw new Error(`the checkpoint names finding ${id}, which the fold does not have`);
    return { id: f.id, lens: f.lens, severity: f.severity, state: f.state, obligation: f.obligation, claim: f.claim, owner: f.owner };
  });
}

function checkpointInputs(ctx: CheckpointContext, s: Captured, r: Recorded): CheckpointInputs {
  const rulings = parseRulings(r.ledgerText, ledgerPath(ctx));
  const sidecars = Object.entries(payloadAt(ctx, r.planRev).manifest.rulings.sidecars)
    .map(([, sha]) => parseRulingSidecar(JSON.parse(kept(ctx, sha, RULING_INPUT).toString('utf8'))));
  return {
    vision: { rev: r.vision.rev, clauses: r.vision.clauses },
    trigger: s.trigger,
    head: s.headSha,
    plan: renderPlan(ctx, s, r),
    findings: findingViews(ctx, s.findings),
    obligations: r.obligations === null ? [] : observedViews(ctx, r.obligations, r.obligations.obligations, s.headSha),
    coverage: visionCoverage(r.vision, r.obligations, sidecars.map((x) => ({ id: x.id, cites: x.cites }))),
    divergences: uncoveredDivergences(ctx.journal.view).map((d) => ({ id: d.id, type: d.type, what: d.what })),
    contracts: r.plan.contracts.map((c) => docAt(ctx, s.headSha, c)),
    rulings: rulings.flatMap((x) => (x.status === 'active' ? [{ id: x.id, text: x.text }] : [])),
    index: { contracts: [], rulings: rulings.flatMap((x) => (x.status === 'withdrawn' ? [{ id: x.id, line: `withdrawn by ${x.by}` }] : [])), ledger: ledgerPath(ctx) },
    architecture: architecture(ctx, s.headSha),
    direction: r.plan.direction,
  };
}

// ---------------------------------------------------------------------------------------------------
// The call

type Asked =
  | Readonly<{ kind: 'output'; output: CheckpointOutput; inv: InvocationId }>
  | Readonly<{ kind: 'failed'; detail: string; inv: InvocationId }>
  | Readonly<{ kind: 'interrupted'; detail: string }>
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' }>;

/** Reads a call: an output, a failure (an invalid decision), or an interruption (its park or usage-limit item written). */
function read(ctx: CheckpointContext, job: JobId, called: BackendCallOutcome): Asked {
  const v = verdictOf(ctx, jobParent(job), called);
  switch (v.kind) {
    case 'success':
      try {
        return { kind: 'output', output: validateCheckpointOutput(v.value), inv: called.inv };
      } catch (error) {
        if (error instanceof SchemaError) return { kind: 'failed', detail: `malformed decision: ${error.message}`, inv: called.inv };
        throw error;
      }
    case 'interrupted': {
      if (v.needsUser !== null) {
        const parent: Parent = { type: 'op', op: parseInvocationId(called.inv).op };
        if (raisedFor(ctx.journal.view, parent) === null) raiseNeedsUser(ctx.journal, ctx.runDir, v.needsUser, parent);
      }
      return { kind: 'interrupted', detail: `interrupted: ${v.reason}` };
    }
    default:
      return { kind: 'failed', detail: `${v.kind}: ${v.detail}`, inv: called.inv };
  }
}

/** The job's call: one it made and consumes, or a new attempt (skipped while its backend is parked or the arc paused). */
async function ask(ctx: CheckpointContext, s: Captured): Promise<Asked> {
  for (let attempt = 1; ; attempt++) {
    const recordedCall = recordedArcCall(ctx, s.job, 'checkpoint', attempt);
    if (recordedCall !== null && interruptedCall(recordedCall)) continue;
    if (recordedCall !== null && recordedCall.kind === 'result') return read(ctx, s.job, recordedCall);
    const skip = checkpointSkip(ctx);
    if (skip !== null) return { kind: 'skipped', reason: skip };
    const r = recorded(ctx, s);
    const { triple } = arcSeat(ctx, 'checkpoint');
    const prompt = promptFor('checkpoint', triple.model);
    const checkout = checkoutOf(ctx, s.job, 'checkpoint');
    await removeJobCheckouts(ctx, s.job);
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${s.job}`, jobParent(s.job), { path: checkout, checkout: { type: 'detached', at: s.headSha } });
    const rendered = prompt.render(checkpointInputs(ctx, s, r));
    const called = await withCpu(ctx, s.job, () => callArcRole(ctx, {
      job: s.job, role: 'checkpoint', attempt, system: prompt.system, rendered, schema: prompt.schema, cwd: checkout, evidenceDirs: [ledgerDir(ctx)],
      deadlineAt: inMs(minutesMs(ctx.plan().limits?.judgmentDeadlineMin ?? DEFAULT_BOUNDS.judgmentDeadlineMin)),
    }));
    await removeCheckout(ctx, s.job, checkout);
    if (called.kind === 'lost') return { kind: 'failed', detail: `${called.inv} was lost with its runner`, inv: called.inv };
    return read(ctx, s.job, called);
  }
}

// ---------------------------------------------------------------------------------------------------
// Before a capture: re-witnessing

/** After an evidence rejection: the cited observations' lanes re-witnessed on the head (under the rejected job). */
async function rewitnessCited(ctx: CheckpointContext, prev: CheckpointState): Promise<void> {
  if (prev.decided?.kind !== 'rejected' || prev.decided.reason !== 'evidence') return;
  const out = outputOf(ctx, prev.inputs.job);
  if (out === null) throw new Error(`${prev.inputs.job} was rejected on its evidence, but its output is not recorded`);
  const revision = revisionInForce(ctx.runDir, requirePlanInForce(ctx.runDir, ctx.journal.view), ctx.planFile);
  const wanted = new Set<LaneId>(out.output.cites.observations.map((k) => k.lane));
  const lanes = (revision.obligations?.value.lanes ?? []).filter((l) => wanted.has(l.id));
  if (lanes.length === 0) return;
  const head: Sha = integrationHeadNow(ctx);
  await removeJobCheckouts(ctx, prev.inputs.job);
  await runJourneySeries(ctx, { type: 'job', job: prev.inputs.job, acquireFirst: ctx.acquireFirst }, lanes.map(arcJourneyLane), {
    path: checkoutOf(ctx, prev.inputs.job, 'rewitness'), checkout: { type: 'detached', at: head },
  }, { reuse: true, stop: () => false });
}

// ---------------------------------------------------------------------------------------------------
// The job

/** A trigger's second decision that is no bundle at all (a refusal, a malformed answer, a fault) goes to the owner. */
function failedTwice(ctx: CheckpointContext, job: JobId, detail: string) {
  return raiseOnce(ctx, job, {
    blocking: false,
    subject: { type: 'arc' },
    reason: 'bundle-request',
    summary: `Checkpoint ${job} gave no valid decision a second time for its trigger (${detail}). Units keep running; the trigger waits for the owner.`,
    recommendation: 'Read the checkpoint calls\' evidence; make any change the arc needs with `roadmap apply`, then acknowledge this item.',
    options: [],
    evidence: [],
  });
}

/** The latest decided checkpoint, settled again where a crash cut its aftermath short. */
function settleLatest(ctx: CheckpointContext): void {
  const last = ctx.journal.view.holistic().checkpoints.filter((c) => c.decided !== null).at(-1);
  if (last === undefined || (last.decided!.kind !== 'applied' && last.decided!.kind !== 'no-op')) return;
  const out = outputOf(ctx, last.inputs.job);
  if (out === null) throw new Error(`${last.inputs.job} decided with no recorded output`);
  const prev = previousOf(ctx, last.inputs.job);
  const captured = approved(ctx, prev) ? prev!.inputs : last.inputs;
  settleDecided(ctx, last.inputs.job, out.output, captured, appliedBundles(ctx));
}

/**
 * Runs (or resumes) the checkpoint due now: see the header. `none` when nothing is due; `skipped` (writing nothing) while
 * its backend is parked or the arc paused; `interrupted` when its call was.
 */
export async function runCheckpoint(ctx: CheckpointContext): Promise<CheckpointOutcome> {
  const fold = ctx.journal.view.holistic();
  if (!fold.on) return { kind: 'none' };
  settleLatest(ctx);
  raiseRespecSecond(ctx);

  let s: Captured | null = fold.checkpoints.find((c) => c.decided === null)?.inputs ?? null;
  if (s === null) {
    const due = dueTrigger(ctx);
    if (due === null) return { kind: 'none' };
    if (!approved(ctx, due.prev)) {
      const skip = checkpointSkip(ctx);
      if (skip !== null) return { kind: 'skipped', reason: skip };
    }
    if (due.trigger.type === 'audit') await rewitnessP1s(ctx, due.trigger.job);
    if (due.prev !== null) await rewitnessCited(ctx, due.prev);
    s = await captureUnderFence(ctx.journal, () => capture(ctx, due));
    crashPoint('checkpoint.after-inputs');
  }
  const { job } = s;
  await removeJobCheckouts(ctx, job);

  const prev = previousOf(ctx, job);
  const enact = approved(ctx, prev);
  let asked: Asked;
  if (enact) {
    const out = outputOf(ctx, prev!.inputs.job);
    if (out === null) throw new Error(`${job} enacts ${prev!.inputs.job}'s bundle, whose output is not recorded`);
    asked = { kind: 'output', ...out };
  } else {
    asked = await ask(ctx, s);
  }
  if (asked.kind === 'skipped') return asked;
  if (asked.kind === 'interrupted') return { kind: 'interrupted', job, detail: asked.detail };
  crashPoint('checkpoint.after-call');

  const { trigger } = s;
  const secondInvalid = ctx.journal.view.holistic().checkpoints.some((c) => triggerKey(c.inputs.trigger) === triggerKey(trigger) && c.decided?.kind === 'rejected' && c.decided.reason === 'invalid');
  if (asked.kind === 'failed') {
    const decision: BundleDecision = secondInvalid
      ? { kind: 'requested', needsUser: failedTwice(ctx, job, asked.detail), reason: 'bundle-request' }
      : { kind: 'rejected', reason: 'invalid', detail: asked.detail };
    ctx.journal.fact({ kind: 'bundle-decided', job, outcome: decision.kind === 'requested' ? { kind: 'requested', needsUser: decision.needsUser } : decision });
    return { kind: 'decided', job, trigger, decision };
  }
  const a: Activation = {
    job, captured: enact ? prev!.inputs : s, output: asked.output, inv: asked.inv, enact, secondInvalid, applied: appliedBundles(ctx),
  };
  const decision = await activate(ctx, a);
  return { kind: 'decided', job, trigger, decision };
}
