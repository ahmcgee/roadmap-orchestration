// The M3 fixture's money-lane barrier (branch R only): `node barrier.ts <barrierDir> <timeoutMs> -- <cmd> [args...]`
// runs `cmd` after waiting, but waits only when the I-2 regression is on the tree an audit runs the lane on: the lane's
// working directory is an audit's lane checkout (`<worktreeRoot>/<arc>/audit-<n>.lanes`) and `node src/cli.js format
// 0.125` there does not print `0.12`. So it holds the first audit that sees tidy's regression (branch R: A1 on S), and
// passes straight through everywhere else: the baseline, a candidate, a re-witness, an audit of a tree without the
// regression (branch P never regresses), and every run after the driver released it. Waiting, it writes
// `<barrierDir>/money.reached` (the audit job's id), then polls for `money.release`, printing a progress line every
// PROGRESS_MS (the runner's stall watchdog counts output as progress). The command inherits stdio and the environment
// (the witness reporter's NODE_OPTIONS and ROADMAP_WITNESS_FILE included); its exit is this process's exit.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

const PROGRESS_MS = 5_000;
const POLL_MS = 100;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => void Atomics.wait(sleepCell, 0, 0, ms);

const argv = process.argv.slice(2);
const [dir, timeout, dashes, cmd, ...args] = argv;
if (dir === undefined || timeout === undefined || dashes !== '--' || cmd === undefined) {
  throw new Error(`usage: barrier <barrierDir> <timeoutMs> -- <cmd> [args...], got ${JSON.stringify(argv)}`);
}

/** Whether the tree here carries the regression: `format 0.125` prints something other than half-even's `0.12`. */
function regressed(): boolean {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS' && k !== 'ROADMAP_WITNESS_FILE'));
  const r = spawnSync(process.execPath, ['src/cli.js', 'format', '0.125'], { encoding: 'utf8', env, timeout: 30_000 });
  return r.stdout !== '0.12\n';
}

const job = /^(audit-[0-9]+)\.lanes$/.exec(basename(process.cwd()))?.[1];
const base = join(dir, 'money');
if (job !== undefined && !existsSync(`${base}.release`) && regressed()) {
  writeFileSync(`${base}.reached`, `${job}\n`);
  const deadline = Date.now() + Number(timeout);
  let progress = 0;
  while (!existsSync(`${base}.release`)) {
    const now = Date.now();
    if (now >= deadline) throw new Error(`barrier ${base} not released within ${timeout} ms`);
    if (now >= progress) {
      writeSync(1, `waiting at money (${job})\n`);
      progress = now + PROGRESS_MS;
    }
    sleepSync(POLL_MS);
  }
  writeSync(1, `released money (${job})\n`);
}

const r = spawnSync(cmd, args, { stdio: 'inherit' });
if (r.error !== undefined) throw r.error;
if (r.signal !== null) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
