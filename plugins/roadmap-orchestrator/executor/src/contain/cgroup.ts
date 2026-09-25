// cgroup v2 containment (R20), experimental. Each invocation gets a leaf `<root>/roadmap/<arc>/<seq>-<ordinal>/`
// with two children: `runner/` holds the runner (the controller) and `work/` holds the workload, so the
// controller is never a workload member. The workload enters `work/` through a fail-closed shell shim, and a
// kill is freeze → TERM → thaw → grace → `cgroup.kill` → `populated 0` → rmdir.
//
// The workload is spawned by session mode's `spawnWorkload` (the one way to spawn a workload), with its
// argv wrapped in the shim; process identities come from proc.ts.
//
// Interface files are read and written through the `fs` default object (not named imports) and signals go
// through `process.kill`: the protocol test (test/cgroup.test.ts) stands in for the kernel by spying on those
// calls under a fake root directory, since a plain directory cannot emulate cgroupfs semantics.
import fs from 'node:fs';
import { join } from 'node:path';
import type { Containment, SpawnedWorkload, WorkloadRef } from '../core/interfaces.ts';
import { type InvocationId, invocationDirName, parseInvocationId, parseOpId } from '../core/ids.ts';
import type { KillReason, LaunchFile, ProcIdentity } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { statOf } from './proc.ts';
import { spawnWorkload } from './session.ts';

/**
 * cgroup mode is not selectable in M1: detect.ts consults this and never picks cgroup while it is true.
 * Flipping it is a deliberate code change, allowed only after `contain.cgroup-real` has passed (run, not
 * skipped) on a host with a writable cgroup v2 tree delegated to the executor's uid. It is skipped here.
 */
export const CGROUP_EXPERIMENTAL = true;

export class CgroupError extends Error {
  readonly path: string;
  constructor(path: string, message: string, options?: ErrorOptions) {
    super(`cgroup ${path}: ${message}`, options);
    this.name = 'CgroupError';
    this.path = path;
  }
}

/** Filesystem paths of one invocation's leaf, and the `work/` cgroup as /proc/<pid>/cgroup names it. */
export type Leaf = Readonly<{ leaf: string; runner: string; work: string; workCgroup: string }>;

/**
 * `root` is the delegated subtree's directory on the cgroup2 mount; `rootCgroup` is the same cgroup's path
 * relative to the mount, as it appears in `/proc/self/cgroup` (`0::<rootCgroup>`).
 */
export function leafOf(root: AbsPath, rootCgroup: string, inv: InvocationId): Leaf {
  const arc = parseOpId(parseInvocationId(inv).op).arc;
  const rel = `roadmap/${arc}/${invocationDirName(inv)}`;
  const base = rootCgroup === '/' ? '' : rootCgroup;
  const leaf = join(root, rel);
  return { leaf, runner: join(leaf, 'runner'), work: join(leaf, 'work'), workCgroup: `${base}/${rel}/work` };
}

// The shim moves itself into work/, proves the move by its own /proc/self/cgroup line, and only then execs
// the command, keeping its pid. Either check failing exits non-zero before the command ever runs. The work
// dir and cgroup path are positional parameters, never interpolated, so no path needs shell quoting.
const SHIM = 'w=$1; g=$2; shift 2; echo $$ > "$w/cgroup.procs" && grep -qxF "0::$g" /proc/self/cgroup && exec "$@"';

/** The workload's full argv. The one builder, used by `launch` and by the fail-closed test. */
export function shimArgv(leaf: Leaf, argv: readonly string[]): readonly string[] {
  return ['/bin/sh', '-c', SHIM, 'roadmap-cgroup-shim', leaf.work, leaf.workCgroup, ...argv];
}

export function cgroupContainment(root: AbsPath, rootCgroup: string): Containment {
  if (!rootCgroup.startsWith('/') || (rootCgroup !== '/' && rootCgroup.endsWith('/'))) {
    throw new CgroupError(root, `rootCgroup must be an absolute cgroup path without a trailing slash, got ${JSON.stringify(rootCgroup)}`);
  }
  const leafFor = (inv: InvocationId): Leaf => leafOf(root, rootCgroup, inv);
  return {
    mode: 'cgroup',
    launch: (launch, invDir) => launchInto(leafFor(launch.inv), launch, invDir),
    members: (workload) => members(leafFor(workload.inv)),
    kill: (workload, reason, graceMs) => kill(leafFor(workload.inv), workload, reason, graceMs),
    empty: (workload) => {
      const l = leafFor(workload.inv);
      return !fs.existsSync(l.work) || !populated(l.work);
    },
  };
}

// ---------------------------------------------------------------------------------------------------

function launchInto(l: Leaf, launch: LaunchFile, invDir: AbsPath): Promise<SpawnedWorkload> {
  fs.mkdirSync(join(l.leaf, '..'), { recursive: true });
  fs.mkdirSync(l.leaf); // EEXIST is loud: an invocation's leaf is created exactly once.
  fs.mkdirSync(l.runner);
  fs.mkdirSync(l.work);
  writeInterface(l.runner, 'cgroup.procs', `${process.pid}\n`);
  return spawnWorkload(shimArgv(l, launch.argv), launch, invDir);
}

function members(l: Leaf): readonly ProcIdentity[] {
  if (!fs.existsSync(l.work)) return [];
  const out: ProcIdentity[] = [];
  for (const pid of procs(l.work)) {
    const stat = statOf(pid);
    if (stat !== null) out.push({ pid, start: stat.start }); // null: exited between the two reads, so not a member
  }
  return out;
}

async function kill(l: Leaf, workload: WorkloadRef, reason: KillReason, graceMs: number): Promise<void> {
  // Idempotent: a repeated kill (recovery, or the executor after the runner exited) finishes what is left.
  if (fs.existsSync(l.work)) {
    writeInterface(l.work, 'cgroup.freeze', '1');
    for (const pid of procs(l.work)) term(pid);
    writeInterface(l.work, 'cgroup.freeze', '0');
    await untilUnpopulated(l.work, graceMs); // TERM gets its grace; cgroup.kill follows either way
    writeInterface(l.work, 'cgroup.kill', '1');
    if (!(await untilUnpopulated(l.work, graceMs))) {
      throw new CgroupError(l.work, `still populated ${graceMs} ms after cgroup.kill (inv ${workload.inv}, reason ${reason})`);
    }
    rmdir(l.work);
  }
  // A live runner killing its own workload (deadline) sits in runner/, which the kernel will not remove;
  // runner/ and the leaf are then removed by the next kill of this workload, after the runner has exited.
  if (fs.existsSync(l.runner)) {
    if (procs(l.runner).includes(process.pid)) return;
    rmdir(l.runner);
  }
  if (fs.existsSync(l.leaf)) rmdir(l.leaf);
}

// ---------------------------------------------------------------------------------------------------

function writeInterface(dir: string, file: string, value: string): void {
  const path = join(dir, file);
  try {
    fs.writeFileSync(path, value, { flag: 'r+' }); // r+: an interface file is never created, only written
  } catch (error) {
    throw new CgroupError(path, `write ${JSON.stringify(value)} refused`, { cause: error });
  }
}

function readInterface(dir: string, file: string): string {
  const path = join(dir, file);
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (error) {
    throw new CgroupError(path, 'unreadable', { cause: error });
  }
}

function procs(dir: string): readonly number[] {
  return readInterface(dir, 'cgroup.procs').split('\n').filter((line) => line !== '').map((line) => {
    const pid = Number(line);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new CgroupError(join(dir, 'cgroup.procs'), `not a pid: ${JSON.stringify(line)}`);
    return pid;
  });
}

function populated(dir: string): boolean {
  const text = readInterface(dir, 'cgroup.events');
  const m = /^populated ([01])$/m.exec(text);
  if (m === null) throw new CgroupError(join(dir, 'cgroup.events'), `no populated line in ${JSON.stringify(text)}`);
  return m[1] === '1';
}

async function untilUnpopulated(dir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!populated(dir)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function term(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; // ESRCH: already exited
  }
}

function rmdir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch (error) {
    throw new CgroupError(dir, 'rmdir refused', { cause: error });
  }
}
