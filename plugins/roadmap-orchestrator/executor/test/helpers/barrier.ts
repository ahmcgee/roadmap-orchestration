// File barriers for cross-process coordination. A child reaching barrier `name` creates
// `<dir>/<name>.reached` and blocks until `<dir>/<name>.release` exists. The test awaits `.reached`,
// inspects the world while the child is parked, then releases it. Every wait has a timeout that throws.
import { existsSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpDir } from './repo.ts';

const POLL_MS = 20;

export function barrierDir(): string {
  return tmpDir('barrier');
}

const reachedPath = (dir: string, name: string): string => join(dir, `${name}.reached`);
const releasePath = (dir: string, name: string): string => join(dir, `${name}.release`);

// Sleeping without the event loop lets a synchronous child (the fake backend) park anywhere.
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/** The barrier one unit parks at: concurrent units reaching the "same" barrier each get their own. */
export const unitBarrierName = (unit: string, name: string): string => `${unit}.${name}`;

/**
 * Child side: announce the barrier and block until released. Reaching the same barrier twice throws. With
 * `progressMs`, a `waiting <name>` line goes to stdout that often while parked, as a lane doing real work
 * would print (the executor's stall watchdog counts output as progress).
 */
export function waitAtBarrier(dir: string, name: string, timeoutMs: number, progressMs?: number): void {
  writeFileSync(reachedPath(dir, name), `${process.pid}\n`, { flag: 'wx' });
  const deadline = Date.now() + timeoutMs;
  let nextProgress = Date.now();
  while (!existsSync(releasePath(dir, name))) {
    const now = Date.now();
    if (now >= deadline) throw new Error(`barrier ${name} in ${dir}: not released within ${timeoutMs} ms`);
    if (progressMs !== undefined && now >= nextProgress) {
      writeSync(1, `waiting ${name}\n`);
      nextProgress = now + progressMs;
    }
    sleepSync(POLL_MS);
  }
}

/** Test side: resolve once a child has reached `name`. */
export async function reached(dir: string, name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(reachedPath(dir, name))) {
    if (Date.now() >= deadline) throw new Error(`barrier ${name} in ${dir}: not reached within ${timeoutMs} ms`);
    await sleep(POLL_MS);
  }
}

/** Test side: let the child parked at `name` continue. Releasing twice throws. */
export function release(dir: string, name: string): void {
  writeFileSync(releasePath(dir, name), '', { flag: 'wx' });
}
