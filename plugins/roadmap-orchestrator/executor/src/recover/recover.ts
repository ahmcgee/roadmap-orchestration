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
// op, parented by the op so a later pass raises it once. `recovery-required` (integration.ff) closes the
// intent with that outcome and raises the same needs-user; `abort` (candidate, snapshot) aborts and raises
// it. Then the passes run again until one changes nothing: a second pass must find only the parked
// intents, else a reconciler is not idempotent and recovery fails loud.
//
// Seams left for later steps: the recovery lock and the takeover order are 14a's (claimHost's
// `reconcilePrevious` hook, fed by `previousArcVerdict` below); crash-during-recovery cells are 14b's, at
// `recover.before-op` / `recover.after-op`.
import { join } from 'node:path';
import type { CommandContext } from '../commands/apply.ts';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, IntentRecord, OpKind, OpOutcome, Parent } from '../core/events.ts';
import { type OpId, invocationId } from '../core/ids.ts';
import type { Disposition, DispositionKind, Journal, JournalView } from '../core/interfaces.ts';
import { readJournal } from '../core/log.ts';
import type { HostLockClaim, NeedsUserContent } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { candidateMergeOp } from '../git/candidate.ts';
import { evidenceSnapshotOp } from '../git/evidence.ts';
import { integrationFfOp } from '../git/ff.ts';
import { refTarget } from '../git/git.ts';
import { mergeinOp } from '../git/mergein.ts';
import { type SalvageRules, salvageCommitOp } from '../git/salvage.ts';
import { snapshotPublishOp } from '../git/snapshot.ts';
import { worktreeCreateOp, worktreeRemoveOp } from '../git/worktree.ts';
import type { PreviousArcVerdict } from '../host/lock.ts';
import type { PlanUnit } from '../input/plan.ts';
import { needsUserReconciler, publishNeedsUser, raiseNeedsUser, raisedFor } from '../needsuser.ts';
import { type StageContext, dispatchOf } from '../pipeline/dispatch.ts';
import { fingerprintValid } from '../pipeline/gate.ts';
import { loadUnitSpec } from '../pipeline/stages.ts';
import { specPatchFileOp } from '../spec/patch.ts';
import { commandReconciler } from './command.ts';
import { killReconciler } from './kill.ts';
import { recoverReservations } from './resource.ts';
import { spawnReconciler } from './spawn.ts';

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
  const unit = ctx.plan.units.find((u) => u.id === id);
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

/** One blocking needs-user per op, parented by the op; a later pass or start finds it raised. */
function raiseOnce(journal: Journal, runDir: AbsPath, intent: IntentRecord, detail: string): void {
  const parent: Parent = { type: 'op', op: intent.op };
  if (raisedFor(journal.view, parent) === null) raiseNeedsUser(journal, runDir, recoveryNeedsUser(intent, detail), parent);
}

async function apply<K extends StepKind>(ctx: RecoveryContext, record: IntentRecord, op: Redoable<K>): Promise<DispositionKind> {
  const { journal, runDir, repo } = ctx.stage;
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
      journal.abort(intent.op, 'recovery', d.detail);
      raiseOnce(journal, runDir, record, d.detail);
      break;
    case 'recovery-required': {
      if (record.kind !== 'integration.ff') throw new Error(`${record.kind} ${record.op}: recovery-required is an integration.ff disposition`);
      journal.done(record.op, 'integration.ff', { kind: 'recovery-required', observed: refTarget(repo, record.expect.ref) }, 'reconciled');
      raiseOnce(journal, runDir, record, d.detail);
      break;
    }
    case 'park':
      raiseOnce(journal, runDir, record, d.detail);
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
      return apply(ctx, intent, specPatchFileOp);
    case 'needsuser.raise':
      return apply(ctx, intent, needsUserOp(s.runDir));
    case 'command.apply':
      return apply(ctx, intent, commandOp(ctx.commands));
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
  constructor(recovered: readonly Recovered[]) {
    super(`a second recovery pass still changed ${recovered.map((r) => `${r.kind} ${r.op} (${r.disposition})`).join(', ')}; a reconciler is not idempotent`);
    this.name = 'RecoveryNotIdempotentError';
  }
}

/**
 * Closes every open intent the log holds, then checks the fixed point: a second pass may only re-park what
 * the first parked. Returns what happened and which ops stay open (parked, each with its needs-user).
 */
export async function recover(ctx: RecoveryContext): Promise<RecoveryReport> {
  const first = await pass(ctx);
  const second = await pass(ctx);
  const changed = second.filter((r) => r.disposition !== 'park');
  if (changed.length > 0) throw new RecoveryNotIdempotentError(changed);
  const parked = ctx.stage.journal.view.openIntents().map((i) => i.op);
  const reparked = second.map((r) => r.op);
  if (parked.length !== reparked.length || parked.some((op) => !reparked.includes(op))) {
    throw new Error(`after recovery the open intents are ${parked.join(', ') || 'none'}, but the second pass parked ${reparked.join(', ') || 'none'}`);
  }
  return { recovered: [...first, ...second], parked };
}

// ---------------------------------------------------------------------------------------------------
// The previous arc (R18)

/**
 * The verdict `claimHost` asks for when it takes over a dead claim of another arc: reconciled when that
 * arc's log holds no open spawn, else unreconciled, naming the invocations (start refuses with
 * `previous-arc-unreconciled`). Read only: this start never acts on another arc's run dir. Step 14a/14b
 * replace this check with the cross-arc reconcile under the recovery lock.
 */
export async function previousArcVerdict(previous: HostLockClaim): Promise<PreviousArcVerdict> {
  const { view } = readJournal(previous.runDir, previous.arc);
  const invocations = view.openIntents().flatMap((i) => (i.kind === 'proc.spawn' ? [invocationId(i.op, i.ordinal)] : []));
  return invocations.length === 0 ? { kind: 'reconciled' } : { kind: 'unreconciled', invocations };
}
