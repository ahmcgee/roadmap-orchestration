// The watchdog of helpers/reap.ts: a test process killed before its teardown (SIGKILL, which it cannot
// handle; SIGTERM or SIGINT from whatever runs the suite end it the same way) leaves no process of a scope it
// owned alive.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, statOf } from '../src/contain/proc.ts';
import { fixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';

for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
  test(`reap.watchdog-${signal}: a test process ended by ${signal} before its teardown leaves nothing of its scopes alive`, { timeout: 30_000 }, async () => {
    const path = tmpDir('reap-scope');
    const child = spawn(process.execPath, [fixture('reap-child.ts'), path], { stdio: ['ignore', 'pipe', 'inherit'] });
    const [line] = (await once(child.stdout.setEncoding('utf8'), 'data')) as [string];
    const pid = Number(line.trim());
    const stat = statOf(pid);
    assert.ok(stat !== null, `the scope's process ${pid} is running`);
    const run = { pid, start: stat.start };
    child.kill(signal);
    await once(child, 'close');
    const deadline = Date.now() + 15_000;
    while (isAlive(run) && Date.now() < deadline) await sleep(50);
    assert.equal(isAlive(run), false, `the scope's process ${pid} outlived the test process that owned it`);
  });
}
