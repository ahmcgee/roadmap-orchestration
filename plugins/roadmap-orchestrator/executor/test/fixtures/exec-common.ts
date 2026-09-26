// Shared by the executor, status and recovery tests: an arc laid out by unit-common's `setupArc` (real repo,
// plan, specs, fake backends), run by the real CLI (`roadmap start`, `status`, `pause`, ...) as child
// processes through exec-cli.ts against the arc's own host directory. The descriptor's `runDir` is the run
// dir the executor derives (`<git common dir>/roadmap-runtime/<arc>`), so unit-common's readers
// (`outcomes`, `events`) read what the executor wrote.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { arcId } from '../../src/core/ids.ts';
import { type LogSnapshot, readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import type { ExitReason } from '../../src/executor.ts';
import type { Status } from '../../src/status.ts';
import { type Exit, fixture, runFixture } from '../helpers/proc.ts';
import { type Owner, own } from '../helpers/reap.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { type ArcDescriptor, type ArcOptions, setupArc } from './unit-common.ts';

const OK = { ok: true } as const;
/** The smoke of a `default` start: Claude's first seat, then Codex's (BACKENDS order). */
export const SMOKE_DEFAULT: readonly Step[] = [
  { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: OK }] },
  { as: 'codex', expect: { argv: ['exec'] }, acts: [{ type: 'emit', value: OK }] },
];
/** The smoke of a `claude-only` start: Claude alone. */
export const SMOKE_CLAUDE_ONLY: readonly Step[] = [{ as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: OK }] }];

/** Generous: a full unit is a dozen stages of real processes polled at up to 500 ms, plus the smoke. */
export const EXEC_TIMEOUT_MS = 240_000;
/** How long one executor child may run before the test calls it hung. */
const CHILD_TIMEOUT_MS = 200_000;

export type ExecOptions = ArcOptions & Readonly<{
  /** Declares resource `db` (probe and teardown are res-tool.ts over `stateDir`) and gives it to every unit. */
  resource?: boolean;
}>;

export type ExecRun = ArcDescriptor & Readonly<{ stateDir: string }>;

/**
 * Lays out an arc that test `t` may start: `t` owns its processes (helpers/reap.ts), stopped when it ends.
 * They are named by the host dir and the repo, so a test that runs this arc on another arc's host dir
 * (`{ ...setupExec(t, o), hostDir }`) still owns what it starts.
 */
export function setupExec(t: Owner, opts: ExecOptions): ExecRun {
  const d = setupArc(opts);
  const stateDir = tmpDir('exec-res');
  if (opts.resource === true) {
    const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as { resources: unknown[]; units: { resources: string[] }[] };
    const tool = (cmd: 'probe' | 'teardown') => ({ argv: [process.execPath, fixture('res-tool.ts'), cmd, stateDir, 'db'], cwd: '.', env: { set: {}, pass: [] } });
    plan.resources = [{ name: 'db', probe: tool('probe'), teardown: tool('teardown') }];
    for (const u of plan.units) u.resources = ['db'];
    writeFileSync(d.planPath, JSON.stringify(plan));
  }
  const common = git(d.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  mkdirSync(d.hostDir, { recursive: true });
  const r = { ...d, runDir: join(common, 'roadmap-runtime', d.arc), stateDir };
  own(t, { paths: [r.hostDir, r.repo], stop: () => cli(r, ['stop']) });
  return r;
}

/** The environment of every CLI child: the fakes' shims first on PATH. */
export function execEnv(r: ExecRun): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${r.binDir}:${process.env['PATH'] ?? ''}` };
}

export type Running = Readonly<{ child: ChildProcess; exit: Promise<Exit> }>;

/**
 * `roadmap start` and the supervised run it launches, in the background (sup-run.ts): `exit` settles when
 * the supervisor has exited, with the last executor's exit line as stdout, or with start's own line when
 * it did not get ready (rejects if it outlives the child timeout).
 */
export function startExec(r: ExecRun, extra: readonly string[] = []): Running {
  const child = spawn(process.execPath, [fixture('sup-run.ts'), r.hostDir, 'start', '--repo', r.repo, '--plan', r.planPath, ...extra], {
    env: execEnv(r), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  const exit = new Promise<Exit>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`roadmap start outlived ${CHILD_TIMEOUT_MS} ms; stderr: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, exit };
}

/** One CLI command (status, pause, stop, ack, resume) against this arc, to completion. */
export async function cli(r: ExecRun, argv: readonly string[]): Promise<Exit> {
  const out = await runFixture('exec-cli.ts', [r.hostDir, ...argv, '--repo', r.repo, '--arc', r.arc], { env: execEnv(r), timeoutMs: 30_000 });
  if (out.code !== 0) throw new Error(`roadmap ${argv.join(' ')} exited ${out.code}: ${out.stderr}`);
  return out;
}

export async function statusOf(r: ExecRun): Promise<Status> {
  return JSON.parse((await cli(r, ['status'])).stdout) as Status;
}

/** The exit reason `roadmap start` printed (its one stdout line). */
export function reasonOf(exit: Exit): ExitReason {
  const lines = exit.stdout.trim().split('\n');
  if (lines.length !== 1) throw new Error(`roadmap start printed ${lines.length} lines: ${exit.stdout}; stderr: ${exit.stderr}`);
  return JSON.parse(lines[0]!) as ExitReason;
}

/** The run's log, read as `status` reads it. */
export function journalOf(r: ExecRun): LogSnapshot {
  return readJournal(absPath(r.runDir), arcId(r.arc));
}

/** Polls `check` every 100 ms until it holds; throws naming `what` after `timeoutMs`. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(100);
  }
}

export const hostFile = (r: ExecRun, name: string): string => join(r.hostDir, name);
export const hostLockHeld = (r: ExecRun): boolean => existsSync(hostFile(r, 'host.lock'));

/** The executor host.owner.json names now (the supervisor publishes it before the handshake). */
export function executorPid(r: ExecRun): number {
  const owner = JSON.parse(readFileSync(hostFile(r, 'host.owner.json'), 'utf8')) as { executor: { pid: number } | null };
  if (owner.executor === null) throw new Error('host.owner.json names no executor yet');
  return owner.executor.pid;
}
