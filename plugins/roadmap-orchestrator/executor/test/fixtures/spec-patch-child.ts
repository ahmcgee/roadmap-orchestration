// argv: <runDir> <arc> <specPath> <patchJson>. Runs one spec.patch through the journal the way the
// pipeline does (prepare, durable intent, act, verify, done) in a child process, so crash tests can
// SIGKILL it at the op's crashPoints.
import { readFileSync } from 'node:fs';
import { arcId, opKey } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { specPatch } from '../../src/core/records.ts';
import { absPath } from '../../src/core/values.ts';
import { specPatchFileOp } from '../../src/spec/patch.ts';

const [runDir, arc, specPath, patchJson] = process.argv.slice(2);
if (runDir === undefined || arc === undefined || specPath === undefined || patchJson === undefined) {
  throw new Error(`usage: spec-patch-child <runDir> <arc> <specPath> <patchJson>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const journal = openJournal(absPath(runDir), arcId(arc));
const body = await specPatchFileOp.prepare({ path: absPath(specPath), patch: specPatch(JSON.parse(readFileSync(patchJson, 'utf8')), 'patch') });
const { op } = journal.begin({ kind: 'spec.patch', key: opKey('spec:u1'), parent: { type: 'arc' }, deadlineAt: null, body: () => body });
const intent = journal.view.latestIntent(op);
if (intent.kind !== 'spec.patch') throw new Error(`expected a spec.patch intent, got ${intent.kind}`);
await specPatchFileOp.act(intent);
journal.done(op, 'spec.patch', await specPatchFileOp.verify(intent), null);
journal.close();
