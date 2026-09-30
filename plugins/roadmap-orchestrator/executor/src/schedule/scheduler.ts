// The scheduler (M2 "Scheduler model"; A12, A17, F5, F13, F19, G2; M3 B7): runs every unit of the arc that may run,
// each in its own task, and the holistic layer's jobs, from one non-reentrant loop that never awaits long work.
//
// Each iteration (every POLL_MS, or sooner when a task or job wakes it):
//   1. poll the command queue and apply control commands (pause, stop, ack) synchronously as facts; kills of
//      the live invocations a pause or stop ends start as tracked jobs (`proc.kill`, once per invocation);
//   2. start one job per pending mutation (resume, sweep, apply, resolve-edge, run-only, and the M3 commands) whose
//      scope (`commandScope`, A12) is clear: every unit in it idle or awaiting admission, no earlier pending
//      mutation overlapping it, and no probe running on a target it probes. A command with a job is never
//      started again; one whose op a crashed executor left open is recovery's;
//   3. start the probe jobs that are due (`prober.due`), at most one per target;
//   4. raise the needs-user items now due: a halted unit's (an operator park, a stop; a design park's per OR-Q1,
//      below) and the park schedule's (escalations, breakers; src/park/schedule.ts); in a holistic arc also the
//      findings' (`raiseFindingItems`) and an owed audit's (`raiseAuditOwed`); then the holistic jobs (below); then,
//      with nothing running and no mutation pending, end `complete` when the completion predicate holds (below);
//   5. start a task for every active unit without one whose next stage is a chain (a recovered park's), then for
//      every ready unit without one (`ready`), and admit waiting tasks (`admitter`), less the scheduler's own holds
//      (below);
//   6. re-evaluate the arbiter (it is also woken by every release: a task's or a job's end), then write the
//      derived `sched.json` (`SCHED_FILE`) when it changed: each task's state, the arbiter's queues (the units'
//      and, first-served, the jobs': docs publications, batches, job lanes) and the pending mutations' scopes, for
//      `status` only. Nothing reads it for a decision; a restart rebuilds all of it in memory.
// Jobs and tasks never block polling: the loop only starts them and reads their ends.
//
// A task runs its unit's stage loop (`runUnit`) with a per-task StageContext: the arbiter's `acquire`, the
// log's rank and the task's own signal, aborted with `pause` or `stop` only. At most one task per unit (a
// second start throws). A task is `idle` (none), `awaiting-admission` (at an admission boundary, waiting for
// step 5), `in-stage` or `in-chain` (A12). Admission is re-checked at every admission boundary of every task
// (F13, A17): a pause, a stop or a unit no longer active ends the task there (the unit holds nothing, F5); any
// other constraint (a drain, a parked backend, a tripped breaker, run-only, base-red, a blocking item, a hold)
// keeps it waiting. Chain stages (quiesce → evidence → salvage → teardown; ff → snapshot) are never gated: they run
// to completion under pause, drain and stop (F5).
//
// Start and restart (G2): before the loop's first iteration a published repair batch a crash cut short is finished
// (`finishBatch`: recovery leaves its slot held), a terminal snapshot the ref lacks is published (G8), and a task is
// started for every unit whose decided next stage is a chain stage (recovery kept a green publication's slot; a
// build's chain has its reservation cleaned), whatever pause or readiness says, and for every merged unit (its
// retire is re-runnable). Step 5 does the same for a unit a recovered retryable park returned to a chain stage.
//
// Pause: `pause <u>` aborts u's task (its waits end: an entry reservation, a later lane's set, a clear host) and
// kills u's live backend, lane, journey and mutant invocations, which their stage records as `interrupted`; `pause
// --all` does so for every unit. Stop (a `stop` command, or a unit whose outcome stops the arc): every task is
// aborted and every live backend, lane, journey, mutant, smoke, lens and checkpoint invocation killed (a probe's
// included; a killed lens call abandons its audit, which runs again later); teardowns and reclaims run to their end,
// as do chains and docs publications (a revision's or the close-out: their lanes are never killed, a critical
// section like a publication chain). Control commands keep applying meanwhile. Once every task and job has settled, `recoverReservations` cleans what a stage still holds, and the
// run ends `stop`.
//
// The holistic layer (M3; only while the plan in force names a vision, A5). One holistic job runs at a time, in
// this order of preference: the baseline witness (`runBaseline`, A6) while one is owed; the checkpoint
// (`runCheckpoint`, B6) while one is due or running; the cadence audit (`runAudit`, B5) while one is due or running
// (one audit at a time, its clock `processClock`). A job that waits on a condition a command changes (skipped for a
// parked backend or a paused arc, an interrupted call, nothing due) is not asked again for HOLISTIC_RETRY_MS. One whose
// lane gave no verdict is retried on the retryable-park backoff (`noVerdictDelayMs`: 1, 2, 4, 8, 16, then every 30
// minutes) and, once its episode is PARK_ESCALATE_MS old, raises one non-blocking `park-escalated` parented by the job
// (`escalateNoVerdict`, D2); progress ends the episode. Beside it, a
// repair batch (`publishBatch`, B2) and the close-out publication each run as a job of their own. Jobs and units
// share the arbiter and `@cpu` (the jobs' waits are served first, `acquireFirst`).
//
// The scheduler's holds (on top of admission's, src/schedule/ready.ts):
//   - baseline (A6): while the baseline is owed or running, or its blocking `obligation-baseline` is open, no unit
//     is admitted to any stage (chains run on).
//   - batch (R7, B2): the candidate of an approved unit repairing a finding directly waits while another active
//     unit repairs that finding directly and is not approved yet; once every such unit (at least two) waits at its
//     candidate they publish as one batch. A red batch records `red` for each member its own selection attributes
//     (a fix round each, `batchMemberFix`); a red nothing attributes, a conflict, a base red, an occupied lane or a
//     foreign move raises one blocking item and the members wait for its acknowledgement; members whose approval no
//     longer holds at the tip leave the batch (each takes its own candidate, whose ff re-gates it).
//
// Design parks (OR-Q1, `designParkRoute`): in a holistic arc a design park goes to the checkpoint first, and its
// own item waits; a checkpoint that respecified the unit re-opens it on its pending revision (`reopened`), one that
// decided nothing for it (or a respec the unit cannot re-open on) raises the park's item, and a second design park
// on a respecified lineage raises `respec-second` from the checkpoint instead.
//
// Ends. Every arc ends by the completion predicate (§2.10, `completionBlockers`). An arc without the holistic layer
// completes as in M2 (nothing runs, every unit merged, cut, superseded or parked for the architect, no own-arc residue,
// no blocking needs-user, no pending command; no close-out). A holistic arc ends
// `complete` when every unit is merged, cut or
// superseded; no blocking item; no pending command; no own-arc residue; no baseline owed; no audit running or due,
// no lens of L with an outstanding range, no owed trigger; no checkpoint due or running; the latest generation
// quiescent under the vision in force; the close-out publication done (the head is its commit) or nothing to
// change; every non-exempt obligation held on the head. The close-out (A8, `publishCloseOut`) runs once all but
// itself and the obligations hold (its lanes witness every arc lane on the head it publishes, or on the head alone
// when nothing changes). Then, for every arc, `arc-completed{planRev, head, highWater, units}` (once while active) and
// the terminal snapshot (parent `arc`, G8), so `gc` can seal it, and the run ends `complete`. The completion stays active while the plan rev and the
// head are those it recorded (A20); an admitting apply or a reopen invalidates it, and the arc runs again.
import type { CommandContext } from '../commands/apply.ts';
import { applyCommand, applyControl } from '../commands/apply.ts';
import { isControl, pollCommands, POLL_MS } from '../commands/queue.ts';
import { dirname, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { type IntentOf, JUDGMENT_STAGES, type Parent, probeTargetKey } from '../core/events.ts';
import { atomicJson, canonicalJson } from '../core/fsx.ts';
import {
  type ArcId, type CommandId, type FindingId, type InvocationId, type JobId, type LaneId, type NeedsUserId, type OpId, type Sha, type UnitId, arcId, commandId, findingId,
  invocationId, jobIdOf, jobIdOfKind, parseJobId, resourceName, unitId,
} from '../core/ids.ts';
import type { Containment, Journal, JournalView } from '../core/interfaces.ts';
import { type CommandFile, type NeedsUserContent, STAGES, type Stage } from '../core/records.ts';
import { type Read, arrayOf, bool, literal, nat, object, oneOf, positive, tagged, version } from '../core/validate.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../core/version.ts';
import { revParse } from '../git/git.ts';
import { jobEvidenceRoot, snapshotRequestOf } from '../git/snapshot.ts';
import { type AuditContext, auditPending, raiseAuditOwed, runAudit } from '../holistic/audit.ts';
import { cadence, integrationHeadNow, processClock } from '../holistic/cadence.ts';
import { type CheckpointContext, type DesignParkRoute, checkpointPending, designParkRoute, runCheckpoint, settleLatest } from '../holistic/checkpoint.ts';
import { quiescentGenerations } from '../holistic/convergence.ts';
import { coverageOf } from '../holistic/coverage.ts';
import { isActive, raiseFindingItems } from '../holistic/findings.ts';
import { isExempt, laneRevOf } from '../holistic/types.ts';
import { type Observation, verdictOf as witnessVerdict } from '../holistic/observe.ts';
import type { RoutingBase } from '../input/inforce.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { commandScope } from '../input/classify.ts';
import { type PlanM1, type PlanUnit, lensSetOf } from '../input/plan.ts';
import { type BlockingItem, blockingItems, holdsUnit, raiseNeedsUser, raisedFor, readNeedsUser } from '../needsuser.ts';
import type { ProberHandle } from '../park/probe.ts';
import { raiseDue as raiseScheduleDue, trippedTargets } from '../park/schedule.ts';
import { baselineDue, runBaseline } from '../pipeline/baseline.ts';
import { type StageContext, runOp } from '../pipeline/dispatch.ts';
import { type BatchOutcome, finishBatch, findingBlocking, heldBatch, publishBatch } from '../pipeline/integrate.ts';
import { invocationDir, killWorkload } from '../pipeline/invoke.ts';
import { observations } from '../pipeline/lanes.ts';
import { type DocsContext, closeOutFiles, endDetail, publishCloseOut } from '../pipeline/publish.ts';
import { repairUnits, specFacts } from '../pipeline/reproduce.ts';
import { at, executorIdentity, holisticInForce, record, start } from '../pipeline/stages.ts';
import { type Gate, type UnitResult, haltResult, runUnit, upcoming } from '../pipeline/unit.ts';
import { snapshotPublishOp } from '../recover/ops.ts';
import { recoverReservations } from '../recover/resource.ts';
import { holderStage } from '../resources/reserve.ts';
import { runnerFiles } from '../runner/files.ts';
import type { Arbiter, FirstHolder } from './arbiter.ts';
import { admitter, nextStage, rankOf, ready } from './ready.ts';
import { type AdmissionStage, type CommandScope, PARK_ESCALATE_MS, PROBE_BACKOFF_MIN, type ResourceRequest, type TaskState } from './types.ts';

// ---------------------------------------------------------------------------------------------------
// sched.json: the scheduler's in-memory view, for `status` only

/** The derived scheduler view in the run dir, rewritten on change. Non-authoritative: never read for a decision. */
export const SCHED_FILE = 'sched.json';

const TASK_STATES = ['idle', 'awaiting-admission', 'in-stage', 'in-chain'] as const satisfies readonly TaskState[];

/** One waiter of the arbiter, in the order it serves them: the unit, the stage attempt it waits for, what it asks. */
export type QueueEntry = Readonly<{ unit: UnitId; stage: Stage; attempt: number; publication: boolean; request: ResourceRequest; envBlocked: boolean }>;

/** M3 (B7): one job's waiter, served before every unit's: a docs publication's or a batch's slot, or a job's lanes. */
export type JobQueueEntry = Readonly<{ holder: FirstHolder; request: ResourceRequest; envBlocked: boolean }>;

/**
 * `sched.json`: written by the executor process `pid` (status trusts it only while that executor owns the
 * run). `tasks`: every unit with a task (a unit without one is idle). `queue`: the units' waiters, served
 * first to last. `jobQueue` (M3): the jobs' waiters, served before every unit's, in arrival order (a 1.0.0-dev.5
 * executor's file has none: read as empty). `drains`: the pending mutations, in submission order, with their
 * scopes (A12).
 */
export type SchedFile = Readonly<{
  v: SchemaVersion;
  arc: ArcId;
  pid: number;
  tasks: readonly Readonly<{ unit: UnitId; state: TaskState }>[];
  queue: readonly QueueEntry[];
  jobQueue: readonly JobQueueEntry[];
  drains: readonly Readonly<{ command: CommandId; scope: CommandScope }>[];
}>;

const units: Read<readonly UnitId[]> = arrayOf((v, p) => unitId(v, p));
const request: Read<ResourceRequest> = object((f) => ({
  named: f.get('named', arrayOf((v, p) => resourceName(v, p))), pools: f.get('pools', arrayOf((v, p) => resourceName(v, p))),
  cpu: f.get('cpu', nat), publication: f.get('publication', bool),
}));
const scope: Read<CommandScope> = tagged('type', {
  arc: object((f): CommandScope => ({ type: f.get('type', literal('arc')) })),
  units: object((f): CommandScope => ({ type: f.get('type', literal('units')), units: f.get('units', units) })),
  none: object((f): CommandScope => ({ type: f.get('type', literal('none')) })),
});
const firstHolder: Read<FirstHolder> = tagged('type', {
  docs: object((f): FirstHolder => ({ type: f.get('type', literal('docs')), pub: f.get('pub', jobIdOfKind('docs')) })),
  batch: object((f): FirstHolder => ({ type: f.get('type', literal('batch')), finding: f.get('finding', findingId), attempt: f.get('attempt', positive) })),
  job: object((f): FirstHolder => ({ type: f.get('type', literal('job')), job: f.get('job', jobIdOf) })),
});

export const schedFile: Read<SchedFile> = object((f) => ({
  v: f.get('v', version),
  arc: f.get('arc', (v, p) => arcId(v, p)),
  pid: f.get('pid', positive),
  tasks: f.get('tasks', arrayOf(object((g) => ({ unit: g.get('unit', (v, p) => unitId(v, p)), state: g.get('state', oneOf(TASK_STATES)) })))),
  queue: f.get('queue', arrayOf(object((g): QueueEntry => ({
    unit: g.get('unit', (v, p) => unitId(v, p)), stage: g.get('stage', oneOf(STAGES)), attempt: g.get('attempt', positive),
    publication: g.get('publication', bool), request: g.get('request', request), envBlocked: g.get('envBlocked', bool),
  })))),
  // A derived view a live 1.0.0-dev.5 executor may still be writing during an upgrade: absent reads as no job waits.
  jobQueue: f.optional('jobQueue', arrayOf(object((g): JobQueueEntry => ({
    holder: g.get('holder', firstHolder), request: g.get('request', request), envBlocked: g.get('envBlocked', bool),
  })))) ?? [],
  drains: f.get('drains', arrayOf(object((g) => ({ command: g.get('command', (v, p) => commandId(v, p)), scope: g.get('scope', scope) })))),
}));

/** How a unit ended the run. */
export type UnitSummary =
  | Readonly<{ unit: UnitId; result: 'merged' }>
  | Readonly<{ unit: UnitId; result: 'parked'; needsUser: NeedsUserId }>
  | Readonly<{ unit: UnitId; result: 'cut' }>
  | Readonly<{ unit: UnitId; result: 'superseded'; by: UnitId }>;

/** Why the scheduler returned. Anything else is a thrown error: a crash. */
export type SchedulerEnd =
  /** The arc is complete (M2: every unit settled; holistic: the completion predicate, `arc-completed` written). */
  | Readonly<{ kind: 'complete'; units: readonly UnitSummary[] }>
  /** A `stop` command, or a unit whose outcome stopped the arc (its needs-user is raised). */
  | Readonly<{ kind: 'stop'; cause: 'command' | 'unit'; needsUser: NeedsUserId | null }>;

/**
 * What the scheduler runs with: the run's arbiter (the one `stage.acquire` is), its prober, and its stop
 * controller, whose signal `commands.probes` carries: the scheduler aborts it (reason `stop`) when the run
 * stops, which ends probe jobs and mutation effects the stop cut short.
 */
export type SchedulerContext = Readonly<{
  stage: StageContext;
  commands: CommandContext;
  arbiter: Arbiter;
  prober: ProberHandle;
  stop: AbortController;
}>;

type Waiting = Readonly<{ stage: AdmissionStage; resolve: (go: boolean) => void }>;

type Task = {
  readonly unit: UnitId;
  state: TaskState;
  readonly abort: AbortController;
  waiting: Waiting | null;
};

/** Invocation purposes a pause kills among a paused unit's spawns. */
const PAUSE_KILLS: readonly string[] = ['backend', 'lane', 'journey', 'mutant'];
/** Invocation purposes a stop kills (lens and checkpoint calls included; never a docs publication's lanes). */
const STOP_KILLS: readonly string[] = ['backend', 'lane', 'smoke', 'journey', 'mutant', 'arc-backend'];

/** A holistic job that made no progress is asked again only this long after. */
export const HOLISTIC_RETRY_MS = 5 * POLL_MS;

const scopeUnits = (scope: CommandScope, all: readonly UnitId[]): readonly UnitId[] =>
  scope.type === 'arc' ? all : scope.type === 'units' ? scope.units : [];

/** Two mutations conflict when their scopes share a unit (the arc shares every one), or both have none. */
function conflicts(a: CommandScope, b: CommandScope): boolean {
  if (a.type === 'none' || b.type === 'none') return a.type === b.type;
  if (a.type === 'arc' || b.type === 'arc') return true;
  return a.units.some((u) => b.units.includes(u));
}

/** The stage attempt whose outcome decided the unit's park or stop: what its needs-user is parented by. */
export function decidedParent(view: JournalView, unit: UnitId): Parent {
  const f = view.unit(unit).decided;
  if (f === null) throw new Error(`unit ${unit} has no decided outcome`);
  return { type: 'stage', unit, stage: f.stage, attempt: f.attempt };
}

/** Whether a parked unit waits for the architect: an operator park (a retryable one recovers by its probes). */
const operatorPark = (view: JournalView, unit: UnitId): boolean => view.unit(unit).park?.park.class !== 'retryable';

/**
 * Whether a unit is settled for the end of an arc without the holistic layer: merged, cut, superseded, or parked for
 * the architect (an operator park). A retryable park is probed until it recovers, so it is not; nor is an active or
 * held unit.
 */
export function unitSettled(view: JournalView, unit: UnitId): boolean {
  const s = view.unit(unit).status;
  return s === 'retired' || s === 'cut' || s === 'superseded' || (s === 'park-pending' && operatorPark(view, unit));
}

/**
 * Whether an arc without the holistic layer may end `complete` (blocking items aside): every unit settled and no
 * own-arc residue left. A residue is probed until reclaimed whether or not a park names it, so the arc waits for it
 * (`status` shows it under `host.probes`).
 */
export function arcSettled(view: JournalView, units: readonly Readonly<{ id: UnitId }>[]): boolean {
  return units.every((u) => unitSettled(view, u.id)) && view.residues().length === 0;
}

// ---------------------------------------------------------------------------------------------------
// The holistic layer's contexts

/** The contexts the holistic jobs run under: the audit's (a clock, the arbiter's first-served waits), the checkpoint's, the docs'. */
export type HolisticContexts = Readonly<{ audit: AuditContext; checkpoint: CheckpointContext; docs: DocsContext }>;

/** The holistic contexts over a run's stage and command contexts and its arbiter. */
export function holisticContexts(
  x: Readonly<{ stage: StageContext; commands: Pick<CommandContext, 'planFile' | 'routingBase' | 'docs'>; arbiter: Arbiter }>, clock = processClock(x.stage.journal.view),
): HolisticContexts {
  const audit: AuditContext = { ...x.stage, acquireFirst: x.arbiter.acquireFirst, clock };
  return {
    audit,
    checkpoint: { ...audit, planFile: x.commands.planFile, routingBase: x.commands.routingBase, docs: x.commands.docs },
    docs: { ...x.stage, planFile: x.commands.planFile, arbiter: x.arbiter },
  };
}

/** OR-Q1: what a unit's design park waits for (null outside a holistic arc, or for any other park). */
export type ParkRoute = (unit: UnitId) => DesignParkRoute | null;

/** The route of a run: `designParkRoute` over its checkpoint context (null for every park outside a holistic arc). */
export const designRoute = (h: HolisticContexts): ParkRoute => (unit) => designParkRoute(h.checkpoint, unit);

/** The route of an arc without the holistic layer: every park raises its own item. */
const NO_ROUTE: ParkRoute = () => null;

// ---------------------------------------------------------------------------------------------------
// Raising a unit's result

/**
 * OR-Q1: whether a design park's own item is raised now under `route`. `respecified`: the checkpoint applied a
 * revision for it, so a judgment-stage park re-opens on its pending revision (`reopened`, as `resume` would), and a
 * unit a planned unit re-enters goes on in its successor; either way no item. Otherwise its item is raised.
 */
function raisesParkItem(ctx: StageContext, unit: UnitId, route: DesignParkRoute): boolean {
  switch (route.kind) {
    case 'checkpoint':
    case 'respec-second':
      return false;
    case 'park-item':
      return true;
    case 'respecified': {
      const view = ctx.journal.view;
      const u = view.unit(unit);
      const p = u.pendingRevision;
      if (p !== null && u.decided !== null && (JUDGMENT_STAGES as readonly Stage[]).includes(u.decided.stage)) {
        ctx.journal.fact({ kind: 'reopened', unit, command: p.command, specRev: p.rev, specSha256: p.sha256 });
        return false;
      }
      return !ctx.plan().units.some((x) => x.reenters?.unit === unit);
    }
  }
}

/**
 * Writes the needs-user a unit's result carries, once (`raisedFor`): an operator park's or a stop's, parented by
 * the attempt that decided it (a design park's per `route`, OR-Q1); a hold's (a usage-limited backend), parented by
 * the held attempt. A retryable park asks nobody: its probes recover it, and it escalates on its own after 6 h (D2).
 */
export function raiseResult(ctx: StageContext, unit: UnitId, result: UnitResult, route: ParkRoute = NO_ROUTE): void {
  const { journal, runDir } = ctx;
  const view = journal.view;
  if (result.kind === 'parked' && !operatorPark(view, unit)) return;
  if (result.kind === 'parked' || result.kind === 'stopped') {
    const parent = decidedParent(view, unit);
    if (raisedFor(view, parent) !== null) return;
    const r = result.kind === 'parked' ? route(unit) : null;
    if (r !== null && !raisesParkItem(ctx, unit, r)) return;
    raiseNeedsUser(journal, runDir, result.needsUser, parent);
    return;
  }
  if (result.kind === 'held' && result.needsUser !== null) {
    const u = view.unit(unit);
    const parent: Parent = { type: 'stage', unit, stage: u.stage, attempt: u.counters.attempts };
    if (raisedFor(view, parent) === null) raiseNeedsUser(journal, runDir, result.needsUser, parent);
  }
}

// ---------------------------------------------------------------------------------------------------
// The completion predicate (§2.10)

/** Why a holistic arc is not `complete` now: each condition of §2.10 that fails, in this order. */
export const COMPLETION_BLOCKERS = [
  'units-open', 'blocking-items', 'pending-commands', 'residues', 'baseline-owed', 'audit-pending', 'coverage-outstanding', 'audit-owed',
  'checkpoint-pending', 'generation-not-quiescent', 'close-out', 'obligations-not-discharged',
] as const;
export type CompletionBlocker = (typeof COMPLETION_BLOCKERS)[number];

const TERMINAL: readonly string[] = ['retired', 'cut', 'superseded'];

/**
 * A6: the baseline the arc owes before any admission under holistic (`baselineDue`), or null. `baselineDue` reads the
 * tip now; a baseline job that already witnessed every arc lane on one tree the tip has since left is done.
 */
export function baselineOwed(ctx: StageContext): JobId | null {
  const job = baselineDue(ctx);
  if (job === null) return null;
  const lanes = holisticInForce(ctx).obligations?.lanes.map((l) => l.id) ?? [];
  const byTree = new Map<Sha, Set<LaneId>>();
  for (const w of ctx.journal.view.holistic().witnessed) {
    if (w.for.type !== 'job' || w.for.job !== job) continue;
    byTree.set(w.treeSha, (byTree.get(w.treeSha) ?? new Set()).add(w.lane));
  }
  const tree = integrationTree(ctx);
  const doneElsewhere = [...byTree].some(([t, seen]) => t !== tree && lanes.every((l) => seen.has(l)));
  return doneElsewhere ? null : job;
}

/** The integration head's tree now (the observation store's key). */
const integrationTree = (ctx: StageContext): Sha => revParse(ctx.repo, `${integrationHeadNow(ctx)}^{tree}`);

/**
 * Every non-exempt obligation (split parents through their children) on `head`: held, one not observed there, or one not
 * held. Each witness is read from the latest observation of its lane (at its rev) on the head's tree, in whichever
 * environment ran it (the scheduler and `status` read the same rule).
 */
export function obligationsOn(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; repo: AbsPath }>, head: Sha): 'discharged' | 'unobserved' | 'not-held' {
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) return 'discharged';
  const tree = revParse(ctx.repo, `${head}^{tree}`);
  const latest = new Map<string, Observation>();
  for (const o of observations(ctx).values()) {
    if (o.key.treeSha !== tree) continue;
    const k = `${o.key.lane}/${o.key.laneRev}`;
    const seen = latest.get(k);
    if (seen === undefined || o.seq > seen.seq) latest.set(k, o);
  }
  const lanes = new Map(obligations.lanes.map((l) => [l.id, l]));
  let unobserved = false;
  for (const o of obligations.obligations) {
    if (isExempt(o) || o.state.type === 'split' || o.witness === null) continue;
    const lane = lanes.get(o.witness.lane);
    if (lane === undefined) throw new Error(`obligation ${o.id} is witnessed on lane ${o.witness.lane}, which the obligations in force do not have`);
    const found = latest.get(`${lane.id}/${laneRevOf(lane)}`);
    if (found === undefined) unobserved = true;
    else if (witnessVerdict(found.record, o.witness) !== 'held') return 'not-held';
  }
  return unobserved ? 'unobserved' : 'discharged';
}

/** A8: the close-out at `head`: done (the head is the latest close-out's commit), nothing to change, or due. */
export function closeOutState(h: HolisticContexts, head: Sha): 'done' | 'nothing-to-change' | 'due' {
  const published = h.docs.journal.view.holistic().docsPublished.filter((d) => d.source === 'close-out').at(-1);
  if (published !== undefined && published.commit === head) return 'done';
  return closeOutFiles(h.docs, head).length === 0 ? 'nothing-to-change' : 'due';
}

/**
 * §2.10's `complete`: the conditions that fail now (none: complete). `blocking`: the open blocking items; `pending`: the
 * pending mutations. Every arc: `units-open` (holistic: a unit neither merged, cut nor superseded; without the layer, one
 * not settled as M2 settles it, an operator park settling), `blocking-items`, `pending-commands`, `residues`. A holistic
 * arc adds the baseline, audit, checkpoint, quiescence, close-out and obligation clauses (vacuous without the layer: an
 * arc without it has no close-out, its in-tree documents being none of the executor's renderings).
 */
export function completionBlockers(h: HolisticContexts, input: Readonly<{ blocking: number; pending: number }>): readonly CompletionBlocker[] {
  const ctx = h.audit;
  const view = ctx.journal.view;
  const fold = view.holistic();
  const plan = ctx.plan();
  const out = new Set<CompletionBlocker>();
  const head = integrationHeadNow(ctx);
  if (input.blocking > 0) out.add('blocking-items');
  if (input.pending > 0) out.add('pending-commands');
  if (view.residues().length > 0) out.add('residues');
  const holistic = plan.holistic;
  if (!fold.on || holistic === undefined) {
    if (!plan.units.every((u) => unitSettled(view, u.id))) out.add('units-open');
    return COMPLETION_BLOCKERS.filter((b) => out.has(b));
  }
  if (plan.units.some((u) => !TERMINAL.includes(view.unit(u.id).status))) out.add('units-open');
  if (baselineOwed(ctx) !== null) out.add('baseline-owed');
  if (auditPending(ctx)) out.add('audit-pending');
  const c = cadence(ctx, ctx.clock);
  if (c === null) throw new Error('a holistic arc without a cadence');
  if (coverageOf(fold, c.base, lensSetOf(holistic), c.head).some((x) => x.outstanding)) out.add('coverage-outstanding');
  if (c.owed.length > 0) out.add('audit-owed');
  if (checkpointPending(h.checkpoint)) out.add('checkpoint-pending');
  const g = Math.max(0, ...fold.audits.map((a) => a.started.generation), ...fold.checkpoints.map((x) => x.inputs.generation));
  const vision = view.planApplied()?.visionSha256;
  if (vision === undefined) throw new Error('a holistic arc whose plan in force records no vision');
  if (g > 0 && !quiescentGenerations(fold, vision).has(g)) out.add('generation-not-quiescent');
  if (closeOutState(h, head) === 'due') out.add('close-out');
  if (obligationsOn(ctx, head) !== 'discharged') out.add('obligations-not-discharged');
  return COMPLETION_BLOCKERS.filter((b) => out.has(b));
}

/**
 * The holistic contexts of a reader outside any executor (`status`): what the completion predicate reads. It runs no
 * job and writes nothing: every writing or process-running member throws.
 */
export function readOnlyContexts(x: Readonly<{
  view: JournalView; runDir: AbsPath; repo: AbsPath; hostDir: AbsPath; planFile: AbsPath; plan: () => PlanM1; hostEnv: Readonly<Record<string, string | undefined>>;
  routingBase: RoutingBase;
}>): HolisticContexts {
  const refuse = (what: string) => (): never => {
    throw new Error(`the completion predicate's reader ${what}: it only reads`);
  };
  const journal: Journal = {
    get view() {
      return x.view;
    },
    begin: refuse('began an op'), retry: refuse('retried an op'), done: refuse('closed an op'), abort: refuse('aborted an op'), fact: refuse('wrote a fact'),
  };
  const containment: Containment = { mode: 'session', launch: refuse('launched'), members: refuse('scanned'), kill: refuse('killed'), empty: refuse('scanned') };
  const stage: StageContext = {
    journal, containment, runDir: x.runDir, repo: x.repo, hostDir: x.hostDir, plan: x.plan, planDir: absPath(dirname(x.planFile)), hostEnv: x.hostEnv,
    routing: refuse('resolved routing'), acquire: refuse('reserved'), rank: refuse('ranked'), signal: new AbortController().signal,
  };
  const arbiter: Arbiter = { acquire: refuse('reserved'), acquireFirst: refuse('reserved'), wake: refuse('woke the arbiter'), waiting: refuse('read waiters'), waitingFirst: refuse('read waiters') };
  const commands = { planFile: x.planFile, routingBase: x.routingBase, docs: refuse('published docs') } as const;
  return holisticContexts({ stage, commands, arbiter });
}

/** G8: whether a terminal snapshot (parent `arc`) covers the completion at `seq`. */
function terminalSnapshotted(view: JournalView, seq: number): boolean {
  return view.opsOf('snapshot.publish').some((i) => i.parent.type === 'arc' && view.doneOf(i.op) !== null && i.expect.highWater >= seq);
}

/** G8: the terminal snapshot after the latest `arc-completed`, where the ref lacks it (a crash between the two). */
export async function terminalSnapshot(ctx: StageContext): Promise<void> {
  const view = ctx.journal.view;
  const c = view.holistic().completion;
  if (c === null) throw new Error('a terminal snapshot before any arc-completed');
  if (terminalSnapshotted(view, c.seq)) return;
  const arc = ctx.plan().arc;
  await runOp(ctx.journal, snapshotPublishOp(ctx.repo), `snapshot:${arc}`, { type: 'arc' }, snapshotRequestOf({
    view, runDir: ctx.runDir, identity: executorIdentity(), message: `roadmap ${arc}: terminal snapshot (arc completed at ${c.head}, plan rev ${c.planRev})\n`,
  }));
}

/**
 * Writes `arc-completed` for the plan in force and the integration head now, unless an active completion records them.
 * An arc started before plan revisions (1.0.0-dev.2, no `plan-applied`) completes without it (scaffolding).
 */
function completeArc(ctx: StageContext): void {
  const view = ctx.journal.view;
  if (view.holistic().completion?.active === true) return;
  const applied = view.planApplied();
  if (applied === null) {
    process.stderr.write('roadmap: upgrade (arc-completed): the arc has no plan revision (started before 1.0.0-dev.3); it completes without the fact\n');
    return;
  }
  const merged = ctx.plan().units.filter((u) => view.unit(u.id).status === 'retired').map((u) => u.id).sort();
  ctx.journal.fact({ kind: 'arc-completed', planRev: applied.rev, head: integrationHeadNow(ctx), highWater: view.highWater(), units: merged });
  crashPoint('complete.after-fact');
}

// ---------------------------------------------------------------------------------------------------
// A holistic job's progress, and the retry of one whose lane gave no verdict

/** What one run of a holistic job did: progress, a wait on a condition a command changes, or a lane without a verdict. */
type Progress = Readonly<{ kind: 'progress' }> | Readonly<{ kind: 'wait' }> | Readonly<{ kind: 'no-verdict'; job: JobId; detail: string }>;
const PROGRESS: Progress = { kind: 'progress' };
const WAIT: Progress = { kind: 'wait' };

/**
 * The wait before the `tries`-th retry of a job whose lane gave no verdict: the retryable-park backoff (PROBE_BACKOFF_MIN:
 * 1, 2, 4, 8, 16 minutes, then 30 repeatedly).
 */
export function noVerdictDelayMs(tries: number): number {
  if (!Number.isSafeInteger(tries) || tries < 1) throw new Error(`a no-verdict retry counts from 1, not ${tries}`);
  return PROBE_BACKOFF_MIN[Math.min(tries, PROBE_BACKOFF_MIN.length - 1)]! * 60_000;
}

/**
 * D2 for a job: its lanes have given no verdict since `since`, PARK_ESCALATE_MS or more: one non-blocking `park-escalated`
 * item, parented by the job (raised once per job); the retries go on.
 */
export function escalateNoVerdict(ctx: Readonly<{ journal: Journal; runDir: AbsPath }>, job: JobId, detail: string, since: number): NeedsUserId {
  const view = ctx.journal.view;
  const parent: Parent = { type: 'job', job };
  const key = canonicalJson(parent);
  const raised = view.opsOf('needsuser.raise').find((i) => canonicalJson(i.parent) === key && view.doneOf(i.op) !== null
    && readNeedsUser(ctx.runDir, i.expect.id)?.reason === 'park-escalated');
  if (raised !== undefined) return raised.expect.id;
  return raiseNeedsUser(ctx.journal, ctx.runDir, {
    blocking: false, subject: { type: 'arc' }, reason: 'park-escalated',
    summary: `Job ${job}'s lanes have given no verdict since ${new Date(since).toISOString()} (6 h or more; last: ${detail}). It is retried every 30 min.`,
    recommendation: `Read the job's evidence (${jobEvidenceRoot(ctx.runDir, job)}) and fix what keeps its lane from a verdict (a runner lost, a deadline, a resource); then acknowledge this item.`,
    options: [], evidence: [jobEvidenceRoot(ctx.runDir, job)],
  }, parent);
}

// ---------------------------------------------------------------------------------------------------
// Repair batches (R7, B2): what the scheduler records of a batch's outcome

/** The reserve ops of `finding`'s repair batches (each attempt's slot reservation), in log order. */
const batchReserveOps = (view: JournalView, finding: FindingId): readonly OpId[] => view.opsOf('resource.transition').flatMap((i) =>
  (i.expect.holder.type === 'batch' && i.expect.holder.finding === finding && i.expect.edge.type === 'reserve' ? [i.op] : []));

/** Whether an item raised for one of `finding`'s batches is open and blocking: its members wait for the architect. */
export function batchSuspended(view: JournalView, finding: FindingId): boolean {
  const ops = new Set<string>(batchReserveOps(view, finding));
  if (ops.size === 0) return false;
  const open = new Set(view.needsUser().filter((n) => n.blocking && n.ack === null).map((n) => n.id));
  return view.opsOf('needsuser.raise').some((i) => i.parent.type === 'op' && ops.has(i.parent.op) && open.has(i.expect.id));
}

/** What a batch's outcome leaves to the scheduler: whether it made progress, the members to retire, those leaving the batch. */
export type BatchSettled = Readonly<{ progress: boolean; retire: readonly UnitId[]; unbatch: readonly UnitId[] }>;

/**
 * Records a repair batch's outcome for its members (B2 decides, the scheduler records; see the header): a published
 * batch's members are retired by its ff (their retire is left); a red one's attributable members each record a candidate
 * `red` (a fix round, `batchMemberFix`), a transient violation its member's `transient-violation`; a red nothing
 * attributes, any other refusal, a base red, a foreign move or an occupied lane raises one blocking item, parented by the
 * attempt's slot reservation, for which the members wait (`batchSuspended`); stale members leave the batch.
 */
export function settleBatch(ctx: StageContext, finding: FindingId, members: readonly PlanUnit[], out: BatchOutcome): BatchSettled {
  const none: BatchSettled = { progress: true, retire: [], unbatch: [] };
  const memberOutcome = (unit: UnitId, kind: 'red' | 'transient-violation'): void => {
    record(ctx, at(start(ctx, unit, 'candidate'), 'candidate'), kind);
  };
  const raise = (content: NeedsUserContent): void => {
    const op = batchReserveOps(ctx.journal.view, finding).at(-1);
    if (op === undefined) throw new Error(`the batch of ${finding} has no reservation`);
    const parent: Parent = { type: 'op', op };
    if (raisedFor(ctx.journal.view, parent) === null) raiseNeedsUser(ctx.journal, ctx.runDir, content, parent);
  };
  const hold = (summary: string): void => raise({
    blocking: true, subject: { type: 'arc' }, reason: 'candidate-red',
    summary: `Repair batch ${out.job} for ${finding} (${members.map((m) => m.id).join(', ')}): ${summary}. Its members wait for this item.`,
    recommendation: 'Read the batch evidence and fix what it names (the base, the suite, or the repair plan with `roadmap apply`); then acknowledge this item: the batch runs again.',
    options: [], evidence: [jobEvidenceRoot(ctx.runDir, out.job)],
  });
  switch (out.kind) {
    case 'published':
      return { ...none, retire: members.map((m) => m.id) };
    case 'red':
      if (out.attributable.length === 0) hold('red on its candidate with a failure no member\'s own selection explains');
      for (const u of out.attributable) memberOutcome(u, 'red');
      return none;
    case 'refused':
      if (out.reason === 'transient-violation' && out.unit !== null) memberOutcome(out.unit, 'transient-violation');
      else hold(`its candidate was refused (${out.reason}${out.unit === null ? '' : ` at ${out.unit}`})`);
      return none;
    case 'base-red':
    case 'foreign-move':
      raise(out.needsUser);
      return none;
    case 'no-verdict':
      if (out.end.kind === 'occupied') raise(out.end.needsUser);
      return { ...none, progress: out.end.kind === 'occupied' };
    case 'stale':
      return { ...none, progress: out.invalid.length > 0, unbatch: out.invalid };
    case 'finding-blocked':
      return { ...none, progress: false };
  }
}

// ---------------------------------------------------------------------------------------------------
// The scheduler

export async function schedule(x: SchedulerContext): Promise<SchedulerEnd> {
  const { journal, runDir } = x.stage;
  const view = (): JournalView => journal.view;
  const plan = () => x.stage.plan();
  /** What admission and each unit's next stage read from its spec in force (M3 B3). */
  const specOf = specFacts(x.stage);
  const { arbiter } = x;
  const scopeOf = commandScope(x.commands);
  const h = holisticContexts(x);
  const holistic = (): boolean => view().holistic().on;
  const route = designRoute(h);
  // A crash right after a checkpoint's decision leaves no checkpoint due, so `runCheckpoint` (which settles too) would
  // not run: the decision's aftermath a crash cut short (a no-op's divergences, dispositions, the digest) is settled here.
  if (holistic()) settleLatest(h.checkpoint);

  const tasks = new Map<UnitId, Task>();
  const jobs = new Map<string, Promise<void>>();
  /** Probe targets a running `resume` job probes (or smokes): no scheduled probe job starts on them meanwhile. */
  const commandTargets = new Map<CommandId, readonly string[]>();
  /** The first error of a task or job: the loop rethrows it (a crash). */
  const failures: unknown[] = [];
  let stopping: Readonly<{ cause: 'command' | 'unit'; unit: UnitId | null }> | null = null;
  /** Holistic tracks (the one holistic job, the batch, the close-out) not asked again before this time (ms). */
  const retryAt = new Map<string, number>();
  /** Per track, the episode of consecutive runs whose lane gave no verdict (in memory: a restart starts a new one). */
  const noVerdict = new Map<string, { since: number; tries: number }>();
  /** Batch members whose approval no longer held at the tip (a stale batch): by the approval they had then. */
  const unbatched = new Map<UnitId, string>();
  /** Members a published batch retired: their retire runs in a task of their own. */
  const retiring = new Set<UnitId>();
  let lastTick = 0;

  let wakeup: (() => void) | null = null;
  const kick = (): void => wakeup?.();
  const settled = (): void => {
    arbiter.wake();
    kick();
  };
  const fail = (error: unknown): void => {
    failures.push(error);
    kick();
  };
  /** A stop's abort surfaces as its reason: the expected end of a job the stop cut short. */
  const cutByStop = (error: unknown): boolean => stopping !== null && error === 'stop';

  /** Tracks one job under `key`: it never blocks the loop; its end wakes it, a failure crashes the run. */
  const track = (key: string, work: () => Promise<unknown>): void => {
    if (jobs.has(key)) throw new Error(`job ${key} is already running`);
    const job = work().then(() => undefined, (error: unknown) => {
      if (!cutByStop(error)) fail(error);
    }).finally(() => {
      jobs.delete(key);
      settled();
    });
    jobs.set(key, job);
  };

  /**
   * Tracks a job of the holistic track `track` (`holistic`, `batch`, `closeout`) whose `work` says whether it made
   * progress; after one that made none the track is not asked again for HOLISTIC_RETRY_MS.
   */
  const trackRetrying = (key: string, trackKey: string, work: () => Promise<Progress>): void => {
    track(key, async () => {
      const p = await work();
      if (p.kind === 'progress') {
        noVerdict.delete(trackKey);
        return;
      }
      if (p.kind === 'wait') {
        retryAt.set(trackKey, Date.now() + HOLISTIC_RETRY_MS);
        return;
      }
      // A lane gave no verdict: the retryable-park backoff, and the escalation once the episode is 6 h old (D2).
      const now = Date.now();
      const episode = noVerdict.get(trackKey) ?? { since: now, tries: 0 };
      episode.tries += 1;
      noVerdict.set(trackKey, episode);
      retryAt.set(trackKey, now + noVerdictDelayMs(episode.tries));
      if (now - episode.since >= PARK_ESCALATE_MS) escalateNoVerdict(x.stage, p.job, p.detail, episode.since);
    });
  };
  /** Whether the holistic track `trackKey` may start a job now: none of its jobs runs and its retry time passed. */
  const due = (trackKey: string): boolean => ![...jobs.keys()].some((k) => k === trackKey || k.startsWith(`${trackKey}:`)) && (retryAt.get(trackKey) ?? 0) <= Date.now();

  const planUnit = (id: UnitId): PlanUnit => {
    const u = plan().units.find((p) => p.id === id);
    if (u === undefined) throw new Error(`unit ${id} is not in the plan in force`);
    return u;
  };

  // -------------------------------------------------------------------------------------------------
  // Tasks

  const startTask = (unit: PlanUnit): void => {
    if (tasks.has(unit.id)) throw new Error(`unit ${unit.id} already has a task`);
    const abort = new AbortController();
    // Until its first gate the task is starting synchronously, or finishing a merged unit's retire.
    const task: Task = { unit: unit.id, state: 'in-chain', abort, waiting: null };
    tasks.set(unit.id, task);
    const ctx: StageContext = { ...x.stage, acquire: arbiter.acquire, rank: (u) => rankOf(view(), plan(), u), signal: abort.signal };
    const gate: Gate = (next) => {
      if (next.kind === 'chain') {
        task.state = 'in-chain';
        return Promise.resolve(true);
      }
      task.state = 'awaiting-admission';
      kick();
      return new Promise<boolean>((resolve) => {
        task.waiting = { stage: next.stage, resolve };
      });
    };
    runUnit(ctx, unit, gate).then((result) => raiseResult(x.stage, unit.id, result, route)).catch(fail).finally(() => {
      tasks.delete(unit.id);
      settled();
    });
  };

  const endTask = (task: Task): void => {
    const w = task.waiting;
    if (w === null) return;
    task.waiting = null;
    task.state = 'idle';
    w.resolve(false);
  };

  // -------------------------------------------------------------------------------------------------
  // The scheduler's holds: the baseline (A6) and repair batches (R7)

  type Holds = Readonly<{ baseline: boolean; batch: ReadonlySet<UnitId> }>;
  const heldBack = (holds: Holds, unit: UnitId, stage: AdmissionStage): boolean => holds.baseline || (stage === 'candidate' && holds.batch.has(unit));

  const approvalKey = (unit: UnitId): string => canonicalJson(view().unit(unit).approval);

  type BatchPlan = Readonly<{ held: ReadonlySet<UnitId>; ready: Readonly<{ finding: FindingId; members: readonly PlanUnit[] }> | null }>;
  const NO_BATCH: BatchPlan = { held: new Set(), ready: null };

  /**
   * R7: for each active finding at least two active units repair directly (not yet published), the approved ones
   * waiting at their candidate are held; once all of them wait there (and none is finding-blocked), they are a batch.
   */
  const batchPlan = (): BatchPlan => {
    const v = view();
    if (!v.holistic().on) return NO_BATCH;
    const findings = v.holistic().findings.filter(isActive);
    if (findings.length === 0) return NO_BATCH;
    for (const [u, key] of unbatched) if (approvalKey(u) !== key) unbatched.delete(u);
    const repairs = repairUnits(x.stage);
    const held = new Set<UnitId>();
    let batch: BatchPlan['ready'] = null;
    for (const f of findings) {
      const direct = repairs.filter((r) => r.repairs.includes(f.id) && v.unit(r.unit).status === 'active' && !unbatched.has(r.unit)
        && (r.progress.kind === 'working' || r.progress.kind === 'approved'));
      if (direct.length < 2) continue;
      const waitingAtCandidate = direct.filter((r) => {
        const t = tasks.get(r.unit);
        const next = upcoming(v.unit(r.unit), specOf(planUnit(r.unit)).reproduces);
        return r.progress.kind === 'approved' && next?.kind === 'admission' && next.stage === 'candidate' && (t === undefined || t.state === 'awaiting-admission' || t.state === 'idle');
      });
      for (const r of waitingAtCandidate) held.add(r.unit);
      if (batch !== null || waitingAtCandidate.length !== direct.length || batchSuspended(v, f.id)) continue;
      const members = waitingAtCandidate.map((r) => planUnit(r.unit));
      if (members.some((m) => findingBlocking(x.stage, m) !== null)) continue;
      batch = { finding: f.id, members };
    }
    return { held, ready: batch };
  };

  // -------------------------------------------------------------------------------------------------
  // Admission and readiness

  const pendingMutations = (pending: readonly CommandFile[]): readonly Readonly<{ command: CommandFile; scope: CommandScope }>[] =>
    pending.filter((c) => !isControl(c.body)).map((command) => ({
      command, scope: scopeOf(command.body as Parameters<typeof scopeOf>[0], view(), plan()),
    }));

  const admissionInput = (blocking: readonly BlockingItem[], mutations: ReturnType<typeof pendingMutations>) => ({
    view: view(), plan: plan(), blocking, drains: mutations.map((m) => ({ command: m.command.id, scope: m.scope })), tripped: trippedTargets(view()),
  });

  const admitWaiting = (blocking: readonly BlockingItem[], mutations: ReturnType<typeof pendingMutations>, holds: Holds): void => {
    const admit = admitter((u) => x.stage.routing(u).table, specOf);
    const input = admissionInput(blocking, mutations);
    for (const task of tasks.values()) {
      const w = task.waiting;
      if (w === null) continue;
      const u = view().unit(task.unit);
      const next = upcoming(u, specOf(planUnit(task.unit)).reproduces);
      // Ended at this boundary: a pause or stop, or the unit moved on without it (cut, superseded, re-opened, retired).
      if (stopping !== null || task.abort.signal.aborted || u.status !== 'active' || next?.kind !== 'admission' || next.stage !== w.stage) {
        endTask(task);
        continue;
      }
      const a = admit({ ...input, unit: planUnit(task.unit), stage: w.stage });
      if (a.kind === 'wait' && a.constraints.some((c) => c.type === 'paused')) {
        endTask(task);
        continue;
      }
      if (a.kind !== 'admit' || blocking.some((b) => holdsUnit(b, task.unit)) || heldBack(holds, task.unit, w.stage)) continue;
      task.waiting = null;
      task.state = 'in-stage';
      w.resolve(true);
    }
  };

  /**
   * A task for every active unit without one whose decided next stage is a chain stage: at a start (G2), and
   * when a retryable park on a chain stage recovers (a teardown's cleanup-failed, a salvage's commit-failed: the
   * fold returns the unit to that stage, F9). Chains are never gated, so `ready` (admission stages) never offers
   * them. And a task for each member a published batch retired, whose retire is left.
   */
  const startChains = (): void => {
    for (const unit of plan().units) {
      const u = view().unit(unit.id);
      if (!tasks.has(unit.id) && u.status === 'active' && nextStage(u, specOf(unit).reproduces)?.kind === 'chain') startTask(unit);
    }
    for (const id of retiring) {
      if (tasks.has(id)) continue;
      retiring.delete(id);
      startTask(planUnit(id));
    }
  };

  const startReady = (blocking: readonly BlockingItem[], mutations: ReturnType<typeof pendingMutations>, holds: Holds): void => {
    for (const r of ready({ ...admissionInput(blocking, mutations), routing: (u) => x.stage.routing(u).table, spec: specOf })) {
      if (tasks.has(r.unit.id) || blocking.some((b) => holdsUnit(b, r.unit.id)) || heldBack(holds, r.unit.id, r.stage)) continue;
      startTask(r.unit);
    }
  };

  // -------------------------------------------------------------------------------------------------
  // Commands

  /** Kills every live invocation `which` selects, once per invocation and reason, as tracked jobs. */
  const killLive = (reason: 'pause' | 'stop', which: (intent: IntentOf<'proc.spawn'>) => boolean): void => {
    const v = view();
    for (const intent of v.openIntents()) {
      if (intent.kind !== 'proc.spawn' || !which(intent)) continue;
      const inv: InvocationId = invocationId(intent.op, intent.ordinal);
      const key = `kill:${inv}:${reason}`;
      if (jobs.has(key) || v.opsOf('proc.kill').some((k) => k.expect.inv === inv && k.expect.reason === reason)) continue;
      // A runner that has not written runner.json may not have exec'd yet: the next poll finds it.
      const files = runnerFiles(invocationDir(runDir, inv), inv);
      if (files.read('runner.json') === null || files.read('exit.json') !== null) continue;
      track(key, () => killWorkload(x.stage, { inv, scope: 'invocation', reason }));
    }
  };

  /** A stop kills a spawn unless it is a docs publication's lane: a revision's or the close-out's runs to its end (a critical section). */
  const stopKills = (intent: IntentOf<'proc.spawn'>): boolean =>
    STOP_KILLS.includes(intent.expect.subject.purpose) && !(intent.parent.type === 'job' && parseJobId(intent.parent.job).kind === 'docs');

  /** What pause and stop ask of the running tasks now, per the durable markers. */
  const interrupt = (): void => {
    const c = view().control();
    if (stopping !== null) {
      for (const task of tasks.values()) if (!task.abort.signal.aborted) task.abort.abort('stop');
      killLive('stop', stopKills);
      return;
    }
    const paused = (unit: UnitId): boolean => c.pausedAll || c.pausedUnits.includes(unit);
    for (const task of tasks.values()) if (paused(task.unit) && !task.abort.signal.aborted) task.abort.abort('pause');
    killLive('pause', (intent) => intent.parent.type === 'stage' && PAUSE_KILLS.includes(intent.expect.subject.purpose) && paused(intent.parent.unit));
  };

  /** The probe targets a mutation probes or smokes through the prober (`resume <u>` of a retryable park, `resume --backend`). */
  const probedBy = (command: CommandFile): readonly string[] => {
    const body = command.body;
    if (body.type !== 'resume') return [];
    if (body.target.type === 'backend') return [probeTargetKey({ type: 'backend', backend: body.target.backend })];
    if (body.target.type !== 'unit') return [];
    const park = view().unit(body.target.unit).park;
    if (park === null || park.park.class !== 'retryable') return [];
    const passed = new Set(park.passed.map(probeTargetKey));
    return park.park.targets.map(probeTargetKey).filter((k) => !passed.has(k));
  };

  const startMutations = (mutations: ReturnType<typeof pendingMutations>): void => {
    const v = view();
    const open = new Set(v.opsOf('command.apply').filter((i) => v.doneOf(i.op) === null).map((i) => i.expect.command));
    const all = plan().units.map((u) => u.id);
    const running = new Set(x.prober.running());
    const earlier: CommandScope[] = [];
    for (const { command, scope } of mutations) {
      const key = `cmd:${command.id}`;
      const blockedByEarlier = earlier.some((e) => conflicts(e, scope));
      earlier.push(scope);
      if (jobs.has(key) || open.has(command.id) || blockedByEarlier) continue;
      const busy = scopeUnits(scope, all).some((u) => {
        const t = tasks.get(u);
        return t !== undefined && t.state !== 'awaiting-admission' && t.state !== 'idle';
      });
      const probes = probedBy(command);
      if (busy || probes.some((k) => running.has(k))) continue;
      commandTargets.set(command.id, probes);
      track(key, async () => {
        try {
          await applyCommand(x.commands, command);
        } finally {
          commandTargets.delete(command.id);
        }
      });
    }
  };

  // -------------------------------------------------------------------------------------------------
  // Probes and needs-user

  const startProbes = (): void => {
    const reserved = new Set([...commandTargets.values()].flat());
    for (const job of x.prober.due(view(), new Date())) {
      const key = probeTargetKey(job.target);
      if (reserved.has(key)) continue;
      track(`probe:${key}`, () => x.prober.run(job, x.stop.signal));
    }
  };

  /** A restarted arc's halted units whose item is not raised yet (a running task raises its own), then the schedule's. */
  const raiseHalted = (): void => {
    for (const unit of plan().units) {
      const { status } = view().unit(unit.id);
      if (tasks.has(unit.id) || (status !== 'park-pending' && status !== 'stop-pending')) continue;
      if (!operatorPark(view(), unit.id) || raisedFor(view(), decidedParent(view(), unit.id)) !== null) continue;
      const halted = haltResult(x.stage, unit);
      if (halted === null) throw new Error(`unit ${unit.id} is ${status}, but its decision halts nothing`);
      raiseResult(x.stage, unit.id, halted, route);
    }
    raiseScheduleDue(journal, runDir, new Date());
  };

  /** The holistic layer's items due on a tick (at most once per POLL_MS): the findings' and an owed audit's. */
  const raiseHolistic = (): void => {
    if (!holistic() || Date.now() - lastTick < POLL_MS) return;
    lastTick = Date.now();
    raiseFindingItems(journal, runDir, new Date());
    const c = cadence(x.stage, h.audit.clock);
    if (c !== null) raiseAuditOwed(h.audit, c);
  };

  // -------------------------------------------------------------------------------------------------
  // The holistic jobs

  /** Whether the baseline holds every admission: owed or running, or its blocking item unacknowledged. */
  const baselineHolds = (blocking: readonly BlockingItem[]): boolean =>
    holistic() && (jobs.has('holistic:baseline') || baselineOwed(x.stage) !== null || blocking.some((b) => b.reason === 'obligation-baseline'));

  /** OR-Q1: a second design park whose `respec-second` the checkpoint job has yet to raise (it raises it when run). */
  const respecSecondDue = (): boolean => plan().units.some((u) => view().unit(u.id).status === 'park-pending'
    && raisedFor(view(), decidedParent(view(), u.id)) === null && route(u.id)?.kind === 'respec-second');

  /** The one holistic job (baseline, checkpoint, audit), the batch and the close-out, each started when due. */
  const startHolistic = (holds: Holds, batch: BatchPlan): void => {
    if (!holistic()) return;
    if (due('holistic')) {
      const job = baselineOwed(x.stage);
      if (job !== null) {
        trackRetrying('holistic:baseline', 'holistic', async () => {
          const out = await runBaseline(h.audit);
          return out.kind === 'incomplete' ? { kind: 'no-verdict', job, detail: endDetail(out.end) } : PROGRESS;
        });
      } else if (checkpointPending(h.checkpoint) || respecSecondDue()) {
        trackRetrying('holistic:checkpoint', 'holistic', async () => ((await runCheckpoint(h.checkpoint)).kind === 'decided' ? PROGRESS : WAIT));
      } else if (auditPending(h.audit)) {
        trackRetrying('holistic:audit', 'holistic', async () => {
          const out = await runAudit(h.audit);
          if (out.kind === 'incomplete') return { kind: 'no-verdict', job: out.job, detail: endDetail(out.end) };
          return out.kind === 'ended' ? PROGRESS : WAIT;
        });
      }
    }
    const ready = batch.ready;
    if (ready !== null && !holds.baseline && due('batch') && heldBatch(view()) === null) {
      trackRetrying('batch', 'batch', async () => {
        const out = await publishBatch({ ...x.stage, acquireFirst: arbiter.acquireFirst }, ready.finding, ready.members);
        const settled = settleBatch(x.stage, ready.finding, ready.members, out);
        for (const u of settled.retire) retiring.add(u);
        for (const u of settled.unbatch) unbatched.set(u, approvalKey(u));
        if (out.kind === 'no-verdict' && out.end.kind !== 'occupied') return { kind: 'no-verdict', job: out.job, detail: endDetail(out.end) };
        return settled.progress ? PROGRESS : WAIT;
      });
    }
  };

  /** A8: the close-out publication (or, with nothing to change, every arc lane on the head), as a job. */
  const startCloseOut = (): void => {
    if (!due('closeout')) return;
    trackRetrying('closeout', 'closeout', async () => {
      const out = await publishCloseOut(h.docs);
      if (out.kind === 'refused') {
        // Its lanes red on the head plus the renderings: the base is broken; the architect answers before it runs again.
        const parent: Parent = { type: 'job', job: out.pub };
        raiseNeedsUser(journal, runDir, {
          blocking: true, subject: { type: 'arc' }, reason: 'base-red', summary: `The close-out publication was refused: ${out.reason}. The arc is not complete.`,
          recommendation: `Repair ${plan().integrationBranch} (or the obligations in force), then acknowledge this item: the close-out runs again.`,
          options: [], evidence: [jobEvidenceRoot(runDir, out.pub)],
        }, parent);
      }
      return out.kind === 'no-verdict' ? { kind: 'no-verdict', job: out.pub, detail: out.detail } : PROGRESS;
    });
  };

  // -------------------------------------------------------------------------------------------------
  // Ends

  const summary = (): readonly UnitSummary[] => plan().units.map((u): UnitSummary => {
    const s = view().unit(u.id);
    switch (s.status) {
      case 'retired':
        return { unit: u.id, result: 'merged' };
      case 'cut':
        return { unit: u.id, result: 'cut' };
      case 'superseded':
        if (s.supersededBy === null) throw new Error(`unit ${u.id} is superseded by no unit`);
        return { unit: u.id, result: 'superseded', by: s.supersededBy };
      case 'park-pending': {
        const id = raisedFor(view(), decidedParent(view(), u.id));
        if (id === null) throw new Error(`unit ${u.id} is parked without its needs-user`);
        return { unit: u.id, result: 'parked', needsUser: id };
      }
      default:
        throw new Error(`unit ${u.id} is ${s.status} at the end of the arc`);
    }
  });

  /**
   * With nothing running and no mutation pending: the completion predicate (the close-out started when only it and the
   * obligations' witnesses on the head are left), then `arc-completed` and the terminal snapshot, for every arc.
   */
  const ended = async (blocking: readonly BlockingItem[]): Promise<SchedulerEnd | null> => {
    const blockers = completionBlockers(h, { blocking: blocking.length, pending: 0 });
    if (blockers.length === 0) {
      completeArc(x.stage);
      if (view().holistic().completion !== null) await terminalSnapshot(x.stage);
      return { kind: 'complete', units: summary() };
    }
    const closing = blockers.every((b) => b === 'close-out' || b === 'obligations-not-discharged');
    if (closing && obligationsOn(x.stage, integrationHeadNow(x.stage)) !== 'not-held') startCloseOut();
    return null;
  };

  // -------------------------------------------------------------------------------------------------
  // The derived view (`sched.json`), rewritten only when it changed

  let published: string | null = null;
  const publishSched = (pending: SchedFile['drains']): void => {
    const file: SchedFile = {
      v: SCHEMA_VERSION, arc: view().arc, pid: process.pid,
      tasks: [...tasks.values()].map((t) => ({ unit: t.unit, state: t.state })).sort((a, b) => (a.unit < b.unit ? -1 : 1)),
      queue: arbiter.waiting().map((w) => ({
        unit: w.holder.unit, stage: holderStage(w.holder), attempt: w.holder.attempt, publication: w.holder.type === 'publication', request: w.request,
        envBlocked: w.envBlocked,
      })),
      jobQueue: arbiter.waitingFirst().map((w) => ({ holder: w.holder, request: w.request, envBlocked: w.envBlocked })),
      drains: pending,
    };
    const text = canonicalJson(file);
    if (text === published) return;
    atomicJson(join(runDir, SCHED_FILE), file);
    published = text;
  };

  // -------------------------------------------------------------------------------------------------
  // The loop

  // A published batch a crash cut short (recovery left its slot held) is finished first; a terminal snapshot the ref
  // lacks is published (G8).
  if (heldBatch(view()) !== null) await finishBatch(x.stage);
  if (view().holistic().completion !== null) await terminalSnapshot(x.stage);
  // G2: pending chains first (and merged units' retires), before any mutation, whatever pause or readiness says.
  for (const unit of plan().units) if (view().unit(unit.id).status === 'retired') startTask(unit);
  startChains();

  for (;;) {
    if (failures.length > 0) throw failures[0];
    const arc = view().arc;
    /** The pending mutations' scopes, for sched.json: none while stopping (nothing will apply). */
    let drains: SchedFile['drains'] = [];
    // 1. Control, then what pause and stop ask of the tasks.
    await applyControl(x.commands, pollCommands(runDir, arc));
    if (stopping === null) {
      const c = view().control();
      const stopped = plan().units.find((u) => view().unit(u.id).status === 'stop-pending');
      if (c.stop !== null) stopping = { cause: 'command', unit: null };
      else if (stopped !== undefined) stopping = { cause: 'unit', unit: stopped.id };
      if (stopping !== null) x.stop.abort('stop');
    }
    interrupt();

    if (stopping !== null) {
      // Stopping: nothing new starts; the halted units' items are raised (a unit's stop names its own), and the
      // run ends once every task and job has settled.
      raiseHalted();
      for (const task of tasks.values()) endTask(task);
      if (tasks.size === 0 && jobs.size === 0) {
        await recoverReservations(x.stage);
        const needsUser = stopping.unit === null ? null : raisedFor(view(), decidedParent(view(), stopping.unit));
        return { kind: 'stop', cause: stopping.cause, needsUser };
      }
    } else {
      const mutations = pendingMutations(pollCommands(runDir, arc));
      drains = mutations.map((m) => ({ command: m.command.id, scope: m.scope }));
      // 2. Mutations whose scope is clear.
      startMutations(mutations);
      // 3. Due probes.
      startProbes();
      // 4. A halted unit's, the schedule's and the holistic layer's needs-user; the holistic jobs; the end.
      raiseHalted();
      raiseHolistic();
      const blocking = blockingItems(runDir, view());
      const batch = batchPlan();
      const holds: Holds = { baseline: baselineHolds(blocking), batch: batch.held };
      startHolistic(holds, batch);
      if (tasks.size === 0 && jobs.size === 0 && mutations.length === 0) {
        const end = await ended(blocking);
        if (end !== null) return end;
      }
      // 5. Chains a recovered park returned a unit to, waiting tasks admitted, then tasks for ready units (each
      //    reaches its first gate at once).
      startChains();
      admitWaiting(blocking, mutations, holds);
      startReady(blocking, mutations, holds);
      admitWaiting(blocking, mutations, holds);
    }
    // 6. The arbiter, then the derived view.
    arbiter.wake();
    publishSched(drains);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => wakeup?.(), POLL_MS);
      wakeup = (): void => {
        clearTimeout(timer);
        wakeup = null;
        resolve();
      };
    });
  }
}

