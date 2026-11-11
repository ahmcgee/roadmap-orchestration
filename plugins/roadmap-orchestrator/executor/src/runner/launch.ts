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

/**
 * A workload environment split for persistence. `env` is what launch.json records; `envPass` (absent when none) names
 * the variables passed from the executor's environment; `inherited` holds their values, which reach the workload only
 * through the runner's process environment (`startRunner`, then `workloadEnv`) and are never written to a file.
 */
export type SplitEnv = Readonly<{ env: Readonly<Record<string, string>>; envPass?: readonly string[]; inherited: Readonly<Record<string, string>> }>;

/** Splits `env` so the `passed` names' values leave the record. Every passed name must be in `env`: a caller bug otherwise. */
export function splitEnv(env: Readonly<Record<string, string>>, passed: readonly string[]): SplitEnv {
  const literal: Record<string, string> = { ...env };
  const inherited: Record<string, string> = {};
  for (const name of [...passed].sort()) {
    const value = env[name];
    if (value === undefined) throw new Error(`passed variable ${name} has no value in the launch env`);
    inherited[name] = value;
    delete literal[name];
  }
  const names = Object.keys(inherited);
  return { env: literal, ...(names.length === 0 ? {} : { envPass: names }), inherited };
}

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

function runnerEnv(launch: LaunchFile, inherited: Readonly<Record<string, string>>): Record<string, string> {
  const names = Object.keys(inherited).sort();
  const declared = launch.envPass ?? [];
  if (names.join('\0') !== declared.join('\0')) throw new Error(`${launch.inv}: inherited values for [${names.join(', ')}], launch.json passes [${declared.join(', ')}]`);
  return {
    PATH: required('PATH'),
    HOME: required('HOME'),
    ...inherited,
    ...invocationEnv(launch.inv, 'runner'),
    ...(launch.test === null ? {} : { [ENV_TEST_CRASH]: launch.test.crash }),
  };
}

export type RunnerHandle = Readonly<{ files: RunnerFiles; launch: LaunchFile; runner: ProcIdentity }>;

/**
 * Writes launch.json (write-once) into `invDir` and starts the runner. Returns once the runner exists. `unit`: the
 * unit whose stage launches it, for crash attribution (G8). `inherited`: the values of `launch.envPass` (`splitEnv`),
 * set in the runner's environment for its workload and never written.
 */
export function startRunner(invDir: AbsPath, launch: LaunchFile, unit?: UnitId, inherited: Readonly<Record<string, string>> = {}): RunnerHandle {
  const env = runnerEnv(launch, inherited);
  durableMkdir(invDir);
  const files = runnerFiles(invDir, launch.inv);
  files.write('launch.json', launch);
  crashPoint('launch.after-launch-json', unit);
  const log = openSync(join(invDir, RUNNER_LOG), 'wx');
  const child = spawn(process.execPath, [RUNNER_SCRIPT, invDir], {
    cwd: invDir,
    env,
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

/** Waits for the runner, enforcing the backstop and any recovery control cancellation while it is alive. */
export async function awaitRunner(handle: RunnerHandle, cancelWhen?: () => CancelReason | null): Promise<RunnerEnd> {
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
    if (cancelWhen !== undefined && exit === null && handle.files.read('cancel.json') === null) {
      const reason = cancelWhen();
      if (reason != null) cancel(handle, reason);
    }
    if (exit === null && !killed && Date.now() >= backstopAt) {
      signal(handle.runner, 'SIGKILL');
      killed = true;
    }
    await sleep(POLL_MS);
  }
}
