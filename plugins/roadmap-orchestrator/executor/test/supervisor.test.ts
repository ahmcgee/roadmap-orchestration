// The supervisor (src/supervisor.ts) through the real `roadmap start`, real processes and fake backends:
// intentional exits, the stop order, the persisted crash window, generation-bound readiness, the
// control-only restart after the crash limit, the stale-heartbeat kill, and the supervisor/host crash row of
// the matrix. Named tests: supervisor.intentional-exit, supervisor.stop-order,
// supervisor.crash-window-persisted, supervisor.ready-generation, supervisor.control-only-restart,
// supervisor.heartbeat-stale.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after,describe,test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pendingCommandIds,readCommand,readReceipt,terminalReceipt } from '../src/commands/queue.ts';
import { identityOf,isAlive,readBootId } from '../src/contain/proc.ts';
import { type ProcIdentity,needsUserRecord } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { EXIT_REASON_FILE } from '../src/executor.ts';
import { type ExecutorEndRecord,HEARTBEAT_STALE_MS,executorLogs,failedPath,readyPath } from '../src/supervisor.ts';
import { EXEC_TIMEOUT_MS,type ExecRun,cli,hostFile,hostLockHeld,journalOf,reasonOf,setupExec,startExec,until } from './fixtures/exec-common.ts';
import {
CLAUDE_ONLY,UNIT_CLAUDE_ONLY,WAIT_MS,blockedCheck,claimOf,cmdline,executorOf,executorsOf,gone,idle,kill,launchDirect,ownerOf,pausedFromTheStart,smokes,
startCli,startLine,startedGenerations,stateOf,supervisorOf,watchEnd,
} from './fixtures/sup-common.ts';
import { outcomes } from './fixtures/unit-common.ts';
import { reached } from './helpers/barrier.ts';
import { assertFired,writeTrigger } from './helpers/crash.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { SUPERVISOR_HOST,crashCells } from './matrix.ts';

// Every supervised run a test here started is stopped by its teardown; nothing of them outlives the file.
after(assertNoSurvivors);

const T = { timeout: EXEC_TIMEOUT_MS };
const STRAIGHT = ['pre-build:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

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

/** dev.32 host shapes, verified against release commit 7a94a4d6 (the tag is not in this checkout). */
function legacyHostFiles(r: ExecRun, supervisor: ProcIdentity): Readonly<Record<string, unknown>> {
  return {
    'host.lock': { v: 1, nonce: '1'.repeat(32), generation: 7, bootId: readBootId(), supervisor, arc: r.arc, runDir: r.runDir, repo: r.repo },
    'host.owner.json': { v: 1, nonce: '1'.repeat(32), generation: 7, executor: null },
    'supervisor.state.json': { v: 1, generation: 7, crashes: Array.from({ length: 3 }, () => new Date().toISOString()), heartbeatStaleMs: HEARTBEAT_STALE_MS },
  };
}

function seedHost(r: ExecRun, files: Readonly<Record<string, unknown>>): void {
  for (const [name, record] of Object.entries(files)) writeFileSync(hostFile(r, name), JSON.stringify(record));
}

function supervisorErrors(r: ExecRun): string {
  return readdirSync(r.hostDir).filter((n) => /^supervisor\.[0-9a-f]{16}\.err$/.test(n))
    .map((n) => readFileSync(hostFile(r, n), 'utf8')).join('\n');
}

describe('supervisor.schema1-host', () => {
  for (const name of ['host.lock', 'host.recovery.lock']) {
    test(`a live dev.32 ${name} refuses cleanly before claiming or renaming`, T, async (t) => {
      const r = setupExec(t, { steps: [] });
      const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
      const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
      assert.ok(holder.pid !== undefined);
      const { pid, start } = identityOf(holder.pid);
      try {
        const files = { ...legacyHostFiles(r, { pid, start }) };
        if (name === 'host.recovery.lock') {
          delete files['host.lock'];
          files[name] = { v: 1, bootId: readBootId(), holder: { pid, start }, nonce: '2'.repeat(32), at: new Date().toISOString() };
        }
        seedHost(r, files);
        const exit = await startCli(r);
        assert.equal(exit.code, 75, exit.stdout + exit.stderr);
        const reason = reasonOf(exit);
        assert.equal(reason.kind, 'refused');
        const rejection = reason.kind === 'refused' ? reason.rejections[0] : assert.fail();
        assert.equal(rejection?.kind, 'previous-schema-host-busy');
        assert.ok(rejection?.kind === 'previous-schema-host-busy');
        assert.equal(rejection.pid, pid);
        assert.equal(rejection.path, hostFile(r, name));
        assert.match(rejection.detail, /previous-schema executor owns the host.*own `roadmap stop`/);
        for (const [file, record] of Object.entries(files)) assert.equal(readFileSync(hostFile(r, file), 'utf8'), JSON.stringify(record));
        assert.equal(readdirSync(r.hostDir).some((n) => n.includes('.schema1')), false);
        assert.equal(existsSync(hostFile(r, 'host.lock')), name === 'host.lock', 'no new v2 claim');
        assert.equal(existsSync(hostFile(r, 'host.generation')), false, 'no generation issued');
        assert.equal(supervisorErrors(r), '', 'no exception or rename notice');
      } finally {
        holder.kill('SIGKILL');
        await exited;
      }
    });
  }

  test('a dead v1 claim, owner and crash window are renamed with notices and a real start succeeds', T, async (t) => {
    const r = setupExec(t, { steps: smokes(1) });
    const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    assert.ok(holder.pid !== undefined);
    const { pid, start } = identityOf(holder.pid);
    holder.kill('SIGKILL');
    await exited;
    const files = legacyHostFiles(r, { pid, start });
    seedHost(r, files);
    writeFileSync(hostFile(r, 'host.generation'), '7\n');
    const generation = await startPaused(r);
    assert.equal(generation, 8);
    assert.equal(claimOf(r)?.v, 2);
    assert.deepEqual(stateOf(r).crashes, [], 'the dev.32 crash window was retired');
    const notices = supervisorErrors(r).trim().split('\n');
    assert.equal(notices.length, Object.keys(files).length);
    for (const [name, record] of Object.entries(files)) {
      assert.equal(readFileSync(hostFile(r, `${name}.schema1`), 'utf8'), JSON.stringify(record));
      assert.ok(notices.includes(`schema-1 host residue renamed: ${hostFile(r, name)} -> ${hostFile(r, `${name}.schema1`)}`));
    }
  });

  test('a schema-1 crash window alone is renamed and start succeeds (atlas2 case 2)', T, async (t) => {
    const r = setupExec(t, { steps: smokes(1) });
    const name = 'supervisor.state.json';
    const record = legacyHostFiles(r, { pid: 1, start: 0 })[name];
    seedHost(r, { [name]: record });
    const generation = await startPaused(r);
    assert.equal(generation, 1);
    assert.equal(readFileSync(hostFile(r, `${name}.schema1`), 'utf8'), JSON.stringify(record));
    assert.deepEqual(stateOf(r).crashes, []);
    assert.equal(supervisorErrors(r), `schema-1 host residue renamed: ${hostFile(r, name)} -> ${hostFile(r, `${name}.schema1`)}\n`);
  });

  test('schema-1 residue history refuses with exit 78 before claim and preserves every file', T, async (t) => {
    const r = setupExec(t, { steps: [] });
    const index = `${JSON.stringify({ v: 1, seq: 2, type: 'compacted', archive: 'residues.archive.1.01234567.jsonl' })}\n`;
    const archive = `${JSON.stringify({ v: 1, seq: 1, type: 'residue' })}\n`;
    writeFileSync(hostFile(r, 'residues.jsonl'), index);
    writeFileSync(hostFile(r, 'residues.archive.1.01234567.jsonl'), archive);
    seedHost(r, { 'supervisor.state.json': { v: 1 } });
    const exit = await startCli(r);
    assert.equal(exit.code, 78, exit.stdout + exit.stderr);
    const reason = reasonOf(exit);
    assert.ok(reason.kind === 'refused');
    assert.equal(reason.rejections[0]?.kind, 'schema-version');
    assert.match(exit.stdout, /dev\.32.*disposition/);
    assert.equal(readFileSync(hostFile(r, 'residues.jsonl'), 'utf8'), index);
    assert.equal(readFileSync(hostFile(r, 'residues.archive.1.01234567.jsonl'), 'utf8'), archive);
    assert.equal(existsSync(hostFile(r, 'supervisor.state.json')), true);
    assert.equal(readdirSync(r.hostDir).some((n) => n.includes('.schema1')), false);
    assert.equal(existsSync(hostFile(r, 'host.lock')), false);
    assert.equal(existsSync(hostFile(r, 'host.generation')), false);
  });
});

test('supervisor.post-claim-throw: the dead v2 lock is taken over cleanly on the next start after the cause is removed', T, async (t) => {
  const r = setupExec(t, { steps: smokes(1) });
  await pausedFromTheStart(r);
  seedHost(r, { 'supervisor.state.json': { v: 2, generation: 1, crashes: 'invalid', heartbeatStaleMs: HEARTBEAT_STALE_MS } });
  const first = await startCli(r);
  assert.equal(first.code, 70, first.stdout + first.stderr);
  assert.equal(startLine(first).kind, 'failed');
  assert.match(supervisorErrors(r), /SchemaError: supervisor\.state\.json\.crashes/);
  const dead = claimOf(r);
  assert.ok(dead !== null && !isAlive(dead.supervisor), 'the post-claim throw left a v2 claim of a dead pid');
  assert.equal(ownerOf(r)?.executor, null);
  assert.equal(existsSync(hostFile(r, 'host.recovery.lock')), false);
  renameSync(hostFile(r, 'supervisor.state.json'), hostFile(r, 'supervisor.state.json.broken'));
  const second = startLine(await startCli(r));
  assert.equal(second.kind, 'ready');
  const generation = second.generation as number;
  assert.ok(generation > dead.generation);
  await idle(r, generation);
  assert.equal(claimOf(r)?.v, 2);
  assert.notEqual(supervisorOf(r).pid, dead.supervisor.pid);
});

describe('supervisor.intentional-exit', () => {
  test('complete is not a crash: the executor exits first, then the lock is released, then the supervisor exits', T, async (t) => {
    const r = setupExec(t, { steps: [...smokes(1), ...UNIT_CLAUDE_ONLY] });
    const line = startLine(await startCli(r));
    assert.equal(line.kind, 'ready', JSON.stringify(line));
    const generation = line.generation as number;
    const supervisor = supervisorOf(r);
    const executor = await executorOf(r, generation);
    const seen = await watchEnd(r, supervisor, executor);
    assert.ok(seen.executorGone <= seen.lockGone && seen.lockGone <= seen.supervisorGone, JSON.stringify(seen));
    assert.deepEqual(exitReason(r), { v: 2, generation, reason: 'complete' });
    const state = stateOf(r);
    assert.deepEqual(state.crashes, [], 'no crash counted');
    assert.equal(state.heartbeatStaleMs, HEARTBEAT_STALE_MS, 'the default threshold is recorded');
    assert.equal(startedGenerations(r).length, 1, 'never restarted');
    assert.ok(existsSync(readyPath(absPath(r.hostDir), generation)));
    assert.deepEqual(outcomes(r), STRAIGHT);
    const end = JSON.parse(readFileSync(hostFile(r, `executor.${generation}.exit.json`), 'utf8')) as ExecutorEndRecord;
    assert.deepEqual(end.child, { type: 'exited', code: 0 });
    assert.ok(end.stages.kind === 'known');
    assert.deepEqual(end.stages.open, []);
    assert.ok(end.stages.last?.stage === 'retire', JSON.stringify(end));
  });

  test('stop is not a crash either: no restart, no crash, the lock released after the executor exits', T, async (t) => {
    const r = setupExec(t, { steps: smokes(1) });
    const generation = await startPaused(r);
    const supervisor = supervisorOf(r);
    const executor = await executorOf(r, generation);
    await cli(r, ['stop']);
    const seen = await watchEnd(r, supervisor, executor);
    assert.ok(seen.executorGone <= seen.lockGone, JSON.stringify(seen));
    assert.deepEqual(exitReason(r), { v: 2, generation, reason: 'stop' });
    assert.deepEqual(stateOf(r).crashes, []);
    assert.deepEqual(startedGenerations(r), [generation]);
  });
});

test('supervisor.stop-order: stop → the executor writes exit.reason{stop} and exits → the supervisor releases the lock → the supervisor exits', T, async (t) => {
  const r = setupExec(t, { steps: [...smokes(1), blockedCheck('check1')] });
  const line = startLine(await startCli(r));
  assert.equal(line.kind, 'ready');
  const generation = line.generation as number;
  await reached(r.scenarioDir, 'check1', WAIT_MS);
  const supervisor = supervisorOf(r);
  const executor = await executorOf(r, generation);
  await cli(r, ['stop']);
  const seen = await watchEnd(r, supervisor, executor);
  assert.ok(seen.executorGone > 0 && seen.executorGone <= seen.lockGone && seen.lockGone <= seen.supervisorGone, JSON.stringify(seen));
  assert.deepEqual(exitReason(r), { v: 2, generation, reason: 'stop' });
  assert.equal(outcomes(r).at(-1), 'pre-build:interrupted', 'the running stage was cancelled before the executor exited');
  assert.deepEqual(journalOf(r).view.openIntents(), [], 'nothing left open');
  assert.deepEqual(stateOf(r).crashes, []);
});

test('supervisor.crash-stage: a killed executor leaves its signal and open stage in supervisor-owned evidence', T, async (t) => {
  const r = setupExec(t, { steps: [...smokes(1), blockedCheck('check1'), ...smokes(1)] });
  const line = startLine(await startCli(r));
  assert.equal(line.kind, 'ready');
  const generation = line.generation as number;
  await reached(r.scenarioDir, 'check1', WAIT_MS);
  await kill(await executorOf(r, generation));
  await cli(r, ['pause', '--all']);
  const path = hostFile(r, `executor.${generation}.exit.json`);
  await until(() => existsSync(path), WAIT_MS, 'the supervisor exit evidence');
  const end = JSON.parse(readFileSync(path, 'utf8')) as ExecutorEndRecord;
  assert.deepEqual(end.child, { type: 'signalled', signal: 'SIGKILL' });
  assert.equal(end.killEvidence?.cause, 'external-unknown');
  assert.ok(end.killEvidence?.pressure.memory.kind === 'readable' || end.killEvidence?.pressure.memory.kind === 'unavailable');
  assert.ok(end.stages.kind === 'known');
  assert.deepEqual(end.stages.open, [{ type: 'stage', unit: 'u1', stage: 'pre-build', attempt: 1 }]);
  assert.deepEqual(end.stages.last, end.stages.open[0]);
});

test('supervisor.crash-window-persisted: crash 1 under one supervisor, a supervisor restart, crashes 2 and 3 under the next; the third writes sup-<gen>-3 and releases the lock', T, async (t) => {
  const r = setupExec(t, { steps: smokes(5) });
  const g1 = await startPaused(r);
  await kill(await executorOf(r, g1));
  const g2 = g1 + 1;
  await idle(r, g2);
  assert.equal(stateOf(r).crashes.length, 1);
  const end = JSON.parse(readFileSync(hostFile(r, `executor.${g1}.exit.json`), 'utf8')) as ExecutorEndRecord;
  assert.deepEqual(end.child, { type: 'signalled', signal: 'SIGKILL' });
  assert.equal(end.generation, g1);

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
  assert.deepEqual(record.options.map((o) => o.id), ['resolved'], 'crash recovery offers an explicit acknowledgement');
  assert.ok(record.evidence.length === 2 && record.evidence.every((p) => existsSync(p)), 'the stderr logs of this supervisor\'s crashed generations');
  assert.ok(!hostLockHeld(r), 'the supervisor released the lock before it exited');
  assert.ok(!existsSync(hostFile(r, EXIT_REASON_FILE)), 'no executor ended on purpose');
  assert.deepEqual(startedGenerations(r), [g1, g2, g3, g4]);
});

test('supervisor.ready-generation: start waits for its own generation; older ready markers are ignored', T, async (t) => {
  const r = setupExec(t, { steps: [] });
  mkdirSync(join(r.repo, '.roadmap'), { recursive: true });
  writeFileSync(join(r.repo, '.roadmap', 'state.json'), '{}\n');
  writeFileSync(hostFile(r, 'host.generation'), '5\n');
  for (let g = 1; g <= 5; g++) {
    writeFileSync(hostFile(r, `supervisor.ready.${g}`), JSON.stringify({ v: 2, generation: g, state: 'ready', at: new Date().toISOString() }));
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

test('supervisor.control-only-restart: after the crash limit, start runs the executor control-only; mutations stay pending until recovery and nothing dispatches until the sup item is acknowledged', T, async (t) => {
  const r = setupExec(t, { steps: [...smokes(4), ...UNIT_CLAUDE_ONLY] });
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
  const resumes = pendingCommandIds(absPath(r.runDir)).filter((id) => readCommand(absPath(r.runDir), id, journalOf(r).view.arc).file.body.type === 'resume');
  assert.equal(resumes.length, 1);
  const resume = resumes[0]!;
  assert.equal(terminalReceipt(absPath(r.runDir), resume), null, 'resume stays pending while the sup item is open');
  await sleep(3_000);
  assert.equal(terminalReceipt(absPath(r.runDir), resume), null, 'control-only still has not applied resume');
  assert.equal(readCalls(r.scenarioPath).length, 3, 'only the three earlier starts\' smokes ran: nothing dispatched while the sup item is open, and the control-only executor smokes after recovery, once it is acknowledged (lead ruling 14c)');
  assert.equal(run.child.exitCode, null, 'the control-only executor waits');
  assert.ok(isAlive(executor));

  await cli(r, ['ack', id]);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stdout + exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.deepEqual(outcomes(r), STRAIGHT);
  assert.deepEqual(journalOf(r).view.ackOf(id as never)?.choice, null);
  assert.equal(readReceipt(absPath(r.runDir), resume, 'applied')?.state, 'applied', 'resume applies after recovery');
});

test('supervisor.heartbeat-stale: a frozen executor (SIGSTOP) is SIGKILLed once its heartbeat is stale and counted as a crash; the next generation runs', T, async (t) => {
  const STALE_MS = 15_000;
  const r = setupExec(t, { steps: smokes(2) });
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
  assert.deepEqual(exitReason(r), { v: 2, generation: g1 + 1, reason: 'stop' });
});

describe(`crash matrix: ${SUPERVISOR_HOST}`, () => {
  for (const cell of crashCells(SUPERVISOR_HOST)) {
    test(`${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async (t) => {
      const handshaken = cell.label === 'sup.after-handshake';
      const r = setupExec(t, { steps: handshaken ? [...smokes(1), ...UNIT_CLAUDE_ONLY, ...smokes(1)] : [...smokes(1), ...UNIT_CLAUDE_ONLY] });
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
      if (handshaken) assert.deepEqual(exitReason(r), { v: 2, generation: dead.generation, reason: 'complete' });
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
