import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { consoleCommon, ensureConsole, serviceDir, readConsoleLease, stopConsole } from '../src/console/lease.ts';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { isAlive } from '../src/host/liveness.ts';
import { absPath } from '../src/core/values.ts';
import { setupExec, cli, until, hostLockHeld } from './fixtures/exec-common.ts';
import { startCli, startLine, pausedFromTheStart, idle, smokes, supervisorOf, kill, launchDirect, ownerOf } from './fixtures/sup-common.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { withConsolePort } from './helpers/console-port.ts';
import { commitAll } from './helpers/repo.ts';
import { consoleFixture } from './fixtures/console.ts';

after(assertNoSurvivors);
test('automatic startup precedes claim; explicit console stop survives ticks, another start restores it; executor stop/death leave it running', { timeout: 90_000 }, async (t) => {
  await withConsolePort(async port => {
  const r = setupExec(t, { steps: smokes(1), webConsole: { host: '127.0.0.1', port } });
  await pausedFromTheStart(r);
  const started = await startCli(r);
  if (/EADDRINUSE/.test(started.stderr)) { await cli(r, ['stop']); await until(() => !hostLockHeld(r), 15_000, 'retry stop'); throw new Error(started.stderr); }
  const line = startLine(started); assert.equal(line.kind, 'ready');
  await idle(r, line.generation!);
  const common = consoleCommon(absPath(r.repo)); const first = readConsoleLease(common)!;
  assert.ok(first.ready && isAlive(first, first.bootId));
  await stopConsole(absPath(r.repo));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(readConsoleLease(common), null, 'supervisor ticks never restore an explicitly stopped console');
  const busy = await startCli(r); assert.equal(busy.code, 75, busy.stdout + busy.stderr);
  const restored = readConsoleLease(common)!;
  assert.notEqual(restored.nonce, first.nonce); assert.ok(restored.ready && isAlive(restored, restored.bootId));
  await cli(r, ['stop']); await until(() => !hostLockHeld(r), 15_000, 'executor stop');
  assert.equal(isAlive(restored, restored.bootId), true);
  // The console itself can crash; ensure on the next start restores a different identity.
  process.kill(restored.pid, 'SIGKILL');
  await until(() => !isAlive(restored, restored.bootId), 5000, 'console death');
  const next = await ensureConsole(absPath(r.repo), absPath(r.hostDir)); assert.notEqual(next.nonce, restored.nonce);
  });
});

test('direct supervisor entry also ensures readiness; supervisor death does not terminate the console', { timeout: 60_000 }, async (t) => {
  await withConsolePort(async port => {
  const r = setupExec(t, { steps: smokes(1), webConsole: { host: '127.0.0.1', port } });
  await pausedFromTheStart(r);
  const supervisor = launchDirect(r, 300_000);
  await until(() => ownerOf(r)?.executor !== null && ownerOf(r)?.executor !== undefined, 15_000, 'direct supervisor owner');
  await idle(r, ownerOf(r)!.generation);
  const lease = readConsoleLease(consoleCommon(absPath(r.repo)));
  if (!lease) {
    const dir = serviceDir(consoleCommon(absPath(r.repo)));
    const errors = readdirSync(dir).filter(n => n.endsWith('.log')).map(n => readFileSync(join(dir, n), 'utf8')).join('\n');
    if (/EADDRINUSE/.test(errors)) { await kill(supervisor); await cli(r, ['stop']); await until(() => !hostLockHeld(r), 15_000, 'retry stop'); throw new Error(errors); }
  }
  assert.ok(lease); assert.ok(lease.ready && isAlive(lease, lease.bootId));
  await kill(supervisor);
  assert.equal(isAlive(lease, lease.bootId), true);
  await cli(r, ['stop']);
  });
});

test('a real start on an occupied configured port warns, proceeds, and never chooses another console port', { timeout: 30_000 }, async (t) => {
  const r = setupExec(t, { steps: smokes(1) });
  const held = createServer();
  await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
  t.after(() => { held.close(); });
  const path = join(r.repo, '.roadmap', 'config.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.webConsole.port = (held.address() as import('node:net').AddressInfo).port; writeFileSync(path, JSON.stringify(config));
  commitAll(r.repo, 'occupied console fixture');
  await pausedFromTheStart(r);
  const exit = await startCli(r);
  assert.equal(exit.code, 0, exit.stdout + exit.stderr); assert.match(exit.stderr, /WARNING:.*\.roadmap\/config.json webConsole.port.*EADDRINUSE/s);
  const line = startLine(exit); await idle(r, line.generation!);
  assert.equal(hostLockHeld(r), true); assert.equal(readConsoleLease(consoleCommon(absPath(r.repo))), null);
  await cli(r, ['stop']); await until(() => !hostLockHeld(r), 15_000, 'executor stop');
});

test('SSE invalidates side-file changes, verifies heartbeats, reconnects with explicit reset and keeps HTTP responsive', { timeout: 20_000 }, async (t) => {
  const f = consoleFixture(); const s = await serveConsole({ ...f, host: '127.0.0.1', port: 0 }); t.after(() => s.close());
  const controller = new AbortController(); t.after(() => controller.abort());
  const url = `${s.url}/api/${CONSOLE_PROTOCOL}/runs/${f.arc}/events`;
  const response = await fetch(url, { signal: controller.signal }); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader(); let carry = '';
  const event = async () => {
    for (;;) {
      const end = carry.indexOf('\n\n');
      if (end !== -1) { const frame = carry.slice(0, end); carry = carry.slice(end + 2); return frame; }
      const page = await reader.read(); assert.equal(page.done, false); carry += new TextDecoder().decode(page.value);
    }
  };
  const first = await event(); assert.match(first, /event: revision/); assert.match(first, /checkedAt/);
  const id = /^id: (.+)$/m.exec(first)![1]!;
  writeFileSync(join(f.runDir, 'heartbeat.json'), JSON.stringify({ v: 2, generation: 1, at: new Date().toISOString() }));
  let changed = '';
  await until(async () => { changed = await event(); return /event: revision/.test(changed) && !changed.startsWith(`id: ${id}\n`); }, 5000, 'side-file revision');
  assert.match(changed, /highWater/);
  const reconnect = await fetch(url, { headers: { 'last-event-id': id }, signal: controller.signal });
  const second = await reconnect.body!.getReader().read(); assert.match(new TextDecoder().decode(second.value), /event: reset/);
  const quick = await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/runs`, { signal: AbortSignal.timeout(1000) }); assert.equal(quick.status, 200);
  controller.abort();
});
