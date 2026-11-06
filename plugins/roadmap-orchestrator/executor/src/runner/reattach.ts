import { pollCommands } from '../commands/queue.ts';
import { stopAborts,stopKills } from '../pipeline/stop.ts';
// Reattaching to an open proc.spawn intent after the executor restarted (plan "Recovery", row proc.spawn;
// R13, R15). The invocation dir is re-read from scratch; no file is trusted for merely existing.
//
//   runner alive (a process with ROADMAP_ROLE=runner and this ROADMAP_INV, matching runner.json when it
//   exists) → adopt: wait for it to exit, polling by identity, backstop-killed at deadlineAt + 2·grace
//   → settle: workload empty, then result.json from exit.json (or lost if the runner died without one).
//
//   runner dead → settle by op: any live member of any ordinal is an orphan and is killed by
//   proc.kill{recovery}, its effects left in place; then a valid result.json is certified (done), exit.json
//   alone re-runs the adapter (redone), and neither is lost with usage unavailable{no-result}. A valid
//   result.json with live members is not quiescent: they are killed before it is certified.
//
//   runner alive of a `bring-up` command (dev.13, src/walk/bringup.ts) → cancelled{recovery} first, then adopted: its
//   owner (a walk job) brings its product up again when it resumes, so a `serve` process is never waited out.
//
// A lost invocation is retried by the caller as a new ordinal with the same deadline, never here.
import type { IntentOf } from '../core/events.ts';
import { invocationId } from '../core/ids.ts';
import { type ProcContext, type Settled, invocationDir, liveRunner, settle } from '../pipeline/invoke.ts';
import { runnerFiles } from './files.ts';
import { awaitRunner, cancel, launchSha256 } from './launch.ts';

export type Reattached = Readonly<{ how: 'adopted' | 'runner-gone'; settled: Settled }>;

export async function reattach(ctx: ProcContext, intent: IntentOf<'proc.spawn'>): Promise<Reattached> {
  const inv = invocationId(intent.op, intent.ordinal);
  const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
  const launch = files.read('launch.json');
  if (launch !== null && launchSha256(launch) !== intent.expect.launchSha256) {
    throw new Error(`${files.invDir}/launch.json does not hash to the intent's launchSha256 ${intent.expect.launchSha256}`);
  }
  const runner = liveRunner(files);
  if (runner === null) return { how: 'runner-gone', settled: await settle(ctx, intent, { type: 'recovered' }) };
  // A live runner was started by this intent, so launch.json was written before it.
  if (launch === null) throw new Error(`${files.invDir}: runner ${runner.pid} is alive but launch.json is missing`);
  const handle = { files, launch, runner };
  if (intent.expect.subject.purpose === 'bring-up' && files.read('cancel.json') === null) cancel(handle, 'recovery');
  await awaitRunner(handle, () => {
    // Recovery can wait on a live workload before the scheduler exists. Keep a durable drain's
    // deadline and a later plain stop effective during that wait, with the same critical sections.
    const control = ctx.journal.view.control();
    if (control.stop === null || !stopKills(intent)) return null;
    const immediate = stopAborts(control) || pollCommands(ctx.runDir, ctx.journal.view.arc).some((c) => c.body.type === 'stop' && c.body.mode !== 'drain');
    return immediate ? 'stop' : null;
  });
  return { how: 'adopted', settled: await settle(ctx, intent, { type: 'adopted' }) };
}
