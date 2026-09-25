// Invocations for runner and containment tests: a fresh arc per call (membership is keyed by ROADMAP_INV,
// and test files run in parallel), a launch record for a workload fixture, and polling with timeouts.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, identityOf } from '../../src/contain/proc.ts';
import { type ArcId, type InvocationId, type OpId, arcId, invocationId, opId } from '../../src/core/ids.ts';
import type { LaunchFile, ProcIdentity, RunnerFile } from '../../src/core/records.ts';
import { SCHEMA_VERSION } from '../../src/core/version.ts';
import { type AbsPath, absPath, isoTimeOf } from '../../src/core/values.ts';
import type { RunnerHandle } from '../../src/runner/launch.ts';
import { fixture } from './proc.ts';
import { tmpDir } from './repo.ts';

/**
 * Deadline for tests whose deadline must fire only after their setup (workload started, runner stopped,
 * executor killed). The runner checks the deadline every 500 ms and every setup step starts a node
 * process, which takes seconds when the whole suite loads the host; 5 s leaves that margin.
 */
export const TEST_DEADLINE_MS = 5_000;
/**
 * Grace for tests that let a deadline fire and await the runner: the executor's backstop comes 2 x grace
 * after the deadline, and the runner needs up to one 500 ms poll plus the kill to write exit.json first.
 */
export const TEST_DEADLINE_GRACE_MS = 1_000;

export type Invocation = Readonly<{ arc: ArcId; op: OpId; inv: InvocationId; root: AbsPath; invDir: AbsPath }>;

export function newInvocation(): Invocation {
  const arc = arcId(`t-${randomBytes(6).toString('hex')}`);
  const op = opId(arc, 1);
  const inv = invocationId(op, 1);
  const root = absPath(tmpDir('runner'));
  return { arc, op, inv, root, invDir: absPath(join(root, 'inv', '1-1')) };
}

export type LaunchOptions = Readonly<{
  argv: readonly string[];
  deadlineMs?: number;
  graceMs?: number;
  stdinPath?: AbsPath | null;
}>;

/** A launch record without `test`: callers pass it through prepareLaunch (in-process or in runner-launcher). */
export function launchBase(inv: Invocation, options: LaunchOptions): Omit<LaunchFile, 'test'> {
  const path = process.env['PATH'];
  assert.ok(path !== undefined, 'tests need PATH');
  return {
    v: SCHEMA_VERSION,
    arc: inv.arc,
    op: inv.op,
    inv: inv.inv,
    argv: options.argv,
    cwd: inv.root,
    env: { PATH: path },
    stdinPath: options.stdinPath ?? null,
    // The default outlasts every test's timeout: a deadline fires only in a test that asks for one.
    deadlineAt: isoTimeOf(new Date(Date.now() + (options.deadlineMs ?? 60_000))),
    graceMs: options.graceMs ?? 500,
    containment: 'session',
    terminal: { type: 'command', purpose: 'lane', expectedExit: 0 },
  };
}

/** argv running a workload fixture with this Node binary. */
export function workload(name: string, ...args: readonly string[]): readonly string[] {
  return [process.execPath, fixture(name), ...args];
}

/** Poll `probe` every 20 ms until it returns non-null, or throw after `timeoutMs`. */
export async function waitFor<T>(what: string, timeoutMs: number, probe: () => T | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(20);
  }
}

/** The runner.json the runner rewrites once its child exists. */
export function waitForChild(handle: RunnerHandle, timeoutMs: number): Promise<RunnerFile & { child: NonNullable<RunnerFile['child']> }> {
  return waitFor('runner.json with a child', timeoutMs, () => {
    const file = handle.files.read('runner.json');
    return file !== null && file.child !== null ? { ...file, child: file.child } : null;
  });
}

/** Identity of a pid a fixture printed or parked at a barrier with; the process must be alive now. */
export function identityFromFile(path: string): ProcIdentity {
  const { pid, start } = identityOf(Number(readFileSync(path, 'utf8').trim()));
  return { pid, start };
}

export function assertGone(ids: readonly ProcIdentity[]): void {
  for (const id of ids) assert.equal(isAlive(id), false, `process ${id.pid} is still alive`);
}
