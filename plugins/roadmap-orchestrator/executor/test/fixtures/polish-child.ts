// Crash child of the polish and compare crash cells (test/polish-loop.test.ts): reopens the arc and runs the polish revision
// (`polish`) or the compare (`compare`) due; the crash trigger in ROADMAP_TEST_CRASH kills it at the cell's label.
import { holisticContexts } from '../../src/schedule/scheduler.ts';
import { runCompare } from '../../src/walk/compare.ts';
import { applyPolish } from '../../src/walk/polish.ts';
import { contextFor } from './unit-common.ts';
import { walkContext } from './walk-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
const what = process.argv[3];
const { w } = walkContext(r);
const h = holisticContexts(w).checkpoint;
const tick = setInterval(() => w.arbiter.wake(), 50);
try {
  if (what !== 'polish' && what !== 'compare') throw new Error(`polish-child: ${what} is neither polish nor compare`);
  process.stdout.write(`${JSON.stringify(what === 'polish' ? await applyPolish(h) : await runCompare(h))}\n`);
} finally {
  clearInterval(tick);
  r.journal.close();
}
