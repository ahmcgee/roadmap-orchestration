// cgroup containment (R20), experimental. Three tests from the plan:
// - contain.cgroup-protocol: a fake root directory, with a tiny in-process fake kernel standing in for
//   cgroupfs by spying on the `fs` calls cgroup.ts makes (mkdir populates interface files, cgroup.procs
//   writes append, a cgroup.kill write flips `populated 0`, rmdir drops interface files first). It records
//   every interface write, signal and rmdir so the exact sequence can be asserted.
// - contain.cgroup-fail-closed: the real shim, run against fake leaves where entry cannot succeed.
// - contain.cgroup-real: the real protocol on a real leaf, only where cgroup v2 is writable and delegated to
//   this uid. On this host it is not, so it is skipped and reported NOT RUN, never as a pass.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { CGROUP_EXPERIMENTAL, CgroupError, cgroupContainment, type Leaf, leafOf, shimArgv } from '../src/contain/cgroup.ts';
import { arcId, invocationIdOf, opIdOf } from '../src/core/ids.ts';
import type { WorkloadRef } from '../src/core/interfaces.ts';
import type { LaunchFile } from '../src/core/records.ts';
import { absPath, isoTimeOf } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { fixture, runUntilExit } from './helpers/proc.ts';

const inv = invocationIdOf('arc-1/7#2');
const ref: WorkloadRef = { inv, child: null };
const ROOT_CGROUP = '/fake.slice/delegated';
const INTERFACE: Readonly<Record<string, string>> = {
  'cgroup.procs': '',
  'cgroup.events': 'populated 0\nfrozen 0\n',
  'cgroup.freeze': '0',
  'cgroup.kill': '',
};

function tempDir(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function launchFor(invDir: string, argv: readonly string[]): LaunchFile {
  return {
    v: SCHEMA_VERSION, arc: arcId('arc-1'), op: opIdOf('arc-1/7'), inv,
    argv, cwd: absPath(invDir), env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, stdinPath: null,
    deadlineAt: isoTimeOf(new Date(Date.now() + 60_000)), graceMs: 1000, containment: 'cgroup', test: null,
    terminal: { type: 'command', purpose: 'probe', expectedExit: 0 },
  };
}

// ---------------------------------------------------------------------------------------------------
// The fake kernel.

type Fake = { readonly root: string; readonly log: string[]; flipOnKill: boolean };

function fakeKernel(t: TestContext, root: string): Fake {
  const fake: Fake = { root, log: [], flipOnKill: true };
  const real = { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, rmdirSync: fs.rmdirSync, kill: process.kill };
  const inRoot = (p: unknown): p is string => typeof p === 'string' && p.startsWith(`${root}/`);
  const rel = (p: string): string => relative(root, p);
  const populate = (dir: string): void => {
    for (const [name, content] of Object.entries(INTERFACE)) {
      if (!fs.existsSync(join(dir, name))) real.writeFileSync.call(fs, join(dir, name), content);
    }
  };

  t.mock.method(fs, 'mkdirSync', ((path: string, options?: fs.MakeDirectoryOptions) => {
    const created = real.mkdirSync.call(fs, path, options);
    if (inRoot(path)) {
      fake.log.push(`mkdir ${rel(path)}`);
      for (let dir = path; dir !== root; dir = join(dir, '..')) populate(dir);
    }
    return created;
  }) as typeof fs.mkdirSync);

  t.mock.method(fs, 'writeFileSync', ((path: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
    if (!inRoot(path)) return real.writeFileSync.call(fs, path, data, options);
    fake.log.push(`write ${rel(path)} ${data.trim()}`);
    fs.accessSync(path, fs.constants.W_OK); // missing or read-only interface file: refused, as the kernel would
    const dir = join(path, '..');
    const name = path.slice(dir.length + 1);
    if (name === 'cgroup.procs') {
      real.writeFileSync.call(fs, path, data, { flag: 'a' });
      real.writeFileSync.call(fs, join(dir, 'cgroup.events'), 'populated 1\nfrozen 0\n');
    } else if (name === 'cgroup.kill' && fake.flipOnKill) {
      real.writeFileSync.call(fs, join(dir, 'cgroup.procs'), '');
      real.writeFileSync.call(fs, join(dir, 'cgroup.events'), 'populated 0\nfrozen 0\n');
    } else {
      real.writeFileSync.call(fs, path, data);
    }
  }) as typeof fs.writeFileSync);

  t.mock.method(fs, 'rmdirSync', ((path: string) => {
    if (inRoot(path)) {
      fake.log.push(`rmdir ${rel(path)}`);
      for (const name of Object.keys(INTERFACE)) fs.rmSync(join(path, name), { force: true });
    }
    real.rmdirSync.call(fs, path);
  }) as typeof fs.rmdirSync);

  t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => {
    fake.log.push(`signal ${pid} ${String(signal)}`);
    return real.kill.call(process, pid, signal);
  }) as typeof process.kill);

  return fake;
}

/** A leaf as the kernel presents it: three cgroups with their interface files. */
function makeLeaf(root: string): Leaf {
  const l = leafOf(absPath(root), ROOT_CGROUP, inv);
  for (const dir of [l.runner, l.work]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const d of [l.leaf, dir]) {
      for (const [name, content] of Object.entries(INTERFACE)) fs.writeFileSync(join(d, name), content);
    }
  }
  return l;
}

/** Real processes to stand in the fake work/ cgroup; resolves each one's exit signal. */
function sleepers(t: TestContext, l: Leaf, n: number): { pids: number[]; ended: Promise<(NodeJS.Signals | null)[]> } {
  const children: ChildProcess[] = [];
  for (let i = 0; i < n; i++) children.push(spawn('sleep', ['30'], { stdio: 'ignore' }));
  t.after(() => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); });
  const pids = children.map((c) => c.pid ?? assert.fail('sleep did not spawn'));
  fs.writeFileSync(join(l.work, 'cgroup.procs'), pids.map((p) => `${p}\n`).join(''));
  fs.writeFileSync(join(l.work, 'cgroup.events'), 'populated 1\nfrozen 0\n');
  const ended = Promise.all(children.map((c) => new Promise<NodeJS.Signals | null>((resolve) => c.once('exit', (_code, sig) => resolve(sig)))));
  return { pids, ended };
}

const REL = 'roadmap/arc-1/7-2';

// ---------------------------------------------------------------------------------------------------

describe('contain.cgroup-protocol', () => {
  it('is experimental and not selectable', () => {
    assert.equal(CGROUP_EXPERIMENTAL, true);
  });

  it('places the leaf per invocation and names work/ as /proc/self/cgroup will', () => {
    const l = leafOf(absPath('/sys/fs/cgroup/d'), '/d', inv);
    assert.deepEqual(l, {
      leaf: `/sys/fs/cgroup/d/${REL}`, runner: `/sys/fs/cgroup/d/${REL}/runner`, work: `/sys/fs/cgroup/d/${REL}/work`,
      workCgroup: `/d/${REL}/work`,
    });
    assert.equal(leafOf(absPath('/sys/fs/cgroup'), '/', inv).workCgroup, `/${REL}/work`);
    assert.throws(() => cgroupContainment(absPath('/x'), 'd/'), CgroupError);
  });

  it('launch creates the leaf, puts the runner in runner/ and the workload behind the shim', async (t) => {
    const root = tempDir(t, 'cgroup-fake-');
    const invDir = tempDir(t, 'cgroup-inv-');
    const marker = join(invDir, 'ran');
    const fake = fakeKernel(t, root);
    const spawned = await cgroupContainment(absPath(root), ROOT_CGROUP).launch(launchFor(invDir, ['touch', marker]), absPath(invDir));
    assert.equal(spawned.kind, 'spawned', JSON.stringify(spawned));
    if (spawned.kind !== 'spawned') throw new Error('unreachable');
    const { child } = spawned;
    assert.deepEqual(fake.log, [
      'mkdir roadmap/arc-1', `mkdir ${REL}`, `mkdir ${REL}/runner`, `mkdir ${REL}/work`,
      `write ${REL}/runner/cgroup.procs ${process.pid}`,
    ]);
    assert.equal(child.sid, child.pid);
    // The fake's work/ is not the shim's real cgroup, so entry fails closed: the command never runs.
    const until = Date.now() + 5000;
    while (fs.existsSync(`/proc/${child.pid}`)) {
      assert.ok(Date.now() < until, `shim ${child.pid} still running after 5 s`);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(join(root, REL, 'work/cgroup.procs'), 'utf8'), `${child.pid}\n`);
    assert.deepEqual(await spawned.ended, { type: 'exited', code: 1 }); // the shim's failed membership check
  });

  it('kill: freeze, TERM each member, thaw, cgroup.kill, populated 0, rmdir work, runner, leaf', async (t) => {
    const root = tempDir(t, 'cgroup-fake-');
    const l = makeLeaf(root);
    const { pids, ended } = sleepers(t, l, 2);
    const c = cgroupContainment(absPath(root), ROOT_CGROUP);
    assert.deepEqual(c.members(ref).map((m) => m.pid), pids);
    assert.equal(c.empty(ref), false);

    const fake = fakeKernel(t, root);
    await c.kill(ref, 'stop', 50);
    assert.deepEqual(fake.log, [
      `write ${REL}/work/cgroup.freeze 1`,
      ...pids.map((p) => `signal ${p} SIGTERM`),
      `write ${REL}/work/cgroup.freeze 0`,
      `write ${REL}/work/cgroup.kill 1`,
      `rmdir ${REL}/work`, `rmdir ${REL}/runner`, `rmdir ${REL}`,
    ]);
    assert.deepEqual(await ended, ['SIGTERM', 'SIGTERM']);
    assert.equal(fs.existsSync(l.leaf), false);
    assert.equal(c.empty(ref), true);
    assert.deepEqual(c.members(ref), []);
  });

  it('kill by the live runner removes work/ only; a later kill removes runner/ and the leaf', async (t) => {
    const root = tempDir(t, 'cgroup-fake-');
    const l = makeLeaf(root);
    fs.writeFileSync(join(l.runner, 'cgroup.procs'), `${process.pid}\n`);
    const c = cgroupContainment(absPath(root), ROOT_CGROUP);
    const fake = fakeKernel(t, root);
    await c.kill(ref, 'deadline', 20);
    assert.deepEqual(fake.log, [
      `write ${REL}/work/cgroup.freeze 1`, `write ${REL}/work/cgroup.freeze 0`, `write ${REL}/work/cgroup.kill 1`,
      `rmdir ${REL}/work`,
    ]);
    assert.equal(fs.existsSync(l.runner), true);

    fs.truncateSync(join(l.runner, 'cgroup.procs')); // the runner has exited (behind the fake's back)
    fake.log.length = 0;
    await c.kill(ref, 'recovery', 20);
    assert.deepEqual(fake.log, [`rmdir ${REL}/runner`, `rmdir ${REL}`]);
  });

  it('missing cgroup.procs is a loud error', async (t) => {
    const root = tempDir(t, 'cgroup-fake-');
    const l = makeLeaf(root);
    fs.rmSync(join(l.work, 'cgroup.procs'));
    const c = cgroupContainment(absPath(root), ROOT_CGROUP);
    assert.throws(() => c.members(ref), (e: unknown) => e instanceof CgroupError && e.path === join(l.work, 'cgroup.procs'));
    const fake = fakeKernel(t, root);
    await assert.rejects(c.kill(ref, 'stop', 20), (e: unknown) => e instanceof CgroupError && e.path === join(l.work, 'cgroup.procs'));
    assert.deepEqual(fake.log, [`write ${REL}/work/cgroup.freeze 1`]);
    assert.equal(fs.existsSync(l.work), true);
  });

  it('missing cgroup.events is a loud error', (t) => {
    const root = tempDir(t, 'cgroup-fake-');
    const l = makeLeaf(root);
    fs.rmSync(join(l.work, 'cgroup.events'));
    assert.throws(() => cgroupContainment(absPath(root), ROOT_CGROUP).empty(ref), CgroupError);
  });

  it('a refused write is a loud error and nothing is signalled', async (t) => {
    const root = tempDir(t, 'cgroup-fake-');
    const l = makeLeaf(root);
    sleepers(t, l, 1);
    fs.chmodSync(join(l.work, 'cgroup.freeze'), 0o444);
    const fake = fakeKernel(t, root);
    await assert.rejects(cgroupContainment(absPath(root), ROOT_CGROUP).kill(ref, 'stop', 20),
      (e: unknown) => e instanceof CgroupError && e.path === join(l.work, 'cgroup.freeze') && /refused/.test(e.message));
    assert.deepEqual(fake.log, [`write ${REL}/work/cgroup.freeze 1`]);
  });

  it('populated never reaching 0 is a loud error and the leaf stays', async (t) => {
    const root = tempDir(t, 'cgroup-fake-');
    const l = makeLeaf(root);
    sleepers(t, l, 1);
    const fake = fakeKernel(t, root);
    fake.flipOnKill = false;
    const started = Date.now();
    await assert.rejects(cgroupContainment(absPath(root), ROOT_CGROUP).kill(ref, 'stop', 100),
      (e: unknown) => e instanceof CgroupError && /still populated 100 ms after cgroup\.kill/.test(e.message));
    assert.ok(Date.now() - started >= 200, 'grace and the kill wait each ran their full bound');
    assert.equal(fake.log.some((line) => line.startsWith('rmdir')), false);
    assert.equal(fs.existsSync(l.work), true);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('contain.cgroup-fail-closed', () => {
  const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const selfCgroup = (): string => {
    const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((s) => s.startsWith('0::'));
    return line?.slice(3) ?? assert.fail('no cgroup v2 line in /proc/self/cgroup');
  };

  async function runShim(t: TestContext, l: Leaf): Promise<{ code: number | null; ran: boolean }> {
    const marker = join(tempDir(t, 'cgroup-marker-'), 'ran');
    const [cmd, ...args] = shimArgv(l, ['touch', marker]) as [string, ...string[]];
    const exit = await runUntilExit(cmd, args, { env, timeoutMs: 10_000 });
    return { code: exit.code, ran: fs.existsSync(marker) };
  }

  it('control: with the write and the membership line both succeeding, the command runs', async (t) => {
    const l = makeLeaf(tempDir(t, 'cgroup-fake-'));
    assert.deepEqual(await runShim(t, { ...l, workCgroup: selfCgroup() }), { code: 0, ran: true });
  });

  it('a refused cgroup.procs write: the command never runs', async (t) => {
    const l = makeLeaf(tempDir(t, 'cgroup-fake-'));
    fs.chmodSync(join(l.work, 'cgroup.procs'), 0o444);
    const r = await runShim(t, { ...l, workCgroup: selfCgroup() }); // membership would match: only the write fails
    assert.equal(r.ran, false);
    assert.notEqual(r.code, 0);
  });

  it('a missing work/ cgroup: the command never runs', async (t) => {
    const l = makeLeaf(tempDir(t, 'cgroup-fake-'));
    fs.rmSync(l.work, { recursive: true });
    const r = await runShim(t, { ...l, workCgroup: selfCgroup() });
    assert.equal(r.ran, false);
    assert.notEqual(r.code, 0);
  });

  it('/proc/self/cgroup not naming work/: the command never runs', async (t) => {
    const l = makeLeaf(tempDir(t, 'cgroup-fake-'));
    const r = await runShim(t, l);
    assert.equal(r.ran, false);
    assert.notEqual(r.code, 0);
    assert.match(fs.readFileSync(join(l.work, 'cgroup.procs'), 'utf8'), /^[0-9]+\n$/); // the write itself happened
  });
});

// ---------------------------------------------------------------------------------------------------

/** This process's cgroup when cgroup v2 is mounted writable and the cgroup is writable by this uid; else why not. */
function delegatedSelf(): { root: string; rootCgroup: string } | { why: string } {
  const own = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((s) => s.startsWith('0::'))?.slice(3);
  if (own === undefined) return { why: 'no cgroup v2 membership' };
  const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((l) => l.split(' '))
    .find((f) => f[f.indexOf('-') + 1] === 'cgroup2');
  if (mount === undefined) return { why: 'cgroup v2 is not mounted' };
  const [, , , mountRoot = '', mountPoint = '', options = ''] = mount;
  if (options.split(',').includes('ro')) return { why: 'cgroup v2 is read-only on this host' };
  if (!own.startsWith(mountRoot)) return { why: `own cgroup ${own} is outside the mount root ${mountRoot}` };
  const root = join(mountPoint, relative(mountRoot, own));
  try {
    fs.accessSync(root, fs.constants.W_OK);
    fs.accessSync(join(root, 'cgroup.procs'), fs.constants.W_OK);
  } catch (error) {
    return { why: `cgroup ${own} is not delegated to uid ${process.getuid?.()} (${(error as Error).message})` };
  }
  return { root, rootCgroup: own };
}

describe('contain.cgroup-real', () => {
  it('runs the real protocol on a real leaf', async (t) => {
    const host = delegatedSelf();
    if ('why' in host) {
      t.skip(`NOT RUN: ${host.why}`);
      return;
    }
    const invDir = tempDir(t, 'cgroup-inv-');
    const launchPath = join(invDir, 'launch.json');
    fs.writeFileSync(launchPath, JSON.stringify(launchFor(invDir, ['sleep', '30'])));
    const runner = await runUntilExit(process.execPath, [fixture('cgroup-real-runner.ts'), host.root, host.rootCgroup, invDir, launchPath],
      { env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, timeoutMs: 10_000 });
    assert.equal(runner.code, 0, runner.stderr);
    const child = JSON.parse(runner.stdout) as { pid: number; start: number };

    const c = cgroupContainment(absPath(host.root), host.rootCgroup);
    const l = leafOf(absPath(host.root), host.rootCgroup, inv);
    assert.deepEqual(c.members(ref), [{ pid: child.pid, start: child.start }]);
    assert.equal(fs.readFileSync(`/proc/${child.pid}/cgroup`, 'utf8').trim(), `0::${l.workCgroup}`);
    assert.equal(c.empty(ref), false);
    await c.kill(ref, 'stop', 2000);
    assert.equal(c.empty(ref), true);
    assert.equal(fs.existsSync(l.leaf), false);
  });
});
