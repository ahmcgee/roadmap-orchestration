// `roadmap watch` (src/watch.ts): needs-user items, acknowledgements, owner liveness and the parallel view as JSON lines.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { identityOf, readBootId } from '../src/contain/proc.ts';
import { atomicJson, canonicalJson, exclusiveCreate } from '../src/core/fsx.ts';
import { arcId, commandId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath, isoTimeOf } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { HOST_LOCK, hostPath, openHostDir } from '../src/host/hostdir.ts';
import { publishOwner } from '../src/host/owner.ts';
import { needsUserAckPath, raiseNeedsUser } from '../src/needsuser.ts';
import { WATCH_POLL_MS, watch } from '../src/watch.ts';
import { tmpDir } from './helpers/repo.ts';
import { claimRecord } from './fixtures/host-records.ts';

type Line = Record<string, unknown>;

/** Waits until `pred` holds for some emitted line, at most `ms`. */
async function until(lines: readonly Line[], pred: (l: Line) => boolean, ms: number, what: string): Promise<Line> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = lines.find(pred);
    if (hit !== undefined) return hit;
    if (Date.now() > end) assert.fail(`${what} did not appear within ${ms} ms; lines: ${JSON.stringify(lines)}`);
    await sleep(25);
  }
}

test('watch.emits-needs-user: a raised needs-user and its ack appear within 2 s; so does the owner\'s death', { timeout: 30_000 }, async () => {
  const runDir = absPath(tmpDir('watch-run'));
  const hostDir = openHostDir(absPath(join(tmpDir('watch-host'), 'roadmap')));
  const arc = arcId(`w-${randomBytes(5).toString('hex')}`);

  // This run owns the host; its executor is a live process we can kill.
  const executor = spawn('sleep', ['300'], { stdio: 'ignore' });
  assert.ok(executor.pid !== undefined);
  const { pid, start } = identityOf(executor.pid);
  const exited = new Promise((resolve) => executor.once('exit', resolve));
  const claim = { ...claimRecord({ supervisor: { pid: process.pid, start: identityOf(process.pid).start }, bootId: readBootId(), arc }), runDir };
  atomicJson(hostPath(hostDir, HOST_LOCK), claim);
  publishOwner(hostDir, claim, { pid, start });

  const lines: Line[] = [];
  const stop = new AbortController();
  const watching = watch(runDir, arc, hostDir, (l) => lines.push(JSON.parse(l) as Line), stop.signal);
  try {
    await until(lines, (l) => l['event'] === 'owner' && l['state'] === 'alive', 2_000, 'owner alive');

    const journal = openJournal(runDir, arc);
    const id = raiseNeedsUser(journal, runDir, {
      blocking: true, subject: { type: 'arc' }, reason: 'usage-limit', summary: 'codex is parked', recommendation: 'resume --backend codex', options: [], evidence: [],
    }, { type: 'arc' });
    journal.close();
    const raisedAt = Date.now();
    const raised = await until(lines, (l) => l['event'] === 'needs-user', 2_000, 'the raised needs-user');
    assert.ok(Date.now() - raisedAt < 2_000);
    assert.deepEqual(raised, { event: 'needs-user', id, blocking: true, reason: 'usage-limit', subject: { type: 'arc' }, summary: 'codex is parked' });

    const command = commandId('cmd-00000000000000aa');
    exclusiveCreate(needsUserAckPath(runDir, id), canonicalJson({ v: SCHEMA_VERSION, id, command, choice: null, at: isoTimeOf(new Date()) }));
    assert.deepEqual(await until(lines, (l) => l['event'] === 'ack', 2_000, 'the ack'), { event: 'ack', id, command, choice: null });

    executor.kill('SIGKILL');
    await exited;
    const diedAt = Date.now();
    assert.deepEqual(await until(lines, (l) => l['event'] === 'owner' && l['state'] === 'dead', 2_000, 'owner dead'), { event: 'owner', state: 'dead', generation: claim.generation, pid });
    assert.ok(Date.now() - diedAt < 2_000);
    // Each item once, the owner once per change.
    const others = lines.filter((l) => l['event'] !== 'units');
    assert.deepEqual(others.map((l) => `${l['event']}${l['state'] === undefined ? '' : ` ${l['state']}`}`), ['owner alive', 'needs-user', 'ack', 'owner dead']);
    // The parallel view once per change: no plan yet, so no units; the open item parks the run, the dead owner leaves it ownerless.
    const views = lines.filter((l) => l['event'] === 'units');
    assert.deepEqual(views.map((l) => l['run']), ['running', 'parked', 'no-owner']);
    assert.ok(views.every((l) => JSON.stringify(l['units']) === '{}'));
  } finally {
    stop.abort();
    await watching;
    if (executor.exitCode === null && executor.signalCode === null) executor.kill('SIGKILL');
  }
});

test('watch.m3-kinds: the holistic layer\'s items wake the watcher as any needs-user does: an owner request, a divergence digest, both convergence brakes, an owed audit, the finding items and M4a\'s pack-review and issue-policy-untrusted, each once with its reason and blocking flag', { timeout: 30_000 }, async () => {
  const runDir = absPath(tmpDir('watch-m3-run'));
  const hostDir = openHostDir(absPath(join(tmpDir('watch-m3-host'), 'roadmap')));
  const arc = arcId(`w-${randomBytes(5).toString('hex')}`);
  const kinds = [
    ['owner-request', true], ['divergence-digest', false], ['convergence-bound', false], ['convergence-identity', false], ['audit-owed', false],
    ['finding-p1-escalated', true], ['new-finding-draining', true], ['pack-review', true], ['issue-policy-untrusted', true],
  ] as const;
  const lines: Line[] = [];
  const stop = new AbortController();
  const watching = watch(runDir, arc, hostDir, (l) => lines.push(JSON.parse(l) as Line), stop.signal);
  try {
    const journal = openJournal(runDir, arc);
    const ids = kinds.map(([reason, blocking]) => raiseNeedsUser(journal, runDir, {
      blocking, subject: { type: 'arc' }, reason, summary: reason, recommendation: 'look', options: [], evidence: [],
    }, { type: 'arc' }));
    journal.close();
    for (const [i, [reason, blocking]] of kinds.entries()) {
      assert.deepEqual(await until(lines, (l) => l['event'] === 'needs-user' && l['id'] === ids[i], 2_000, reason), {
        event: 'needs-user', id: ids[i], blocking, reason, subject: { type: 'arc' }, summary: reason,
      });
    }
    await sleep(3 * WATCH_POLL_MS);
    assert.equal(lines.filter((l) => l['event'] === 'needs-user').length, kinds.length, 'each item once');
  } finally {
    stop.abort();
    await watching;
  }
});
