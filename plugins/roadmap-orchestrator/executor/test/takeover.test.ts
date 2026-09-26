// The ownership handshake from the executor's side, and takeover of a dead claim of another arc whose
// runner outlived it (R17-R18), through real processes: the real executor, the real supervisor via
// `roadmap start`, real runners parked at fake-backend barriers. Named tests: host.handshake-verifies-self,
// host.takeover-cross-arc-live-runner, host.takeover-cross-arc-unreconcilable.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { constants, existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { IntentOf } from '../src/core/events.ts';
import { arcId, invocationId } from '../src/core/ids.ts';
import { needsUserRecord } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { EXIT_REASON_FILE, REJECTION_FILE, executorArgv } from '../src/executor.ts';
import { isAlive, statOf } from '../src/contain/proc.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { claimHost, readClaim, readRecoveryClaim, releaseHost } from '../src/host/lock.ts';
import { createHandshake, publishOwner } from '../src/host/owner.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { type Exit } from './helpers/proc.ts';
import { reached, release } from './helpers/barrier.ts';
import { readCalls } from './helpers/scenario.ts';
import { EXEC_TIMEOUT_MS, type ExecRun, execEnv, hostFile, journalOf, reasonOf, setupExec, startExec, until } from './fixtures/exec-common.ts';
import {
  CLAUDE_ONLY, UNIT_CLAUDE_ONLY, WAIT_MS, blockedCheck, claimOf, executorOf, kill, smokes, startCli, startLine, supervisorOf,
} from './fixtures/sup-common.ts';

const T = { timeout: EXEC_TIMEOUT_MS };
const { O_APPEND } = constants;
const EXECUTOR = new URL('../src/executor.ts', import.meta.url).pathname;

function run(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<Exit> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('host.handshake-verifies-self: an owner record naming another pid → the executor refuses before any effect', T, async () => {
  const r = setupExec({ steps: smokes(1) });
  const hostDir = absPath(r.hostDir);
  const out = await claimHost(hostDir, { arc: arcId(r.arc), runDir: absPath(r.runDir), repo: absPath(r.repo), supervisor: selfIdentity() }, async () => ({ kind: 'reconciled' }));
  assert.equal(out.kind, 'claimed');
  const claim = out.kind === 'claimed' ? out.claim : assert.fail();
  // A live stranger as the published executor: this process, the test (its pid is not the executor's).
  publishOwner(hostDir, claim, selfIdentity());
  createHandshake(hostDir, claim);
  const argv = executorArgv({ hostDir, generation: claim.generation, nonce: claim.nonce, repo: absPath(r.repo), planFile: absPath(r.planPath), profile: 'claude-only', controlOnly: false });
  const exit = await run([EXECUTOR, ...argv], execEnv(r));
  assert.equal(exit.code, 78, exit.stderr);
  assert.match(exit.stderr, /refused before any effect: handshake .* arrived but host\.owner\.json names/);
  assert.equal(exit.stdout, '', 'no exit line');
  assert.ok(!existsSync(r.runDir), 'no journal append, no file in the run dir: the run dir was never created');
  assert.ok(!existsSync(hostFile(r, EXIT_REASON_FILE)), 'no exit reason either');
  assert.equal(readCalls(r.scenarioPath).length, 0, 'no backend was called');
  assert.deepEqual(readClaim(hostDir), claim, 'the claim is untouched');
  releaseHost(hostDir, claim);
});

/** Arc A parked in a plan-check at barrier `check1`, then its supervisor and executor SIGKILLed: its runner lives. */
async function strandedArc(): Promise<Readonly<{ a: ExecRun; spawn: IntentOf<'proc.spawn'> }>> {
  const a = setupExec({ steps: [...smokes(1), blockedCheck('check1')] });
  const line = startLine(await startCli(a));
  assert.equal(line.kind, 'ready', JSON.stringify(line));
  await reached(a.scenarioDir, 'check1', WAIT_MS);
  const executor = await executorOf(a, line.generation as number);
  await kill(supervisorOf(a));
  await kill(executor);
  const open = journalOf(a).view.openIntents().filter((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'backend');
  assert.equal(open.length, 1, 'the plan-check spawn is open');
  return { a, spawn: open[0] as IntentOf<'proc.spawn'> };
}

/**
 * Resolves once the recovery-lock holder is waiting on A's live runner. Its reconcile pass runs without a
 * pause from the recovery lock to the first wait of `awaitRunner`, so the only observable end of that pass
 * is the holder going to sleep: it has A's journal open for append (the read-only survivor pass is behind
 * it) and its main thread is found sleeping on consecutive samples, which the pass never does.
 */
async function adopting(a: ExecRun): Promise<void> {
  const holder = readRecoveryClaim(absPath(a.hostDir));
  if (holder === null) throw new Error('host.recovery.lock vanished before A was adopted');
  const { pid } = holder.holder;
  const events = realpathSync(join(a.runDir, 'events.jsonl'));
  await until(() => readdirSync(`/proc/${pid}/fd`).some((fd) => appendFdOn(pid, fd) === events), WAIT_MS, 'B\'s supervisor to open A\'s journal for append');
  let asleep = 0;
  const deadline = Date.now() + WAIT_MS;
  while (asleep < 5) {
    if (Date.now() >= deadline) throw new Error(`B's supervisor ${pid} never settled into waiting on A's runner`);
    asleep = statOf(pid)?.state === 'S' ? asleep + 1 : 0;
    await sleep(10);
  }
}

/** The file `fd` of `pid` names when it is open for append (the journal; the survivor pass only reads), else null. */
function appendFdOn(pid: number, fd: string): string | null {
  try {
    const flags = /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'))?.[1];
    if (flags === undefined) throw new Error(`/proc/${pid}/fdinfo/${fd} has no flags line`);
    return (parseInt(flags, 8) & O_APPEND) !== 0 ? readlinkSync(`/proc/${pid}/fd/${fd}`) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // the fd closed between the listing and the read
    throw error;
  }
}

test('host.takeover-cross-arc-live-runner: arc B takes over a dead claim of arc A whose runner lives; A\'s invocation is adopted first, with exactly one result, then B runs', T, async () => {
  const { a, spawn: stranded } = await strandedArc();
  const inv = invocationId(stranded.op, stranded.ordinal);
  const intentsBefore = journalOf(a).events.filter((e) => e.type === 'intent').length;
  const b = { ...setupExec({ steps: [...smokes(1), ...UNIT_CLAUDE_ONLY] }), hostDir: a.hostDir };
  const running = startExec(b, CLAUDE_ONLY);

  // B's supervisor holds the recovery lock while it waits on A's live runner; host.lock is still A's.
  await until(() => existsSync(hostFile(a, 'host.recovery.lock')), WAIT_MS, 'B to reconcile A under the recovery lock');
  assert.equal(claimOf(a)?.arc, a.arc, 'no new claim before the reconcile');
  // A's build stays parked until B's supervisor is adopting it: releasing earlier lets the runner finish
  // before the takeover sees it live, and the reconciler then closes the invocation without adopting it.
  await adopting(a);
  release(a.scenarioDir, 'check1');

  const exit = await running.exit;
  assert.equal(exit.code, 0, exit.stdout + exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });

  const { view, events } = journalOf(a);
  const done = view.doneOf(stranded.op);
  assert.ok(done !== null && done.kind === 'proc.spawn' && done.outcome.kind === 'result' && done.recoveredBy === 'adopted', JSON.stringify(done));
  assert.equal(events.filter((e) => e.type === 'done' && e.op === stranded.op).length, 1, 'exactly one done for the invocation');
  assert.ok(existsSync(join(invocationDir(absPath(a.runDir), inv), 'result.json')), 'its one result');
  assert.equal(events.filter((e) => e.type === 'intent').length, intentsBefore, 'nothing was dispatched for A');
});

test('host.takeover-cross-arc-unreconcilable: a surviving invocation whose launch.json is not its intent\'s refuses the takeover with a durable needs-user', T, async () => {
  const { a, spawn: stranded } = await strandedArc();
  const inv = invocationId(stranded.op, stranded.ordinal);
  const launchPath = join(invocationDir(absPath(a.runDir), inv), 'launch.json');
  const launch = JSON.parse(readFileSync(launchPath, 'utf8')) as { graceMs: number };
  writeFileSync(launchPath, JSON.stringify({ ...launch, graceMs: launch.graceMs + 1 }));
  const logBefore = readFileSync(join(a.runDir, 'events.jsonl'));
  const lockBefore = readFileSync(hostFile(a, 'host.lock'), 'utf8');

  const b = { ...setupExec({ steps: smokes(1) }), hostDir: a.hostDir };
  const exit = await startCli(b);
  try {
    assert.equal(exit.code, 78, exit.stdout + exit.stderr);
    assert.deepEqual(reasonOf(exit), {
      kind: 'refused', exitCode: 78, rejections: [{ kind: 'previous-arc-unreconciled', arc: a.arc, invocations: [inv] }],
    });
    assert.equal(readFileSync(hostFile(a, 'host.lock'), 'utf8'), lockBefore, 'A\'s dead claim stays');
    assert.ok(!existsSync(hostFile(a, 'host.recovery.lock')), 'the recovery lock is released');
    assert.deepEqual(readFileSync(join(a.runDir, 'events.jsonl')), logBefore, 'A\'s log is untouched');
    assert.ok(existsSync(join(b.runDir, REJECTION_FILE)), 'B\'s status explains the refusal');
    const id = 'host-previous-arc-unreconciled-1';
    const record = needsUserRecord(JSON.parse(readFileSync(join(b.runDir, 'needs-user', `${id}.json`), 'utf8')), id);
    assert.deepEqual([record.blocking, record.subject, record.reason, record.arc], [true, { type: 'host' }, 'previous-arc-unreconciled', b.arc]);
    // Refused again: the same unanswered question, not a second one.
    assert.equal((await startCli(b)).code, 78);
    assert.ok(!existsSync(join(b.runDir, 'needs-user', 'host-previous-arc-unreconciled-2.json')));
  } finally {
    release(a.scenarioDir, 'check1');
  }
  const { runner } = JSON.parse(readFileSync(join(invocationDir(absPath(a.runDir), inv), 'runner.json'), 'utf8')) as { runner: { pid: number; start: number } };
  await until(() => !isAlive(runner), WAIT_MS, 'A\'s runner to finish');
});
