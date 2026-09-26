// The M1 paid fixture, step 2: `node evals/m1/driver.ts <dir> --profile default|claude-only [--fake <scenario.json>]`
// runs `roadmap start` against a fixture laid out by setup.ts, waits for it to end, reads `roadmap status`
// and writes `<dir>/report.json` for check.ts.
//
// Real run (no --fake): `bin/roadmap`, the host's real CLIs and the host dir /var/tmp/roadmap. Hard timeout
// 90 min. Paid: run it once per merged batch, never per worktree agent (evals/README.md).
//
// Fake run (--fake): the fake backends behind PATH shims (test/fakes/shim.ts) play the scenario
// (evals/m1/scenario.ts), and the CLI runs through test/fixtures/exec-cli.ts with a host dir inside the
// fixture: the same `runCli` as bin/roadmap, but a fake run never claims, and never collides with, the
// machine's real host lock. Hard timeout 5 min. Free; this is how the fixture itself is tested.
//
// `claude-only` takes `codex` off PATH: every PATH directory holding an executable `codex` (the real CLI's,
// or the fake shim dir) is replaced by a shadow directory of symlinks to everything else in it.
//
// `roadmap start` returns once the detached supervisor reports its generation ready (`{kind: ready, generation,
// supervisor}`); the run goes on in the background. The driver then polls `roadmap status` until the run has
// ended: the supervisor process has exited (read from /proc by the pid on the ready line) and `run.state` is
// terminal (complete, refused or no-owner). Requiring both keeps a no-owner seen during a crash restart's
// backoff from ending the wait early. The run's exit reason is the last line the final executor printed
// (`executor.<generation>.out` in the host dir, the generation named by `exit.reason.json`); a run the
// supervisor ended at its crash limit has none.
//
// A parked unit does not end the run: once every unit is merged or parked, the executor waits, alive, until
// each blocking needs-user is acknowledged. An unattended fixture cannot answer one, so when `status` says
// `parked` the driver sends `stop` and records `endedBy: parked-stop`, then waits for the supervisor to exit
// as above; check.ts then grades the needs-user items for coherence. On the hard timeout it sends `stop`,
// waits a grace period for the supervisor to exit, then SIGKILLs the supervisor and the executor
// (`endedBy: timeout`, exit 1).
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, statOf } from '../../src/contain/proc.ts';
import { readJson } from '../../src/core/fsx.ts';
import { type ProcIdentity, executorExitReason } from '../../src/core/records.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { EXIT_REASON_FILE, type ExitReason } from '../../src/executor.ts';
import { HOST_DIR, hostPath } from '../../src/host/hostdir.ts';
import { type ProfileName, profileName } from '../../src/routing/types.ts';
import type { ArcState, Status } from '../../src/status.ts';
import { executorLogs, lastLine } from '../../src/supervisor.ts';
import { writeShims } from '../../test/fakes/shim.ts';
import { ARC, layout } from './layout.ts';
import { fakeSteps, readScenario } from './scenario.ts';

const BIN_ROADMAP = fileURLToPath(new URL('../../bin/roadmap', import.meta.url));
const EXEC_CLI = fileURLToPath(new URL('../../test/fixtures/exec-cli.ts', import.meta.url));

export const REPORT_SCHEMA = 'roadmap/m1-report';
const TIMEOUTS = {
  real: { runMs: 90 * 60_000, stopGraceMs: 5 * 60_000, pollMs: 10_000 },
  fake: { runMs: 5 * 60_000, stopGraceMs: 30_000, pollMs: 1_000 },
} as const;
const CLI_TIMEOUT_MS = 60_000;

/** `exit`: the run ended by itself; `start-failed`: `start` exited non-zero, so no run went on in the background. */
export type EndedBy = 'exit' | 'parked-stop' | 'timeout' | 'start-failed';

/** `roadmap start`'s line when the supervisor's generation is ready. */
export type Ready = Readonly<{ kind: 'ready'; generation: number; supervisor: number }>;

export type Report = Readonly<{
  schema: typeof REPORT_SCHEMA;
  profile: ProfileName;
  /** The scenario file's name for a fake run, null for a real one. */
  fake: string | null;
  startedAt: string;
  endedAt: string;
  endedBy: EndedBy;
  /** `roadmap start` itself; `ready` is its parsed line when it exited 0. */
  start: Readonly<{ code: number | null; signal: string | null; stdout: string; stderr: string; ready: Ready | null }>;
  /** The generation the run ended on (exit.reason.json), null when no executor of this run wrote one. */
  generation: number | null;
  /** The final executor's exit line, null when it wrote none (the supervisor's crash limit, a timeout, a failed start). */
  exit: ExitReason | null;
  status: Status;
}>;

type Args = Readonly<{ dir: string; profile: ProfileName; fake: string | null }>;

function parseArgs(argv: readonly string[]): Args {
  const usage = 'usage: node evals/m1/driver.ts <dir> --profile default|claude-only [--fake <scenario.json>]';
  const [dir, ...rest] = argv;
  if (dir === undefined || dir.startsWith('--')) throw new Error(usage);
  let profile: ProfileName | null = null;
  let fake: string | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (value === undefined) throw new Error(usage);
    if (rest[i] === '--profile' && profile === null) profile = profileName(value, 'profile');
    else if (rest[i] === '--fake' && fake === null) fake = resolve(value);
    else throw new Error(usage);
  }
  if (profile === null) throw new Error(usage);
  return { dir: resolve(dir), profile, fake };
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** PATH with every directory that holds `codex` replaced by a shadow of it without `codex`. */
function withoutCodex(dirs: readonly string[], shadowRoot: string): readonly string[] {
  return dirs.map((dir, i) => {
    if (!executable(join(dir, 'codex'))) return dir;
    const shadow = join(shadowRoot, String(i));
    mkdirSync(shadow, { recursive: true });
    for (const name of readdirSync(dir)) if (name !== 'codex') symlinkSync(join(dir, name), join(shadow, name));
    return shadow;
  });
}

type Cli = Readonly<{ argv: (args: readonly string[]) => readonly string[]; env: NodeJS.ProcessEnv; hostDir: AbsPath }>;

function prepare(args: Args): Cli {
  const l = layout(args.dir);
  if (!existsSync(l.plan)) throw new Error(`${args.dir} holds no fixture: run evals/m1/setup.ts first`);
  if (existsSync(l.report)) throw new Error(`${l.report} exists: a fixture dir is run once`);
  let path = (process.env['PATH'] ?? '').split(':').filter((d) => d !== '');
  let entry: (a: readonly string[]) => readonly string[] = (a) => [BIN_ROADMAP, ...a];
  let hostDir = HOST_DIR;
  if (args.fake !== null) {
    mkdirSync(l.fake, { recursive: true });
    const scenario = join(l.fake, 'scenario.json');
    writeFileSync(scenario, `${JSON.stringify({ steps: fakeSteps(readScenario(args.fake), args.profile) }, null, 2)}\n`, { flag: 'wx' });
    writeShims(join(l.fake, 'bin'), scenario);
    hostDir = absPath(join(l.fake, 'host'));
    mkdirSync(hostDir, { recursive: true });
    path = [join(l.fake, 'bin'), ...path];
    entry = (a) => [EXEC_CLI, hostDir, ...a];
  }
  if (args.profile === 'claude-only') path = [...withoutCodex(path, join(args.dir, 'path-shadow'))];
  return { argv: entry, env: { ...process.env, PATH: path.join(':') }, hostDir };
}

/** One run command (status, stop) to completion; a failure is fatal. */
function cli(c: Cli, args: readonly string[]): string {
  const r = spawnSync(process.execPath, c.argv(args), { env: c.env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`roadmap ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const TERMINAL: readonly ArcState[] = ['complete', 'refused', 'no-owner'];

const statusOf = (c: Cli, run: readonly string[]): Status => JSON.parse(cli(c, ['status', ...run])) as Status;

/** The supervisor's identity, read right after `start` returned; null when it has already exited. */
function supervisorOf(pid: number): ProcIdentity | null {
  const stat = statOf(pid);
  return stat === null || stat.state === 'Z' ? null : { pid, start: stat.start };
}

const alive = (p: ProcIdentity | null): boolean => p !== null && isAlive(p);

/** Polls until the supervisor has exited and `status` is terminal, or `deadline` passes (then returns false). */
async function awaitEnd(c: Cli, run: readonly string[], supervisor: ProcIdentity | null, deadline: number, pollMs: number, onStatus: (s: Status) => void): Promise<boolean> {
  for (;;) {
    // Liveness before status: once the supervisor is gone, the status read after it is final.
    const running = alive(supervisor);
    const s = statusOf(c, run);
    if (!running && TERMINAL.includes(s.run.state)) return true;
    if (Date.now() >= deadline) return false;
    onStatus(s);
    await sleep(pollMs);
  }
}

/** The generation this run ended on and its executor's exit line, from the host dir. */
type Ended = Readonly<{ generation: number | null; exit: ExitReason | null }>;

function exitOf(hostDir: AbsPath, readyGeneration: number): Ended {
  const path = hostPath(hostDir, EXIT_REASON_FILE);
  if (!existsSync(path)) return { generation: null, exit: null };
  const file = executorExitReason(readJson(path), EXIT_REASON_FILE);
  // The real host dir may hold an earlier run's file; this run's generations start at the ready one.
  if (file.generation < readyGeneration) return { generation: null, exit: null };
  const out = executorLogs(hostDir, file.generation).out;
  const line = lastLine(out);
  if (line === null) throw new Error(`${EXIT_REASON_FILE} names generation ${file.generation}, but ${out} holds no exit line`);
  const exit = JSON.parse(line) as ExitReason;
  if (exit.kind !== file.reason) throw new Error(`${out} ends with ${line}, but ${EXIT_REASON_FILE} says ${file.reason}`);
  return { generation: file.generation, exit };
}

export async function drive(args: Args): Promise<Report> {
  const l = layout(args.dir);
  const c = prepare(args);
  const limits = args.fake === null ? TIMEOUTS.real : TIMEOUTS.fake;
  const run = ['--repo', l.repo, '--arc', ARC];
  const startedAt = new Date();
  const deadline = startedAt.getTime() + limits.runMs;
  const s = spawnSync(process.execPath, c.argv(['start', '--repo', l.repo, '--plan', l.plan, '--profile', args.profile]), { env: c.env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
  if (s.error !== undefined) throw s.error;
  const ready = s.status === 0 ? JSON.parse(s.stdout) as Ready : null;
  if (ready !== null && ready.kind !== 'ready') throw new Error(`roadmap start exited 0 without a ready line: ${s.stdout}`);

  let endedBy: EndedBy = ready === null ? 'start-failed' : 'exit';
  let ended: Ended = { generation: null, exit: null };
  if (ready !== null) {
    const supervisor = supervisorOf(ready.supervisor);
    const onStatus = (st: Status): void => {
      if (endedBy === 'exit' && st.run.state === 'parked') {
        endedBy = 'parked-stop';
        cli(c, ['stop', ...run]);
      }
    };
    if (!(await awaitEnd(c, run, supervisor, deadline, limits.pollMs, onStatus))) {
      endedBy = 'timeout';
      cli(c, ['stop', ...run]);
      if (!(await awaitEnd(c, run, supervisor, Date.now() + limits.stopGraceMs, limits.pollMs, () => {}))) {
        const owner = statusOf(c, run).run.owner;
        if (alive(supervisor)) process.kill(supervisor!.pid, 'SIGKILL');
        if (owner.state === 'alive' && owner.pid !== null) process.kill(owner.pid, 'SIGKILL');
      }
    }
    ended = exitOf(c.hostDir, ready.generation);
  }
  const report: Report = {
    schema: REPORT_SCHEMA,
    profile: args.profile,
    fake: args.fake === null ? null : basename(args.fake),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    endedBy,
    start: { code: s.status, signal: s.signal, stdout: s.stdout, stderr: s.stderr, ready },
    generation: ended.generation,
    exit: ended.exit,
    status: statusOf(c, run),
  };
  writeFileSync(l.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const report = await drive(args);
  process.stdout.write(`${JSON.stringify({ report: layout(args.dir).report, endedBy: report.endedBy, generation: report.generation, exit: report.exit, state: report.status.run.state })}\n`);
  process.exitCode = report.endedBy === 'timeout' || report.start.code !== 0 ? 1 : 0;
}
