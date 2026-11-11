import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { Observations } from './helpers/observations.ts';
import { ConsoleError, statusBytes, validateEnvelope } from '../src/observation/protocol.ts';
import { parityArc } from './fixtures/status-parity.ts';

function fixture() {
  const f = parityArc();
  const run = { runDir: f.runDir, arc: arcId(f.d.arc) };
  const cache = new Observations(f.hostDir, 'instance', 'repo');
  return { ...f, run, cache };
}

test('one captured observation supplies exact canonical full and summary transport bytes', () => {
  const { cache, run } = fixture();
  const e = cache.read(run);
  assert.equal(statusBytes(e, false), canonicalJson(e.data.display.status) + '\n');
  assert.equal(statusBytes(e, true), canonicalJson(e.data.summary) + '\n');
  assert.equal(e.data.capture.foldMs, e.data.display.status.host.log.foldMs);
  assert.ok(Number.isFinite(e.data.capture.clock));
  assert.equal(e.highWater, e.data.display.seq);
  assert.equal(validateEnvelope(JSON.parse(JSON.stringify(e)), { instance: e.instance, repoId: e.repoId, arc: e.arc }).revision, e.revision);
  assert.throws(() => validateEnvelope({ ...e, protocol: 'old' }, { instance: e.instance, repoId: e.repoId, arc: e.arc }), /protocol/);
  assert.throws(() => validateEnvelope({ ...e, data: {} }, { instance: e.instance, repoId: e.repoId, arc: e.arc }), /payload/);
});

test('unchanged dependencies reuse expensive captures, heartbeat invalidates only volatile fields, receipts invalidate independently', () => {
  const { cache, run } = fixture();
  const first = cache.read(run);
  const checked = cache.read(run);
  assert.equal(checked.data, first.data);
  assert.equal(checked.revision, first.revision);
  writeFileSync(join(run.runDir, 'heartbeat.json'), JSON.stringify({ v: 2, generation: 1, at: '2026-06-01T00:00:00.000Z' }));
  const next = cache.read(run);
  assert.equal(next.highWater, first.highWater);
  assert.ok(next.revision > first.revision);
  assert.equal(next.data.display.status.run.heartbeatAt, '2026-06-01T00:00:00.000Z');
  assert.equal(next.data.capture.materializations, first.data.capture.materializations);
  const file = join(run.runDir, 'commands', 'receipts', 'cmd-0000000000000001.rejected.json');
  const receipt = JSON.parse(readFileSync(file, 'utf8')); receipt.reason = 'Changed side file';
  writeFileSync(file, JSON.stringify(receipt));
  assert.ok(cache.read(run).data.capture.materializations > next.data.capture.materializations);
  writeFileSync(file, '{}');
  assert.throws(() => cache.read(run));
});

test('partial tails stay read-only, journal replacement resets epoch, corrupt complete lines never publish', () => {
  const { cache, run } = fixture();
  const first = cache.read(run);
  const path = join(run.runDir, 'events.jsonl');
  const original = readFileSync(path);
  appendFileSync(path, '{"incomplete":');
  assert.equal(cache.read(run).highWater, first.highWater);
  assert.equal(readFileSync(path).length, original.length + 14);
  writeFileSync(path, original);
  const reset = cache.read(run);
  assert.notEqual(reset.epoch, first.epoch);
  assert.throws(() => cache.read(run, { epoch: first.epoch }), (e: unknown) => e instanceof ConsoleError && e.code === 'reset');
  assert.throws(() => cache.read(run, { minHighWater: first.highWater + 1 }), /watermark/);
  appendFileSync(path, 'broken\n');
  assert.throws(() => cache.read(run), /corrupt|JSON|Unexpected/);
});


test('owner death and owner-validated scheduler invalidation advance revision without journal changes', async (t) => {
  const { spawn } = await import('node:child_process');
  const { claimHost, releaseHost } = await import('../src/host/lock.ts');
  const { openHostDir } = await import('../src/host/hostdir.ts');
  const { publishOwner } = await import('../src/host/owner.ts');
  const { selfIdentity } = await import('../src/host/liveness.ts');
  const { identityOf } = await import('../src/contain/proc.ts');
  const { absPath } = await import('../src/core/values.ts');
  const { cache, run, hostDir, d } = fixture();
  openHostDir(hostDir);
  const claim = await claimHost(hostDir, { ...run, repo: absPath(d.repo), supervisor: selfIdentity() }, async () => ({ kind: 'reconciled' }));
  assert.equal(claim.kind, 'claimed'); if (claim.kind !== 'claimed') return assert.fail();
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); releaseHost(hostDir, claim.claim); });
  const id = identityOf(child.pid!); publishOwner(hostDir, claim.claim, { pid: id.pid, start: id.start });
  const path = join(run.runDir, 'sched.json');
  writeFileSync(path, JSON.stringify({ v: 2, arc: run.arc, pid: id.pid, tasks: [], queue: [{ unit: 'u1', stage: 'pre-build', attempt: 1, publication: false, request: { named: [], pools: [], cpu: 1, publication: false }, envBlocked: false, pressureBlocked: false, queuedAt: Date.now() }], jobQueue: [], drains: [] }));
  const first = cache.read(run); assert.equal(first.data.display.status.run.owner.state, 'alive');
  assert.equal(first.data.display.status.host.queue.length, 1);
  const ended = new Promise<void>((r) => child.once('exit', () => r())); child.kill('SIGKILL'); await ended;
  const next = cache.read(run);
  assert.equal(next.highWater, first.highWater); assert.ok(next.revision > first.revision);
  assert.equal(next.data.display.status.run.owner.state, 'dead');
  assert.deepEqual(next.data.display.status.host.queue, []);
});


test('the maintained set is the selected arc plus the two most recent; a released arc returns with a new epoch', { timeout: 60_000 }, async (t) => {
  const { serveConsole } = await import('../src/console/http.ts');
  const { consoleFixture } = await import('./fixtures/console.ts');
  const { mkdirSync } = await import('node:fs');
  const f = consoleFixture();
  // Three more retained arcs of the same repository, each started after the fixture's, so the fixture's arc stays selected.
  const others = [1, 2, 3].map((n) => {
    const arc = `${f.arc}-other${n}`, runDir = join(f.common, 'roadmap-runtime', arc);
    mkdirSync(runDir, { recursive: true });
    const start = JSON.parse(readFileSync(join(f.runDir, 'start.json'), 'utf8'));
    writeFileSync(join(runDir, 'start.json'), JSON.stringify({ ...start, at: new Date(Date.parse(start.at) - n * 60_000).toISOString() }));
    writeFileSync(join(runDir, 'events.jsonl'), '');
    return arc;
  });
  const s = await serveConsole({ ...f, host: '127.0.0.1', port: 0 }); t.after(() => s.close());
  const { CONSOLE_PROTOCOL } = await import('../src/observation/protocol.ts');
  const status = async (arc: string) => { const r = await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${arc}/status`); return { code: r.status, body: await r.json() as { epoch: string } }; };
  const selected = await status(f.arc); assert.equal(selected.code, 200);
  const first = await status(others[0]!); assert.equal(first.code, 200, JSON.stringify(first.body));
  await status(others[1]!);
  assert.ok(s.stats(f.arc) && s.stats(others[0]!) && s.stats(others[1]!), 'the selected arc and two read arcs are kept current');
  await status(others[2]!);
  assert.ok(s.stats(others[2]!), 'the most recently read arc is kept current');
  assert.equal(s.stats(others[0]!), null, 'the least recently read is released: its collector stops');
  assert.ok(s.stats(f.arc), 'the selected arc is always kept current');
  const again = await status(others[0]!); assert.equal(again.code, 200);
  assert.notEqual(again.body.epoch, first.body.epoch, 'a released arc returns with a new epoch');
});
