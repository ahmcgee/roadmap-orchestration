// A child executor for the M2 stage crash tests: argv <ArcDescriptor json> <unit>. It opens the arc's journal,
// runs recovery (as a restarted executor does before any stage), then the unit driver to its end, and prints
// the result as JSON, so a test can SIGKILL it at a crashPoint (ROADMAP_TEST_CRASH) and start it again.
import { runUnit } from '../../src/pipeline/unit.ts';
import { recover } from '../../src/recover/recover.ts';
import { recoveryContext } from './rec-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json, id] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: stage-child <arc descriptor json> <unit>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
await recover(recoveryContext(r));
const result = await runUnit(r.ctx, r.unit(id), new AbortController().signal);
process.stdout.write(`${JSON.stringify(result)}\n`);
r.journal.close();
