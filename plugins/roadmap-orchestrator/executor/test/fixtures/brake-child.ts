// Crash child of the LATCH matrix row (test/brake.test.ts): reopens the arc and runs unit u1 to its end (its candidate
// completes future obligation I-2); the crash trigger in ROADMAP_TEST_CRASH kills it at the row's label.
import { runUnit } from '../../src/pipeline/unit.ts';
import { admitAll } from './stage-common.ts';
import { contextFor } from './unit-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
try {
  process.stdout.write(`${JSON.stringify(await runUnit(r.ctx, r.unit('u1'), admitAll))}\n`);
} finally {
  r.journal.close();
}
