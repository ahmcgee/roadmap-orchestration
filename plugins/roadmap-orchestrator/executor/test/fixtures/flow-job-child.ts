// Crash child of the M4b flow rows (test/flow-job.test.ts: FLOW_JOB, FLOW_SERIES): argv <ArcDescriptor json> <job | series>.
// Reopens the arc and runs its flow job once for a `requested` trigger, or keeps its series before completion; the crash
// trigger in ROADMAP_TEST_CRASH kills it at the row's label.
import { runFlowJob } from '../../src/flow/job.ts';
import { beforeCompletion } from '../../src/flow/track.ts';
import { checkpointContext } from './checkpoint-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json, mode] = process.argv.slice(2);
if (json === undefined || (mode !== 'job' && mode !== 'series')) throw new Error(`usage: flow-job-child <arc descriptor json> <job|series>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
try {
  const { ctx } = checkpointContext(r);
  if (mode === 'job') process.stdout.write(`${JSON.stringify(await runFlowJob(ctx, ['requested'], null))}\n`);
  else beforeCompletion(ctx);
} finally {
  r.journal.close();
}
