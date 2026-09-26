// The executor process (plan "Runtime components"; DESIGN-1.0.md §2.3, §2.10): one run of an arc, from the
// startup checks to an exit reason.
//
//   runChecks (the startup table, frozen order) → refused: `status.rejection.json` in the run dir, exit 78/75
//   → claimed host and open journal → `executor-started{generation}` (clears the stop marker) → recovery
//   (recover.ts) → the command loop:
//
//     control commands (pause, stop, ack) → mutations (resume, sweep) at this safe point → needs-user due
//     → stop marker: stop · a unit stop-pending: stop · everything settled and no open blocking needs-user:
//     complete · a blocking needs-user open, the arc or the next unit paused, the next unit held: wait (poll
//     1 s) · otherwise run the arc.
//
//   While the arc runs, control commands keep applying every poll. A pause or stop aborts the arc's signal
//   and cancels the live backend or lane invocation of the running stage (`proc.kill{pause|stop}`); the
//   stage records `interrupted` (a hold) and the arc returns. A stop then cleans whatever a stage still
//   holds, releases the host and exits `stop`; a pause waits in the loop for `resume` or `stop`.
//
// Needs-user content the driver returns is written here with `raiseNeedsUser`, parented by the stage attempt
// that decided it, so an item is raised once however often the arc is re-read (`raisedFor`).
//
// Supervision (14a) is not here: `roadmap start` runs this in the foreground, and the process claims the
// host itself (`claimForeground`), acting as its own supervisor. Step 14a moves the claim to the supervisor
// and adds, before any effect, the wait for `handshake.<generation>` and the owner verification
// (`awaitHandshake` in host/owner.ts); nothing else here changes.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CommandContext } from './commands/apply.ts';
import { applyAtSafePoint, applyControl } from './commands/apply.ts';
import { POLL_MS, pollCommands } from './commands/queue.ts';
import { containmentFor, detectContainmentMode } from './contain/detect.ts';
import type { Parent, StageOutcomeFact } from './core/events.ts';
import { atomicJson, durableMkdir, durableUnlink } from './core/fsx.ts';
import { canonicalJson } from './core/json.ts';
import { type NeedsUserId, type UnitId, invocationId } from './core/ids.ts';
import type { JournalView } from './core/interfaces.ts';
import type { OpenJournal } from './core/log.ts';
import type { ExecutorExitReason, Heartbeat, HostLockClaim, NeedsUserContent, RunStart } from './core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from './core/values.ts';
import { SCHEMA_VERSION } from './core/version.ts';
import { hostPath, openHostDir } from './host/hostdir.ts';
import { selfIdentity } from './host/liveness.ts';
import { type ClaimOutcome, claimHost, releaseHost } from './host/lock.ts';
import { publishOwner } from './host/owner.ts';
import { runDir as runDirOf } from './input/cli.ts';
import type { PlanUnit } from './input/plan.ts';
import { openBlocking, raiseNeedsUser, raisedFor } from './needsuser.ts';
import { type ArcResult, runArc } from './pipeline/arc.ts';
import type { StageContext } from './pipeline/dispatch.ts';
import { invocationDir, killWorkload } from './pipeline/invoke.ts';
import { step } from './pipeline/unit.ts';
import { gitCommonDir, loadPlan, runChecks } from './preflight/checks.ts';
import { backendEnv } from './preflight/smoke.ts';
import { EXIT_HOST_BUSY, EXIT_REFUSED, type RejectionFile, type StartupContext, type StartupRejection, exitCodeFor } from './preflight/startup.ts';
import { previousArcVerdict, recover } from './recover/recover.ts';
import { recoverReservations } from './recover/resource.ts';
import type { ProfileName } from './routing/types.ts';
import { runnerFiles } from './runner/files.ts';

/** Run dir: the latest start's refusal, for `status` (removed by the next start that passes). */
export const REJECTION_FILE = 'status.rejection.json';
/** Run dir: what the latest passed start runs (repo, plan, resolved profile), for `status`. */
export const START_FILE = 'start.json';
/** Run dir: the executor's heartbeat (14a's supervisor reads it; stale at 5 min). */
export const HEARTBEAT_FILE = 'heartbeat.json';
/** Host dir: why the executor of a generation ended, when it ended on purpose. */
export const EXIT_REASON_FILE = 'exit.reason.json';
export const HEARTBEAT_MS = 10_000;

export type ExecutorArgs = Readonly<{
  repo: AbsPath;
  planFile: AbsPath;
  /** `start --profile`, or null to let `.roadmap/config.json` choose. */
  profile: ProfileName | null;
  hostDir: AbsPath;
  /** The executor's environment: lanes resolve against it, backends get `backendEnv` of it. */
  env: Readonly<Record<string, string | undefined>>;
}>;

export type UnitSummary = Readonly<{ unit: UnitId; result: 'merged' } | { unit: UnitId; result: 'parked'; needsUser: NeedsUserId }>;

/** Why a run ended on purpose. Anything else is a thrown error: a crash, which leaves the claim for takeover. */
export type ExitReason =
  /** Every unit merged, or parked with its needs-user acknowledged. */
  | Readonly<{ kind: 'complete'; units: readonly UnitSummary[] }>
  /** A `stop` command, or a unit whose outcome stopped the arc (its needs-user is raised). */
  | Readonly<{ kind: 'stop'; cause: 'command' | 'unit'; needsUser: NeedsUserId | null }>
  | Readonly<{ kind: 'refused'; rejections: readonly StartupRejection[]; exitCode: typeof EXIT_REFUSED | typeof EXIT_HOST_BUSY }>;

export function exitCodeOf(reason: ExitReason): number {
  return reason.kind === 'refused' ? reason.exitCode : 0;
}

// ---------------------------------------------------------------------------------------------------
// Files

function writeExitReason(hostDir: AbsPath, claim: HostLockClaim, reason: ExitReason['kind']): void {
  const file: ExecutorExitReason = { v: SCHEMA_VERSION, generation: claim.generation, reason };
  atomicJson(hostPath(hostDir, EXIT_REASON_FILE), file);
}

function writeHeartbeat(runDir: AbsPath, generation: number): void {
  const file: Heartbeat = { v: SCHEMA_VERSION, generation, at: isoTimeOf(new Date()) };
  atomicJson(join(runDir, HEARTBEAT_FILE), file);
}

/** The run dir a refused start can name: known once the plan parses (its arc), else none. */
function refusedRunDir(args: ExecutorArgs): AbsPath | null {
  const plan = loadPlan(args.planFile);
  return 'kind' in plan ? null : runDirOf(gitCommonDir(args.repo), plan.arc);
}

function writeRejection(runDir: AbsPath, rejections: readonly StartupRejection[]): void {
  durableMkdir(runDir);
  const file: RejectionFile = { v: SCHEMA_VERSION, at: isoTimeOf(new Date()), rejections };
  atomicJson(join(runDir, REJECTION_FILE), file);
}

// ---------------------------------------------------------------------------------------------------
// Start

/** 13b's claim: this process is its own supervisor, so it claims the host and publishes itself as the owner. */
async function claimForeground(context: StartupContext): Promise<ClaimOutcome> {
  const self = selfIdentity();
  const out = await claimHost(context.hostDir, { arc: context.plan.arc, runDir: context.runDir, repo: context.repo, supervisor: self }, previousArcVerdict);
  if (out.kind === 'claimed') publishOwner(context.hostDir, out.claim, self);
  return out;
}

export async function runExecutor(args: ExecutorArgs): Promise<ExitReason> {
  openHostDir(args.hostDir);
  const checks = await runChecks({ ...args, claim: claimForeground });
  if (checks.kind === 'refused') {
    const { rejections } = checks;
    const first = rejections[0];
    if (first === undefined) throw new Error('runChecks refused with no rejection');
    const exitCode = exitCodeFor(first);
    checks.journal?.close();
    // A busy host is "try later", not a verdict on this arc: its run dir (possibly a live run's) is left alone.
    if (exitCode === EXIT_REFUSED) {
      const runDir = checks.claim?.runDir ?? refusedRunDir(args);
      if (runDir !== null) writeRejection(runDir, rejections);
    }
    if (checks.claim !== null) {
      writeExitReason(args.hostDir, checks.claim, 'refused');
      releaseHost(args.hostDir, checks.claim);
    }
    return { kind: 'refused', rejections, exitCode };
  }

  const { context, claim, journal, routing } = checks;
  const heartbeat = setInterval(() => writeHeartbeat(context.runDir, claim.generation), HEARTBEAT_MS);
  try {
    const rejection = join(context.runDir, REJECTION_FILE);
    if (existsSync(rejection)) durableUnlink(rejection);
    const start: RunStart = { v: SCHEMA_VERSION, generation: claim.generation, at: isoTimeOf(new Date()), repo: context.repo, planFile: context.planFile, profile: context.profile };
    atomicJson(join(context.runDir, START_FILE), start);
    writeHeartbeat(context.runDir, claim.generation);
    journal.fact({ kind: 'executor-started', generation: claim.generation });

    const stage: StageContext = {
      journal, containment: containmentFor(detectContainmentMode()), runDir: context.runDir, plan: context.plan, repo: context.repo,
      hostDir: context.hostDir, routing: routing.resolved, hostEnv: args.env, planDir: absPath(dirname(context.planFile)),
    };
    const commands: CommandContext = { ...stage, hostEnv: backendEnv(args.env), routing };
    await recover({ stage, commands });
    const reason = await drive({ stage, commands, journal });
    writeExitReason(args.hostDir, claim, reason.kind);
    releaseHost(args.hostDir, claim);
    return reason;
  } finally {
    clearInterval(heartbeat);
    journal.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// The command loop

type Exec = Readonly<{ stage: StageContext; commands: CommandContext; journal: OpenJournal }>;

/** Control commands now (deferred only inside an integration.ff), then mutations if nothing of a stage is open. */
async function applyCommands(x: Exec): Promise<void> {
  const arc = x.journal.view.arc;
  await applyControl(x.commands, pollCommands(x.stage.runDir, arc));
  await applyAtSafePoint(x.commands, pollCommands(x.stage.runDir, arc));
}

const settledStatus = (view: JournalView, unit: PlanUnit): boolean => {
  const s = view.unit(unit.id).status;
  return s === 'retired' || s === 'park-pending';
};

/** The unit the serial arc works on next: the first in plan order that is neither merged nor parked. */
function currentUnit(x: Exec): PlanUnit | null {
  return x.stage.plan.units.find((u) => !settledStatus(x.journal.view, u)) ?? null;
}

/** What a pause or stop asks of the running arc, per the durable markers. */
function interruption(x: Exec): 'pause' | 'stop' | null {
  const c = x.journal.view.control();
  if (c.stop !== null) return 'stop';
  const current = currentUnit(x);
  if (c.pausedAll || (current !== null && c.pausedUnits.includes(current.id))) return 'pause';
  return null;
}

/** Why the loop does not dispatch now, or null when it may. */
function waitReason(x: Exec, current: PlanUnit): string | null {
  const view = x.journal.view;
  const blocking = openBlocking(view);
  if (blocking.length > 0) return `blocking needs-user ${blocking.join(', ')}`;
  const c = view.control();
  if (c.pausedAll) return 'the arc is paused';
  if (c.pausedUnits.includes(current.id)) return `unit ${current.id} is paused`;
  if (view.unit(current.id).status === 'held') return `unit ${current.id} is held`;
  return null;
}

async function drive(x: Exec): Promise<ExitReason> {
  for (;;) {
    await applyCommands(x);
    await raiseDue(x, null);
    const view = x.journal.view;
    if (view.control().stop !== null) return stopRun(x, { kind: 'stop', cause: 'command', needsUser: null });
    const stopped = x.stage.plan.units.find((u) => view.unit(u.id).status === 'stop-pending');
    if (stopped !== undefined) return stopRun(x, { kind: 'stop', cause: 'unit', needsUser: raisedFor(view, decidedParent(view, stopped.id)) });
    const current = currentUnit(x);
    if (current === null && openBlocking(view).length === 0) return { kind: 'complete', units: summary(x) };
    if (current === null || waitReason(x, current) !== null) {
      await sleep(POLL_MS);
      continue;
    }
    await raiseDue(x, await runWithControl(x));
  }
}

/** Runs the arc while applying control commands every poll; a pause or stop interrupts the running stage. */
async function runWithControl(x: Exec): Promise<ArcResult> {
  const abort = new AbortController();
  let finished = false;
  const running = runArc(x.stage, abort.signal).finally(() => {
    finished = true;
  });
  // Settles when the arc does, without rethrowing here: `running` is returned and rethrows to the caller.
  const ended = running.then(() => undefined, () => undefined);
  while (!finished) {
    await Promise.race([ended, sleep(POLL_MS)]);
    if (finished) break;
    await applyControl(x.commands, pollCommands(x.stage.runDir, x.journal.view.arc));
    const reason = interruption(x);
    if (reason === null) continue;
    abort.abort();
    await interruptLive(x, reason);
  }
  return running;
}

/**
 * Cancels every live backend or lane invocation of a stage through `proc.kill{reason}`, once each. Probes and
 * teardowns run to their end: a cleanup is never cut short. An invocation whose runner has not written
 * runner.json yet is left for the next poll (its runner may not have exec'd, so it cannot be found yet).
 */
async function interruptLive(x: Exec, reason: 'pause' | 'stop'): Promise<void> {
  const view = x.journal.view;
  for (const intent of view.openIntents()) {
    if (intent.kind !== 'proc.spawn' || intent.parent.type !== 'stage') continue;
    const { purpose } = intent.expect.subject;
    if (purpose !== 'backend' && purpose !== 'lane') continue;
    const inv = invocationId(intent.op, intent.ordinal);
    if (view.opsOf('proc.kill').some((k) => k.expect.inv === inv && k.expect.reason === reason)) continue;
    const files = runnerFiles(invocationDir(x.stage.runDir, inv), inv);
    if (files.read('runner.json') === null || files.read('exit.json') !== null) continue;
    await killWorkload(x.stage, { inv, scope: 'invocation', reason });
  }
}

/** A stop: whatever a stage still holds is cleaned (an interrupted stage cleans its own), then the run ends. */
async function stopRun(x: Exec, reason: Extract<ExitReason, { kind: 'stop' }>): Promise<ExitReason> {
  await recoverReservations(x.stage);
  return reason;
}

// ---------------------------------------------------------------------------------------------------
// Needs-user

/** The stage attempt whose outcome decided the unit's park or stop: what its needs-user is parented by. */
function decidedParent(view: JournalView, unit: UnitId): Parent {
  const f: StageOutcomeFact | null = view.unit(unit).decided;
  if (f === null) throw new Error(`unit ${unit} has no decided outcome`);
  return { type: 'stage', unit, stage: f.stage, attempt: f.attempt };
}

/** The content the arc returned for `unit`, if this result carries one. */
function contentOf(result: ArcResult | null, unit: UnitId): NeedsUserContent | null {
  if (result === null) return null;
  switch (result.kind) {
    case 'terminal': {
      const s = result.units.find((u) => u.unit === unit)?.result;
      return s?.kind === 'parked' ? s.needsUser : null;
    }
    case 'held':
      return null;
    case 'stopped':
      return result.unit === unit ? result.needsUser : null;
  }
}

/**
 * Writes every needs-user now due, once: each parked or stopped unit's (content from `result` when the arc
 * just decided it, else re-read from the driver, which returns it without running anything), and a held
 * unit's arc-wide item (a backend park), parented by the held attempt.
 */
async function raiseDue(x: Exec, result: ArcResult | null): Promise<void> {
  const { journal, runDir } = x.stage;
  for (const unit of x.stage.plan.units) {
    const status = journal.view.unit(unit.id).status;
    if (status !== 'park-pending' && status !== 'stop-pending') continue;
    const parent = decidedParent(journal.view, unit.id);
    if (raisedFor(journal.view, parent) !== null) continue;
    let content = contentOf(result, unit.id);
    if (content === null) {
      const s = await step(x.stage, unit);
      if (s.kind !== 'parked' && s.kind !== 'stopped') throw new Error(`unit ${unit.id} is ${status}, but the driver says ${s.kind}`);
      content = s.needsUser;
    }
    raiseNeedsUser(journal, runDir, content, parent);
  }
  if (result?.kind === 'held' && result.needsUser !== null) {
    const u = journal.view.unit(result.unit);
    const parent: Parent = { type: 'stage', unit: result.unit, stage: u.stage, attempt: u.counters.attempts };
    if (raisedFor(journal.view, parent) === null) raiseNeedsUser(journal, runDir, result.needsUser, parent);
  }
}

function summary(x: Exec): readonly UnitSummary[] {
  const view = x.journal.view;
  return x.stage.plan.units.map((u): UnitSummary => {
    if (view.unit(u.id).status === 'retired') return { unit: u.id, result: 'merged' };
    const id = raisedFor(view, decidedParent(view, u.id));
    if (id === null) throw new Error(`unit ${u.id} is parked without its needs-user`);
    return { unit: u.id, result: 'parked', needsUser: id };
  });
}

/** One line of agent-facing JSON describing how the run ended. */
export function exitLine(reason: ExitReason): string {
  return canonicalJson(reason);
}
