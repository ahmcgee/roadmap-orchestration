// Directory-backed estate pool instance for tests (no docker, no kind): argv <probe|teardown|hold> <stateDir>
// <pool> [<barrierDir> <barrierName> <timeoutMs> <progressMs>]. The instance is the directory
// `<stateDir>/<pool>#<n>`, `n` from RESOURCE_INSTANCE_<POOL> (pool upper-cased, `-` → `_`), the owner label
// from RESOURCE_OWNER. Files in it:
//   occupant     the owner label of the workload holding the instance, created exclusively by `hold`.
//   history.log  one line per event, appended: `enter <label>`, `leave <label>`, `conflict <label> <holder>`.
//                test/helpers/estate.ts replays it to assert no instance had two concurrent owners.
// probe: occupant absent → 0, own label → 10, another's → 11 (the PROBE_EXIT contract).
// teardown: removes the occupant when it carries the caller's label, logging `leave`. Beside the instances,
//   `<stateDir>/<pool>.teardown-fails-once`, when present, is consumed by the next teardown, which then
//   exits 1 removing nothing: a teardown that fails exactly once.
// hold: the lane workload. Claims the instance (a second owner logs `conflict` and exits 1), parks at the
//   per-unit barrier if one is named (emitting progress), then releases the instance.
// Every call appends `<cmd> <pool>#<n> <label>` to `<stateDir>/calls.log`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unitBarrierName, waitAtBarrier } from '../helpers/barrier.ts';

const instanceEnvVar = (pool: string): string => `RESOURCE_INSTANCE_${pool.toUpperCase().replaceAll('-', '_')}`;

const [cmd, stateDir, pool, barrierDir, barrierName, timeoutMs, progressMs] = process.argv.slice(2);
if ((cmd !== 'probe' && cmd !== 'teardown' && cmd !== 'hold') || stateDir === undefined || pool === undefined) {
  throw new Error(`usage: estate <probe|teardown|hold> <stateDir> <pool> [...], got ${JSON.stringify(process.argv.slice(2))}`);
}
const label = process.env['RESOURCE_OWNER'];
if (label === undefined) throw new Error('estate: RESOURCE_OWNER is not set');
const n = process.env[instanceEnvVar(pool)];
if (n === undefined) throw new Error(`estate: ${instanceEnvVar(pool)} is not set`);

const dir = join(stateDir, `${pool}#${n}`);
mkdirSync(dir, { recursive: true });
appendFileSync(join(stateDir, 'calls.log'), `${cmd} ${pool}#${n} ${label}\n`);
const occupantFile = join(dir, 'occupant');
const history = (line: string): void => appendFileSync(join(dir, 'history.log'), `${line}\n`);
const occupant = (): string | null => (existsSync(occupantFile) ? readFileSync(occupantFile, 'utf8') : null);

if (cmd === 'probe') {
  const held = occupant();
  process.exit(held === null ? 0 : held === label ? 10 : 11);
}
if (cmd === 'teardown') {
  const once = join(stateDir, `${pool}.teardown-fails-once`);
  if (existsSync(once)) {
    rmSync(once);
    process.stderr.write(`estate: teardown of ${pool}#${n} fails once\n`);
    process.exit(1);
  }
  if (occupant() === label) {
    history(`leave ${label}`);
    rmSync(occupantFile);
  }
  process.exit(0);
}
try {
  writeFileSync(occupantFile, label, { flag: 'wx' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  history(`conflict ${label} ${occupant()}`);
  process.stderr.write(`estate: ${pool}#${n} is held by ${occupant()}\n`);
  process.exit(1);
}
history(`enter ${label}`);
if (barrierDir !== undefined && barrierName !== undefined && timeoutMs !== undefined) {
  const unit = label.slice(label.lastIndexOf('/') + 1);
  waitAtBarrier(barrierDir, unitBarrierName(unit, barrierName), Number(timeoutMs), progressMs === undefined ? undefined : Number(progressMs));
}
history(`leave ${label}`);
rmSync(occupantFile);
