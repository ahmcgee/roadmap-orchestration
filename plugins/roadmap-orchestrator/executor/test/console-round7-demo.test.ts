import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { consoleFixture } from './fixtures/console.ts';
import { portableStatus } from './fixtures/status-parity.ts';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { status } from '../src/status.ts';
import { openJournal } from '../src/core/log.ts';
import { milestoneId, serveName, sha } from '../src/core/ids.ts';
import { readBootId, identityOf } from '../src/contain/proc.ts';
import { EMPTY_RECORD, writeDemoRecord, type DemoRecord } from '../src/demo/records.ts';

for (const change of ['record', 'process death'] as const) test(`F2 demo ${change} invalidates server status without a journal event`, async t => {
  const f = consoleFixture(), promoted = sha('a'.repeat(40)), ms = milestoneId('MS-1'), web = serveName('web');
  const journal = openJournal(f.runDir, f.arc);
  journal.fact({ kind: 'demo-promoted', milestone: ms, sha: promoted }); journal.close();
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit'); t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await once(child.stdout!, 'data');
  const identity = identityOf(child.pid!);
  const record: DemoRecord = { ...EMPTY_RECORD, ports: { [web]: 12345 }, serving: {
    arc: f.arc, repo: f.repo, worktreeRoot: f.repo, slot: f.repo, milestone: ms, sha: promoted,
    bringUp: { setup: [], serve: [{ name: web, argv: [process.execPath], ready: { log: 'ready' } }], seed: [], env: {} },
    boot: readBootId(), processes: [{ name: web, ...identity }], state: 'up',
  } };
  writeDemoRecord(f.hostDir, record);
  const server = await serveConsole({ ...f, host: '127.0.0.1', port: 0 }); t.after(() => server.close());
  const read = async () => { const response = await fetch(`${server.url}/api/${CONSOLE_PROTOCOL}/runs/${f.arc}/status`); assert.equal(response.status, 200); return await response.json() as { revision: number; data: ReturnType<typeof status> }; };
  const before = await read(); assert.equal(before.data.demo?.serving, promoted);
  const journalBytes = readFileSync(join(f.runDir, 'events.jsonl'));
  if (change === 'record') writeDemoRecord(f.hostDir, { ...record, ports: { [web]: 23456 } });
  else { child.kill('SIGKILL'); await exited; }
  const after = await read(), local = status(f.runDir, f.arc, f.hostDir);
  assert.deepEqual(portableStatus(after.data), portableStatus(local));
  assert.ok(after.revision > before.revision);
  assert.equal(after.data.demo?.serving, change === 'record' ? promoted : null);
  if (change === 'record') { assert.equal(after.data.demo?.where?.type, 'url'); assert.ok(after.data.demo?.where?.type === 'url'); assert.equal(after.data.demo.where.url, 'http://127.0.0.1:23456/'); }
  assert.deepEqual(readFileSync(join(f.runDir, 'events.jsonl')), journalBytes);
});
