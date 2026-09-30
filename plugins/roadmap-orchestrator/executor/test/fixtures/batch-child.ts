// Crash child of the BATCH_PUBLICATION matrix row (test/batch.test.ts): reopens the arc both units were approved in and
// publishes their batch; the crash trigger in ROADMAP_TEST_CRASH kills it at the row's label.
import { publish } from './batch-common.ts';
import { contextFor } from './unit-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
try {
  process.stdout.write(`${JSON.stringify(await publish(r))}\n`);
} finally {
  r.journal.close();
}
