// A child executor for the DEBT_BANK crash row (test/corpus-judgment.test.ts): argv <ArcDescriptor json> <unit>. It opens
// the corpus arc's journal, runs recovery (as a restarted executor does before any stage), then steps the unit through
// a context that follows the log (route-common `followContext`) until its gate is decided, and prints the outcome.
import { recover } from '../../src/recover/recover.ts';
import { recoveryContext } from './rec-common.ts';
import { followContext, stepTo } from './route-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json, id] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: corpus-gate-child <arc descriptor json> <unit>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
await recover(recoveryContext(r));
await stepTo(followContext(r), id, (f) => f.stage === 'gate');
process.stdout.write(`${JSON.stringify(r.journal.view.unit(r.unit(id).id).decided)}\n`);
r.journal.close();
