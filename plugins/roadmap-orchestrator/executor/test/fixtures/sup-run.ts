// argv: <hostDir> <roadmap start argv...>. A whole supervised run as one child process, for tests that want
// "start, then wait for the run to end": runs the real `roadmap start` (exec-cli.ts), which returns once the
// supervisor's generation is ready; then waits for that supervisor to exit and prints the exit line the
// last generation's executor printed, exiting with its code. A start that did not report `ready` (a
// refusal, a failure) is relayed as is. Every wait is bounded by the caller's child timeout.
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, statOf } from '../../src/contain/proc.ts';
import { absPath } from '../../src/core/values.ts';
import { exitCodeOf, type ExitReason } from '../../src/executor.ts';
import { lastGeneration } from '../../src/host/lock.ts';
import { executorLogs, lastLine } from '../../src/supervisor.ts';
import { fixture, runUntilExit } from '../helpers/proc.ts';

const [hostDir, ...argv] = process.argv.slice(2);
if (hostDir === undefined) throw new Error('usage: sup-run <hostDir> start <argv...>');

const start = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), hostDir, ...argv], { env: process.env, timeoutMs: 120_000 });
const line = start.stdout.trim();
const said = line === '' ? null : JSON.parse(line) as { kind: string; supervisor?: number };
if (said?.kind !== 'ready' || said.supervisor === undefined) {
  process.stdout.write(start.stdout);
  process.stderr.write(start.stderr);
  process.exitCode = start.code ?? 1;
} else {
  const stat = statOf(said.supervisor);
  if (stat !== null) {
    const supervisor = { pid: said.supervisor, start: stat.start };
    while (isAlive(supervisor)) await sleep(100);
  }
  const generation = lastGeneration(absPath(hostDir));
  const exit = lastLine(executorLogs(absPath(hostDir), generation).out);
  if (exit === null) {
    process.stdout.write(`${JSON.stringify({ kind: 'no-exit-line', generation })}\n`);
    process.exitCode = 70;
  } else {
    process.stdout.write(`${exit}\n`);
    process.exitCode = exitCodeOf(JSON.parse(exit) as ExitReason);
  }
}
