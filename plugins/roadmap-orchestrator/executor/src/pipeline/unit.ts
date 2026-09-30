// The serial unit driver: `runUnit(ctx, unit, signal)` loops stage → transition → next until the unit is
// merged, parked, held or stopped.
//
// Nothing is carried in memory from one stage to the next. Each step reads the unit's state from the fold
// (`JournalView.unit`): the latest decided stage-outcome says which stage runs next (`decidedBy`), and that
// stage's inputs are read back from the journal, git and the invocation files: the build a quiesce,
// evidence, salvage or teardown works on and the reservation it still holds; the unit commit (its branch
// tip, which only build rounds and merge-ins move); the lane series a fix round or the gate reads; the
// gate's directives; the approval. So a restarted executor continues from any stage boundary of a
// reconciled journal exactly as a live one would.
//
// Inside a stage, after recovery (src/recover/recover.ts) has closed what a dead executor left open: a
// plan-check, build or gate attempt whose backend call ended with a result (or, for a build, was lost with
// tree effects) but whose stage-outcome fact is missing (the fold's `open` attempt) is recorded from that
// call, never dispatched again. Any other cut short attempt (no call yet, a lost call, a stage without one)
// runs again as a new, uncharged attempt. The executor records these at startup, right after recovery.
//
// A held unit (an interrupted stage) re-runs that stage when the driver is called again: calling it is
// the resume. An interrupted build is not restarted: its re-run is a `continue` round (rounds.ts) of the
// interrupted attempt's invocation, read from the fold's `interrupted` fact. A pause or stop signal, and
// the durable pause markers and `after` edges (`dispatchBlock`), are checked before a unit's first stage and
// between stages; the stage in flight is ended by the command layer's kills (step 13), which the stage
// records as `interrupted`. A unit re-opened (`reopened`: no decided outcome) starts over at plan-check, like a
// unit never dispatched: after a park by `resume <unit>`, or in flight by the driver itself, on a spec revision an
// `apply` left pending, at the first boundary whose next stage starts from a clean worktree (`reentryAllowed`).
// Mutations (apply, resume, sweep) run at every stage boundary through `atBoundary`.
//
// Needs-user content is produced here, never written: the writer is step 13's. A halt's item names its
// evidence and says what `resume` does for it (`haltNeedsUser`).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { JUDGMENT_STAGES, type OutcomeStage, type StageOutcomeFact } from '../core/events.ts';
import { type OpId, type ResourceInstance, type UnitId, invocationId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { UnitState } from '../core/state.ts';
import { type NeedsUserReason, type NeedsUserContent, STDERR_FILE, STDOUT_FILE, type Stage } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { raisedFor, reentryRecommendation, reopenRecommendation, routingChangedRecommendation } from '../needsuser.ts';
import { capturedEvidence } from '../git/evidence.ts';
import type { PlanUnit } from '../input/plan.ts';
import { type Reservation, type StageHolder, heldReservation, holderUnits, resourceTable, sameHolder } from '../resources/reserve.ts';
import { type Cancelled, type StageContext, type StageParent, dispatchOf, isCancelled, runOp, unitBranch, unitWorktree, workDir } from './dispatch.ts';
import { gate, gateDirectives, gateRead, unitTip } from './gate.ts';
import { candidate, candidateRefusalFix, candidateSeriesRoot, ff, latestCandidate, snapshot } from './integrate.ts';
import { invocationDir } from './invoke.ts';
import { latestSeries, presentCheckouts, removeCheckout, seriesDirty, seriesLedger, seriesTree, specSeriesRoot } from './lanes.ts';
import { type DecidedRound, type RoundInput, candidateFixRound, gateReviseRound, laneFixRound, failingLaneDirectives } from './rounds.ts';
import {
  type BuildRun, type StageDone, at, build, buildRead, evidence, failedFacts, integrationTip, keptSpecPath, laneGlobs, lanes, loadUnitSpec, planCheck, planCheckRead,
  quiesce, record, recordedCall, salvage, teardown,
} from './stages.ts';
import { type Next, type Target, decidedBy } from './transitions.ts';
import { worktreeRemoveOp } from '../recover/ops.ts';

export type UnitResult =
  | Readonly<{ kind: 'merged' }>
  | Readonly<{ kind: 'parked'; needsUser: NeedsUserContent }>
  /** Waiting for a resume: an interrupted stage (with the arc-wide needs-user of a backend park), or a signal between stages. */
  | Readonly<{ kind: 'held'; needsUser: NeedsUserContent | null }>
  | Readonly<{ kind: 'stopped'; needsUser: NeedsUserContent }>;

export type Step = UnitResult | Readonly<{ kind: 'continue' }>;

// ---------------------------------------------------------------------------------------------------
// Waiting at a unit

/**
 * Whether `id` no longer holds the units that name it in `after`: merged, or parked with the blocking
 * needs-user of its park acknowledged.
 */
function settledForAfter(view: JournalView, id: UnitId): boolean {
  const u = view.unit(id);
  if (u.status === 'retired') return true;
  if (u.status !== 'park-pending' || u.decided === null) return false;
  const item = raisedFor(view, { type: 'stage', unit: id, stage: u.decided.stage, attempt: u.decided.attempt });
  return item !== null && view.ackOf(item) !== null;
}

/** The units `unit` is still held after (plan `after`), in plan order. */
export function heldAfter(view: JournalView, unit: PlanUnit): readonly UnitId[] {
  return unit.after.filter((id) => !settledForAfter(view, id));
}

/**
 * Why the serial arc may not start a stage of `unit` now, from the log alone, or null: the arc or the unit
 * is paused, or a unit it runs after is neither merged nor parked-and-acknowledged. The arc waits at such a
 * unit (M1 is serial), and so does every unit after it.
 */
export function dispatchBlock(view: JournalView, unit: PlanUnit): string | null {
  const c = view.control();
  if (c.pausedAll) return 'the arc is paused';
  if (c.pausedUnits.includes(unit.id)) return `unit ${unit.id} is paused`;
  const after = heldAfter(view, unit);
  if (after.length > 0) return `unit ${unit.id} is held after ${after.join(', ')}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Needs-user content

/** The stages that make a backend call. */
const CALL_STAGES: readonly OutcomeStage[] = ['plan-check', 'build', 'gate'];

/** Reasons that concern the arc rather than one unit: the base is broken, or someone else moved a ref. */
const ARC_REASONS: ReadonlySet<NeedsUserReason> = new Set(['base-red', 'foreign-ref-move', 'usage-limit']);

/**
 * What a halt's recommendation refers to (arc-1 feedback item 23): the deciding stage's backend call
 * (result.json, which holds a judgment's reasons and patch, and stdout; stdout and stderr of a lost call),
 * for a plan-check the redirect whose patch the unit's spec last took, a lanes or candidate attempt's
 * evidence, a failed salvage's worktree, and the spec in force (its kept file, not the live one).
 */
function haltEvidence(ctx: StageContext, unit: PlanUnit, f: StageOutcomeFact): readonly AbsPath[] {
  const parent = stageParent(f);
  const out: AbsPath[] = [];
  const called = CALL_STAGES.includes(f.stage) ? recordedCall(ctx, parent) : null;
  if (called?.kind === 'result') out.push(absPath(join(called.invDir, 'result.json')), absPath(join(called.invDir, STDOUT_FILE)));
  if (called?.kind === 'lost') out.push(absPath(join(called.invDir, STDOUT_FILE)), absPath(join(called.invDir, STDERR_FILE)));
  if (f.stage === 'plan-check') {
    const view = ctx.journal.view;
    const redirect = view.opsOf('spec.patch').flatMap((i) => {
      const { by } = i.expect.patch;
      return i.parent.type === 'stage' && i.parent.unit === unit.id && by.role === 'planCheck' && view.doneOf(i.op) !== null ? [by.inv] : [];
    }).at(-1);
    if (redirect !== undefined) out.push(absPath(join(invocationDir(ctx.runDir, redirect), 'result.json')));
  }
  if (f.stage === 'lanes') out.push(specSeriesRoot(ctx.runDir, parent));
  if (f.stage === 'candidate') out.push(candidateSeriesRoot(ctx.runDir, parent));
  if (f.stage === 'salvage') out.push(unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id));
  out.push(keptSpecPath(ctx, unit));
  return [...new Set(out)].filter((p) => existsSync(p));
}

/**
 * The needs-user content of a halt the table decided (the unit's latest decided outcome), when the stage
 * had nothing more specific to say. A park's recommendation says exactly what `resume` does for it: a
 * `routing-changed` park re-enters once its implementer seat's routing is restored; any other park at a
 * judgment stage re-opens after a spec edit; any other is re-entered under a new unit id.
 */
function haltNeedsUser(ctx: StageContext, unit: PlanUnit, kind: 'park' | 'stop', reason: NeedsUserReason, summary: string): NeedsUserContent {
  const f = ctx.journal.view.unit(unit.id).decided;
  if (f === null) throw new Error(`unit ${unit.id} halted without a decided outcome`);
  const { path, spec } = loadUnitSpec(ctx, unit);
  const recommendation = kind === 'stop'
    ? 'Read the evidence and the log, find and fix the cause, then acknowledge this item and start the arc again.'
    : reason === 'routing-changed'
      ? routingChangedRecommendation(unit.id, dispatchOf(ctx.journal.view, unit.id).riskFloor)
      : (JUDGMENT_STAGES as readonly Stage[]).includes(f.stage)
        ? reopenRecommendation(unit.id, path, spec.rev)
        : reentryRecommendation(unit.id, f.stage, unitBranch(ctx.plan().arc, unit.id));
  return {
    blocking: true,
    subject: ARC_REASONS.has(reason) ? { type: 'arc' } : { type: 'unit', unit: unit.id },
    reason,
    summary: `Unit ${unit.id}: ${summary} (spec ${path} at rev ${spec.rev}).`,
    recommendation,
    options: [],
    evidence: haltEvidence(ctx, unit, f),
  };
}

const factSummary = (f: StageOutcomeFact): string => `${f.stage} attempt ${f.attempt} ended ${f.outcome}`;

// ---------------------------------------------------------------------------------------------------
// Stage inputs, read back from the journal

const stageParent = (f: StageOutcomeFact): StageParent => ({ type: 'stage', unit: f.unit, stage: f.stage, attempt: f.attempt });

/** The reservation `holder` still holds running, rebuilt from the resource table; null when it holds none. */
function heldBy(ctx: StageContext, holder: StageHolder): Reservation<'running', StageHolder> | null {
  return holderUnits(ctx.journal.view, holder).length === 0 ? null : heldReservation(ctx, holder, 'running');
}

/** The unit's latest successful build: its invocation (the last of its attempt: a collided resume retries), dirs and held reservation. */
function buildRunOf(ctx: StageContext, unit: PlanUnit): BuildRun {
  const view = ctx.journal.view;
  const spawn = view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'backend' && s.role === 'build' && s.unit === unit.id;
  }).at(-1);
  if (spawn === undefined || spawn.parent.type !== 'stage') throw new Error(`unit ${unit.id} has no build invocation`);
  const parent = spawn.parent;
  const inv = invocationId(spawn.op, spawn.ordinal);
  return {
    inv,
    invDir: invocationDir(ctx.runDir, inv),
    worktree: unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id),
    branch: unitBranch(ctx.plan().arc, unit.id),
    workDir: workDir(ctx.runDir, parent),
    reservation: heldBy(ctx, { type: 'stage', unit: unit.id, stage: 'build', attempt: parent.attempt }),
  };
}

/** The build round `round` after the decision `f`, with the inputs its kind needs. */
function decidedInput(ctx: StageContext, unit: PlanUnit, round: Extract<Target, { stage: 'build' }>['round'], f: StageOutcomeFact): DecidedRound {
  if (round !== 'fix') return { kind: round };
  const view = ctx.journal.view;
  const { spec } = loadUnitSpec(ctx, unit);
  const tip = unitTip(ctx, unit.id);
  // The unit's latest spec series: the green one the gate judged and the candidate merged.
  const specSeries = (): StageParent => {
    const parent = latestSeries(view, unit.id, 'spec');
    if (parent === null) throw new Error(`unit ${unit.id}: a fix round after ${f.stage} ${f.outcome}, but no spec lanes ran`);
    return parent;
  };
  switch (f.stage) {
    case 'lanes': {
      const parent = stageParent(f);
      const root = specSeriesRoot(ctx.runDir, parent);
      return laneFixRound(seriesLedger(ctx, parent, spec.lanes, tip, root), seriesDirty(view, root), tip);
    }
    case 'gate': {
      const parent = specSeries();
      return gateReviseRound(gateDirectives(ctx, stageParent(f)), seriesLedger(ctx, parent, spec.lanes, tip, specSeriesRoot(ctx.runDir, parent)), seriesTree(view, parent), tip);
    }
    case 'candidate': {
      const parent = specSeries();
      const verification = seriesTree(view, parent);
      if (f.outcome === 'transient-violation') {
        return candidateFixRound(candidateRefusalFix(ctx, unit), seriesLedger(ctx, parent, spec.lanes, tip, specSeriesRoot(ctx.runDir, parent)), verification, tip);
      }
      // Red on the candidate, green on the tip alone: the suite's failing lanes are the evidence.
      const at = stageParent(f);
      const suite = seriesLedger(ctx, at, ctx.plan().suite.lanes, latestCandidate(ctx, unit.id).post.new, candidateSeriesRoot(ctx.runDir, at));
      const failing = suite.filter((l) => l.verdict !== 'pass');
      return candidateFixRound({ failingEvidenceDirs: (failing.length > 0 ? failing : suite).flatMap((l) => l.fixDirs), directives: failingLaneDirectives(failing) }, suite, verification, tip);
    }
    default:
      throw new Error(`unit ${unit.id}: no fix round follows ${f.stage} ${f.outcome}`);
  }
}

/**
 * The round the build after decision `f` runs: the decided round, or, when an attempt of it was interrupted
 * since, the continue of that attempt's last invocation (a hold is only ever recorded from a call's result).
 */
function roundInput(ctx: StageContext, unit: PlanUnit, round: Extract<Target, { stage: 'build' }>['round'], f: StageOutcomeFact): RoundInput {
  const of = decidedInput(ctx, unit, round, f);
  const held = ctx.journal.view.unit(unit.id).interrupted;
  if (held === null) return of;
  const called = recordedCall(ctx, stageParent(held));
  if (held.stage !== 'build' || called === null || called.kind !== 'result') throw new Error(`unit ${unit.id}: ${held.stage} attempt ${held.attempt} was interrupted before a build, or without a call result`);
  return { kind: 'continue', of, interrupted: called.inv };
}

/** Runs the stage `target` names, from inputs read back from the journal. */
async function runStage(ctx: StageContext, unit: PlanUnit, target: Target, f: StageOutcomeFact): Promise<StageDone<Target['stage']> | Cancelled> {
  switch (target.stage) {
    case 'plan-check':
      return planCheck(ctx, unit);
    case 'build':
      return build(ctx, unit, roundInput(ctx, unit, target.round, f));
    case 'quiesce':
      return quiesce(ctx, unit.id, buildRunOf(ctx, unit));
    case 'evidence':
      return evidence(ctx, unit, buildRunOf(ctx, unit));
    case 'salvage':
      return salvage(ctx, unit, buildRunOf(ctx, unit));
    case 'teardown':
      return teardown(ctx, unit.id, buildRunOf(ctx, unit));
    case 'lanes':
      return lanes(ctx, unit, unitTip(ctx, unit.id));
    case 'gate':
      return gate(ctx, unit);
    case 'candidate':
      return candidate(ctx, unit);
    case 'ff':
      return ff(ctx, unit);
    case 'snapshot':
      return snapshot(ctx, unit);
  }
}

// ---------------------------------------------------------------------------------------------------
// retire

/**
 * Removes every worktree the unit still has, verification checkouts first (each citing its series' evidence
 * snapshot, or a leftover's own: `removeCheckout`) and its own worktree last, citing its latest build
 * evidence. Branches and the candidate ref are kept. Re-runnable: what the journal says is gone is not touched.
 */
async function retire(ctx: StageContext, unit: PlanUnit): Promise<void> {
  const view = ctx.journal.view;
  const parent: StageParent = { type: 'stage', unit: unit.id, stage: 'retire', attempt: view.unit(unit.id).counters.attempts + 1 };
  const { spec } = loadUnitSpec(ctx, unit);
  for (const created of presentCheckouts(view, unit.id)) await removeCheckout(ctx, created, parent, laneGlobs(ctx, spec));
  const after = ctx.journal.view;
  const removed = new Set(after.opsOf('worktree.remove').filter((i) => after.doneOf(i.op) !== null).map((i) => i.expect.path));
  const own = after.opsOf('worktree.create').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit.id && i.expect.checkout.type === 'branch'
    && after.doneOf(i.op) !== null && !removed.has(i.expect.path));
  for (const created of own) {
    const evidenceOp: OpId | undefined = after.opsOf('evidence.snapshot')
      .filter((i) => i.parent.type === 'stage' && i.parent.unit === unit.id && i.parent.stage === 'evidence' && after.doneOf(i.op) !== null).at(-1)?.op;
    if (evidenceOp === undefined) throw new Error(`retire of ${unit.id}: its worktree ${created.expect.path} has no build evidence to cite`);
    await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${unit.id}:retire`, parent, {
      path: created.expect.path, evidence: capturedEvidence(after, evidenceOp),
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// The driver

/** What a finished stage leads to, for the loop: on to the next stage, or the unit's result (a stage that never started: held). */
async function after(ctx: StageContext, unit: PlanUnit, done: StageDone<Target['stage']> | Cancelled): Promise<Step> {
  if (isCancelled(done)) return { kind: 'held', needsUser: null };
  const next: Next = done.next;
  switch (next.kind) {
    case 'stage':
      return { kind: 'continue' };
    case 'hold':
      return { kind: 'held', needsUser: done.needsUser };
    case 'park':
      return { kind: 'parked', needsUser: done.needsUser ?? haltNeedsUser(ctx, unit, 'park', next.needsUser.reason, next.needsUser.summary) };
    case 'stop':
      return { kind: 'stopped', needsUser: done.needsUser ?? haltNeedsUser(ctx, unit, 'stop', next.needsUser.reason, next.needsUser.summary) };
    case 'retire':
      await retire(ctx, unit);
      return { kind: 'merged' };
  }
}

// ---------------------------------------------------------------------------------------------------
// A backend call a crash left unrecorded

/**
 * The outcome of a stage attempt a crash cut short after its backend call: the fold's open attempt (no
 * stage-outcome fact) at plan-check, build or gate whose call recovery has since closed with a result
 * (adopted, reconciled or redone). That result is consumed as the attempt's outcome, exactly as the live
 * stage would have read it; the call is never dispatched again (lead ruling 14a/14b: completed but
 * unrecorded is never treated as not started), and so is a build lost with tree effects (its work is
 * salvaged, the plan's recovery table). Any other lost call, or none, returns null: the stage runs again as
 * a new, uncharged attempt.
 */
async function consumeRecorded(ctx: StageContext, unit: PlanUnit, f: StageOutcomeFact | null): Promise<StageDone<Target['stage']> | null> {
  const open = ctx.journal.view.unit(unit.id).open;
  if (open === null || !CALL_STAGES.includes(open.stage as OutcomeStage)) return null;
  const parent: StageParent = { type: 'stage', unit: unit.id, stage: open.stage, attempt: open.attempt };
  const called = recordedCall(ctx, parent);
  // A lost implementer call that may have changed the tree is consumed too (salvaged and verified); any
  // other lost call is not: its stage runs again.
  if (called === null || (called.kind === 'lost' && !(open.stage === 'build' && called.treeEffects))) return null;
  const decided = f === null ? null : decidedBy(f);
  if (decided !== null && decided.kind !== 'stage') throw new Error(`unit ${unit.id}: ${open.stage} attempt ${open.attempt} is open after ${f?.stage} ${f?.outcome} ended the unit`);
  const target: Target = decided === null ? { stage: 'plan-check' } : decided.target;
  if (target.stage !== open.stage) throw new Error(`unit ${unit.id}: the open attempt ${open.attempt} is at ${open.stage}, but the unit's next stage is ${target.stage}`);
  switch (target.stage) {
    case 'plan-check':
    case 'gate': {
      if (called.kind === 'lost') throw new Error(`${called.inv}: a lost judgment call is never consumed`);
      const { result } = called;
      if (result.role === 'build') throw new Error(`${called.inv}: an implementer result at ${target.stage}`);
      if (target.stage === 'plan-check') return planCheckRead(ctx, unit, at(parent, 'plan-check'), called, result.session);
      return gateRead(ctx, unit, at(parent, 'gate'), called, result.session, integrationTip(ctx), unitTip(ctx, unit.id));
    }
    case 'build': {
      const holder: StageHolder = { type: 'stage', unit: unit.id, stage: 'build', attempt: open.attempt };
      // Recovery cleaned the dead attempt's reservation; a teardown that failed there is this attempt's outcome.
      const failed = [...resourceTable(ctx.journal.view)].flatMap(([r, e]) => (e.status.state === 'cleanup-failed' && sameHolder(e.status.holder, holder) ? [r as ResourceInstance] : []));
      if (failed.length > 0) return record(ctx, at(parent, 'build'), 'cleanup-failed', null, failedFacts(failed));
      return buildRead(ctx, unit, at(parent, 'build'), target.round, called, heldBy(ctx, holder));
    }
    default:
      throw new Error(`unit ${unit.id}: ${target.stage} makes no backend call`);
  }
}

/**
 * The step that records a stage attempt a crash cut short after its backend call, from the call recovery
 * closed (`consumeRecorded`); null when the unit has no such attempt. The executor calls it for every unit
 * at startup, right after recovery (lead ruling, 14c), and `step` calls it first, so it is recorded once.
 */
export async function consume(ctx: StageContext, unit: PlanUnit): Promise<Step | null> {
  const recorded = await consumeRecorded(ctx, unit, ctx.journal.view.unit(unit.id).decided);
  return recorded === null ? null : after(ctx, unit, recorded);
}

/**
 * One step of the unit: the stage its latest decided outcome names, run and recorded (or, when a crash cut
 * that stage short after its backend call, consumed from the recorded call); or, when that outcome ended
 * the unit, its result (a merged unit's retire is finished first if a restart cut it short).
 */
export async function step(ctx: StageContext, unit: PlanUnit): Promise<Step> {
  const consumed = await consume(ctx, unit);
  if (consumed !== null) return consumed;
  const f = ctx.journal.view.unit(unit.id).decided;
  if (f === null) return after(ctx, unit, await planCheck(ctx, unit));
  const decided = decidedBy(f);
  switch (decided.kind) {
    case 'stage':
      return after(ctx, unit, await runStage(ctx, unit, decided.target, f));
    case 'park':
      return { kind: 'parked', needsUser: haltNeedsUser(ctx, unit, 'park', decided.reason, factSummary(f)) };
    case 'stop':
      return { kind: 'stopped', needsUser: haltNeedsUser(ctx, unit, 'stop', decided.reason, factSummary(f)) };
    case 'retire':
      await retire(ctx, unit);
      return { kind: 'merged' };
  }
}

/** What runs at each stage boundary, after the stage's outcome: the executor applies pending mutations. */
export type AtBoundary = () => Promise<void>;
export const noBoundary: AtBoundary = async () => {};

/**
 * Whether a unit may re-open on a pending spec revision now: it is active, no attempt is open, an interrupted
 * one (if any) was a judgment (a build's would be continued), and its next stage starts from a clean unit
 * worktree (plan-check, lanes, gate, or a fresh or fix build), not inside the build → teardown chain, a resumed
 * build or publication.
 */
export function reentryAllowed(u: UnitState): boolean {
  if (u.status !== 'active' || u.open !== null) return false;
  if (u.interrupted !== null && !(JUDGMENT_STAGES as readonly Stage[]).includes(u.interrupted.stage)) return false;
  if (u.decided === null) return true;
  const d = decidedBy(u.decided);
  if (d.kind !== 'stage') return false;
  const t = d.target;
  return t.stage === 'plan-check' || t.stage === 'lanes' || t.stage === 'gate' || (t.stage === 'build' && (t.round === 'fresh' || t.round === 'fix'));
}

/**
 * Re-opens an in-flight unit on its pending revision (an applied rev + 1 of its spec) when it may:
 * a `reopened` fact naming the apply that recorded it. The unit starts over at plan-check, keeping its
 * branch, worktree, implementer session and counters, as a reopen after a park does.
 */
function reopenIfDue(ctx: StageContext, unit: UnitId): void {
  const u = ctx.journal.view.unit(unit);
  const p = u.pendingRevision;
  if (p === null || !reentryAllowed(u)) return;
  // The classifier refuses a revision while an attempt is open, and no executor patch runs while one is
  // pending, so a pending revision is always the next rev.
  if (u.spec === null || p.rev !== u.spec.rev + 1) throw new Error(`unit ${unit}: its pending revision is rev ${p.rev}, but its spec is at rev ${u.spec?.rev}`);
  ctx.journal.fact({ kind: 'reopened', unit, command: p.command, specRev: p.rev, specSha256: p.sha256 });
}

/**
 * Runs `unit` stage by stage until it is merged, parked, held or stopped. `signal` (pause or stop) and the
 * unit's `dispatchBlock` (a pause marker, an unmet `after`) are honoured before its first stage and between
 * stages: the unit is left where the fold says, and the next call continues there. A pending spec revision
 * re-opens the unit at the first boundary that allows it (`reopenIfDue`); `atBoundary` runs after each stage.
 */
export async function runUnit(ctx: StageContext, unit: PlanUnit, signal: AbortSignal, atBoundary: AtBoundary = noBoundary): Promise<UnitResult> {
  for (;;) {
    // The durable markers too, not only the signal the command loop aborts on its next poll: a unit paused
    // (or waiting on `after`) is never dispatched, and no further stage of it starts (arc-1 feedback item 16).
    // A merged, parked or stopped unit starts no stage: its step only reads its result back.
    const ended = ['retired', 'park-pending', 'stop-pending'].includes(ctx.journal.view.unit(unit.id).status);
    if (signal.aborted || (!ended && dispatchBlock(ctx.journal.view, unit) !== null)) return { kind: 'held', needsUser: null };
    reopenIfDue(ctx, unit.id);
    const s = await step(ctx, unit);
    if (s.kind !== 'continue') return s;
    crashPoint('unit.after-stage');
    await atBoundary();
  }
}
