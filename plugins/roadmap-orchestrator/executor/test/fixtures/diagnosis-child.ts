// A child executor for the diagnosis crash tests (test/steer-diagnosis.test.ts): argv <ArcDescriptor json> <unit>. As
// unit-child.ts, with the unit's M4 diagnosis due (8 builds or 20 judged attempts, which no fixture arc reaches by itself:
// the count is read as the threshold, as test/agent-surface.test.ts does in process).
import { runUnit } from '../../src/pipeline/unit.ts';
import { admitAll } from './stage-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json, id] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: diagnosis-child <arc descriptor json> <unit>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
Object.assign(r.journal.view, { attemptCounts: () => ({ builds: 8, judged: 20 }) });
const result = await runUnit(r.ctx, r.unit(id), admitAll);
process.stdout.write(`${JSON.stringify(result)}\n`);
r.journal.close();
