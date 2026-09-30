// A child executor for the docs publication crash tests: argv <ArcDescriptor json> <command id> [<barrier dir>]. Applies
// the pending `rule` through its `command.apply` op with the real docs publication (publish-common.ts `wire`). With a
// barrier dir, unit u1 runs first on the same arbiter until its candidate's suite lane parks at the barrier
// (`barrierSuite`), then the rule is applied, preempting it, and the unit runs on to its end. Crash tests SIGKILL it at
// a crashPoint (ROADMAP_TEST_CRASH).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { applyCommand } from '../../src/commands/apply.ts';
import { readCommand } from '../../src/commands/queue.ts';
import { commandId } from '../../src/core/ids.ts';
import { runUnit } from '../../src/pipeline/unit.ts';
import { wire } from './publish-common.ts';
import { admitAll } from './stage-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json, id, barrier] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: publish-child <arc json> <command id> [<barrier dir>], got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
const w = wire(r);
const { file } = readCommand(r.ctx.runDir, commandId(id), r.journal.view.arc);
if (barrier === undefined) {
  process.stdout.write(`${JSON.stringify(await applyCommand(w.commands, file))}\n`);
} else {
  const unit = runUnit(w.stage, r.unit('u1'), admitAll);
  const until = Date.now() + 120_000;
  while (!existsSync(join(barrier, 'lane.reached'))) {
    if (Date.now() > until) throw new Error('the candidate never reached the barrier');
    await sleep(20);
  }
  const outcome = await applyCommand(w.commands, file);
  process.stdout.write(`${JSON.stringify({ outcome, unit: await unit })}\n`);
}
r.journal.close();
