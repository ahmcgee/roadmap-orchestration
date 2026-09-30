// The scheduler (M2 "Scheduler model"; A12, A17, F5, F13, F19, G2): runs every unit of the arc that may run,
// each in its own task, from one non-reentrant loop that never awaits long work.
//
// Each iteration (every POLL_MS, or sooner when a task or job wakes it):
//   1. poll the command queue and apply control commands (pause, stop, ack) synchronously as facts; kills of
//      the live invocations a pause or stop ends start as tracked jobs (`proc.kill`, once per invocation);
//   2. start one job per pending mutation (resume, sweep, apply, resolve-edge, run-only) whose scope
//      (`commandScope`, A12) is clear: every unit in it idle or awaiting admission, no earlier pending
//      mutation overlapping it, and no probe running on a target it probes. A command with a job is never
//      started again; one whose op a crashed executor left open is recovery's;
//   3. start the probe jobs that are due (`prober.due`), at most one per target;
//   4. raise the needs-user items now due: a halted unit's (an operator park, a stop) and the park
//      schedule's (escalations, breakers; src/park/schedule.ts); then, with nothing running and no mutation
//      pending, end `complete` if every unit is settled and no blocking item is open;
//   5. start a task for every active unit without one whose next stage is a chain (a recovered park's), then for
//      every ready unit without one (`ready`), and admit waiting tasks (`admitter`);
//   6. re-evaluate the arbiter (it is also woken by every release: a task's or a job's end), then write the
//      derived `sched.json` (`SCHED_FILE`) when it changed: each task's state, the arbiter's queue and the
//      pending mutations' scopes, for `status` only. Nothing reads it for a decision; a restart rebuilds all
//      of it in memory.
// Jobs and tasks never block polling: the loop only starts them and reads their ends.
//
// A task runs its unit's stage loop (`runUnit`) with a per-task StageContext: the arbiter's `acquire`, the
// log's rank and the task's own signal, aborted with `pause` or `stop` only. At most one task per unit (a
// second start throws). A task is `idle` (none), `awaiting-admission` (at an admission boundary, waiting for
// step 5), `in-stage` or `in-chain` (A12). Admission is re-checked at every admission boundary of every task
// (F13, A17): a pause, a stop or a unit no longer active ends the task there (the unit holds nothing, F5); any
// other constraint (a drain, a parked backend, a tripped breaker, run-only, base-red, a blocking item) keeps it
// waiting. Chain stages (quiesce → evidence → salvage → teardown; ff → snapshot) are never gated: they run to
// completion under pause, drain and stop (F5).
//
// Start and restart (G2): before the loop's first iteration a task is started for every unit whose decided
// next stage is a chain stage (recovery kept a green publication's slot; a build's chain has its reservation
// cleaned), whatever pause or readiness says, and for every merged unit (its retire is re-runnable). Step 5
// does the same for a unit a recovered retryable park returned to a chain stage (a teardown or a salvage).
//
// Pause: `pause <u>` aborts u's task (its waits end: an entry reservation, a later lane's set, a clear host) and
// kills u's live backend and lane invocations, which their stage records as `interrupted`; `pause --all` does
// so for every unit. Stop (a `stop` command, or a unit whose outcome stops the arc): every task is aborted and
// every live backend, lane and smoke invocation killed (a probe's included); teardowns and reclaims run to
// their end, as do chains. Control commands keep applying meanwhile. Once every task and job has settled,
// `recoverReservations` cleans what a stage still holds, and the run ends `stop`.
//
// The run ends `complete` when nothing runs and every unit is merged, cut, superseded or parked for the
// architect (an operator park: a retryable park is probed until it recovers, so it is not settled), and no
// blocking needs-user is open.
import type { CommandContext } from '../commands/apply.ts';
import { applyCommand, applyControl } from '../commands/apply.ts';
import { isControl, pollCommands, POLL_MS } from '../commands/queue.ts';
import { join } from 'node:path';
import { type Parent, probeTargetKey } from '../core/events.ts';
import { atomicJson, canonicalJson } from '../core/fsx.ts';
import { type ArcId, type CommandId, type InvocationId, type NeedsUserId, type UnitId, arcId, commandId, invocationId, resourceName, unitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type CommandFile, STAGES, type Stage } from '../core/records.ts';
import { type Read, arrayOf, bool, literal, nat, object, oneOf, positive, tagged, version } from '../core/validate.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../core/version.ts';
import { commandScope } from '../input/classify.ts';
import type { PlanUnit } from '../input/plan.ts';
import { type BlockingItem, blockingItems, holdsUnit, raiseNeedsUser, raisedFor } from '../needsuser.ts';
import type { ProberHandle } from '../park/probe.ts';
import { raiseDue as raiseScheduleDue, trippedTargets } from '../park/schedule.ts';
import type { StageContext } from '../pipeline/dispatch.ts';
import { invocationDir, killWorkload } from '../pipeline/invoke.ts';
import { type Gate, type UnitResult, haltResult, runUnit, upcoming } from '../pipeline/unit.ts';
import { recoverReservations } from '../recover/resource.ts';
import { holderStage } from '../resources/reserve.ts';
import { runnerFiles } from '../runner/files.ts';
import type { Arbiter } from './arbiter.ts';
import { admitter, nextStage, rankOf, ready } from './ready.ts';
import type { AdmissionStage, CommandScope, ResourceRequest, TaskState } from './types.ts';

// ---------------------------------------------------------------------------------------------------
// sched.json: the scheduler's in-memory view, for `status` only

/** The derived scheduler view in the run dir, rewritten on change. Non-authoritative: never read for a decision. */
export const SCHED_FILE = 'sched.json';

const TASK_STATES = ['idle', 'awaiting-admission', 'in-stage', 'in-chain'] as const satisfies readonly TaskState[];

/** One waiter of the arbiter, in the order it serves them: the unit, the stage attempt it waits for, what it asks. */
export type QueueEntry = Readonly<{ unit: UnitId; stage: Stage; attempt: number; publication: boolean; request: ResourceRequest; envBlocked: boolean }>;

/**
 * `sched.json`: written by the executor process `pid` (status trusts it only while that executor owns the
 * run). `tasks`: every unit with a task (a unit without one is idle). `queue`: the arbiter's waiters, served
 * first to last. `drains`: the pending mutations, in submission order, with their scopes (A12).
 */
export type SchedFile = Readonly<{
  v: SchemaVersion;
  arc: ArcId;
  pid: number;
  tasks: readonly Readonly<{ unit: UnitId; state: TaskState }>[];
  queue: readonly QueueEntry[];
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

export const schedFile: Read<SchedFile> = object((f) => ({
  v: f.get('v', version),
  arc: f.get('arc', (v, p) => arcId(v, p)),
  pid: f.get('pid', positive),
  tasks: f.get('tasks', arrayOf(object((g) => ({ unit: g.get('unit', (v, p) => unitId(v, p)), state: g.get('state', oneOf(TASK_STATES)) })))),
  queue: f.get('queue', arrayOf(object((g): QueueEntry => ({
    unit: g.get('unit', (v, p) => unitId(v, p)), stage: g.get('stage', oneOf(STAGES)), attempt: g.get('attempt', positive),
    publication: g.get('publication', bool), request: g.get('request', request), envBlocked: g.get('envBlocked', bool),
  })))),
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
  /** Every unit settled (merged, cut, superseded, or parked with its needs-user acknowledged). */
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

/** Invocation purposes a pause (backend, lane) or a stop (also smoke: an apply's, `resume --backend`'s, a probe's) kills. */
const PAUSE_KILLS: readonly string[] = ['backend', 'lane'];
const STOP_KILLS: readonly string[] = ['backend', 'lane', 'smoke'];

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
 * Whether a unit is settled for the end of the arc: merged, cut, superseded, or parked for the architect (an
 * operator park). A retryable park is probed until it recovers, so it is not; nor is an active or held unit.
 */
export function unitSettled(view: JournalView, unit: UnitId): boolean {
  const s = view.unit(unit).status;
  return s === 'retired' || s === 'cut' || s === 'superseded' || (s === 'park-pending' && operatorPark(view, unit));
}

/**
 * Writes the needs-user a unit's result carries, once (`raisedFor`): an operator park's or a stop's, parented by
 * the attempt that decided it; a hold's (a usage-limited backend), parented by the held attempt. A retryable
 * park asks nobody: its probes recover it, and it escalates on its own after 6 h (D2).
 */
export function raiseResult(ctx: StageContext, unit: UnitId, result: UnitResult): void {
  const { journal, runDir } = ctx;
  const view = journal.view;
  if (result.kind === 'parked' && !operatorPark(view, unit)) return;
  if (result.kind === 'parked' || result.kind === 'stopped') {
    const parent = decidedParent(view, unit);
    if (raisedFor(view, parent) === null) raiseNeedsUser(journal, runDir, result.needsUser, parent);
    return;
  }
  if (result.kind === 'held' && result.needsUser !== null) {
    const u = view.unit(unit);
    const parent: Parent = { type: 'stage', unit, stage: u.stage, attempt: u.counters.attempts };
    if (raisedFor(view, parent) === null) raiseNeedsUser(journal, runDir, result.needsUser, parent);
  }
}

export async function schedule(x: SchedulerContext): Promise<SchedulerEnd> {
  const { journal, runDir } = x.stage;
  const view = (): JournalView => journal.view;
  const plan = () => x.stage.plan();
  const { arbiter } = x;
  const scopeOf = commandScope(x.commands);

  const tasks = new Map<UnitId, Task>();
  const jobs = new Map<string, Promise<void>>();
  /** Probe targets a running `resume` job probes (or smokes): no scheduled probe job starts on them meanwhile. */
  const commandTargets = new Map<CommandId, readonly string[]>();
  /** The first error of a task or job: the loop rethrows it (a crash). */
  const failures: unknown[] = [];
  let stopping: Readonly<{ cause: 'command' | 'unit'; unit: UnitId | null }> | null = null;

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
    runUnit(ctx, unit, gate).then((result) => raiseResult(x.stage, unit.id, result)).catch(fail).finally(() => {
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
  // Admission and readiness

  const pendingMutations = (pending: readonly CommandFile[]): readonly Readonly<{ command: CommandFile; scope: CommandScope }>[] =>
    pending.filter((c) => !isControl(c.body)).map((command) => ({
      command, scope: scopeOf(command.body as Parameters<typeof scopeOf>[0], view(), plan()),
    }));

  const admissionInput = (blocking: readonly BlockingItem[], mutations: ReturnType<typeof pendingMutations>) => ({
    view: view(), plan: plan(), blocking, drains: mutations.map((m) => ({ command: m.command.id, scope: m.scope })), tripped: trippedTargets(view()),
  });

  const admitWaiting = (blocking: readonly BlockingItem[], mutations: ReturnType<typeof pendingMutations>): void => {
    const admit = admitter(x.stage.routing().table);
    const input = admissionInput(blocking, mutations);
    for (const task of tasks.values()) {
      const w = task.waiting;
      if (w === null) continue;
      const u = view().unit(task.unit);
      const next = upcoming(u);
      // Ended at this boundary: a pause or stop, or the unit moved on without it (cut, superseded, re-opened).
      if (stopping !== null || task.abort.signal.aborted || u.status !== 'active' || next?.kind !== 'admission' || next.stage !== w.stage) {
        endTask(task);
        continue;
      }
      const a = admit({ ...input, unit: planUnit(task.unit), stage: w.stage });
      if (a.kind === 'wait' && a.constraints.some((c) => c.type === 'paused')) {
        endTask(task);
        continue;
      }
      if (a.kind !== 'admit' || blocking.some((b) => holdsUnit(b, task.unit))) continue;
      task.waiting = null;
      task.state = 'in-stage';
      w.resolve(true);
    }
  };

  /**
   * A task for every active unit without one whose decided next stage is a chain stage: at a start (G2), and
   * when a retryable park on a chain stage recovers (a teardown's cleanup-failed, a salvage's commit-failed: the
   * fold returns the unit to that stage, F9). Chains are never gated, so `ready` (admission stages) never offers
   * them.
   */
  const startChains = (): void => {
    for (const unit of plan().units) {
      const u = view().unit(unit.id);
      if (!tasks.has(unit.id) && u.status === 'active' && nextStage(u)?.kind === 'chain') startTask(unit);
    }
  };

  const startReady = (blocking: readonly BlockingItem[], mutations: ReturnType<typeof pendingMutations>): void => {
    for (const r of ready({ ...admissionInput(blocking, mutations), routing: x.stage.routing().table })) {
      if (tasks.has(r.unit.id) || blocking.some((b) => holdsUnit(b, r.unit.id))) continue;
      startTask(r.unit);
    }
  };

  // -------------------------------------------------------------------------------------------------
  // Commands

  /** Kills every live invocation `which` selects, once per invocation and reason, as tracked jobs. */
  const killLive = (reason: 'pause' | 'stop', which: (purpose: string, unit: UnitId | null) => boolean): void => {
    const v = view();
    for (const intent of v.openIntents()) {
      if (intent.kind !== 'proc.spawn') continue;
      const unit = intent.parent.type === 'stage' ? intent.parent.unit : null;
      if (!which(intent.expect.subject.purpose, unit)) continue;
      const inv: InvocationId = invocationId(intent.op, intent.ordinal);
      const key = `kill:${inv}:${reason}`;
      if (jobs.has(key) || v.opsOf('proc.kill').some((k) => k.expect.inv === inv && k.expect.reason === reason)) continue;
      // A runner that has not written runner.json may not have exec'd yet: the next poll finds it.
      const files = runnerFiles(invocationDir(runDir, inv), inv);
      if (files.read('runner.json') === null || files.read('exit.json') !== null) continue;
      track(key, () => killWorkload(x.stage, { inv, scope: 'invocation', reason }));
    }
  };

  /** What pause and stop ask of the running tasks now, per the durable markers. */
  const interrupt = (): void => {
    const c = view().control();
    if (stopping !== null) {
      for (const task of tasks.values()) if (!task.abort.signal.aborted) task.abort.abort('stop');
      killLive('stop', (purpose) => STOP_KILLS.includes(purpose));
      return;
    }
    const paused = (unit: UnitId): boolean => c.pausedAll || c.pausedUnits.includes(unit);
    for (const task of tasks.values()) if (paused(task.unit) && !task.abort.signal.aborted) task.abort.abort('pause');
    killLive('pause', (purpose, unit) => unit !== null && PAUSE_KILLS.includes(purpose) && paused(unit));
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
      raiseResult(x.stage, unit.id, halted);
    }
    raiseScheduleDue(journal, runDir, new Date());
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
      drains: pending,
    };
    const text = canonicalJson(file);
    if (text === published) return;
    atomicJson(join(runDir, SCHED_FILE), file);
    published = text;
  };

  // -------------------------------------------------------------------------------------------------
  // The loop

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
      // 4. A halted unit's and the schedule's needs-user.
      raiseHalted();
      const blocking = blockingItems(runDir, view());
      const idle = tasks.size === 0 && jobs.size === 0 && mutations.length === 0;
      if (idle && blocking.length === 0 && plan().units.every((u) => unitSettled(view(), u.id))) return { kind: 'complete', units: summary() };
      // 5. Chains a recovered park returned a unit to, waiting tasks admitted, then tasks for ready units (each
      //    reaches its first gate at once).
      startChains();
      admitWaiting(blocking, mutations);
      startReady(blocking, mutations);
      admitWaiting(blocking, mutations);
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
