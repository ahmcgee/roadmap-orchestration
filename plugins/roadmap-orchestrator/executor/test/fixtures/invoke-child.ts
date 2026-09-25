// A child executor for crash tests: argv <mode> <SpecDescriptor json>. It opens the journal and runs one
// `invoke`, printing the outcome kind on stdout, so a test can SIGKILL it at a crashPoint (ROADMAP_TEST_CRASH)
// or from outside.
//   invoke: just the invocation.
//   pause:  also issues proc.kill{pause} once the fake backend has logged its call (so the kill lands on a
//           running backend call, not on a node process still starting up), then awaits both.
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { invocationId, opId } from '../../src/core/ids.ts';
import { invocationDir, invoke, killWorkload } from '../../src/pipeline/invoke.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { readCalls } from '../helpers/scenario.ts';
import { type SpecDescriptor, context, open, specFor } from './invoke-specs.ts';

const [mode, json] = process.argv.slice(2);
if (json === undefined || (mode !== 'invoke' && mode !== 'pause')) throw new Error(`usage: invoke-child <invoke|pause> <spec json>, got ${JSON.stringify(process.argv.slice(2))}`);
const d = JSON.parse(json) as SpecDescriptor;
const journal = open(d.runDir, d.arc);
const ctx = context(journal, d.runDir);
const spec = specFor(d);

if (mode === 'invoke') {
  const outcome = await invoke(journal, ctx.containment, spec);
  process.stdout.write(`${outcome.kind}\n`);
} else {
  if (spec.origin.type !== 'new') throw new Error('pause mode runs a new op');
  if (d.binDir === undefined) throw new Error('pause mode pauses a backend call');
  const scenarioPath = join(dirname(d.binDir), 'scenario.json');
  const inv = invocationId(opId(journal.view.arc, journal.view.highWater() + 1), 1);
  const running = invoke(journal, ctx.containment, spec);
  const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
  // runner.json names the child as soon as it is spawned; the fake logs its call only once node has
  // started it. Killing in between would pause a call that never reached the backend.
  while (files.read('runner.json')?.child == null || readCalls(scenarioPath).length === 0) await sleep(20);
  await killWorkload(ctx, { inv, scope: 'invocation', reason: 'pause' });
  const outcome = await running;
  process.stdout.write(`${outcome.kind}\n`);
}
journal.close();
