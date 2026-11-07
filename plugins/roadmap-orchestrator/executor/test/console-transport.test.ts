import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { durableMkdir, durableUnlink } from '../src/core/fsx.ts';
import { sha256Hex } from '../src/core/json.ts';
import { nonce } from '../src/core/values.ts';
import { readBootId } from '../src/contain/proc.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { consoleStatus } from '../src/console/client.ts';
import { publishConsoleLease, serviceDir } from '../src/console/lease.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';

test('CLI refuses malformed, mismatched and corrupt responses; version/timeout/unreachable fall back locally', { timeout: 15_000 }, async (t) => {
  const f = consoleFixture(); const instance = nonce('a'.repeat(32));
  const capture = new ObservationCache(f.hostDir, instance, sha256Hex(f.common)).read(f);
  let mode = 'good';
  const server = createServer((req, res) => {
    if (mode === 'timeout') return;
    const summary = new URL(req.url!, 'http://console').searchParams.get('summary') === '1';
    const e = { ...capture, data: summary ? capture.data.summary : capture.data.display.status };
    const body = mode === 'malformed' ? { ...e, data: { arc: f.arc } } : mode === 'protocol' ? { ...e, protocol: 'other' } : mode === 'identity' ? { ...e, instance: 'other' } : mode === 'corruption' ? { error: { code: 'corruption', message: 'recorded hash mismatch' } } : e;
    res.writeHead(mode === 'corruption' ? 500 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); durableUnlink(join(serviceDir(f.common), 'lease.json')); });
  const port = (server.address() as AddressInfo).port, url = `http://127.0.0.1:${port}`;
  durableMkdir(serviceDir(f.common));
  publishConsoleLease({ ...selfIdentity(), bootId: readBootId(), nonce: instance, executorVersion: CONSOLE_PROTOCOL, repo: f.repo, common: f.common, hostDir: f.hostDir, configSource: `${f.repo}/.roadmap/config.json`, host: '127.0.0.1', port, bindUrl: url, url, ready: true, startedAt: new Date().toISOString() });
  const lines: string[] = [];
  const read = () => consoleStatus(f, f.hostDir, false, (l) => lines.push(l));
  assert.equal(JSON.parse(await read()).arc, f.arc);
  for (mode of ['malformed', 'identity', 'corruption']) {
    lines.length = 0; await assert.rejects(read(), /malformed|protocol|identity|corruption/);
    assert.ok(lines.every((line) => !line.includes('using local observation')));
  }
  mode = 'protocol'; lines.length = 0; assert.equal(JSON.parse(await read()).arc, f.arc); assert.ok(lines.some(line => line.includes('protocol/version mismatch') && line.includes('using local observation')));
  mode = 'timeout'; lines.length = 0; const began = Date.now();
  assert.equal(JSON.parse(await read()).arc, f.arc); assert.ok(Date.now() - began < 4000);
  assert.ok(lines.some((line) => line.includes('using local observation')));
  server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
  lines.length = 0; assert.equal(JSON.parse(await read()).arc, f.arc);
  assert.ok(lines.some((line) => line.includes('using local observation')));
});
