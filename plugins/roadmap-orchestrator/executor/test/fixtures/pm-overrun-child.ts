// Crash child of the admit-conversions row (test/pipeline-matrix.test.ts, pm-overrun.ts): argv <ArcDescriptor json>.
// Reopens the story's corpus arc, recovers what a crash left open, and runs its next checkpoint once under the plan in
// force (the fake gh first on PATH from the parent's env); the crash trigger in ROADMAP_TEST_CRASH kills it at the row's
// label. Prints the checkpoint's outcome.
import { runCheckpoint } from '../../src/holistic/checkpoint.ts';
import { recover } from '../../src/recover/recover.ts';
import { overrunContext } from './pm-overrun.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json] = process.argv.slice(2);
if (json === undefined) throw new Error(`usage: pm-overrun-child <arc descriptor json>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
try {
  const { ctx, w } = overrunContext(r);
  await recover({ stage: ctx, commands: w.commands });
  process.stdout.write(`${JSON.stringify(await runCheckpoint(ctx))}\n`);
} finally {
  r.journal.close();
}
