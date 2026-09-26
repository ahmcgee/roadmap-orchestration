// Session containment against real process trees. Every workload runs under the real runner, launched the
// way the executor launches it; the escape tests pin the narrowed guarantee (plan: "Narrowed guarantee").
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { containmentFor, detectContainmentMode } from '../src/contain/detect.ts';
import { isAlive, scan, signal } from '../src/contain/proc.ts';
import { ENV_INV, killSet, members, opMembers, sessionContainment } from '../src/contain/session.ts';
import type { ProcIdentity } from '../src/core/records.ts';
import { awaitRunner, cancel, prepareLaunch, startRunner } from '../src/runner/launch.ts';
import { barrierDir, reached } from './helpers/barrier.ts';
import {
  assertGone, identityFromFile, launchBase, newInvocation, waitFor, waitForChild, workload,
} from './helpers/invocation.ts';

const T = { timeout: 30_000 };

const key = (p: ProcIdentity): string => `${p.pid}:${p.start}`;
const keys = (ps: readonly ProcIdentity[]): string[] => ps.map(key).sort();

/** The pid a workload-fork fixture printed on its stdout. */
async function forkedIdentity(invDir: string): Promise<ProcIdentity> {
  const path = join(invDir, 'stdout');
  await waitFor('workload-fork to print its descendant', 10_000, () =>
    existsSync(path) && readFileSync(path, 'utf8').endsWith('\n') ? true : null);
  return identityFromFile(path);
}

test('contain.detect-session', () => {
  assert.equal(detectContainmentMode(), 'session');
  assert.equal(containmentFor('session'), sessionContainment);
  assert.throws(() => containmentFor('cgroup'), /not selectable in M1 builds/);
});

test('contain.kill-tree', T, async () => {
  const inv = newInvocation();
  const dir = barrierDir();
  // Every level ignores SIGTERM, so the kill must escalate to SIGKILL after the grace.
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, { argv: workload('workload-tree.ts', dir, '3', '1', '--ignore-term'), graceMs: 1000 })));
  const { child } = await waitForChild(handle, 10_000);
  for (const level of [1, 2, 3]) await reached(dir, `level-${level}`, 10_000);
  const tree = [1, 2, 3].map((level) => identityFromFile(join(dir, `level-${level}.reached`)));
  assert.equal(tree[0]?.pid, child.pid);
  const ref = { inv: inv.inv, child };
  assert.deepEqual(keys(sessionContainment.members(ref)), keys(tree));

  // The executor's recovery path: kill from outside the runner.
  await sessionContainment.kill(ref, 'recovery', 300);
  assertGone(tree);
  assert.equal(sessionContainment.empty(ref), true);

  const end = await awaitRunner(handle);
  assert.equal(end.kind, 'exited');
  assert.equal(end.kind === 'exited' && end.exit.child.type, 'signalled');
});

test('contain.growing-tree-stable-set', T, async () => {
  const inv = newInvocation();
  const dir = barrierDir();
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, { argv: workload('workload-growing.ts', dir), graceMs: 1000 })));
  const { child } = await waitForChild(handle, 10_000);
  await reached(dir, 'growing', 10_000);
  const ref = { inv: inv.inv, child };
  const before = sessionContainment.members(ref);
  assert.ok(before.length > 20, `expected a grown tree, found ${before.length} members`);

  // The spawner is still forking every 10 ms while the stop loop runs.
  await sessionContainment.kill(ref, 'stop', 300);
  assert.deepEqual(sessionContainment.members(ref), []);
  assertGone(before);
  await awaitRunner(handle);
});

test('contain.runner-not-in-kill-set', T, async () => {
  const inv = newInvocation();
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, { argv: workload('workload-hang.ts') })));
  const { child, runner } = await waitForChild(handle, 10_000);
  const ref = { inv: inv.inv, child };

  // The runner carries ROADMAP_INV=<inv> itself: only its role keeps it out of the set.
  const runnerProc = scan().find((p) => p.pid === runner.pid);
  assert.equal(runnerProc?.env?.get(ENV_INV), inv.inv);
  assert.equal(runnerProc?.env?.get('ROADMAP_ROLE'), 'runner');
  assert.deepEqual(keys(sessionContainment.members(ref)), keys([child]));

  // The runner kills its workload and survives to write exit.json itself.
  cancel(handle, 'stop');
  const exit = await waitFor('exit.json', 10_000, () => handle.files.read('exit.json'));
  assert.equal(exit.cause, 'cancel');
  assert.equal(isAlive(child), false);
  const end = await awaitRunner(handle);
  assert.equal(end.kind, 'exited');
  assert.equal(readFileSync(join(inv.invDir, 'runner.log'), 'utf8'), '', 'the runner logged an error');
});

test('contain.op-scan-finds-stray-ordinals', T, async () => {
  const inv = newInvocation();
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, { argv: workload('workload-hang.ts') })));
  const { child } = await waitForChild(handle, 10_000);
  // A dead runner leaves a stray workload; the op-wide scan finds it (and would find any earlier ordinal).
  signal(handle.runner, 'SIGKILL');
  assert.equal((await awaitRunner(handle)).kind, 'died');
  assert.deepEqual(keys(opMembers(inv.op)), keys([child]));
  await killSet(() => opMembers(inv.op), 300);
  assert.deepEqual(opMembers(inv.op), []);
});

test('contain.setsid-keep-env-caught', T, async () => {
  const inv = newInvocation();
  const out = join(inv.root, 'late-write');
  // The workload exits at once; its setsid descendant keeps ROADMAP_INV and writes 800 ms later.
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, {
    argv: workload('workload-fork.ts', 'setsid', 'keep', 'exit', 'workload-write-later.ts', '800', '0', out),
  })));
  const escapee = await forkedIdentity(inv.invDir);
  const { child } = await waitForChild(handle, 10_000);
  assert.ok(keys(members({ inv: inv.inv, child })).includes(key(escapee)), 'found by ROADMAP_INV despite setsid');
  const end = await awaitRunner(handle);
  assert.equal(end.kind, 'exited');
  // exit.json was written only after the descendant wrote and exited.
  assert.equal(existsSync(out), true);
  assertGone([escapee]);
});

// The four escape tests below pin the narrowed guarantee of session mode: a descendant that calls setsid()
// and execs with a cleared environment is invisible to membership. Each asserts that the escape happens
// and is not detected. This is the documented limit of session containment, not a bug.

test('contain.escape-verification-tree', T, async () => {
  const inv = newInvocation();
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, {
    argv: workload('workload-fork.ts', 'setsid', 'clear', 'exit', 'workload-hang.ts'),
  })));
  const escapee = await forkedIdentity(inv.invDir);
  try {
    const { child } = await waitForChild(handle, 10_000);
    const ref = { inv: inv.inv, child };
    const found = scan().find((p) => p.pid === escapee.pid);
    assert.ok(found !== undefined, 'the escapee is running');
    assert.notEqual(found.sid, child.sid, 'the escapee left the workload session');
    assert.equal(found.env?.size, 0, 'the escapee has no environment, so no ROADMAP_INV');
    assert.equal(keys(members(ref)).includes(key(escapee)), false, 'membership does not find it');

    // The runner certifies quiescence once the found set is empty, while the escapee still runs. The
    // verification-tree dirty assertion (a later step) is what catches such a process writing the tree.
    const end = await awaitRunner(handle);
    assert.equal(end.kind === 'exited' && end.exit.cause, 'exited');
    assert.equal(sessionContainment.empty(ref), true);
    assert.equal(isAlive(escapee), true);
  } finally {
    signal(escapee, 'SIGKILL');
  }
});

test('contain.escape-original-worktree', T, async () => {
  const inv = newInvocation();
  const worktree = join(inv.root, 'worktree');
  mkdirSync(worktree);
  const file = join(worktree, 'escaped-writes');
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, {
    argv: workload('workload-fork.ts', 'setsid', 'clear', 'exit', 'workload-write-later.ts', '0', '50', file),
  })));
  const escapee = await forkedIdentity(inv.invDir);
  try {
    const end = await awaitRunner(handle);
    assert.equal(end.kind, 'exited');
    await waitFor('the first escaped write', 10_000, () => (existsSync(file) ? true : null));
    const sizeAtCertification = statSync(file).size;
    // Not caught: the original unit worktree keeps changing after exit.json certified quiescence.
    await waitFor('writes after certification', 10_000, () => (statSync(file).size > sizeAtCertification ? true : null));
  } finally {
    signal(escapee, 'SIGKILL');
  }
});

test('contain.escape-external', T, async () => {
  const inv = newInvocation();
  const portFile = join(inv.root, 'port');
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, {
    argv: workload('workload-fork.ts', 'setsid', 'clear', 'exit', 'workload-listen.ts', portFile),
  })));
  const escapee = await forkedIdentity(inv.invDir);
  try {
    assert.equal((await awaitRunner(handle)).kind, 'exited');
    const port = Number(await waitFor('the escapee to listen', 10_000, () => (existsSync(portFile) ? readFileSync(portFile, 'utf8') : null)));
    // Not caught: an undeclared external resource (a listening socket) is still held after certification.
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      socket.on('data', (chunk) => (data += chunk.toString()));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.equal(reply, 'held\n');
  } finally {
    signal(escapee, 'SIGKILL');
  }
});

test('contain.escape-delayed', T, async () => {
  const inv = newInvocation();
  const file = join(inv.root, 'delayed-write');
  const handle = startRunner(inv.invDir, prepareLaunch(launchBase(inv, {
    argv: workload('workload-fork.ts', 'setsid', 'clear', 'exit', 'workload-write-later.ts', '1500', '0', file),
  })));
  const escapee = await forkedIdentity(inv.invDir);
  try {
    assert.equal((await awaitRunner(handle)).kind, 'exited');
    assert.equal(existsSync(file), false, 'nothing written yet when exit.json certified quiescence');
    // Not caught: the write lands after every check has passed.
    await waitFor('the delayed write', 10_000, () => (existsSync(file) ? true : null));
  } finally {
    signal(escapee, 'SIGKILL');
  }
});
