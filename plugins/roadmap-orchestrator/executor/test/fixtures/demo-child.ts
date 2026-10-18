// A child executor for the demo crash test: argv <ArcDescriptor json>. Runs one demo tick of the scheduler (src/demo/promote.ts
// `demoTicker`) over a unit-common arc; the test SIGKILLs it at the crash point `demo-promoted` (ROADMAP_TEST_CRASH).
import { demoTicker, liveRepairs } from '../../src/demo/promote.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json] = process.argv.slice(2);
if (json === undefined) throw new Error(`usage: demo-child <arc json>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
demoTicker(r.ctx, liveRepairs(r.ctx)).tick();
r.journal.close();
