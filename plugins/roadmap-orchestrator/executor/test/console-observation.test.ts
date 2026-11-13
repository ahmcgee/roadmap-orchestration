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
  // dev.75: a check is not an observation. The heartbeat reaches the status route, which applies the last check (T3).
  assert.equal(next.revision, first.revision);
  assert.equal(next.data, first.data);
  assert.equal((cache.arc(run).model.status(next, false) as typeof next.data.display.status).run.heartbeatAt, '2026-06-01T00:00:00.000Z');
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

test('an arc with open invocations is captured once while nothing changes', async (t) => {
  const { investigationFixture } = await import('./fixtures/console-investigations.ts');
  const f = await investigationFixture(); t.after(() => f.close());
  const arc = new Observations(f.hostDir, 'open-set', 'repo').arc(f);
  const first = arc.read();
  assert.ok(first.data.display.invocations.some((i) => i.endedAt === null), 'the fixture has open invocations');
  for (let n = 0; n < 3; n++) arc.read();
  assert.equal(arc.messages.filter((m) => m.kind === 'observation').length, 1, 'learning the open set after the cold capture is not a change');
});

test('T9: with the shadow derivation on every capture, a scripted run publishes every capture: spawns, lanes, an apply, a ref move, a receipt, a needs-user item', { timeout: 120_000 }, async (t) => {
  const { investigationFixture } = await import('./fixtures/console-investigations.ts');
  const { writeReceipt } = await import('../src/commands/queue.ts');
  const { commitRevisionNow, keptPayload } = await import('../src/input/inforce.ts');
  const { raiseNeedsUser } = await import('../src/needsuser.ts');
  const { commandId, planRev, unitId } = await import('../src/core/ids.ts');
  const { isoTimeOf } = await import('../src/core/values.ts');
  const { SCHEMA_VERSION } = await import('../src/core/version.ts');
  const { commitAll, git, writeFiles } = await import('./helpers/repo.ts');
  const f = await investigationFixture(); t.after(() => f.close());
  const arc = new Observations(f.hostDir, 'shadow', 'repo').arc(f), j = f.journal;
  const step = (label: string): void => {
    const before = arc.messages.length;
    arc.read();
    const kinds = arc.messages.slice(before).map((m) => m.kind === 'failed' ? `failed: ${m.error.message}` : m.kind);
    assert.ok(kinds.includes('observation') && !kinds.some((k) => k.startsWith('failed')), `${label}: ${kinds.join(', ')}`);
  };
  step('the first capture');
  const build = f.begin('u9', 'build'), run = f.invocation(build, true); step('a spawn starts');
  run.finish({ summary: 'Built.' }); f.outcome(build, 'success'); step('the spawn ends');
  const lanes = f.begin('u9', 'lanes'), check = f.invocation(lanes, false); step('a lane starts');
  check.finish(); f.outcome(lanes, 'green'); step('the lanes pass');
  const previous = keptPayload(f.runDir, j.view.planApplied()!.payloadSha256);
  commitRevisionNow(j, f.runDir, { ...previous, source: { type: 'command', command: commandId('cmd-00000000000000d1') }, base: planRev(previous.rev),
    rev: planRev(previous.rev + 1), changes: [], dispositions: [], divergences: [], publication: null }, { type: 'arc' });
  step('an apply');
  writeFiles(f.d.repo, { 'src/shadow.js': 'export const shadow = 1;\n' }); commitAll(f.d.repo, 'move the integration head');
  step('a ref move');
  git(f.d.repo, 'update-ref', `refs/heads/roadmap/${f.d.arc}/u9`, git(f.d.repo, 'rev-parse', 'main').trim()); step('a unit branch moves');
  writeReceipt(f.runDir, { v: SCHEMA_VERSION, command: commandId('cmd-00000000000000d2'), state: 'rejected', at: isoTimeOf(new Date()), reason: 'Rejected d2' });
  step('a receipt');
  raiseNeedsUser(j, f.runDir, { reason: 'owner-request', blocking: true, subject: { type: 'unit', unit: unitId('u9') }, summary: 'Check the shadow', recommendation: 'Look.', options: [], evidence: [] }, { type: 'arc' });
  step('a needs-user item');
  f.finishLive(); step('the live build ends');
});

test('T10: a cell whose key misses an input fails the capture with the diverging path, and the failure stands', { timeout: 60_000 }, async (t) => {
  const { RecordMemo } = await import('../src/observation/memo.ts');
  const { writeReceipt } = await import('../src/commands/queue.ts');
  const { commandId } = await import('../src/core/ids.ts');
  const { isoTimeOf } = await import('../src/core/values.ts');
  const { SCHEMA_VERSION } = await import('../src/core/version.ts');
  const { cache, run } = fixture();
  // The receipts cell given a key that names none of its inputs, in this test only.
  const cell = RecordMemo.prototype.cell;
  RecordMemo.prototype.cell = function <T>(this: InstanceType<typeof RecordMemo>, name: Parameters<typeof cell>[0], key: string, compute: () => T): T {
    return cell.call(this, name, name === 'receipts' ? 'incomplete' : key, compute) as T;
  };
  t.after(() => { RecordMemo.prototype.cell = cell; });
  const arc = cache.arc(run);
  arc.read();
  writeReceipt(run.runDir, { v: SCHEMA_VERSION, command: commandId('cmd-00000000000000e1'), state: 'rejected', at: isoTimeOf(new Date()), reason: 'Rejected e1' });
  const before = arc.messages.length;
  assert.throws(() => arc.read(), (e: unknown) => e instanceof ConsoleError && e.code === 'corruption' && /console derivation diverged at `status\.commands\.receipts\.\d+/.test(e.message));
  const published = arc.messages.slice(before);
  assert.ok(!published.some((m) => m.kind === 'observation'), 'the diverging capture is not published');
  assert.ok(published.some((m) => m.kind === 'log' && /diverged/.test(m.message)), 'the divergence reaches the log');
  assert.throws(() => arc.read(), (e: unknown) => e instanceof ConsoleError && e.code === 'corruption', 'every later read answers it');
});

test('the idle shadow derivation checks the published capture once the collector has been idle a minute, once per capture', { timeout: 60_000 }, async (t) => {
  const { RecordMemo } = await import('../src/observation/memo.ts');
  const { ArcCollector, COLLECT } = await import('../src/observation/collect.ts');
  const { commonDirOfRun } = await import('../src/answers.ts');
  const { writeReceipt } = await import('../src/commands/queue.ts');
  const { commandId } = await import('../src/core/ids.ts');
  const { absPath, isoTimeOf } = await import('../src/core/values.ts');
  const { SCHEMA_VERSION } = await import('../src/core/version.ts');
  const { run, hostDir } = fixture();
  const messages: { kind: string; error?: { code: string; message: string } }[] = [];
  const r = { runDir: absPath(run.runDir), arc: run.arc, at: '' };
  const c = new ArcCollector(r, absPath(hostDir), absPath(commonDirOfRun(r.runDir)), (m) => messages.push(m), { shadow: 'idle' });
  const cell = RecordMemo.prototype.cell;
  RecordMemo.prototype.cell = function <T>(this: InstanceType<typeof RecordMemo>, name: Parameters<typeof cell>[0], key: string, compute: () => T): T {
    return cell.call(this, name, name === 'receipts' ? 'incomplete' : key, compute) as T;
  };
  t.after(() => { RecordMemo.prototype.cell = cell; });
  const t0 = Date.now();
  c.step(t0);
  writeReceipt(r.runDir, { v: SCHEMA_VERSION, command: commandId('cmd-00000000000000f1'), state: 'rejected', at: isoTimeOf(new Date()), reason: 'Rejected f1' });
  c.step(t0 + 1_000);
  assert.equal(messages.filter((m) => m.kind === 'observation').length, 2, 'the stale capture is published: no shadow while busy');
  c.step(t0 + 1_000 + COLLECT.shadowIdleMs - 1);
  assert.ok(!messages.some((m) => m.kind === 'failed'), 'not yet idle a minute: no shadow derivation');
  c.step(t0 + 1_000 + COLLECT.shadowIdleMs);
  const failed = messages.filter((m) => m.kind === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.error!.code, 'corruption');
  assert.match(failed[0]!.error!.message, /console derivation diverged at `status\.commands\.receipts\./);
  c.step(t0 + 2_000 + COLLECT.shadowIdleMs);
  assert.equal(messages.filter((m) => m.kind === 'failed').length, 2, 'the divergence stands');
});

test('an idle collector whose cells agree runs the shadow derivation once per published capture', { timeout: 60_000 }, async () => {
  const { ArcCollector, COLLECT } = await import('../src/observation/collect.ts');
  const { commonDirOfRun } = await import('../src/answers.ts');
  const { absPath } = await import('../src/core/values.ts');
  const { run, hostDir } = fixture();
  const messages: { kind: string }[] = [];
  const r = { runDir: absPath(run.runDir), arc: run.arc, at: '' };
  const c = new ArcCollector(r, absPath(hostDir), absPath(commonDirOfRun(r.runDir)), (m) => messages.push(m), { shadow: 'idle' });
  const t0 = Date.now();
  c.step(t0);
  const at = (ms: number) => { const n = messages.length; c.step(t0 + ms); return messages.slice(n).map((m) => m.kind).filter((k) => k !== 'progress'); };
  assert.deepEqual(at(COLLECT.shadowIdleMs), ['checked'], 'the shadow agrees: the step is a check');
  assert.deepEqual(at(COLLECT.shadowIdleMs + COLLECT.shadowEveryMs), ['checked'], 'and is not repeated on the same capture');
});
