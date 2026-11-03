// Real CLI processes: lease exclusion/replacement/stop, liveness projections and missed-wake recovery.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { identityOf,readBootId } from '../src/contain/proc.ts';
import { atomicJson,exclusivePublish } from '../src/core/fsx.ts';
import { arcId,commandId,jobId,needsUserId,planRev,sha256 } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { type NeedsUserContent,watchLease } from '../src/core/records.ts';
import { absPath,isoTimeOf } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { HOST_LOCK,hostPath,openHostDir } from '../src/host/hostdir.ts';
import { isAlive,selfIdentity } from '../src/host/liveness.ts';
import { needsUserAckPath,needsUserPath,raiseNeedsUser } from '../src/needsuser.ts';
import { EXIT_WATCH_BUSY,readWatchLease,releaseWatch,WATCH_LEASE_FILE } from '../src/watch-lease.ts';
import { claimRecord } from './fixtures/host-records.ts';
import { fixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';

type Line = Record<string, unknown>;
async function until(pred: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() >= end) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
function setup(t: TestContext) {
  const runDir = absPath(tmpDir('supervision-run'));
  const hostDir = openHostDir(absPath(join(tmpDir('supervision-host'), 'roadmap')));
  const arc = arcId('supervision');
  const journal = openJournal(runDir, arc);
  t.after(() => journal.close());
  atomicJson(hostPath(hostDir, HOST_LOCK), { ...claimRecord({ supervisor: selfIdentity(), bootId: readBootId(), arc }), runDir });
  function cli(...args: string[]) {
    const child = spawn(process.execPath, [fixture('exec-cli.ts'), hostDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
    return { child, done, lines: (): Line[] => stdout.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s) as Line), stderr: () => stderr };
  }
  async function ready(p: ReturnType<typeof cli>) {
    await until(() => {
      assert.equal(p.child.exitCode, null, p.stderr());
      return readWatchLease(runDir)?.pid === p.child.pid && p.lines().length > 0;
    }, 'watch lease and first poll');
    return readWatchLease(runDir)!;
  }
  return { runDir, hostDir, arc, journal, cli, ready };
}

test('watch lease: none/live/stale in full and summary status; busy refusal, poll renewal, dead takeover, stop and idempotence; raw stream has no lease', { timeout: 30_000 }, async (t) => {
  const r = setup(t);
  const status = async (summary: boolean) => {
    const p = r.cli('status', ...(summary ? ['--summary'] : []));
    assert.equal(await p.done, 0, p.stderr());
    return p.lines()[0]!['supervision'];
  };
  for (const summary of [false, true]) assert.deepEqual(await status(summary), { state: 'none' });
  const raw = r.cli('watch');
  await until(() => raw.lines().length > 0, 'raw stream');
  assert.equal(readWatchLease(r.runDir), null);
  const first = r.cli('watch', '--actionable');
  const lease = await r.ready(first);
  for (const line of first.lines()) assert.deepEqual(line['openBlocking'], []);
  assert.deepEqual(watchLease(JSON.parse(readFileSync(join(r.runDir, WATCH_LEASE_FILE), 'utf8')), 'lease'), lease);
  assert.equal(lease.arc, r.arc);
  assert.equal(lease.executorVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  await until(() => readWatchLease(r.runDir)!.lastPollAt > lease.lastPollAt, 'lease renewal');
  const renewed = readWatchLease(r.runDir)!;
  assert.deepEqual({ ...renewed, lastPollAt: lease.lastPollAt, lastSeq: lease.lastSeq }, lease, 'only poll time and cursor change');
  assert.equal(renewed.lastSeq, r.journal.view.highWater());
  for (const summary of [false, true]) {
    const s = await status(summary) as Line;
    assert.equal(s['state'], 'live'); assert.equal(s['pid'], first.child.pid); assert.equal(s['executorVersion'], lease.executorVersion);
    assert.ok(Date.parse(s['lastPollAt'] as string) >= Date.parse(lease.lastPollAt));
  }
  const second = r.cli('watch', '--actionable');
  assert.equal(await second.done, EXIT_WATCH_BUSY, second.stderr());
  const busy = second.lines();
  assert.equal(busy.length, 1);
  assert.deepEqual({ ...busy[0], lastPollAt: lease.lastPollAt, lastSeq: lease.lastSeq }, { event: 'watch-busy', ...lease });
  first.child.kill('SIGKILL'); await first.done;
  for (const summary of [false, true]) {
    const s = await status(summary) as Line;
    assert.equal(s['state'], 'stale'); assert.equal(s['pid'], lease.pid);
  }
  const takeover = r.cli('watch', '--actionable');
  const next = await r.ready(takeover);
  assert.ok(isAlive(next, next.bootId));
  releaseWatch(r.runDir, lease);
  assert.equal(readWatchLease(r.runDir)!.pid, next.pid, 'an old identity cannot release the new lease');
  const stop = r.cli('watch', '--stop');
  assert.equal(await stop.done, 0, stop.stderr());
  assert.equal(await takeover.done, 0, takeover.stderr());
  assert.deepEqual(stop.lines(), [{ event: 'watch-stopped', state: 'stopped', pid: next.pid }]);
  assert.equal(readWatchLease(r.runDir), null);
  const again = r.cli('watch', '--stop');
  assert.equal(await again.done, 0, again.stderr());
  assert.deepEqual(again.lines(), [{ event: 'watch-stopped', state: 'none' }]);
  assert.equal(raw.child.exitCode, null, 'stopping actionable supervision leaves raw streams running');
});

test('watch --replace terminates a live watcher of any executor version, takes over and cleans up on SIGINT', { timeout: 30_000 }, async (t) => {
  const r = setup(t);
  const first = r.cli('watch', '--actionable');
  const old = await r.ready(first);
  // The record, not the executable path or argv pattern, is authoritative across plugin versions.
  atomicJson(join(r.runDir, WATCH_LEASE_FILE), { ...old, executorVersion: '1.0.0-dev.37' });
  const replacement = r.cli('watch', '--actionable', '--replace');
  const next = await r.ready(replacement);
  assert.equal(await first.done, 0, first.stderr());
  assert.equal(isAlive(old, old.bootId), false);
  assert.notEqual(next.pid, old.pid);
  assert.equal(next.executorVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  replacement.child.kill('SIGINT');
  assert.equal(await replacement.done, 0, replacement.stderr());
  assert.equal(existsSync(join(r.runDir, WATCH_LEASE_FILE)), false);
});

test('simultaneous actionable starts have one live lease holder', { timeout: 30_000 }, async (t) => {
  const r = setup(t);
  const starts = [r.cli('watch', '--actionable'), r.cli('watch', '--actionable'), r.cli('watch', '--actionable')];
  await until(() => starts.every((p) => p.lines().length > 0), 'all start outcomes');
  const busy = starts.filter((p) => p.lines()[0]!['event'] === 'watch-busy');
  assert.equal(busy.length, 2);
  for (const p of busy) assert.equal(await p.done, EXIT_WATCH_BUSY, p.stderr());
  const winner = starts.find((p) => !busy.includes(p))!;
  assert.equal(readWatchLease(r.runDir)!.pid, winner.child.pid);
});

test('actionable digest on every transition and the real one-minute heartbeat: sorted, excludes notes, drops acked and superseded items, retains missed blocking items', { timeout: 75_000 }, async (t) => {
  const r = setup(t);
  const raise = (reason: NeedsUserContent['reason'], blocking: boolean, parent: Parameters<typeof raiseNeedsUser>[3] = { type: 'arc' }) =>
    raiseNeedsUser(r.journal, r.runDir, { blocking, reason, subject: { type: 'arc' }, summary: reason, recommendation: 'read evidence', options: [], evidence: [] }, parent);
  const review = (n: number) => {
    const job = jobId('review', n);
    r.journal.fact({ kind: 'pack-review-started', job, planRev: planRev(1), inputsSha256: sha256('a'.repeat(64)), key: sha256('b'.repeat(64)) });
    r.journal.fact({ kind: 'pack-review-ended', job, outcome: 'completed', findings: [], dispositions: [] });
    return job;
  };
  const old = raise('pack-review', true, { type: 'job', job: review(1) });
  const acked = raise('usage-limit', true);
  const standing = raise('owner-request', true);
  raise('revision-notice', false);
  const host = needsUserId('host-base-1');
  exclusivePublish(needsUserPath(r.runDir, host), JSON.stringify({ v: SCHEMA_VERSION, id: host, arc: r.arc, raisedAt: isoTimeOf(new Date()), blocking: true, reason: 'base-red', subject: { type: 'host' }, summary: 'baseline fault', recommendation: 'read', options: [], evidence: [] }));
  const p = r.cli('watch', '--actionable', '--heartbeat-min', '1');
  await r.ready(p);
  await until(() => p.lines().some((l) => l['id'] === standing), 'initial digest');
  const initial = [{ id: host, reason: 'base-red' }, { id: old, reason: 'pack-review' }, { id: acked, reason: 'usage-limit' }, { id: standing, reason: 'owner-request' }].sort((a, b) => a.id.localeCompare(b.id));
  for (const l of p.lines()) assert.deepEqual(l['openBlocking'], initial);
  const command = commandId('cmd-0000000000000038');
  exclusivePublish(needsUserAckPath(r.runDir, acked), JSON.stringify({ v: SCHEMA_VERSION, id: acked, command, choice: null, at: isoTimeOf(new Date()) }));
  // No ack of old: only the later review supersedes it.
  review(2);
  const marker = raise('revision-notice', false);
  const expected = [{ id: host, reason: 'base-red' }, { id: standing, reason: 'owner-request' }].sort((a, b) => a.id.localeCompare(b.id));
  await until(() => p.lines().some((l) => l['id'] === marker), 'transition after ack and supersession');
  assert.deepEqual(p.lines().find((l) => l['id'] === marker)!['openBlocking'], expected);
  r.journal.fact({ kind: 'needs-user-acked', id: acked, command, choice: null });
  // This log-only change produces no transition. The heartbeat must still carry the latest poll's seq.
  await until(() => p.lines().some((l) => l['event'] === 'heartbeat'), 'one-minute heartbeat', 65_000);
  const heartbeat = p.lines().find((l) => l['event'] === 'heartbeat')!;
  assert.deepEqual(heartbeat, { event: 'heartbeat', everyMin: 1, seq: r.journal.view.highWater(), openBlocking: expected });
  const lastLease = readWatchLease(r.runDir)!;
  assert.equal(lastLease.lastSeq, heartbeat['seq']);
  const s = r.cli('status', '--summary'); assert.equal(await s.done, 0, s.stderr());
  const items = s.lines()[0]!['needsUser'] as Array<{ id: string; reason: string; blocking: boolean }>;
  assert.deepEqual(items.filter((n) => n.blocking).map(({ id, reason }) => ({ id, reason })), expected, 'status and digest use one open-item function');
  for (const id of [standing, host]) exclusivePublish(needsUserAckPath(r.runDir, id), JSON.stringify({ v: SCHEMA_VERSION, id, command, choice: null, at: isoTimeOf(new Date()) }));
  const cleared = raise('revision-notice', false);
  await until(() => p.lines().some((l) => l['id'] === cleared), 'empty digest after acknowledgement');
  assert.deepEqual(p.lines().find((l) => l['id'] === cleared)!['openBlocking'], []);
});


test('watch --replace escalates a TERM-resistant previous-version holder to SIGKILL; stop clears a stale lease', { timeout: 20_000 }, async (t) => {
  const r = setup(t);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise<void>((resolve) => holder.once('close', () => resolve()));
  t.after(async () => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); await ended; });
  await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
  const at = isoTimeOf(new Date());
  const old = { v: SCHEMA_VERSION, ...identityOf(holder.pid!), bootId: readBootId(), executorVersion: '1.0.0-dev.37', arc: r.arc, startedAt: at, lastPollAt: at, lastSeq: 0 };
  const { sid: _sid, ...lease } = old;
  atomicJson(join(r.runDir, WATCH_LEASE_FILE), lease);
  const replacement = r.cli('watch', '--actionable', '--replace');
  await until(() => readWatchLease(r.runDir)?.pid === replacement.child.pid && replacement.lines().length > 0, 'replacement after SIGKILL', 15_000);
  await ended;
  assert.equal(holder.signalCode, 'SIGKILL');
  assert.equal(isAlive(lease, lease.bootId), false);
  replacement.child.kill('SIGKILL'); await replacement.done;
  const stop = r.cli('watch', '--stop');
  assert.equal(await stop.done, 0, stop.stderr());
  assert.deepEqual(stop.lines(), [{ event: 'watch-stopped', state: 'stale', pid: replacement.child.pid }]);
  assert.equal(readWatchLease(r.runDir), null);
});
