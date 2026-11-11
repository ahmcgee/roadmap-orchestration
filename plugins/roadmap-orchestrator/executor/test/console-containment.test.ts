import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readBootId } from '../src/contain/proc.ts';
import { consoleStatus } from '../src/console/client.ts';
import { publishConsoleLease, serviceDir } from '../src/console/lease.ts';
import { nonce } from '../src/core/values.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { checkRunContainment } from '../src/observation/containment.ts';
import { Observer } from '../src/observation/observer.ts';
import { CONSOLE_PROTOCOL, ConsoleError } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';

function restoreSpies(t: TestContext): void {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
function directory(t: TestContext): string {
  restoreSpies(t);
  const dir = fs.mkdtempSync(join(tmpdir(), 'containment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('containment skips a temporary entry renamed between enumeration and lstat', t => {
  const root = directory(t), temp = join(root, 'manifest.json.race.tmp');
  fs.writeFileSync(temp, '{}');
  const lstat = fs.lstatSync;
  let races = 0;
  t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof lstat>) => {
    if (args[0] === temp) { fs.renameSync(temp, join(root, 'manifest.json')); races++; }
    return lstat(...args);
  }) as typeof lstat);
  syncBuiltinESMExports();
  assert.doesNotThrow(() => checkRunContainment(root));
  assert.equal(races, 1);
});

test('containment skips a directory removed between lstat and readdir', t => {
  const root = directory(t), child = join(root, 'removed');
  fs.mkdirSync(child);
  const readdir = fs.readdirSync;
  let races = 0;
  t.mock.method(fs, 'readdirSync', ((...args: Parameters<typeof readdir>) => {
    if (args[0] === child) { fs.rmdirSync(child); races++; }
    return readdir(...args);
  }) as typeof readdir);
  syncBuiltinESMExports();
  assert.doesNotThrow(() => checkRunContainment(root));
  assert.equal(races, 1);
});

test('containment still rejects an escaping symlink', t => {
  const root = directory(t);
  fs.symlinkSync(tmpdir(), join(root, 'escape'));
  assert.throws(() => checkRunContainment(root), (e: unknown) => e instanceof ConsoleError && e.code === 'invalid' && /symlink escapes/.test(e.message));
});

test('containment preserves ENOENT for a dangling symlink that still exists', t => {
  const root = directory(t), child = join(root, 'dangling');
  fs.symlinkSync(join(root, 'missing'), child);
  assert.throws(() => checkRunContainment(root), { code: 'ENOENT' });
  assert.equal(fs.lstatSync(child).isSymbolicLink(), true);
});

test('containment skips a symlink removed before target resolution', t => {
  const root = directory(t), child = join(root, 'removed-link');
  fs.symlinkSync(root, child);
  const realpath = fs.realpathSync;
  let races = 0;
  t.mock.method(fs, 'realpathSync', ((...args: Parameters<typeof realpath>) => {
    if (args[0] === child) { fs.unlinkSync(child); races++; }
    return realpath(...args);
  }) as typeof realpath);
  syncBuiltinESMExports();
  assert.doesNotThrow(() => checkRunContainment(root));
  assert.equal(races, 1);
});

test('containment propagates errors other than ENOENT', t => {
  const root = directory(t), child = join(root, 'unreadable');
  fs.writeFileSync(child, '{}');
  const lstat = fs.lstatSync, failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof lstat>) => {
    if (args[0] === child) throw failure;
    return lstat(...args);
  }) as typeof lstat);
  syncBuiltinESMExports();
  assert.throws(() => checkRunContainment(root), e => e === failure);
});

for (const mode of ['absent', 'unavailable'] as const) {
  test(`CLI local status survives a vanishing publication temporary when console is ${mode}`, async t => {
    restoreSpies(t);
    const f = consoleFixture();
    if (mode === 'unavailable') {
      const server = createServer((_req, res) => res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unavailable', message: 'console has not verified the arc since this request arrived' } })));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
      const port = (server.address() as AddressInfo).port, url = `http://127.0.0.1:${port}`;
      fs.mkdirSync(serviceDir(f.common), { recursive: true });
      publishConsoleLease({ ...selfIdentity(), bootId: readBootId(), nonce: nonce('a'.repeat(32)), executorVersion: CONSOLE_PROTOCOL, repo: f.repo, common: f.common, hostDir: f.hostDir, configSource: `${f.repo}/.roadmap/config.json`, host: '127.0.0.1', port, bindUrl: url, url, ready: true, startedAt: new Date().toISOString() });
    }
    const temp = join(f.runDir, 'manifest.json.race.tmp');
    fs.writeFileSync(temp, '{}');
    const lstat = fs.lstatSync;
    let races = 0;
    t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof lstat>) => {
      if (args[0] === temp) { fs.renameSync(temp, join(f.runDir, 'manifest.json')); races++; }
      return lstat(...args);
    }) as typeof lstat);
    const captures = t.mock.method(Observer.prototype, 'capture');
    syncBuiltinESMExports();
    const lines: string[] = [];
    assert.equal(JSON.parse(await consoleStatus(f, f.hostDir, false, l => lines.push(l))).arc, f.arc);
    assert.equal(races, 1);
    assert.equal(captures.mock.callCount(), 1, 'a vanished temporary needs no recapture');
    assert.ok(lines.some(l => l.includes(`${mode === 'absent' ? 'server is absent' : 'console has not verified the arc since this request arrived'}; using local observation`)));
  });
}

for (const persistent of [false, true]) {
  test(`CLI local capture ${persistent ? 'bounds persistent dependency races as unavailable' : 'retries ENOENT from a dependency inside Observer'}`, async t => {
    restoreSpies(t);
    const f = consoleFixture(), path = join(f.runDir, 'heartbeat.json');
    const heartbeat = JSON.stringify({ v: 2, generation: 1, at: '2026-06-01T00:00:00.000Z' });
    fs.writeFileSync(path, heartbeat);
    const read = fs.readFileSync;
    let races = 0;
    t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
      if (args[0] !== path || (!persistent && races > 0)) return read(...args);
      fs.unlinkSync(path); races++;
      try { return read(...args); }
      finally { fs.writeFileSync(path, heartbeat); }
    }) as typeof read);
    const captures = t.mock.method(Observer.prototype, 'capture');
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    syncBuiltinESMExports();
    const local = () => consoleStatus(f, f.hostDir, false, () => {});
    if (persistent) {
      await assert.rejects(local(), (e: unknown) => e instanceof ConsoleError && e.code === 'unavailable' && /observation file disappeared/.test(e.message));
      assert.equal(races, 2);
      t.mock.restoreAll(); syncBuiltinESMExports();
      assert.equal(JSON.parse(await local()).arc, f.arc, 'failed local attempts do not poison later status');
    } else {
      const status = JSON.parse(await local());
      assert.equal(status.arc, f.arc);
      assert.equal(status.run.heartbeatAt, '2026-06-01T00:00:00.000Z');
      assert.equal(races, 1);
      assert.equal(captures.mock.callCount(), 2);
    }
  });
}

test('CLI retries a console lease removed between existence check and read before local fallback', async t => {
  restoreSpies(t);
  const f = consoleFixture(), path = join(serviceDir(f.common), 'lease.json');
  fs.mkdirSync(serviceDir(f.common), { recursive: true });
  fs.writeFileSync(path, '{}'); // It disappears before parsing, so no lease is returned.
  const read = fs.readFileSync;
  let races = 0;
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    if (args[0] === path) { fs.unlinkSync(path); races++; }
    return read(...args);
  }) as typeof read);
  syncBuiltinESMExports();
  const lines: string[] = [];
  assert.equal(JSON.parse(await consoleStatus(f, f.hostDir, false, l => lines.push(l))).arc, f.arc);
  assert.equal(races, 1);
  assert.ok(lines.some(l => l.includes('server is absent; using local observation')));
});
