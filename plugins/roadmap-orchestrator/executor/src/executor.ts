// The executor process (plan "Runtime components"; DESIGN-1.0.md §2.3, §2.10): one run of an arc, from the
// ownership handshake to an exit reason. The supervisor (src/supervisor.ts) spawns it as
//
//   node src/entry/executor.ts <hostDir> --generation <n> --nonce <hex> --repo <abs> --plan <abs> [--profile <p>] [--control-only] [--respawn]
//
// with the claim it holds for this executor in argv, never in the environment. Nothing here acts before the
// handshake: the executor waits for `handshake.<generation>`, verifies that host.owner.json names this
// process under that nonce and generation and that host.lock is that claim, and otherwise exits 78 having
// written nothing at all (not even exit.reason.json). Then:
//
//   runChecks (the startup table but the smoke, frozen order; the host claim is the handshaken one; last,
//   the plan in force: a start puts changed files in force through the apply rules, a `--respawn` after a
//   crash runs the plan in force and ignores unapplied edits) →
//   refused: `status.rejection.json` in the run dir for exit 78, exit.reason.json{refused}, exit 78/75
//   → `start.json`, the first heartbeat (the supervisor's readiness signal), `executor-started{generation}`
//   (clears the stop marker) → control-only phase (below) → recovery (recover.ts), which closes a smoke
//   spawn a crashed start left open like any other → the outcomes of the stage attempts whose backend call
//   recovery closed are recorded (`consumeRecovered`) → the backend smoke, last of the startup checks (a
//   refusal exits `refused` as above, after readiness; on a respawn a failed backend is parked instead, A18)
//   → the scheduler (src/schedule/scheduler.ts), which runs every unit that may run, each in its own task, and
//   the holistic layer's jobs (baseline, audits, checkpoints, repair batches, the close-out), applies commands as
//   they arrive (control at once, mutations once their scope drains), probes parks, raises what is due, and
//   returns `complete` or `stop`. After recovery and before the scheduler, the findings' moves the recovered log
//   calls for are written (`syncRepairs`, M3 B3).
//
//   The contexts' `plan` and `routing` are the plan in force and its routing, read from the log at each call
//   (`plan()`, `routing()`), so an apply takes effect at the next one. One arbiter serves every reservation of
//   the run, and one prober every probe (the scheduler's jobs, `resume <unit>` of a retryable park, `resume
//   --backend`). The run's stop controller is aborted by the scheduler when the run stops: it ends a probe or
//   a mutation's smoke the stop killed.
//
// Control-only (`--control-only`, after a supervisor crash-limit exit, R19): before recovery, the executor
// applies control commands (ack, stop, pause) and mutations at the safe point (sweep, resume), and goes on to
// recovery and dispatch only once no blocking needs-user remains; a stop ends the run there. So an `ack` of
// the crash limit is applied by a fresh executor even when recovery is what kept crashing.
//
// The executor never releases the host: it writes exit.reason.json and exits, and its supervisor releases
// the claim after it has exited. Any other end is a crash: a thrown error, no exit reason.
//
// Needs-user content the driver returns is written with `raiseNeedsUser` (the scheduler's `raiseResult`),
// parented by the stage attempt that decided it, so an item is raised once however often the arc is re-read
// (`raisedFor`). Blocking items include the file-only ones outside the journal: the supervisor's
// `sup-<gen>-<n>` and a refused claim's `host-<kind>-<n>` (`writeFileNeedsUser` here; read by needsuser.ts).
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CommandContext } from './commands/apply.ts';
import { applyAtSafePoint, applyCommand } from './commands/apply.ts';
import { POLL_MS, isControl, pollCommands } from './commands/queue.ts';
import { containmentFor, detectContainmentMode } from './contain/detect.ts';
import { atomicJson, durableMkdir, durableUnlink, exclusivePublish } from './core/fsx.ts';
import { canonicalJson } from './core/json.ts';
import { type ArcId, type NeedsUserId, type PlanRev, type UnitId, hostNeedsUserId } from './core/ids.ts';
import type { OpenJournal } from './core/log.ts';
import {
  type ExecutorExitReason, type Heartbeat, type HostLockClaim, type NeedsUserContent, type NeedsUserRecord, type RunStart,
} from './core/records.ts';
import { routingProvenanceOf } from './core/upgrade.ts';
import { type Read, arrayOf, literal, object } from './core/validate.ts';
import { type AbsPath, absPath, isoTimeOf, nonce } from './core/values.ts';
import { SCHEMA_VERSION } from './core/version.ts';
import { readLegacyProvenance } from './git/snapshot.ts';
import { hostPath, openHostDir } from './host/hostdir.ts';
import { isAlive, selfIdentity } from './host/liveness.ts';
import { readClaim } from './host/lock.ts';
import { HandshakeAbandonedError, HandshakeMismatchError, HandshakeTimeoutError, OwnerMismatchError, awaitHandshake } from './host/owner.ts';
import { readHostSample } from './host/sample.ts';
import { requirePlanInForce, routingProvenanceOf as provenanceOf } from './input/inforce.ts';
import type { PlanM1 } from './input/plan.ts';
import { NEEDS_USER_DIR, needsUserPath, openBlockingItems } from './needsuser.ts';
import { type ProberHandle, createProber } from './park/probe.ts';
import type { StageContext } from './pipeline/dispatch.ts';
import { docsPublisher } from './pipeline/publish.ts';
import { syncRepairs } from './pipeline/reproduce.ts';
import { consume } from './pipeline/unit.ts';
import { readRepoConfig, runChecks, smokeCheck } from './preflight/checks.ts';
import { backendEnv } from './preflight/smoke.ts';
import {
  EXIT_HOST_BUSY, EXIT_REFUSED, type RejectionFile, type StartupContext, type StartupRejection, exitCodeFor, startupRejection,
} from './preflight/startup.ts';
import { recover } from './recover/recover.ts';
import { type ResolvedRouting, arcScopeOf, provenanceStack, resolveRouting } from './routing/layers.ts';
import { type ProfileName, type RoutingProvenance, profileName } from './routing/types.ts';
import { type Arbiter, createArbiter } from './schedule/arbiter.ts';
import { rankOf } from './schedule/ready.ts';
import { type SchedulerEnd, designRoute, holisticContexts, raiseResult, schedule } from './schedule/scheduler.ts';

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
  /** A supervisor's respawn after a crash, once one of its generations was ready: runs the plan in force, never the files (`runChecks`). */
  respawn: boolean;
}>;

/**
 * Why a run ended on purpose: the scheduler's `complete` (every unit merged, cut, superseded, or parked with
 * its needs-user acknowledged) or `stop`, or a refused start. Anything else is a thrown error: a crash, which
 * the supervisor counts.
 */
export type ExitReason =
  | SchedulerEnd
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

/**
 * Writes a host-level blocking needs-user as a file (write-once), outside any journal: the supervisor's
 * crash limit and a refused claim have no open journal to raise through. The executor reads them back with
 * `fileNeedsUser` (needsuser.ts), and `ack` answers them like any item (the ack fact takes any id form).
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

// ---------------------------------------------------------------------------------------------------
// Start

export async function runExecutor(args: ExecutorArgs): Promise<ExitReason> {
  const { claim } = args;
  const checks = await runChecks({
    ...args, claim: async () => ({ kind: 'claimed', claim, previous: null }), respawn: args.respawn ? { runDir: claim.runDir, arc: claim.arc } : null,
  });
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

    const x = contexts(args, context, routing.profile, journal);
    const stopped = args.controlOnly ? await controlOnly(x) : null;
    if (stopped !== null) {
      writeExitReason(args.hostDir, claim, stopped.kind);
      return stopped;
    }
    // Recovery before the smoke: it closes a smoke spawn a crashed start left open, like any other spawn.
    await recover({ stage: x.stage, commands: x.commands });
    // M3 (B3): the findings' moves the recovered log calls for (ownership, a killed mutant's dismissal).
    syncRepairs(x.stage);
    await consumeRecovered(x);
    const smoked = await smokeCheck(checks, args.env);
    if (smoked.kind === 'refused') return refuse(args, smoked.rejections);
    const reason = await schedule(x);
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
 * unit.ts), and raises the needs-user it decides. Done before the scheduler, so a unit that a pause holds
 * does not wait for its next step to learn it was interrupted: one resume releases it (lead ruling, 14c).
 */
async function consumeRecovered(x: Exec): Promise<void> {
  const route = designRoute(holisticContexts(x));
  for (const unit of x.stage.plan().units) {
    const s = await consume(x.stage, unit);
    if (s !== null && s.kind !== 'continue') raiseResult(x.stage, unit.id, s, route);
  }
}

// ---------------------------------------------------------------------------------------------------
// The contexts: the plan and routing in force are read from the log at each call

/**
 * The contexts of a run. `plan()` is the plan in force (`planInForce`) and `routing(unit)` its resolution under
 * the start's profile and repo config, both read at each call, so an apply takes effect at the next one; each
 * plan revision is parsed and resolved once (the one cache of the plan in force). The stage context's
 * `acquire` is the run's arbiter and its signal is never aborted: each unit's task gets its own
 * (src/schedule/scheduler.ts). The prober and the run's stop controller serve the commands too.
 */
function contexts(args: ExecutorArgs, context: StartupContext, profile: ProfileName, journal: OpenJournal): Exec {
  const config = readRepoConfig(context.repo);
  // H7 (M3 steps A3, B7): each revision's routing resolves from the provenance its plan-applied recorded, per unit (its
  // layer on top). A 1.0.0-dev.5 revision has none: it resolves from the record the adoption persisted
  // (`routing-provenance/<rev>.json`, `adoptLegacyProvenance` in `runChecks`), never from the repo config read again at a
  // later start (lead ruling: one canonical source).
  type Entry = Readonly<{ plan: PlanM1; routing: (unit: UnitId | null) => ResolvedRouting }>;
  const cache = new Map<string, Entry>();
  const inForce = (): Entry => {
    const fact = journal.view.planApplied();
    const key = fact === null ? '' : `${fact.rev}:${fact.planSha256}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const { plan, fact: applied } = requirePlanInForce(context.runDir, journal.view);
    const provenance = routingProvenanceOf(applied, () => adoptedProvenance(context.runDir, applied.rev, () => provenanceOf({ profile, config }, plan)));
    const resolved = new Map<UnitId | null, ResolvedRouting>();
    const routingOf = (unit: UnitId | null): ResolvedRouting => {
      const hit = resolved.get(unit);
      if (hit !== undefined) return hit;
      const r = resolveRouting(provenanceStack(provenance, arcScopeOf(plan), unit));
      resolved.set(unit, r);
      return r;
    };
    const entry = { plan, routing: routingOf };
    cache.set(key, entry);
    return entry;
  };
  const routing = (unit: UnitId | null): ResolvedRouting => inForce().routing(unit);
  const base = {
    journal, containment: containmentFor(detectContainmentMode()), runDir: context.runDir, repo: context.repo, hostDir: context.hostDir,
    planDir: absPath(dirname(context.planFile)),
  };
  const resources = { ...base, plan: () => inForce().plan };
  const arbiter = createArbiter(resources);
  const stage: StageContext = {
    ...resources,
    hostEnv: args.env,
    routing,
    acquire: arbiter.acquire,
    rank: (unit) => rankOf(journal.view, inForce().plan, unit),
    signal: new AbortController().signal,
  };
  const prober = createProber({ ...stage, profile, sample: readHostSample });
  const stop = new AbortController();
  const commands: CommandContext = {
    ...base,
    hostEnv: backendEnv(args.env),
    laneEnv: args.env,
    planFile: context.planFile,
    routingBase: { profile, config },
    docs: docsPublisher({ ...resources, hostEnv: args.env, planFile: context.planFile, arbiter }),
    plan: () => inForce().plan,
    routing: (unit) => ({ profile, resolved: routing(unit) }),
    probes: { prober, signal: stop.signal },
  };
  return { stage, commands, journal, arbiter, prober, stop };
}

/**
 * The routing provenance a 1.0.0-dev.5 revision's adoption persisted (scaffolding: delete with the other dev.5
 * defaults). An unreconstructable one (its routing revs are none the adopting start's config resolves) has no
 * provenance to read: the revision resolves as a dev.5 executor resolved it, from the repo config of this start
 * (`rebuild`), warned; a missing record is a bug (every start adopts before it runs).
 */
function adoptedProvenance(runDir: AbsPath, rev: PlanRev, rebuild: () => RoutingProvenance): RoutingProvenance {
  const adopted = readLegacyProvenance(runDir, rev);
  if (adopted.kind === 'reconstructed') return adopted.provenance;
  process.stderr.write(`roadmap: upgrade (routing provenance, H7): ${adopted.reason}; plan rev ${rev} resolves under the repo config of this start\n`);
  return rebuild();
}

// ---------------------------------------------------------------------------------------------------
// Control-only

type Exec = Readonly<{
  stage: StageContext; commands: CommandContext; journal: OpenJournal; arbiter: Arbiter; prober: ProberHandle; stop: AbortController;
}>;

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
    if (openBlockingItems(x.stage.runDir, x.journal.view).length === 0) return null;
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------------------------------
// The process entry

export type ExecutorArgv = Readonly<{
  hostDir: AbsPath; generation: number; nonce: string; repo: AbsPath; planFile: AbsPath; profile: ProfileName | null; controlOnly: boolean; respawn: boolean;
}>;

/** The argv the supervisor builds (`executorArgv`) and this entry parses back. */
export function executorArgv(a: ExecutorArgv): readonly string[] {
  return [
    a.hostDir, '--generation', String(a.generation), '--nonce', a.nonce, '--repo', a.repo, '--plan', a.planFile,
    ...(a.profile === null ? [] : ['--profile', a.profile]), ...(a.controlOnly ? ['--control-only'] : []), ...(a.respawn ? ['--respawn'] : []),
  ];
}

function parseExecutorArgv(argv: readonly string[]): ExecutorArgv {
  const [hostDir, ...rest] = argv;
  if (hostDir === undefined) throw new Error('usage: executor <hostDir> --generation <n> --nonce <hex> --repo <abs> --plan <abs> [--profile <p>] [--control-only] [--respawn]');
  const values = new Map<string, string>();
  let controlOnly = false;
  let respawn = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] as string;
    if (flag === '--control-only' || flag === '--respawn') {
      if (flag === '--control-only') controlOnly = true;
      else respawn = true;
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
    profile: profile === undefined ? null : profileName(profile, '--profile'), controlOnly, respawn,
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
    repo: a.repo, planFile: a.planFile, profile: a.profile, hostDir: a.hostDir, env: process.env, claim, controlOnly: a.controlOnly, respawn: a.respawn,
  });
  process.stdout.write(`${exitLine(reason)}\n`);
  return exitCodeOf(reason);
}

