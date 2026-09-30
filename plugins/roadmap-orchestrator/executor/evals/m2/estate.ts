// The M2 fixture's directory-backed estate pool and its lane barriers (no docker, no kind). Run by the plan's
// probe, teardown and lanes as `node estate.ts <cmd> ...`:
//
//   probe <stateDir>                    the PROBE_EXIT contract: the instance's occupant absent → 0, the
//                                       caller's own label → 10, another's → 11
//   teardown <stateDir>                 removes the occupant when it is the caller's (history `leave`); the
//                                       marker `<stateDir>/estate#<n>.teardown-fails-once`, when present, is
//                                       consumed instead and the teardown exits 1 having removed nothing
//                                       (history `teardown-failed`): a teardown that fails exactly once. The
//                                       driver arms it (evals/m2/driver.ts)
//   hold <stateDir> [<barrierDir> <name> <rounds> <timeoutMs>]
//                                       the estate lane: claims the instance (a second owner logs
//                                       `conflict:<holder>` and exits 1; history `enter`), waits at the barrier
//                                       if named, then leaves (history `leave`)
//   barrier <barrierDir> <name> <rounds> <timeoutMs>
//                                       a lane that only waits at the barrier (no instance)
//
// The instance is `<stateDir>/estate#<n>/`, `n` from RESOURCE_INSTANCE_ESTATE; the owner label is
// RESOURCE_OWNER (`<arc>/<unit>`). history.log lines are `<event> <label> <epoch ms>`; check.ts replays them to
// show no instance had two owners at once. Every call appends `<cmd> estate#<n> <label>` to
// `<stateDir>/calls.log`.
//
// Barriers are per unit and counted in rounds: `<barrierDir>/<unit>.<name>.<k>` for k = 1..rounds. A run of the
// lane waits at the first round the driver has not released (it writes `.reached`, then waits for `.release`,
// printing a progress line every PROGRESS_MS: a quiet lane is not a stalled one); a run after the last round
// passes straight through. So each round holds exactly one run of the lane, and the pipeline may run the lane
// again (after a crash or a recovered park) without ever blocking past the rounds the driver means.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const POOL = 'estate';
const INSTANCE_ENV = 'RESOURCE_INSTANCE_ESTATE';
const PROGRESS_MS = 5_000;
const POLL_MS = 100;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => void Atomics.wait(sleepCell, 0, 0, ms);

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`estate: ${name} is not set`);
  return v;
}

/** Waits at the unit's first unreleased round of barrier `name`; returns at once when every round is released. */
function barrier(dir: string, name: string, rounds: number, timeoutMs: number, label: string): void {
  const unit = label.slice(label.lastIndexOf('/') + 1);
  const round = Array.from({ length: rounds }, (_, i) => i + 1).find((k) => !existsSync(join(dir, `${unit}.${name}.${k}.release`)));
  if (round === undefined) return;
  const base = join(dir, `${unit}.${name}.${round}`);
  writeFileSync(`${base}.reached`, `${process.pid}\n`);
  const deadline = Date.now() + timeoutMs;
  let progress = 0;
  while (!existsSync(`${base}.release`)) {
    const now = Date.now();
    if (now >= deadline) throw new Error(`estate: barrier ${base} not released within ${timeoutMs} ms`);
    if (now >= progress) {
      writeSync(1, `waiting at ${unit}.${name}.${round}\n`);
      progress = now + PROGRESS_MS;
    }
    sleepSync(POLL_MS);
  }
  writeSync(1, `released ${unit}.${name}.${round}\n`);
}

/** `<barrierDir> <name> <rounds> <timeoutMs>` from `args`, or null when `args` names no barrier. */
function barrierArgs(args: readonly string[], usage: string): Readonly<{ dir: string; name: string; rounds: number; timeoutMs: number }> | null {
  if (args.length === 0) return null;
  const [dir, name, rounds, timeoutMs] = args;
  if (dir === undefined || name === undefined || rounds === undefined || timeoutMs === undefined || args.length !== 4) {
    throw new Error(`usage: ${usage}, got ${JSON.stringify(process.argv.slice(2))}`);
  }
  return { dir, name, rounds: Number(rounds), timeoutMs: Number(timeoutMs) };
}

const [cmd, ...args] = process.argv.slice(2);
const label = need('RESOURCE_OWNER');

if (cmd === 'barrier') {
  const b = barrierArgs(args, 'estate barrier <barrierDir> <name> <rounds> <timeoutMs>');
  if (b === null) throw new Error('estate barrier: no barrier named');
  barrier(b.dir, b.name, b.rounds, b.timeoutMs, label);
  process.exit(0);
}
if (cmd !== 'probe' && cmd !== 'teardown' && cmd !== 'hold') throw new Error(`usage: estate <probe|teardown|hold|barrier> ..., got ${JSON.stringify(process.argv.slice(2))}`);
const [stateDir, ...rest] = args;
if (stateDir === undefined) throw new Error(`usage: estate ${cmd} <stateDir> ..., got ${JSON.stringify(args)}`);
const instance = `${POOL}#${need(INSTANCE_ENV)}`;
const dir = join(stateDir, instance);
mkdirSync(dir, { recursive: true });
appendFileSync(join(stateDir, 'calls.log'), `${cmd} ${instance} ${label}\n`);
const occupantFile = join(dir, 'occupant');
const history = (event: string): void => appendFileSync(join(dir, 'history.log'), `${event} ${label} ${Date.now()}\n`);
const occupant = (): string | null => (existsSync(occupantFile) ? readFileSync(occupantFile, 'utf8') : null);

if (cmd === 'probe') {
  const held = occupant();
  process.exit(held === null ? 0 : held === label ? 10 : 11);
}
if (cmd === 'teardown') {
  const once = join(stateDir, `${instance}.teardown-fails-once`);
  if (existsSync(once)) {
    rmSync(once);
    history('teardown-failed');
    process.stderr.write(`estate: the teardown of ${instance} fails once\n`);
    process.exit(1);
  }
  if (occupant() === label) {
    history('leave');
    rmSync(occupantFile);
  }
  process.exit(0);
}
const hold = barrierArgs(rest, 'estate hold <stateDir> [<barrierDir> <name> <rounds> <timeoutMs>]');
try {
  writeFileSync(occupantFile, label, { flag: 'wx' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  history(`conflict:${occupant()}`);
  process.stderr.write(`estate: ${instance} is held by ${occupant()}\n`);
  process.exit(1);
}
history('enter');
if (hold !== null) barrier(hold.dir, hold.name, hold.rounds, hold.timeoutMs, label);
history('leave');
rmSync(occupantFile);
