// The pack review (M4a, OR-Q16, R16, R25, R28, H9, K8, K13, K14; DESIGN §3 Phase 0): an executor judgment job
// `review-<n>` on the `packReview` seat `arc` (frontier), in corpus arcs only, before the arc's first admission. It reads
// the pack read-only (the vision, the plan, every spec, the obligations with their census, the pinned rules index and
// the Phase-0 record) and reports findings, each identified by `(job, index)`.
//
// - **Required-review key** (`packReviewKey`, R28): the canonical `PackReviewInputs` without `job`. The inputs bind the
//   plan in force (rev and bytes), every unit's spec in force, the obligations, the pin, the Phase-0 record, the vision,
//   the integration head and the routing rev; so any `apply` before the first admission changes the key (H9).
// - **Due** (`packReviewStatus`): before the first admission (no unit has started a stage), while no review is running
//   and the current key differs from the key of every started review. The scheduler runs it before the baseline job.
// - **The job** (`runPackReview`, PACK_REVIEW_JOB): the inputs kept as `inputs/<sha>.pack-review.json` under the revision
//   fence, then `pack-review-started{inputsSha256, key}`, then the call (a fresh session, cwd a detached checkout of the
//   inputs' head, `@cpu`×1 under the job), rendered from the kept inputs alone: a resumed job and recovery consume only
//   that record's bytes (K8), never the live files. A recorded call is consumed, never asked again; an interrupted one
//   (a pause, a stop, a backend park) leaves the job running. Then `pack-review-ended{completed, findings}` and, when a
//   finding is blocking, one blocking `pack-review` item for the job (raised once: `settlePackReviews` finishes it
//   after a crash). A call that gives no valid report (a refusal, a malformed answer, a fault, lost twice: a call recovery
//   closed lost is asked again once) ends the job
//   `abandoned` with one blocking `pack-review` item saying so: the architect fixes the pack (a new key, so a new
//   review) or acknowledges it.
// - **Hold** (K14, H9, R25), a pure function of the started and ended facts, the items and the current key: before the
//   first admission, admission is held while a review is running or due, or while the latest ended review with the
//   current key has an open item (src/needsuser.ts `supersededPackItems`: a later review's end supersedes every earlier
//   review's item, which then holds nothing). An `apply` that fixes the pack makes a new key and so a superseding review; an ack
//   releases. From the first admission on, no review runs and no key is required.
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { captureUnderFence } from '../core/fence.ts';
import { type JobId, type NeedsUserId, type Sha256Hex, parseInvocationId, sha256 } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { Parent } from '../core/events.ts';
import { DEFAULT_BOUNDS, type NeedsUserContent } from '../core/records.ts';
import type { PackReviewState } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { parseCorpusPin } from '../corpus/types.ts';
import {
  CORPUS_INPUT, OBLIGATIONS_INPUT, PACK_REVIEW_INPUT, PHASE0_INPUT, PLAN_INPUT, SPEC_INPUT, VISION_INPUT, inputPath, keepInput, keptInput, requirePlanInForce,
  revisionInForce, specShaInForce,
} from '../input/inforce.ts';
import { advancesOf, parsePlan } from '../input/plan.ts';
import { raiseNeedsUser, raisedFor, supersededPackItems } from '../needsuser.ts';
import { type BackendCallOutcome, type JobParent, arcSeat, callArcRole, minutesMs, recordedArcCall, runOp, verdictOf } from '../pipeline/dispatch.ts';
import { removeJobCheckouts } from '../pipeline/lanes.ts';
import { inMs } from '../pipeline/stages.ts';
import { parsePhase0Record } from '../phase0/types.ts';
import { promptFor } from '../prompts/index.ts';
import { type PackReviewPromptInputs, visionInputOf } from '../prompts/inputs.ts';
import { type PackReviewOutput, validatePackReviewOutput } from '../prompts/schemas.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { renderSpec } from '../spec/render.ts';
import { parseSpec } from '../spec/spec.ts';
import { removeCheckout, withCpu } from './audit.ts';
import { interruptedCall } from './checkpoint.ts';
import type { CheckpointContext } from './bundle.ts';
import { integrationHeadNow } from './cadence.ts';
import { PACK_REVIEW_INPUTS_SCHEMA, type PackFinding, type PackReviewInputs, parseObligations, parsePackReviewInputs, parseVision } from './types.ts';

/**
 * The required-review key (H9, R28): sha256 of the canonical inputs without `job`, which is the review's identity, not
 * an input (with it no completed review could match the next key). Pure; the only place the key is computed.
 */
export function packReviewKey(inputs: PackReviewInputs): Sha256Hex {
  const { job: _job, ...bound } = inputs;
  return sha256(sha256Hex(canonicalJson(bound)));
}

const jobParent = (job: JobId): JobParent => ({ type: 'job', job });

/** Whether the arc is past its first admission: some unit has started a stage (its stage-parented intents count attempts). */
export function admitted(view: JournalView): boolean {
  return view.plannedUnits().some((u) => view.unit(u).counters.attempts > 0);
}

/** The inputs a review would bind now, as `job`; null outside a corpus arc. */
export function requiredInputs(ctx: CheckpointContext, job: JobId): PackReviewInputs | null {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  if (inForce.plan.target !== 'corpus') return null;
  const revision = revisionInForce(ctx.runDir, inForce);
  const { obligations, vision, corpus } = revision;
  if (obligations === null || vision === null || corpus === null) throw new Error(`a corpus arc's revision in force (rev ${inForce.rev}) keeps no obligations, vision or corpus`);
  return {
    schema: PACK_REVIEW_INPUTS_SCHEMA, job, planRev: inForce.rev, planSha256: inForce.manifest.planSha256,
    specs: [...inForce.plan.units].sort((a, b) => (a.id < b.id ? -1 : 1)).map((u) => ({ unit: u.id, sha256: specShaInForce(view, u.id) })),
    obligationsSha256: obligations.sha256, corpusPinSha256: corpus.pin.sha256, phase0Sha256: corpus.phase0.sha256, visionSha256: vision.sha256,
    head: integrationHeadNow(ctx), routingRev: arcSeat(ctx, 'packReview').routingRev,
  };
}

/** The pack review's current key, or null outside a corpus arc. */
function currentKey(ctx: CheckpointContext): Sha256Hex | null {
  const inputs = requiredInputs(ctx, ctx.journal.view.nextJobId('review'));
  return inputs === null ? null : packReviewKey(inputs);
}

/** The blocking `pack-review` item a review job raised, or null. */
export const packItemOf = (view: JournalView, job: JobId): NeedsUserId | null => raisedFor(view, jobParent(job));

/** What the pack review asks of the arc now. */
export type PackReviewStatus =
  /** Not a corpus arc, or past the first admission: no review runs and nothing is held. */
  | Readonly<{ kind: 'none' }>
  /** A review is running (started, not ended): it resumes. */
  | Readonly<{ kind: 'running'; job: JobId }>
  /** The current key differs from every started review's: a review is due. */
  | Readonly<{ kind: 'due' }>
  /** The latest ended review with the current key has an open item (or one a crash left unraised). */
  | Readonly<{ kind: 'held'; job: JobId; needsUser: NeedsUserId | null }>
  /** A review with the current key ended and nothing of it is open. */
  | Readonly<{ kind: 'clear'; job: JobId }>;

/** Whether an ended review calls for its blocking item: a blocking finding, or no valid report at all. */
const needsItem = (r: PackReviewState): boolean => r.ended !== null && (r.ended.outcome === 'abandoned' || r.ended.findings.some((f) => f.severity === 'blocking'));

export function packReviewStatus(ctx: CheckpointContext): PackReviewStatus {
  const view = ctx.journal.view;
  if (ctx.plan().target !== 'corpus' || admitted(view)) return { kind: 'none' };
  const reviews = view.holistic().packReviews;
  const running = reviews.find((r) => r.ended === null);
  if (running !== undefined) return { kind: 'running', job: running.started.job };
  const key = currentKey(ctx);
  if (key === null) return { kind: 'none' };
  const matching = reviews.filter((r) => r.started.key === key).at(-1);
  if (matching === undefined) return { kind: 'due' };
  const { job } = matching.started;
  if (!needsItem(matching)) return { kind: 'clear', job };
  const item = packItemOf(view, job);
  if (item === null) return { kind: 'held', job, needsUser: null };
  const open = view.ackOf(item) === null && !supersededPackItems(view).has(item);
  return open ? { kind: 'held', job, needsUser: item } : { kind: 'clear', job };
}

/** Whether the pack review holds every admission now: running, due or held (K14, H9). */
export function packReviewHolds(ctx: CheckpointContext): boolean {
  const s = packReviewStatus(ctx).kind;
  return s === 'running' || s === 'due' || s === 'held';
}

/** Whether the pack review job has work: a review running or due (an item a crash left unraised is `settlePackReviews`'). */
export function packReviewPending(ctx: CheckpointContext): boolean {
  const s = packReviewStatus(ctx).kind;
  return s === 'running' || s === 'due';
}

// ---------------------------------------------------------------------------------------------------
// The job

export type PackReviewOutcome =
  | Readonly<{ kind: 'none' }>
  /** Due, but not asked: the seat's backend is parked, or the arc is paused or stopped. */
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' }>
  /** The call was interrupted (a pause, a stop, a backend park): the job stays running. */
  | Readonly<{ kind: 'interrupted'; job: JobId; detail: string }>
  | Readonly<{ kind: 'ended'; job: JobId; outcome: 'completed' | 'abandoned'; needsUser: NeedsUserId | null }>;

/** Why a due review does not start now, or null. */
function skip(ctx: CheckpointContext): 'backend-parked' | 'paused' | null {
  const view = ctx.journal.view;
  const control = view.control();
  if (control.stop !== null || control.pausedAll) return 'paused';
  return view.parkedBackends().includes(arcSeat(ctx, 'packReview').triple.backend) ? 'backend-parked' : null;
}

function kept(ctx: CheckpointContext, sha: Sha256Hex, ext: string): Buffer {
  const bytes = keptInput(ctx.runDir, sha, ext);
  if (bytes === null) throw new Error(`a pack review names ${ext} ${sha}, but ${inputPath(ctx.runDir, sha, ext)} is not kept`);
  return bytes;
}
const json = (bytes: Buffer): unknown => JSON.parse(bytes.toString('utf8'));

/** The kept inputs of a started review (K8): recovery and a resumed call read only these bytes. */
export function keptPackInputs(ctx: CheckpointContext, r: PackReviewState): PackReviewInputs {
  const inputs = parsePackReviewInputs(json(kept(ctx, r.started.inputsSha256, PACK_REVIEW_INPUT)));
  if (inputs.job !== r.started.job || packReviewKey(inputs) !== r.started.key) throw new Error(`${r.started.job}: its kept inputs do not match its pack-review-started fact`);
  return inputs;
}

/** The prompt's inputs, rendered from the kept inputs alone. */
function promptInputs(ctx: CheckpointContext, inputs: PackReviewInputs): PackReviewPromptInputs {
  const plan = parsePlan(json(kept(ctx, inputs.planSha256, PLAN_INPUT)));
  const shaOf = new Map(inputs.specs.map((s) => [s.unit as string, s.sha256]));
  return {
    vision: visionInputOf(parseVision(json(kept(ctx, inputs.visionSha256, VISION_INPUT))), advancesOf(plan)),
    plan: `Plan rev ${inputs.planRev} (the plan file in force):\n${JSON.stringify(plan, null, 2)}`,
    specs: plan.units.map((u) => {
      const sha = shaOf.get(u.id);
      if (sha === undefined) throw new Error(`${inputs.job}: unit ${u.id} is planned but its inputs name no spec`);
      const spec = parseSpec(kept(ctx, sha, SPEC_INPUT), absPath(join(ctx.planFile, '..', u.spec)));
      return { unit: u.id, rev: spec.rev, markdown: renderSpec(spec) };
    }),
    obligations: parseObligations(json(kept(ctx, inputs.obligationsSha256, OBLIGATIONS_INPUT))),
    rulesIndex: parseCorpusPin(json(kept(ctx, inputs.corpusPinSha256, CORPUS_INPUT))).rules,
    phase0: parsePhase0Record(json(kept(ctx, inputs.phase0Sha256, PHASE0_INPUT))),
  };
}

type Asked =
  | Readonly<{ kind: 'output'; output: PackReviewOutput }>
  | Readonly<{ kind: 'failed'; detail: string }>
  | Readonly<{ kind: 'interrupted'; detail: string }>
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' }>;

/** Reads a call: an output, a failure (no valid report), or an interruption (its park or usage-limit item written). */
function read(ctx: CheckpointContext, job: JobId, called: BackendCallOutcome): Asked {
  if (called.kind === 'lost') return { kind: 'failed', detail: `${called.inv} was lost with its runner` };
  const v = verdictOf(ctx, jobParent(job), called);
  switch (v.kind) {
    case 'success':
      try {
        return { kind: 'output', output: validatePackReviewOutput(v.value) };
      } catch (error) {
        if (error instanceof SchemaError) return { kind: 'failed', detail: `malformed report: ${error.message}` };
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
      return { kind: 'failed', detail: `${v.kind}: ${v.detail}` };
  }
}

/** The job's call: one it made and consumes, or a new attempt from the kept inputs (cwd: a checkout of their head). */
async function ask(ctx: CheckpointContext, inputs: PackReviewInputs): Promise<Asked> {
  const { job } = inputs;
  for (let attempt = 1; ; attempt++) {
    const recorded = recordedArcCall(ctx, job, 'packReview', attempt);
    if (recorded !== null && interruptedCall(recorded)) continue;
    // A call recovery closed lost (its runner died with the executor) is asked again, as a checkpoint's is; a second loss fails.
    if (recorded !== null && recorded.kind === 'result') return read(ctx, job, recorded);
    const why = skip(ctx);
    if (why !== null) return { kind: 'skipped', reason: why };
    const { triple } = arcSeat(ctx, 'packReview');
    const prompt = promptFor('packReview', triple.model);
    const checkout: AbsPath = absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.review`));
    await removeJobCheckouts(ctx, job);
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${job}`, jobParent(job), { path: checkout, checkout: { type: 'detached', at: inputs.head } });
    const rendered = prompt.render(promptInputs(ctx, inputs));
    const called = await withCpu(ctx, job, () => callArcRole(ctx, {
      job, role: 'packReview', attempt, system: prompt.system, rendered, schema: prompt.schema, cwd: checkout, evidenceDirs: [],
      deadlineAt: inMs(minutesMs(ctx.plan().limits?.judgmentDeadlineMin ?? DEFAULT_BOUNDS.judgmentDeadlineMin)),
    }));
    await removeCheckout(ctx, job, checkout);
    return read(ctx, job, called);
  }
}

/** The blocking `pack-review` item of an ended review that calls for one (`needsItem`); `detail`: why no report was valid. */
function itemContent(r: PackReviewState, detail: string | null): NeedsUserContent {
  const { job } = r.started;
  const ended = r.ended!;
  const blocking = ended.findings.filter((f) => f.severity === 'blocking');
  const target = (f: PackFinding): string => (f.target.type === 'plan' ? 'the plan' : f.target.type === 'census' ? `census ${f.target.rule}` : `${f.target.type} ${f.target.id}`);
  return {
    blocking: true,
    subject: { type: 'arc' },
    reason: 'pack-review',
    summary: ended.outcome === 'abandoned'
      ? `The pack review ${job} gave no valid report${detail === null ? '' : ` (${detail})`}. No unit is admitted until the pack is reviewed or this item is acknowledged.`
      : `The pack review ${job} reports ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}: ${blocking.map((f) => `#${f.index} (${target(f)}): ${f.claim}`).join('; ')}. No unit is admitted until the pack is fixed or this item is acknowledged.`,
    recommendation: 'Adjudicate each finding: fix the pack with `roadmap apply` (a new pack, so a new review supersedes this one), or acknowledge this item to admit units on the pack as it is.',
    options: [],
    evidence: [],
  };
}

/**
 * Raises the item of every ended review that calls for one and has none (once per job: a crash between the end and the
 * raise loses only `detail`, which the job that just ended passes for itself).
 */
export function settlePackReviews(ctx: CheckpointContext, detail: Readonly<{ job: JobId; text: string }> | null = null): void {
  const view = ctx.journal.view;
  for (const r of view.holistic().packReviews) {
    if (!needsItem(r) || packItemOf(view, r.started.job) !== null) continue;
    raiseNeedsUser(ctx.journal, ctx.runDir, itemContent(r, detail?.job === r.started.job ? detail.text : null), jobParent(r.started.job));
  }
}

/** Runs (or resumes) the pack review now due: see the header. `none` when nothing is due. */
export async function runPackReview(ctx: CheckpointContext): Promise<PackReviewOutcome> {
  settlePackReviews(ctx);
  const status = packReviewStatus(ctx);
  let r: PackReviewState;
  if (status.kind === 'running') {
    r = ctx.journal.view.holistic().packReviews.find((x) => x.started.job === status.job)!;
  } else if (status.kind === 'due') {
    const why = skip(ctx);
    if (why !== null) return { kind: 'skipped', reason: why };
    r = await captureUnderFence(ctx.journal, () => {
      const view = ctx.journal.view;
      const inputs = requiredInputs(ctx, view.nextJobId('review'));
      if (inputs === null) throw new Error('a pack review is due outside a corpus arc');
      const inputsSha256 = keepInput(ctx.runDir, Buffer.from(canonicalJson(inputs), 'utf8'), PACK_REVIEW_INPUT);
      crashPoint('packreview.after-inputs');
      ctx.journal.fact({ kind: 'pack-review-started', job: inputs.job, planRev: inputs.planRev, inputsSha256, key: packReviewKey(inputs) });
      return ctx.journal.view.holistic().packReviews.at(-1)!;
    });
    crashPoint('packreview.after-started');
  } else {
    return { kind: 'none' };
  }
  const inputs = keptPackInputs(ctx, r);
  const { job } = inputs;
  await removeJobCheckouts(ctx, job);
  const asked = await ask(ctx, inputs);
  if (asked.kind === 'skipped') return asked;
  if (asked.kind === 'interrupted') return { kind: 'interrupted', job, detail: asked.detail };
  crashPoint('packreview.after-call');
  const findings: readonly PackFinding[] = asked.kind === 'output' ? asked.output.findings.map((f, index) => ({ index, ...f })) : [];
  const outcome = asked.kind === 'output' ? 'completed' : 'abandoned';
  ctx.journal.fact({ kind: 'pack-review-ended', job, outcome, findings });
  crashPoint('packreview.after-ended');
  settlePackReviews(ctx, asked.kind === 'failed' ? { job, text: asked.detail } : null);
  return { kind: 'ended', job, outcome, needsUser: packItemOf(ctx.journal.view, job) };
}
