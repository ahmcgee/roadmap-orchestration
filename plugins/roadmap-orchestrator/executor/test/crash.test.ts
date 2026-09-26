import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';

const TIMEOUT_MS = 10_000;

function envWith(trigger: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['ROADMAP_TEST_CRASH'];
  if (trigger !== undefined) env['ROADMAP_TEST_CRASH'] = trigger;
  return env;
}

test('crash.fires-once', async () => {
  const trigger = writeTrigger(tmpDir('crash'), { label: 'a', occurrence: 2 });
  const first = await runFixture('crash-child.ts', [], { env: envWith(trigger), timeoutMs: TIMEOUT_MS });
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assert.equal(first.stdout, 'passed a 1\n');
  assertFired(trigger);

  const second = await runFixture('crash-child.ts', [], { env: envWith(trigger), timeoutMs: TIMEOUT_MS });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, 'passed a 1\npassed a 2\npassed a 3\n');
});

test('crash.no-trigger-noop', async () => {
  const run = await runFixture('crash-child.ts', [], { env: envWith(undefined), timeoutMs: TIMEOUT_MS });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'passed a 1\npassed a 2\npassed a 3\n');
});

test('crash.wrong-occurrence-passes', async () => {
  for (const spec of [{ label: 'a', occurrence: 4 }, { label: 'b', occurrence: 1 }]) {
    const trigger = writeTrigger(tmpDir('crash'), spec);
    const run = await runFixture('crash-child.ts', [], { env: envWith(trigger), timeoutMs: TIMEOUT_MS });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, 'passed a 1\npassed a 2\npassed a 3\n');
    assert.equal(existsSync(trigger), true, 'an unmatched trigger stays armed');
  }
});

test('crash.missing-trigger-file-loud', async () => {
  const missing = join(tmpDir('crash'), 'nope.json');
  const run = await runFixture('crash-child.ts', [], { env: envWith(missing), timeoutMs: TIMEOUT_MS });
  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /ROADMAP_TEST_CRASH names .*nope\.json, which does not exist/);
});
