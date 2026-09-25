// Session-mode containment (plan: "Runner and containment", "Workload membership", "Narrowed guarantee").
//
// The workload is spawned as the leader of its own session, and every process that keeps ROADMAP_INV=<inv>
// in its exec-time environment or stays in that session is a member. The runner that controls the
// invocation carries ROADMAP_INV too but also ROADMAP_ROLE=runner, and is never a member, so neither the
// runner nor a recovering executor ever signals it as part of the workload.
//
// Not contained: a descendant that calls setsid() and execs with a cleared environment. That hole is the
// documented narrowed guarantee (the contain.escape-* tests pin it), not a bug to patch here. A descendant
// that leaves the session and turns non-dumpable (its environ becomes unreadable) is the same hole.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { InvocationId, OpId } from '../core/ids.ts';
import { parseInvocationId, parseOpId } from '../core/ids.ts';
import type { Containment, SpawnedWorkload, WorkloadRef } from '../core/interfaces.ts';
import { type ChildEnd, type KillReason, type LaunchFile, type ProcIdentity, STDERR_FILE, STDOUT_FILE } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { type ProcInfo, identityOf, scan, signal } from './proc.ts';

export const ENV_ARC = 'ROADMAP_ARC';
export const ENV_OP = 'ROADMAP_OP';
export const ENV_INV = 'ROADMAP_INV';
export const ENV_ROLE = 'ROADMAP_ROLE';
export const ENV_TEST_CRASH = 'ROADMAP_TEST_CRASH';

/** The ROADMAP_* variables every process of an invocation carries; the role tells controller from workload. */
export function invocationEnv(inv: InvocationId, role: 'runner' | 'workload'): Record<string, string> {
  const { op } = parseInvocationId(inv);
  return { [ENV_ARC]: parseOpId(op).arc, [ENV_OP]: op, [ENV_INV]: inv, [ENV_ROLE]: role };
}

/** The workload's environment: exactly the declared env, the invocation variables and the crash trigger if any. */
export function workloadEnv(launch: LaunchFile): Record<string, string> {
  return {
    ...launch.env,
    ...invocationEnv(launch.inv, 'workload'),
    ...(launch.test === null ? {} : { [ENV_TEST_CRASH]: launch.test.crash }),
  };
}

const isRunner = (p: ProcInfo): boolean => p.env?.get(ENV_ROLE) === 'runner';
const identity = (p: ProcInfo): ProcIdentity => ({ pid: p.pid, start: p.start });

export function members(workload: WorkloadRef): readonly ProcIdentity[] {
  const sid = workload.child?.sid;
  return scan()
    .filter((p) => !isRunner(p) && (p.env?.get(ENV_INV) === workload.inv || p.sid === sid))
    .map(identity);
}

/**
 * Every process of any ordinal of `op`, runners included: recovery uses this, when no runner of the op is
 * legitimately alive, to find strays of earlier ordinals that a per-invocation scan would miss.
 */
export function opMembers(op: OpId): readonly ProcIdentity[] {
  return scan().filter((p) => p.env?.get(ENV_OP) === op).map(identity);
}

type ChildEnded = Extract<ChildEnd, { type: 'exited' | 'signalled' }>;

const key = (p: ProcIdentity): string => `${p.pid}:${p.start}`;
const POLL_MS = 50;

/**
 * Stop every member, rescanning until a rescan finds nobody new (a stopped process cannot fork, so the set
 * converges even while the tree grows), then TERM + CONT, wait up to `graceMs` for the set to empty, then
 * KILL whatever remains or appears until a scan comes back empty.
 */
export async function killSet(find: () => readonly ProcIdentity[], graceMs: number): Promise<void> {
  const stopped = new Map<string, ProcIdentity>();
  for (;;) {
    const fresh = find().filter((p) => !stopped.has(key(p)));
    if (fresh.length === 0) break;
    for (const p of fresh) {
      signal(p, 'SIGSTOP');
      stopped.set(key(p), p);
    }
  }
  for (const p of stopped.values()) {
    signal(p, 'SIGTERM');
    signal(p, 'SIGCONT');
  }
  const graceEnd = Date.now() + graceMs;
  while (find().length > 0 && Date.now() < graceEnd) await sleep(POLL_MS);
  for (;;) {
    const left = find();
    if (left.length === 0) return;
    for (const p of left) signal(p, 'SIGKILL');
    await sleep(POLL_MS);
  }
}

/** Spawn the workload as a session leader with stdio on files in the invocation dir (never pipes). */
function launchWorkload(launch: LaunchFile, invDir: AbsPath): Promise<SpawnedWorkload> {
  const stdin = openSync(launch.stdinPath ?? '/dev/null', 'r');
  const stdout = openSync(join(invDir, STDOUT_FILE), 'wx');
  const stderr = openSync(join(invDir, STDERR_FILE), 'wx');
  const [cmd, ...args] = launch.argv;
  if (cmd === undefined) throw new Error('launch.argv is empty'); // unreachable: the validator requires non-empty
  const child = spawn(cmd, args, {
    cwd: launch.cwd,
    env: workloadEnv(launch),
    stdio: [stdin, stdout, stderr],
    detached: true,
  });
  for (const fd of [stdin, stdout, stderr]) closeSync(fd);
  const pid = child.pid;
  if (pid === undefined) {
    // Node reports a failed exec (missing binary, bad cwd) through an 'error' event after spawn returns.
    return new Promise((resolve) => {
      child.once('error', (error) => resolve({ kind: 'spawn-failed', error: error.message }));
    });
  }
  // The child cannot have been reaped yet: libuv reaps only from the event loop, so its stat is readable here.
  const id = identityOf(pid);
  const ended = new Promise<ChildEnded>((resolve) => {
    child.once('exit', (code, sig) => {
      if (sig !== null) resolve({ type: 'signalled', signal: sig });
      else if (code !== null) resolve({ type: 'exited', code });
      else throw new Error(`workload ${pid} exited with neither a code nor a signal`);
    });
  });
  return Promise.resolve({ kind: 'spawned', child: id, ended });
}

export const sessionContainment: Containment = {
  mode: 'session',
  launch: launchWorkload,
  members,
  // The reason only matters to cgroup mode's bookkeeping; session mode kills the same way for every reason.
  kill: (workload: WorkloadRef, _reason: KillReason, graceMs: number) => killSet(() => members(workload), graceMs),
  empty: (workload: WorkloadRef) => members(workload).length === 0,
};
