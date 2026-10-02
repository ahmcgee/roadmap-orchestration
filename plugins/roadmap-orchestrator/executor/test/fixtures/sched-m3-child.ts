// Crash child of `complete.terminal-snapshot` (test/scheduler-m3.test.ts): reopens the arc and runs the scheduler over
// it; the crash trigger in ROADMAP_TEST_CRASH kills it at its label (`complete.after-fact`: after `arc-completed`, before
// the terminal snapshot).
import { startHolistic } from './sched-m3-common.ts';
import { contextFor } from './unit-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
try {
  process.stdout.write(`${JSON.stringify(await startHolistic(r).end)}\n`);
} finally {
  r.journal.close();
}
