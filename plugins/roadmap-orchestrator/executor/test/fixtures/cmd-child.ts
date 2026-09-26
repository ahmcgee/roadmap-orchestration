// A child executor for the command crash tests: argv <CmdRun json> <command id>. Applies one pending
// command through its `command.apply` op; crash tests SIGKILL it at a crashPoint (ROADMAP_TEST_CRASH).
import { applyCommand } from '../../src/commands/apply.ts';
import { readCommand } from '../../src/commands/queue.ts';
import { commandId } from '../../src/core/ids.ts';
import { type CmdRun, openCommandRun } from './cmd-common.ts';

const [json, id] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: cmd-child <run json> <command id>, got ${JSON.stringify(process.argv.slice(2))}`);
const { ctx, journal } = openCommandRun(JSON.parse(json) as CmdRun);
const { file } = readCommand(ctx.runDir, commandId(id), ctx.journal.view.arc);
process.stdout.write(`${JSON.stringify(await applyCommand(ctx, file))}\n`);
journal.close();
