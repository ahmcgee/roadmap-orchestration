// A child executor for the reservation crash tests: argv <mode> <ResRun json>. Crash tests SIGKILL it at a
// crashPoint (ROADMAP_TEST_CRASH).
//   cycle:   the build's whole cycle for unit u1: reserve [db, queue] → probe → run → one lane invocation
//            (the holder's workload) → cleanup from the teardown stage. Prints the cleanup result. With
//            `queue.teardown-fails` in the state dir, it is the failed-cleanup scenario.
//   recover: the resources phase of recovery alone (recoverReservations), which must also settle the
//            spawns it depends on. Prints nothing.
import { recoverReservations } from '../../src/recover/resource.ts';
import { cleanup, reserve, run } from '../../src/resources/reserve.ts';
import { probe } from '../../src/resources/probe.ts';
import { DB, QUEUE, type ResRun, laneInvocation, openRun, stageHolder, stageParent } from './res-plan.ts';

const [mode, json] = process.argv.slice(2);
if (json === undefined || (mode !== 'cycle' && mode !== 'recover')) throw new Error(`usage: res-child <cycle|recover> <run json>, got ${JSON.stringify(process.argv.slice(2))}`);
const { ctx, journal } = openRun(JSON.parse(json) as ResRun);

if (mode === 'cycle') {
  const holder = stageHolder('build');
  const reserved = reserve(ctx, holder, [QUEUE, DB], stageParent(holder));
  if (reserved.state === 'refused') throw new Error(`refused: ${reserved.busy.join(', ')}`);
  const occupancy = await probe(ctx, reserved, stageParent(holder));
  if (occupancy.kind !== 'clear') throw new Error(`parked: ${occupancy.needsUser.summary}`);
  const running = run(ctx, reserved, stageParent(holder));
  await laneInvocation(ctx, holder);
  const result = await cleanup(ctx, running, stageParent(stageHolder('teardown')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  await recoverReservations(ctx);
}
journal.close();
