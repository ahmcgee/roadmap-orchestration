// Reattaching to live or orphaned invocations after the executor died: adoption of a live runner, a
// certified result with a live descendant (R13), and an orphaned workload whose runner is dead (R15).
import assert from 'node:assert/strict';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { isAlive, signal } from '../src/contain/proc.ts';
import { invocationEnv, sessionContainment } from '../src/contain/session.ts';
import type { DoneOf, Event } from '../src/core/events.ts';
import { type InvocationId, arcId, invocationId, opId } from '../src/core/ids.ts';
import type { ProcIdentity } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { assertGone, identityFromFile, waitFor, workload } from './helpers/invocation.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Scenario, type Step, readCalls } from './helpers/scenario.ts';
import {
  type Purpose, PURPOSES, type Run, type SpecDescriptor, backend, command, dones, events, intents, invocationDirs, openIntents,
  recover, run, runChild, scenario, startChild, usageFacts,
} from './fixtures/invoke-specs.ts';

const T = { timeout: 30_000 };
const OK = { ok: true } as const;

const spawnDones = (runDir: string): readonly DoneOf<'proc.spawn'>[] => dones(runDir, 'proc.spawn') as readonly DoneOf<'proc.spawn'>[];
const firstInv = (r: Run): InvocationId => invocationId(opId(arcId(r.arc), 1), 1);
const files = (r: Run) => runnerFiles(invocationDir(absPath(r.runDir), firstInv(r)), firstInv(r));

async function killExecutor(child: ChildProcess): Promise<void> {
  child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
}

test('recover.live-adopted', T, async () => {
  const r = run();
  const s = scenario([{ as: 'claude', expect: {}, acts: [{ type: 'barrier', name: 'mid', timeoutMs: 20_000 }, { type: 'emit', value: OK }] }]);
  const executor = startChild(backend(r, s));
  await reached(s.dir, 'mid', 10_000);
  await killExecutor(executor);
  const runner = files(r).read('runner.json');
  assert.ok(runner !== null && isAlive(runner.runner), 'the runner outlives the executor');

  // recover() decides before its first await, so the runner is still parked at the barrier when it adopts.
  const recovering = recover(r.runDir, r.arc);
  release(s.dir, 'mid');
  const recovered = await recovering;

  assert.deepEqual(recovered.map((x) => x.disposition), [{ kind: 'adopt' }]);
  assert.deepEqual(spawnDones(r.runDir).map((x) => x.recoveredBy), ['adopted']);
  const done = spawnDones(r.runDir)[0]?.outcome;
  assert.deepEqual(done?.kind === 'result' ? done.summary : done, { type: 'backend', outcome: 'success' });
  assert.equal(isAlive(runner.runner), false);
  assert.equal(files(r).read('exit.json')?.cause, 'exited');
  assert.equal(files(r).read('result.json')?.type, 'backend');
  assert.deepEqual(invocationDirs(r.runDir), ['1-1'], 'exactly one invocation, so one result.json');
  assert.deepEqual(usageFacts(r.runDir).map((f) => f.kind), ['meter']);
  assert.equal(readCalls(s.path).length, 1);
  assert.deepEqual(openIntents(r.runDir, r.arc), []);
});

// A descendant that outlives quiescence (the runner saw the workload empty; this one appeared after, as a
// racing fork would) must be killed before the result is certified. It is made by the fake's
// forkSetsid{keepEnv}: a new session, but the invocation's ROADMAP_INV kept, so it is a member.
const LATE: Step = { as: 'claude', expect: {}, acts: [{ type: 'forkSetsid', env: 'keepEnv', lifeMs: 60_000, pidFile: 'late.pid' }] };

function lateDescendant(s: Scenario, inv: InvocationId, cwd: string): ProcIdentity {
  const r = spawnSync(join(s.binDir, 'claude'), [], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', ...invocationEnv(inv, 'workload') },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return identityFromFile(join(cwd, 'late.pid'));
}

function descriptor(r: Run, purpose: Purpose, s: Scenario): SpecDescriptor {
  return purpose === 'backend' ? backend(r, s) : command(r, purpose, workload('workload-exit.ts', '0'));
}

for (const purpose of PURPOSES) {
  test(`recover.result-with-live-descendant.${purpose}`, T, async () => {
    const r = run();
    const s = scenario(purpose === 'backend' ? [{ as: 'claude', expect: {}, acts: [{ type: 'emit', value: OK }] }, LATE] : [LATE]);
    const trigger = writeTrigger(tmpDir('trigger'), { label: 'spawn.after-result', occurrence: 1 });
    const exit = await runChild('invoke', descriptor(r, purpose, s), trigger);
    assert.equal(exit.signal, 'SIGKILL', exit.stderr);
    assertFired(trigger);
    const inv = firstInv(r);
    const result = readFileSync(join(files(r).invDir, 'result.json'));
    const late = lateDescendant(s, inv, r.work);
    assert.equal(isAlive(late), true);
    assert.equal(sessionContainment.empty({ inv, child: null }), false, 'a valid result.json with a live member');

    const recovered = await recover(r.runDir, r.arc);
    assert.deepEqual(recovered.map((x) => x.disposition.kind), ['done']);
    assertGone([late]);
    // The kill is its own op, closed before the spawn is certified.
    const [kill] = intents(r.runDir, 'proc.kill');
    assert.ok(kill !== undefined && kill.kind === 'proc.kill');
    assert.deepEqual(kill.expect, { inv, scope: 'op', reason: 'recovery' });
    assert.deepEqual(kill.parent, { type: 'op', op: opId(arcId(r.arc), 1) });
    const log = events(r.runDir);
    const seqOf = (pred: (e: Event) => boolean): number => log.find(pred)?.seq ?? -1;
    const killDone = seqOf((e) => e.type === 'done' && e.op === kill.op);
    const spawnDone = seqOf((e) => e.type === 'done' && e.kind === 'proc.spawn');
    assert.ok(killDone > 0 && killDone < spawnDone, `kill done ${killDone} before spawn done ${spawnDone}`);
    assert.deepEqual(spawnDones(r.runDir).map((x) => x.recoveredBy), ['reconciled']);
    assert.deepEqual(readFileSync(join(files(r).invDir, 'result.json')), result, 'the certified result is the one written before the crash');
    assert.deepEqual(invocationDirs(r.runDir), ['1-1']);
    assert.equal(usageFacts(r.runDir).length, purpose === 'backend' ? 1 : 0);
  });
}

test('recover.orphan-lost', T, async () => {
  const r = run();
  const s = scenario([{ as: 'claude', expect: {}, acts: [{ type: 'dirty', files: { 'effect.txt': 'written\n' } }, { type: 'barrier', name: 'hold', timeoutMs: 25_000 }] }]);
  const executor = startChild(backend(r, s));
  await reached(s.dir, 'hold', 10_000);
  await killExecutor(executor);
  const runner = await waitFor('runner.json with a child', 5_000, () => {
    const f = files(r).read('runner.json');
    return f?.child == null ? null : { runner: f.runner, child: f.child };
  });
  signal(runner.runner, 'SIGKILL');
  await waitFor('the runner to die', 5_000, () => (isAlive(runner.runner) ? null : true));
  assert.equal(isAlive(runner.child), true, 'the workload is an orphan');

  const recovered = await recover(r.runDir, r.arc);
  assert.deepEqual(recovered.map((x) => x.disposition), [{ kind: 'lost', treeEffects: true }]);
  assertGone([runner.child]);
  assert.equal(sessionContainment.empty({ inv: firstInv(r), child: runner.child }), true);
  assert.deepEqual(intents(r.runDir, 'proc.kill').map((k) => (k.kind === 'proc.kill' ? k.expect : null)), [{ inv: firstInv(r), scope: 'op', reason: 'recovery' }]);
  assert.deepEqual(dones(r.runDir, 'proc.kill').map((d) => d.recoveredBy), [null]);
  assert.deepEqual(spawnDones(r.runDir).map((x) => [x.outcome, x.recoveredBy]), [[{ kind: 'lost', treeEffects: true }, 'reconciled']]);
  assert.deepEqual(usageFacts(r.runDir).map((f) => (f.kind === 'usage-unavailable' ? f.reason : f.kind)), ['no-result']);
  // Effects are preserved for salvage: the orphan is killed, never cleaned up after.
  assert.equal(existsSync(join(r.work, 'effect.txt')), true);
  assert.equal(readFileSync(join(r.work, 'effect.txt'), 'utf8'), 'written\n');
  assert.equal(files(r).read('exit.json'), null);
  assert.equal(files(r).read('result.json'), null);
  assert.deepEqual(openIntents(r.runDir, r.arc), []);
});
