// A child executor for the apply crash tests: argv <ArcDescriptor json> <command id>. Applies one pending
// `apply` through its `command.apply` op over the arc's context; crash tests SIGKILL it at a crashPoint
// (ROADMAP_TEST_CRASH).
import { applyCommand } from '../../src/commands/apply.ts';
import { readCommand } from '../../src/commands/queue.ts';
import { commandId } from '../../src/core/ids.ts';
import { type ArcDescriptor, commandContextFor, contextFor } from './unit-common.ts';

const [json, id] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: apply-child <arc json> <command id>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
const ctx = commandContextFor(r);
const { file } = readCommand(ctx.runDir, commandId(id), ctx.journal.view.arc);
process.stdout.write(`${JSON.stringify(await applyCommand(ctx, file))}\n`);
r.journal.close();
