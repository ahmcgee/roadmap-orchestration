// The M3 fixture's lane barrier: `node barrier.ts <barrierDir> <job> <timeoutMs> -- <cmd> [args...]` runs `cmd`
// after waiting, but waits only in `<job>`'s lane series: when the lane's working directory (the job's detached
// checkout, `<worktreeRoot>/<arc>/<job>.lanes`) is that job's. Every other run of the lane (the baseline job, a
// candidate, a re-witness on a later head) passes straight through, and so does a run after the driver released
// the barrier. Waiting, it writes `<barrierDir>/<job>.money.reached`, then polls for `.release`, printing a progress
// line every PROGRESS_MS (the runner's stall watchdog counts output as progress). The command inherits stdio and
// the environment (the witness reporter's NODE_OPTIONS and ROADMAP_WITNESS_FILE included); its exit is this
// process's exit.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

const PROGRESS_MS = 5_000;
const POLL_MS = 100;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => void Atomics.wait(sleepCell, 0, 0, ms);

const argv = process.argv.slice(2);
const [dir, job, timeout, dashes, cmd, ...args] = argv;
if (dir === undefined || job === undefined || timeout === undefined || dashes !== '--' || cmd === undefined) {
  throw new Error(`usage: barrier <barrierDir> <job> <timeoutMs> -- <cmd> [args...], got ${JSON.stringify(argv)}`);
}

const base = join(dir, `${job}.money`);
if (basename(process.cwd()) === `${job}.lanes` && !existsSync(`${base}.release`)) {
  writeFileSync(`${base}.reached`, `${process.pid}\n`);
  const deadline = Date.now() + Number(timeout);
  let progress = 0;
  while (!existsSync(`${base}.release`)) {
    const now = Date.now();
    if (now >= deadline) throw new Error(`barrier ${base} not released within ${timeout} ms`);
    if (now >= progress) {
      writeSync(1, `waiting at ${job}.money\n`);
      progress = now + PROGRESS_MS;
    }
    sleepSync(POLL_MS);
  }
  writeSync(1, `released ${job}.money\n`);
}

const r = spawnSync(cmd, args, { stdio: 'inherit' });
if (r.error !== undefined) throw r.error;
if (r.signal !== null) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
