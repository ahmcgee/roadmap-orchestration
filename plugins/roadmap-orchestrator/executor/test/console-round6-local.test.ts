import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { consoleStatus } from '../src/console/client.ts';
import { consoleFixture } from './fixtures/console.ts';
import { portableStatus } from './fixtures/status-parity.ts';

test('R1 local status remains available while observation inputs are atomically republished', async t => {
  const f = consoleFixture();
  const expected = JSON.parse(await consoleStatus(f, f.hostDir, false, () => {}));
  const path = join(f.runDir, 'commands', 'receipts', 'cmd-0000000000000001.rejected.json');
  const writer = new Worker(`const {workerData:d,parentPort}=require('node:worker_threads');const fs=require('node:fs');function tick(){fs.writeFileSync(d.path+'.tmp',d.bytes);fs.renameSync(d.path+'.tmp',d.path);}tick();parentPort.postMessage('ready');setInterval(tick,1);`, { eval: true, workerData: { path, bytes: readFileSync(path) } });
  t.after(() => writer.terminate());
  await new Promise(resolve => writer.once('message', resolve));
  const started = performance.now();
  const actual = JSON.parse(await consoleStatus(f, f.hostDir, false, () => {}));
  assert.deepEqual(portableStatus(actual), portableStatus(expected));
  assert.ok(performance.now() - started < 1500, 'local canonical capture does not wait for a globally quiet interval');
});
