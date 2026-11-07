import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { consoleLease, ensureConsole, readConsoleLease, stopConsole } from '../src/console/lease.ts';
import { consoleFixture, setConsolePort } from './fixtures/console.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { consoleSettings } from '../src/console/settings.ts';

test('port zero is explicit allocation; default and invalid-config validation are unchanged', () => {
  assert.deepEqual(consoleSettings(null), { host: '0.0.0.0', port: 4747 });
  assert.deepEqual(consoleSettings(parseRepoConfig({ webConsole: { host: '127.0.0.1', port: 0 } })), { host: '127.0.0.1', port: 0 });
  for (const port of [-1, 65536, 1.5, '0']) assert.throws(() => parseRepoConfig({ webConsole: { port } }));
});

test('identical port-zero configs bind distinct ports, publish usable URLs and reuse their live leases', async t => {
  const fixtures = [consoleFixture(), consoleFixture()];
  for (const f of fixtures) { setConsolePort(f.repo, 0); t.after(() => stopConsole(f.repo)); }
  const before = fixtures.map(f => readFileSync(join(f.repo, '.roadmap/config.json'), 'utf8'));
  const leases = await Promise.all(fixtures.map(f => ensureConsole(f.repo, f.hostDir)));
  assert.notEqual(leases[0]!.port, leases[1]!.port);
  for (const [i, f] of fixtures.entries()) {
    const lease = leases[i]!;
    assert.ok(lease.port > 0 && lease.port <= 65535);
    assert.equal(lease.url, `http://127.0.0.1:${lease.port}`);
    assert.equal(lease.bindUrl, lease.url);
    assert.deepEqual(readConsoleLease(f.common), lease);
    assert.equal((await fetch(lease.url)).status, 200);
    assert.equal((await ensureConsole(f.repo, f.hostDir)).nonce, lease.nonce);
    assert.equal(readFileSync(join(f.repo, '.roadmap/config.json'), 'utf8'), before[i]);
    assert.throws(() => consoleLease({ ...lease, port: 0 }, 'lease'), /lease.port: expected an integer in \[1,/);
  }
});

test('explicit occupied ports refuse without retry or config rewriting', async t => {
  const held = createServer();
  await new Promise<void>(resolve => held.listen(0, '127.0.0.1', resolve));
  t.after(() => { held.close(); });
  const f = consoleFixture(); t.after(() => stopConsole(f.repo));
  setConsolePort(f.repo, (held.address() as AddressInfo).port);
  const before = readFileSync(join(f.repo, '.roadmap/config.json'), 'utf8');
  await assert.rejects(ensureConsole(f.repo, f.hostDir), /webConsole.port.*EADDRINUSE/s);
  assert.equal(readConsoleLease(f.common), null);
  assert.equal(readFileSync(join(f.repo, '.roadmap/config.json'), 'utf8'), before);
});


test('start and resume report the bound URL from the port-zero lease', { timeout: 45000 }, async t => {
  const { setupExec, cli, until, hostLockHeld, execEnv } = await import('./fixtures/exec-common.ts');
  const { startCli, startLine, pausedFromTheStart, idle, smokes, kill, supervisorOf, ownerOf } = await import('./fixtures/sup-common.ts');
  const { consoleCommon } = await import('../src/console/lease.ts');
  const { absPath } = await import('../src/core/values.ts');
  const { runFixture } = await import('./helpers/proc.ts');
  const r = setupExec(t, { steps: smokes(2), webConsole: { host: '127.0.0.1', port: 0 } });
  await pausedFromTheStart(r);
  const start = await startCli(r); assert.equal(start.code, 0, start.stderr);
  await idle(r, startLine(start).generation!);
  const lease = readConsoleLease(consoleCommon(absPath(r.repo)))!;
  assert.ok(lease.port > 0); assert.ok(start.stderr.includes(lease.url));
  // resume-arc restores a dead claimed run; an orderly stop releases the claim and is a no-op.
  const executor = ownerOf(r)!.executor!;
  await kill(supervisorOf(r)); await kill(executor);
  const resume = await runFixture('exec-cli.ts', [r.hostDir, 'resume-arc', '--repo', r.repo], { env: execEnv(r), timeoutMs: 15000 });
  assert.equal(resume.code, 0, resume.stderr);
  assert.ok(resume.stderr.includes(lease.url));
  assert.equal(readConsoleLease(consoleCommon(absPath(r.repo)))!.nonce, lease.nonce);
  await idle(r, startLine(resume).generation!);
  await cli(r, ['stop']); await until(() => !hostLockHeld(r), 15000, 'stop resumed run');
});
