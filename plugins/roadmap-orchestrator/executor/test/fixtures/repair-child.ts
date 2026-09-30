// Crash child of the MUTANT_APPLY matrix row (test/repair.test.ts): reopens the arc and runs the vacuity repair v1 to its
// end (its reproduce, then its candidate's kill check, apply F-1's mutant); the crash trigger in ROADMAP_TEST_CRASH kills
// it at the row's label.
import { runUnit } from '../../src/pipeline/unit.ts';
import { admitAll } from './stage-common.ts';
import { contextFor } from './unit-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
try {
  process.stdout.write(`${JSON.stringify(await runUnit(r.ctx, r.unit('v1'), admitAll))}\n`);
} finally {
  r.journal.close();
}
