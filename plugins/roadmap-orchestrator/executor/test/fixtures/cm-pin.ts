// A one-shot pin for the concurrent crash matrix (test/concurrent-matrix.test.ts): the workload a peer unit is
// pinned in while the stepping unit walks its pipeline. argv: <barrierDir> <name> [<stateDir> <pool>].
//
// The first run parks at file barrier `name` (test/helpers/barrier.ts), printing progress, until the test
// releases it; a run after the release passes at once, so a teardown recovery re-runs, or a lane series a
// crash cut short and its stage re-runs, never parks again. With `<stateDir> <pool>` it is an estate lane that
// holds its pool instance meanwhile, as test/fakes/estate.ts `hold` does (the same occupant file and history
// log, so test/helpers/estate.ts replays it): the instance from RESOURCE_INSTANCE_<POOL>, the owner label from
// RESOURCE_OWNER; a second owner logs `conflict` and exits 1.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitAtBarrier } from '../helpers/barrier.ts';

const PIN_TIMEOUT_MS = 300_000;
const PROGRESS_MS = 1_000;

const [barrierDir, name, stateDir, pool] = process.argv.slice(2);
if (barrierDir === undefined || name === undefined || (stateDir === undefined) !== (pool === undefined)) {
  throw new Error(`usage: cm-pin <barrierDir> <name> [<stateDir> <pool>], got ${JSON.stringify(process.argv.slice(2))}`);
}

const park = (): void => {
  if (!existsSync(join(barrierDir, `${name}.release`))) waitAtBarrier(barrierDir, name, PIN_TIMEOUT_MS, PROGRESS_MS);
};

if (stateDir === undefined || pool === undefined) {
  park();
} else {
  const label = process.env['RESOURCE_OWNER'];
  if (label === undefined) throw new Error('cm-pin: RESOURCE_OWNER is not set');
  const variable = `RESOURCE_INSTANCE_${pool.toUpperCase().replaceAll('-', '_')}`;
  const n = process.env[variable];
  if (n === undefined) throw new Error(`cm-pin: ${variable} is not set`);
  const dir = join(stateDir, `${pool}#${n}`);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(stateDir, 'calls.log'), `hold ${pool}#${n} ${label}\n`);
  const occupant = join(dir, 'occupant');
  const history = (line: string): void => appendFileSync(join(dir, 'history.log'), `${line}\n`);
  try {
    writeFileSync(occupant, label, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    history(`conflict ${label} ${readFileSync(occupant, 'utf8')}`);
    process.stderr.write(`cm-pin: ${pool}#${n} is held\n`);
    process.exit(1);
  }
  history(`enter ${label}`);
  park();
  history(`leave ${label}`);
  rmSync(occupant);
}
process.stdout.write('released\n');
