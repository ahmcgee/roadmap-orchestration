// A child executor for the flow apply crash test: argv <ArcDescriptor json>. Runs one `applyPendingFlow` tick over a
// unit-common arc; the test SIGKILLs it at a crashPoint (ROADMAP_TEST_CRASH).
import { absPath } from '../../src/core/values.ts';
import { applyPendingFlow } from '../../src/flow/apply.ts';
import { followingContext } from './steer-common.ts';
import { type ArcDescriptor, commandContextFor, contextFor } from './unit-common.ts';

const [json] = process.argv.slice(2);
if (json === undefined) throw new Error('usage: flow-apply-child <arc json>');
const d = JSON.parse(json) as ArcDescriptor;
const r = contextFor(d);
await applyPendingFlow({ ...commandContextFor(r, followingContext(r)), repo: absPath(d.repo) });
r.journal.close();
