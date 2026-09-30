// Teardown for tests that start supervised runs. A supervisor is launched detached and outlives the test
// that started it unless the test stops it, so every test that can start one owns its run's processes:
// `own(t, scope)` stops them when the test ends, passed, failed or timed out, and each such test file ends
// with `after(assertNoSurvivors)`, which fails naming any process of any scope the file owned that is still
// alive (and kills it, so a failure never leaks either).
//
// Neither runs when the test process itself is killed (a SIGTERM or SIGINT from whatever runs the suite, a
// SIGKILL), and the detached supervisors then live on, respawning executors, with nothing to stop them. So
// the first scope a test process owns also starts a watchdog (fixtures/reap-watch.ts), detached, that waits
// for this process to be gone however it ended and then kills everything of every scope it owned.
//
// A scope's processes are found by /proc scan, not by the records the run wrote (a crashed or killed run
// may not have written them): every process whose argv names one of the scope's paths (the supervisor and
// the executor name the host dir and the repo; a runner names its invocation dir, under the repo's git
// dir; `roadmap` CLI children name the host dir), and every process in a session one of those leads (a
// runner's workload, the fake backends it runs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { statOf } from '../../src/contain/proc.ts';
import { fixture } from './proc.ts';

export type RunScope = Readonly<{
  /** Paths only this run's processes carry in their argv: its host dir and its repo. */
  paths: readonly string[];
  /** `roadmap stop` through the run's queue. */
  stop: () => Promise<unknown>;
}>;

/** Who tears a scope down: a test's context (its `after` runs when the test ends, passed, failed or timed out). */
export type Owner = Readonly<{ after(fn: () => Promise<void>): void }>;

type Proc = Readonly<{ pid: number; sid: number; state: string; argv: readonly string[] }>;

/** How long a healthy run gets to end after `stop` before it is killed. */
const STOP_MS = 30_000;
/** How long killed processes get to disappear. */
const KILL_MS = 10_000;
const POLL_MS = 50;

/** Every scope this test file owned, for the final assertion. */
const owned: RunScope[] = [];

/** The watchdog's registry: one JSON line of paths per owned scope. Started with the first scope. */
let registry: string | null = null;

/** Registers `scope` with this file's final assertion and its watchdog, without a per-test teardown (the caller tears down). */
export function track(scope: RunScope): void {
  owned.push(scope);
  registry ??= startWatchdog();
  appendFileSync(registry, `${JSON.stringify(scope.paths)}\n`);
}

/** Starts the watchdog of this process's scopes and returns its registry file (the watchdog removes it). */
function startWatchdog(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'roadmap-reap-')), 'scopes');
  appendFileSync(file, '');
  const self = statOf(process.pid);
  assert.ok(self !== null);
  spawn(process.execPath, [fixture('reap-watch.ts'), String(process.pid), String(self.start), file], { detached: true, stdio: 'ignore' }).unref();
  return file;
}

/** Registers `scope`, and tears it down when test `t` ends. */
export function own(t: Owner, scope: RunScope): void {
  track(scope);
  t.after(() => teardown(scope));
}

/**
 * Stops everything of `scope`: through `stop` when its run is healthy (a supervisor that is not stopped and
 * an executor), otherwise, or when that does not end it in time, by SIGKILL. Throws naming what survives.
 */
export async function teardown(scope: RunScope): Promise<void> {
  try {
    if (healthy(members(scope.paths))) {
      await scope.stop();
      const deadline = Date.now() + STOP_MS;
      while (members(scope.paths).length > 0 && Date.now() < deadline) await sleep(POLL_MS);
    }
  } finally {
    await killAll(scope.paths);
  }
}

/** The final assertion of a test file: no process of any scope it owned survives. Survivors are killed, then named. */
export async function assertNoSurvivors(): Promise<void> {
  const survivors = owned.flatMap((s) => members(s.paths));
  for (const scope of owned) await killAll(scope.paths);
  assert.deepEqual(survivors.map(show), [], 'processes of this file\'s supervised runs survived their tests');
}

/** SIGKILLs every process of the scope named by `paths` until none is left; throws naming survivors after a bound. */
export async function killAll(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + KILL_MS;
  for (let left = members(paths); left.length > 0; left = members(paths)) {
    if (Date.now() >= deadline) throw new Error(`could not kill ${left.map(show).join('; ')}`);
    for (const p of left) kill(p.pid);
    await sleep(POLL_MS);
  }
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

const isScript = (p: Proc, script: string): boolean => p.argv[1]?.endsWith(`/src/entry/${script}`) ?? false;

function healthy(ps: readonly Proc[]): boolean {
  return ps.some((p) => isScript(p, 'supervisor.ts') && p.state !== 'T' && p.state !== 't') && ps.some((p) => isScript(p, 'executor.ts'));
}

function members(paths: readonly string[]): readonly Proc[] {
  const all = processes();
  const named = all.filter((p) => p.argv.some((a) => paths.some((path) => a.includes(path))));
  const leaders = new Set(named.filter((p) => p.sid === p.pid).map((p) => p.pid));
  return all.filter((p) => named.includes(p) || leaders.has(p.sid));
}

/** Every live, non-zombie process but this one, with its argv. */
function processes(): readonly Proc[] {
  return readdirSync('/proc').flatMap((name) => {
    if (!/^[0-9]+$/.test(name) || Number(name) === process.pid) return [];
    const pid = Number(name);
    const stat = statOf(pid);
    if (stat === null || stat.state === 'Z') return [];
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return []; // exited since its stat
      throw error;
    }
    return [{ pid, sid: stat.sid, state: stat.state, argv: cmdline.split('\0').filter((a) => a !== '') }];
  });
}

const show = (p: Proc): string => `${p.pid} ${p.argv.join(' ')}`;
