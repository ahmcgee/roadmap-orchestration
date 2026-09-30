// The executor side of an invocation: write launch.json, start the runner detached (its own session, stdio
// on runner.log, never pipes), then observe runner.json / exit.json, write cancel.json on request, and
// backstop-kill a runner that has not written exit.json by deadlineAt + 2·graceMs.
//
// The runner, not the executor, enforces the deadline and kills the workload; the backstop only covers a
// hung runner. Killing the workload such a runner leaves behind is recovery's job (Containment.kill).
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, identityOf, signal } from '../contain/proc.ts';
import { ENV_TEST_CRASH, invocationEnv } from '../contain/session.ts';
import { crashPoint, crashTriggerFromEnv } from '../core/crash.ts';
import { durableMkdir } from '../core/fsx.ts';
import { type Sha256Hex, type UnitId, sha256 } from '../core/ids.ts';
import type { RunnerFiles } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { CancelReason, ExitFile, LaunchFile, ProcIdentity } from '../core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from '../core/values.ts';
import { runnerFiles } from './files.ts';

/** The runner's own stdout and stderr, both appended to one file in the invocation dir. */
export const RUNNER_LOG = 'runner.log';
const RUNNER_SCRIPT = fileURLToPath(new URL('../entry/runner.ts', import.meta.url));
const POLL_MS = 100;

/** Completes a launch record: the crash trigger in the executor's environment, if any, rides into test.crash. */
export function prepareLaunch(base: Omit<LaunchFile, 'test'>): LaunchFile {
  const crash = crashTriggerFromEnv();
  return { ...base, test: crash === undefined ? null : { crash: absPath(crash, 'ROADMAP_TEST_CRASH') } };
}

/** The hash the proc.spawn intent records: sha256 over the exact bytes launch.json is written with. */
export function launchSha256(launch: LaunchFile): Sha256Hex {
  return sha256(sha256Hex(canonicalJson(launch)));
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`the executor's environment has no ${name}; the runner needs it`);
  return value;
}

function runnerEnv(launch: LaunchFile): Record<string, string> {
  return {
    PATH: required('PATH'),
    HOME: required('HOME'),
    ...invocationEnv(launch.inv, 'runner'),
    ...(launch.test === null ? {} : { [ENV_TEST_CRASH]: launch.test.crash }),
  };
}

export type RunnerHandle = Readonly<{ files: RunnerFiles; launch: LaunchFile; runner: ProcIdentity }>;

/**
 * Writes launch.json (write-once) into `invDir` and starts the runner. Returns once the runner exists. `unit`: the
 * unit whose stage launches it, for crash attribution (G8).
 */
export function startRunner(invDir: AbsPath, launch: LaunchFile, unit?: UnitId): RunnerHandle {
  durableMkdir(invDir);
  const files = runnerFiles(invDir, launch.inv);
  files.write('launch.json', launch);
  crashPoint('launch.after-launch-json', unit);
  const log = openSync(join(invDir, RUNNER_LOG), 'wx');
  const child = spawn(process.execPath, [RUNNER_SCRIPT, invDir], {
    cwd: invDir,
    env: runnerEnv(launch),
    stdio: ['ignore', log, log],
    detached: true,
  });
  closeSync(log);
  if (child.pid === undefined) throw new Error(`could not spawn the runner (${process.execPath} ${RUNNER_SCRIPT})`);
  // Unreaped until the event loop runs, so the stat is readable even if the runner already exited.
  const { pid, start } = identityOf(child.pid);
  child.unref();
  crashPoint('launch.after-spawn', unit);
  return { files, launch, runner: { pid, start } };
}

/** Asks the runner to kill the workload. The runner notices within its poll interval. */
export function cancel(handle: RunnerHandle, reason: CancelReason): void {
  const { v, arc, op, inv } = handle.launch;
  handle.files.write('cancel.json', { v, arc, op, inv, reason, at: isoTimeOf(new Date()) });
}

export type RunnerEnd =
  /** The runner wrote exit.json and is gone: the workload was quiescent when it wrote it. */
  | Readonly<{ kind: 'exited'; exit: ExitFile }>
  /** The runner is gone without exit.json (it crashed or was killed); the workload may still live. */
  | Readonly<{ kind: 'died' }>
  /** exit.json was still absent at deadlineAt + 2·graceMs: the runner was SIGKILLed by (pid, start). */
  | Readonly<{ kind: 'backstop-killed'; runner: ProcIdentity }>;

/** Resolves when the runner is gone, killing it first if it is still running at the backstop. */
export async function awaitRunner(handle: RunnerHandle): Promise<RunnerEnd> {
  const backstopAt = new Date(handle.launch.deadlineAt).getTime() + 2 * handle.launch.graceMs;
  let killed = false;
  for (;;) {
    // Liveness first, then exit.json: a runner seen dead has written everything it ever will.
    const alive = isAlive(handle.runner);
    const exit = handle.files.read('exit.json');
    if (!alive) {
      if (exit !== null) return { kind: 'exited', exit };
      return killed ? { kind: 'backstop-killed', runner: handle.runner } : { kind: 'died' };
    }
    if (exit === null && !killed && Date.now() >= backstopAt) {
      signal(handle.runner, 'SIGKILL');
      killed = true;
    }
    await sleep(POLL_MS);
  }
}
