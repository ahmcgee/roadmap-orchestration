// Crash child of the walk crash cells (test/walk-job.test.ts): reopens the arc whose milestone was reached and runs the
// walk due; the crash trigger in ROADMAP_TEST_CRASH kills it at the cell's label.
import { runWalk } from '../../src/walk/walk.ts';
import { contextFor } from './unit-common.ts';
import { walkContext } from './walk-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
const { ctx, w } = walkContext(r);
const tick = setInterval(() => w.arbiter.wake(), 50);
try {
  process.stdout.write(`${JSON.stringify(await runWalk(ctx))}\n`);
} finally {
  clearInterval(tick);
  r.journal.close();
}
