// The supervisor (src/supervisor.ts) through the real `roadmap start`, real processes and fake backends:
// intentional exits, the stop order, the persisted crash window, generation-bound readiness, the
// control-only restart after the crash limit, the stale-heartbeat kill, and the supervisor/host crash row of
// the matrix. Named tests: supervisor.intentional-exit, supervisor.stop-order,
// supervisor.crash-window-persisted, supervisor.ready-generation, supervisor.control-only-restart,
// supervisor.heartbeat-stale.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { isAlive } from '../src/contain/proc.ts';
import { needsUserRecord } from '../src/core/records.ts';
import { EXIT_REASON_FILE } from '../src/executor.ts';
import { HEARTBEAT_STALE_MS, executorLogs, failedPath, readyPath } from '../src/supervisor.ts';
import { absPath } from '../src/core/values.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { readCalls } from './helpers/scenario.ts';
import { tmpDir } from './helpers/repo.ts';
import { reached } from './helpers/barrier.ts';
import { EXEC_TIMEOUT_MS, type ExecRun, cli, hostFile, hostLockHeld, journalOf, reasonOf, setupExec, startExec, until } from './fixtures/exec-common.ts';
import {
  CLAUDE_ONLY, UNIT_CLAUDE_ONLY, WAIT_MS, blockedCheck, claimOf, cmdline, executorOf, executorsOf, gone, idle, kill, launchDirect, ownerOf, pausedFromTheStart, smokes,
  startCli, startLine, startedGenerations, stateOf, supervisorOf, watchEnd,
} from './fixtures/sup-common.ts';
import { SUPERVISOR_HOST, crashCells } from './matrix.ts';
import { outcomes } from './fixtures/unit-common.ts';

const T = { timeout: EXEC_TIMEOUT_MS };
const STRAIGHT = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

const exitReason = (r: ExecRun): { reason: string; generation: number } => JSON.parse(readFileSync(hostFile(r, EXIT_REASON_FILE), 'utf8')) as { reason: string; generation: number };

/** Starts a paused claude-only arc and returns the idle executor of its first generation. */
async function startPaused(r: ExecRun): Promise<number> {
  await pausedFromTheStart(r);
  const line = startLine(await startCli(r));
  assert.equal(line.kind, 'ready', JSON.stringify(line));
  const generation = line.generation as number;
  await idle(r, generation);
  return generation;
}

describe('supervisor.intentional-exit', () => {
  test('complete is not a crash: the executor exits first, then the lock is released, then the supervisor exits', T, async () => {
    const r = setupExec({ steps: [...smokes(1), ...UNIT_CLAUDE_ONLY] });
    const line = startLine(await startCli(r));
    assert.equal(line.kind, 'ready', JSON.stringify(line));
    const generation = line.generation as number;
    const supervisor = supervisorOf(r);
    const executor = await executorOf(r, generation);
    const seen = await watchEnd(r, supervisor, executor);
    assert.ok(seen.executorGone <= seen.lockGone && seen.lockGone <= seen.supervisorGone, JSON.stringify(seen));
    assert.deepEqual(exitReason(r), { v: 1, generation, reason: 'complete' });
    const state = stateOf(r);
    assert.deepEqual(state.crashes, [], 'no crash counted');
    assert.equal(state.heartbeatStaleMs, HEARTBEAT_STALE_MS, 'the default threshold is recorded');
    assert.equal(startedGenerations(r).length, 1, 'never restarted');
    assert.ok(existsSync(readyPath(absPath(r.hostDir), generation)));
    assert.deepEqual(outcomes(r), STRAIGHT);
  });

  test('stop is not a crash either: no restart, no crash, the lock released after the executor exits', T, async () => {
    const r = setupExec({ steps: smokes(1) });
    const generation = await startPaused(r);
    const supervisor = supervisorOf(r);
    const executor = await executorOf(r, generation);
    await cli(r, ['stop']);
    const seen = await watchEnd(r, supervisor, executor);
    assert.ok(seen.executorGone <= seen.lockGone, JSON.stringify(seen));
    assert.deepEqual(exitReason(r), { v: 1, generation, reason: 'stop' });
    assert.deepEqual(stateOf(r).crashes, []);
    assert.deepEqual(startedGenerations(r), [generation]);
  });
});

test('supervisor.stop-order: stop → the executor writes exit.reason{stop} and exits → the supervisor releases the lock → the supervisor exits', T, async () => {
  const r = setupExec({ steps: [...smokes(1), blockedCheck('check1')] });
  const line = startLine(await startCli(r));
  assert.equal(line.kind, 'ready');
  const generation = line.generation as number;
  await reached(r.scenarioDir, 'check1', WAIT_MS);
  const supervisor = supervisorOf(r);
  const executor = await executorOf(r, generation);
  await cli(r, ['stop']);
  const seen = await watchEnd(r, supervisor, executor);
  assert.ok(seen.executorGone > 0 && seen.executorGone <= seen.lockGone && seen.lockGone <= seen.supervisorGone, JSON.stringify(seen));
  assert.deepEqual(exitReason(r), { v: 1, generation, reason: 'stop' });
  assert.equal(outcomes(r).at(-1), 'plan-check:interrupted', 'the running stage was cancelled before the executor exited');
  assert.deepEqual(journalOf(r).view.openIntents(), [], 'nothing left open');
  assert.deepEqual(stateOf(r).crashes, []);
});

test('supervisor.crash-window-persisted: crash 1 under one supervisor, a supervisor restart, crashes 2 and 3 under the next; the third writes sup-<gen>-3 and releases the lock', T, async () => {
  const r = setupExec({ steps: smokes(5) });
  const g1 = await startPaused(r);
  await kill(await executorOf(r, g1));
  const g2 = g1 + 1;
  await idle(r, g2);
  assert.equal(stateOf(r).crashes.length, 1);

  // Restart the supervisor process: kill it first (so nobody counts what follows), then its executor.
  const first = supervisorOf(r);
  await kill(first);
  await kill(await executorOf(r, g2));
  const line = startLine(await startCli(r));
  assert.equal(line.kind, 'ready', JSON.stringify(line));
  const g3 = line.generation as number;
  assert.ok(g3 > g2);
  const second = supervisorOf(r);
  assert.notEqual(second.pid, first.pid);
  assert.equal(stateOf(r).crashes.length, 1, 'the new supervisor loaded the window');

  await kill(await idle(r, g3));
  const g4 = g3 + 1;
  await until(() => stateOf(r).crashes.length === 2, WAIT_MS, 'crash 2');
  await kill(await idle(r, g4));
  await gone(second);

  const state = stateOf(r);
  assert.equal(state.crashes.length, 3);
  assert.equal(state.generation, g4);
  const id = `sup-${g4}-3`;
  const record = needsUserRecord(JSON.parse(readFileSync(join(r.runDir, 'needs-user', `${id}.json`), 'utf8')), id);
  assert.deepEqual([record.id, record.blocking, record.subject, record.reason], [id, true, { type: 'host' }, 'supervisor-crash-limit']);
  assert.ok(record.evidence.length === 2 && record.evidence.every((p) => existsSync(p)), 'the stderr logs of this supervisor\'s crashed generations');
  assert.ok(!hostLockHeld(r), 'the supervisor released the lock before it exited');
  assert.ok(!existsSync(hostFile(r, EXIT_REASON_FILE)), 'no executor ended on purpose');
  assert.deepEqual(startedGenerations(r), [g1, g2, g3, g4]);
});

test('supervisor.ready-generation: start waits for its own generation; older ready markers are ignored', T, async () => {
  const r = setupExec({ steps: [] });
  mkdirSync(join(r.repo, '.roadmap'), { recursive: true });
  writeFileSync(join(r.repo, '.roadmap', 'state.json'), '{}\n');
  writeFileSync(hostFile(r, 'host.generation'), '5\n');
  for (let g = 1; g <= 5; g++) {
    writeFileSync(hostFile(r, `supervisor.ready.${g}`), JSON.stringify({ v: 1, generation: g, state: 'ready', at: new Date().toISOString() }));
  }
  const exit = await startCli(r);
  assert.equal(exit.code, 78, exit.stdout + exit.stderr);
  const reason = reasonOf(exit);
  assert.ok(reason.kind === 'refused');
  assert.deepEqual(reason.rejections.map((x) => x.kind), ['legacy-roadmap-dir']);
  assert.ok(existsSync(failedPath(absPath(r.hostDir), 6)), 'generation 6 failed');
  assert.ok(!existsSync(readyPath(absPath(r.hostDir), 6)));
  await until(() => !hostLockHeld(r), WAIT_MS, 'the release');
});

test('supervisor.control-only-restart: after the crash limit, start runs the executor control-only; it dispatches nothing until the sup item is acknowledged', T, async () => {
  const r = setupExec({ steps: [...smokes(4), ...UNIT_CLAUDE_ONLY] });
  const g1 = await startPaused(r);
  const supervisor = supervisorOf(r);
  await kill(await executorOf(r, g1));
  await kill(await idle(r, g1 + 1));
  await until(() => stateOf(r).crashes.length === 2, WAIT_MS, 'crash 2');
  await kill(await idle(r, g1 + 2));
  await gone(supervisor);
  const id = `sup-${g1 + 2}-3`;
  assert.ok(existsSync(join(r.runDir, 'needs-user', `${id}.json`)));

  const run = startExec(r, CLAUDE_ONLY);
  await until(() => claimOf(r) !== null && ownerOf(r)?.executor !== null && ownerOf(r)?.generation === claimOf(r)?.generation, WAIT_MS, 'the control-only executor');
  const g4 = (claimOf(r) as { generation: number }).generation;
  const executor = await executorOf(r, g4);
  assert.ok(cmdline(executor).includes('--control-only'), cmdline(executor).join(' '));
  await until(() => startedGenerations(r).includes(g4), WAIT_MS, 'executor-started of the control-only executor');
  await cli(r, ['resume']);
  await sleep(3_000);
  assert.equal(readCalls(r.scenarioPath).length, 3, 'only the three earlier starts\' smokes ran: nothing dispatched while the sup item is open, and the control-only executor smokes after recovery, once it is acknowledged (lead ruling 14c)');
  assert.equal(run.child.exitCode, null, 'the control-only executor waits');
  assert.ok(isAlive(executor));

  await cli(r, ['ack', id]);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stdout + exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.deepEqual(outcomes(r), STRAIGHT);
  assert.deepEqual(journalOf(r).view.ackOf(id as never)?.choice, null);
});

test('supervisor.heartbeat-stale: a frozen executor (SIGSTOP) is SIGKILLed once its heartbeat is stale and counted as a crash; the next generation runs', T, async () => {
  const STALE_MS = 15_000;
  const r = setupExec({ steps: smokes(2) });
  await pausedFromTheStart(r);
  const supervisor = launchDirect(r, STALE_MS);
  await until(() => claimOf(r) !== null, WAIT_MS, 'the claim');
  const g1 = (claimOf(r) as { generation: number }).generation;
  const executor = await idle(r, g1);
  assert.equal(stateOf(r).heartbeatStaleMs, STALE_MS, 'the explicit threshold is recorded');
  process.kill(executor.pid, 'SIGSTOP');
  await gone(executor, 3 * WAIT_MS);
  // The supervisor records the crash after its SIGKILL has reaped the executor.
  await until(() => stateOf(r).crashes.length === 1, WAIT_MS, 'the crash to be recorded');
  await idle(r, g1 + 1);
  assert.ok(isAlive(supervisor), 'the supervisor restarted the executor');
  await cli(r, ['stop']);
  await gone(supervisor);
  assert.deepEqual(exitReason(r), { v: 1, generation: g1 + 1, reason: 'stop' });
});

describe(`crash matrix: ${SUPERVISOR_HOST}`, () => {
  for (const cell of crashCells(SUPERVISOR_HOST)) {
    test(`${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async () => {
      const handshaken = cell.label === 'sup.after-handshake';
      const r = setupExec({ steps: handshaken ? [...smokes(1), ...UNIT_CLAUDE_ONLY, ...smokes(1)] : [...smokes(1), ...UNIT_CLAUDE_ONLY] });
      const trigger = writeTrigger(tmpDir('trigger'), { label: cell.label, occurrence: 1 });
      const first = await startCli(r, CLAUDE_ONLY, { ROADMAP_TEST_CRASH: trigger });
      assert.equal(first.code, 70, first.stdout + first.stderr);
      assert.equal(startLine(first).kind, 'failed');
      assertFired(trigger);
      const dead = claimOf(r);
      assert.ok(dead !== null && !isAlive(dead.supervisor), 'the claim of a dead supervisor is left');
      const published = ownerOf(r)?.executor ?? null;
      assert.equal(published !== null, cell.label === 'sup.after-owner-publish' || handshaken, 'the owner record names an executor only once published');
      const logs = executorLogs(absPath(r.hostDir), dead.generation);
      assert.equal(existsSync(logs.err), cell.label !== 'sup.after-claim', 'an executor was spawned exactly when the crash came after the spawn');
      for (const p of executorsOf(dead.nonce)) await gone(p, 3 * WAIT_MS);
      if (!handshaken && cell.label !== 'sup.after-claim') assert.match(readFileSync(logs.err, 'utf8'), /refused before any effect: the supervisor that spawned this executor died/);
      const effects = startedGenerations(r);
      assert.deepEqual(effects, handshaken ? [dead.generation] : [], 'only a handshaken executor acted');
      if (handshaken) assert.deepEqual(exitReason(r), { v: 1, generation: dead.generation, reason: 'complete' });
      else assert.ok(!existsSync(r.runDir), 'the orphan wrote nothing, not even its run dir');

      const exit = await startExec(r, CLAUDE_ONLY).exit;
      assert.equal(exit.code, 0, exit.stdout + exit.stderr);
      assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
      const generations = startedGenerations(r);
      assert.equal(generations.length, handshaken ? 2 : 1);
      assert.ok(generations.every((g, i) => i === 0 || g > generations[i - 1]!), 'executors followed one another');
      assert.deepEqual(outcomes(r), STRAIGHT, 'the unit ran once');
      assert.equal(journalOf(r).view.opsOf('integration.ff').length, 1, 'published once');
      assert.ok(!hostLockHeld(r));
    });
  }
});
