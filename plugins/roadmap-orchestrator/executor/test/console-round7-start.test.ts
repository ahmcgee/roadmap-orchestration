import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { absPath } from '../src/core/values.ts';
import { sha256Hex } from '../src/core/json.ts';
import { ensureArcConsole, ensureConsole, serviceDir, stopConsole } from '../src/console/lease.ts';
import { consoleFixture } from './fixtures/console.ts';
import { setupExec, cli, execEnv, hostLockHeld, until } from './fixtures/exec-common.ts';
import { startCli, startLine, pausedFromTheStart, idle, smokes, supervisorOf, ownerOf, kill } from './fixtures/sup-common.ts';
import { commitAll, tmpDir } from './helpers/repo.ts';
import { runFixture } from './helpers/proc.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
after(assertNoSurvivors);

for (const cause of ['startup timeout', 'settings conflict'] as const) test(`F1 ${cause}: start and resume proceed with one warning; console start refuses`, { timeout: 90000 }, async t => {
  const r = setupExec(t, { steps: smokes(2) });
  let env = execEnv(r);
  if (cause === 'startup timeout') {
    // A Node preload delays only the console child; no production test hook or shared port.
    const preload = join(tmpDir('console-delay'), 'delay.mjs');
    writeFileSync(preload, "if (process.env.ROADMAP_ROLE === 'console') await new Promise(resolve => setTimeout(resolve, 60000));\n");
    env = { ...env, NODE_OPTIONS: `${env['NODE_OPTIONS'] ?? ''} --import=${pathToFileURL(preload).href}` };
  } else {
    const lease = await ensureConsole(absPath(r.repo), absPath(r.hostDir));
    const path = join(r.repo, '.roadmap/config.json');
    const config = JSON.parse(readFileSync(path, 'utf8')); config.webConsole.host = '::1';
    writeFileSync(path, JSON.stringify(config)); commitAll(r.repo, 'conflicting console host');
    assert.ok(lease.port > 0);
  }
  await pausedFromTheStart(r);
  const warning = (stderr: string) => {
    assert.equal((stderr.match(/WARNING: Roadmap console/g) ?? []).length, 1, stderr);
    assert.match(stderr, /arc work continues/);
    assert.match(stderr, cause === 'startup timeout' ? /startup.*timed out.*webConsole.port|webConsole.port.*startup.*timed out/s : /webConsole.port.*conflicts.*roadmap console stop/s);
  };
  const started = await startCli(r, undefined, env);
  assert.equal(started.code, 0, started.stdout + started.stderr); warning(started.stderr);
  await idle(r, startLine(started).generation!); assert.equal(hostLockHeld(r), true);
  const explicit = await runFixture('exec-cli.ts', [r.hostDir, 'console', 'start', '--repo', r.repo], { env, timeoutMs: 15000 });
  assert.notEqual(explicit.code, 0, explicit.stderr);
  assert.match(explicit.stderr, cause === 'startup timeout' ? /startup.*timed out/ : /conflicts/);
  const executor = ownerOf(r)!.executor!; await kill(supervisorOf(r)); await kill(executor);
  const resumed = await runFixture('exec-cli.ts', [r.hostDir, 'resume-arc', '--repo', r.repo], { env, timeoutMs: 35000 });
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr); warning(resumed.stderr);
  await idle(r, startLine(resumed).generation!);
  await cli(r, ['stop']); await until(() => !hostLockHeld(r), 15000, 'stop resumed run');
});

test('F1 mutex deadline is console unavailability for arc work and refuses explicit startup', async t => {
  const f = consoleFixture(), held = createServer();
  await new Promise<void>(resolve => held.listen(`\0roadmap-console-${sha256Hex(f.common)}`, resolve));
  t.after(() => { held.close(); });
  const now = Date.now(); let calls = 0;
  t.mock.method(Date, 'now', () => now + calls++ * 21000);
  let warning = ''; t.mock.method(process.stderr, 'write', (text: string) => { warning += text; return true; });
  await assert.rejects(ensureConsole(f.repo, f.hostDir), { name: 'ConsoleUnavailableError' });
  assert.equal(await ensureArcConsole(f.repo, f.hostDir), null);
  assert.match(warning, /mutex.*timed out.*roadmap console stop/);
  assert.equal((warning.match(/WARNING:/g) ?? []).length, 1);
});

test('F1 failed termination is operational, but lease corruption and unexpected child errors still propagate', { timeout: 20000 }, async t => {
  const f = consoleFixture(); t.after(() => stopConsole(f.repo));
  const lease = await ensureConsole(f.repo, f.hostDir);
  const path = join(serviceDir(f.common), 'lease.json');
  writeFileSync(path, JSON.stringify({ ...lease, executorVersion: 'older' }));
  const signals: string[] = [], realKill = process.kill.bind(process), now = Date.now(); let calls = 0;
  const clock = t.mock.method(Date, 'now', () => now + calls++ * 10000);
  const killMock = t.mock.method(process, 'kill', (pid: number, sig: NodeJS.Signals | number) => { if (pid === lease.pid) { signals.push(String(sig)); return true; } return realKill(pid, sig); });
  let warning = ''; const stderr = t.mock.method(process.stderr, 'write', (text: string) => { warning += text; return true; });
  try {
    await assert.rejects(ensureConsole(f.repo, f.hostDir), { name: 'ConsoleUnavailableError' });
    assert.equal(await ensureArcConsole(f.repo, f.hostDir), null);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
    assert.match(warning, /survived SIGKILL.*roadmap console stop/);
  } finally { clock.mock.restore(); killMock.mock.restore(); stderr.mock.restore(); }
  writeFileSync(path, JSON.stringify({ ...lease, url: 'http://wrong.invalid' }));
  try { await assert.rejects(ensureArcConsole(f.repo, f.hostDir), /URL\/binding identity mismatch/); }
  finally { writeFileSync(path, JSON.stringify(lease)); }
  await stopConsole(f.repo);
  const preload = join(tmpDir('console-crash'), 'crash.mjs');
  writeFileSync(preload, "if (process.env.ROADMAP_ROLE === 'console') throw new TypeError('unexpected console defect');\n");
  const old = process.env['NODE_OPTIONS']; process.env['NODE_OPTIONS'] = `--import=${pathToFileURL(preload).href}`;
  try { await assert.rejects(ensureArcConsole(f.repo, f.hostDir), /unexpected console defect/); }
  finally { if (old === undefined) delete process.env['NODE_OPTIONS']; else process.env['NODE_OPTIONS'] = old; }
});
