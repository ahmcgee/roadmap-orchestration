// The unit driver: `runUnit(ctx, unit, gate)` loops stage → transition → next until the unit is merged,
// parked, held or stopped. The scheduler (src/schedule/scheduler.ts) runs one per unit in flight, as that
// unit's task.
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
// call, never dispatched again; a judgment's against its recorded `judgment-inputs` (`consumeJudgment`, F1).
// Any other cut short attempt (no call yet, a lost call, a stage without one) runs again as a new,
// uncharged attempt. The executor records these at startup, right after recovery.
//
// A held unit (an interrupted stage) re-runs that stage when the driver is called again: calling it is
// the resume. An interrupted build is not restarted: its re-run is a `continue` round (rounds.ts) of the
// interrupted attempt's invocation, read from the fold's `interrupted` fact. Before every stage the driver
// asserts that none of the unit's invocations has a live workload, then asks its `gate`: an admission stage
// (prepare, reproduce, plan-check, build, lanes, gate, candidate) waits there for the scheduler's admission, which may
// end the task instead (a pause, a stop: the unit is left where the fold says, holding nothing); a chain
// stage (quiesce → evidence → salvage → teardown after a build, ff → snapshot in a publication) is only
// announced and runs whatever pause or drain says (F5). A re-entered unit starts at `prepare` (step 6). A
// unit re-opened (`reopened`: no decided outcome) starts over at plan-check: after a park by `resume <unit>`,
// or in flight by the driver itself, on a spec revision an `apply` left pending, at the first boundary whose
// next stage starts from a clean worktree (`reentryAllowed`).
//
// M3 (step A3): a command may set an entry outside the table (`UnitState.entry`), which runs before anything the
// latest decision says: `steer <u>` a steer round (a fresh implementer session with the architect's brief, R11; the
// pass then goes build chain → lanes → gate and exits by the table's steer rows), `merge-in <u>` the unit's lanes at
// its merged commit.
//
// M3 (step B3): a vacuity repair (its spec repairs an active vacuity finding with a mutant, reproduce.ts `specFacts`)
// starts at `reproduce` instead of plan-check, and so does its re-open. Around every stage the driver writes the
// findings' moves the log calls for (`syncRepairs`: ownership by the repairing units, resolution by their publication,
// code's dismissal of a mutant a reproduce killed). A candidate red on a surviving mutant gets its fix round from the
// mutant's run (`mutantFix`).
//
// Needs-user content is produced here, never written: the scheduler writes it. A halt's item names its
// evidence and says what `resume` does for it (`haltNeedsUser`).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_INV, ENV_ROLE } from '../contain/session.ts';
import { scan } from '../contain/proc.ts';
import { crashPoint } from '../core/crash.ts';
import { JUDGMENT_STAGES, type OutcomeStage, type StageOutcomeFact } from '../core/events.ts';
import { type InvocationId, type OpId, type ResourceInstance, type UnitId, invocationId } from '../core/ids.ts';
import type { EntryPoint, UnitState } from '../core/state.ts';
import { type NeedsUserReason, type NeedsUserContent, STDERR_FILE, STDOUT_FILE, type Stage } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { reentryRecommendation, reopenRecommendation, routingChangedRecommendation } from '../needsuser.ts';
import { capturedEvidence } from '../git/evidence.ts';
import type { PlanUnit } from '../input/plan.ts';
import { type NextStage, nextStage } from '../schedule/ready.ts';
import { type Reservation, type StageHolder, heldReservation, holderUnits, resourceTable, sameHolder } from '../resources/reserve.ts';
import { type Cancelled, type StageContext, type StageParent, dispatchOf, isCancelled, runOp, unitBranch, unitWorktree, verificationWorktree, workDir } from './dispatch.ts';
import { consumeJudgment, gate, gateDirectives, unitTip } from './gate.ts';
import { batchMemberFix, candidate, candidateBrakeFix, candidateRefusalFix, candidateSeriesRoot, ff, latestCandidate, memberBatchCandidate, snapshot } from './integrate.ts';
import { invocationDir } from './invoke.ts';
import { type LaneRecord, latestSeries, presentCheckouts, removeCheckout, seriesDirty, seriesLedger, seriesTree, specSeriesRoot } from './lanes.ts';
import type { FixRound } from '../prompts/inputs.ts';
import { prepare } from './prepare.ts';
import { mutantFix, reproduce, specFacts, syncRepairs } from './reproduce.ts';
import {
  type DecidedRound, type RoundInput, candidateFixRound, failingEvidenceDirs, failingLaneDirectives, gateReviseRound, laneFixRound, steerBrief,
} from './rounds.ts';
import {
  type BuildRun, type StageDone, at, build, buildRead, evidence, failedFacts, keptSpecPath, laneGlobs, lanes, loadUnitSpec, planCheck, quiesce, record,
  recordedCall, salvage, teardown,
} from './stages.ts';
import { type Next, type Target, decidedBy } from './transitions.ts';
import { notYet } from '../core/notyet.ts';
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
    : reason === 'steered'
      ? `Review the steer pass (its build and ${f.stage} evidence). \`roadmap resume ${unit.id}\` re-runs ${f.stage} with the pass over, so the pipeline goes on as usual `
        + `(a green gate to the candidate); \`roadmap steer ${unit.id} --brief <file> --budget <min>\` steers it again.`
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

/** Why candidate attempt `at` (an outcome `red`) was red, as its fix round reads it: the fix, and the suite's ledger. */
function candidateRed(ctx: StageContext, unit: PlanUnit, at: StageParent): Readonly<{ fix: FixRound; suite: readonly LaneRecord[] }> {
  const view = ctx.journal.view;
  // M3 (B7): a member of a repair batch red on its own selection: the batch candidate's evidence.
  const batch = memberBatchCandidate(view, at);
  if (batch !== null) return { fix: batchMemberFix(ctx, unit, batch), suite: [] };
  // Red on the candidate, green on the tip alone: the suite's failing lanes are the evidence.
  const suite = seriesLedger(ctx, at, ctx.plan().suite.lanes, latestCandidate(ctx, unit.id).post.new, candidateSeriesRoot(ctx.runDir, at));
  // M3 (B3): a vacuity repair's candidate that did not kill its mutant (the suite and the brake green).
  const survived = mutantFix(ctx, at);
  if (survived !== null) return { fix: survived, suite };
  const failing = suite.filter((l) => l.verdict !== 'pass');
  // M3: a green suite with red held claims (the brake): the obligations and journey lanes left red.
  if (failing.length === 0 && seriesDirty(view, candidateSeriesRoot(ctx.runDir, at)).length === 0) return { fix: candidateBrakeFix(ctx, unit, at), suite };
  return { fix: { failingEvidenceDirs: (failing.length > 0 ? failing : suite).flatMap(failingEvidenceDirs), directives: failingLaneDirectives(failing) }, suite };
}

/**
 * The cause of a red candidate attempt `at` in sentences, as its fix round would read it (the checkpoint's park
 * trigger): the suite lanes that were not green, then the fix round's directives (the obligations the brake graded red).
 */
export function candidateRedCause(ctx: StageContext, unit: PlanUnit, at: StageParent): readonly string[] {
  const { fix, suite } = candidateRed(ctx, unit, at);
  return [...suite.filter((l) => l.verdict !== 'pass').map((l) => `Suite lane ${l.lane} ended ${l.verdict} on the candidate.`), ...fix.directives];
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
  // The series' own verification checkout (Q3), while it is still there.
  const verificationOf = (parent: StageParent) => seriesTree(view, parent, verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, parent.attempt));
  switch (f.stage) {
    case 'lanes': {
      const parent = stageParent(f);
      const root = specSeriesRoot(ctx.runDir, parent);
      return laneFixRound(seriesLedger(ctx, parent, spec.lanes, tip, root), seriesDirty(view, root), tip);
    }
    case 'gate': {
      const parent = specSeries();
      return gateReviseRound(gateDirectives(ctx, stageParent(f)), seriesLedger(ctx, parent, spec.lanes, tip, specSeriesRoot(ctx.runDir, parent)), verificationOf(parent), tip);
    }
    case 'candidate': {
      const parent = specSeries();
      const verification = verificationOf(parent);
      if (f.outcome === 'transient-violation') {
        return candidateFixRound(candidateRefusalFix(ctx, unit), seriesLedger(ctx, parent, spec.lanes, tip, specSeriesRoot(ctx.runDir, parent)), verification, tip);
      }
      const red = candidateRed(ctx, unit, stageParent(f));
      return candidateFixRound(red.fix, red.suite, verification, tip);
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
  return continued(ctx, unit, decidedInput(ctx, unit, round, f));
}

/** `of`, or the continue of its attempt an interruption held since (a hold is only ever recorded from a call's result). */
function continued(ctx: StageContext, unit: PlanUnit, of: DecidedRound): RoundInput {
  const held = ctx.journal.view.unit(unit.id).interrupted;
  if (held === null) return of;
  const called = recordedCall(ctx, stageParent(held));
  if (held.stage !== 'build' || called === null || called.kind !== 'result') throw new Error(`unit ${unit.id}: ${held.stage} attempt ${held.attempt} was interrupted before a build, or without a call result`);
  return { kind: 'continue', of, interrupted: called.inv };
}

// ---------------------------------------------------------------------------------------------------
// Entries a command set (M3: steer, merge-in)

/** Where an entry sends the unit, as the table's target: a steer round is read as a fresh build's (`decidedRound`). */
const entryTarget = (entry: EntryPoint): Target => (entry.kind === 'steer' ? { stage: 'build', round: 'fresh' } : { stage: 'lanes' });

/**
 * Runs the stage an entry names: a steer round (R11: a fresh session, the brief kept by the command, the budget as its
 * window; the continue of it after a pause), or a merge-in's lanes at the merged unit commit.
 */
async function runEntry(ctx: StageContext, unit: PlanUnit, entry: EntryPoint): Promise<StageDone<OutcomeStage> | Cancelled> {
  if (entry.kind === 'merge-in') return lanes(ctx, unit, unitTip(ctx, unit.id));
  return build(ctx, unit, continued(ctx, unit, { kind: 'steer', brief: steerBrief(ctx.runDir, entry.brief), budgetMin: entry.budgetMin }));
}

/** Runs the stage `target` names, from inputs read back from the journal. */
async function runStage(ctx: StageContext, unit: PlanUnit, target: Target, f: StageOutcomeFact): Promise<StageDone<Target['stage']> | Cancelled> {
  switch (target.stage) {
    case 'prepare':
      // M4a rev 3 (F4): only a lanes `known-defect` sends a unit back to prepare, and no stage records one before N3.
      return notYet(`unit ${unit.id}: prepare after a known defect`, 'N3');
    case 'reproduce':
      return reproduce(ctx, unit);
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
 * snapshot, or a leftover's own: `removeCheckout`) and its own worktree last, citing its latest evidence
 * snapshot of an `evidence` or a `prepare` stage (F14: a re-entry verified straight from its preparation has
 * no build evidence). Branches and the candidate ref are kept. Re-runnable: what the journal says is gone is
 * not touched.
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
      .filter((i) => i.parent.type === 'stage' && i.parent.unit === unit.id && (i.parent.stage === 'evidence' || i.parent.stage === 'prepare') && after.doneOf(i.op) !== null)
      .at(-1)?.op;
    if (evidenceOp === undefined) throw new Error(`retire of ${unit.id}: its worktree ${created.expect.path} has no build or preparation evidence to cite`);
    await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${unit.id}:retire`, parent, {
      path: created.expect.path, evidence: capturedEvidence(after, evidenceOp),
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// The driver

/** What a finished stage leads to, for the loop: on to the next stage, or the unit's result (a stage that never started: held). */
async function after(ctx: StageContext, unit: PlanUnit, done: StageDone<OutcomeStage> | Cancelled): Promise<Step> {
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
  const entry = ctx.journal.view.unit(unit.id).entry;
  const decided = entry !== null || f === null ? null : decidedBy(f);
  if (decided !== null && decided.kind !== 'stage') throw new Error(`unit ${unit.id}: ${open.stage} attempt ${open.attempt} is open after ${f?.stage} ${f?.outcome} ended the unit`);
  const target: Target = entry !== null ? entryTarget(entry) : decided === null ? { stage: 'plan-check' } : decided.target;
  if (target.stage !== open.stage) throw new Error(`unit ${unit.id}: the open attempt ${open.attempt} is at ${open.stage}, but the unit's next stage is ${target.stage}`);
  switch (target.stage) {
    case 'plan-check':
    case 'gate':
      // Against the attempt's recorded inputs (F1): a gate at the tip and head it judged, not the current ones.
      return consumeJudgment(ctx, unit, parent, called);
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
  // M3 (B3): the findings' moves the log calls for (ownership, a killed mutant's dismissal) before and after each stage.
  syncRepairs(ctx);
  const s = await stepOnce(ctx, unit);
  syncRepairs(ctx);
  return s;
}

async function stepOnce(ctx: StageContext, unit: PlanUnit): Promise<Step> {
  const consumed = await consume(ctx, unit);
  if (consumed !== null) return consumed;
  const u = ctx.journal.view.unit(unit.id);
  // M3 (B7): a repair batch's ff retired the unit with its gate's approval still its decision: only its retire is left.
  if (u.status === 'retired') {
    await retire(ctx, unit);
    return { kind: 'merged' };
  }
  if (u.entry !== null) return after(ctx, unit, await runEntry(ctx, unit, u.entry));
  const f = u.decided;
  // Before a decision: a re-entry prepares first (its lineage not yet prepared), a vacuity repair reproduces its mutant
  // (M3), anything else plan-checks.
  if (f === null) {
    const first = nextStage(u, specFacts(ctx)(unit).reproduces);
    if (first?.kind !== 'admission') throw new Error(`unit ${unit.id}: no first stage before a decision`);
    return after(ctx, unit, first.stage === 'prepare' ? await prepare(ctx, unit) : first.stage === 'reproduce' ? await reproduce(ctx, unit) : await planCheck(ctx, unit));
  }
  const halted = haltResult(ctx, unit);
  if (halted !== null) return halted;
  const decided = decidedBy(f);
  switch (decided.kind) {
    case 'stage':
      return after(ctx, unit, await runStage(ctx, unit, decided.target, f));
    case 'park':
    case 'stop':
      throw new Error(`unit ${unit.id}: ${decided.kind} decided, but haltResult read none`);
    case 'retire':
      await retire(ctx, unit);
      return { kind: 'merged' };
  }
}

/**
 * The result of a unit its latest decision parked or stopped, with its needs-user content, read without
 * running anything; null for any other unit. The scheduler raises a restarted arc's due items from it.
 */
export function haltResult(ctx: StageContext, unit: PlanUnit): Extract<UnitResult, Readonly<{ kind: 'parked' | 'stopped' }>> | null {
  const u = ctx.journal.view.unit(unit.id);
  const f = u.decided;
  // An entry a command set runs next, whatever the decision before it (M3).
  if (f === null || u.entry !== null) return null;
  const decided = decidedBy(f);
  if (decided.kind === 'park') return { kind: 'parked', needsUser: haltNeedsUser(ctx, unit, 'park', decided.reason, factSummary(f)) };
  if (decided.kind === 'stop') return { kind: 'stopped', needsUser: haltNeedsUser(ctx, unit, 'stop', decided.reason, factSummary(f)) };
  return null;
}

/**
 * Whether a unit may re-open on a pending spec revision now: it is active, no attempt is open, an interrupted
 * one (if any) was a judgment (a build's would be continued), and its next stage starts from a clean unit
 * worktree (plan-check, lanes, gate, or a fresh or fix build), not inside the build → teardown chain, a resumed
 * build or publication.
 */
export function reentryAllowed(u: UnitState): boolean {
  if (u.status !== 'active' || u.open !== null || u.entry !== null) return false;
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
  if (p === null || !reopenDue(u)) return;
  // The classifier refuses a revision while an attempt is open, and no executor patch runs while one is
  // pending, so a pending revision is always the next rev.
  if (u.spec === null || p.rev !== u.spec.rev + 1) throw new Error(`unit ${unit}: its pending revision is rev ${p.rev}, but its spec is at rev ${u.spec?.rev}`);
  ctx.journal.fact({ kind: 'reopened', unit, command: p.command, specRev: p.rev, specSha256: p.sha256 });
}

/** Whether the unit re-opens on a pending revision at this boundary. */
const reopenDue = (u: UnitState): boolean => u.pendingRevision !== null && reentryAllowed(u);

/**
 * The stage the unit starts next: its first stage when it re-opens at this boundary (plan-check, or `reproduce` for a
 * vacuity repair: `reproduces`, src/pipeline/reproduce.ts `specFacts`), else its decided next stage (`nextStage`).
 */
export const upcoming = (u: UnitState, reproduces: boolean): NextStage | null =>
  (u.status === 'retired' ? null : reopenDue(u) ? { kind: 'admission', stage: reproduces ? 'reproduce' : 'plan-check' } : nextStage(u, reproduces));

// ---------------------------------------------------------------------------------------------------
// The loop

/**
 * Asked before each stage: `next` is the stage about to start. An admission stage resolves true once the
 * scheduler admits it, or false to end the unit's task there (a pause or stop: nothing of the stage has
 * started, so the unit holds nothing). A chain stage is only announced: it must resolve true (F5).
 */
export type Gate = (next: NextStage) => Promise<boolean>;

/** The invocations of the unit's stages: every ordinal of every stage-parented spawn of it. */
function unitInvocations(ctx: StageContext, unit: UnitId): ReadonlySet<string> {
  const out = new Set<string>();
  for (const i of ctx.journal.view.opsOf('proc.spawn')) {
    if (i.parent.type !== 'stage' || i.parent.unit !== unit) continue;
    for (let n = 1; n <= i.ordinal; n++) out.add(invocationId(i.op, n));
  }
  return out;
}

/**
 * No next stage while a workload of the unit lives: no live process (runners aside) carries ROADMAP_INV of
 * one of the unit's invocations. Every stage settles its invocations before it records, so one found here is
 * a bug: two writers of one unit.
 */
function assertQuiescent(ctx: StageContext, unit: UnitId): void {
  const own = unitInvocations(ctx, unit);
  if (own.size === 0) return;
  const live = scan().filter((p) => {
    const inv = p.env?.get(ENV_INV);
    return inv !== undefined && p.env?.get(ENV_ROLE) !== 'runner' && own.has(inv);
  });
  if (live.length > 0) throw new Error(`unit ${unit}: a stage would start while its workload lives: ${live.map((p) => `${p.pid} (${p.env?.get(ENV_INV)})`).join(', ')}`);
}

/**
 * Runs `unit` stage by stage until it is merged, parked, held or stopped. Before each stage the unit's
 * workload must be quiescent and `gate` is asked (a pending spec revision re-opens the unit at plan-check at
 * the first boundary that allows it, `reopenIfDue`, so the gate is asked for plan-check then). A gate that
 * refuses leaves the unit where the fold says (`held`, no needs-user); the next call continues there. A merged,
 * parked or stopped unit starts no stage: its step only reads its result back (a merged unit's retire is
 * finished first).
 */
export async function runUnit(ctx: StageContext, unit: PlanUnit, gate: Gate): Promise<UnitResult> {
  for (;;) {
    const u = ctx.journal.view.unit(unit.id);
    const next = upcoming(u, specFacts(ctx)(unit).reproduces);
    if (next !== null) {
      assertQuiescent(ctx, unit.id);
      if (!(await gate(next))) {
        if (next.kind === 'chain') throw new Error(`unit ${unit.id}: the gate refused the chain stage ${next.stage}`);
        return { kind: 'held', needsUser: null };
      }
      reopenIfDue(ctx, unit.id);
    }
    const s = await step(ctx, unit);
    if (s.kind !== 'continue') return s;
    crashPoint('unit.after-stage', unit.id);
  }
}
