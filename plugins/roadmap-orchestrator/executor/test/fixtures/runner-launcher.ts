// A stand-in executor. argv: <invDir> <launch json without `test`> <exit|hang>. Starts the runner the way the
// executor does (prepareLaunch copies ROADMAP_TEST_CRASH from this process's env), prints the runner's
// {pid, start} as JSON, then exits or hangs until killed.
import { launchFile } from '../../src/core/records.ts';
import { absPath } from '../../src/core/values.ts';
import { prepareLaunch, startRunner } from '../../src/runner/launch.ts';

const [invDir, json, after] = process.argv.slice(2);
if (invDir === undefined || json === undefined || (after !== 'exit' && after !== 'hang')) {
  throw new Error(`usage: runner-launcher <invDir> <launch json> <exit|hang>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const base = launchFile({ ...(JSON.parse(json) as object), test: null }, 'launch');
const handle = startRunner(absPath(invDir), prepareLaunch(base));
process.stdout.write(`${JSON.stringify(handle.runner)}\n`);
if (after === 'hang') setInterval(() => {}, 60_000);
