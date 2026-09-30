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
//              - green → in a holistic arc, the held-claims brake (M3 B2, below): the arc lanes witnessing the
//                obligations the approval selects run on the candidate as journey lanes; red claims take the same
//                path, witnessing T alone (`base-red`, `red`, or green by the known-regression rule);
//              - green → ff.
//   ff         the approval fingerprint recomputed at the tip being published onto; `planFf`, then
//              `integration.ff` by CAS under the publication's slot. published → the latches (M3: a future obligation
//              the unit completes and that holds on its candidate, `latchPublished`) → snapshot · the tip advanced with the
//              approval intact → a fresh candidate, no new gate · the approval no longer holds → re-gate
//              · integration rewound or an executor-owned ref moved by another → stop, needs-user.
//   snapshot   `snapshot.publish` of the run's records at the journal's high-water mark (the ff done
//              is below it), then the unit retires (unit.ts).
//
// Every checkout a series creates here is removed before the stage records its outcome, citing the
// series' evidence snapshot; the unit's branch and the candidate ref stay.
//
// Preemption (M3, A7): a docs publication (publish.ts) outranks every unit publication. While the slot is held by a
// candidate that has not recorded green, the publication asks it to abandon (`preemptCandidate`): its suite lanes are
// killed with reason `preempt` (and any lane it starts after is killed at once), and the stage records `preempted`,
// uncharged, releasing the slot; the unit's next candidate waits behind the docs publication. Once green, the ff ->
// snapshot chain completes first and the docs publication waits for its release.
//
// Eligibility (G10): an active P1 finding over an obligation the unit's approval selects (its fingerprint's
// `obligationRevs`), which its spec does not repair, blocks publication (`findingBlocking`). Re-checked under the slot
// before a candidate records green (-> `finding-blocked`, uncharged), immediately before the unit's `ff` intent (the
// frozen `ff` vocabulary has no `finding-blocked`: -> `cas-stale`, whose fresh candidate records it), and in recovery's
// `ff` redo (`unitRedo`: a blocked unit's CAS is not redone).
//
// Re-entry: a stage attempt a restart cut short runs again as a new attempt. A merge-in it already
// prepared (MERGE_HEAD = T in the unit worktree) and a publication op it already closed are read back
// from the journal rather than repeated.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, OpOutcome, Parent } from '../core/events.ts';
import { canonicalJson } from '../core/json.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import { type FindingId, INTEGRATION_SLOT, type JobId, type LaneId, type ObligationId, type ResourceInstance, type Sha, type UnitId, invocationId } from '../core/ids.ts';
import { type ApprovalFingerprint, type NeedsUserContent, obligationRevsOf, specRepairs } from '../core/records.ts';
import { type AbsPath, absPath, branchRef } from '../core/values.ts';
import { type CandidateDecision, type CandidateRequest, candidateRef, candidateWorktreeRequest, planBatchCandidate, planCandidate } from '../git/candidate.ts';
import { planBatchFf, planFf } from '../git/ff.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import { revParse } from '../git/git.ts';
import { snapshotRequestOf } from '../git/snapshot.ts';
import { unitTransientRules } from '../git/transient.ts';
import { classifyMergein } from '../git/mergein.ts';
import type { WorktreeCreateRequest } from '../git/worktree.ts';
import { keyOf, observedVerdict, reuse, verdictOf } from '../holistic/observe.ts';
import { type ObligationEffect, completes, latches, obligationEffects } from '../holistic/table.ts';
import { type ArcLaneDef, type ObligationDef, type Obligations, type ObservationVerdict, type WitnessRef, isExempt } from '../holistic/types.ts';
import type { PlanUnit } from '../input/plan.ts';
import type { FixRound } from '../prompts/inputs.ts';
import { reentryRecommendation } from '../needsuser.ts';
import { runnerFiles } from '../runner/files.ts';
import { invocationDir, killWorkload } from './invoke.ts';
import {
  type BatchHolder, type PublicationHolder, type Reservation, type ResourceContext, cleanup, entryOf, finishCleanup, heldReservation, resourceTable, run, sameHolder,
} from '../resources/reserve.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import type { ResourceRequest } from '../schedule/types.ts';
import {
  type Cancelled, type StageContext, type StageParent, dispatchOf, enter, evidenceRoot, isCancelled, runOp, runPrepared, unitBranch, unitWorktree,
} from './dispatch.ts';
import { fingerprintHolds, fingerprintValid, selected, unitTip } from './gate.ts';
import {
  type JourneyEnd, type JourneyRun, type JourneySeries, type Series, arcJourneyLane, intact, journeyRed, laneEnvId, laneRuntime, observations, removeJobCheckouts,
  removeVerificationTree, runJourneySeries, runLaneSeries, seriesOrder, suiteJourneyLane,
} from './lanes.ts';
import { type StageDone, at, executorIdentity, failedFacts, holisticInForce, latestMergein, loadUnitSpec, record, start } from './stages.ts';
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
  kind: 'green' | 'transient-violation' | 'conflict' | 'red' | 'base-red' | 'blocked' | 'occupied' | 'cleanup-failed' | 'interrupted' | 'preempted' | 'finding-blocked';
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
    rules: unitTransientRules(dispatchOf(ctx.journal.view, unit.id), [...new Set(spec.lanes.flatMap((l) => l.evidenceGlobs))].sort()),
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
      return ended('blocked');
    case 'interrupted':
      return ended(series.end.reason === 'preempt' ? 'preempted' : 'interrupted');
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
  if (ctx.signal.reason === 'preempt') return ended('preempted');
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
      if (ctx.signal.reason === 'preempt') return ended('preempted');
      const onCandidate = await suite(ctx, parent, candidateWorktreeRequest(intent), candidateSeriesRoot(ctx.runDir, parent));
      const fault = seriesFault(onCandidate);
      if (fault !== null) return fault;
      if (!failed(onCandidate)) return heldClaims(ctx, unit, parent, intent);
      if (ctx.signal.reason === 'preempt') return ended('preempted');
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
  const preempt = preemptible(ctx, unit.id, parent);
  let end: CandidateEnd;
  try {
    end = await integrate(preempt.ctx, unit, parent, planCandidate(ctx.repo, request));
    // Before green is recorded: a preemption that arrived after the last lane still wins (A7), and an active P1 over
    // a selected obligation blocks it (G10).
    if (end.kind === 'green' && preempt.ctx.signal.reason === 'preempt') end = ended('preempted');
    if (end.kind === 'green' && findingBlocking(ctx, unit) !== null) end = ended('finding-blocked');
  } finally {
    await preempt.close();
  }
  const done = record(ctx, parent, end.kind, end.needsUser, failedFacts(end.failed));
  if (end.kind !== 'green') await releasePublication(ctx, held, parent);
  return done;
}

// ---------------------------------------------------------------------------------------------------
// The held-claims brake (M3 B2; DESIGN-1.0.md §2.8; plan "Journey lanes and the held-claims brake")

/** What a candidate is graded against: the obligations in force, its selection, its completions and its declared repairs. */
export type Claims = Readonly<{
  obligations: Obligations;
  /** The candidate's selection, split closure applied (`selectObligations`). */
  selected: ReadonlySet<ObligationId>;
  /** Future obligations (not latched) whose `deliveredBy` the candidate completes. */
  completing: ReadonlySet<ObligationId>;
  /** The obligations its units' specs declare they repair (a finding repair: its finding's obligation). */
  repairs: ReadonlySet<ObligationId>;
  latched: ReadonlySet<ObligationId>;
  /** The arc lanes witnessing the selected, non-exempt obligations, in the file's lane order. */
  lanes: readonly ArcLaneDef[];
}>;

/** The obligations a unit's spec repairs: its `I-n` repairs, and the obligation of each finding it repairs. */
export function repairedObligations(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; planDir: AbsPath }>, unit: PlanUnit): ReadonlySet<ObligationId> {
  const findings = ctx.journal.view.holistic().findings;
  return new Set(specRepairs(loadUnitSpec(ctx, unit).spec).flatMap((r): ObligationId[] => {
    if (r.startsWith('I-')) return [r as ObligationId];
    const o = findings.find((f) => f.id === r)?.obligation ?? null;
    return o === null ? [] : [o];
  }));
}

/** The latched obligations: must-hold from their latch on. */
const latchedSet = (view: JournalView): ReadonlySet<ObligationId> => new Set(view.holistic().latched.map((l) => l.obligation));

/**
 * The claims of a candidate publishing `units` (one unit, or a batch's members) with selection `selected` over the
 * obligations in force; null outside a holistic arc with obligations.
 */
export function claimsOf(
  ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>, obligations: Obligations | null, units: readonly UnitId[],
  selected: readonly ObligationId[], repairs: ReadonlySet<ObligationId>,
): Claims | null {
  if (obligations === null) return null;
  const view = ctx.journal.view;
  const latched = latchedSet(view);
  const published = new Set(view.publications().map((p) => p.unit));
  const chosen = new Set(selected);
  const completing = new Set(obligations.obligations.filter((o) => o.activation === 'future' && !latched.has(o.id) && !isExempt(o) && completes(o, published, units)).map((o) => o.id));
  const needed = new Set(obligations.obligations.flatMap((o) => (chosen.has(o.id) && !isExempt(o) && o.witness !== null ? [o.witness.lane] : [])));
  return { obligations, selected: chosen, completing, repairs, latched, lanes: obligations.lanes.filter((l) => needed.has(l.id)) };
}

/** A unit candidate's claims at tip `tip` for its approved commit `head` (`selected`, gate.ts: what its approval selects). */
function unitClaims(ctx: StageContext, unit: PlanUnit, tip: Sha, head: Sha): Claims | null {
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) return null;
  return claimsOf(ctx, obligations, [unit.id], selected(ctx, unit, tip, head).map((o) => o.id), repairedObligations(ctx, unit));
}

/** Active P1 findings' obligations: what the known-regression rule reads (R4, G11). */
function p1Obligations(view: JournalView): ReadonlySet<ObligationId> {
  return new Set(view.holistic().findings.flatMap((f) => (f.severity === 'P1' && ACTIVE_FINDING.has(f.state) && f.obligation !== null ? [f.obligation] : [])));
}

/** How the claims grade on one tree. */
export type TreeGrade = Readonly<{
  effects: ReadonlyMap<ObligationId, ObligationEffect>;
  /** Selected obligations whose effect is `red` (the brake), and declared repairs not shown held: never excused. */
  red: readonly ObligationId[];
  /**
   * Failing tests the known-regression rule may excuse (background failures, G11), per lane: in the witness of an
   * unselected must-hold obligation over which an active P1 is open.
   */
  background: ReadonlyMap<LaneId, readonly string[]>;
  /** Lanes that ran red with a failure nothing explains: a failing test no obligation or P1 accounts for, or no failing test at all. */
  unexplained: readonly LaneId[];
  /** The checkout was still the commit after the lanes (nothing dirty, HEAD not moved): a tree that changed is never certified. */
  intact: boolean;
}>;

/**
 * The claims graded on the records of one tree (`runs`, a journey series on it), with `completing` and `repairs` as the
 * tree has them (the tip alone completes and repairs nothing). A failing test of a future obligation not yet latched,
 * or of an exempt one, is measured, never graded.
 */
export function gradeTree(
  claims: Claims, runs: readonly JourneyRun[], completing: ReadonlySet<ObligationId>, repairs: ReadonlySet<ObligationId>, p1: ReadonlySet<ObligationId>,
): TreeGrade {
  const records = new Map(runs.flatMap((r) => (r.record === null ? [] : [[r.lane, r.record] as const])));
  const defs = claims.obligations.obligations;
  const verdict = (_o: ObligationDef, w: WitnessRef): ObservationVerdict | null => {
    const rec = records.get(w.lane);
    return rec === undefined ? null : verdictOf(rec, w);
  };
  const effects = obligationEffects({ obligations: defs, selected: claims.selected, latched: claims.latched, completing, verdict });
  const mustHold = (o: ObligationDef): boolean => o.activation === 'must-hold' || claims.latched.has(o.id);
  const red = new Set([...claims.selected].filter((id) => effects.get(id) === 'red'));
  for (const id of repairs) {
    const o = defs.find((d) => d.id === id);
    if (o === undefined) throw new Error(`repaired obligation ${id} is not in force`);
    if (isExempt(o)) continue;
    const held = o.state.type === 'split' ? effects.get(id) === 'discharged' : o.witness !== null && verdict(o, o.witness) === 'held';
    if (!held) red.add(id);
  }
  const background = new Map<LaneId, string[]>();
  const unexplained = new Set<LaneId>();
  for (const r of runs) {
    if (r.record === null) continue;
    const failing = r.record.records.filter((t) => t.outcome === 'fail').map((t) => t.testId);
    if (r.record.malformed || failing.length === 0) {
      if (journeyRed(r)) unexplained.add(r.lane);
      continue;
    }
    for (const t of failing) {
      const owners = defs.filter((o) => o.witness !== null && o.witness.lane === r.lane && o.witness.testIds.includes(t));
      if (owners.length === 0) {
        unexplained.add(r.lane);
        continue;
      }
      const live = owners.filter((o) => !isExempt(o) && mustHold(o));
      // A selected must-hold obligation's failing test is the brake's, never excused; an exempt or measured one's is not graded.
      if (live.length === 0 || live.some((o) => claims.selected.has(o.id))) continue;
      if (live.some((o) => p1.has(o.id))) background.set(r.lane, [...(background.get(r.lane) ?? []), t]);
      else unexplained.add(r.lane);
    }
  }
  return {
    effects, red: [...red].sort(), unexplained: [...unexplained].sort(), intact: true,
    background: new Map([...background].map(([lane, tests]) => [lane, [...new Set(tests)].sort()] as const)),
  };
}

const clean = (g: TreeGrade): boolean => g.intact && g.red.length === 0 && g.unexplained.length === 0 && g.background.size === 0;

/**
 * A non-clean candidate grade read against the tip alone's (the red-suite path): a blocking failure (a brake red, a
 * repair not held, an unexplained lane, a checkout the lanes changed) that the tip reproduces → `base-red`, else `red` (charged). An obligation the
 * candidate declares it repairs is known not to hold on the tip: its red is the candidate's (`red`), never the base's.
 * Background failures only: the tip failing exactly those tests on each lane → `green` (known regression, R4, G11); the
 * tip failing none of them → `red`; anything else → `base-red`.
 */
export function brakeVerdict(candidate: TreeGrade, tip: TreeGrade, repairs: ReadonlySet<ObligationId>): 'green' | 'red' | 'base-red' {
  if (!candidate.intact || candidate.red.length > 0 || candidate.unexplained.length > 0) {
    const reproduced = (!candidate.intact && !tip.intact) || candidate.red.some((id) => !repairs.has(id) && tip.red.includes(id))
      || candidate.unexplained.some((l) => tip.unexplained.includes(l));
    return reproduced ? 'base-red' : 'red';
  }
  const lanes = [...candidate.background.keys()];
  if (lanes.every((l) => canonicalJson(tip.background.get(l) ?? []) === canonicalJson(candidate.background.get(l)))) return 'green';
  if (lanes.every((l) => !tip.background.has(l) && !tip.unexplained.includes(l))) return 'red';
  return 'base-red';
}

export const journeyWorktree = (root: AbsPath, arc: string, owner: string, which: 'journey' | 'base-journey', attempt: number): AbsPath =>
  absPath(join(root, arc, `${owner}.${which}-${attempt}`));
/**
 * Where a candidate attempt keeps its journey lanes' evidence, on the candidate and on the tip alone: one dir per
 * execution under it (src/git/snapshot.ts `candidateLaneDir`).
 */
export const journeyRoot = (runDir: AbsPath, parent: StageParent): AbsPath => absPath(join(evidenceRoot(runDir, parent), 'journey'));

/** A journey series' end read as a candidate outcome, when it has no verdict. */
function journeyFault(end: JourneyEnd): CandidateEnd | null {
  switch (end.kind) {
    case 'ran':
      return null;
    case 'blocked':
      return ended('blocked');
    case 'interrupted':
      return ended(end.reason === 'preempt' ? 'preempted' : 'interrupted');
    case 'cleanup-failed':
      return { kind: 'cleanup-failed', needsUser: null, failed: end.failed };
    case 'occupied':
      return ended('occupied', end.needsUser);
  }
}

/**
 * After a green suite: the arc lanes witnessing the candidate's selected obligations, on the candidate, under the
 * unit's stage holder. Clean → green. Otherwise the tip alone is witnessed with the same lanes and `brakeVerdict`
 * decides: `red` (a fix round, charged), `base-red`, or green by the known-regression rule.
 */
async function heldClaims(ctx: StageContext, unit: PlanUnit, parent: StageParent, intent: IntentOf<'candidate.merge'>): Promise<CandidateEnd> {
  const tip = intent.expect.integrationTip;
  const claims = unitClaims(ctx, unit, tip, intent.expect.unitCommit);
  if (claims === null || claims.selected.size === 0) return ended('green');
  const owner = { type: 'unit', parent, rt: laneRuntime(ctx, unit.id) } as const;
  const lanes = claims.lanes.map(arcJourneyLane);
  const root = ctx.plan().worktreeRoot;
  const onCandidate = await runJourneySeries(ctx, owner, lanes, {
    path: journeyWorktree(root, ctx.plan().arc, unit.id, 'journey', parent.attempt), checkout: { type: 'detached', at: intent.post.new },
  }, { reuse: true, stop: () => false });
  const fault = journeyFault(onCandidate.end);
  if (fault !== null) return fault;
  const p1 = p1Obligations(ctx.journal.view);
  const grade = { ...gradeTree(claims, onCandidate.runs, claims.completing, claims.repairs, p1), intact: intact(onCandidate) };
  if (clean(grade)) return ended('green');
  if (ctx.signal.reason === 'preempt') return ended('preempted');
  const alone = await runJourneySeries(ctx, owner, lanes, {
    path: journeyWorktree(root, ctx.plan().arc, unit.id, 'base-journey', parent.attempt), checkout: { type: 'detached', at: tip },
  }, { reuse: true, stop: () => false });
  const baseFault = journeyFault(alone.end);
  if (baseFault !== null) return baseFault;
  switch (brakeVerdict(grade, { ...gradeTree(claims, alone.runs, new Set(), new Set(), p1), intact: intact(alone) }, claims.repairs)) {
    case 'green':
      return ended('green');
    case 'red':
      return ended('red');
    case 'base-red':
      return ended('base-red', baseRedNeedsUser(ctx, unit.id, tip, [
        candidateSeriesRoot(ctx.runDir, parent), journeyRoot(ctx.runDir, parent),
      ]));
  }
}

/**
 * The fix round after a candidate whose suite was green and whose held claims were red (the brake): the obligations it
 * left red on the candidate (re-graded from the observations its journey lanes left), with the journey evidence.
 */
export function candidateBrakeFix(ctx: StageContext, unit: PlanUnit, parent: StageParent): FixRound {
  const cand = latestCandidate(ctx, unit.id);
  const claims = unitClaims(ctx, unit, cand.expect.integrationTip, cand.expect.unitCommit);
  if (claims === null) throw new Error(`unit ${unit.id}: a red candidate with a green suite outside a holistic arc`);
  const runs = observedRuns(ctx, claims, cand.post.new);
  const grade = gradeTree(claims, runs, claims.completing, claims.repairs, p1Obligations(ctx.journal.view));
  const byId = new Map(claims.obligations.obligations.map((o) => [o.id, o]));
  const directives = [
    ...grade.red.map((id) => {
      const o = byId.get(id)!;
      const tests = o.witness === null ? 'its split children' : `lane ${o.witness.lane}, tests ${o.witness.testIds.join(', ')}`;
      return `Obligation ${id} must hold on the candidate and does not (${grade.effects.get(id) ?? 'red'}): "${o.statement}" (witness: ${tests}). Make it hold without weakening its witness.`;
    }),
    ...grade.unexplained.map((lane) => `Journey lane ${lane} ran red on the candidate with a failure no obligation explains; read its output and fix the regression.`),
    ...[...grade.background].map(([lane, tests]) => `Journey lane ${lane}: tests ${tests.join(', ')} fail on the candidate but not on the integration tip alone; the change regressed them.`),
  ];
  const root = journeyRoot(ctx.runDir, parent);
  return { failingEvidenceDirs: existsSync(root) ? [root] : [], directives: directives.length > 0 ? directives : ['The candidate\'s held claims were red; read the journey evidence and fix it.'] };
}

/** The claims' lanes as the observations on `commit`'s tree record them (a lane with none reads as not run). */
function observedRuns(ctx: StageContext, claims: Claims, commit: Sha): readonly JourneyRun[] {
  const tree = revParse(ctx.repo, `${commit}^{tree}`);
  const store = observations(ctx);
  return claims.lanes.flatMap((l) => {
    const o = reuse(store, keyOf(tree, l, laneEnvId(ctx, l)));
    return o === null ? [] : [{ lane: l.id, inv: o.record.inv, verdict: null, flaky: false, dir: null, record: o.record }];
  });
}

/**
 * Latching (plan "Latching"; §2.8): after `ff{published}` of `commit` publishing `units`, and before the snapshot, an
 * `obligation-latched` for each future obligation the publication completes and that holds on its tree (the `latch`
 * effect), where missing. From then on it is must-hold. A restart that re-reads the published ff writes what is missing.
 */
export function latchPublished(
  ctx: Readonly<{ journal: Journal; runDir: AbsPath; repo: AbsPath; hostEnv: Readonly<Record<string, string | undefined>> }>, units: readonly UnitId[], commit: Sha,
): void {
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) return;
  const view = ctx.journal.view;
  const latched = latchedSet(view);
  const published = new Set(view.publications().map((p) => p.unit));
  const completing = new Set(obligations.obligations.filter((o) => o.activation === 'future' && !latched.has(o.id) && !isExempt(o) && completes(o, published, units)).map((o) => o.id));
  if (completing.size === 0) return;
  const tree = revParse(ctx.repo, `${commit}^{tree}`);
  const store = observations(ctx);
  const lanes = new Map(obligations.lanes.map((l) => [l.id, l]));
  const effects = obligationEffects({
    obligations: obligations.obligations, selected: completing, latched, completing,
    verdict: (_o, w) => {
      const lane = lanes.get(w.lane);
      if (lane === undefined) throw new Error(`witness lane ${w.lane} is not in the obligations in force`);
      return observedVerdict(store, keyOf(tree, lane, laneEnvId(ctx, lane)), w);
    },
  });
  const ids = latches(effects).filter((id) => completing.has(id));
  if (ids.length === 0) return;
  for (const id of ids) {
    const o = obligations.obligations.find((d) => d.id === id)!;
    const unit = units.find((u) => o.deliveredBy.includes(u));
    if (unit === undefined) throw new Error(`obligation ${id} latches, but none of ${units.join(', ')} delivers it`);
    ctx.journal.fact({ kind: 'obligation-latched', obligation: id, unit, treeSha: tree });
  }
  crashPoint('latch.after-fact');
}

// ---------------------------------------------------------------------------------------------------
// Preemption (A7)

/** The candidates that hold the slot before green, by journal: what a docs publication may preempt. */
const preemptions = new WeakMap<Journal, Map<UnitId, AbortController>>();

/** How often a preempted candidate kills a lane it started after the preemption (the race of the first kill). */
const PREEMPT_POLL_MS = 100;

/**
 * Asks `unit`'s candidate, holding the slot before green, to abandon (A7). False when it has no such candidate (it
 * has not reached the slot yet, or it is past green): the caller asks again at its next wake.
 */
export function preemptCandidate(journal: Journal, unit: UnitId): boolean {
  const c = preemptions.get(journal)?.get(unit);
  if (c === undefined) return false;
  if (!c.signal.aborted) c.abort('preempt');
  return true;
}

type Preemptible = Readonly<{ ctx: StageContext; close: () => Promise<void> }>;

/**
 * Registers the candidate attempt for preemption and gives `ctx` a signal that a preemption also aborts (reason
 * `preempt`, so its lanes' waits end `interrupted{preempt}`). Once preempted, every lane of the attempt that is
 * running, or starts later, is killed with reason `preempt`. `close` unregisters it and awaits the kills.
 */
function preemptible(ctx: StageContext, unit: UnitId, parent: StageParent): Preemptible {
  let byUnit = preemptions.get(ctx.journal);
  if (byUnit === undefined) {
    byUnit = new Map();
    preemptions.set(ctx.journal, byUnit);
  }
  if (byUnit.has(unit)) throw new Error(`unit ${unit} has two candidates in the slot`);
  const controller = new AbortController();
  byUnit.set(unit, controller);
  const kills: Promise<void>[] = [];
  const killed = new Set<string>();
  let open = true;
  const sweep = (): void => {
    for (const intent of ctx.journal.view.openIntents()) {
      if (intent.kind !== 'proc.spawn' || canonicalJson(intent.parent) !== canonicalJson(parent)) continue;
      if (intent.expect.subject.purpose !== 'lane' && intent.expect.subject.purpose !== 'journey') continue;
      const inv = invocationId(intent.op, intent.ordinal);
      if (killed.has(inv)) continue;
      // A runner that has not written runner.json may not have exec'd yet: the next sweep finds it.
      const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
      if (files.read('runner.json') === null || files.read('exit.json') !== null) continue;
      killed.add(inv);
      kills.push(killWorkload(ctx, { inv, scope: 'invocation', reason: 'preempt' }));
    }
  };
  let looping: Promise<void> = Promise.resolve();
  controller.signal.addEventListener('abort', () => {
    looping = (async () => {
      while (open) {
        sweep();
        await new Promise((resolve) => setTimeout(resolve, PREEMPT_POLL_MS));
      }
    })();
  }, { once: true });
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  const map = byUnit;
  return {
    ctx: { ...ctx, signal },
    close: async () => {
      open = false;
      map.delete(unit);
      await looping;
      await Promise.all(kills);
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Eligibility (G10)

/** An active P1 finding that blocks a unit's publication, and the selected obligation it is over. */
export type FindingBlock = Readonly<{ finding: FindingId; obligation: ObligationId }>;

/** A finding is active until it is resolved or ruled. */
const ACTIVE_FINDING: ReadonlySet<string> = new Set(['open', 'owned', 'fixed-on-branch']);

/**
 * The first active P1 finding (by id) over an obligation the unit's approval selects that its spec does not repair
 * (a finding repair repairs its obligation), or null (G10). Read from the fold's findings, which B3 opens.
 */
export function findingBlocking(ctx: StageContext, unit: PlanUnit): FindingBlock | null {
  const approval = ctx.journal.view.unit(unit.id).approval;
  if (approval === null) throw new Error(`unit ${unit.id}: eligibility is checked only for an approved unit`);
  const selected = new Set(obligationRevsOf(approval.fingerprint).map((r) => r.id));
  if (selected.size === 0) return null;
  const findings = ctx.journal.view.holistic().findings;
  const repaired = repairedObligations(ctx, unit);
  for (const f of findings) {
    if (f.severity !== 'P1' || !ACTIVE_FINDING.has(f.state) || f.obligation === null) continue;
    if (selected.has(f.obligation) && !repaired.has(f.obligation)) return { finding: f.id, obligation: f.obligation };
  }
  return null;
}

/** The re-check recovery's `ff` redo takes (ops.ts `integrationFfOp`): the approval at the tip now, and eligibility. */
export function unitRedo(ctx: StageContext, unit: PlanUnit): (fingerprint: ApprovalFingerprint) => boolean {
  const valid = fingerprintValid(ctx, unit);
  return (fingerprint) => valid(fingerprint) && findingBlocking(ctx, unit) === null;
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
      return { failingEvidenceDirs: [], directives: [`The candidate merge was refused: these paths must not reach integration (run state, evidence, executor files, in-tree .roadmap/ paths, or paths outside the unit's pinned scope): ${decision.violations.map((v) => `${v.path} (${v.rule})`).join(', ')}. Remove them from the branch; if the work needs an out-of-scope path, say so in your report as a scope growth instead of keeping it.`] };
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
        // Latching (plan "Latching"): after ff{published}, before the snapshot; a restart re-reads the ff and writes what is missing.
        latchPublished(ctx, [unit.id], cand.post.new);
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
      // G10, immediately before the intent: a blocked unit does not publish; its fresh candidate records
      // `finding-blocked` (the frozen ff vocabulary has none of its own).
      if (findingBlocking(ctx, unit) !== null) return record(ctx, parent, 'cas-stale');
      const op = integrationFfOp(ctx.repo, unitRedo(ctx, unit));
      const intent = await runPrepared(ctx.journal, op, `integration:${ctx.plan().arc}`, parent, decision.body);
      const done = ctx.journal.view.doneOf(intent.op);
      if (done === null || done.kind !== 'integration.ff') throw new Error(`integration.ff ${intent.op} has no done record`);
      return closed(done.outcome);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// A repair batch's publication (M3 B2; R7, G5, H4; DESIGN-1.0.md §2.8 "Batch repair")
//
// All approved units repairing one finding publish as one candidate: `publishBatch` takes `integration-slot` under
// `batch{finding, attempt}` (first of every unit waiter, as a repair ranks first, R6) for the batch's durable job
// `batch-<n>` (one per finding until it publishes; each attempt reuses it), chains the members as `--no-ff` merges on
// the candidate ref (src/git/candidate.ts `planBatchCandidate`), and runs the plan's suite and the arc lanes of the
// members' selected obligations as a journey series under `job{batch-<n>}` (its residues job-owned, reclaimed by the
// job's own holder, G4). It grades like a unit candidate (the brake, known regressions, the tip alone); green, it
// re-checks every member's approval fingerprint at the tip and eligibility (G10), then `ff{subject: batch}`: the fold
// retires every member on that one ff. Then the latches, the snapshot, the slot released (`finishBatch`).
//
// Red: `red{attributable}` names the members whose own selection holds a red obligation (a fix round each), none when
// the red is not attributable (every member parks); the caller (the scheduler, step B7) records the members' outcomes.
//
// Recovery (src/recover/resource.ts): a batch holder found holding the slot whose ff published is left holding it, and
// `finishBatch` completes it; any other is abandoned (`abandonBatch`: its checkouts removed, the slot released). A batch
// ff's CAS is never redone (src/recover/ff.ts): the batch runs again as the next attempt of the same job.

export type BatchContext = StageContext & Readonly<{ acquireFirst: AcquireFirst }>;

export type BatchOutcome =
  | Readonly<{ kind: 'published'; job: JobId; head: Sha }>
  /** A member's diff failed the transient check, its merge conflicted, or the chain collides by case: that member's fix. */
  | Readonly<{ kind: 'refused'; job: JobId; unit: UnitId | null; reason: 'transient-violation' | 'conflict' | 'prefix-collision' }>
  | Readonly<{ kind: 'red'; job: JobId; attributable: readonly UnitId[] }>
  | Readonly<{ kind: 'base-red'; job: JobId; needsUser: NeedsUserContent }>
  /** A lane gave no verdict (blocked, occupied, a failed cleanup: job-owned residues): the batch runs again later. */
  | Readonly<{ kind: 'no-verdict'; job: JobId; end: JourneyEnd }>
  /** The tip advanced (a fresh batch), or these members' approvals no longer hold at the tip (each re-gates). */
  | Readonly<{ kind: 'stale'; job: JobId; invalid: readonly UnitId[] }>
  | Readonly<{ kind: 'finding-blocked'; job: JobId; unit: UnitId; block: FindingBlock }>
  | Readonly<{ kind: 'foreign-move'; job: JobId; needsUser: NeedsUserContent }>;

/** A batch's slot: `integration-slot` alone. */
const BATCH_SLOT: ResourceRequest = { named: [], pools: [], cpu: 0, publication: true };
/** A batch's waits are never cancelled: once begun it runs to its end. */
const NEVER = new AbortController().signal;

const batchCheckout = (root: AbsPath, arc: string, job: JobId, which: 'candidate' | 'base', attempt: number): AbsPath =>
  absPath(join(root, arc, `${job}.${which}-${attempt}`));

/** The batch reservations of `finding` (their `reserve` intents, log order): each attempt's holder and its job. */
function batchReserves(view: JournalView, finding: FindingId): readonly Readonly<{ holder: BatchHolder; job: JobId }>[] {
  return view.opsOf('resource.transition').flatMap((i) => {
    const h = i.expect.holder;
    if (h.type !== 'batch' || h.finding !== finding || i.expect.edge.type !== 'reserve') return [];
    if (i.parent.type !== 'job') throw new Error(`${i.op}: a batch reserve parented by ${canonicalJson(i.parent)}, not its job`);
    return [{ holder: h, job: i.parent.job }];
  });
}

/** The batch `ff` of `job`, if one was begun (the latest). */
const batchFfOf = (view: JournalView, job: JobId): IntentOf<'integration.ff'> | undefined =>
  view.opsOf('integration.ff').filter((i) => i.expect.subject?.type === 'batch' && i.expect.subject.job === job).at(-1);

/** Whether `job`'s batch `ff` published. */
function batchPublished(view: JournalView, job: JobId): boolean {
  const ff = batchFfOf(view, job);
  const done = ff === undefined ? null : view.doneOf(ff.op);
  return done !== null && done.kind === 'integration.ff' && done.outcome.kind === 'published';
}

/** The batch holder holding the slot now, and its job; null when the slot is not a batch's. */
export function heldBatch(view: JournalView): Readonly<{ holder: BatchHolder; job: JobId }> | null {
  const { status } = entryOf(resourceTable(view), INTEGRATION_SLOT);
  if (status.state === 'free' || status.holder.type !== 'batch') return null;
  const holder = status.holder;
  const found = batchReserves(view, holder.finding).find((r) => r.holder.attempt === holder.attempt);
  if (found === undefined) throw new Error(`${canonicalJson(holder)} holds ${INTEGRATION_SLOT} without a reserve intent`);
  return found;
}

/** The batch holder's slot released (it declares no teardown, so its cleanup cannot fail), from whatever state it is in. */
async function releaseBatch(ctx: ResourceContext, holder: BatchHolder, job: JobId): Promise<void> {
  const parent: Parent = { type: 'job', job };
  const { status, pending } = entryOf(resourceTable(ctx.journal.view), INTEGRATION_SLOT);
  if (pending !== null) throw new Error(`${job}: ${pending.op} is open on ${INTEGRATION_SLOT}`);
  if (status.state === 'free' || !sameHolder(status.holder, holder)) return;
  const cleaned = status.state === 'cleaning'
    ? await finishCleanup(ctx, { state: 'cleaning', holder, resources: [INTEGRATION_SLOT], recipes: new Map() }, parent)
    : await cleanup(ctx, heldReservation(ctx, holder, status.state === 'reserved' ? 'reserved' : 'running'), parent);
  if (cleaned.kind !== 'released') throw new Error(`the integration slot of ${job} was not released: ${cleaned.kind}`);
}

/** The done batch `candidate.merge` of `job` (the latest). */
function batchCandidateOf(view: JournalView, job: JobId): IntentOf<'candidate.merge'> {
  const intent = view.opsOf('candidate.merge').filter((i) => i.expect.batch?.job === job && view.doneOf(i.op) !== null).at(-1);
  if (intent === undefined) throw new Error(`batch ${job} has no done candidate`);
  return intent;
}

/**
 * After a batch's `ff{published}`, each step only where missing (recovery's restart calls it again): the latches for
 * every member, the snapshot (parent `job{batch-n}`), the slot released.
 */
export async function finishBatch(ctx: StageContext): Promise<BatchOutcome> {
  const held = heldBatch(ctx.journal.view);
  if (held === null) throw new Error('finishBatch: no batch holds the integration slot');
  const { holder, job } = held;
  const view = ctx.journal.view;
  if (!batchPublished(view, job)) throw new Error(`finishBatch: batch ${job} did not publish`);
  const ff = batchFfOf(view, job)!;
  const members = batchCandidateOf(view, job).expect.batch!.members.map((m) => m.unit);
  latchPublished(ctx, members, ff.expect.new);
  const parent: Parent = { type: 'job', job };
  if (!view.opsOf('snapshot.publish').some((i) => canonicalJson(i.parent) === canonicalJson(parent) && view.doneOf(i.op) !== null)) {
    await runOp(ctx.journal, snapshotPublishOp(ctx.repo), `snapshot:${ctx.plan().arc}`, parent, snapshotRequestOf({
      view: ctx.journal.view, runDir: ctx.runDir, identity: executorIdentity(), message: `roadmap ${ctx.plan().arc}: snapshot after publishing batch ${job} (${members.join(', ')})\n`,
    }));
  }
  await releaseBatch(ctx, holder, job);
  return { kind: 'published', job, head: ff.expect.new };
}

/** Recovery of a batch holder that did not publish: its checkouts removed, the slot released; the batch runs again. */
export async function abandonBatch(ctx: ResourceContext, holder: BatchHolder): Promise<void> {
  const found = batchReserves(ctx.journal.view, holder.finding).find((r) => r.holder.attempt === holder.attempt);
  if (found === undefined) throw new Error(`${canonicalJson(holder)} has no reserve intent`);
  await removeJobCheckouts(ctx, found.job);
  await releaseBatch(ctx, holder, found.job);
}

/** Whether a batch holder's `ff` published (recovery then leaves the slot to `finishBatch`). */
export function batchHolderPublished(view: JournalView, holder: BatchHolder): boolean {
  const found = batchReserves(view, holder.finding).find((r) => r.holder.attempt === holder.attempt);
  return found !== undefined && batchPublished(view, found.job);
}

/** The grade of a tree with no claims: nothing selected, nothing failing. */
const NO_CLAIMS: TreeGrade = { effects: new Map(), red: [], background: new Map(), unexplained: [], intact: true };

/** A batch's suite lanes that ran red count as failures nothing explains (the red-suite path). */
const withSuite = (g: TreeGrade, runs: readonly JourneyRun[]): TreeGrade =>
  ({ ...g, unexplained: [...new Set([...g.unexplained, ...runs.filter((r) => r.record === null && journeyRed(r)).map((r) => r.lane)])].sort() });

/**
 * Publishes the approved `members` (at least two) repairing `finding` as one batch candidate. A batch whose ff published
 * but was cut short is finished first.
 */
export async function publishBatch(ctx: BatchContext, finding: FindingId, members: readonly PlanUnit[]): Promise<BatchOutcome> {
  if (heldBatch(ctx.journal.view) !== null) return finishBatch(ctx);
  if (members.length < 2) throw new Error(`a batch of ${members.length} member for ${finding}: a batch has at least two`);
  const view = ctx.journal.view;
  const f = view.holistic().findings.find((x) => x.id === finding);
  if (f === undefined) throw new Error(`batch for ${finding}: no such finding`);
  const sorted = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const u of sorted) {
    if (view.unit(u.id).approval === null) throw new Error(`batch for ${finding}: member ${u.id} is not approved`);
    const repairs = specRepairs(loadUnitSpec(ctx, u).spec);
    if (!repairs.includes(finding) && (f.obligation === null || !repairs.includes(f.obligation))) throw new Error(`batch for ${finding}: member ${u.id} does not repair it`);
  }
  const reserves = batchReserves(view, finding);
  const earlier = reserves.at(-1);
  const job = earlier === undefined || batchPublished(view, earlier.job) ? view.nextJobId('batch') : earlier.job;
  const attempt = reserves.length + 1;
  const holder: BatchHolder = { type: 'batch', finding, attempt };
  const parent: Parent = { type: 'job', job };
  const grant = await ctx.acquireFirst(BATCH_SLOT, holder, NEVER, undefined, parent);
  if (grant.kind !== 'granted') throw new Error(`${job}: its slot wait was cancelled, and nothing cancels it`);
  run(ctx, heldReservation(ctx, holder, 'reserved'), parent);
  const close = async (outcome: BatchOutcome): Promise<BatchOutcome> => {
    await releaseBatch(ctx, holder, job);
    return outcome;
  };

  const plan = ctx.plan();
  const integration = branchRef(plan.integrationBranch);
  const approvals = new Map(sorted.map((u) => [u.id, approvalOf(ctx, u.id)] as const));
  const decision = planBatchCandidate(ctx.repo, {
    arc: plan.arc, job, integration, worktree: batchCheckout(plan.worktreeRoot, plan.arc, job, 'candidate', attempt), identity: executorIdentity(),
    message: `roadmap ${plan.arc}: batch ${job} repairing ${finding} (${sorted.map((u) => u.id).join(', ')})\n`,
    members: sorted.map((u) => {
      const fingerprint = approvals.get(u.id)!;
      const head = unitTip(ctx, u.id);
      if (fingerprint.unitCommit !== head) throw new Error(`batch ${job}: ${u.id}'s approval binds ${fingerprint.unitCommit}, the branch is at ${head}`);
      return { unit: u.id, unitCommit: head, fingerprint, rules: candidateRequest(ctx, u, 0).rules };
    }),
  });
  if (decision.kind !== 'merge') return close({ kind: 'refused', job, unit: decision.kind === 'prefix-collision' ? null : decision.unit, reason: decision.kind });
  const op = candidateMergeOp(ctx.repo);
  const cand = await runPrepared(ctx.journal, op, `candidate:${job}`, parent, await op.prepare(decision.plan));
  crashPoint('batch.after-candidate');
  const tip = cand.expect.integrationTip;

  // The claims: the union of every member's selection (each over its own diff and closure), completions over all members.
  const { obligations } = holisticInForce(ctx);
  const ids = [...new Set(sorted.flatMap((u) => selected(ctx, u, tip, approvals.get(u.id)!.unitCommit).map((o) => o.id)))].sort();
  const repairs = new Set(sorted.flatMap((u) => [...repairedObligations(ctx, u)]));
  const claims = claimsOf(ctx, obligations, sorted.map((u) => u.id), ids, repairs);
  const owner = { type: 'job', job, acquireFirst: ctx.acquireFirst } as const;
  const lanes = [...plan.suite.lanes.map(suiteJourneyLane), ...(claims?.lanes ?? []).map(arcJourneyLane)];
  const suiteRed = (r: JourneyRun): boolean => r.record === null && journeyRed(r);
  const onCandidate = await runJourneySeries(ctx, owner, lanes, candidateWorktreeRequest(cand), { reuse: true, stop: suiteRed });
  if (onCandidate.end.kind !== 'ran') return close({ kind: 'no-verdict', job, end: onCandidate.end });
  const p1 = p1Obligations(ctx.journal.view);
  // Outside an arc with obligations only the suite grades.
  const gradeOn = (series: JourneySeries, on: 'candidate' | 'tip'): TreeGrade => ({
    ...withSuite(claims === null ? NO_CLAIMS : on === 'candidate'
      ? gradeTree(claims, series.runs, claims.completing, claims.repairs, p1)
      : gradeTree(claims, series.runs, new Set(), new Set(), p1), series.runs),
    intact: intact(series),
  });
  const grade = gradeOn(onCandidate, 'candidate');
  if (!clean(grade)) {
    const alone = await runJourneySeries(ctx, owner, lanes, {
      path: batchCheckout(plan.worktreeRoot, plan.arc, job, 'base', attempt), checkout: { type: 'detached', at: tip },
    }, { reuse: true, stop: () => false });
    if (alone.end.kind !== 'ran') return close({ kind: 'no-verdict', job, end: alone.end });
    switch (brakeVerdict(grade, gradeOn(alone, 'tip'), claims?.repairs ?? new Set())) {
      case 'green':
        break;
      case 'red': {
        // A member is attributable when its own selection holds a red obligation and nothing else is red.
        const attributable = !grade.intact || grade.unexplained.length > 0 || grade.background.size > 0 ? [] : sorted.filter((u) => {
          const own = new Set(selected(ctx, u, tip, approvals.get(u.id)!.unitCommit).map((o) => o.id));
          return grade.red.some((id) => own.has(id));
        }).map((u) => u.id);
        return close({ kind: 'red', job, attributable });
      }
      case 'base-red':
        return close({ kind: 'base-red', job, needsUser: {
          blocking: true, subject: { type: 'arc' }, reason: 'base-red',
          summary: `Batch ${job} repairing ${finding} is red on ${plan.integrationBranch} at ${tip} alone as well: the base is broken, not the batch. Merges halt.`,
          recommendation: `Repair ${plan.integrationBranch} (or the suite), then acknowledge this item: the batch runs again.`,
          options: [], evidence: [jobEvidenceRoot(ctx.runDir, job)],
        } });
    }
  }

  // Green: every member's approval at the tip, then eligibility (G10), then the ff.
  const blocked = (): BatchOutcome | null => {
    for (const u of sorted) {
      const block = findingBlocking(ctx, u);
      if (block !== null) return { kind: 'finding-blocked', job, unit: u.id, block };
    }
    return null;
  };
  const eligible = blocked();
  if (eligible !== null) return close(eligible);
  const ffPlan = planBatchFf(ctx.repo, integration, cand);
  switch (ffPlan.kind) {
    case 'foreign-mover':
      return close({ kind: 'foreign-move', job, needsUser: batchForeignMove(ctx, job, `${ffPlan.ref} is at ${ffPlan.observed ?? 'nothing'}, expected ${ffPlan.expected}`) });
    case 'unpublished':
      return close({ kind: 'stale', job, invalid: [] });
    case 'ff':
      break;
  }
  const invalid = sorted.filter((u) => !fingerprintHolds(ctx, u, approvals.get(u.id)!, tip)).map((u) => u.id);
  if (invalid.length > 0) return close({ kind: 'stale', job, invalid });
  const late = blocked();
  if (late !== null) return close(late);
  const ff = await runPrepared(ctx.journal, integrationFfOp(ctx.repo, noBatchRedo), `integration:${plan.arc}`, parent, ffPlan.body);
  const done = ctx.journal.view.doneOf(ff.op);
  if (done === null || done.kind !== 'integration.ff') throw new Error(`integration.ff ${ff.op} has no done record`);
  switch (done.outcome.kind) {
    case 'published':
      return finishBatch(ctx);
    case 'unpublished':
      return close({ kind: 'stale', job, invalid: [] });
    case 'recovery-required':
      return close({ kind: 'foreign-move', job, needsUser: batchForeignMove(ctx, job, `${integration} is at ${done.outcome.observed ?? 'nothing'} after the publication CAS`) });
  }
}

/** A batch `ff` never asks for a unit's re-check (src/recover/ff.ts never redoes a batch CAS). */
const noBatchRedo = (): never => {
  throw new Error('a batch ff has no unit to re-check');
};

function batchForeignMove(ctx: StageContext, job: JobId, detail: string): NeedsUserContent {
  return {
    blocking: true, subject: { type: 'arc' }, reason: 'foreign-ref-move',
    summary: `Publication of batch ${job} stopped: ${detail}. Integration only moves forward, and only the executor moves its refs.`,
    recommendation: `Find out who moved it; restore ${ctx.plan().integrationBranch} (or the ref) to a descendant of what the executor published, then acknowledge.`,
    options: [], evidence: [],
  };
}

// ---------------------------------------------------------------------------------------------------
// snapshot

export async function snapshot(ctx: StageContext, unit: PlanUnit): Promise<StageDone<'snapshot'>> {
  const held = heldPublication(ctx, unit.id);
  const parent = at(start(ctx, unit.id, 'snapshot'), 'snapshot');
  // Everything durable so far, the ff's done included.
  await runOp(ctx.journal, snapshotPublishOp(ctx.repo), `snapshot:${ctx.plan().arc}`, parent, snapshotRequestOf({
    view: ctx.journal.view, runDir: ctx.runDir, identity: executorIdentity(), message: `roadmap ${ctx.plan().arc}: snapshot after publishing unit ${unit.id}\n`,
  }));
  const done = record(ctx, parent, 'published');
  await releasePublication(ctx, held, parent);
  return done;
}
