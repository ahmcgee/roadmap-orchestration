// The checkpoint job (M3 step B6; DESIGN-1.0.md §2.8; plan "Checkpoint and bundles", OR-V, OR-Q1, H2, H3): one durable
// job `ckpt-<n>` at a time, the one seat that steers the arc as a whole. It runs after every completed audit and for
// every operator-design park (OR-Q1), reads the arc with the vision first and in full, and decides one bundle, which
// src/holistic/bundle.ts activates all or nothing. It writes nothing itself.
//
// A run (`runCheckpoint`, one call per scheduler turn):
//   0. Settle what a crash may have cut short after the latest decision (`settleLatest`, which the scheduler also runs
//      once at its start: a crash right after a decision leaves no checkpoint due), and raise `respec-second` for a
//      design park on a lineage the checkpoint already respecified (OR-Q1: the second goes to the owner).
//   1. A running job (captured, undecided) resumes from its recorded inputs. Otherwise the first due trigger, parks
//      first (they hold units), then completed audits in order. A trigger is due while it has no job, or its latest job
//      was rejected (`stale` or `evidence`: re-evaluated whole; `busy` (M4a rev 3, C5): once every open attempt it named
//      has closed, so no paid call is made while a unit it changes is mid-stage; `invalid`: once, the second goes to the
//      owner; whatever the reason, the next job's prompt carries every rejected job of its trigger with its reason and
//      detail verbatim, `priorRejected`), or its
//      latest job's bundle request was acknowledged `apply` (the next job enacts that bundle: no call, the brakes and
//      draining skipped, staleness and the rest checked as ever); a request answered otherwise ends the trigger's decision
//      (its generation quiescent, `quiescentGenerations`). A due job is skipped, writing nothing, while the
//      checkpoint seat's backend is parked or the arc is paused or stopped.
//   1b. Paid M4a runs 10 and 11 (R-15, R-20): a due job that would make a call does not capture while a plan-check may
//      patch a spec or a publication would move the head under it (`publishing`: a unit at plan-check or gate, approved
//      and not yet at its candidate, at candidate or ff, or the integration slot held by any publication, a docs or batch
//      one included); it is skipped, writing nothing, and asked
//      again at the boundary, so its capture is not stale on arrival. The wait is bounded: once the trigger has waited
//      CAPTURE_WAIT_MAX_MIN (by the scheduler's clock, from its audit's end, its park, or its previous job's capture),
//      it captures whatever is in flight, so a steady stream of publications cannot starve it.
//   2. Before the capture: for an audit's trigger, its cited P1s re-witnessed on the head (B5's `rewitnessP1s`, the
//      race of §2.5); after an evidence rejection, the lanes of the observations it cited re-witnessed on the head.
//   3. The capture (H2, A19), under the revision fence in one synchronous step: `checkpoint-inputs{job, trigger,
//      generation, vector, headSha, visionSha256, findings, observations, issues?, corpusSha256?}`. The vector is the
//      plan rev, every unit's spec rev, the obligations', ledger's and vision's bytes, and the blob of every plan
//      contract and the architecture doc at the head. The generation is the trigger audit's (a park's: the latest
//      recorded, else 1). M4a: in a corpus arc, the issues are captured first (src/holistic/intake.ts: the kept capture,
//      or `unavailable{reason}`; an untrusted issue policy holds the job uncaptured, `skipped{issue-policy-untrusted}`),
//      and `corpusSha256` names the pin in force. An enactment (no call) captures no issues.
//   4. The call: a fresh session on the checkpoint seat (`callArcRole`, `arc-backend{role: checkpoint}`, metered to the
//      job), `@cpu`×1 under the job, in a detached checkout `<job>.checkpoint` of the captured head, the prompt rendered
//      from the recorded inputs alone: the vision first and in full (by its kept bytes), the trigger and head, vision
//      coverage, the findings, the obligations with their observations on the head, the uncovered divergences, the plan
//      in force at the captured rev (units with state, edges, limits and routing), the contracts at the head, the
//      rulings, the direction, the captured issues; a corpus arc's materialised pin is readable beside the checkout
//      (`targetDirs`). M4a rev 3 (H4, F08, F16, F21): the input manifest (every captured input by kind, id, kept path and
//      sha256: the only way to read one), every non-retired unit's spec in full with the item ids it holds, and the
//      ledger's next ruling id. H5 (R65): after a `no-op` decision, a non-final audit checkpoint whose findings,
//      obligations, ledger, plan and specs, issue capture and observation verdicts are as that no-op saw them renders a
//      closeout (`closeout{since}`): the findings and specs are not repeated. Issues unchanged since the latest decided
//      checkpoint, on unchanged grounds, are not listed (`issuesUnchangedSince`, src/holistic/intake.ts `issueReuse`). A resumed job consumes a
//      call it made; a call interrupted (a pause, a stop, a backend park) leaves the job running and a later run asks
//      again as the next attempt. A refusal or fault is an invalid decision. 2026-10-15: an answer off its schema, or
//      whose bundle the activation finds invalid, first takes one repair turn: its own session resumed (`repairCall`)
//      with every reason, as the next attempt, whose answer is decided (refused again: invalid). A repair turn the job
//      already made is consumed in place of the answer it repaired (`madeRepair`).
//   4b. Drift (paid M4b run 3). A decision is checked at its activation against the arc as it is then, strictly; what
//      moved since the capture is handled by what can judge it. Code can re-check the head: the decision's cited lanes
//      with no observation on the head now (a publication moved it under the call) are witnessed there before the
//      activation (`witnessDrift`), so the evidence base compares each citation with the head's own observation (one it
//      contradicts still rejects `evidence`). Only a fresh read can judge a new plan or vision: a revision that changes
//      either supersedes the job at once (`supersededBy`): its call in flight is cancelled (`proc.kill{supersede}`,
//      `supersedable`), or not made, and the job decides `rejected{stale}`, so the trigger is captured again on the new
//      revision. A finding closed under the call (paid M4b run 5) is stale only where the decision rests on it; its
//      disposition alone is moot (src/holistic/bundle.ts `restsOn`). No drift path spends the trigger's one invalid
//      retry. Other revisions (a spec patch, a ruling) leave the call running; the activation's staleness checks what the
//      bundle touches.
//   5. The activation (src/holistic/bundle.ts): `plan-applied{source: bundle{job}}` or `bundle-decided`; then (an
//      applied or no-op decision) its amendments and issue outcomes (src/holistic/{amendments,intake}.ts).
//
// OR-Q1: `designParkRoute` tells the scheduler what a design park waits for: the checkpoint (its park item is held
// back), the owner (`respec-second`, raised here), or its own park item (the checkpoint decided nothing applicable).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshJudgmentSession, resumedJudgmentSession } from '../backends/argv.ts';
import { crashPoint } from '../core/crash.ts';
import type { CheckpointIssues, Parent } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { type JsonValue, canonicalJson } from '../core/json.ts';
import { type InvocationId, type JobId, type LaneId, type Sha, type Sha256Hex, type UnitId, INTEGRATION_SLOT, invocationId, parseInvocationId, canonicalIds } from '../core/ids.ts';
import { invocationDir, killWorkload } from '../pipeline/invoke.ts';
import { runnerFiles } from '../runner/files.ts';
import type { JournalView } from '../core/interfaces.ts';
import { BACKEND_PARK_CLASSES } from '../core/events.ts';
import { DEFAULT_BOUNDS, specWitnesses } from '../core/records.ts';
import { type CheckpointState, openAttempt } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { git, revParse } from '../git/git.ts';
import {
  ISSUES_INPUT, OBLIGATIONS_INPUT, PHASE0_INPUT, PLAN_INPUT, RULING_INPUT, RULINGS_INPUT, SPEC_INPUT, VISION_INPUT, inForceFiles, inputPath, keptInput, payloadAtRev, requirePlanInForce,
  revisionInForce,
} from '../input/inforce.ts';
import { DEFAULT_CONVERGENCE_K, type PlanM1, advancesOf, parsePlan } from '../input/plan.ts';
import { raiseNeedsUser, raisedFor, readNeedsUser } from '../needsuser.ts';
import {
  type BackendCallOutcome, type JobParent, arcSeat, callArcRole, minutesMs, recordedArcCall, runOp, verdictOf,
} from '../pipeline/dispatch.ts';
import { arcJourneyLane, jobSeriesCheckout, laneEnvId, observations, observedViews, removeJobCheckouts, runJourneySeries } from '../pipeline/lanes.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { candidateRedCause } from '../pipeline/unit.ts';
import { architecture, docAt, inMs, ledgerDir, ledgerPath, targetDirs } from '../pipeline/stages.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import { promptFor } from '../prompts/index.ts';
import { type CheckpointInputs, type CheckpointSpec, type FindingView, type ManifestEntry, type ManifestKind, type TriggerView, visionInputOf } from '../prompts/inputs.ts';
import { type CheckpointIds, type CheckpointOutput, checkpointSchemaFor, validateCheckpointOutput } from '../prompts/schemas.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { entryOf, isFree, resourceTable } from '../resources/reserve.ts';
import { renderSpec } from '../spec/render.ts';
import { nextRulingId, parseRulings } from '../spec/rulings.ts';
import { parseSpec } from '../spec/spec.ts';
import { removeCheckout, rewitnessP1s, withCpu } from './audit.ts';
import { type Activation, type BundleDecision, type Captured, type CheckpointContext, INVALID_REQUEST_OPTIONS, type Refused, activate, effectiveOps, raiseOnce, recordedAdmits, settleDecided, vectorAt } from './bundle.ts';
import { opportunityClauses } from './admits.ts';
import { integrationHeadNow } from './cadence.ts';
import type { AppliedBundle } from './convergence.ts';
import { uncoveredDivergences } from './divergence.ts';
import { isActive } from './findings.ts';
import { captureCheckpointIssues, issueReuse, issuesInputOf } from './intake.ts';
import { keyOf, reuse } from './observe.ts';
import { type ArcLaneDef, type BusyAttempt, type CheckpointTrigger, type ObligationDef, type Obligations, type Vision, observationKeyText, parseObligations, parseRulingSidecar, parseVision } from './types.ts';
import { visionCoverage } from './vision.ts';

export type { CheckpointContext } from './bundle.ts';

export type CheckpointOutcome =
  /** Nothing is due. */
  | Readonly<{ kind: 'none' }>
  /**
   * Due, but not asked: the checkpoint backend is parked, or the arc is paused or stopped; or (M4a) an untrusted issue
   * policy's item is open and the job waits uncaptured (R31); or (R-15) a publication is in flight (`publishing`).
   */
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' | 'issue-policy-untrusted' | 'publishing' }>
  /** The call was interrupted (a pause, a stop, a backend park): the job stays running and resumes at a later call. */
  | Readonly<{ kind: 'interrupted'; job: JobId; detail: string }>
  | Readonly<{ kind: 'decided'; job: JobId; trigger: CheckpointTrigger; decision: BundleDecision }>;

const jobParent = (job: JobId): JobParent => ({ type: 'job', job });
const triggerKey = (t: CheckpointTrigger): string => canonicalJson(t);
const checkpointCheckout = (ctx: CheckpointContext, job: JobId): AbsPath => absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.checkpoint`));

// ---------------------------------------------------------------------------------------------------
// Consumed calls

/** Whether a recorded call was already read as an interruption (a pause, a stop, a backend park): a later run asks again. */
export function interruptedCall(called: BackendCallOutcome): boolean {
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

/** Every applied bundle so far, in log order: its job, its revision.commit's seq, its effective ops (converted admits dropped, Q4). */
function appliedBundles(ctx: CheckpointContext): readonly AppliedBundle[] {
  const view = ctx.journal.view;
  return view.opsOf('revision.commit').flatMap((commit) => {
    if (commit.expect.source.type !== 'bundle' || view.doneOf(commit.op) === null) return [];
    const job = commit.expect.source.job;
    const out = outputOf(ctx, job);
    if (out === null) throw new Error(`${job} applied a bundle, but its output is not recorded`);
    return [{ job, seq: Number(commit.op.slice(commit.op.lastIndexOf('/') + 1)), ops: effectiveOps(view, job, out.output) }];
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

/** `since`: the seq from which the trigger has waited (its audit's end, its park, or its previous job's capture). */
type Due = Readonly<{ trigger: CheckpointTrigger; generation: number; prev: CheckpointState | null; since: number }>;

/** The latest generation any audit or checkpoint recorded (1 before any). */
function latestGeneration(ctx: CheckpointContext): number {
  const fold = ctx.journal.view.holistic();
  return Math.max(1, ...fold.audits.map((a) => a.started.generation), ...fold.checkpoints.map((c) => c.inputs.generation));
}

/** A busy rejection's attempts (C5, R50) that are still open: what its trigger waits for before it is due again. */
export function stillBusy(view: JournalView, last: CheckpointState): readonly BusyAttempt[] {
  const d = last.decided;
  if (d?.kind !== 'rejected' || d.reason !== 'busy') return [];
  return (d.units ?? []).filter((b) => {
    const open = openAttempt(view, b.unit);
    return open !== null && open.stage === b.stage && open.attempt === b.attempt;
  });
}

/**
 * The checkpoints waiting at a stage boundary now (status): each trigger's latest job that was rejected `busy` and the
 * attempts it named that are still open.
 */
export function busyWaits(view: JournalView): readonly Readonly<{ job: JobId; waitingFor: readonly BusyAttempt[] }>[] {
  const latest = new Map<string, CheckpointState>();
  for (const c of view.holistic().checkpoints) latest.set(triggerKey(c.inputs.trigger), c);
  return [...latest.values()].sort((a, b) => a.inputs.seq - b.inputs.seq).flatMap((c) => {
    const waitingFor = stillBusy(view, c);
    return waitingFor.length === 0 ? [] : [{ job: c.inputs.job, waitingFor }];
  });
}

/** Whether a trigger whose latest job is `last` is due again (see the header). */
function dueAgain(ctx: CheckpointContext, last: CheckpointState | undefined): boolean {
  if (last === undefined) return true;
  const d = last.decided;
  if (d === null) throw new Error(`${last.inputs.job} is running; it resumes before any trigger is due`);
  // C5 (R50): a busy rejection is due once every attempt it named has closed (none open, or another one).
  if (d.kind === 'rejected' && d.reason === 'busy') return stillBusy(ctx.journal.view, last).length === 0;
  if (d.kind === 'rejected') return true;
  return approved(ctx, last);
}

/** The first due trigger, parks first; null when none is. */
function dueTrigger(ctx: CheckpointContext): Due | null {
  const fold = ctx.journal.view.holistic();
  const latest = (t: CheckpointTrigger): CheckpointState | undefined => fold.checkpoints.filter((c) => triggerKey(c.inputs.trigger) === triggerKey(t)).at(-1);
  const parks = designParks(ctx).filter((p) => earlierRespecs(ctx, p.unit, p.seq).length === 0)
    .map((p) => ({ trigger: { type: 'park', unit: p.unit, seq: p.seq } as CheckpointTrigger, generation: latestGeneration(ctx), at: p.seq }));
  const audits = fold.audits.flatMap((a) => (a.ended?.outcome === 'completed'
    ? [{ trigger: { type: 'audit', job: a.started.job } as CheckpointTrigger, generation: a.started.generation, at: a.ended.seq }] : []));
  for (const { at, ...t } of [...parks, ...audits]) {
    const last = latest(t.trigger);
    if (dueAgain(ctx, last)) return { ...t, prev: last ?? null, since: last?.inputs.seq ?? at };
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

/** R-15: how long a due checkpoint waits for the publications in flight before it captures anyway (see the header). */
export const CAPTURE_WAIT_MAX_MIN = 15;

/**
 * The stages whose open attempt moves what a capture reads: plan-check (its redirect patches the unit's spec, R-20), and
 * the judgment stage and publication steps after which a unit's publication moves the integration head (R-15).
 */
const PUBLISHING_STAGES: readonly string[] = ['plan-check', 'gate', 'candidate', 'ff'];

/**
 * R-15 (paid M4a run 10: ckpt-3 captured while refusal-next-steps was at gate, which published 4 s later) and R-20 (paid
 * M4a run 11: ckpt-2 was stale after a plan-check patched a spec it read): what would move a capture's inputs under it now:
 * each unit at plan-check, gate, candidate or ff, or approved and not yet at its candidate, and the integration slot when
 * any publication holds it (a unit's, a docs or a batch one). Empty: a capture now is not stale on arrival.
 */
export function publishing(view: JournalView): readonly string[] {
  const out = view.plannedUnits().flatMap((unit) => {
    const open = openAttempt(view, unit);
    if (open !== null) return PUBLISHING_STAGES.includes(open.stage) ? [`${unit} at ${open.stage} attempt ${open.attempt}`] : [];
    const u = view.unit(unit);
    return u.status === 'active' && u.decided?.stage === 'gate' && u.decided.outcome === 'approve' ? [`${unit} approved at gate attempt ${u.decided.attempt}`] : [];
  });
  return isFree(entryOf(resourceTable(view), INTEGRATION_SLOT)) ? out : [...out, 'the integration slot is held'];
}

/** Whether a checkpoint is running or due now (the scheduler's question before it calls `runCheckpoint`). */
export function checkpointPending(ctx: CheckpointContext): boolean {
  const fold = ctx.journal.view.holistic();
  if (!fold.on) return false;
  return fold.checkpoints.some((c) => c.decided === null) || dueTrigger(ctx) !== null;
}

// ---------------------------------------------------------------------------------------------------
// The capture (H2)

/** `checkpoint-inputs` of `due` with `issues` (M4a: absent outside a corpus arc), captured synchronously under the revision fence. */
function capture(ctx: CheckpointContext, due: Due, issues: CheckpointIssues | null): Captured {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce);
  const files = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile, ctx.repo);
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
    findings: canonicalIds(view.holistic().findings.filter(isActive).map((f) => f.id)),
    observations: shown,
    ...(issues === null ? {} : { issues }),
    ...(revision.corpus === null ? {} : { corpusSha256: revision.corpus.pin.sha256 }),
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
const payloadAt = (ctx: CheckpointContext, rev: number) => payloadAtRev(ctx.journal.view, ctx.runDir, rev);

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
 * The plan in force at the captured rev, rendered: each unit with its state, edges, limits and routing layer, and the
 * arc's limits. The specs are embedded beside it, every one in full (H4): an `admit`'s spec takes their shape.
 */
function renderPlan(ctx: CheckpointContext, s: Captured, r: Recorded): string {
  const view = ctx.journal.view;
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
  return [
    `Plan rev ${r.planRev}. Units, in plan order:`,
    ...lines,
    `Arc limits: ${canonicalJson(r.plan.limits ?? {})} (convergenceK ${r.plan.limits?.convergenceK ?? DEFAULT_CONVERGENCE_K}).`,
  ].join('\n');
}

/**
 * H4 (F08): every input the checkpoint was captured on, content-addressed in the run dir: the plan, each spec, the ledger
 * and its sidecars, the obligations, the vision, the Phase-0 record and the issue capture.
 */
function manifestOf(ctx: CheckpointContext, s: Captured): readonly ManifestEntry[] {
  const m = payloadAt(ctx, s.vector.plan).manifest;
  const entry = (kind: ManifestKind, id: string, sha256: Sha256Hex, ext: string): ManifestEntry => ({ kind, id, path: inputPath(ctx.runDir, sha256, ext), sha256 });
  if (s.vector.ledgerSha256 === null) throw new Error(`${s.job}: a holistic revision keeps its ledger`);
  return [
    entry('plan', 'plan', m.planSha256, PLAN_INPUT),
    ...Object.entries(m.specs).sort(([a], [b]) => (a < b ? -1 : 1)).map(([unit, sha]) => entry('spec', unit, sha, SPEC_INPUT)),
    entry('ledger', 'rulings', s.vector.ledgerSha256, RULINGS_INPUT),
    ...Object.entries(m.rulings.sidecars).map(([id, sha]) => entry('sidecar', id, sha, RULING_INPUT)),
    ...(s.vector.obligationsSha256 === null ? [] : [entry('obligations', 'obligations', s.vector.obligationsSha256, OBLIGATIONS_INPUT)]),
    entry('vision', 'vision', s.visionSha256, VISION_INPUT),
    ...(m.phase0 === undefined ? [] : [entry('phase0', 'phase0', m.phase0, PHASE0_INPUT)]),
    ...(s.issues?.type === 'captured' ? [entry('issues', 'issues', s.issues.sha256, ISSUES_INPUT)] : []),
  ];
}

/** H4 (F21): every non-retired unit's spec in force at the captured rev, in plan order, rendered, with every item id it holds. */
function specsOf(ctx: CheckpointContext, r: Recorded): readonly CheckpointSpec[] {
  const view = ctx.journal.view;
  const m = payloadAt(ctx, r.planRev).manifest;
  return r.plan.units.flatMap((u) => {
    const status = view.unit(u.id).status;
    const sha = m.specs[u.id];
    if (status === 'retired' || status === 'cut' || status === 'superseded' || sha === undefined) return [];
    const spec = parseSpec(kept(ctx, sha, SPEC_INPUT), absPath(join(ctx.planFile, '..', u.spec)));
    const occupied = [...spec.lanes, ...spec.acceptance, ...spec.decisions, ...spec.facts, ...specWitnesses(spec)].map((i) => i.id as string);
    return [{ unit: u.id, rev: spec.rev, markdown: renderSpec(spec), occupied }];
  });
}

/** Whether audit `job` ran for the arc's final trigger (H5: a final checkpoint always renders in full). */
function finalAudit(ctx: CheckpointContext, job: JobId): boolean {
  return ctx.journal.view.holistic().audits.find((x) => x.started.job === job)?.started.triggers.some((t) => t.type === 'final') ?? false;
}

/**
 * H5 (F11, R65): the no-op checkpoint this one closes out, or null (a full render). The latest checkpoint decided before
 * `s` decided `no-op`, `s` is an audit's and not the final one, and since that no-op's capture the active findings, the
 * vision, obligations, ledger, plan and specs, the issue capture and every obligation's verdict on the head are equal.
 */
function closeoutOf(ctx: CheckpointContext, s: Captured, r: Recorded): CheckpointInputs['closeout'] {
  if (s.trigger.type !== 'audit' || finalAudit(ctx, s.trigger.job)) return null;
  const prev = ctx.journal.view.holistic().checkpoints.filter((c) => c.inputs.seq < s.seq && c.decided !== null).at(-1);
  if (prev?.decided?.kind !== 'no-op') return null;
  const was = prev.inputs;
  const same = canonicalJson(was.findings) === canonicalJson(s.findings)
    && canonicalJson({ ...was.vector, contracts: [] }) === canonicalJson({ ...s.vector, contracts: [] })
    && canonicalJson(was.issues ?? null) === canonicalJson(s.issues ?? null);
  if (!same) return null;
  const obligations = r.obligations?.obligations ?? [];
  const verdicts = (head: Sha) => observedViews(ctx, r.obligations, obligations, head).map((v) => [v.obligation.id, v.observation?.verdict ?? null]);
  return canonicalJson(verdicts(was.headSha)) === canonicalJson(verdicts(s.headSha)) ? { since: was.job } : null;
}

function findingViews(ctx: CheckpointContext, ids: readonly Captured['findings'][number][]): readonly FindingView[] {
  const findings = ctx.journal.view.holistic().findings;
  return ids.map((id) => {
    const f = findings.find((x) => x.id === id);
    if (f === undefined) throw new Error(`the checkpoint names finding ${id}, which the fold does not have`);
    return { id: f.id, lens: f.lens, severity: f.severity, state: f.state, obligation: f.obligation, claim: f.claim, owner: f.owner };
  });
}

/**
 * The trigger as the checkpoint reads it: a park with its cause from the unit's parking outcome (null when the unit
 * has decided something since), so an executor-side red is never read as a design question (paid m3 run 7).
 */
function triggerView(ctx: CheckpointContext, t: CheckpointTrigger): TriggerView {
  if (t.type === 'audit') return t;
  const view = ctx.journal.view;
  const u = view.unit(t.unit);
  const f = u.decided;
  if (f === null || view.decidedSeq(t.unit) !== t.seq) return { ...t, cause: null };
  const d = decidedBy(f);
  if (d.kind !== 'park') throw new Error(`checkpoint trigger ${t.unit}@${t.seq}: the outcome there is no park`);
  const unit = ctx.plan().units.find((x) => x.id === t.unit);
  if (unit === undefined) throw new Error(`checkpoint trigger: unit ${t.unit} is not planned`);
  const detail = [
    ...(d.reason === 'chargeable-bound' ? [`Its chargeable failures reached the unit's bound of ${u.bounds.chargeable}.`] : []),
    ...(d.reason === 'candidate-red' ? [`Its candidate was red again after ${u.bounds.candidateReds} fix round${u.bounds.candidateReds === 1 ? '' : 's'}: the candidate-red bound is spent.`] : []),
    ...(f.stage === 'candidate' && f.outcome === 'red' ? candidateRedCause(ctx, unit, { type: 'stage', unit: f.unit, stage: f.stage, attempt: f.attempt }) : []),
  ];
  // A judgment's escalation or a refusal past the escalation seat is a design question; anything else the executor decided.
  const design = d.reason === 'escalation' || d.reason === 'refusal';
  return { ...t, cause: { stage: f.stage, attempt: f.attempt, outcome: f.outcome, reason: d.reason, design, detail } };
}

/**
 * Paid M4b run 3 (ckpt-5 re-ran blind to ckpt-4's evidence rejection): every earlier job of `s`'s trigger the executor
 * rejected, oldest first, each with its reason and detail verbatim, whatever the reason (`invalid`: what the retry must
 * not repeat; `evidence`, `stale`, `busy`: what moved under it). Only rejections: a trigger's other decisions end it, or
 * (an approved request) are enacted with no call.
 */
function priorRejected(ctx: CheckpointContext, s: Captured): CheckpointInputs['priorRejected'] {
  return ctx.journal.view.holistic().checkpoints
    .filter((c) => triggerKey(c.inputs.trigger) === triggerKey(s.trigger) && c.inputs.seq < s.seq)
    .flatMap((c) => (c.decided?.kind === 'rejected' ? [{ job: c.inputs.job, reason: c.decided.reason, detail: c.decided.detail }] : []));
}

/** How many refused proposals a checkpoint's prompt carries at most: the most recent. */
export const REFUSED_MAX = 3;

/**
 * Paid M4a run 12 (ckpt-3 to ckpt-5 re-proposed one invalid split, each a paid call): the decisions captured before `s`
 * under its plan rev, on any trigger, that the executor refused: rejected `invalid` (its detail), or sent to the owner as
 * not applicable as proposed (an invalid second decision, or no valid decision twice: the request's summary). The most
 * recent REFUSED_MAX, oldest first, without the jobs of `prior` (this trigger's, rendered as `priorRejected`). A later
 * plan rev drops them: the plan they were refused against changed.
 */
function refusedOf(ctx: CheckpointContext, s: Captured, prior: CheckpointInputs['priorRejected']): CheckpointInputs['refused'] {
  const shown = new Set(prior.map((p) => p.job));
  return ctx.journal.view.holistic().checkpoints
    .filter((c) => c.inputs.seq < s.seq && c.inputs.vector.plan === s.vector.plan && !shown.has(c.inputs.job))
    .flatMap((c): CheckpointInputs['refused'] => {
      const d = c.decided;
      if (d?.kind === 'rejected' && d.reason === 'invalid') return [{ job: c.inputs.job, outcome: 'rejected-invalid', reasons: d.detail }];
      if (d?.kind !== 'requested') return [];
      const id = d.needsUser as Parameters<typeof readNeedsUser>[1];
      const record = readNeedsUser(ctx.runDir, id);
      if (record === null) throw new Error(`${c.inputs.job} decided the request ${id}, which has no record`);
      const notApplicable = canonicalJson(record.options.map((o) => o.id)) === canonicalJson(INVALID_REQUEST_OPTIONS.map((o) => o.id));
      return notApplicable ? [{ job: c.inputs.job, outcome: 'owner-request', reasons: record.summary }] : [];
    })
    .slice(-REFUSED_MAX);
}

function checkpointInputs(ctx: CheckpointContext, s: Captured, r: Recorded): CheckpointInputs {
  const rulings = parseRulings(r.ledgerText, ledgerPath(ctx));
  const closeout = closeoutOf(ctx, s, r);
  const reuse = issueReuse(ctx.journal.view, ctx.runDir, s);
  const sidecars = Object.entries(payloadAt(ctx, r.planRev).manifest.rulings.sidecars)
    .map(([, sha]) => parseRulingSidecar(JSON.parse(kept(ctx, sha, RULING_INPUT).toString('utf8'))));
  const prior = priorRejected(ctx, s);
  return {
    vision: visionInputOf(r.vision, advancesOf(r.plan)),
    trigger: triggerView(ctx, s.trigger),
    priorRejected: prior,
    refused: refusedOf(ctx, s, prior),
    head: s.headSha,
    plan: renderPlan(ctx, s, r),
    // A closeout (H5) repeats neither the findings nor the specs the no-op it follows weighed.
    findings: closeout === null ? findingViews(ctx, s.findings) : [],
    obligations: r.obligations === null ? [] : observedViews(ctx, r.obligations, r.obligations.obligations, s.headSha),
    coverage: visionCoverage(r.vision, advancesOf(r.plan), r.obligations, sidecars.map((x) => ({ id: x.id, cites: x.cites })), opportunityClauses(recordedAdmits(ctx.journal.view))),
    divergences: uncoveredDivergences(ctx.journal.view).map((d) => ({ id: d.id, type: d.type, what: d.what })),
    contracts: r.plan.contracts.map((c) => docAt(ctx, s.headSha, c)),
    rulings: rulings.flatMap((x) => (x.status === 'active' ? [{ id: x.id, text: x.text }] : [])),
    index: { contracts: [], rulings: rulings.flatMap((x) => (x.status === 'withdrawn' ? [{ id: x.id, line: `withdrawn by ${x.by}` }] : [])), ledger: ledgerPath(ctx) },
    target: architecture(ctx, s.headSha),
    direction: r.plan.direction,
    issues: issuesInputOf(ctx.runDir, s, reuse),
    manifest: manifestOf(ctx, s),
    specs: closeout === null ? specsOf(ctx, r) : [],
    nextRulingId: nextRulingId(rulings),
    closeout,
    issuesUnchangedSince: reuse?.since ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------
// The call

/**
 * A call's reading. `repairOf` (2026-10-15, arc feedback #3): the attempt whose answer may still take its repair turn (a
 * fresh call's answer that its schema or the bundle's validation may refuse), or null (a repair turn's own answer, an
 * enactment's, or a failure that is no answer: a refusal, a fault, a lost call).
 */
type Asked =
  | Readonly<{ kind: 'output'; output: CheckpointOutput; inv: InvocationId; repairOf: number | null }>
  | Readonly<{ kind: 'failed'; detail: string; inv: InvocationId; repairOf: number | null }>
  | Readonly<{ kind: 'interrupted'; detail: string }>
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' }>
  /** A revision superseded the captured inputs (`supersededBy`): decided `rejected{stale}` with no (further) call. */
  | Readonly<{ kind: 'superseded'; detail: string }>;

/**
 * Why a revision since `s`'s capture supersedes its call, or null: the plan's bytes or the vision changed, the arc-wide
 * inputs nearly every decision rests on and only a fresh read can judge (a bundle touching the plan is stale against
 * the first, every bundle against the second, H3). The wording is the activation's staleness reasons'.
 */
export function supersededBy(ctx: CheckpointContext, s: Captured): string | null {
  const view = ctx.journal.view;
  if (view.planApplied()?.rev === s.vector.plan) return null;
  const inForce = requirePlanInForce(ctx.runDir, view);
  if (revisionInForce(ctx.runDir, inForce).vision?.sha256 !== s.visionSha256) return 'the vision changed since the checkpoint read it';
  return payloadAt(ctx, s.vector.plan).manifest.planSha256 !== inForce.manifest.planSha256 ? `the plan changed since plan rev ${s.vector.plan}` : null;
}

/** How often a checkpoint call in flight looks for a superseding revision. */
export const SUPERSEDE_POLL_MS = 1000;

/**
 * Runs `call` (the job's backend call), cancelling it (`proc.kill{supersede}`) once a revision supersedes `s`
 * (`supersededBy`), so a call is not paid to its end only to be rejected stale (paid M4b run 3: ckpt-7 ran seven
 * minutes past the owner's apply).
 */
async function supersedable<T>(ctx: CheckpointContext, s: Captured, call: () => Promise<T>): Promise<T> {
  let killing: Promise<void> | null = null;
  let failure: unknown = null;
  const poll = (): void => {
    if (killing !== null || supersededBy(ctx, s) === null) return;
    const spawn = ctx.journal.view.opsOf('proc.spawn').find((i) => i.expect.subject.purpose === 'arc-backend' && i.expect.subject.job === s.job && ctx.journal.view.doneOf(i.op) === null);
    if (spawn === undefined) return;
    const inv = invocationId(spawn.op, spawn.ordinal);
    // A runner that has not written runner.json may not have exec'd yet: the next poll finds it (as the scheduler's kills).
    const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
    if (files.read('runner.json') === null || files.read('exit.json') !== null) return;
    killing = killWorkload(ctx, { inv, scope: 'invocation', reason: 'supersede' }).catch((error: unknown) => {
      failure = error;
    });
  };
  const timer = setInterval(() => {
    try {
      poll();
    } catch (error) {
      failure = error;
    }
  }, SUPERSEDE_POLL_MS);
  try {
    return await call();
  } finally {
    clearInterval(timer);
    if (killing !== null) await killing;
    if (failure !== null) throw failure;
  }
}

/**
 * The closed id sets the call's schema enumerates (paid M4b run 5, ckpt-4), from the captured obligations: the arc lanes a
 * split child's witness may name, the active obligations a split may name as its parent, every obligation a dispose may
 * name. Null outside a holistic arc with obligations (any id; the bundle's validation refuses an unknown one).
 */
export function checkpointIdsOf(obligations: Readonly<{ lanes: readonly Pick<ArcLaneDef, 'id'>[]; obligations: readonly ObligationDef[] }> | null): CheckpointIds | null {
  if (obligations === null) return null;
  return {
    arcLanes: obligations.lanes.map((l) => l.id),
    splittable: obligations.obligations.filter((o) => o.state.type === 'active').map((o) => o.id),
    obligations: obligations.obligations.map((o) => o.id),
  };
}

/**
 * Reads call `attempt` of the job: an output, a failure (an invalid decision), or an interruption (its park or usage-limit
 * item written). `repaired`: the call is a repair turn, whose answer takes no further one.
 */
function read(ctx: CheckpointContext, job: JobId, called: BackendCallOutcome, attempt: number, repaired: boolean): Asked {
  const v = verdictOf(ctx, jobParent(job), called);
  const repairOf = repaired ? null : attempt;
  switch (v.kind) {
    case 'success':
      try {
        return { kind: 'output', output: validateCheckpointOutput(v.value), inv: called.inv, repairOf };
      } catch (error) {
        if (error instanceof SchemaError) return { kind: 'failed', detail: `malformed decision: ${error.message}`, inv: called.inv, repairOf };
        throw error;
      }
    // An answer the adapter found off its schema is an answer to repair.
    case 'malformed':
      return { kind: 'failed', detail: `malformed: ${v.detail}`, inv: called.inv, repairOf };
    case 'interrupted': {
      if (v.needsUser !== null) {
        const parent: Parent = { type: 'op', op: parseInvocationId(called.inv).op };
        if (raisedFor(ctx.journal.view, parent) === null) raiseNeedsUser(ctx.journal, ctx.runDir, v.needsUser, parent);
      }
      return { kind: 'interrupted', detail: `interrupted: ${v.reason}` };
    }
    default:
      return { kind: 'failed', detail: `${v.kind}: ${v.detail}`, inv: called.inv, repairOf: null };
  }
}

/**
 * The repair turn the job already made after its answer at `attempt` (a later attempt; an interrupted one is skipped), read
 * as the job's answer: a crash after it never judges the answer it repaired again. Null when it made none.
 */
function madeRepair(ctx: CheckpointContext, job: JobId, attempt: number): Asked | null {
  for (let next = attempt + 1; ; next++) {
    const called = recordedArcCall(ctx, job, 'checkpoint', next);
    if (called === null) return null;
    if (interruptedCall(called)) continue;
    if (called.kind === 'lost') return { kind: 'failed', detail: `${called.inv} was lost with its runner`, inv: called.inv, repairOf: null };
    return read(ctx, job, called, next, true);
  }
}

/** The job's call: one it made and consumes, or a new attempt (skipped while its backend is parked or the arc paused). */
async function ask(ctx: CheckpointContext, s: Captured): Promise<Asked> {
  for (let attempt = 1; ; attempt++) {
    const recordedCall = recordedArcCall(ctx, s.job, 'checkpoint', attempt);
    if (recordedCall !== null && interruptedCall(recordedCall)) continue;
    if (recordedCall !== null && recordedCall.kind === 'result') return madeRepair(ctx, s.job, attempt) ?? read(ctx, s.job, recordedCall, attempt, false);
    // Paid M4b run 3: inputs a revision superseded are not asked (again); a superseded call ends here as well.
    const superseded = supersededBy(ctx, s);
    if (superseded !== null) return { kind: 'superseded', detail: superseded };
    const skip = checkpointSkip(ctx);
    if (skip !== null) return { kind: 'skipped', reason: skip };
    const r = recorded(ctx, s);
    const { triple } = arcSeat(ctx, 'checkpoint');
    const prompt = promptFor('checkpoint', triple.model);
    const checkout = checkpointCheckout(ctx, s.job);
    await removeJobCheckouts(ctx, s.job);
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${s.job}`, jobParent(s.job), { path: checkout, checkout: { type: 'detached', at: s.headSha } });
    const inputs = checkpointInputs(ctx, s, r);
    const rendered = prompt.render(inputs);
    const called = await withCpu(ctx, s.job, () => supersedable(ctx, s, () => callArcRole(ctx, {
      job: s.job, role: 'checkpoint', attempt, system: prompt.system, rendered, schema: checkpointSchemaFor(checkpointIdsOf(r.obligations)), cwd: checkout,
      evidenceDirs: [ledgerDir(ctx), ...targetDirs(inputs.target)],
      deadlineAt: inMs(minutesMs(ctx.plan().limits?.judgmentDeadlineMin ?? DEFAULT_BOUNDS.judgmentDeadlineMin)), session: freshJudgmentSession(),
    })));
    await removeCheckout(ctx, s.job, checkout);
    if (called.kind === 'result' && called.result.outcome.kind === 'cancelled' && called.result.outcome.reason === 'supersede') continue;
    if (called.kind === 'lost') return { kind: 'failed', detail: `${called.inv} was lost with its runner`, inv: called.inv, repairOf: null };
    return read(ctx, s.job, called, attempt, false);
  }
}

/**
 * 2026-10-15 (arc feedback #3): the repair turn of the answer call `inv` gave as attempt `of`: the same session resumed once
 * (`--resume`; the checkpoint's fresh call persists it) with every reason the answer was refused (its schema, or the
 * bundle's validation), in the checkout of the captured head made again (a resumed Claude session is found by its cwd),
 * with the call's own schema. The next attempt after `of`; an interrupted one is asked again as the one after.
 */
async function repairCall(ctx: CheckpointContext, s: Captured, inv: InvocationId, of: number, reasons: readonly string[]): Promise<Asked> {
  for (let attempt = of + 1; ; attempt++) {
    const recordedCall = recordedArcCall(ctx, s.job, 'checkpoint', attempt);
    if (recordedCall !== null && interruptedCall(recordedCall)) continue;
    if (recordedCall !== null && recordedCall.kind === 'result') return read(ctx, s.job, recordedCall, attempt, true);
    const superseded = supersededBy(ctx, s);
    if (superseded !== null) return { kind: 'superseded', detail: superseded };
    const skip = checkpointSkip(ctx);
    if (skip !== null) return { kind: 'skipped', reason: skip };
    const launch = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('launch.json');
    if (launch === null || launch.terminal.type !== 'backend' || launch.terminal.role !== 'checkpoint') throw new Error(`${inv}: a checkpoint call without its checkpoint launch.json`);
    const { schemaPath, session } = launch.terminal;
    if (session.backend !== 'claude' || session.mode !== 'fresh') throw new Error(`${inv}: a checkpoint repair turn follows a fresh Claude session, not ${canonicalJson(session)}`);
    const prompt = promptFor('checkpoint', arcSeat(ctx, 'checkpoint').triple.model);
    const checkout = checkpointCheckout(ctx, s.job);
    await removeJobCheckouts(ctx, s.job);
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${s.job}`, jobParent(s.job), { path: checkout, checkout: { type: 'detached', at: s.headSha } });
    const called = await withCpu(ctx, s.job, () => supersedable(ctx, s, () => callArcRole(ctx, {
      job: s.job, role: 'checkpoint', attempt, system: prompt.system, rendered: judgmentRepairDirective(reasons), schema: JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonValue,
      cwd: checkout, evidenceDirs: [ledgerDir(ctx), ...targetDirs(architecture(ctx, s.headSha))],
      deadlineAt: inMs(minutesMs(ctx.plan().limits?.judgmentDeadlineMin ?? DEFAULT_BOUNDS.judgmentDeadlineMin)), session: resumedJudgmentSession(session.id),
    })));
    await removeCheckout(ctx, s.job, checkout);
    if (called.kind === 'result' && called.result.outcome.kind === 'cancelled' && called.result.outcome.reason === 'supersede') continue;
    if (called.kind === 'lost') return { kind: 'failed', detail: `${called.inv} was lost with its runner`, inv: called.inv, repairOf: null };
    return read(ctx, s.job, called, attempt, true);
  }
}

// ---------------------------------------------------------------------------------------------------
// Before a capture: re-witnessing

/**
 * The arc lanes in force of `output`'s cited observations that have none on `head`'s tree under their lane rev and this
 * host's environment: what the evidence base (src/holistic/bundle.ts step 5) would find missing there. A citation on
 * the head's own tree, or whose lane the head already observed, is not among them.
 */
function citedLanesUnobserved(ctx: CheckpointContext, output: CheckpointOutput, head: Sha) {
  const revision = revisionInForce(ctx.runDir, requirePlanInForce(ctx.runDir, ctx.journal.view));
  const tree = revParse(ctx.repo, `${head}^{tree}`);
  const store = observations(ctx);
  const wanted = new Set<LaneId>(output.cites.observations.filter((k) => k.treeSha !== tree).map((k) => k.lane));
  return (revision.obligations?.value.lanes ?? []).filter((l) => wanted.has(l.id) && reuse(store, keyOf(tree, l, laneEnvId(ctx, l))) === null);
}

/** Witnesses on the head now, under `job`, `output`'s cited lanes that have no observation there; the head, or null when none was due. */
async function witnessCited(ctx: CheckpointContext, job: JobId, output: CheckpointOutput): Promise<Sha | null> {
  const head: Sha = integrationHeadNow(ctx);
  const lanes = citedLanesUnobserved(ctx, output, head);
  if (lanes.length === 0) return null;
  await removeJobCheckouts(ctx, job);
  await runJourneySeries(ctx, { type: 'job', job, acquireFirst: ctx.acquireFirst }, lanes.map(arcJourneyLane), {
    path: jobSeriesCheckout(ctx, job, 'rewitness'), checkout: { type: 'detached', at: head },
  }, { reuse: true, stop: () => false });
  return head;
}

/** After an evidence rejection: the cited observations' lanes re-witnessed on the head (under the rejected job). */
async function rewitnessCited(ctx: CheckpointContext, prev: CheckpointState): Promise<void> {
  if (prev.decided?.kind !== 'rejected' || prev.decided.reason !== 'evidence') return;
  const out = outputOf(ctx, prev.inputs.job);
  if (out === null) throw new Error(`${prev.inputs.job} was rejected on its evidence, but its output is not recorded`);
  await witnessCited(ctx, prev.inputs.job, out.output);
}

/** How many times a decided job re-witnesses its cited lanes on a head that keeps moving before it activates anyway. */
export const DRIFT_ROUNDS_MAX = 3;

/**
 * Paid M4b run 3 (ckpt-4, $2.01): a publication moved the head while the call ran, the decision's cited observation had
 * none on the new head, and a decision valid for the tree it read was rejected `evidence` and paid for again. Before the
 * activation, the cited lanes with no observation on the head now are witnessed there (no call), so the evidence base
 * compares each citation with the head's own observation, strict as ever: a citation the new head contradicts still
 * rejects. Again while the head moves under the re-witness, at most DRIFT_ROUNDS_MAX rounds; then the activation reads
 * the head as it is (a citation still unobserved there rejects `evidence`, and `rewitnessCited` runs before the next).
 */
async function witnessDrift(ctx: CheckpointContext, job: JobId, output: CheckpointOutput): Promise<void> {
  for (let round = 0; round < DRIFT_ROUNDS_MAX; round++) {
    if (await witnessCited(ctx, job, output) === null) return;
  }
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
    recommendation: 'Read the checkpoint calls\' evidence; make any change the arc needs with `roadmap apply`, then choose `acknowledge`; or choose `decline` to drop it.',
    options: INVALID_REQUEST_OPTIONS,
    evidence: [],
  });
}

/** The latest decided checkpoint, settled again where a crash cut its aftermath short. */
export function settleLatest(ctx: CheckpointContext): void {
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
      // R-15: a paid call waits at the publication boundary, bounded (see the header).
      if (publishing(ctx.journal.view).length > 0 && ctx.clock(due.since) < CAPTURE_WAIT_MAX_MIN) return { kind: 'skipped', reason: 'publishing' };
    }
    if (due.trigger.type === 'audit') await rewitnessP1s(ctx, due.trigger.job);
    if (due.prev !== null) await rewitnessCited(ctx, due.prev);
    let issues: CheckpointIssues | null = null;
    if (ctx.plan().target === 'corpus' && !approved(ctx, due.prev)) {
      const captured = captureCheckpointIssues(ctx);
      if (captured.kind === 'held') return { kind: 'skipped', reason: 'issue-policy-untrusted' };
      issues = captured.issues;
    }
    s = await captureUnderFence(ctx.journal, () => capture(ctx, due, issues));
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
    asked = { kind: 'output', ...out, repairOf: null };
  } else {
    asked = await ask(ctx, s);
  }
  // 2026-10-15 (arc feedback #3): an answer off its schema takes its repair turn before anything is decided.
  if (asked.kind === 'failed' && asked.repairOf !== null) {
    asked = await repairCall(ctx, s, asked.inv, asked.repairOf, [asked.detail]);
  }
  const answered = await answerOf(ctx, s, asked);
  if (answered.kind !== 'output' && answered.kind !== 'failed') return answered;
  crashPoint('checkpoint.after-call');
  const decision = await decideAnswer(ctx, s, answered, enact, prev);
  if (decision.kind !== 'refused') return { kind: 'decided', job, trigger: s.trigger, decision };
  // 2026-10-15: an invalid bundle of a fresh answer takes its repair turn with every reason, and that answer is decided.
  if (answered.kind !== 'output' || answered.repairOf === null) throw new Error(`${job}: a refused bundle without a repair turn to take`);
  const repaired = await answerOf(ctx, s, await repairCall(ctx, s, answered.inv, answered.repairOf, decision.reasons));
  if (repaired.kind !== 'output' && repaired.kind !== 'failed') return repaired;
  const final = await decideAnswer(ctx, s, repaired, enact, prev);
  if (final.kind === 'refused') throw new Error(`${job}: a repair turn's answer was refused for another repair turn`);
  return { kind: 'decided', job, trigger: s.trigger, decision: final };
}

/** A call's reading as the job's answer, or what ends the run without one (skipped, superseded: decided stale, interrupted). */
async function answerOf(ctx: CheckpointContext, s: Captured, asked: Asked): Promise<Extract<Asked, Readonly<{ kind: 'output' | 'failed' }>> | CheckpointOutcome> {
  switch (asked.kind) {
    case 'skipped':
      return asked;
    case 'superseded': {
      const decision: BundleDecision = { kind: 'rejected', reason: 'stale', detail: asked.detail };
      ctx.journal.fact({ kind: 'bundle-decided', job: s.job, outcome: decision });
      return { kind: 'decided', job: s.job, trigger: s.trigger, decision };
    }
    case 'interrupted':
      return { kind: 'interrupted', job: s.job, detail: asked.detail };
    default:
      return asked;
  }
}

/**
 * Decides the job's answer: a failure is an invalid decision (a trigger's second goes to the owner); an output is
 * activated (src/holistic/bundle.ts), `refused` when it is invalid and may still take its repair turn (`repairOf`).
 */
async function decideAnswer(
  ctx: CheckpointContext, s: Captured, asked: Extract<Asked, Readonly<{ kind: 'output' | 'failed' }>>, enact: boolean, prev: CheckpointState | null,
): Promise<BundleDecision | Refused> {
  const { job, trigger } = s;
  if (asked.kind === 'output') await witnessDrift(ctx, job, asked.output);
  const secondInvalid = ctx.journal.view.holistic().checkpoints.some((c) => triggerKey(c.inputs.trigger) === triggerKey(trigger) && c.decided?.kind === 'rejected' && c.decided.reason === 'invalid');
  if (asked.kind === 'failed') {
    const decision: BundleDecision = secondInvalid
      ? { kind: 'requested', needsUser: failedTwice(ctx, job, asked.detail), reason: 'bundle-request' }
      : { kind: 'rejected', reason: 'invalid', detail: asked.detail };
    ctx.journal.fact({ kind: 'bundle-decided', job, outcome: decision.kind === 'requested' ? { kind: 'requested', needsUser: decision.needsUser } : decision });
    return decision;
  }
  const a: Activation = {
    job, captured: enact ? prev!.inputs : s, output: asked.output, inv: asked.inv, enact, secondInvalid, applied: appliedBundles(ctx), repairable: !enact && asked.repairOf !== null,
  };
  return activate(ctx, a);
}
