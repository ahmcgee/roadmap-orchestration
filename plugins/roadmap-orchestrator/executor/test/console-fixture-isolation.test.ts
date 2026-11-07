import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup as m1 } from '../evals/m1/setup.ts';
import { setup as m2 } from '../evals/m2/setup.ts';
import { setup as m3 } from '../evals/m3/setup.ts';
import { setup as m4a } from '../evals/m4a/setup.ts';
import { setup as m5 } from '../evals/m5/setup.ts';
import { setupExec } from './fixtures/exec-common.ts';
import { tmpDir } from './helpers/repo.ts';
import { consoleCommon, ensureConsole, readConsoleLease, stopConsole } from '../src/console/lease.ts';
import { isAlive } from '../src/host/liveness.ts';
import { absPath } from '../src/core/values.ts';

for (const [name, setup, product] of [['m1', m1, 'repo'], ['m2', m2, 'repo'], ['m3', m3, 'repo'], ['m4a', (dir: string) => m4a(dir, { visionSilent: false, fakePace: true }), 'tidewater'], ['m5', m5, 'tidewater']] as const) {
  test(`console isolation: ${name} fixture config uses a free loopback port`, async () => {
    const dir = join(tmpDir(`console-${name}`), 'fx');
    const result = await setup(dir);
    const repo = (name === 'm5' || name === 'm4a') ? (result as ReturnType<typeof m5>).product : join(dir, product);
    const config = JSON.parse(readFileSync(join(repo, '.roadmap/config.json'), 'utf8'));
    assert.equal(config.webConsole?.host, '127.0.0.1');
    assert.ok(Number.isInteger(config.webConsole.port) && config.webConsole.port > 0);
    assert.notEqual(config.webConsole.port, 4747);
  });
}

test('console isolation: completed executor fixture teardown removes console process and lease', async t => {
  const cleanup: Array<() => Promise<void>> = [];
  const r = setupExec({ after: fn => { cleanup.push(fn); } }, { steps: [] });
  t.after(async () => { await stopConsole(absPath(r.repo)); });
  const lease = await ensureConsole(absPath(r.repo), absPath(r.hostDir));
  for (const fn of cleanup) await fn();
  assert.equal(isAlive(lease, lease.bootId), false);
  assert.equal(readConsoleLease(consoleCommon(absPath(r.repo))), null);
});
