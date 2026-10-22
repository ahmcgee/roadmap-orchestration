// Fault isolation (1.0.0-dev.17, plan A): what the scheduler (src/schedule/scheduler.ts) does with an error a unit's task or
// an arc job throws. The boundary is the scheduler's task wrapper, which knows what the task holds, read back from the log
// at the throw (never from the throw site):
//
//   shared state   the unit's publication holds the integration slot (candidate through ff and snapshot); one of the
//                  task's own ops is open on shared state (`OP_CLASS` `shared`: a spec patch, the durable half of the
//                  revision fence a machine patch holds; a candidate merge, an ff, a snapshot, a docs commit, a revision,
//                  a needs-user raise, a command); a checkpoint job with a docs publication or a batch on the slot. The
//                  fault crashes the executor as before (the supervisor restarts it, 3 an hour). So does a fault the
//                  wrapper cannot attribute: a throw in the scheduler loop never reaches a wrapper, and a broken journal
//                  writer refuses the fault's own record. The in-process half of the fence is released by its holder's
//                  `finally` before the wrapper sees the throw.
//   unit-confined  everything else the task holds is its own: its worktrees, branch, evidence, records, reservations and
//                  processes. They are settled as recovery would settle a dead holder's (`settleFaulted`): its live
//                  invocations killed and closed, each of its own open ops (`OWN_KINDS`) closed by its reconciler, a
//                  faulted act never re-run blindly (a redo that throws again is aborted `fault`), its reservations
//                  cleaned. Then a unit parks `executor-fault` at the stage it was in (its open attempt, or the stage it
//                  was about to start): uncharged, operator env, the stack in the fact's detail and in a non-blocking
//                  needs-user; `resume <unit>` re-enters that stage. A restart replays the park, never the throw. An arc
//                  job (`JOB_FAULT_TRACKS`: audit, walk, checkpoint, baseline) ends faulted the same way: a non-blocking
//                  needs-user (parent `arc`, reason `executor-fault`), and the holistic track is not asked again while
//                  that item is open (`jobFaultOpen`): acknowledging it makes the job due again.
import { crashPoint } from '../core/crash.ts';
import type { Holder, IntentRecord, OpKind, OutcomeStage, Parent } from '../core/events.ts';
import { type JobKind, type UnitId, invocationId, parseJobId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { openAttempt } from '../core/state.ts';
import type { AbsPath } from '../core/values.ts';
import type { PlanUnit } from '../input/plan.ts';
import { raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
import { NO_PARK_FACTS } from '../park/table.ts';
import type { StageContext, StageParent } from '../pipeline/dispatch.ts';
import { invocationDir, killWorkload, liveRunner, quiescent } from '../pipeline/invoke.ts';
import { specFacts } from '../pipeline/reproduce.ts';
import { record } from '../pipeline/stages.ts';
import { type UnitResult, haltResult, upcoming } from '../pipeline/unit.ts';
import { killReconciler } from '../recover/kill.ts';
import { settleFaultedOp } from '../recover/recover.ts';
import { settleHolders } from '../recover/resource.ts';
import { spawnReconciler } from '../recover/spawn.ts';
import { resourceTable } from '../resources/reserve.ts';
import { runnerFiles } from '../runner/files.ts';

/**
 * Every op kind by what an open one of a faulted task's means: `own` (its checkouts, branch and evidence: settled),
 * `shared` (the fault crashes), `process` (its invocations: killed and closed), `reservation` (cleaned with its holder).
 */
const OP_CLASS: { readonly [K in OpKind]: 'own' | 'shared' | 'process' | 'reservation' } = {
  'worktree.create': 'own', 'worktree.remove': 'own', 'evidence.snapshot': 'own', 'salvage.commit': 'own', 'mergein.prepare': 'own', 'mutant.apply': 'own',
  'spec.patch': 'shared', 'candidate.merge': 'shared', 'integration.ff': 'shared', 'snapshot.publish': 'shared', 'needsuser.raise': 'shared',
  'command.apply': 'shared', 'docs.commit': 'shared', 'revision.commit': 'shared',
  'proc.spawn': 'process', 'proc.kill': 'process',
  'resource.transition': 'reservation',
};

/** The stages a unit may park `executor-fault` at: every outcome stage but `ff` and `snapshot`, which hold the slot. */
type FaultStage = Exclude<OutcomeStage, 'ff' | 'snapshot'>;
const FAULT_STAGES: readonly FaultStage[] = ['prepare', 'reproduce', 'plan-check', 'build', 'quiesce', 'evidence', 'salvage', 'teardown', 'lanes', 'gate', 'candidate'];

/** The arc jobs whose faults are contained (their scheduler track key), with the job kinds their work runs under. */
export const JOB_FAULT_TRACKS: Readonly<Record<string, Readonly<{ name: string; kinds: readonly JobKind[] }>>> = {
  'holistic:audit': { name: 'audit', kinds: ['audit'] },
  'holistic:walk': { name: 'milestone walk', kinds: ['walk'] },
  'holistic:checkpoint': { name: 'checkpoint', kinds: ['ckpt'] },
  'holistic:baseline': { name: 'baseline', kinds: ['baseline'] },
};

/** Whose fault: a unit's task, or an arc job's (its work's job kinds). */
type FaultScope = Readonly<{ type: 'unit'; unit: UnitId }> | Readonly<{ type: 'job'; kinds: readonly JobKind[] }>;

/** The parent an op's chain of op parents ends in (a kill is parented by the spawn it kills). */
function rootParent(view: JournalView, parent: Parent): Parent {
  return parent.type === 'op' ? rootParent(view, view.latestIntent(parent.op).parent) : parent;
}

const ownsParent = (scope: FaultScope, parent: Parent): boolean =>
  scope.type === 'unit' ? parent.type === 'stage' && parent.unit === scope.unit : parent.type === 'job' && scope.kinds.includes(parseJobId(parent.job).kind);

const ownsHolder = (scope: FaultScope, holder: Holder): boolean =>
  scope.type === 'unit' ? holder.type === 'stage' && holder.unit === scope.unit : holder.type === 'job' && scope.kinds.includes(parseJobId(holder.job).kind);

/** The task's open intents: by their parent's root, a reservation's by its holder. */
function openOf(view: JournalView, scope: FaultScope): readonly IntentRecord[] {
  return view.openIntents().filter((i) => (i.kind === 'resource.transition' ? ownsHolder(scope, i.expect.holder) : ownsParent(scope, rootParent(view, i.parent))));
}

/** What shared state the task holds now (see the header), or null when it holds only its own. */
function sharedHeld(view: JournalView, scope: FaultScope): string | null {
  const op = openOf(view, scope).find((i) => OP_CLASS[i.kind] === 'shared');
  if (op !== undefined) return `its ${op.kind} ${op.op} is open`;
  for (const [resource, { status }] of resourceTable(view)) {
    if (status.state === 'free' || status.state === 'cleanup-failed') continue;
    const h = status.holder;
    if (scope.type === 'unit' && h.type === 'publication' && h.unit === scope.unit) return `its publication holds ${resource}`;
    if (scope.type === 'job' && scope.kinds.includes('ckpt') && (h.type === 'docs' || h.type === 'batch')) return `a ${h.type} publication holds ${resource}`;
  }
  return null;
}

const stackOf = (error: unknown): string => (error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error));
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * What a faulted task left, settled as recovery settles a dead holder's: open kills reconciled; live invocations killed,
 * then closed by the spawn reconciler; own ops closed (`settleFaultedOp`); its reservations cleaned (`settleHolders`).
 * Afterwards nothing of the task is open.
 */
async function settleFaulted(ctx: StageContext, scope: FaultScope, fault: string): Promise<void> {
  const view = (): JournalView => ctx.journal.view;
  const kill = killReconciler(ctx);
  for (const i of openOf(view(), scope)) if (i.kind === 'proc.kill') await kill(i, view());
  const spawn = spawnReconciler(ctx);
  for (const i of openOf(view(), scope)) {
    if (i.kind !== 'proc.spawn') continue;
    const inv = invocationId(i.op, i.ordinal);
    const target = { inv, scope: 'invocation', reason: 'recovery' } as const;
    if (liveRunner(runnerFiles(invocationDir(ctx.runDir, inv), inv)) !== null || !quiescent(ctx, target)) await killWorkload(ctx, target);
    await spawn(i, view());
  }
  for (const i of openOf(view(), scope)) if (OP_CLASS[i.kind] === 'own') await settleFaultedOp(ctx, i, fault);
  await settleHolders(ctx, (h) => ownsHolder(scope, h));
  const left = openOf(view(), scope);
  if (left.length > 0) throw new Error(`a faulted task still has ${left.map((i) => `${i.kind} ${i.op}`).join(', ')} open after its settlement`);
}

/** The attempt a unit's fault parks: its open attempt, or a new one of the stage it was about to start; null when none is a fault stage. */
function faultedAttempt(ctx: StageContext, unit: PlanUnit): (StageParent & Readonly<{ stage: FaultStage }>) | null {
  const view = ctx.journal.view;
  const open = openAttempt(view, unit.id);
  const u = view.unit(unit.id);
  const next = open === null ? upcoming(u, specFacts(ctx)(unit).reproduces) : null;
  const stage = open?.stage ?? next?.stage ?? null;
  const fault = FAULT_STAGES.find((s) => s === stage);
  if (fault === undefined) return null;
  return { type: 'stage', unit: unit.id, stage: fault, attempt: open?.attempt ?? u.counters.attempts + 1 };
}

/** A settlement that throws leaves the fault uncontained: the executor crashes with both errors. */
async function contain<T>(error: unknown, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (settling) {
    throw new Error(`containing an executor fault failed (${messageOf(settling)}); the fault: ${stackOf(error)}`, { cause: settling });
  }
}

/**
 * A unit's task threw `error`. Unit-confined (see the header): settles what it left, parks it `executor-fault` at its
 * stage and returns the park (the scheduler raises its item). Null when the task held shared state, or its unit has no
 * stage to park at: the caller crashes.
 */
export async function faultUnit(ctx: StageContext, unit: PlanUnit, error: unknown): Promise<UnitResult | null> {
  const scope: FaultScope = { type: 'unit', unit: unit.id };
  if (sharedHeld(ctx.journal.view, scope) !== null) return null;
  const parent = faultedAttempt(ctx, unit);
  if (parent === null) return null;
  return contain(error, async () => {
    await settleFaulted(ctx, scope, `executor fault in ${unit.id} ${parent.stage}#${parent.attempt}: ${messageOf(error)}`);
    record<FaultStage>(ctx, parent, 'executor-fault', null, NO_PARK_FACTS, undefined, { kind: 'executor-fault', stack: stackOf(error) });
    crashPoint('fault.after-park', unit.id);
    const halted = haltResult(ctx, unit);
    if (halted === null) throw new Error(`unit ${unit.id} parked executor-fault, but its decision halts nothing`);
    return halted;
  });
}

/**
 * An arc job's work under track `key` threw `error`. For a job of `JOB_FAULT_TRACKS` holding only its own state: settles
 * what it left and raises its non-blocking `executor-fault` item (parent `arc`), and returns true; the holistic track waits
 * for that item (`jobFaultOpen`). False otherwise: the caller crashes.
 */
export async function faultJob(ctx: StageContext, key: string, error: unknown): Promise<boolean> {
  const track = JOB_FAULT_TRACKS[key];
  if (track === undefined) return false;
  const scope: FaultScope = { type: 'job', kinds: track.kinds };
  if (sharedHeld(ctx.journal.view, scope) !== null) return false;
  return contain(error, async () => {
    await settleFaulted(ctx, scope, `executor fault in the ${track.name} job: ${messageOf(error)}`);
    raiseNeedsUser(ctx.journal, ctx.runDir, {
      blocking: false, subject: { type: 'arc' }, reason: 'executor-fault',
      summary: `The executor threw in the ${track.name} job while it held only its own state; the job ended faulted and the arc went on without it. The executor threw: ${stackOf(error)}`,
      recommendation: `Fix the cause (an executor defect, or what the job's lanes left), then acknowledge this item: the ${track.name} job is due again.`,
      options: [], evidence: [],
    }, { type: 'arc' });
    return true;
  });
}

/** Whether an arc job's `executor-fault` item (parent `arc`) is still unacknowledged: the holistic track waits for it. */
export function jobFaultOpen(view: JournalView, runDir: AbsPath): boolean {
  return view.opsOf('needsuser.raise').some((i) => i.parent.type === 'arc' && view.doneOf(i.op) !== null && view.ackOf(i.expect.id) === null
    && readNeedsUser(runDir, i.expect.id)?.reason === 'executor-fault');
}
