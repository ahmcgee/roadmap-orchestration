// The runner and the runner-file lifecycle with real processes: stdio on files, umask, deadline, cancel,
// quiescence before exit.json, spawn failure, the executor's backstop, and every crashPoint label.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAlive, signal } from '../src/contain/proc.ts';
import { members, opMembers, sessionContainment } from '../src/contain/session.ts';
import { readJson } from '../src/core/fsx.ts';
import { exitFile, launchFile, runnerFile, type ProcIdentity } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { type RunnerHandle, awaitRunner, cancel, launchSha256, prepareLaunch, startRunner } from '../src/runner/launch.ts';
import { barrierDir, reached } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import {
  type Invocation, type LaunchOptions, assertGone, identityFromFile, launchBase, newInvocation, waitFor, waitForChild, workload,
} from './helpers/invocation.ts';
import { fixture, runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';

const T = { timeout: 30_000 };

function start(inv: Invocation, options: LaunchOptions): RunnerHandle {
  return startRunner(inv.invDir, prepareLaunch(launchBase(inv, options)));
}

async function exited(handle: RunnerHandle) {
  const end = await awaitRunner(handle);
  assert.equal(end.kind, 'exited', JSON.stringify(end));
  if (end.kind !== 'exited') throw new Error('unreachable');
  assert.equal(readFileSync(join(handle.files.invDir, 'runner.log'), 'utf8'), '', 'the runner logged an error');
  return end.exit;
}

test('runner.normal-exit', T, async () => {
  const inv = newInvocation();
  const stdin = join(inv.root, 'stdin');
  writeFileSync(stdin, 'fed\n');
  const handle = start(inv, { argv: workload('workload-exit.ts', '3'), stdinPath: absPath(stdin) });
  const exit = await exited(handle);
  assert.deepEqual(exit.child, { type: 'exited', code: 3 });
  assert.equal(exit.cause, 'exited');
  assert.ok(exit.quiescedAt >= exit.endedAt);
  assert.equal(readFileSync(join(inv.invDir, 'stdout'), 'utf8'), 'out\nfed\n');
  assert.equal(readFileSync(join(inv.invDir, 'stderr'), 'utf8'), 'err\n');
  // The runner never writes result.json: the executor's adapter does.
  assert.equal(existsSync(join(inv.invDir, 'result.json')), false);
});

test('runner.files-validate', T, async () => {
  const inv = newInvocation();
  const handle = start(inv, { argv: workload('workload-exit.ts', '0') });
  await exited(handle);
  const raw = (name: string): unknown => readJson(join(inv.invDir, name));
  const launch = launchFile(raw('launch.json'), 'launch.json');
  assert.equal(launchSha256(launch), launchSha256(handle.launch));
  const runner = runnerFile(raw('runner.json'), 'runner.json');
  assert.deepEqual({ pid: runner.runner.pid, start: runner.runner.start }, handle.runner);
  assert.ok(runner.child !== null);
  assert.equal(runner.child.sid, runner.child.pid, 'the workload leads its own session');
  exitFile(raw('exit.json'), 'exit.json');

  // Reads are bound to the invocation: another inv's reader refuses these files.
  const other = runnerFiles(inv.invDir, newInvocation().inv);
  assert.throws(() => other.read('exit.json'), /inv is/);
  // Write-once files refuse a second write.
  assert.throws(() => handle.files.write('exit.json', exitFile(raw('exit.json'), 'exit.json')), /already exists/);
});

test('runner.no-pipes', T, async () => {
  for (const stdinPath of [absPath(join(tmpDir('stdin'), 'in')), null]) {
    if (stdinPath !== null) writeFileSync(stdinPath, '');
    const inv = newInvocation();
    const handle = start(inv, { argv: workload('workload-hang.ts'), stdinPath });
    const { child } = await waitForChild(handle, 10_000);
    const fd = (pid: number, n: number): string => readlinkSync(`/proc/${pid}/fd/${n}`);
    assert.equal(fd(child.pid, 0), stdinPath ?? '/dev/null');
    if (stdinPath !== null) assert.ok(statSync(`/proc/${child.pid}/fd/0`).isFile());
    for (const [n, name] of [[1, 'stdout'], [2, 'stderr']] as const) {
      assert.equal(fd(child.pid, n), join(inv.invDir, name));
      assert.ok(statSync(`/proc/${child.pid}/fd/${n}`).isFile(), `fd ${n} is a regular file`);
    }
    // The runner's own stdio is files too.
    for (const n of [1, 2]) assert.equal(fd(handle.runner.pid, n), join(inv.invDir, 'runner.log'));
    cancel(handle, 'stop');
    await exited(handle);
  }
});

test('runner.umask-022', T, async () => {
  const inv = newInvocation();
  const previous = process.umask(0o077);
  let handle: RunnerHandle;
  try {
    handle = start(inv, { argv: workload('workload-hang.ts') });
  } finally {
    process.umask(previous);
  }
  const { child } = await waitForChild(handle, 10_000);
  const umask = (pid: number): string | undefined => /^Umask:\s*(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  assert.equal(umask(handle.runner.pid), '0022');
  assert.equal(umask(child.pid), '0022');
  assert.equal(statSync(join(inv.invDir, 'stdout')).mode & 0o777, 0o644);
  cancel(handle, 'stop');
  await exited(handle);
});

test('runner.deadline-without-executor', T, async () => {
  const inv = newInvocation();
  const dir = barrierDir();
  const base = launchBase(inv, { argv: workload('workload-tree.ts', dir, '3', '1'), deadlineMs: 2_000, graceMs: 300 });
  const launcher: ChildProcess = spawn(process.execPath, [fixture('runner-launcher.ts'), inv.invDir, JSON.stringify(base), 'hang'], {
    env: process.env,
    stdio: 'ignore',
  });
  try {
    for (const level of [1, 2, 3]) await reached(dir, `level-${level}`, 10_000);
    const tree = [1, 2, 3].map((level) => identityFromFile(join(dir, `level-${level}.reached`)));
    const files = runnerFiles(inv.invDir, inv.inv);
    const runner = await waitFor('runner.json', 10_000, () => files.read('runner.json'));
    // The executor dies; the runner alone enforces the deadline.
    launcher.kill('SIGKILL');
    const exit = await waitFor('exit.json', 10_000, () => files.read('exit.json'));
    assert.equal(exit.cause, 'deadline');
    assert.ok(exit.quiescedAt >= base.deadlineAt);
    assertGone(tree);
    assert.deepEqual(members({ inv: inv.inv, child: runner.child }), []);
    await waitFor('the runner to exit', 10_000, () => (isAlive(runner.runner) ? null : true));
  } finally {
    launcher.kill('SIGKILL');
  }
});

test('runner.cancel', T, async () => {
  for (const [reason, cause] of [['pause', 'cancel'], ['stop', 'cancel'], ['recovery', 'recovery-kill']] as const) {
    const inv = newInvocation();
    const handle = start(inv, { argv: workload('workload-hang.ts') });
    const { child } = await waitForChild(handle, 10_000);
    cancel(handle, reason);
    const exit = await exited(handle);
    assert.equal(exit.cause, cause);
    assert.deepEqual(exit.child, { type: 'signalled', signal: 'SIGTERM' });
    assertGone([child]);
  }
});

test('runner.waits-for-grandchild', T, async () => {
  const inv = newInvocation();
  const out = join(inv.root, 'grandchild-wrote');
  // The workload exits at once; its grandchild (same session, same env) writes 800 ms later, then exits.
  const handle = start(inv, { argv: workload('workload-fork.ts', 'same', 'keep', 'exit', 'workload-write-later.ts', '800', '0', out) });
  const exit = await exited(handle);
  assert.deepEqual(exit.child, { type: 'exited', code: 0 });
  assert.equal(existsSync(out), true, 'exit.json was written before the grandchild finished');
  assert.ok(new Date(exit.quiescedAt).getTime() - new Date(exit.endedAt).getTime() >= 500, JSON.stringify(exit));
});

test('runner.grandchild-killed-at-deadline', T, async () => {
  const inv = newInvocation();
  // The child exits, but its grandchild would outlive the deadline: the runner kills it and says so.
  const handle = start(inv, { argv: workload('workload-fork.ts', 'same', 'keep', 'exit', 'workload-hang.ts'), deadlineMs: 1_500, graceMs: 200 });
  const exit = await exited(handle);
  assert.deepEqual(exit.child, { type: 'exited', code: 0 });
  assert.equal(exit.cause, 'deadline');
  assert.deepEqual(opMembers(inv.op), []);
});

test('runner.spawn-failed', T, async () => {
  const inv = newInvocation();
  const handle = start(inv, { argv: [join(inv.root, 'no-such-binary')] });
  const exit = await exited(handle);
  assert.equal(exit.child.type, 'spawn-failed');
  assert.equal(exit.cause, 'exited');
  assert.equal(handle.files.read('runner.json')?.child, null);
});

test('runner.backstop-kills-hung-runner', T, async () => {
  const inv = newInvocation();
  const handle = start(inv, { argv: workload('workload-hang.ts'), deadlineMs: 1_000, graceMs: 300 });
  const { child } = await waitForChild(handle, 10_000);
  // A hung runner: stopped, it can neither enforce the deadline nor write exit.json.
  signal(handle.runner, 'SIGSTOP');
  const end = await awaitRunner(handle);
  assert.deepEqual(end, { kind: 'backstop-killed', runner: handle.runner });
  assert.ok(Date.now() >= new Date(handle.launch.deadlineAt).getTime() + 600);
  assert.equal(handle.files.read('exit.json'), null);
  // The workload outlives its runner; recovery's kill empties it.
  const ref = { inv: inv.inv, child };
  assert.equal(isAlive(child), true);
  await sessionContainment.kill(ref, 'recovery', 300);
  assert.equal(sessionContainment.empty(ref), true);
});

// B3 internal points of proc.spawn. The launcher stands in for the executor; its ROADMAP_TEST_CRASH rides
// launch.json into the runner, which SIGKILLs itself at the label.

type CrashCase = Readonly<{ label: string; argv: readonly string[]; check: (inv: Invocation, handle: RunnerHandle) => Promise<void> }>;

async function crashRun(label: string, argv: readonly string[]): Promise<{ inv: Invocation; handle: RunnerHandle; trigger: string }> {
  const inv = newInvocation();
  const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: 1 });
  const base = launchBase(inv, { argv });
  const run = await runFixture('runner-launcher.ts', [inv.invDir, JSON.stringify(base), 'exit'], {
    env: { ...process.env, ROADMAP_TEST_CRASH: trigger },
    timeoutMs: 10_000,
  });
  assert.equal(run.code, 0, run.stderr);
  const runner = JSON.parse(run.stdout) as ProcIdentity;
  const files = runnerFiles(inv.invDir, inv.inv);
  const launch = files.read('launch.json');
  assert.ok(launch !== null);
  assert.deepEqual(launch.test, { crash: trigger });
  return { inv, handle: { files, launch, runner }, trigger };
}

const RUNNER_CRASHES: readonly CrashCase[] = [
  {
    label: 'runner.before-runner-json',
    argv: workload('workload-hang.ts'),
    check: async (inv, handle) => {
      assert.equal(handle.files.read('runner.json'), null);
      assert.deepEqual(opMembers(inv.op), []);
    },
  },
  {
    label: 'runner.after-runner-json',
    argv: workload('workload-hang.ts'),
    check: async (inv, handle) => {
      assert.equal(handle.files.read('runner.json')?.child, null);
      assert.equal(existsSync(join(inv.invDir, 'stdout')), false, 'no workload was spawned');
      assert.deepEqual(opMembers(inv.op), []);
    },
  },
  {
    label: 'runner.after-child-spawn',
    argv: workload('workload-hang.ts'),
    check: async (inv, handle) => {
      // The child exists but runner.json does not name it yet: ROADMAP_INV still finds it.
      assert.equal(handle.files.read('runner.json')?.child, null);
      const ref = { inv: inv.inv, child: null };
      assert.equal(members(ref).length, 1);
      await sessionContainment.kill(ref, 'recovery', 300);
      assert.equal(sessionContainment.empty(ref), true);
    },
  },
  {
    label: 'runner.child-exited-before-exit-json',
    argv: workload('workload-exit.ts', '0'),
    check: async (inv, handle) => {
      const runner = handle.files.read('runner.json');
      assert.ok(runner?.child != null);
      assert.equal(isAlive(runner.child), false);
      assert.deepEqual(opMembers(inv.op), []);
    },
  },
  {
    label: 'runner.after-exit-json',
    argv: workload('workload-exit.ts', '0'),
    check: async (_inv, handle) => {
      assert.equal(handle.files.read('exit.json')?.cause, 'exited');
    },
  },
];

for (const c of RUNNER_CRASHES) {
  test(`runner.crash.${c.label}`, T, async () => {
    const { inv, handle, trigger } = await crashRun(c.label, c.argv);
    const end = await awaitRunner(handle);
    assert.equal(end.kind, c.label === 'runner.after-exit-json' ? 'exited' : 'died');
    assertFired(trigger);
    assert.ok(handle.files.read('launch.json') !== null);
    if (c.label !== 'runner.after-exit-json') assert.equal(handle.files.read('exit.json'), null);
    assert.equal(handle.files.read('result.json'), null);
    await c.check(inv, handle);
  });
}

test('runner.crash.launch.after-launch-json', T, async () => {
  const inv = newInvocation();
  const trigger = writeTrigger(tmpDir('trigger'), { label: 'launch.after-launch-json', occurrence: 1 });
  const base = launchBase(inv, { argv: workload('workload-exit.ts', '0') });
  const run = await runFixture('runner-launcher.ts', [inv.invDir, JSON.stringify(base), 'exit'], {
    env: { ...process.env, ROADMAP_TEST_CRASH: trigger },
    timeoutMs: 10_000,
  });
  assert.equal(run.signal, 'SIGKILL', run.stderr);
  assertFired(trigger);
  const files = runnerFiles(inv.invDir, inv.inv);
  assert.ok(files.read('launch.json') !== null);
  assert.equal(existsSync(join(inv.invDir, 'runner.log')), false, 'no runner was started');
  assert.equal(files.read('runner.json'), null);
  assert.deepEqual(opMembers(inv.op), []);
});

test('runner.crash.launch.after-spawn', T, async () => {
  const inv = newInvocation();
  const trigger = writeTrigger(tmpDir('trigger'), { label: 'launch.after-spawn', occurrence: 1 });
  const base = launchBase(inv, { argv: workload('workload-exit.ts', '0') });
  const run = await runFixture('runner-launcher.ts', [inv.invDir, JSON.stringify(base), 'exit'], {
    env: { ...process.env, ROADMAP_TEST_CRASH: trigger },
    timeoutMs: 10_000,
  });
  assert.equal(run.signal, 'SIGKILL', run.stderr);
  assertFired(trigger);
  // The runner outlives the executor that started it and completes the invocation.
  const files = runnerFiles(inv.invDir, inv.inv);
  const exit = await waitFor('exit.json', 10_000, () => files.read('exit.json'));
  assert.equal(exit.cause, 'exited');
  const runner = files.read('runner.json');
  assert.ok(runner !== null);
  await waitFor('the runner to exit', 10_000, () => (isAlive(runner.runner) ? null : true));
  assert.deepEqual(opMembers(inv.op), []);
});
