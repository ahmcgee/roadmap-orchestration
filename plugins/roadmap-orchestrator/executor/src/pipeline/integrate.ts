// The integration slot (plan "Pipeline", candidate, ff and snapshot rows; DESIGN-1.0.md §3 "Merge"):
// candidate → suite lanes → ff-only publication → snapshot, so the tested head is the published head.
//
// The publication transaction (A2, F3): the candidate takes `integration-slot` as its entry reservation, under
// the holder `publication{unit, attempt}` (the candidate's attempt), before its first journaled op, and the
// slot stays that holder's, durably in the journal, through `ff` and `snapshot`: no competitor can take it
// between the stages. It is released after the stage records any candidate outcome but `green`, after ff
// records `cas-stale`, `fingerprint-invalid` or `foreign-move`, and after snapshot records its outcome; ff and
// snapshot assert the unit's publication holds it. Recording first means a crash between the two leaves the
// slot to recovery, which keeps it exactly while the unit's decided next stage is ff or snapshot. Once green,
// ff and snapshot are mandatory chain stages that pause and stop wait for; before green, a pause or stop
// abandons the candidate (its suite killed or its lane wait cancelled: `interrupted`, the slot released).
//
//   candidate  holds `integration-slot` (last in lock order) under its publication; each suite lane
//              reserves its own resources inside the series (the one hold-and-wait, A1), and a red suite
//              lane goes through the red-lane protocol (redlane.ts). `planCandidate` (transient check, merge-tree,
//              prefix guard) → `candidate.merge` onto the current tip T → the candidate checkout, detached
//              (`candidateWorktreeRequest`) → the plan's suite, serially and verbatim. Outcomes:
//              - a transient violation or prefix collision: refused, a scope-growth fix round (C, trigger);
//              - a conflict: `mergein.prepare` in the unit worktree (MERGE_HEAD = T), then the resolve
//                round; uncharged, and the diff base is recomputed (T), so the unit is gated again;
//              - red (or a suite that dirtied the checkout): the suite runs again on T alone in its own
//                detached checkout: red there too → `base-red` (uncharged), else a fix round (C);
//              - green → ff.
//   ff         the approval fingerprint recomputed at the tip being published onto; `planFf`, then
//              `integration.ff` by CAS under the publication's slot. published → snapshot · the tip advanced with the
//              approval intact → a fresh candidate, no new gate · the approval no longer holds → re-gate
//              · integration rewound or an executor-owned ref moved by another → stop, needs-user.
//   snapshot   `snapshot.publish` of the run's records at the journal's high-water mark (the ff done
//              is below it), then the unit retires (unit.ts).
//
// Every checkout a series creates here is removed before the stage records its outcome, citing the
// series' evidence snapshot; the unit's branch and the candidate ref stay.
//
// Re-entry: a stage attempt a restart cut short runs again as a new attempt. A merge-in it already
// prepared (MERGE_HEAD = T in the unit worktree) and a publication op it already closed are read back
// from the journal rather than repeated.
import { join } from 'node:path';
import type { IntentOf, OpOutcome } from '../core/events.ts';
import { INTEGRATION_SLOT, type ResourceInstance, type Sha, type UnitId } from '../core/ids.ts';
import type { ApprovalFingerprint, NeedsUserContent } from '../core/records.ts';
import { type AbsPath, absPath, branchRef } from '../core/values.ts';
import { type CandidateDecision, type CandidateRequest, candidateRef, candidateWorktreeRequest, planCandidate } from '../git/candidate.ts';
import { planFf } from '../git/ff.ts';
import { classifyMergein } from '../git/mergein.ts';
import type { WorktreeCreateRequest } from '../git/worktree.ts';
import type { PlanUnit } from '../input/plan.ts';
import type { FixRound } from '../prompts/inputs.ts';
import { reentryRecommendation } from '../needsuser.ts';
import { type PublicationHolder, type Reservation, cleanup, entryOf, heldReservation, resourceTable, run } from '../resources/reserve.ts';
import type { ResourceRequest } from '../schedule/types.ts';
import {
  type Cancelled, type StageContext, type StageParent, enter, evidenceRoot, isCancelled, runOp, runPrepared, unitBranch, unitWorktree,
} from './dispatch.ts';
import { fingerprintHolds, fingerprintValid, unitTip } from './gate.ts';
import { type Series, laneRuntime, removeVerificationTree, runLaneSeries, seriesOrder } from './lanes.ts';
import { type StageDone, at, executorIdentity, failedFacts, keptSpecPath, latestMergein, loadUnitSpec, record, start } from './stages.ts';
import { candidateMergeOp, integrationFfOp, mergeinOp, snapshotPublishOp } from '../recover/ops.ts';

export const candidateWorktree = (root: AbsPath, arc: string, unit: UnitId, attempt: number): AbsPath =>
  absPath(join(root, arc, `${unit}.candidate-${attempt}`));
const baseWorktree = (root: AbsPath, arc: string, unit: UnitId, attempt: number): AbsPath =>
  absPath(join(root, arc, `${unit}.base-${attempt}`));

/** The approval the candidate and ff stages publish under; the table reaches them only after a gate approved. */
function approvalOf(ctx: StageContext, unit: UnitId): ApprovalFingerprint {
  const approval = ctx.journal.view.unit(unit).approval;
  if (approval === null) throw new Error(`unit ${unit} reached the integration slot without an approval`);
  return approval.fingerprint;
}

// ---------------------------------------------------------------------------------------------------
// The publication (A2)

/** What a publication reserves: `integration-slot`, alone. */
export const PUBLICATION: ResourceRequest = { named: [], pools: [], cpu: 0, publication: true };

/**
 * The slot as `unit`'s publication holds it, running: what ff and snapshot publish under. Throws when anything
 * else holds it, or it is not running: the publication never lapses between the candidate and the snapshot.
 */
export function heldPublication(ctx: StageContext, unit: UnitId): Reservation<'running', PublicationHolder> {
  const { status, pending } = entryOf(resourceTable(ctx.journal.view), INTEGRATION_SLOT);
  if (pending !== null || status.state !== 'running' || status.holder.type !== 'publication' || status.holder.unit !== unit) {
    throw new Error(`publication of ${unit}: ${INTEGRATION_SLOT} is ${status.state}${status.state === 'free' ? '' : ` under ${JSON.stringify(status.holder)}`}${pending === null ? '' : ` (${pending.op} open)`}, not running under the unit's publication`);
  }
  return heldReservation(ctx, status.holder, 'running');
}

/** Ends the publication: the slot released (it has no teardown, so its cleanup cannot fail). */
async function releasePublication(ctx: StageContext, held: Reservation<'running', PublicationHolder>, parent: StageParent): Promise<void> {
  const cleaned = await cleanup(ctx, held, parent);
  if (cleaned.kind !== 'released') throw new Error(`the integration slot of ${held.holder.unit} was not released: ${cleaned.kind}`);
}

// ---------------------------------------------------------------------------------------------------
// candidate

type CandidateEnd = Readonly<{
  kind: 'green' | 'transient-violation' | 'conflict' | 'red' | 'base-red' | 'blocked' | 'occupied' | 'cleanup-failed' | 'interrupted';
  needsUser: NeedsUserContent | null;
  /** The instances a suite lane's cleanup failed (`cleanup-failed`): the park's targets. */
  failed: readonly ResourceInstance[];
}>;

const ended = (kind: CandidateEnd['kind'], needsUser: NeedsUserContent | null = null): CandidateEnd => ({ kind, needsUser, failed: [] });

function candidateRequest(ctx: StageContext, unit: PlanUnit, attempt: number): CandidateRequest {
  const { spec } = loadUnitSpec(ctx, unit);
  return {
    arc: ctx.plan().arc, unit: unit.id, integration: branchRef(ctx.plan().integrationBranch), unitCommit: unitTip(ctx, unit.id),
    worktree: candidateWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, attempt),
    rules: { evidenceGlobs: [...new Set(spec.lanes.flatMap((l) => l.evidenceGlobs))].sort() },
    identity: executorIdentity(),
    message: `roadmap ${ctx.plan().arc}: candidate of unit ${unit.id}\n`,
  };
}

/** A series' end read as a candidate outcome, when it is not a product verdict (green or red). */
function seriesFault(series: Series): CandidateEnd | null {
  switch (series.end.kind) {
    case 'green':
    case 'red':
      return null;
    case 'blocked':
    case 'interrupted':
      return ended(series.end.kind);
    case 'cleanup-failed':
      return { kind: 'cleanup-failed', needsUser: null, failed: series.end.failed };
    case 'occupied':
      return ended('occupied', series.end.needsUser);
  }
}

/** Where a candidate attempt keeps the evidence of its suite on the candidate, and on the tip alone. */
export const candidateSeriesRoot = (runDir: AbsPath, parent: StageParent): AbsPath => absPath(join(evidenceRoot(runDir, parent), 'candidate'));
const baseSeriesRoot = (runDir: AbsPath, parent: StageParent): AbsPath => absPath(join(evidenceRoot(runDir, parent), 'base'));

/**
 * A suite series on `checkout`, its checkout removed afterwards (citing the series' evidence). Its lanes take
 * their own sets while the publication holds the slot (the one hold-and-wait, A1).
 */
async function suite(ctx: StageContext, parent: StageParent, checkout: WorktreeCreateRequest, root: AbsPath): Promise<Series> {
  const series = await runLaneSeries(ctx, parent, seriesOrder(ctx.plan().suite.lanes), 'suite', checkout, root, laneRuntime(ctx, parent.unit), false);
  if (series.tree !== null) await removeVerificationTree(ctx, series.tree, parent);
  return series;
}

/** A suite that did not pass, or that changed its checkout (never certified under a SHA). */
const failed = (series: Series): boolean => series.end.kind === 'red' || series.dirty.length > 0;

async function integrate(ctx: StageContext, unit: PlanUnit, parent: StageParent, decision: CandidateDecision): Promise<CandidateEnd> {
  switch (decision.kind) {
    case 'transient-violation':
    case 'prefix-collision':
      return ended('transient-violation');
    case 'conflict': {
      // Integration merged into the unit branch in its worktree: MERGE_HEAD = T, the conflicts left for the
      // resolve round. A merge-tree conflict of (T, unit) is a conflict of (unit, T), so this merge conflicts.
      // A restart that cut the stage short after the merge-in finds it prepared and does not merge again.
      const prepared = latestMergein(ctx, unit.id);
      if (prepared !== null && ctx.journal.view.doneOf(prepared.op) !== null && classifyMergein(prepared).kind === 'conflicted') return ended('conflict');
      await runOp(ctx.journal, mergeinOp(ctx.repo), `mergein:${unit.id}`, parent, {
        worktree: unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id), branch: unitBranch(ctx.plan().arc, unit.id),
        integration: branchRef(ctx.plan().integrationBranch), identity: executorIdentity(),
        message: `roadmap ${ctx.plan().arc}: merge ${ctx.plan().integrationBranch} into unit ${unit.id}\n`,
      });
      return ended('conflict');
    }
    case 'merge': {
      const op = candidateMergeOp(ctx.repo);
      const intent = await runPrepared(ctx.journal, op, `candidate:${unit.id}`, parent, await op.prepare(decision.plan));
      const onCandidate = await suite(ctx, parent, candidateWorktreeRequest(intent), candidateSeriesRoot(ctx.runDir, parent));
      const fault = seriesFault(onCandidate);
      if (fault !== null) return fault;
      if (!failed(onCandidate)) return ended('green');
      // Red on the candidate: the tip alone decides whose red it is.
      const tip = intent.expect.integrationTip;
      const alone = await suite(ctx, parent, { path: baseWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, parent.attempt), checkout: { type: 'detached', at: tip } }, baseSeriesRoot(ctx.runDir, parent));
      const baseFault = seriesFault(alone);
      if (baseFault !== null) return baseFault;
      if (!failed(alone)) return ended('red');
      return ended('base-red', baseRedNeedsUser(ctx, unit.id, tip, [candidateSeriesRoot(ctx.runDir, parent), baseSeriesRoot(ctx.runDir, parent)]));
    }
  }
}

/** `evidence`: the suite series on the candidate and on T alone. */
function baseRedNeedsUser(ctx: StageContext, unit: UnitId, tip: Sha, evidence: readonly AbsPath[]): NeedsUserContent {
  return {
    blocking: true,
    subject: { type: 'arc' },
    reason: 'base-red',
    summary: `The suite is red on ${ctx.plan().integrationBranch} at ${tip} alone, without unit ${unit}: the base is broken, not the unit. Merges halt; unit ${unit} is parked uncharged.`,
    recommendation: `Repair ${ctx.plan().integrationBranch} (or the suite), then acknowledge this item: merges resume. ${reentryRecommendation(unit, 'candidate', unitBranch(ctx.plan().arc, unit))}`,
    options: [],
    evidence,
  };
}

export async function candidate(ctx: StageContext, unit: PlanUnit): Promise<StageDone<'candidate'> | Cancelled> {
  const parent = at(start(ctx, unit.id, 'candidate'), 'candidate');
  const approved = approvalOf(ctx, unit.id);
  const request = candidateRequest(ctx, unit, parent.attempt);
  if (approved.unitCommit !== request.unitCommit) throw new Error(`candidate of ${unit.id}: the approval binds ${approved.unitCommit}, the branch is at ${request.unitCommit}`);
  const holder: PublicationHolder = { type: 'publication', unit: unit.id, attempt: parent.attempt };
  const entered = await enter(ctx, holder, PUBLICATION);
  if (isCancelled(entered)) return entered;
  // The slot declares no probe: nothing can occupy it.
  const held = run(ctx, heldReservation(ctx, holder, 'reserved'), parent);
  const end = await integrate(ctx, unit, parent, planCandidate(ctx.repo, request));
  const done = record(ctx, parent, end.kind, end.needsUser, failedFacts(end.failed));
  if (end.kind !== 'green') await releasePublication(ctx, held, parent);
  return done;
}

/** The unit's latest done candidate.merge: the commit its suite tested. */
export function latestCandidate(ctx: StageContext, unit: UnitId): IntentOf<'candidate.merge'> {
  const ref = candidateRef(ctx.plan().arc, unit);
  const intent = ctx.journal.view.opsOf('candidate.merge').filter((i) => i.expect.ref === ref && ctx.journal.view.doneOf(i.op) !== null).at(-1);
  if (intent === undefined) throw new Error(`unit ${unit} has no done candidate`);
  return intent;
}

/**
 * The executor's directive for the fix round after a refused candidate: what the transient check (or the
 * prefix guard) refuses at the current tip, re-derived from git, since the refusal is a pure function of
 * the tip and the unit commit.
 */
export function candidateRefusalFix(ctx: StageContext, unit: PlanUnit): FixRound {
  const decision = planCandidate(ctx.repo, candidateRequest(ctx, unit, 0));
  switch (decision.kind) {
    case 'transient-violation':
      return { failingEvidenceDirs: [], directives: [`The candidate merge was refused: these paths must not reach integration (run state, evidence, executor files or .roadmap/ outside its published entries): ${decision.violations.map((v) => `${v.path} (${v.rule})`).join(', ')}. Remove them from the branch.`] };
    case 'prefix-collision':
      return { failingEvidenceDirs: [], directives: [`The candidate merge was refused: these new paths collide, ignoring case, with existing ones: ${decision.collisions.map((c) => `${c.path} with ${c.existing}`).join(', ')}. Rename them.`] };
    case 'conflict':
    case 'merge':
      return { failingEvidenceDirs: [], directives: ['The candidate merge was refused by the transient check at an earlier integration tip, and passes at the current one. Change nothing unless a fast lane fails, and report.'] };
  }
}

// ---------------------------------------------------------------------------------------------------
// ff

function foreignMoveNeedsUser(ctx: StageContext, unit: UnitId, detail: string): NeedsUserContent {
  return {
    blocking: true,
    subject: { type: 'arc' },
    reason: 'foreign-ref-move',
    summary: `Publication of unit ${unit} stopped: ${detail}. Integration only moves forward, and only the executor moves its refs.`,
    recommendation: `Find out who moved it; restore ${ctx.plan().integrationBranch} (or the ref) to a descendant of what the executor published, then acknowledge.`,
    options: [],
    evidence: [],
  };
}

export async function ff(ctx: StageContext, unit: PlanUnit): Promise<StageDone<'ff'>> {
  const held = heldPublication(ctx, unit.id);
  const done = await publish(ctx, unit);
  // Published: the slot stays the publication's through snapshot. Any other outcome ends it.
  if (done.outcome.kind !== 'published') await releasePublication(ctx, held, { type: 'stage', unit: unit.id, stage: 'ff', attempt: done.attempt });
  return done;
}

async function publish(ctx: StageContext, unit: PlanUnit): Promise<StageDone<'ff'>> {
  const parent = at(start(ctx, unit.id, 'ff'), 'ff');
  const fingerprint = approvalOf(ctx, unit.id);
  const cand = latestCandidate(ctx, unit.id);
  const integration = branchRef(ctx.plan().integrationBranch);
  const holds = (tip: Sha): boolean => fingerprintHolds(ctx, unit, fingerprint, tip);
  const stale = (tip: Sha): StageDone<'ff'> => record(ctx, parent, holds(tip) ? 'cas-stale' : 'fingerprint-invalid');
  const closed = (outcome: OpOutcome['integration.ff']): StageDone<'ff'> => {
    switch (outcome.kind) {
      case 'published':
        return record(ctx, parent, 'published');
      case 'unpublished':
        return stale(outcome.tip);
      case 'recovery-required':
        return record(ctx, parent, 'foreign-move', foreignMoveNeedsUser(ctx, unit.id, `${integration} is at ${outcome.observed ?? 'nothing'} after the publication CAS`));
    }
  };

  // A restart that cut the stage short after the publication op closed (live, or by recovery) reads it back.
  const earlier = ctx.journal.view.opsOf('integration.ff').filter((i) => i.expect.new === cand.post.new).at(-1);
  const earlierDone = earlier === undefined ? null : ctx.journal.view.doneOf(earlier.op);
  if (earlierDone !== null && earlierDone.kind === 'integration.ff') return closed(earlierDone.outcome);

  const decision = planFf(ctx.repo, { integration, candidate: cand, fingerprint });
  switch (decision.kind) {
    case 'foreign-mover':
      return record(ctx, parent, 'foreign-move', foreignMoveNeedsUser(ctx, unit.id, `${decision.ref} is at ${decision.observed ?? 'nothing'}, expected ${decision.expected}`));
    case 'unpublished':
      return stale(decision.tip);
    case 'ff': {
      if (!holds(cand.expect.integrationTip)) return record(ctx, parent, 'fingerprint-invalid');
      const op = integrationFfOp(ctx.repo, fingerprintValid(ctx, unit));
      const intent = await runPrepared(ctx.journal, op, `integration:${ctx.plan().arc}`, parent, decision.body);
      const done = ctx.journal.view.doneOf(intent.op);
      if (done === null || done.kind !== 'integration.ff') throw new Error(`integration.ff ${intent.op} has no done record`);
      return closed(done.outcome);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// snapshot

export async function snapshot(ctx: StageContext, unit: PlanUnit): Promise<StageDone<'snapshot'>> {
  const held = heldPublication(ctx, unit.id);
  const parent = at(start(ctx, unit.id, 'snapshot'), 'snapshot');
  await runOp(ctx.journal, snapshotPublishOp(ctx.repo), `snapshot:${ctx.plan().arc}`, parent, {
    arc: ctx.plan().arc,
    runDir: ctx.runDir,
    // Everything durable so far, the ff's done included.
    highWater: ctx.journal.view.highWater(),
    // The specs in force (kept by hash), never the live files, which may hold edits nobody applied.
    specs: ctx.plan().units.map((u) => ({ unit: u.id, path: keptSpecPath(ctx, u) })),
    identity: executorIdentity(),
    message: `roadmap ${ctx.plan().arc}: snapshot after publishing unit ${unit.id}\n`,
  });
  const done = record(ctx, parent, 'published');
  await releasePublication(ctx, held, parent);
  return done;
}
