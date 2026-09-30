// A child executor for the revision crash tests: argv <ArcDescriptor json> <command id>. Applies one pending `apply`
// through its `command.apply` op, with the stand-in docs publication (docs-fake.ts); crash tests SIGKILL it at a
// crashPoint (ROADMAP_TEST_CRASH).
import { applyCommand } from '../../src/commands/apply.ts';
import { readCommand } from '../../src/commands/queue.ts';
import { commandId } from '../../src/core/ids.ts';
import { absPath, branchName } from '../../src/core/values.ts';
import { fakeDocs } from './docs-fake.ts';
import { type ArcDescriptor, commandContextFor, contextFor } from './unit-common.ts';

const [json, id] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: revision-child <arc json> <command id>, got ${JSON.stringify(process.argv.slice(2))}`);
const d = JSON.parse(json) as ArcDescriptor;
const r = contextFor(d);
const ctx = { ...commandContextFor(r), docs: fakeDocs(r.journal, absPath(d.repo), branchName('main')) };
const { file } = readCommand(ctx.runDir, commandId(id), ctx.journal.view.arc);
process.stdout.write(`${JSON.stringify(await applyCommand(ctx, file))}\n`);
r.journal.close();
