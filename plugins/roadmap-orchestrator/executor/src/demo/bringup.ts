// The demo's bring-up primitives (SCHEMAS.md "dev.13" "Bring-up semantics"): commands with no shell from the checkout root,
// `env` added, `{port:<name>}` substituted; `setup` and `seed` each to exit 0; `serve` entries as long-lived processes, each
// in a session of its own (so it outlives the supervisor and the executor, and is stopped whole), probed ready by an HTTP
// GET below 500 or a substring of its output. Each step has a deadline; a step that outlives it is stopped and fails.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { identityOf, isAlive, scan, signal } from '../contain/proc.ts';
import type { ServeName } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import { type Argv, type BringUp, PORT_PLACEHOLDER, type ServeEntry } from '../input/plan.ts';
import type { DemoProcess } from './records.ts';

/** A setup or seed command's deadline. */
export const STEP_MS = 20 * 60_000;
/** How long a serve entry has to answer ready. */
export const READY_MS = 2 * 60_000;
/** Grace between TERM and KILL when a session is stopped. */
export const STOP_GRACE_MS = 5_000;
const POLL_MS = 200;

export type Ports = Readonly<Record<ServeName, number>>;

/** `text` with every `{port:<name>}` replaced by its port; a name with no port is a bug (the plan's parse refuses it). */
export function substitutePorts(text: string, ports: Ports): string {
  return text.replace(PORT_PLACEHOLDER, (_, name: string) => {
    const port = ports[name as ServeName];
    if (port === undefined) throw new Error(`{port:${name}} names no serve entry of this bring-up`);
    return String(port);
  });
}

/** The environment a bring-up's commands run with: `base` plus the bring-up's `env`, substituted. */
export function bringUpEnv(base: Readonly<Record<string, string | undefined>>, b: BringUp, ports: Ports): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(b.env)) out[k] = substitutePorts(v, ports);
  return out;
}

/** A port free now on the loopback (the kernel's pick), not one of `taken`. */
export async function freePort(taken: ReadonlySet<number> = new Set()): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('a listening TCP server has no port');
        server.close(() => resolve(address.port));
      });
    });
    if (!taken.has(port)) return port;
  }
}

/** Appends a line to a bring-up log. */
export function logLine(log: AbsPath, line: string): void {
  const fd = openSync(log, 'a');
  try {
    writeSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Starts `argv` in a session of its own, output appended to `log`. */
function start(argv: Argv, cwd: AbsPath, env: Readonly<Record<string, string>>, log: AbsPath): Readonly<{ sid: number; pid: number; start: number; exited: Promise<number | null> }> | string {
  const fd = openSync(log, 'a');
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error('an empty argv');
  try {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null));
      child.once('exit', (code) => resolve(code));
    });
    if (child.pid === undefined) return `${cmd} could not be started (not found or not executable)`;
    const id = identityOf(child.pid);
    child.unref();
    return { sid: id.sid, pid: id.pid, start: id.start, exited };
  } catch (error) {
    return `${cmd} could not be started: ${(error as Error).message}`;
  } finally {
    closeSync(fd);
  }
}

/** Every live process of session `sid` (the session leader's pid). */
const members = (sid: number) => scan().filter((p) => p.sid === sid);

/** Stops session `sid` whole: TERM, then KILL after the grace, until none is left. */
export async function stopSession(sid: number): Promise<void> {
  for (const p of members(sid)) signal(p, 'SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (members(sid).length > 0 && Date.now() < deadline) await sleep(POLL_MS);
  for (let left = members(sid); left.length > 0; left = members(sid)) {
    for (const p of left) signal(p, 'SIGKILL');
    await sleep(POLL_MS);
  }
}

/** Whether a recorded serve process still runs (same pid and start). */
export const processAlive = (p: DemoProcess): boolean => isAlive({ pid: p.pid, start: p.start });

export type StepResult = Readonly<{ ok: true }> | Readonly<{ ok: false; detail: string }>;

/** Thrown when the keeper is told to stop in the middle of a bring-up: not a failure of the version. */
export class BringUpAborted extends Error {}

/**
 * How a step's run ends: its exit code, its deadline, or the keeper's abort. The deadline's timer and the abort listener
 * are disposed once it is decided (a pending timer would hold the process open for the whole deadline).
 */
function stepEnd(exited: Promise<number | null>, signal: AbortSignal): Promise<number | null | 'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    const onAbort = (): void => done('aborted');
    const timer = setTimeout(() => done('timeout'), STEP_MS);
    function done(end: number | null | 'timeout' | 'aborted'): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(end);
    }
    if (signal.aborted) done('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    void exited.then(done);
  });
}

/**
 * Runs a setup or seed command (argv substituted) to its exit: ok on 0; otherwise, or past `STEP_MS` (its session stopped),
 * why not. An abort stops it and throws `BringUpAborted`.
 */
export async function runStep(step: string, argv: Argv, cwd: AbsPath, env: Readonly<Record<string, string>>, ports: Ports, log: AbsPath, signal: AbortSignal): Promise<StepResult> {
  const args = argv.map((a) => substitutePorts(a, ports));
  logLine(log, `# ${step}: ${JSON.stringify(args)}`);
  const s = start(args, cwd, env, log);
  if (typeof s === 'string') return { ok: false, detail: `${step}: ${s}` };
  const code = await stepEnd(s.exited, signal);
  if (code === 'aborted') {
    await stopSession(s.sid);
    throw new BringUpAborted(`${step} stopped: the keeper is ending`);
  }
  if (code === 'timeout') {
    await stopSession(s.sid);
    return { ok: false, detail: `${step}: still running after ${STEP_MS} ms; stopped` };
  }
  await stopSession(s.sid);
  return code === 0 ? { ok: true } : { ok: false, detail: `${step}: exited ${code}` };
}

/** Starts a serve entry (argv substituted), its output to `log`. */
export function startServe(entry: ServeEntry, cwd: AbsPath, env: Readonly<Record<string, string>>, ports: Ports, log: AbsPath): DemoProcess | string {
  const s = start(entry.argv.map((a) => substitutePorts(a, ports)), cwd, env, log);
  return typeof s === 'string' ? `serve.${entry.name}: ${s}` : { name: entry.name, pid: s.pid, start: s.start, sid: s.sid };
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Waits for a started serve entry to be ready (see the header); null when it is, else why not. */
export async function awaitReady(entry: ServeEntry, p: DemoProcess, ports: Ports, log: AbsPath, signal: AbortSignal): Promise<string | null> {
  const deadline = Date.now() + READY_MS;
  const ready = entry.ready;
  for (;;) {
    if (signal.aborted) throw new BringUpAborted(`serve.${entry.name} stopped waiting: the keeper is ending`);
    if ('http' in ready ? await answers(substitutePorts(ready.http, ports)) : existsSync(log) && readFileSync(log, 'utf8').includes(ready.log)) return null;
    if (!processAlive(p)) return `serve.${entry.name}: exited before it was ready; see ${log}`;
    if (Date.now() >= deadline) return `serve.${entry.name}: not ready after ${READY_MS} ms; see ${log}`;
    await sleep(POLL_MS);
  }
}
