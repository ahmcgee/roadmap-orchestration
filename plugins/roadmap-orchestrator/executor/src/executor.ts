// The executor process (plan "Runtime components"; DESIGN-1.0.md §2.3, §2.10): one run of an arc, from the
// ownership handshake to an exit reason. The supervisor (src/supervisor.ts) spawns it as
//
//   node src/executor.ts <hostDir> --generation <n> --nonce <hex> --repo <abs> --plan <abs> [--profile <p>] [--control-only]
//
// with the claim it holds for this executor in argv, never in the environment. Nothing here acts before the
// handshake: the executor waits for `handshake.<generation>`, verifies that host.owner.json names this
// process under that nonce and generation and that host.lock is that claim, and otherwise exits 78 having
// written nothing at all (not even exit.reason.json). Then:
//
//   runChecks (the startup table but the smoke, frozen order; the host claim is the handshaken one) →
//   refused: `status.rejection.json` in the run dir for exit 78, exit.reason.json{refused}, exit 78/75
//   → `start.json`, the first heartbeat (the supervisor's readiness signal), `executor-started{generation}`
//   (clears the stop marker) → control-only phase (below) → recovery (recover.ts), which closes a smoke
//   spawn a crashed start left open like any other → the outcomes of the stage attempts whose backend call
//   recovery closed are recorded (`consumeRecovered`) → the backend smoke, last of the startup checks (a
//   refusal exits `refused` as above, after readiness) → the command loop:
//
//     control commands (pause, stop, ack) → mutations (resume, sweep) at this safe point → needs-user due
//     → stop marker: stop · a unit stop-pending: stop · everything settled and no open blocking needs-user:
//     complete · a blocking needs-user that holds the arc, the arc or the next unit paused, the next unit
//     held: wait (poll 1 s) · otherwise run the arc.
//
//   A blocking needs-user holds the arc only when it is arc-wide (a host or arc subject, or a reason in
//   ARC_WIDE_REASONS) or concerns the next unit; a unit-scoped park lets later units run (lead ruling 14a).
//   Blocking items include the file-only ones outside the journal: the supervisor's `sup-<gen>-<n>` and a
//   refused claim's `host-<kind>-<n>`, both host-level (`fileNeedsUser`).
//
//   While the arc runs, control commands keep applying every poll. A pause or stop aborts the arc's signal
//   and cancels the live backend or lane invocation of the running stage (`proc.kill{pause|stop}`); the
//   stage records `interrupted` (a hold) and the arc returns. A stop then cleans whatever a stage still
//   holds and exits `stop`; a pause waits in the loop for `resume` or `stop`.
//
// Control-only (`--control-only`, after a supervisor crash-limit exit, R19): before recovery, the executor
// applies control commands (ack, stop, pause) and mutations at the safe point (sweep, resume), and goes on to
// recovery and dispatch only once no blocking needs-user remains; a stop ends the run there. So an `ack` of
// the crash limit is applied by a fresh executor even when recovery is what kept crashing.
//
// The executor never releases the host: it writes exit.reason.json and exits, and its supervisor releases
// the claim after it has exited. Any other end is a crash: a thrown error, no exit reason.
//
// Needs-user content the driver returns is written here with `raiseNeedsUser`, parented by the stage attempt
// that decided it, so an item is raised once however often the arc is re-read (`raisedFor`). A park's item
// is raised the moment the arc hands it over (`runArc`'s `onParked`), while later units still run.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CommandContext } from './commands/apply.ts';
import { applyAtSafePoint, applyCommand, applyControl } from './commands/apply.ts';
import { POLL_MS, isControl, pollCommands } from './commands/queue.ts';
import { containmentFor, detectContainmentMode } from './contain/detect.ts';
import type { Parent, StageOutcomeFact } from './core/events.ts';
import { atomicJson, durableMkdir, durableUnlink, exclusivePublish } from './core/fsx.ts';
import { canonicalJson } from './core/json.ts';
import { type ArcId, type NeedsUserId, type UnitId, hostNeedsUserId, invocationId, needsUserId } from './core/ids.ts';
import type { JournalView } from './core/interfaces.ts';
import type { OpenJournal } from './core/log.ts';
import {
  type ExecutorExitReason, type Heartbeat, type HostLockClaim, type NeedsUserContent, type NeedsUserReason, type NeedsUserRecord, type RunStart,
} from './core/records.ts';
import { type Read, arrayOf, literal, object } from './core/validate.ts';
import { type AbsPath, absPath, isoTimeOf, nonce } from './core/values.ts';
import { SCHEMA_VERSION } from './core/version.ts';
import { hostPath, openHostDir } from './host/hostdir.ts';
import { isAlive, selfIdentity } from './host/liveness.ts';
import { readClaim } from './host/lock.ts';
import { HandshakeAbandonedError, HandshakeMismatchError, HandshakeTimeoutError, OwnerMismatchError, awaitHandshake } from './host/owner.ts';
import type { PlanUnit } from './input/plan.ts';
import { NEEDS_USER_DIR, needsUserPath, openBlocking, raiseNeedsUser, raisedFor, readNeedsUser } from './needsuser.ts';
import { type ArcResult, runArc } from './pipeline/arc.ts';
import type { StageContext } from './pipeline/dispatch.ts';
import { invocationDir, killWorkload } from './pipeline/invoke.ts';
import { consume, step } from './pipeline/unit.ts';
import { runChecks, smokeCheck } from './preflight/checks.ts';
import { backendEnv } from './preflight/smoke.ts';
import {
  EXIT_HOST_BUSY, EXIT_REFUSED, type RejectionFile, type StartupRejection, exitCodeFor, startupRejection,
} from './preflight/startup.ts';
import { recover } from './recover/recover.ts';
import { recoverReservations } from './recover/resource.ts';
import { type ProfileName, profileName } from './routing/types.ts';
import { runnerFiles } from './runner/files.ts';

/** Run dir: the latest start's refusal, for `status` (removed by the next start that passes). */
export const REJECTION_FILE = 'status.rejection.json';
/** Run dir: what the latest passed start runs (repo, plan, resolved profile), for `status`. */
export const START_FILE = 'start.json';
/** Run dir: the executor's heartbeat; the supervisor reads it (readiness, staleness). */
export const HEARTBEAT_FILE = 'heartbeat.json';
/** Host dir: why the executor of a generation ended, when it ended on purpose. */
export const EXIT_REASON_FILE = 'exit.reason.json';
export const HEARTBEAT_MS = 10_000;
/** How long an executor waits for its supervisor's handshake before refusing. */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Reasons whose blocking needs-user holds the whole arc, whatever unit it names (lead ruling 14a). */
export const ARC_WIDE_REASONS = ['usage-limit', 'recovery-required', 'foreign-ref-move', 'residue'] as const satisfies readonly NeedsUserReason[];

export type ExecutorArgs = Readonly<{
  repo: AbsPath;
  planFile: AbsPath;
  /** `start --profile`, or null to let `.roadmap/config.json` choose. */
  profile: ProfileName | null;
  hostDir: AbsPath;
  /** The executor's environment: lanes resolve against it, backends get `backendEnv` of it. */
  env: Readonly<Record<string, string | undefined>>;
  /** The claim the supervisor holds for this executor, handshaken and verified. */
  claim: HostLockClaim;
  /** After a supervisor crash-limit exit: commands before recovery, dispatch only once nothing blocks. */
  controlOnly: boolean;
}>;

export type UnitSummary = Readonly<{ unit: UnitId; result: 'merged' } | { unit: UnitId; result: 'parked'; needsUser: NeedsUserId }>;

/** Why a run ended on purpose. Anything else is a thrown error: a crash, which the supervisor counts. */
export type ExitReason =
  /** Every unit merged, or parked with its needs-user acknowledged. */
  | Readonly<{ kind: 'complete'; units: readonly UnitSummary[] }>
  /** A `stop` command, or a unit whose outcome stopped the arc (its needs-user is raised). */
  | Readonly<{ kind: 'stop'; cause: 'command' | 'unit'; needsUser: NeedsUserId | null }>
  | Readonly<{ kind: 'refused'; rejections: readonly StartupRejection[]; exitCode: typeof EXIT_REFUSED | typeof EXIT_HOST_BUSY }>;

export type RefusedReason = Extract<ExitReason, { kind: 'refused' }>;

/** A refused exit line (the executor's, or the supervisor's at its claim) read back, e.g. by `roadmap start`. */
export const refusedReason: Read<RefusedReason> = object((f) => ({
  kind: f.get('kind', literal('refused')),
  rejections: f.get('rejections', arrayOf(startupRejection, { nonEmpty: true })),
  exitCode: f.get('exitCode', (v, p) => (v === EXIT_HOST_BUSY ? EXIT_HOST_BUSY : literal(EXIT_REFUSED)(v, p))),
}));

export function exitCodeOf(reason: ExitReason): number {
  return reason.kind === 'refused' ? reason.exitCode : 0;
}

/** One line of agent-facing JSON describing how the run ended. */
export function exitLine(reason: ExitReason): string {
  return canonicalJson(reason);
}

export function refusedOf(rejections: readonly StartupRejection[]): RefusedReason {
  const first = rejections[0];
  if (first === undefined) throw new Error('a refusal needs at least one rejection');
  return { kind: 'refused', rejections, exitCode: exitCodeFor(first) };
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

export function writeRejection(runDir: AbsPath, rejections: readonly StartupRejection[]): void {
  durableMkdir(runDir);
  const file: RejectionFile = { v: SCHEMA_VERSION, at: isoTimeOf(new Date()), rejections };
  atomicJson(join(runDir, REJECTION_FILE), file);
}

// ---------------------------------------------------------------------------------------------------
// Needs-user items outside the journal (sup-<gen>-<n>, host-<slug>)

const FILE_ITEM = /^(sup-[0-9]+-[0-9]+|host-[a-z0-9-]+)\.json$/;

/**
 * Writes a host-level blocking needs-user as a file (write-once), outside any journal: the supervisor's
 * crash limit and a refused claim have no open journal to raise through. The executor reads them back with
 * `fileNeedsUser`, and `ack` answers them like any item (the ack fact takes any id form).
 */
export function writeFileNeedsUser(runDir: AbsPath, arc: ArcId, id: NeedsUserId, content: NeedsUserContent): void {
  durableMkdir(join(runDir, NEEDS_USER_DIR));
  const record: NeedsUserRecord = { v: SCHEMA_VERSION, id, arc, raisedAt: isoTimeOf(new Date()), ...content };
  // Published whole: the executor and `status` list the needs-user dir and read what they find.
  exclusivePublish(needsUserPath(runDir, id), canonicalJson(record));
}

/** The claim refusals that carry a durable needs-user (SCHEMAS.md startup table); host-busy is only "try later". */
export type ClaimRefusal = Extract<StartupRejection, { kind: 'owner-mismatch' | 'recovery-holder-dead' | 'previous-arc-unreconciled' }>;

/**
 * The durable needs-user of a claim refused with exit 78 (R17-R18): `host-<kind>-<n>`. A still unacknowledged
 * one of the same kind is the same question and is kept; after an ack, a new refusal asks again as n + 1.
 */
export function raiseClaimRefusal(runDir: AbsPath, arc: ArcId, rejection: ClaimRefusal, detail: string): NeedsUserId {
  const dir = join(runDir, NEEDS_USER_DIR);
  const prefix = `host-${rejection.kind}-`;
  const taken = existsSync(dir)
    ? readdirSync(dir).flatMap((n) => (n.startsWith(prefix) && n.endsWith('.json') && !n.endsWith('.ack.json') ? [Number(n.slice(prefix.length, -'.json'.length))] : []))
    : [];
  const last = Math.max(0, ...taken);
  if (last > 0 && !existsSync(join(dir, `${prefix}${last}.ack.json`))) return hostNeedsUserId(`${rejection.kind}-${last}`);
  const id = hostNeedsUserId(`${rejection.kind}-${last + 1}`);
  writeFileNeedsUser(runDir, arc, id, {
    blocking: true,
    subject: { type: 'host' },
    reason: rejection.kind,
    summary: `roadmap start was refused at the host claim: ${detail}`,
    recommendation: 'Resolve the host state the rejection names (see `roadmap status`), then acknowledge this item and start again.',
    options: [],
    evidence: [],
  });
  return id;
}

/** The file-only items (sup-*, host-*) that no ack in the log answers, ascending id. */
export function fileNeedsUser(runDir: AbsPath, view: JournalView): readonly NeedsUserRecord[] {
  const dir = join(runDir, NEEDS_USER_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const m = FILE_ITEM.exec(name);
    if (m === null) return [];
    const id = needsUserId(m[1]);
    const record = readNeedsUser(runDir, id);
    if (record === null) throw new Error(`needs-user ${name} vanished while it was listed`);
    return view.ackOf(id) === null ? [record] : [];
  });
}

/** Every blocking needs-user no ack answers: the journal's and the file-only ones. */
export function openBlockingItems(runDir: AbsPath, view: JournalView): readonly NeedsUserId[] {
  return [...openBlocking(view), ...fileNeedsUser(runDir, view).filter((r) => r.blocking).map((r) => r.id)];
}

/** The unit the serial arc works on next: the first in plan order that is neither merged nor parked. */
export function nextUnit(units: readonly UnitId[], view: JournalView): UnitId | null {
  return units.find((u) => {
    const s = view.unit(u).status;
    return s !== 'retired' && s !== 'park-pending';
  }) ?? null;
}

/**
 * Whether an open blocking item holds the arc (lead ruling 14a): it is arc-wide (a host or arc subject, or a
 * reason in ARC_WIDE_REASONS), or it names the unit that would run next, or no unit is left to run.
 */
export function holdsArc(record: NeedsUserRecord, next: UnitId | null): boolean {
  if (next === null || record.subject.type !== 'unit') return true;
  if ((ARC_WIDE_REASONS as readonly NeedsUserReason[]).includes(record.reason)) return true;
  return record.subject.unit === next;
}

// ---------------------------------------------------------------------------------------------------
// Start

export async function runExecutor(args: ExecutorArgs): Promise<ExitReason> {
  const { claim } = args;
  const checks = await runChecks({ ...args, claim: async () => ({ kind: 'claimed', claim, previous: null }) });
  if (checks.kind === 'refused') {
    checks.journal?.close();
    return refuse(args, checks.rejections);
  }

  const { context, journal, routing } = checks;
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
    const x: Exec = { stage, commands, journal };
    const stopped = args.controlOnly ? await controlOnly(x) : null;
    if (stopped !== null) {
      writeExitReason(args.hostDir, claim, stopped.kind);
      return stopped;
    }
    // Recovery before the smoke: it closes a smoke spawn a crashed start left open, like any other spawn.
    await recover({ stage, commands });
    await consumeRecovered(x);
    const smoked = await smokeCheck(checks, args.env);
    if (smoked.kind === 'refused') return refuse(args, smoked.rejections);
    const reason = await drive(x);
    writeExitReason(args.hostDir, claim, reason.kind);
    return reason;
  } finally {
    clearInterval(heartbeat);
    journal.close();
  }
}

/** A refused start: `status.rejection.json` for exit 78, then `exit.reason.json {refused}`. */
function refuse(args: ExecutorArgs, rejections: readonly StartupRejection[]): RefusedReason {
  const reason = refusedOf(rejections);
  // A busy host is "try later", not a verdict on this arc: its run dir is left alone.
  if (reason.exitCode === EXIT_REFUSED) writeRejection(args.claim.runDir, reason.rejections);
  writeExitReason(args.hostDir, args.claim, 'refused');
  return reason;
}

/**
 * Records, at startup, the outcome of every stage attempt whose backend call recovery closed (`consume` in
 * unit.ts), and raises the needs-user it decides. Done before the command loop, so a unit that a pause
 * holds does not wait for its next step to learn it was interrupted: one resume releases it (lead ruling, 14c).
 */
async function consumeRecovered(x: Exec): Promise<void> {
  for (const unit of x.stage.plan.units) {
    const s = await consume(x.stage, unit);
    if (s === null) continue;
    if (s.kind === 'parked' || s.kind === 'stopped') {
      const parent = decidedParent(x.journal.view, unit.id);
      if (raisedFor(x.journal.view, parent) === null) raiseNeedsUser(x.journal, x.stage.runDir, s.needsUser, parent);
    } else if (s.kind === 'held' && s.needsUser !== null) {
      await raiseDue(x, { kind: 'held', unit: unit.id, needsUser: s.needsUser, settled: [] });
    }
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

function blockingOpen(x: Exec): readonly NeedsUserId[] {
  return openBlockingItems(x.stage.runDir, x.journal.view);
}

/**
 * The control-only phase: before recovery, so nobody is inside an integration.ff and control commands apply
 * directly. A command whose op the crashed executor left open is recovery's, and waits for it. Returns a stop,
 * or null once no blocking needs-user remains.
 */
async function controlOnly(x: Exec): Promise<ExitReason | null> {
  const arc = x.journal.view.arc;
  for (;;) {
    const view = x.journal.view;
    const open = new Set(view.opsOf('command.apply').filter((i) => view.doneOf(i.op) === null).map((i) => i.expect.command));
    for (const command of pollCommands(x.stage.runDir, arc)) {
      if (isControl(command.body) && !open.has(command.id)) await applyCommand(x.commands, command);
    }
    await applyAtSafePoint(x.commands, pollCommands(x.stage.runDir, arc).filter((c) => !open.has(c.id)));
    if (x.journal.view.control().stop !== null) return { kind: 'stop', cause: 'command', needsUser: null };
    if (blockingOpen(x).length === 0) return null;
    await sleep(POLL_MS);
  }
}

function currentUnit(x: Exec): PlanUnit | null {
  const next = nextUnit(x.stage.plan.units.map((u) => u.id), x.journal.view);
  return x.stage.plan.units.find((u) => u.id === next) ?? null;
}

/** What a pause or stop asks of the running arc, per the durable markers. */
function interruption(x: Exec): 'pause' | 'stop' | null {
  const c = x.journal.view.control();
  if (c.stop !== null) return 'stop';
  const current = currentUnit(x);
  if (c.pausedAll || (current !== null && c.pausedUnits.includes(current.id))) return 'pause';
  return null;
}

/** The needs-user record of a raised id; its file must exist. */
export function recordOf(runDir: AbsPath, id: NeedsUserId): NeedsUserRecord {
  const record = readNeedsUser(runDir, id);
  if (record === null) throw new Error(`needs-user ${id} is raised but ${needsUserPath(runDir, id)} does not exist`);
  return record;
}

/** Why the loop does not dispatch now, or null when it may. */
function waitReason(x: Exec, current: PlanUnit): string | null {
  const view = x.journal.view;
  const holding = blockingOpen(x).filter((id) => holdsArc(recordOf(x.stage.runDir, id), current.id));
  if (holding.length > 0) return `blocking needs-user ${holding.join(', ')}`;
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
    if (current === null && blockingOpen(x).length === 0) return { kind: 'complete', units: summary(x) };
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
  const running = runArc(x.stage, abort.signal, (unit, content) => raiseParked(x, unit, content)).finally(() => {
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
 * A parked unit's needs-user, raised as the arc hands it over (`runArc`'s `onParked`), so the item is open
 * while later units run; parented by the attempt that parked the unit, so it is raised once.
 */
function raiseParked(x: Exec, unit: UnitId, content: NeedsUserContent): void {
  const { journal, runDir } = x.stage;
  const parent = decidedParent(journal.view, unit);
  if (raisedFor(journal.view, parent) === null) raiseNeedsUser(journal, runDir, content, parent);
}

/**
 * Writes every needs-user now due, once: each parked or stopped unit's not yet raised (content from
 * `result` when the arc just decided it, else re-read from the driver, which returns it without running
 * anything), and a held unit's arc-wide item (a backend park), parented by the held attempt.
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

// ---------------------------------------------------------------------------------------------------
// The process entry

export type ExecutorArgv = Readonly<{
  hostDir: AbsPath; generation: number; nonce: string; repo: AbsPath; planFile: AbsPath; profile: ProfileName | null; controlOnly: boolean;
}>;

/** The argv the supervisor builds (`executorArgv`) and this entry parses back. */
export function executorArgv(a: ExecutorArgv): readonly string[] {
  return [
    a.hostDir, '--generation', String(a.generation), '--nonce', a.nonce, '--repo', a.repo, '--plan', a.planFile,
    ...(a.profile === null ? [] : ['--profile', a.profile]), ...(a.controlOnly ? ['--control-only'] : []),
  ];
}

function parseExecutorArgv(argv: readonly string[]): ExecutorArgv {
  const [hostDir, ...rest] = argv;
  if (hostDir === undefined) throw new Error('usage: executor <hostDir> --generation <n> --nonce <hex> --repo <abs> --plan <abs> [--profile <p>] [--control-only]');
  const values = new Map<string, string>();
  let controlOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] as string;
    if (flag === '--control-only') {
      controlOnly = true;
      continue;
    }
    const value = rest[i + 1];
    if (!['--generation', '--nonce', '--repo', '--plan', '--profile'].includes(flag) || value === undefined || values.has(flag)) {
      throw new Error(`executor: unexpected argument ${JSON.stringify(flag)} in ${JSON.stringify(argv)}`);
    }
    values.set(flag, value);
    i++;
  }
  const need = (flag: string): string => {
    const v = values.get(flag);
    if (v === undefined) throw new Error(`executor: ${flag} is required`);
    return v;
  };
  const generation = Number(need('--generation'));
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error(`executor: --generation must be a positive integer, got ${need('--generation')}`);
  const profile = values.get('--profile');
  return {
    hostDir: absPath(hostDir), generation, nonce: need('--nonce'), repo: absPath(need('--repo')), planFile: absPath(need('--plan')),
    profile: profile === undefined ? null : profileName(profile, '--profile'), controlOnly,
  };
}

/** Why an executor refused before any effect, or its verified claim. */
async function handshake(a: ExecutorArgv): Promise<HostLockClaim | string> {
  const ref = { nonce: nonce(a.nonce), generation: a.generation };
  // The claim is published before the spawn: while host.lock is still this claim, its supervisor is ours.
  const supervisorAlive = (): boolean => {
    const held = readClaim(a.hostDir);
    return held !== null && held.nonce === ref.nonce && isAlive(held.supervisor, held.bootId);
  };
  try {
    await awaitHandshake(a.hostDir, ref, selfIdentity(), HANDSHAKE_TIMEOUT_MS, supervisorAlive);
  } catch (error) {
    const refused = error instanceof HandshakeTimeoutError || error instanceof HandshakeAbandonedError || error instanceof HandshakeMismatchError || error instanceof OwnerMismatchError;
    if (!refused) throw error;
    return error.message;
  }
  const claim = readClaim(a.hostDir);
  if (claim === null || claim.nonce !== ref.nonce || claim.generation !== ref.generation) {
    return `host.lock is ${claim === null ? 'absent' : `the claim of nonce ${claim.nonce} generation ${claim.generation}`}, not this executor's (nonce ${ref.nonce} generation ${ref.generation})`;
  }
  return claim;
}

/** Runs one executor process; returns its exit code. A refused handshake writes nothing and exits 78. */
export async function executorMain(argv: readonly string[]): Promise<number> {
  const a = parseExecutorArgv(argv);
  const claim = await handshake(a);
  if (typeof claim === 'string') {
    process.stderr.write(`roadmap executor: refused before any effect: ${claim}\n`);
    return EXIT_REFUSED;
  }
  openHostDir(a.hostDir);
  const reason = await runExecutor({
    repo: a.repo, planFile: a.planFile, profile: a.profile, hostDir: a.hostDir, env: process.env, claim, controlOnly: a.controlOnly,
  });
  process.stdout.write(`${exitLine(reason)}\n`);
  return exitCodeOf(reason);
}

if (import.meta.main) process.exitCode = await executorMain(process.argv.slice(2));
