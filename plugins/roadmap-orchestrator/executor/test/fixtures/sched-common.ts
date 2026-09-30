// Shared by the scheduler tests: the scheduler (src/schedule/scheduler.ts) run in the test process over an arc
// that unit-common's `contextFor` opened, wired as the executor wires it (one arbiter, the real prober, a stop
// controller), with commands submitted to the run dir's queue as the CLI does. It returns only on `complete`
// or `stop`, so a test that leaves work behind ends it with a `stop` command (`stopScheduler`).
import type { CommandId, NeedsUserId, UnitId } from '../../src/core/ids.ts';
import { submitCommand, terminalReceipt } from '../../src/commands/queue.ts';
import type { CommandBody, Receipt } from '../../src/core/records.ts';
import { readHostSample } from '../../src/host/sample.ts';
import { raisedFor } from '../../src/needsuser.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import { createProber } from '../../src/park/probe.ts';
import type { StageContext } from '../../src/pipeline/dispatch.ts';
import type { ProfileName } from '../../src/routing/types.ts';
import { createArbiter } from '../../src/schedule/arbiter.ts';
import { type SchedulerEnd, decidedParent, schedule } from '../../src/schedule/scheduler.ts';
import { type ArcRun, commandContextFor } from './unit-common.ts';
import { until } from './exec-common.ts';

export type Scheduled = Readonly<{ end: Promise<SchedulerEnd>; stage: StageContext }>;

/**
 * Starts the scheduler over `r`'s arc, as the executor does after recovery; `stage` is the run's stage context.
 * Its plan is the plan in force, read from the log at each call, so an `apply` takes effect as in the executor.
 */
export function startScheduler(r: ArcRun, profile: ProfileName = 'default'): Scheduled {
  const plan = () => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
  const resources = { ...r.ctx, plan };
  const arbiter = createArbiter(resources);
  const stage: StageContext = { ...resources, acquire: arbiter.acquire };
  const prober = createProber({ ...stage, profile, sample: readHostSample });
  const stop = new AbortController();
  const commands = { ...commandContextFor(r, stage), probes: { prober, signal: stop.signal } };
  return { end: schedule({ stage, commands, arbiter, prober, stop }), stage };
}

/** Submits one command to the arc's queue, as the CLI does; the scheduler picks it up on its next poll. */
export function submit(r: ArcRun, body: CommandBody): CommandId {
  return submitCommand(r.ctx.runDir, r.ctx.plan().arc, body).id;
}

/** The command's terminal receipt, once the scheduler has applied it. */
export async function receiptOf(r: ArcRun, id: CommandId, timeoutMs = 60_000): Promise<Receipt> {
  let receipt: Receipt | null = null;
  await until(() => (receipt = terminalReceipt(r.ctx.runDir, id)) !== null, timeoutMs, `the receipt of ${id}`);
  return receipt!;
}

/** Stops a scheduler still running and returns its end. */
export async function stopScheduler(r: ArcRun, s: Scheduled): Promise<SchedulerEnd> {
  submit(r, { type: 'stop' });
  return s.end;
}

/** The needs-user a halted unit's park or stop raised, once it is raised. */
export async function haltItem(r: ArcRun, unit: UnitId, timeoutMs = 120_000): Promise<NeedsUserId> {
  let id: NeedsUserId | null = null;
  await until(() => {
    const u = r.journal.view.unit(unit);
    if (u.decided === null || (u.status !== 'park-pending' && u.status !== 'stop-pending')) return false;
    return (id = raisedFor(r.journal.view, decidedParent(r.journal.view, unit))) !== null;
  }, timeoutMs, `the needs-user of ${unit}'s halt`);
  return id!;
}
