// Shared by the supervisor and takeover tests: exec-common's fake-backed arcs, driven through the real
// `roadmap start` (the CLI launches the real supervisor, which spawns the real executor), plus readers of
// the host files the supervisor writes and helpers to find, freeze and kill its processes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, statOf } from '../../src/contain/proc.ts';
import type { Fact } from '../../src/core/events.ts';
import type { HostLockClaim, HostOwner, ProcIdentity, SupervisorState } from '../../src/core/records.ts';
import { hostLockClaim, hostOwner, supervisorState } from '../../src/core/records.ts';
import { absPath } from '../../src/core/values.ts';
import { SUPERVISOR_ENTRY, SUPERVISOR_STATE, supervisorArgv } from '../../src/supervisor.ts';
import { type Exit, fixture, runUntilExit } from '../helpers/proc.ts';
import type { Step } from '../helpers/scenario.ts';
import { tmpDir } from '../helpers/repo.ts';
import { BUILD_REPORT, planCheckStep } from './stage-common.ts';
import { type ExecRun, SMOKE_CLAUDE_ONLY, cli, execEnv, hostFile, journalOf, until } from './exec-common.ts';
import { MUL, gateStep } from './unit-common.ts';

export const CLAUDE_ONLY = ['--profile', 'claude-only'] as const;
/** One unit straight through under claude-only: plan-check, the Claude implementer's build, the gate. */
export const UNIT_CLAUDE_ONLY: readonly Step[] = [
  planCheckStep({ decision: 'approve' }),
  { as: 'claude', expect: { argv: ['-p', '--permission-mode'] }, acts: [{ type: 'commit', message: 'add mul', files: MUL }, { type: 'emit', value: BUILD_REPORT }] },
  gateStep({ decision: 'approve' }),
];
/** A plan-check that parks at barrier `name` (until released or killed), then approves. */
export function blockedCheck(name: string): Step {
  const step = planCheckStep({ decision: 'approve' });
  return { ...step, acts: [{ type: 'barrier', name, timeoutMs: 120_000 }, ...step.acts] } as Step;
}
/** `n` claude-only smokes: one per executor that passes its handshake. */
export const smokes = (n: number): readonly Step[] => Array.from({ length: n }, () => SMOKE_CLAUDE_ONLY).flat();

export const WAIT_MS = 60_000;

/** `roadmap start` alone (it returns at readiness), with extra environment (a crash trigger). */
export async function startCli(r: ExecRun, extra: readonly string[] = CLAUDE_ONLY, env: NodeJS.ProcessEnv = {}): Promise<Exit> {
  return runUntilExit(process.execPath, [fixture('exec-cli.ts'), r.hostDir, 'start', '--repo', r.repo, '--plan', r.planPath, ...extra], {
    env: { ...execEnv(r), ...env }, timeoutMs: 120_000,
  });
}

/** The one JSON line `roadmap start` printed. */
export function startLine(exit: Exit): { kind: string; generation?: number; supervisor?: number } {
  const lines = exit.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `start printed ${exit.stdout}; stderr ${exit.stderr}`);
  return JSON.parse(lines[0]!) as { kind: string; generation?: number; supervisor?: number };
}

export function claimOf(r: ExecRun): HostLockClaim | null {
  const path = hostFile(r, 'host.lock');
  return existsSync(path) ? hostLockClaim(JSON.parse(readFileSync(path, 'utf8')), 'host.lock') : null;
}

export function ownerOf(r: ExecRun): HostOwner | null {
  const path = hostFile(r, 'host.owner.json');
  return existsSync(path) ? hostOwner(JSON.parse(readFileSync(path, 'utf8')), 'host.owner.json') : null;
}

export function stateOf(r: ExecRun): SupervisorState {
  return supervisorState(JSON.parse(readFileSync(hostFile(r, SUPERVISOR_STATE), 'utf8')), SUPERVISOR_STATE);
}

/** The executor host.owner.json names for `generation`, once published. */
export async function executorOf(r: ExecRun, generation: number): Promise<ProcIdentity> {
  let found: ProcIdentity | null = null;
  await until(() => {
    const o = ownerOf(r);
    found = o !== null && o.generation === generation ? o.executor : null;
    return found !== null;
  }, WAIT_MS, `the executor of generation ${generation}`);
  return found as unknown as ProcIdentity;
}

export function supervisorOf(r: ExecRun): ProcIdentity {
  const c = claimOf(r);
  if (c === null) throw new Error('host.lock is absent: no supervisor');
  return c.supervisor;
}

export const factsOf = (r: ExecRun): readonly Fact[] => journalOf(r).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
export const startedGenerations = (r: ExecRun): readonly number[] => factsOf(r).flatMap((f) => (f.kind === 'executor-started' ? [f.generation] : []));

/**
 * Whether the executor of `generation` has finished its startup smoke: every backend any start of the arc
 * smoked has a done smoke spawn after its `executor-started{generation}` (the smoke runs after that fact and
 * after recovery; lead ruling 14c). The first start's smoke finished before it applied the pause.
 */
function smoked(r: ExecRun, generation: number): boolean {
  const { events, view } = journalOf(r);
  const started = events.findIndex((e) => e.type === 'fact' && e.fact.kind === 'executor-started' && e.fact.generation === generation);
  if (started === -1) return false;
  const smokeOf = (e: (typeof events)[number]): string | null =>
    e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'smoke' && e.expect.subject.target.type === 'backend' ? e.expect.subject.target.backend : null;
  const all = new Set(events.flatMap((e) => smokeOf(e) ?? []));
  const done = new Set(events.slice(started).flatMap((e) => {
    const backend = smokeOf(e);
    return backend !== null && e.type === 'intent' && view.doneOf(e.op) !== null ? [backend] : [];
  }));
  return all.size > 0 && [...all].every((b) => done.has(b));
}

/** Waits until the executor of `generation` has started, smoked, and is idle in its loop (it applied the pause). */
export async function idle(r: ExecRun, generation: number): Promise<ProcIdentity> {
  await until(() => existsSync(join(r.runDir, 'events.jsonl')) && startedGenerations(r).includes(generation), WAIT_MS, `executor-started{${generation}}`);
  await until(() => journalOf(r).view.control().pausedAll, WAIT_MS, 'the pause to be applied');
  await until(() => smoked(r, generation), WAIT_MS, `the smoke of generation ${generation}`);
  return executorOf(r, generation);
}

export async function gone(p: ProcIdentity, timeoutMs: number = WAIT_MS): Promise<void> {
  await until(() => !isAlive(p), timeoutMs, `process ${p.pid} to exit`);
}

export async function kill(p: ProcIdentity): Promise<void> {
  process.kill(p.pid, 'SIGKILL');
  await gone(p);
}

/** Submits `pause --all` before the first start, so every executor of the test idles in its command loop. */
export async function pausedFromTheStart(r: ExecRun): Promise<void> {
  mkdirSync(r.runDir, { recursive: true });
  await cli(r, ['pause', '--all']);
}

/** Live executor processes started for the claim `nonce` (by their argv), found by a /proc scan. */
export function executorsOf(nonce: string): readonly ProcIdentity[] {
  return readdirSync('/proc').flatMap((name) => {
    if (!/^[0-9]+$/.test(name)) return [];
    const pid = Number(name);
    const stat = statOf(pid);
    if (stat === null) return [];
    let argv: readonly string[];
    try {
      argv = cmdline({ pid, start: stat.start });
    } catch {
      return []; // exited between the stat and the read
    }
    const i = argv.indexOf('--nonce');
    return argv.some((a) => a.endsWith('/src/executor.ts')) && i !== -1 && argv[i + 1] === nonce ? [{ pid, start: stat.start }] : [];
  });
}

/** The argv a process was started with, from /proc. */
export function cmdline(p: ProcIdentity): readonly string[] {
  return readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0').filter((a) => a !== '');
}

/**
 * The supervisor launched directly, as `roadmap start` does (detached, ROADMAP_ROLE=supervisor, stdio to
 * files), for arguments start never passes (`--heartbeat-stale-ms`).
 */
export function launchDirect(r: ExecRun, heartbeatStaleMs: number): ProcIdentity {
  const dir = tmpDir('sup-direct');
  const out = openSync(join(dir, 'out'), 'a');
  const err = openSync(join(dir, 'err'), 'a');
  const argv = supervisorArgv({
    hostDir: absPath(r.hostDir), repo: absPath(r.repo), planFile: absPath(r.planPath), profile: 'claude-only', heartbeatStaleMs,
  });
  const child = spawn(process.execPath, [SUPERVISOR_ENTRY, ...argv], {
    detached: true, stdio: ['ignore', out, err], env: { ...execEnv(r), ROADMAP_ROLE: 'supervisor' },
  });
  closeSync(out);
  closeSync(err);
  child.unref();
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const stat = statOf(pid);
  assert.ok(stat !== null);
  return { pid, start: stat.start };
}

/** Polls every 2 ms until the supervisor is gone, recording when each end was first seen; fails if the lock goes first. */
export async function watchEnd(r: ExecRun, supervisor: ProcIdentity, executor: ProcIdentity): Promise<Readonly<{ executorGone: number; lockGone: number; supervisorGone: number }>> {
  const seen = { executorGone: 0, lockGone: 0, supervisorGone: 0 };
  const deadline = Date.now() + 3 * WAIT_MS;
  for (let tick = 1; seen.supervisorGone === 0; tick++) {
    if (Date.now() >= deadline) throw new Error('the supervisor did not exit');
    // Read the lock before the executor: a lock seen gone while the executor is then still alive is a release
    // before the executor's exit.
    const lock = existsSync(hostFile(r, 'host.lock'));
    const exec = isAlive(executor);
    const sup = isAlive(supervisor);
    assert.ok(lock || !exec, `host.lock was released while executor ${executor.pid} was alive`);
    if (!exec && seen.executorGone === 0) seen.executorGone = tick;
    if (!lock && seen.lockGone === 0) seen.lockGone = tick;
    if (!sup) seen.supervisorGone = tick;
    await sleep(2);
  }
  return seen;
}
