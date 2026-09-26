// The runner: `node src/runner/runner.ts <invDir>`, launched detached by launch.ts. It is the invocation's
// controller and never a workload member (ROADMAP_ROLE=runner). It owns the workload from spawn to
// quiescence on its own, so a dead executor cannot leave a workload past its deadline:
//
//   verify session leader → umask 022 → runner.json (child: null) → spawn workload → runner.json (child)
//   → wait for child exit | deadlineAt | cancel.json → wait until the workload is empty (killing it on
//   deadline or cancel, also while waiting for descendants) → exit.json → exit 0.
//
// It writes runner.json and exit.json only. It never runs the adapter and never writes result.json: the
// executor's adapter does that once exit.json exists.
import { setTimeout as sleep } from 'node:timers/promises';
import { containmentFor } from '../contain/detect.ts';
import { identityOf, readBootId } from '../contain/proc.ts';
import { ENV_INV } from '../contain/session.ts';
import { crashPoint } from '../core/crash.ts';
import { invocationIdOf } from '../core/ids.ts';
import type { WorkloadRef } from '../core/interfaces.ts';
import type { ChildEnd, ExitCause, ExitFile, KillReason } from '../core/records.ts';
import { type IsoTime, absPath, isoTimeOf } from '../core/values.ts';
import { runnerFiles } from './files.ts';

/** cancel.json is polled at this interval while the child runs. */
const CANCEL_POLL_MS = 500;
/** Membership is rescanned at this interval while descendants outlive the child. */
const QUIESCE_POLL_MS = 100;

type Stop = Readonly<{ cause: Exclude<ExitCause, 'exited'>; reason: KillReason }>;

const now = (): IsoTime => isoTimeOf(new Date());

async function main(): Promise<void> {
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

  const stopRequested = (): Stop | null => {
    const cancel = files.read('cancel.json');
    if (cancel !== null) return cancel.reason === 'recovery' ? { cause: 'recovery-kill', reason: 'recovery' } : { cause: 'cancel', reason: cancel.reason };
    return Date.now() >= deadline ? { cause: 'deadline', reason: 'deadline' } : null;
  };

  crashPoint('runner.before-runner-json');
  files.write('runner.json', { ...binding, runner, child: null });
  crashPoint('runner.after-runner-json');

  const spawned = await containment.launch(launch, invDir);
  if (spawned.kind === 'spawn-failed') {
    const at = now();
    files.write('exit.json', { ...binding, child: { type: 'spawn-failed', error: spawned.error }, cause: 'exited', endedAt: at, quiescedAt: at });
    crashPoint('runner.after-exit-json');
    return;
  }
  crashPoint('runner.after-child-spawn');
  files.write('runner.json', { ...binding, runner, child: spawned.child });
  const workload: WorkloadRef = { inv, child: spawned.child };

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
    const stop = stopRequested();
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
    const stop = stopRequested();
    if (stop !== null) {
      await killFor(stop);
      break;
    }
    await sleep(QUIESCE_POLL_MS);
  }

  const exit: ExitFile = { ...binding, child: end, cause, endedAt: at, quiescedAt: now() };
  files.write('exit.json', exit);
  crashPoint('runner.after-exit-json');
}

await main();
process.exit(0);
