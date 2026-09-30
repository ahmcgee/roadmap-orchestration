// A child executor for the probe crash tests: argv <mode> <ProbeRun json>. Crash tests SIGKILL it at a
// crashPoint (ROADMAP_TEST_CRASH).
//   probe:    runs every probe job due now, one after another (as the scheduler starts them); prints each result.
//   recover:  the executor's recovery (`recover`), as a restart runs it before any probe.
import { createProber } from '../../src/park/probe.ts';
import { recover } from '../../src/recover/recover.ts';
import { type ProbeRun, openProbeRun } from './probe-common.ts';

const [mode, json] = process.argv.slice(2);
if (json === undefined || (mode !== 'probe' && mode !== 'recover')) throw new Error(`usage: probe-child <probe|recover> <run json>, got ${JSON.stringify(process.argv.slice(2))}`);
const { ctx, recovery, journal } = openProbeRun(JSON.parse(json) as ProbeRun);

if (mode === 'probe') {
  const prober = createProber(ctx);
  const results: string[] = [];
  for (const job of prober.due(journal.view, new Date())) results.push(await prober.run(job, new AbortController().signal));
  process.stdout.write(`${results.join(',')}\n`);
} else {
  await recover(recovery);
}
journal.close();
