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
// plan-check, build or gate attempt whose backend call ended with a result but whose stage-outcome fact is
// missing (the fold's `open` attempt) is recorded from that result, never dispatched again. Any other cut
// short attempt (no call yet, a lost call, a stage without one) runs again as a new, uncharged attempt.
//
// A held unit (an interrupted stage) re-runs that stage when the driver is called again: calling it is
// the resume. A pause or stop signal is checked between stages; the stage in flight is ended by the
// command layer's kills (step 13), which the stage records as `interrupted`.
//
// Needs-user content is produced here, never written: the writer is step 13's.
import { crashPoint } from '../core/crash.ts';
import type { OutcomeStage, Parent, StageOutcomeFact } from '../core/events.ts';
import { type OpId, type UnitId, invocationId } from '../core/ids.ts';
import type { NeedsUserReason, NeedsUserContent } from '../core/records.ts';
import { capturedEvidence } from '../git/evidence.ts';
import type { PlanUnit } from '../input/plan.ts';
import { type Reservation, type StageHolder, lockOrder, resourceTable, sameHolder } from '../resources/reserve.ts';
import { stageRecipes } from '../resources/teardown.ts';
import { canonicalJson } from '../core/json.ts';
import { type StageContext, type StageParent, runOp, unitBranch, unitWorktree, workDir } from './dispatch.ts';
import { gate, gateDirectives, gateRead, unitTip } from './gate.ts';
import { candidate, candidateRefusalFix, candidateSeriesRoot, ff, latestCandidate, snapshot } from './integrate.ts';
import { invocationDir } from './invoke.ts';
import { latestSeries, seriesDirty, seriesLedger, seriesTree, specSeriesRoot } from './lanes.ts';
import { type RoundInput, candidateFixRound, gateReviseRound, laneFixRound } from './rounds.ts';
import {
  type BuildRun, type StageDone, at, build, buildRead, evidence, integrationTip, lanes, loadUnitSpec, planCheck, planCheckRead, quiesce, record,
  recordedCall, salvage, teardown,
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
// Needs-user content

/** Reasons that concern the arc rather than one unit: the base is broken, or someone else moved a ref. */
const ARC_REASONS: ReadonlySet<NeedsUserReason> = new Set(['base-red', 'foreign-ref-move', 'usage-limit']);

/** The needs-user content of a halt the table decided, when the stage had nothing more specific to say. */
function haltNeedsUser(unit: UnitId, reason: NeedsUserReason, summary: string): NeedsUserContent {
  return {
    blocking: true,
    subject: ARC_REASONS.has(reason) ? { type: 'arc' } : { type: 'unit', unit },
    reason,
    summary: `Unit ${unit}: ${summary}.`,
    recommendation: `Read the unit's evidence and log; fix the cause (spec, environment or ruling), then resume unit ${unit}, or acknowledge to leave it parked.`,
    options: [],
    evidence: [],
  };
}

const factSummary = (f: StageOutcomeFact): string => `${f.stage} attempt ${f.attempt} ended ${f.outcome}`;

// ---------------------------------------------------------------------------------------------------
// Stage inputs, read back from the journal

const stageParent = (f: StageOutcomeFact): StageParent => ({ type: 'stage', unit: f.unit, stage: f.stage, attempt: f.attempt });

/** The reservation `holder` still holds running, rebuilt from the resource table; null when it holds none. */
function heldBy(ctx: StageContext, holder: StageHolder): Reservation<'running', StageHolder> | null {
  const resources = [...resourceTable(ctx.journal.view)]
    .filter(([, e]) => e.pending === null && e.status.state === 'running' && sameHolder(e.status.holder, holder))
    .map(([r]) => r);
  if (resources.length === 0) return null;
  const ordered = lockOrder(resources);
  return { state: 'running', holder, resources: ordered, recipes: stageRecipes(ctx.plan, ctx.repo, holder.unit, ordered) };
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
    worktree: unitWorktree(ctx.plan.worktreeRoot, ctx.plan.arc, unit.id),
    branch: unitBranch(ctx.plan.arc, unit.id),
    workDir: workDir(ctx.runDir, parent),
    reservation: heldBy(ctx, { type: 'stage', unit: unit.id, stage: 'build', attempt: parent.attempt }),
  };
}

/** The build round `round` after the decision `f`, with the inputs its kind needs. */
function roundInput(ctx: StageContext, unit: PlanUnit, round: Extract<Target, { stage: 'build' }>['round'], f: StageOutcomeFact): RoundInput {
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
      const suite = seriesLedger(ctx, at, ctx.plan.suite.lanes, latestCandidate(ctx, unit.id).post.new, candidateSeriesRoot(ctx.runDir, at));
      const failing = suite.filter((l) => l.verdict !== 'pass');
      return candidateFixRound({ failingEvidenceDirs: (failing.length > 0 ? failing : suite).flatMap((l) => l.fixDirs), directives: [] }, suite, verification, tip);
    }
    default:
      throw new Error(`unit ${unit.id}: no fix round follows ${f.stage} ${f.outcome}`);
  }
}

/** Runs the stage `target` names, from inputs read back from the journal. */
async function runStage(ctx: StageContext, unit: PlanUnit, target: Target, f: StageOutcomeFact): Promise<StageDone<Target['stage']>> {
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
 * Removes every worktree the unit still has, verification checkouts first and its own worktree last, each
 * citing its captured evidence (the series' snapshot; for the unit worktree, its latest build evidence).
 * Branches and the candidate ref are kept. Re-runnable: what the journal says is gone is not touched.
 */
async function retire(ctx: StageContext, unit: PlanUnit): Promise<void> {
  const view = ctx.journal.view;
  const parent: StageParent = { type: 'stage', unit: unit.id, stage: 'retire', attempt: view.unit(unit.id).counters.attempts + 1 };
  const ofUnit = (p: Parent): boolean => p.type === 'stage' && p.unit === unit.id;
  const removed = new Set(view.opsOf('worktree.remove').filter((i) => view.doneOf(i.op) !== null).map((i) => i.expect.path));
  const present = view.opsOf('worktree.create').filter((i) => ofUnit(i.parent) && view.doneOf(i.op) !== null && !removed.has(i.expect.path));
  const evidenceOps = view.opsOf('evidence.snapshot').filter((i) => ofUnit(i.parent) && view.doneOf(i.op) !== null);
  const ordered = [...present.filter((i) => i.expect.checkout.type === 'detached'), ...present.filter((i) => i.expect.checkout.type === 'branch')];
  for (const created of ordered) {
    // A series checkout cites its series' last snapshot; the unit worktree, its latest build evidence.
    const evidenceOp: OpId | undefined = (created.expect.checkout.type === 'detached'
      ? evidenceOps.filter((i) => canonicalJson(i.parent) === canonicalJson(created.parent))
      : evidenceOps.filter((i) => i.parent.type === 'stage' && i.parent.stage === 'evidence')).at(-1)?.op;
    if (evidenceOp === undefined) throw new Error(`retire of ${unit.id}: no captured evidence to cite for ${created.expect.path}`);
    await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${unit.id}:retire`, parent, {
      path: created.expect.path, evidence: capturedEvidence(view, evidenceOp),
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// The driver

/** What a finished stage leads to, for the loop: on to the next stage, or the unit's result. */
async function after(ctx: StageContext, unit: PlanUnit, done: StageDone<Target['stage']>): Promise<Step> {
  const next: Next = done.next;
  switch (next.kind) {
    case 'stage':
      return { kind: 'continue' };
    case 'hold':
      return { kind: 'held', needsUser: done.needsUser };
    case 'park':
      return { kind: 'parked', needsUser: done.needsUser ?? haltNeedsUser(unit.id, next.needsUser.reason, next.needsUser.summary) };
    case 'stop':
      return { kind: 'stopped', needsUser: done.needsUser ?? haltNeedsUser(unit.id, next.needsUser.reason, next.needsUser.summary) };
    case 'retire':
      await retire(ctx, unit);
      return { kind: 'merged' };
  }
}

// ---------------------------------------------------------------------------------------------------
// A backend call a crash left unrecorded

const CALL_STAGES: readonly OutcomeStage[] = ['plan-check', 'build', 'gate'];

/**
 * The outcome of a stage attempt a crash cut short after its backend call: the fold's open attempt (no
 * stage-outcome fact) at plan-check, build or gate whose call recovery has since closed with a result
 * (adopted, reconciled or redone). That result is consumed as the attempt's outcome, exactly as the live
 * stage would have read it; the call is never dispatched again (lead ruling 14a/14b: completed but
 * unrecorded is never treated as not started). A lost call, or none, returns null: the stage runs again as
 * a new attempt.
 */
async function consumeRecorded(ctx: StageContext, unit: PlanUnit, f: StageOutcomeFact | null): Promise<StageDone<Target['stage']> | null> {
  const open = ctx.journal.view.unit(unit.id).open;
  if (open === null || !CALL_STAGES.includes(open.stage as OutcomeStage)) return null;
  const parent: StageParent = { type: 'stage', unit: unit.id, stage: open.stage, attempt: open.attempt };
  const called = recordedCall(ctx, parent);
  if (called === null || called.kind === 'lost') return null;
  const decided = f === null ? null : decidedBy(f);
  if (decided !== null && decided.kind !== 'stage') throw new Error(`unit ${unit.id}: ${open.stage} attempt ${open.attempt} is open after ${f?.stage} ${f?.outcome} ended the unit`);
  const target: Target = decided === null ? { stage: 'plan-check' } : decided.target;
  if (target.stage !== open.stage) throw new Error(`unit ${unit.id}: the open attempt ${open.attempt} is at ${open.stage}, but the unit's next stage is ${target.stage}`);
  const { result } = called;
  switch (target.stage) {
    case 'plan-check':
    case 'gate': {
      if (result.role === 'build') throw new Error(`${called.inv}: an implementer result at ${target.stage}`);
      if (target.stage === 'plan-check') return planCheckRead(ctx, unit, at(parent, 'plan-check'), called, result.session);
      return gateRead(ctx, unit, at(parent, 'gate'), called, result.session, integrationTip(ctx), unitTip(ctx, unit.id));
    }
    case 'build': {
      const holder: StageHolder = { type: 'stage', unit: unit.id, stage: 'build', attempt: open.attempt };
      // Recovery cleaned the dead attempt's reservation; a teardown that failed there is this attempt's outcome.
      const failed = [...resourceTable(ctx.journal.view).values()].some((e) => e.status.state === 'cleanup-failed' && sameHolder(e.status.holder, holder));
      if (failed) return record(ctx, at(parent, 'build'), 'cleanup-failed');
      return buildRead(ctx, unit, at(parent, 'build'), target.round, called, heldBy(ctx, holder));
    }
    default:
      throw new Error(`unit ${unit.id}: ${target.stage} makes no backend call`);
  }
}

/**
 * One step of the unit: the stage its latest decided outcome names, run and recorded (or, when a crash cut
 * that stage short after its backend call, consumed from the recorded call); or, when that outcome ended
 * the unit, its result (a merged unit's retire is finished first if a restart cut it short).
 */
export async function step(ctx: StageContext, unit: PlanUnit): Promise<Step> {
  const f = ctx.journal.view.unit(unit.id).decided;
  const recorded = await consumeRecorded(ctx, unit, f);
  if (recorded !== null) return after(ctx, unit, recorded);
  if (f === null) return after(ctx, unit, await planCheck(ctx, unit));
  const decided = decidedBy(f);
  switch (decided.kind) {
    case 'stage':
      return after(ctx, unit, await runStage(ctx, unit, decided.target, f));
    case 'park':
      return { kind: 'parked', needsUser: haltNeedsUser(unit.id, decided.reason, factSummary(f)) };
    case 'stop':
      return { kind: 'stopped', needsUser: haltNeedsUser(unit.id, decided.reason, factSummary(f)) };
    case 'retire':
      await retire(ctx, unit);
      return { kind: 'merged' };
  }
}

/**
 * Runs `unit` stage by stage until it is merged, parked, held or stopped. `signal` (pause or stop) is
 * honoured between stages: the unit is left where the fold says, and the next call continues there.
 */
export async function runUnit(ctx: StageContext, unit: PlanUnit, signal: AbortSignal): Promise<UnitResult> {
  for (;;) {
    if (signal.aborted) return { kind: 'held', needsUser: null };
    const s = await step(ctx, unit);
    if (s.kind !== 'continue') return s;
    crashPoint('unit.after-stage');
  }
}
