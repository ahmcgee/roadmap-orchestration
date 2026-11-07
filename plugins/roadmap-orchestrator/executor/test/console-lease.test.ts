import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureConsole as ensureService, readConsoleLease, serviceDir, stopConsole } from '../src/console/lease.ts';
import { consoleStatus } from '../src/console/client.ts';
import { isAlive } from '../src/host/liveness.ts';
import { CONSOLE_PROTOCOL, type Envelope } from '../src/observation/protocol.ts';
import { consoleFixture, setConsolePort } from './fixtures/console.ts';
import { freeConsolePort, withConsolePort, withConfiguredConsolePort } from './helpers/console-port.ts';
import { git } from './helpers/repo.ts';
import { absPath } from '../src/core/values.ts';

const ensureConsole = (repo: Parameters<typeof ensureService>[0], host: Parameters<typeof ensureService>[1]) => withConfiguredConsolePort(repo, () => ensureService(repo, host));

test('concurrent starters share readiness, worktrees share ownership, settings conflict, stop persists and version replacement waits for death', async (t) => {
  const f = consoleFixture();
  setConsolePort(f.repo, freeConsolePort());
  t.after(() => stopConsole(f.repo));
  const leases = await withConsolePort(port => { setConsolePort(f.repo, port); return Promise.all(Array.from({ length: 4 }, () => ensureConsole(f.repo, f.hostDir))); });
  assert.ok(leases.every((l) => l.pid === leases[0]!.pid && l.nonce === leases[0]!.nonce && l.ready));
  const lease = leases[0]!;
  assert.equal(isAlive(lease, lease.bootId), true);
  const worktree = `${f.repo}-worktree`;
  git(f.repo, 'worktree', 'add', '--detach', worktree);
  setConsolePort(worktree, lease.port);
  assert.equal((await ensureConsole(absPath(worktree), f.hostDir)).pid, lease.pid);
  setConsolePort(worktree, freeConsolePort());
  await assert.rejects(ensureConsole(absPath(worktree), f.hostDir), /webConsole.port.*conflicts.*stop\/start/);
  const path = join(serviceDir(f.common), 'lease.json');
  const old = JSON.parse(readFileSync(path, 'utf8')); old.executorVersion = 'older';
  writeFileSync(path, JSON.stringify(old));
  const next = await ensureConsole(f.repo, f.hostDir);
  assert.notEqual(next.nonce, lease.nonce);
  assert.equal(isAlive(lease, lease.bootId), false);
  assert.equal(next.executorVersion, CONSOLE_PROTOCOL);
  assert.equal((await stopConsole(f.repo)).state, 'stopped');
  assert.equal(readConsoleLease(f.common), null);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(readConsoleLease(f.common), null);
  const restored = await ensureConsole(f.repo, f.hostDir);
  assert.notEqual(restored.nonce, next.nonce);
});

test('CLI transport bytes equal the same captured observation; stopped/dead server falls back with diagnostic, old version falls back locally', async (t) => {
  const f = consoleFixture(); setConsolePort(f.repo, freeConsolePort());
  t.after(() => stopConsole(f.repo));
  const lease = await withConsolePort(port => { setConsolePort(f.repo, port); return ensureConsole(f.repo, f.hostDir); });
  const diagnostics: string[] = [];
  const e = await (await fetch(`${lease.url}/api/${CONSOLE_PROTOCOL}/runs/${f.arc}/snapshot`)).json() as Envelope;
  const full = await consoleStatus(f, f.hostDir, false, (l) => diagnostics.push(l));
  const summary = await consoleStatus(f, f.hostDir, true, (l) => diagnostics.push(l));
  const { canonicalJson } = await import('../src/core/json.ts');
  assert.equal(full, canonicalJson(e.data.display.status) + '\n');
  assert.equal(summary, canonicalJson(e.data.summary) + '\n');
  assert.ok(diagnostics.every((d) => d.includes(lease.url)));
  const path = join(serviceDir(f.common), 'lease.json');
  const bad = { ...readConsoleLease(f.common)!, executorVersion: 'incompatible' };
  writeFileSync(path, JSON.stringify(bad));
  diagnostics.length = 0;
  assert.equal(JSON.parse(await consoleStatus(f, f.hostDir, false, l => diagnostics.push(l))).arc, f.arc);
  assert.ok(diagnostics.some(l => l.includes('protocol/version mismatch') && l.includes('using local observation')));
  await stopConsole(f.repo);
  diagnostics.length = 0;
  assert.equal(JSON.parse(await consoleStatus(f, f.hostDir, false, (l) => diagnostics.push(l))).arc, f.arc);
  assert.ok(diagnostics.some((d) => d.includes('using local observation')));
});

test('invalid config names the port setting; stale PID identity is never signalled', async (t) => {
  const f = consoleFixture();
  const path = join(f.repo, '.roadmap', 'config.json');
  writeFileSync(path, JSON.stringify({ webConsole: { port: 0 } }));
  await assert.rejects(ensureConsole(f.repo, f.hostDir), /\.roadmap\/config.json webConsole.port/);
  setConsolePort(f.repo, freeConsolePort());
  const lease = await withConsolePort(port => { setConsolePort(f.repo, port); return ensureConsole(f.repo, f.hostDir); });
  t.after(() => stopConsole(f.repo));
  await stopConsole(f.repo);
  const { selfIdentity } = await import('../src/host/liveness.ts');
  const self = selfIdentity();
  writeFileSync(join(serviceDir(f.common), 'lease.json'), JSON.stringify({ ...lease, url: 'http://127.0.0.1:1' }));
  assert.throws(() => readConsoleLease(f.common), /URL\/binding identity mismatch/);
  writeFileSync(join(serviceDir(f.common), 'lease.json'), JSON.stringify({ ...lease, pid: self.pid, start: self.start + 1 }));
  assert.equal((await stopConsole(f.repo)).state, 'stale');
  assert.equal(process.pid, self.pid);
});

test('real console CLI keeps stdout empty, reports identical status URLs, restores after stop and bounds forced termination', { timeout: 25_000 }, async (t) => {
  const { runFixture } = await import('./helpers/proc.ts');
  const f = consoleFixture(); setConsolePort(f.repo, freeConsolePort());
  t.after(() => stopConsole(f.repo));
  const command = (action: string) => runFixture('exec-cli.ts', [f.hostDir, 'console', action, '--repo', f.repo], { timeoutMs: 15_000, env: process.env });
  const start = await withConsolePort(async port => { setConsolePort(f.repo, port); const result = await command('start'); if (result.code !== 0 && /EADDRINUSE/.test(result.stderr)) throw new Error(result.stderr); return result; }); assert.equal(start.code, 0, start.stderr); assert.equal(start.stdout, '');
  const lease = readConsoleLease(f.common)!; assert.ok(start.stderr.includes(lease.url));
  const status = await command('status'); assert.equal(status.code, 0); assert.equal(status.stdout, ''); assert.equal(status.stderr, start.stderr);
  const legacy = await runFixture('exec-cli.ts', [f.hostDir, 'status', '--summary', '--repo', f.repo, '--arc', f.arc], { env: process.env, timeoutMs: 15_000 });
  assert.equal(legacy.code, 0, legacy.stderr); const value = JSON.parse(legacy.stdout);
  assert.equal(value.arc, f.arc); assert.equal(Object.hasOwn(value, 'observedAt'), false); assert.ok(legacy.stderr.includes(lease.url));
  const stopped = await command('stop'); assert.equal(stopped.code, 0, stopped.stderr); assert.equal(stopped.stdout, ''); assert.match(stopped.stderr, /stopped/);
  assert.equal((await command('status')).stderr, stopped.stderr);
  const restart = await withConfiguredConsolePort(f.repo, async () => { const result = await command('start'); if (result.code !== 0 && /EADDRINUSE/.test(result.stderr)) throw new Error(result.stderr); return result; }); assert.equal(restart.code, 0, restart.stderr);
  const next = readConsoleLease(f.common)!; assert.notEqual(next.nonce, lease.nonce);
  process.kill(next.pid, 'SIGSTOP'); // TERM cannot be handled; the production bounded KILL path must end it.
  const forced = await command('stop'); assert.equal(forced.code, 0, forced.stderr); assert.equal(isAlive(next, next.bootId), false);
});
