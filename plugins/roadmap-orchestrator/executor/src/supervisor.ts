// The supervisor (plan "Supervisor (R19)", "Host lock and ownership (R17-R18)"; DESIGN-1.0.md §2): it owns
// the executor and nothing else.
//
//   node src/entry/supervisor.ts <hostDir> --repo <abs> --plan <abs> [--profile <p>] [--heartbeat-stale-ms <n>]
//
// `roadmap start` launches it (`launchSupervisor`) detached (setsid) with ROADMAP_ROLE=supervisor, stdout and
// stderr to `supervisor.<token>.out|.err` in the host dir. Its stdout is agent-facing JSON lines: one
// `{kind: claimed, generation}` per claim it holds, or the refused exit line when it cannot claim.
//
//   claim (claimHost, under the recovery lock; a takeover of another arc reconciles that arc's surviving
//   invocations first, recover.ts) → residue-index compaction (src/host/compact.ts, once per start) → per executor:
//     spawn `node src/entry/executor.ts` (claim in argv; stdio to `executor.<generation>.out|.err`; every
//     executor after one of this supervisor's generations was ready is a `--respawn`: it runs the plan in
//     force and ignores unapplied plan edits; before that, a respawn is a start that reads the files, since
//     a generation that crashed before readiness may not have put them in force yet)
//     → publish host.owner.json naming it → write `handshake.<generation>`
//     → watch: its first heartbeat of this generation is readiness (`supervisor.ready.<generation>`: the
//       executor passed its startup checks); every 10 s the heartbeat is checked, and one older than the
//       stale threshold (5 min) gets the executor SIGKILLed and counted as a crash (its invocations' runners
//       are left for the next executor's recovery to adopt)
//     → exit with `exit.reason.json` of this generation (stop, complete, refused): intentional, never a crash.
//       The executor has exited; the supervisor releases the claim, then writes the readiness marker still
//       owed (ready, or `supervisor.failed.<generation>` carrying a refusal's exit line) and exits with the
//       executor's code.
//     → any other exit: a crash, recorded in `supervisor.state.json` (the rolling one-hour window survives
//       supervisor restarts). Below the limit: back off 2 s, then 10 s, renew the claim (a new generation,
//       so the next executor has its own handshake) and spawn again. The third crash in the window: write
//       `needs-user/sup-<generation>-<n>.json` (blocking, host-level), release, exit.
//
// A supervisor that starts with the window already at the limit (a start after a crash-limit exit) runs its
// first executor with `--control-only`: it applies commands before recovery and dispatches only once no
// blocking needs-user remains (src/executor.ts). The limit leaves no room for a third backoff step: the
// plan's 2/10/60 s sequence ends at the needs-user on the third crash.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { identityOf, signal } from './contain/proc.ts';
import { crashPoint } from './core/crash.ts';
import { atomicJson, canonicalJson as fileJson, durableUnlink, exclusivePublish, readJson } from './core/fsx.ts';
import { LogCorruptError } from './core/log.ts';
import { supervisorNeedsUserId } from './core/ids.ts';
import { canonicalJson } from './core/json.ts';
import {
  type ExecutorExitReason, type HostLockClaim, type NeedsUserContent, type ProcIdentity, type ReadinessFile, type SupervisorState, executorExitReason, heartbeat,
  readinessFile, supervisorState,
} from './core/records.ts';
import { type Read, literal, object, positive, tagged } from './core/validate.ts';
import { type AbsPath, type IsoTime, absPath, isoTimeOf } from './core/values.ts';
import { SCHEMA_VERSION } from './core/version.ts';
import {
  EXIT_REASON_FILE, HEARTBEAT_FILE, type RefusedReason, executorArgv, exitLine, raiseClaimRefusal, refusedOf, refusedReason, writeFileNeedsUser,
  writeRejection,
} from './executor.ts';
import { compactResidues } from './host/compact.ts';
import { hostPath, openHostDir } from './host/hostdir.ts';
import { selfIdentity } from './host/liveness.ts';
import { claimHost, releaseHost, renewClaim } from './host/lock.ts';
import { createHandshake, publishOwner } from './host/owner.ts';
import { runDir as runDirOf } from './input/cli.ts';
import { gitCommonDir, legacyRoadmapDir, loadPlan } from './preflight/checks.ts';
import type { StartupRejection } from './preflight/startup.ts';
import { reconcilePreviousArc } from './recover/recover.ts';
import { type ProfileName, profileName } from './routing/types.ts';

export const SUPERVISOR_STATE = 'supervisor.state.json';
export const SUPERVISOR_ENTRY = fileURLToPath(new URL('./entry/supervisor.ts', import.meta.url));
const EXECUTOR_ENTRY = fileURLToPath(new URL('./entry/executor.ts', import.meta.url));

export const ROLE_ENV = 'ROADMAP_ROLE';
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 60 * 60_000;
/** Backoff before the restart after the n-th crash in the window; the limit ends the run at the third. */
export const BACKOFF_MS = [2_000, 10_000] as const;
export const HEARTBEAT_STALE_MS = 5 * 60_000;
export const HEARTBEAT_CHECK_MS = 10_000;
/**
 * How long `roadmap start` waits for its own generation's readiness by default (`--wait <ms>` overrides):
 * longer than the smoke's deadline (180 s), so a smoke refusal always reaches the caller (lead ruling 14b).
 */
export const START_WAIT_MS = 240_000;
/** `roadmap start` when the supervisor failed or did not report in time (EX_SOFTWARE). */
export const EXIT_START_FAILED = 70;
const TICK_MS = 200;

export const readyPath = (dir: AbsPath, generation: number): AbsPath => hostPath(dir, `supervisor.ready.${generation}`);
export const failedPath = (dir: AbsPath, generation: number): AbsPath => hostPath(dir, `supervisor.failed.${generation}`);
export type Logs = Readonly<{ out: AbsPath; err: AbsPath }>;
export const executorLogs = (dir: AbsPath, generation: number): Logs =>
  ({ out: hostPath(dir, `executor.${generation}.out`), err: hostPath(dir, `executor.${generation}.err`) });
const supervisorLogs = (dir: AbsPath, token: string): Logs =>
  ({ out: hostPath(dir, `supervisor.${token}.out`), err: hostPath(dir, `supervisor.${token}.err`) });

export type SupervisorArgs = Readonly<{
  hostDir: AbsPath;
  repo: AbsPath;
  planFile: AbsPath;
  profile: ProfileName | null;
  /** Only when `--heartbeat-stale-ms` is given; recorded in supervisor.state.json. */
  heartbeatStaleMs: number | null;
}>;

/** A line on the supervisor's stdout. */
export type SupervisorLine = Readonly<{ kind: 'claimed'; generation: number }> | RefusedReason;
export const supervisorLine: Read<SupervisorLine> = tagged<'claimed' | 'refused', SupervisorLine>('kind', {
  claimed: object((f) => ({ kind: f.get('kind', literal('claimed')), generation: f.get('generation', positive) })),
  refused: refusedReason,
});

function emit(line: SupervisorLine): void {
  process.stdout.write(`${canonicalJson(line)}\n`);
}

// ---------------------------------------------------------------------------------------------------
// Generation files: what each generation leaves in the host dir, pruned by `roadmap gc` (A5b)

const GENERATION_FILE = /^(?:handshake|supervisor\.ready|supervisor\.failed)\.([1-9][0-9]*)$|^executor\.([1-9][0-9]*)\.(?:out|err)$/;
const SUPERVISOR_OUT = /^supervisor\.([0-9a-f]{16})\.out$/;
const SUPERVISOR_LOG = /^supervisor\.([0-9a-f]{16})\.(?:out|err)$/;

/** The generations a supervisor's stdout log claimed, from its complete lines. */
function claimedGenerations(out: AbsPath): readonly number[] {
  const lines = readFileSync(out, 'utf8').split('\n');
  lines.pop();
  return lines.flatMap((text) => {
    const line = supervisorLine(JSON.parse(text), out);
    return line.kind === 'claimed' ? [line.generation] : [];
  });
}

/**
 * The host files of every generation before the last `keep` issued, `generation` (the caller's claim's, held, or
 * the one it would claim) being the last: `handshake.<g>`, `supervisor.ready|failed.<g>`, `executor.<g>.out|err`,
 * and a supervisor's `supervisor.<token>.out|err` once the newest generation it claimed is among them. A supervisor
 * log that claimed nothing (a refused start, or one still starting) is left. So is every file of a generation a path
 * of `cited` (an open needs-user item's evidence) belongs to: a generation file of it, or a supervisor log that
 * claimed it. Sorted.
 */
export function generationFilesToPrune(dir: AbsPath, generation: number, keep: number, cited: readonly AbsPath[]): readonly string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep ${keep}: the held generation is always kept`);
  const oldest = generation - keep + 1;
  const citedGenerations = new Set<number>();
  for (const path of cited) {
    if (dirname(path) !== dir) continue;
    const g = GENERATION_FILE.exec(basename(path));
    if (g !== null) citedGenerations.add(Number(g[1] ?? g[2]));
    const s = SUPERVISOR_LOG.exec(basename(path));
    const out = s === null ? null : hostPath(dir, `supervisor.${s[1]}.out`);
    if (out !== null && existsSync(out)) for (const c of claimedGenerations(out)) citedGenerations.add(c);
  }
  const doomed: string[] = [];
  for (const name of readdirSync(dir)) {
    const g = GENERATION_FILE.exec(name);
    if (g !== null) {
      const of = Number(g[1] ?? g[2]);
      if (of < oldest && !citedGenerations.has(of)) doomed.push(name);
      continue;
    }
    const s = SUPERVISOR_OUT.exec(name);
    if (s === null) continue;
    const claimed = claimedGenerations(hostPath(dir, name));
    if (claimed.length > 0 && Math.max(...claimed) < oldest && !claimed.some((c) => citedGenerations.has(c))) doomed.push(name, `supervisor.${s[1]}.err`);
  }
  return doomed.sort();
}

/** Deletes `generationFilesToPrune`'s files (`roadmap gc`, src/commands/gc.ts). Returns the names deleted, sorted. */
export function pruneGenerationFiles(dir: AbsPath, claim: HostLockClaim, keep: number, cited: readonly AbsPath[]): readonly string[] {
  const doomed = generationFilesToPrune(dir, claim.generation, keep, cited);
  for (const name of doomed) durableUnlink(hostPath(dir, name));
  return doomed;
}

// ---------------------------------------------------------------------------------------------------
// Host files

/** The crash window as of `now`: persisted crashes within the last hour. */
function recentCrashes(dir: AbsPath, now: number): IsoTime[] {
  const path = hostPath(dir, SUPERVISOR_STATE);
  if (!existsSync(path)) return [];
  return supervisorState(readJson(path), SUPERVISOR_STATE).crashes.filter((at) => now - Date.parse(at) < CRASH_WINDOW_MS);
}

function saveState(dir: AbsPath, generation: number, crashes: readonly IsoTime[], heartbeatStaleMs: number): void {
  const state: SupervisorState = { v: SCHEMA_VERSION, generation, crashes, heartbeatStaleMs };
  atomicJson(hostPath(dir, SUPERVISOR_STATE), state);
}

function writeReadiness(dir: AbsPath, generation: number, failure: string | null): void {
  const at = isoTimeOf(new Date());
  const file: ReadinessFile = failure === null
    ? { v: SCHEMA_VERSION, generation, state: 'ready', at }
    : { v: SCHEMA_VERSION, generation, state: 'failed', at, reason: failure };
  // Published whole: `roadmap start` polls for it and must never read it half-written.
  exclusivePublish(failure === null ? readyPath(dir, generation) : failedPath(dir, generation), fileJson(file));
}

export function readReadiness(dir: AbsPath, generation: number): ReadinessFile | null {
  for (const path of [readyPath(dir, generation), failedPath(dir, generation)]) {
    if (existsSync(path)) return readinessFile(readJson(path), `supervisor readiness ${generation}`);
  }
  return null;
}

function exitReasonOf(dir: AbsPath, generation: number): ExecutorExitReason | null {
  const path = hostPath(dir, EXIT_REASON_FILE);
  if (!existsSync(path)) return null;
  const reason = executorExitReason(readJson(path), EXIT_REASON_FILE);
  return reason.generation === generation ? reason : null;
}

function heartbeatAt(claim: HostLockClaim): number | null {
  const path = join(claim.runDir, HEARTBEAT_FILE);
  if (!existsSync(path)) return null;
  const beat = heartbeat(readJson(path), HEARTBEAT_FILE);
  return beat.generation === claim.generation ? Date.parse(beat.at) : null;
}

/** The last complete line of a log file, or null. */
export function lastLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.pop();
  return lines.at(-1) ?? null;
}

function firstLine(path: string): string | null {
  const text = readFileSync(path, 'utf8');
  const end = text.indexOf('\n');
  return end === -1 ? null : text.slice(0, end);
}

// ---------------------------------------------------------------------------------------------------
// One executor

/** The readiness marker a generation still owes when its executor has ended. */
type Owed = Readonly<{ kind: 'none' }> | Readonly<{ kind: 'ready' }> | Readonly<{ kind: 'failed'; reason: string }>;

type End =
  | Readonly<{ kind: 'intentional'; code: number; owed: Owed }>
  | Readonly<{ kind: 'crash'; detail: string; owed: Owed }>;

type Exited = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

async function superviseOne(args: SupervisorArgs, claim: HostLockClaim, controlOnly: boolean, respawn: boolean, staleMs: number): Promise<End> {
  const dir = args.hostDir;
  const logs = executorLogs(dir, claim.generation);
  const out = openSync(logs.out, 'a');
  const err = openSync(logs.err, 'a');
  const env = { ...process.env };
  delete env[ROLE_ENV];
  const argv = executorArgv({
    hostDir: dir, generation: claim.generation, nonce: claim.nonce, repo: args.repo, planFile: args.planFile, profile: args.profile, controlOnly, respawn,
  });
  const child = spawn(process.execPath, [EXECUTOR_ENTRY, ...argv], { stdio: ['ignore', out, err], env });
  closeSync(out);
  closeSync(err);
  let exited: Exited | null = null;
  const ended = new Promise<void>((resolve) => child.once('exit', (code, sig) => {
    exited = { code, signal: sig };
    resolve();
  }));
  if (child.pid === undefined) throw new Error(`spawning the executor of generation ${claim.generation} failed`);
  crashPoint('sup.after-spawn');
  // Read synchronously after the spawn: the child cannot have been reaped yet, so its identity is exact.
  const { pid, start } = identityOf(child.pid);
  const executor: ProcIdentity = { pid, start };
  publishOwner(dir, claim, executor);
  crashPoint('sup.after-owner-publish');
  createHandshake(dir, claim);
  crashPoint('sup.after-handshake');

  const spawnedAt = Date.now();
  let ready = false;
  let checkedAt = spawnedAt;
  let stale: string | null = null;
  for (;;) {
    await Promise.race([ended, sleep(TICK_MS)]);
    if (exited !== null) break;
    const beat = heartbeatAt(claim);
    if (!ready && beat !== null) {
      writeReadiness(dir, claim.generation, null);
      ready = true;
    }
    if (stale === null && Date.now() - checkedAt >= HEARTBEAT_CHECK_MS) {
      checkedAt = Date.now();
      const age = checkedAt - (beat ?? spawnedAt);
      if (age > staleMs) {
        stale = `its heartbeat was ${age} ms old (stale after ${staleMs} ms), so it was SIGKILLed`;
        signal(executor, 'SIGKILL');
      }
    }
  }
  const how: Exited = exited;

  const owed = (failure: Owed): Owed => (ready ? { kind: 'none' } : failure);
  const reason = exitReasonOf(dir, claim.generation);
  if (reason !== null && stale === null) {
    if (reason.reason !== 'refused') return { kind: 'intentional', code: 0, owed: owed({ kind: 'ready' }) };
    const line = lastLine(logs.out);
    if (line === null) throw new Error(`executor generation ${claim.generation} refused without printing its exit line to ${logs.out}`);
    return { kind: 'intentional', code: refusedReason(JSON.parse(line), logs.out).exitCode, owed: owed({ kind: 'failed', reason: line }) };
  }
  const detail = stale ?? `it exited (code ${how.code}, signal ${how.signal}) without an exit reason`;
  return { kind: 'crash', detail, owed: owed({ kind: 'failed', reason: `executor generation ${claim.generation}: ${detail}, before it was ready; see ${logs.err}` }) };
}

function settleReadiness(dir: AbsPath, generation: number, owed: Owed): void {
  if (owed.kind !== 'none') writeReadiness(dir, generation, owed.kind === 'ready' ? null : owed.reason);
}

// ---------------------------------------------------------------------------------------------------
// The supervisor

function crashLimitContent(crashes: readonly IsoTime[], evidence: readonly AbsPath[], detail: string): NeedsUserContent {
  return {
    blocking: true,
    subject: { type: 'host' },
    reason: 'supervisor-crash-limit',
    summary: `The executor crashed ${crashes.length} times within an hour (${crashes.join(', ')}); the supervisor stopped restarting it. The last crash: ${detail}.`,
    recommendation: 'Read the executor stderr logs in evidence and fix the cause, then `roadmap ack` this item and `roadmap start`: that start runs control-only and dispatches only once nothing blocking remains.',
    options: [],
    evidence,
  };
}

/**
 * Residue-index compaction (src/host/compact.ts), once per start, after the claim and before any executor. Arcs are
 * located in this repo's runtime dir. A corrupt index is left as it is: the executor's startup row reads it and
 * refuses `log-corrupt` the way it always has. What was compacted goes to the supervisor's stderr.
 */
function compactAtStart(dir: AbsPath, commonDir: AbsPath): void {
  try {
    const done = compactResidues(dir, (arc) => runDirOf(commonDir, arc));
    if (done.kind === 'compacted') process.stderr.write(`residues compacted: ${done.dropped} disposed pairs archived in ${done.archive}, ${done.kept} lines kept\n`);
  } catch (error) {
    if (!(error instanceof LogCorruptError)) throw error;
    process.stderr.write(`residues not compacted: ${error.message}\n`);
  }
}

function refuse(rejections: readonly StartupRejection[]): number {
  const reason = refusedOf(rejections);
  emit(reason);
  return reason.exitCode;
}

/** Runs the supervisor to its end; returns its exit code. */
export async function supervise(args: SupervisorArgs): Promise<number> {
  const dir = openHostDir(args.hostDir);
  const plan = loadPlan(args.planFile);
  // No arc, no run dir, no claim: the refusal the executor's own first check group would give.
  if ('kind' in plan) return refuse([...legacyRoadmapDir(args.repo), plan]);
  const runDir = runDirOf(gitCommonDir(args.repo), plan.arc);
  const claimed = await claimHost(dir, { arc: plan.arc, runDir, repo: args.repo, supervisor: selfIdentity() }, reconcilePreviousArc);
  if (claimed.kind === 'refused') {
    const r = claimed.rejection;
    if (r.kind !== 'host-busy') {
      writeRejection(runDir, [r]);
      raiseClaimRefusal(runDir, plan.arc, r, canonicalJson(r).trim());
    }
    return refuse([r]);
  }

  compactAtStart(dir, gitCommonDir(args.repo));

  const staleMs = args.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
  let claim = claimed.claim;
  let crashes = recentCrashes(dir, Date.now());
  const controlOnly = crashes.length >= CRASH_LIMIT;
  const evidence: AbsPath[] = [];
  saveState(dir, claim.generation, crashes, staleMs);
  // Whether a generation of this supervisor was ready, so past settling the plan in force (`runChecks`).
  let wasReady = false;
  for (let first = true; ; first = false) {
    emit({ kind: 'claimed', generation: claim.generation });
    crashPoint('sup.after-claim');
    const end = await superviseOne(args, claim, first && controlOnly, wasReady, staleMs);
    if (end.kind === 'intentional') {
      releaseHost(dir, claim);
      settleReadiness(dir, claim.generation, end.owed);
      return end.code;
    }
    // A generation owes no readiness marker exactly when it wrote `ready` itself.
    wasReady ||= end.owed.kind === 'none';
    crashes = [...recentCrashes(dir, Date.now()), isoTimeOf(new Date())];
    evidence.push(executorLogs(dir, claim.generation).err);
    saveState(dir, claim.generation, crashes, staleMs);
    if (crashes.length >= CRASH_LIMIT) {
      writeFileNeedsUser(runDir, plan.arc, supervisorNeedsUserId(claim.generation, crashes.length), crashLimitContent(crashes, evidence, end.detail));
      releaseHost(dir, claim);
      settleReadiness(dir, claim.generation, end.owed);
      return EXIT_START_FAILED;
    }
    settleReadiness(dir, claim.generation, end.owed);
    const backoff = BACKOFF_MS[crashes.length - 1];
    if (backoff === undefined) throw new Error(`no backoff for crash ${crashes.length} below the limit ${CRASH_LIMIT}`);
    await sleep(backoff);
    claim = await renewClaim(dir, claim);
    saveState(dir, claim.generation, crashes, staleMs);
  }
}

// ---------------------------------------------------------------------------------------------------
// Launching it (`roadmap start`)

export function supervisorArgv(a: SupervisorArgs): readonly string[] {
  return [
    a.hostDir, '--repo', a.repo, '--plan', a.planFile, ...(a.profile === null ? [] : ['--profile', a.profile]),
    ...(a.heartbeatStaleMs === null ? [] : ['--heartbeat-stale-ms', String(a.heartbeatStaleMs)]),
  ];
}

function parseSupervisorArgv(argv: readonly string[]): SupervisorArgs {
  const [hostDir, ...rest] = argv;
  if (hostDir === undefined) throw new Error('usage: supervisor <hostDir> --repo <abs> --plan <abs> [--profile <p>] [--heartbeat-stale-ms <n>]');
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] as string;
    const value = rest[i + 1];
    if (!['--repo', '--plan', '--profile', '--heartbeat-stale-ms'].includes(flag) || value === undefined || values.has(flag)) {
      throw new Error(`supervisor: unexpected argument ${JSON.stringify(flag)} in ${JSON.stringify(argv)}`);
    }
    values.set(flag, value);
  }
  const need = (flag: string): string => {
    const v = values.get(flag);
    if (v === undefined) throw new Error(`supervisor: ${flag} is required`);
    return v;
  };
  const profile = values.get('--profile');
  const stale = values.get('--heartbeat-stale-ms');
  return {
    hostDir: absPath(hostDir), repo: absPath(need('--repo')), planFile: absPath(need('--plan')),
    profile: profile === undefined ? null : profileName(profile, '--profile'),
    heartbeatStaleMs: stale === undefined ? null : positive(Number(stale), '--heartbeat-stale-ms'),
  };
}

/** What `roadmap start` prints (one line) and exits with. */
export type StartOutcome = Readonly<{ line: string; code: number }>;

function failed(generation: number | null, reason: string): StartOutcome {
  return { line: canonicalJson({ kind: 'failed', generation, reason }), code: EXIT_START_FAILED };
}

/** A failed marker's reason: a refusal's exit line (start exits with its code), else prose. */
function fromMarker(marker: ReadinessFile, supervisor: number): StartOutcome {
  if (marker.state === 'ready') return { line: canonicalJson({ kind: 'ready', generation: marker.generation, supervisor }), code: 0 };
  if (marker.reason.startsWith('{')) {
    const refused = refusedReason(JSON.parse(marker.reason), `supervisor.failed.${marker.generation}.reason`);
    return { line: exitLine(refused), code: refused.exitCode };
  }
  return failed(marker.generation, marker.reason);
}

/**
 * `roadmap start`: launches the supervisor detached, then waits at most `waitMs` for its claim (or its
 * refusal) and for that generation's readiness marker. Markers of other generations are never read. Returns
 * with the supervisor still running once it is ready, or once the wait is over (`timeout`).
 */
export async function launchSupervisor(args: SupervisorArgs, env: Readonly<Record<string, string | undefined>>, waitMs: number): Promise<StartOutcome> {
  const dir = openHostDir(args.hostDir);
  const logs = supervisorLogs(dir, randomBytes(8).toString('hex'));
  const out = openSync(logs.out, 'a');
  const err = openSync(logs.err, 'a');
  const child = spawn(process.execPath, [SUPERVISOR_ENTRY, ...supervisorArgv(args)], {
    detached: true, stdio: ['ignore', out, err], env: { ...env, [ROLE_ENV]: 'supervisor' },
  });
  closeSync(out);
  closeSync(err);
  let exited: Exited | null = null;
  child.once('exit', (code, sig) => {
    exited = { code, signal: sig };
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawning the supervisor failed');
  const gone = (what: string): string => {
    const how: Exited | null = exited;
    return `the supervisor exited (code ${how?.code}, signal ${how?.signal}) before ${what}; see ${logs.err}`;
  };
  const deadline = Date.now() + waitMs;
  try {
    let generation: number | null = null;
    for (;;) {
      const endedBefore = exited !== null;
      if (generation === null) {
        const text = firstLine(logs.out);
        if (text !== null) {
          const line = supervisorLine(JSON.parse(text), logs.out);
          if (line.kind === 'refused') return { line: exitLine(line), code: line.exitCode };
          generation = line.generation;
          continue;
        }
        if (endedBefore) return failed(null, gone('claiming the host'));
      } else {
        const marker = readReadiness(dir, generation);
        if (marker !== null) return fromMarker(marker, pid);
        if (endedBefore) return failed(generation, gone(`generation ${generation} was ready`));
      }
      if (Date.now() >= deadline) return { line: canonicalJson({ kind: 'timeout', generation, waitedMs: waitMs }), code: EXIT_START_FAILED };
      await sleep(TICK_MS / 4);
    }
  } finally {
    child.unref();
  }
}

/** The supervisor process's main (src/entry/supervisor.ts): argv after the script. */
export function supervisorMain(argv: readonly string[]): Promise<number> {
  return supervise(parseSupervisorArgv(argv));
}
