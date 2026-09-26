import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { barrierDir, reached, release } from './helpers/barrier.ts';
import { runFixture } from './helpers/proc.ts';

test('barrier.park-and-release', async () => {
  const dir = barrierDir();
  const child = runFixture('barrier-child.ts', [dir, 'mid', '10000'], { env: process.env, timeoutMs: 15_000 });
  await reached(dir, 'mid', 10_000);
  // Parked: give it a few poll periods to prove it does not run past the barrier on its own.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(join(dir, 'mid.release')), false);
  release(dir, 'mid');
  const exit = await child;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(exit.stdout, 'released\n');
});

test('barrier.child-timeout-throws', async () => {
  const dir = barrierDir();
  const exit = await runFixture('barrier-child.ts', [dir, 'never', '100'], { env: process.env, timeoutMs: 10_000 });
  assert.notEqual(exit.code, 0);
  assert.match(exit.stderr, /barrier never .*not released within 100 ms/);
});

test('barrier.reached-timeout-throws', async () => {
  await assert.rejects(reached(barrierDir(), 'absent', 100), /barrier absent .*not reached within 100 ms/);
});
