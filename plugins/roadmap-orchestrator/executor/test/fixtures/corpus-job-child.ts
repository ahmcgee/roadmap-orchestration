// Crash child of the M4a job rows (test/intake.test.ts: ISSUE_CAPTURE, CORPUS_AMENDMENT/ISSUE_INTAKE; test/packreview.test.ts:
// PACK_REVIEW_JOB; test/closeout.test.ts: CLOSE_OUT_SETTLEMENT): argv <ArcDescriptor json> <checkpoint | packreview |
// closeout>. Reopens the corpus arc and runs its checkpoint, its pack review or its close-out settlement once (the fake gh
// comes first on PATH from the parent's env); the crash trigger in ROADMAP_TEST_CRASH kills it at the row's label.
import { runCheckpoint } from '../../src/holistic/checkpoint.ts';
import { settleCloseOut } from '../../src/holistic/closeout.ts';
import { runPackReview } from '../../src/holistic/packreview.ts';
import { checkpointContext } from './checkpoint-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json, job] = process.argv.slice(2);
if (json === undefined || (job !== 'checkpoint' && job !== 'packreview' && job !== 'closeout')) {
  throw new Error(`usage: corpus-job-child <arc descriptor json> <checkpoint|packreview|closeout>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const r = contextFor(JSON.parse(json) as ArcDescriptor);
try {
  const { ctx } = checkpointContext(r);
  const out = job === 'checkpoint' ? await runCheckpoint(ctx) : job === 'packreview' ? await runPackReview(ctx) : { settled: settleCloseOut(ctx) };
  process.stdout.write(`${JSON.stringify(out)}\n`);
} finally {
  r.journal.close();
}
