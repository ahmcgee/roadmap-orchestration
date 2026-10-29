// The runner: `node src/entry/runner.ts <invDir>`, launched detached by launch.ts. It is the invocation's
// controller and never a workload member (ROADMAP_ROLE=runner). It owns the workload from spawn to
// quiescence on its own, so a dead executor cannot leave a workload past its deadline:
//
//   verify session leader → umask 022 → runner.json (child: null) → spawn workload → runner.json (child)
//   → wait for child exit | deadlineAt | stall | cancel.json | reported → wait until the workload is empty (killing
//   it on deadline, stall, cancel or reported, also while waiting for descendants) → exit.json → exit 0.
//
// Reported (src/runner/report.ts): a backend whose schema declares `final` ends with its final report, not with its
// process. Once the latest report on its output is schema-valid and `final: true`, and the workload is still running
// REPORT_GRACE_MS later (a pending wake-up or monitor keeps the CLI alive, or descendants outlive it), the runner kills
// it with cause `reported` and the adapter reads that report. An interim report (`final: false`, a turn ended to wait)
// never ends anything; waiting is unrestricted until the final report, and the deadline stays the backstop.
//
// Cpu wait (M4b rev 3): at every poll the runner reads the schedstat of every thread of the workload
// (src/host/pressure.ts `WorkloadCpu`: the members when the stall watchdog or the descendants' wait scans
// them, else the child's process tree) and writes the totals, with the wall time from spawn to quiescence,
// as exit.json's `cpu` (null on a host without schedstat): the launch's pressure is read from them.
//
// Stall watchdog (launch.json `stallMs`, lanes only): at every poll the runner takes the workload's progress
// mark, its members' total CPU time, which members exist, and the sizes of its stdout and stderr. A mark
// unchanged for `stallMs` is a hang (a deadlock, a wait on something that never comes) and is killed with
// cause `stall`. A slow workload that is working moves its mark and runs on, up to the deadline, which is
// only a backstop for a busy loop.
//
// It writes runner.json and exit.json only. It never runs the adapter and never writes result.json: the
// executor's adapter does that once exit.json exists.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { containmentFor } from '../contain/detect.ts';
import { identityOf, readBootId, statOf } from '../contain/proc.ts';
import { ENV_INV } from '../contain/session.ts';
import { crashPoint } from '../core/crash.ts';
import { invocationIdOf } from '../core/ids.ts';
import type { WorkloadRef } from '../core/interfaces.ts';
import { type ChildEnd, type ExitCause, type ExitFile, type KillReason, type ProcIdentity, STDERR_FILE, STDOUT_FILE } from '../core/records.ts';
import { type IsoTime, absPath, isoTimeOf } from '../core/values.ts';
import { WorkloadCpu, pressureAvailability } from '../host/pressure.ts';
import { runnerFiles } from './files.ts';
import { REPORT_GRACE_MS, reportWatch } from './report.ts';

/** cancel.json is polled at this interval while the child runs. */
const CANCEL_POLL_MS = 500;
/** Membership is rescanned at this interval while descendants outlive the child. */
const QUIESCE_POLL_MS = 100;

type Stop = Readonly<{ cause: Exclude<ExitCause, 'exited'>; reason: KillReason }>;

const now = (): IsoTime => isoTimeOf(new Date());

/** The workload's progress mark: equal marks mean nothing moved in between. */
function progressMark(members: readonly ProcIdentity[], invDir: string): string {
  let cpu = 0;
  const alive: string[] = [];
  for (const m of members) {
    const stat = statOf(m.pid);
    if (stat === null || stat.start !== m.start) continue;
    cpu += stat.cpu;
    alive.push(`${m.pid}:${m.start}`);
  }
  const size = (name: string): number => statSync(join(invDir, name)).size;
  return `${cpu}|${size(STDOUT_FILE)}|${size(STDERR_FILE)}|${alive.sort().join(',')}`;
}

/** The runner process's main (src/entry/runner.ts); the entry exits 0 once it returns. */
export async function runnerMain(): Promise<void> {
  const invDir = absPath(process.argv[2], 'argv[2] (invocation dir)');
  const inv = invocationIdOf(process.env[ENV_INV], ENV_INV);
  const self = identityOf(process.pid);
  if (self.sid !== process.pid) throw new Error(`runner ${process.pid} is not a session leader (sid ${self.sid}); launch it detached`);
  process.umask(0o022);

  const files = runnerFiles(invDir, inv);
  const launch = files.read('launch.json');
  if (launch === null) throw new Error(`${invDir}/launch.json is missing`);
  const binding = { v: launch.v, arc: launch.arc, op: launch.op, inv: launch.inv };
  const containment = containmentFor(launch.containment);
  const runner = { pid: self.pid, start: self.start, bootId: readBootId() };
  const deadline = new Date(launch.deadlineAt).getTime();

  let mark: Readonly<{ value: string; since: number }> | null = null;
  const stalled = (members: readonly ProcIdentity[]): boolean => {
    if (launch.stallMs === null) return false;
    const value = progressMark(members, invDir);
    const t = Date.now();
    if (mark === null || mark.value !== value) mark = { value, since: t };
    return t - mark.since >= launch.stallMs;
  };

  const report = reportWatch(launch.terminal);
  let reportedSince: number | null = null;
  /** The latest report has been final for REPORT_GRACE_MS (a newer interim report restarts the count). */
  const reported = (): boolean => {
    if (report === null) return false;
    if (!report()) {
      reportedSince = null;
      return false;
    }
    reportedSince ??= Date.now();
    return Date.now() - reportedSince >= REPORT_GRACE_MS;
  };

  const cpu = pressureAvailability() === 'available' ? new WorkloadCpu() : null;
  /**
   * One poll. The membership scan runs when the stall watchdog needs it or once the child has exited (descendants
   * only); otherwise the cpu wait reads the child's process tree, which costs no scan of every process.
   */
  const stopRequested = (workload: WorkloadRef & Readonly<{ child: ProcIdentity }>, childExited: boolean): Stop | null => {
    const members = launch.stallMs !== null || childExited ? containment.members(workload) : null;
    if (members !== null) cpu?.observe(members);
    else cpu?.observeTree(workload.child);
    const cancel = files.read('cancel.json');
    if (cancel !== null) return cancel.reason === 'recovery' ? { cause: 'recovery-kill', reason: 'recovery' } : { cause: 'cancel', reason: cancel.reason };
    if (Date.now() >= deadline) return { cause: launch.terminal.type === 'command' && launch.terminal.timeoutMin !== undefined ? 'timeout' : 'deadline', reason: 'deadline' };
    if (reported()) return { cause: 'reported', reason: 'reported' };
    return members !== null && stalled(members) ? { cause: 'stall', reason: 'stall' } : null;
  };

  crashPoint('runner.before-runner-json');
  files.write('runner.json', { ...binding, runner, child: null });
  crashPoint('runner.after-runner-json');

  const spawned = await containment.launch(launch, invDir);
  if (spawned.kind === 'spawn-failed') {
    const at = now();
    files.write('exit.json', { ...binding, child: { type: 'spawn-failed', error: spawned.error }, cause: 'exited', endedAt: at, quiescedAt: at, cpu: cpu?.total(0) ?? null });
    crashPoint('runner.after-exit-json');
    return;
  }
  const spawnedAt = Date.now();
  crashPoint('runner.after-child-spawn');
  files.write('runner.json', { ...binding, runner, child: spawned.child });
  const workload = { inv, child: spawned.child } satisfies WorkloadRef;

  let ended: Readonly<{ end: ChildEnd; at: IsoTime }> | null = null;
  const endedAt = spawned.ended.then((end) => {
    ended = { end, at: now() };
    return ended;
  });

  let cause: ExitCause = 'exited';
  const killFor = async (stop: Stop): Promise<void> => {
    cause = stop.cause;
    await containment.kill(workload, stop.reason, launch.graceMs);
  };

  // Phase 1: the child runs until it exits or the runner is told (or times out) to stop it.
  while (ended === null) {
    const stop = stopRequested(workload, false);
    if (stop !== null) {
      await killFor(stop);
      break;
    }
    await Promise.race([endedAt, sleep(CANCEL_POLL_MS)]);
  }
  const { end, at } = await endedAt;
  crashPoint('runner.child-exited-before-exit-json');

  // Phase 2: descendants may outlive the child; the invocation ends only when the workload is empty.
  while (cause === 'exited' && !containment.empty(workload)) {
    const stop = stopRequested(workload, true);
    if (stop !== null) {
      await killFor(stop);
      break;
    }
    await sleep(QUIESCE_POLL_MS);
  }

  const exit: ExitFile = { ...binding, child: end, cause, endedAt: at, quiescedAt: now(), cpu: cpu?.total(Date.now() - spawnedAt) ?? null };
  files.write('exit.json', exit);
  crashPoint('runner.after-exit-json');
}

