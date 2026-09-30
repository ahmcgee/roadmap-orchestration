// A child executor for the driver's crash test: argv <ArcDescriptor json> <unit>. It opens the arc's journal,
// runs the unit driver to its end and prints the result as JSON, so a test can SIGKILL it at a crashPoint
// (ROADMAP_TEST_CRASH) and start it again on the same journal.
import { runUnit } from '../../src/pipeline/unit.ts';
import { admitAll } from './stage-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json, id] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: unit-child <arc descriptor json> <unit>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
const result = await runUnit(r.ctx, r.unit(id), admitAll);
process.stdout.write(`${JSON.stringify(result)}\n`);
r.journal.close();
