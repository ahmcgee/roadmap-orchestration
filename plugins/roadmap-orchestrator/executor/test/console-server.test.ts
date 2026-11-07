import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openJournal } from '../src/core/log.ts';
import { invocationDirName, opKey, sha256 } from '../src/core/ids.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { parseCommand } from '../src/input/cli.ts';
import { consoleSettings } from '../src/console/settings.ts';
import { serveConsole } from '../src/console/http.ts';
import { consoleFixture } from './fixtures/console.ts';
import { CONSOLE_PROTOCOL, type Envelope } from '../src/observation/protocol.ts';

test('console config defaults, literal addresses, strict ports/keys and CLI surface', () => {
  assert.deepEqual(consoleSettings(null), { host: '0.0.0.0', port: 4747 });
  assert.deepEqual(consoleSettings(parseRepoConfig({ webConsole: { host: '::1' } })), { host: '::1', port: 4747 });
  for (const webConsole of [{ host: 'localhost' }, { port: -1 }, { port: 65536 }, { port: 1.2 }, { host: ':::' }, { typo: true }]) assert.throws(() => parseRepoConfig({ webConsole }));
  for (const action of ['start', 'stop', 'status']) assert.deepEqual(parseCommand(['console', action, '--repo', '/repo']), { command: 'console', action, repo: '/repo' });
  assert.throws(() => parseCommand(['console', 'restart', '--repo', '/repo']));
});

test('real HTTP worker observes retained runs, enforces GET/HEAD, immutable status bytes and request fences', async (t) => {
  const f = consoleFixture();
  const console = await serveConsole({ ...f, host: '127.0.0.1', port: 0, instance: 'test' });
  t.after(() => console.close());
  const api = `${console.url}/api/${CONSOLE_PROTOCOL}`;
  const runs = await (await fetch(`${api}/arcs`)).json() as { selected: string; arcs: { arc: string }[]; runs?: unknown };
  assert.ok(runs.arcs.some(a => a.arc === f.arc)); assert.equal(runs.runs, undefined);
  assert.equal((await fetch(`${api}/runs`)).status, 404, 'old API routes have no compatibility alias');
  assert.equal(runs.selected, f.arc);
  const response = await fetch(`${api}/arcs/${f.arc}/snapshot`);
  const e = await response.json() as Envelope;
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(e.data.display.status.arc, f.arc);
  assert.equal(e.data.display.status.units.length, 3);
  assert.ok(response.headers.get('content-security-policy')?.includes("default-src 'self'"));
  assert.equal((await fetch(`${api}/arcs/${f.arc}/status?summary=1`)).status, 200);
  assert.equal((await fetch(`${api}/arcs/${f.arc}/snapshot?minHighWater=${e.highWater + 1}`)).status, 503);
  assert.equal((await fetch(`${api}/arcs/${f.arc}/snapshot?epoch=old`)).status, 409);
  assert.equal((await fetch(`${api}/arcs/${f.arc}/units/u1`)).status, 200);
  assert.equal((await fetch(`${api}/arcs/${f.arc}/units/missing`)).status, 404);
  assert.equal((await fetch(`${api}/arcs`, { method: 'POST' })).status, 405);
  assert.equal(await (await fetch(`${api}/arcs`, { method: 'HEAD' })).text(), '');
  assert.equal((await fetch(`${console.url}/api/old/arcs`)).status, 409);
  assert.equal((await fetch(`${api}/arcs/${f.arc}/units/a%2fb`)).status, 400);
  assert.equal((await fetch(`${console.url}/package.json`)).status, 404);
  assert.equal((await fetch(`${api}/arcs`)).headers.get('access-control-allow-origin'), null);
});

test('occupied explicit port refuses binding without choosing another', async (t) => {
  const held = createServer();
  await new Promise<void>((r) => held.listen(0, '127.0.0.1', r));
  t.after(() => { held.close(); });
  const port = (held.address() as import('node:net').AddressInfo).port;
  await assert.rejects(serveConsole({ ...consoleFixture(), host: '127.0.0.1', port, instance: 'test' }), /\.roadmap\/config.json.*webConsole.port.*EADDRINUSE/);
});


test('logs use recorded invocation IDs, bounded byte pages, explicit pruning and descriptor containment', async (t) => {
  const f = consoleFixture();
  const j = openJournal(f.runDir, f.arc);
  const inv = j.begin({ kind: 'proc.spawn', key: opKey('console-log'), parent: { type: 'arc' }, deadlineAt: null,
    body: () => ({ expect: { subject: { purpose: 'smoke', check: 'command', target: { type: 'command' } }, launchSha256: sha256('1'.repeat(64)) }, post: null }) }).inv;
  j.close();
  const dir = invocationDir(f.runDir, inv); mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('é'.repeat(40000)); writeFileSync(join(dir, 'stdout'), bytes);
  const console = await serveConsole({ ...f, host: '127.0.0.1', port: 0 }); t.after(() => console.close());
  const root = `${console.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/invocations/${invocationDirName(inv)}`;
  const first = await (await fetch(`${root}/log?after=0`)).json() as { data: { after: number; next: number; bytes: string; identity: string } };
  assert.ok(first.data, JSON.stringify(first));
  assert.equal(first.data.next, 65536);
  const next = await (await fetch(`${root}/log?after=${first.data.next}&identity=${first.data.identity}`)).json() as typeof first;
  assert.deepEqual(Buffer.concat([Buffer.from(first.data.bytes, 'base64'), Buffer.from(next.data.bytes, 'base64')]), bytes);
  assert.equal((await fetch(`${root}/log?source=launch.json`)).status, 400);
  assert.equal((await fetch(`${root}/log?after=-1`)).status, 400);
  assert.equal((await fetch(`${root}/log?after=999999`)).status, 409);
  assert.equal((await fetch(`${root}/log?identity=old`)).status, 409);
  assert.equal((await fetch(`${root}/result`)).status, 404);
  assert.equal((await fetch(`${root}/log?source=stderr`)).status, 404);
  rmSync(join(dir, 'stdout')); symlinkSync('/etc/hostname', join(dir, 'stdout'));
  const escaped = await fetch(`${root}/log`);
  assert.equal(escaped.status, 400);
  assert.match(await escaped.text(), /symlink escapes/);
});
