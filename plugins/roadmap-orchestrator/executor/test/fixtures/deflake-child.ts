// Crash child of the deflake revision's crash cells (test/deflake.test.ts): reopens the arc and runs the deflake job; the crash
// trigger in ROADMAP_TEST_CRASH kills it at the cell's label.
import { applyDeflake } from '../../src/pipeline/deflakemint.ts';
import { deflakeContext } from './deflake-common.ts';
import { contextFor } from './unit-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
const { ctx, w } = deflakeContext(r);
const tick = setInterval(() => w.arbiter.wake(), 50);
try {
  process.stdout.write(`${JSON.stringify(await applyDeflake(ctx))}\n`);
} finally {
  clearInterval(tick);
  r.journal.close();
}
