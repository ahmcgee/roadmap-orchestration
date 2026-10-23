// Crash child of the propagation revision's crash cells (test/propagation.test.ts): reopens the arc and runs the propagation
// revision due; the crash trigger in ROADMAP_TEST_CRASH kills it at the cell's label.
import { applyPropagation } from '../../src/holistic/propagation.ts';
import { holisticContexts } from '../../src/schedule/scheduler.ts';
import { contextFor } from './unit-common.ts';
import { walkContext } from './walk-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
const { w } = walkContext(r);
const tick = setInterval(() => w.arbiter.wake(), 50);
try {
  process.stdout.write(`${JSON.stringify(await applyPropagation(holisticContexts(w).checkpoint))}\n`);
} finally {
  clearInterval(tick);
  r.journal.close();
}
