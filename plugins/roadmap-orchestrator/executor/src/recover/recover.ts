// The first recovery pass (plan "Recovery on `roadmap start`"): every intent a dead executor left open is
// closed by its kind's reconciler before anything is dispatched. Order:
//
//   processes   proc.kill, then proc.spawn (a spawn's own recovery kill must not collide with a kill left
//               open before the crash; lead note, 14b). Both reconcilers write their own done.
//   git         worktree.*, evidence.snapshot, salvage.commit, mergein.prepare, candidate.merge,
//               integration.ff, snapshot.publish: the reconciler reads the postcondition and returns a
//               disposition this module applies (done, redo through the op's own act and verify, abort).
//   resources   recoverReservations: open transitions closed, dead holders' reservations cleaned.
//   files       spec.patch, needsuser.raise, command.apply.
//
// A `park` leaves its intent open and raises one blocking needs-user (reason recovery-required) naming the
// op, parented by the op so a later pass raises it once. `recovery-required` (integration.ff) raises the
// same needs-user, then closes the intent with that outcome; `abort` (candidate, snapshot) raises it, then
// aborts. Then a second pass checks the fixed point: it must find only the parked intents and append
// nothing, else a reconciler is not idempotent and recovery fails loud.
//
// It runs in the executor after the ownership handshake, under the supervisor's host claim (a takeover
// already ran under host.recovery.lock, with `reconcilePreviousArc` below), before anything is dispatched.
// A crash inside it (`recover.before-op` / `recover.after-op` around each op, or inside an op's own act)
// leaves open intents the next start's recovery reconciles to the same fixed point, with no effect twice.
//
// Also here: `reconcilePreviousArc`, claimHost's `reconcilePrevious` hook (R18), which settles what a dead
// claim of another arc left running before a takeover.
import { join } from 'node:path';
import type { CommandContext } from '../commands/apply.ts';
import { containmentFor, detectContainmentMode } from '../contain/detect.ts';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, IntentRecord, OpKind, OpOutcome, Parent } from '../core/events.ts';
import { type InvocationId, type OpId, invocationId } from '../core/ids.ts';
import type { Disposition, DispositionKind, Journal, JournalView } from '../core/interfaces.ts';
import { LogCorruptError, type LogSnapshot, openJournal, readJournal } from '../core/log.ts';
import type { HostLockClaim, NeedsUserContent } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { refTarget } from '../git/git.ts';
import type { SalvageRules } from '../git/salvage.ts';
import type { PreviousArcVerdict } from '../host/lock.ts';
import type { PlanUnit } from '../input/plan.ts';
import { needsUserReconciler, publishNeedsUser, raiseNeedsUser, raisedFor } from '../needsuser.ts';
import { type StageContext, dispatchOf } from '../pipeline/dispatch.ts';
import { fingerprintValid } from '../pipeline/gate.ts';
import { type ProcContext, invocationDir, liveRunner, quiescent } from '../pipeline/invoke.ts';
import { loadUnitSpec } from '../pipeline/stages.ts';
import { launchSha256 } from '../runner/launch.ts';
import { runnerFiles } from '../runner/files.ts';
import { specPatchOp } from '../spec/patch.ts';
import { commandReconciler } from './command.ts';
import { killReconciler } from './kill.ts';
import { recoverReservations } from './resource.ts';
import { spawnReconciler } from './spawn.ts';
import {
  candidateMergeOp, evidenceSnapshotOp, integrationFfOp, mergeinOp, salvageCommitOp, snapshotPublishOp, worktreeCreateOp, worktreeRemoveOp,
} from './ops.ts';

/** The stage context the git and resource reconcilers need, and the command context command.apply needs. */
export type RecoveryContext = Readonly<{ stage: StageContext; commands: CommandContext }>;

/** What one open intent came to in a pass. */
export type Recovered = Readonly<{ op: OpId; kind: OpKind; disposition: DispositionKind }>;

export type RecoveryReport = Readonly<{
  /** Every intent the passes handled, in the order handled (a parked one appears once per pass). */
  recovered: readonly Recovered[];
  /** Intents left open by a park, each with its needs-user raised. */
  parked: readonly OpId[];
}>;

const GIT_KINDS = [
  'worktree.create', 'worktree.remove', 'evidence.snapshot', 'salvage.commit', 'mergein.prepare', 'candidate.merge', 'integration.ff',
  'snapshot.publish',
] as const satisfies readonly OpKind[];
const FILE_KINDS = ['spec.patch', 'needsuser.raise', 'command.apply'] as const satisfies readonly OpKind[];
type StepKind = (typeof GIT_KINDS)[number] | (typeof FILE_KINDS)[number];

/** An op this module can finish on a `redo`: its reconciler, and its act and verify from the intent alone. */
type Redoable<K extends StepKind> = Readonly<{
  reconcile: (intent: IntentOf<K>, view: JournalView) => Promise<Disposition<K>>;
  act: (intent: IntentOf<K>) => Promise<void>;
  verify: (intent: IntentOf<K>) => Promise<OpOutcome[K]>;
}>;

// ---------------------------------------------------------------------------------------------------
// Rebuilding what an op was bound with

function unitOf(ctx: StageContext, intent: IntentRecord): PlanUnit {
  if (intent.parent.type !== 'stage') throw new Error(`${intent.kind} ${intent.op} is not parented by a stage; its unit cannot be known`);
  const id = intent.parent.unit;
  const unit = ctx.plan().units.find((u) => u.id === id);
  if (unit === undefined) throw new Error(`${intent.op} names unit ${id}, which the plan does not have`);
  return unit;
}

/** The salvage rules, rebuilt exactly as the salvage stage binds them: the pinned scope, the spec's evidence globs. */
function salvageRules(ctx: StageContext, unit: PlanUnit): SalvageRules {
  const { spec } = loadUnitSpec(ctx, unit);
  return {
    scope: dispatchOf(ctx.journal.view, unit.id).scope,
    excluded: [...new Set(spec.lanes.flatMap((l) => l.evidenceGlobs))].sort(),
    rejectedRoot: absPath(join(ctx.runDir, 'rejected', unit.id)),
  };
}

/** The needs-user op as a redoable: the reconciler, and the rename of the staged file as its act. */
function needsUserOp(runDir: AbsPath): Redoable<'needsuser.raise'> {
  return {
    reconcile: needsUserReconciler(runDir),
    act: async (intent) => publishNeedsUser(runDir, intent),
    verify: async () => ({ kind: 'raised' }),
  };
}

/** command.apply's reconciler applies the remainder and writes the receipt itself: it only ever says done. */
function commandOp(ctx: CommandContext): Redoable<'command.apply'> {
  const never = async (intent: IntentOf<'command.apply'>): Promise<never> => {
    throw new Error(`command.apply ${intent.op}: its reconciler never asks for a redo`);
  };
  return { reconcile: commandReconciler(ctx), act: never, verify: never };
}

// ---------------------------------------------------------------------------------------------------
// Applying a disposition

function recoveryNeedsUser(intent: IntentRecord, detail: string): NeedsUserContent {
  return {
    blocking: true,
    subject: intent.parent.type === 'stage' ? { type: 'unit', unit: intent.parent.unit } : { type: 'arc' },
    reason: 'recovery-required',
    summary: `Recovery could not settle ${intent.kind} ${intent.op} on its own: ${detail}`,
    recommendation: `Inspect what ${intent.op} acted on and put it back to the state its intent records (or finish it by hand); the op stays open until then.`,
    options: [],
    evidence: [],
  };
}

/**
 * One blocking needs-user per op, parented by the op; a later pass or start finds it raised. Raised before
 * the op is closed (abort, recovery-required), so a crash in between leaves the op open and the next
 * recovery reaches the same disposition and finds the item raised. A raise a crash left open holds the
 * one `needs-user` key, so it is finished first (it may be this op's own).
 */
async function raiseOnce(ctx: RecoveryContext, intent: IntentRecord, detail: string): Promise<void> {
  const { journal, runDir } = ctx.stage;
  for (const open of openOf(journal, ['needsuser.raise'])) await step(ctx, open);
  const parent: Parent = { type: 'op', op: intent.op };
  if (raisedFor(journal.view, parent) === null) raiseNeedsUser(journal, runDir, recoveryNeedsUser(intent, detail), parent);
}

async function apply<K extends StepKind>(ctx: RecoveryContext, record: IntentRecord, op: Redoable<K>): Promise<DispositionKind> {
  const { journal, repo } = ctx.stage;
  const intent = record as IntentOf<K>;
  const d = await op.reconcile(intent, journal.view);
  switch (d.kind) {
    case 'done':
      journal.done(intent.op, intent.kind, d.outcome, 'reconciled');
      break;
    case 'redo':
      await op.act(intent);
      journal.done(intent.op, intent.kind, await op.verify(intent), 'redone');
      break;
    case 'abort':
      await raiseOnce(ctx, record, d.detail);
      journal.abort(intent.op, 'recovery', d.detail);
      break;
    case 'recovery-required': {
      if (record.kind !== 'integration.ff') throw new Error(`${record.kind} ${record.op}: recovery-required is an integration.ff disposition`);
      await raiseOnce(ctx, record, d.detail);
      journal.done(record.op, 'integration.ff', { kind: 'recovery-required', observed: refTarget(repo, record.expect.ref) }, 'reconciled');
      break;
    }
    case 'park':
      await raiseOnce(ctx, record, d.detail);
      break;
    case 'adopt':
    case 'lost':
      throw new Error(`${record.kind} ${record.op}: disposition ${d.kind} belongs to proc.spawn`);
  }
  return d.kind;
}

/** One git or file intent through its kind's reconciler, with the op rebuilt as its stage bound it. */
function step(ctx: RecoveryContext, intent: IntentRecord): Promise<DispositionKind> {
  const s = ctx.stage;
  switch (intent.kind) {
    case 'worktree.create':
      return apply(ctx, intent, worktreeCreateOp(s.repo));
    case 'worktree.remove':
      return apply(ctx, intent, worktreeRemoveOp(s.repo));
    case 'evidence.snapshot':
      return apply(ctx, intent, evidenceSnapshotOp);
    case 'salvage.commit':
      return apply(ctx, intent, salvageCommitOp(salvageRules(s, unitOf(s, intent))));
    case 'mergein.prepare':
      return apply(ctx, intent, mergeinOp(s.repo));
    case 'candidate.merge':
      return apply(ctx, intent, candidateMergeOp(s.repo));
    case 'integration.ff':
      return apply(ctx, intent, integrationFfOp(s.repo, fingerprintValid(s, unitOf(s, intent))));
    case 'snapshot.publish':
      return apply(ctx, intent, snapshotPublishOp(s.repo));
    case 'spec.patch':
      return apply(ctx, intent, specPatchOp(s.runDir));
    case 'needsuser.raise':
      return apply(ctx, intent, needsUserOp(s.runDir));
    case 'command.apply':
      return apply(ctx, intent, commandOp(ctx.commands));
    // Interim (M3 0a): no release before these steps writes these intents.
    case 'docs.commit':
      throw new Error(`${intent.kind} ${intent.op}: recovery not implemented (step A4)`);
    case 'mutant.apply':
      throw new Error(`${intent.kind} ${intent.op}: recovery not implemented (step B3)`);
    case 'revision.commit':
      throw new Error(`${intent.kind} ${intent.op}: recovery not implemented (step A2)`);
    case 'proc.spawn':
    case 'proc.kill':
    case 'resource.transition':
      throw new Error(`${intent.kind} ${intent.op} is recovered by its own phase`);
  }
}

// ---------------------------------------------------------------------------------------------------
// The passes

const openOf = (journal: Journal, kinds: readonly OpKind[]): readonly IntentRecord[] =>
  journal.view.openIntents().filter((i) => kinds.includes(i.kind));

/** One pass in the fixed order. Returns what it did to each open intent it met. */
async function pass(ctx: RecoveryContext): Promise<readonly Recovered[]> {
  const s = ctx.stage;
  const out: Recovered[] = [];
  const track = async (intent: IntentRecord, run: () => Promise<DispositionKind>): Promise<void> => {
    crashPoint('recover.before-op');
    out.push({ op: intent.op, kind: intent.kind, disposition: await run() });
    crashPoint('recover.after-op');
  };

  const kill = killReconciler(s);
  for (const intent of openOf(s.journal, ['proc.kill'])) await track(intent, async () => (await kill(intent as IntentOf<'proc.kill'>, s.journal.view)).kind);
  const spawn = spawnReconciler(s);
  for (const intent of openOf(s.journal, ['proc.spawn'])) await track(intent, async () => (await spawn(intent as IntentOf<'proc.spawn'>, s.journal.view)).kind);

  for (const kind of GIT_KINDS) for (const intent of openOf(s.journal, [kind])) await track(intent, () => step(ctx, intent));

  const transitions = openOf(s.journal, ['resource.transition']);
  crashPoint('recover.before-op');
  await recoverReservations(s);
  for (const intent of transitions) out.push({ op: intent.op, kind: intent.kind, disposition: 'done' });
  crashPoint('recover.after-op');

  for (const kind of FILE_KINDS) for (const intent of openOf(s.journal, [kind])) await track(intent, () => step(ctx, intent));
  return out;
}

export class RecoveryNotIdempotentError extends Error {
  constructor(detail: string) {
    super(`a second recovery pass ${detail}; a reconciler is not idempotent`);
    this.name = 'RecoveryNotIdempotentError';
  }
}

/**
 * Closes every open intent the log holds, then checks the fixed point: a second pass may only re-park what
 * the first parked, and appends nothing to the log. Returns what happened and which ops stay open (parked,
 * each with its needs-user). A crash anywhere in here leaves a log the next start recovers the same way: every
 * reconciler re-reads its postcondition first, and each needs-user is raised before its op is closed.
 */
export async function recover(ctx: RecoveryContext): Promise<RecoveryReport> {
  const first = await pass(ctx);
  const mark = ctx.stage.journal.view.highWater();
  const second = await pass(ctx);
  const changed = second.filter((r) => r.disposition !== 'park');
  if (changed.length > 0) throw new RecoveryNotIdempotentError(`still changed ${changed.map((r) => `${r.kind} ${r.op} (${r.disposition})`).join(', ')}`);
  const appended = ctx.stage.journal.view.highWater() - mark;
  if (appended > 0) throw new RecoveryNotIdempotentError(`appended ${appended} events to the log`);
  const parked = ctx.stage.journal.view.openIntents().map((i) => i.op);
  const reparked = second.map((r) => r.op);
  if (parked.length !== reparked.length || parked.some((op) => !reparked.includes(op))) {
    throw new Error(`after recovery the open intents are ${parked.join(', ') || 'none'}, but the second pass parked ${reparked.join(', ') || 'none'}`);
  }
  return { recovered: [...first, ...second], parked };
}

// ---------------------------------------------------------------------------------------------------
// The previous arc (R18)

const invOf = (intent: IntentOf<'proc.spawn'>): InvocationId => invocationId(intent.op, intent.ordinal);
const filesOf = (runDir: AbsPath, intent: IntentOf<'proc.spawn'>) => runnerFiles(invocationDir(runDir, invOf(intent)), invOf(intent));

/** Open spawns with a live runner or a live workload member (by ROADMAP_INV): what outlived the dead executor. */
function survivors(ctx: Pick<ProcContext, 'containment' | 'runDir'>, view: JournalView): readonly IntentOf<'proc.spawn'>[] {
  return view.openIntents().flatMap((i) => {
    if (i.kind !== 'proc.spawn') return [];
    const intent = i as IntentOf<'proc.spawn'>;
    const live = liveRunner(filesOf(ctx.runDir, intent)) !== null || !quiescent(ctx, { inv: invOf(intent), scope: 'invocation', reason: 'recovery' });
    return live ? [intent] : [];
  });
}

/** The spawn reconciler's precondition: a live invocation's launch.json is the one its intent recorded. */
function launchMatches(runDir: AbsPath, intent: IntentOf<'proc.spawn'>): boolean {
  const launch = filesOf(runDir, intent).read('launch.json');
  return launch !== null && launchSha256(launch) === intent.expect.launchSha256;
}

/**
 * The `reconcilePrevious` hook `claimHost` runs, under the recovery lock, when it takes over a dead claim
 * of another arc. That arc's runners are setsid'd and may have outlived its executor. Read only first:
 * when no open spawn has a live runner or workload, nothing is written and the previous arc's own next
 * start recovers the rest. Otherwise its journal is opened (its executor is verified dead, and the recovery
 * lock keeps its own start out) and the existing reconcilers settle the survivors: open kills first, then
 * each surviving spawn (a live runner is adopted: waited for, its result recorded once; an orphan workload
 * is killed and the invocation closed lost). Nothing is dispatched. Unreconcilable, so the takeover refuses
 * with `previous-arc-unreconciled`: the log is corrupt (no survivor can be named), a survivor's launch.json
 * is not the one its intent recorded, or a survivor remains after the pass.
 */
export async function reconcilePreviousArc(previous: HostLockClaim): Promise<PreviousArcVerdict> {
  let snapshot: LogSnapshot;
  try {
    snapshot = readJournal(previous.runDir, previous.arc);
  } catch (error) {
    if (!(error instanceof LogCorruptError)) throw error;
    return { kind: 'unreconciled', invocations: [] };
  }
  const containment = containmentFor(snapshot.view.containmentMode() ?? detectContainmentMode());
  const found = survivors({ containment, runDir: previous.runDir }, snapshot.view);
  if (found.length === 0) return { kind: 'reconciled' };
  const mismatched = found.filter((i) => !launchMatches(previous.runDir, i));
  if (mismatched.length > 0) return { kind: 'unreconciled', invocations: mismatched.map(invOf) };

  const journal = openJournal(previous.runDir, previous.arc);
  try {
    const ctx: ProcContext = { journal, containment, runDir: previous.runDir };
    const kill = killReconciler(ctx);
    for (const intent of openOf(journal, ['proc.kill'])) await kill(intent as IntentOf<'proc.kill'>, journal.view);
    const spawn = spawnReconciler(ctx);
    for (const intent of survivors(ctx, journal.view)) await spawn(intent, journal.view);
    const left = survivors(ctx, journal.view);
    return left.length === 0 ? { kind: 'reconciled' } : { kind: 'unreconciled', invocations: left.map(invOf) };
  } finally {
    journal.close();
  }
}
