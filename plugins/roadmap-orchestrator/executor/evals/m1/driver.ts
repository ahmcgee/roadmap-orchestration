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
// A parked unit does not end the run: once every unit is merged or parked, the executor waits, alive, until
// each blocking needs-user is acknowledged. An unattended fixture cannot answer one, so when `status` says
// `parked` the driver sends `stop` and records `endedBy: parked-stop`; check.ts then grades the needs-user
// items for coherence. On the hard
// timeout it sends `stop`, waits a grace period, then SIGKILLs the executor (`endedBy: timeout`, exit 1).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExitReason } from '../../src/executor.ts';
import { type ProfileName, profileName } from '../../src/routing/types.ts';
import type { Status } from '../../src/status.ts';
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

export type EndedBy = 'exit' | 'parked-stop' | 'timeout';

export type Report = Readonly<{
  schema: typeof REPORT_SCHEMA;
  profile: ProfileName;
  /** The scenario file's name for a fake run, null for a real one. */
  fake: string | null;
  startedAt: string;
  endedAt: string;
  endedBy: EndedBy;
  start: Readonly<{ code: number | null; signal: string | null; reason: ExitReason | null; stderr: string }>;
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

type Cli = Readonly<{ argv: (args: readonly string[]) => readonly string[]; env: NodeJS.ProcessEnv }>;

function prepare(args: Args): Cli {
  const l = layout(args.dir);
  if (!existsSync(l.plan)) throw new Error(`${args.dir} holds no fixture: run evals/m1/setup.ts first`);
  if (existsSync(l.report)) throw new Error(`${l.report} exists: a fixture dir is run once`);
  let path = (process.env['PATH'] ?? '').split(':').filter((d) => d !== '');
  let entry: (a: readonly string[]) => readonly string[] = (a) => [BIN_ROADMAP, ...a];
  if (args.fake !== null) {
    mkdirSync(l.fake, { recursive: true });
    const scenario = join(l.fake, 'scenario.json');
    writeFileSync(scenario, `${JSON.stringify({ steps: fakeSteps(readScenario(args.fake), args.profile) }, null, 2)}\n`, { flag: 'wx' });
    writeShims(join(l.fake, 'bin'), scenario);
    const hostDir = join(l.fake, 'host');
    mkdirSync(hostDir, { recursive: true });
    path = [join(l.fake, 'bin'), ...path];
    entry = (a) => [EXEC_CLI, hostDir, ...a];
  }
  if (args.profile === 'claude-only') path = [...withoutCodex(path, join(args.dir, 'path-shadow'))];
  return { argv: entry, env: { ...process.env, PATH: path.join(':') } };
}

/** One run command (status, stop) to completion; a failure is fatal. */
function cli(c: Cli, args: readonly string[]): string {
  const r = spawnSync(process.execPath, c.argv(args), { env: c.env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`roadmap ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

type Ended = Readonly<{ code: number | null; signal: string | null; stdout: string; stderr: string }>;

function startChild(c: Cli, args: readonly string[]): Readonly<{ child: ChildProcess; ended: Promise<Ended> }> {
  const child = spawn(process.execPath, c.argv(args), { env: c.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (s: string) => (stdout += s));
  child.stderr!.setEncoding('utf8').on('data', (s: string) => (stderr += s));
  const ended = new Promise<Ended>((done, fail) => {
    child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal, stdout, stderr }));
  });
  return { child, ended };
}

function exitReason(stdout: string): ExitReason | null {
  const lines = stdout.trim().split('\n').filter((s) => s !== '');
  return lines.length === 1 ? JSON.parse(lines[0]!) as ExitReason : null;
}

export async function drive(args: Args): Promise<Report> {
  const l = layout(args.dir);
  const c = prepare(args);
  const limits = args.fake === null ? TIMEOUTS.real : TIMEOUTS.fake;
  const run = ['--repo', l.repo, '--arc', ARC];
  const startedAt = new Date();
  const { child, ended } = startChild(c, ['start', '--repo', l.repo, '--plan', l.plan, '--profile', args.profile]);
  const exited = { now: false };
  void ended.then(() => (exited.now = true), () => (exited.now = true));

  let endedBy: EndedBy = 'exit';
  const deadline = startedAt.getTime() + limits.runMs;
  while (!exited.now) {
    await Promise.race([ended, sleep(limits.pollMs)]);
    if (exited.now) break;
    if (Date.now() >= deadline) {
      endedBy = 'timeout';
      cli(c, ['stop', ...run]);
      const killed = await Promise.race([ended, sleep(limits.stopGraceMs).then(() => null)]);
      if (killed === null) child.kill('SIGKILL');
      break;
    }
    if (endedBy === 'exit' && (JSON.parse(cli(c, ['status', ...run])) as Status).run.state === 'parked') {
      endedBy = 'parked-stop';
      cli(c, ['stop', ...run]);
    }
  }
  const e = await ended;
  const report: Report = {
    schema: REPORT_SCHEMA,
    profile: args.profile,
    fake: args.fake === null ? null : basename(args.fake),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    endedBy,
    start: { code: e.code, signal: e.signal, reason: exitReason(e.stdout), stderr: e.stderr },
    status: JSON.parse(cli(c, ['status', ...run])) as Status,
  };
  writeFileSync(l.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const report = await drive(args);
  process.stdout.write(`${JSON.stringify({ report: layout(args.dir).report, endedBy: report.endedBy, start: report.start.reason, state: report.status.run.state })}\n`);
  process.exitCode = report.endedBy === 'timeout' || report.start.code !== 0 ? 1 : 0;
}
