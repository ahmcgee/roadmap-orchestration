// A child executor for the recovery tests: argv <mode> <ArcDescriptor json> [<started file>]. Crash tests
// SIGKILL it at a crashPoint (ROADMAP_TEST_CRASH) or from outside.
//   recover:  the recovery engine (src/recover/recover.ts) over the arc's journal; prints its report. With a
//             started file, writes it once the journal is open, just before recovery begins.
//   command:  submits `pause --all` and applies it through its command.apply op, as the executor does.
import { writeFileSync } from 'node:fs';
import { applyCommand } from '../../src/commands/apply.ts';
import { pollCommands, submitCommand } from '../../src/commands/queue.ts';
import { recover } from '../../src/recover/recover.ts';
import { recoveryContext } from './rec-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [mode, json, started] = process.argv.slice(2);
if (json === undefined || (mode !== 'recover' && mode !== 'command')) throw new Error(`usage: rec-child <recover|command> <arc json>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
const ctx = recoveryContext(r);
if (mode === 'recover') {
  if (started !== undefined) writeFileSync(started, `${process.pid}\n`);
  process.stdout.write(`${JSON.stringify(await recover(ctx))}\n`);
} else {
  submitCommand(r.ctx.runDir, r.ctx.plan.arc, { type: 'pause', target: { type: 'all' } });
  const [file] = pollCommands(r.ctx.runDir, r.ctx.plan.arc);
  if (file === undefined) throw new Error('rec-child: the submitted command is not pending');
  process.stdout.write(`${JSON.stringify(await applyCommand(ctx.commands, file))}\n`);
}
r.journal.close();
