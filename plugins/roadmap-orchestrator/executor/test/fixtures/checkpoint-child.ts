// Crash child of the CHECKPOINT_JOB and BUNDLE_ACTIVATE matrix rows (test/checkpoint.test.ts): reopens the arc an audit
// completed in and runs its checkpoint; the crash trigger in ROADMAP_TEST_CRASH kills it at the row's label.
import { runCheckpoint } from '../../src/holistic/checkpoint.ts';
import { checkpointContext } from './checkpoint-common.ts';
import { contextFor } from './unit-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
try {
  process.stdout.write(`${JSON.stringify(await runCheckpoint(checkpointContext(r).ctx))}\n`);
} finally {
  r.journal.close();
}
