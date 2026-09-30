// The M2 paid fixture, step 2: `node evals/m2/driver.ts <dir> --profile default|claude-only [--fake <story dir>]`
// runs `roadmap start` against a fixture laid out by setup.ts, applies the forcing devices as the run reaches
// them, waits for it to end, and writes `<dir>/report.json` for check.ts.
//
// Real run (no --fake): `bin/roadmap`, the host's real CLIs and the host dir /var/tmp/roadmap; hard timeout
// 120 min. Paid: once per merged batch (evals/README.md). Fake run (--fake): the fake backends behind PATH
// shims play the story (evals/m2/scenario.ts), the CLI runs through test/fixtures/exec-cli.ts with a host dir
// inside the fixture; hard timeout 10 min. `claude-only` takes `codex` off PATH as in evals/m1/driver.ts.
//
// The forcing devices (plan "Fixture evals/m2/", revision 2.1 G9), all durable gates rather than timing. Each
// fires once, when the condition it waits for holds in `roadmap status`, the log or the barrier files, and is
// recorded in the report (`devices`), which check.ts reads:
//
//   run-only    before `start`, the driver creates the run dir and queues `run-only base left right top`: the
//               scheduler's first iteration applies it before it dispatches anything (graph commands take effect
//               synchronously), so `urgent` never starts until it joins
//   kill        once `left` and `right` both wait at `estate-hold` round 1 (their `.reached` files), status
//               shows the pool's two instances used and both units running lanes: SIGKILL the executor (status'
//               owner pid). Their lane runners live on: the respawned executor's recovery adopts them
//   respawn     once the supervisor's respawned generation owns the run: arm instance #1's teardown-fails-once
//               marker, then release round 1 of both. Recovery then cleans the dead holders' reservations:
//               #2's teardown passes, #1's fails in recovery's cleanup of the killed holder, a residue no stage
//               outcome parks, which the residue's own probe reclaims; and the units run their
//               lanes again
//   teardown    once both wait at `estate-hold` round 2, status showing both instances used again: arm
//               instance #2's teardown-fails-once marker, then release round 2. The holder of #2 fails its
//               cleanup on the live path: a residue, a retryable park on `resource{estate#2}`, whose probe
//               reclaims it (reclaim → teardown → `cleaned` → release), and the unit runs its lanes again. Armed
//               here, not at setup, so this failure lands on the live path, not in recovery's cleanup
//   edge        once `left` is merged: `resolve-edge e-top`
//   pause       once `right` waits at `right-hold`, after its edit commit (the driver reads the shared line
//               on `right`'s branch): `pause right`. The pause kills the lane, which records the lanes stage
//               `interrupted`: `right` is held, with nothing running
//   quiescent   once status shows `right` held with nothing running: release `right-hold` (the killed lane no
//               longer waits; a lane run again passes), then `run-only base left right top urgent`
//   reentry     once `urgent` is merged: `git merge-tree` must show `right`'s branch and integration conflicting
//               on the shared file; then the driver writes right2.json, appends `right2 {reenters: {unit:
//               right, enterAt: verify}}` to the plan and runs `roadmap apply`
//   unlimited   once the apply's receipt is `applied`: `run-only --clear`
//
// A device whose check fails (no conflict, a rejected apply) stops the run: `endedBy: device-failed` with the
// reason in `devices.failed`. As in M1, a run parked on a blocking needs-user is stopped (`parked-stop`), and the
// hard timeout stops, then SIGKILLs. The driver refuses a fixture dir that already holds a report or a run dir:
// a fixture is set up and run once.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { terminalReceipt } from '../../src/commands/queue.ts';
import { isAlive, statOf } from '../../src/contain/proc.ts';
import { readJson } from '../../src/core/fsx.ts';
import { arcId, commandId, unitId } from '../../src/core/ids.ts';
import { type ProcIdentity, executorExitReason } from '../../src/core/records.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { EXIT_REASON_FILE, type ExitReason } from '../../src/executor.ts';
import { HOST_DIR, hostPath } from '../../src/host/hostdir.ts';
import { unitBranch } from '../../src/pipeline/dispatch.ts';
import { type ProfileName, profileName } from '../../src/routing/types.ts';
import type { ArcState, Status, UnitStatusLine } from '../../src/status.ts';
import { executorLogs, lastLine } from '../../src/supervisor.ts';
import { writeShims } from '../../test/fakes/shim.ts';
import {
  EDGE, ESTATE_HOLD, INTEGRATION, type Layout, POOL, RIGHT_HOLD, SHARED_FILE, UNITS, barrierFile, layout, teardownFailsOnce,
} from './layout.ts';
import { storySteps } from './scenario.ts';
import { json, reentrySpec, reentryUnit } from './setup.ts';

const BIN_ROADMAP = fileURLToPath(new URL('../../bin/roadmap', import.meta.url));
const EXEC_CLI = fileURLToPath(new URL('../../test/fixtures/exec-cli.ts', import.meta.url));

export const REPORT_SCHEMA = 'roadmap/m2-report';
const TIMEOUTS = {
  real: { runMs: 120 * 60_000, stopGraceMs: 5 * 60_000, pollMs: 5_000 },
  fake: { runMs: 10 * 60_000, stopGraceMs: 60_000, pollMs: 250 },
} as const;
const CLI_TIMEOUT_MS = 60_000;

export type EndedBy = 'exit' | 'parked-stop' | 'device-failed' | 'timeout' | 'start-failed';
export type Ready = Readonly<{ kind: 'ready'; generation: number; supervisor: number }>;

/** The forcing devices as the driver applied them, in order; null until each fired. */
export type Devices = {
  runOnly: string | null;
  kill: { generation: number; pid: number; at: string } | null;
  respawn: { generation: number; at: string } | null;
  teardown: { at: string } | null;
  edge: string | null;
  pause: { command: string; rightTip: string } | null;
  quiescent: { at: string; runOnly: string } | null;
  mergeTree: { conflict: boolean; paths: readonly string[]; right: string; integration: string } | null;
  reentry: string | null;
  unlimited: string | null;
  failed: string | null;
};

export type Report = Readonly<{
  schema: typeof REPORT_SCHEMA;
  profile: ProfileName;
  /** The story dir's name for a fake run, null for a real one. */
  fake: string | null;
  /** The host dir the run claimed: the residue index check.ts reads. */
  hostDir: string;
  startedAt: string;
  endedAt: string;
  endedBy: EndedBy;
  start: Readonly<{ code: number | null; signal: string | null; stdout: string; stderr: string; ready: Ready | null }>;
  generation: number | null;
  exit: ExitReason | null;
  devices: Devices;
  status: Status;
}>;

type Args = Readonly<{ dir: string; profile: ProfileName; fake: string | null }>;

function parseArgs(argv: readonly string[]): Args {
  const usage = 'usage: node evals/m2/driver.ts <dir> --profile default|claude-only [--fake <story dir>]';
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

/** PATH with every directory that holds `codex` replaced by a shadow of it without `codex` (as evals/m1). */
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
  if (!existsSync(l.plan)) throw new Error(`${args.dir} holds no fixture: run evals/m2/setup.ts first`);
  if (existsSync(l.report)) throw new Error(`${l.report} exists: a fixture dir is run once`);
  if (existsSync(l.runDir)) throw new Error(`${l.runDir} exists: this fixture was started before; set up a fresh dir`);
  let path = (process.env['PATH'] ?? '').split(':').filter((d) => d !== '');
  let entry: (a: readonly string[]) => readonly string[] = (a) => [BIN_ROADMAP, ...a];
  let hostDir = HOST_DIR;
  if (args.fake !== null) {
    mkdirSync(l.fake, { recursive: true });
    const scenario = join(l.fake, 'scenario.json');
    writeFileSync(scenario, json({ steps: storySteps(args.fake, args.profile) }), { flag: 'wx' });
    writeShims(join(l.fake, 'bin'), scenario);
    hostDir = absPath(join(l.fake, 'host'));
    mkdirSync(hostDir, { recursive: true });
    path = [join(l.fake, 'bin'), ...path];
    entry = (a) => [EXEC_CLI, hostDir, ...a];
  }
  if (args.profile === 'claude-only') path = [...withoutCodex(path, join(args.dir, 'path-shadow'))];
  return { argv: entry, env: { ...process.env, PATH: path.join(':') }, hostDir };
}

/** One run command to completion; a failure is fatal. */
function cli(c: Cli, args: readonly string[]): string {
  const r = spawnSync(process.execPath, c.argv(args), { env: c.env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`roadmap ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

/** A queued command's id, from the CLI's `{command, arc, type}` line. */
const submitted = (out: string): string => (JSON.parse(out) as { command: string }).command;

const TERMINAL: readonly ArcState[] = ['complete', 'refused', 'no-owner'];

function supervisorOf(pid: number): ProcIdentity | null {
  const stat = statOf(pid);
  return stat === null || stat.state === 'Z' ? null : { pid, start: stat.start };
}

const alive = (p: ProcIdentity | null): boolean => p !== null && isAlive(p);

/** Polls until the supervisor has exited and `status` is terminal, or `deadline` passes (then returns false). */
async function awaitEnd(status: () => Status, supervisor: ProcIdentity | null, deadline: number, pollMs: number, onStatus: (s: Status) => void): Promise<boolean> {
  for (;;) {
    const running = alive(supervisor);
    const s = status();
    if (!running && TERMINAL.includes(s.run.state)) return true;
    if (Date.now() >= deadline) return false;
    onStatus(s);
    await sleep(pollMs);
  }
}

type Ended = Readonly<{ generation: number | null; exit: ExitReason | null }>;

function exitOf(hostDir: AbsPath, readyGeneration: number): Ended {
  const path = hostPath(hostDir, EXIT_REASON_FILE);
  if (!existsSync(path)) return { generation: null, exit: null };
  const file = executorExitReason(readJson(path), EXIT_REASON_FILE);
  if (file.generation < readyGeneration) return { generation: null, exit: null };
  const out = executorLogs(hostDir, file.generation).out;
  const line = lastLine(out);
  if (line === null) throw new Error(`${EXIT_REASON_FILE} names generation ${file.generation}, but ${out} holds no exit line`);
  const exit = JSON.parse(line) as ExitReason;
  if (exit.kind !== file.reason) throw new Error(`${out} ends with ${line}, but ${EXIT_REASON_FILE} says ${file.reason}`);
  return { generation: file.generation, exit };
}

// ---------------------------------------------------------------------------------------------------
// The forcing devices

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(repo: string, args: readonly string[], ok: readonly number[] = [0]): Readonly<{ code: number; stdout: string }> {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  if (r.error !== undefined) throw r.error;
  if (r.status === null || !ok.includes(r.status)) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
  return { code: r.status, stdout: r.stdout.trim() };
}

const unitLine = (s: Status, unit: string): UnitStatusLine | undefined => s.units.find((u) => u.unit === unit);
const merged = (s: Status, unit: string): boolean => unitLine(s, unit)?.status === 'retired';
const reached = (l: Layout, unit: string, name: string, round: number): boolean => existsSync(barrierFile(l, unit, name, round, 'reached'));
const release = (l: Layout, unit: string, name: string, round: number): void => writeFileSync(barrierFile(l, unit, name, round, 'release'), '', { flag: 'wx' });
/** `left` and `right` both wait at `estate-hold` round `round`, holding the pool's two instances, their lanes running. */
const bothHold = (l: Layout, s: Status, round: number): boolean =>
  ['left', 'right'].every((u) => reached(l, u, ESTATE_HOLD, round) && unitLine(s, u)?.running?.stage === 'lanes') && s.host.pools[POOL]?.used === 2;
const now = (): string => new Date().toISOString();
const rightBranch = (l: Layout): string => unitBranch(arcId(l.arc), unitId('right'));

/** `git merge-tree` of `right`'s branch and integration: whether they conflict, and on which paths. */
function mergeTree(l: Layout): NonNullable<Devices['mergeTree']> {
  const right = git(l.repo, ['rev-parse', rightBranch(l)]).stdout;
  const integration = git(l.repo, ['rev-parse', `refs/heads/${INTEGRATION}`]).stdout;
  const r = git(l.repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', right, integration], [0, 1]);
  const paths = r.code === 1 ? r.stdout.split('\n').slice(1).filter((p) => p !== '') : [];
  return { conflict: r.code === 1, paths, right, integration };
}

/** Appends `right2` (re-entering `right` at verify) to the plan, as the architect would, and writes its spec. */
function writeReentry(l: Layout): void {
  writeFileSync(join(l.input, reentryUnit.spec), json(reentrySpec(l)), { flag: 'wx' });
  const plan = JSON.parse(readFileSync(l.plan, 'utf8')) as { units: object[] };
  writeFileSync(l.plan, json({ ...plan, units: [...plan.units, reentryUnit] }));
}

/**
 * One poll's worth of devices: fires every device whose condition holds now, in order. Returns a failure
 * reason when a device's own check fails (the caller stops the run), else null.
 */
function fire(l: Layout, c: Cli, run: readonly string[], d: Devices, s: Status): string | null {
  const owner = s.run.owner;
  if (d.kill === null) {
    if (bothHold(l, s, 1) && owner.state === 'alive' && owner.pid !== null && owner.generation !== null) {
      process.kill(owner.pid, 'SIGKILL');
      d.kill = { generation: owner.generation, pid: owner.pid, at: now() };
    }
    return null;
  }
  if (d.respawn === null) {
    if (owner.state === 'alive' && owner.generation !== null && owner.generation > d.kill.generation) {
      writeFileSync(teardownFailsOnce(l, 1), '', { flag: 'wx' });
      for (const u of ['left', 'right']) release(l, u, ESTATE_HOLD, 1);
      d.respawn = { generation: owner.generation, at: now() };
    }
    return null;
  }
  if (d.teardown === null) {
    if (!bothHold(l, s, 2) || owner.state !== 'alive') return null;
    writeFileSync(teardownFailsOnce(l, 2), '', { flag: 'wx' });
    for (const u of ['left', 'right']) release(l, u, ESTATE_HOLD, 2);
    d.teardown = { at: now() };
    return null;
  }
  if (d.edge === null && merged(s, 'left')) {
    d.edge = submitted(cli(c, ['resolve-edge', EDGE, '--evidence', `left merged; integration at ${git(l.repo, ['rev-parse', `refs/heads/${INTEGRATION}`]).stdout}`, ...run]));
  }
  if (d.pause === null) {
    if (!reached(l, 'right', RIGHT_HOLD, 1)) return null;
    const rightTip = git(l.repo, ['rev-parse', rightBranch(l)]).stdout;
    const line = git(l.repo, ['show', `${rightTip}:${SHARED_FILE}`]).stdout;
    if (!line.includes("'right'")) return `right waits at ${RIGHT_HOLD}, but its branch's ${SHARED_FILE} does not register 'right': ${JSON.stringify(line)}`;
    d.pause = { command: submitted(cli(c, ['pause', 'right', ...run])), rightTip };
    return null;
  }
  if (d.quiescent === null) {
    const right = unitLine(s, 'right');
    if (right?.state !== 'held' || right.running !== null) return null;
    release(l, 'right', RIGHT_HOLD, 1);
    d.quiescent = { at: now(), runOnly: submitted(cli(c, ['run-only', ...UNITS, ...run])) };
    return null;
  }
  if (d.mergeTree === null) {
    if (!merged(s, 'urgent')) return null;
    d.mergeTree = mergeTree(l);
    if (!d.mergeTree.conflict || !d.mergeTree.paths.includes(SHARED_FILE)) {
      return `urgent merged, but right's branch and integration do not conflict on ${SHARED_FILE}: ${JSON.stringify(d.mergeTree)}`;
    }
    writeReentry(l);
    d.reentry = submitted(cli(c, ['apply', ...run]));
    return null;
  }
  if (d.unlimited === null && d.reentry !== null) {
    const receipt = terminalReceipt(absPath(l.runDir), commandId(d.reentry));
    if (receipt === null) return null;
    if (receipt.state !== 'applied') return `the re-entry apply ${d.reentry} was ${receipt.state}: ${JSON.stringify(receipt)}`;
    d.unlimited = submitted(cli(c, ['run-only', '--clear', ...run]));
  }
  return null;
}

export async function drive(args: Args): Promise<Report> {
  const l = layout(args.dir);
  const c = prepare(args);
  const limits = args.fake === null ? TIMEOUTS.real : TIMEOUTS.fake;
  const run = ['--repo', l.repo, '--arc', l.arc];
  const status = (): Status => JSON.parse(cli(c, ['status', ...run])) as Status;
  const devices: Devices = { runOnly: null, kill: null, respawn: null, teardown: null, edge: null, pause: null, quiescent: null, mergeTree: null, reentry: null, unlimited: null, failed: null };
  const startedAt = new Date();
  const deadline = startedAt.getTime() + limits.runMs;

  // `urgent` is kept out from the first dispatch: the run dir is created for the queue, which the arc's first
  // scheduler iteration reads.
  mkdirSync(l.runDir, { recursive: true });
  devices.runOnly = submitted(cli(c, ['run-only', ...UNITS.filter((u) => u !== 'urgent'), ...run]));

  const s = spawnSync(process.execPath, c.argv(['start', '--repo', l.repo, '--plan', l.plan, '--profile', args.profile]), { env: c.env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
  if (s.error !== undefined) throw s.error;
  const ready = s.status === 0 ? JSON.parse(s.stdout) as Ready : null;
  if (ready !== null && ready.kind !== 'ready') throw new Error(`roadmap start exited 0 without a ready line: ${s.stdout}`);

  let endedBy: EndedBy = ready === null ? 'start-failed' : 'exit';
  let ended: Ended = { generation: null, exit: null };
  if (ready !== null) {
    const supervisor = supervisorOf(ready.supervisor);
    const onStatus = (st: Status): void => {
      if (endedBy !== 'exit') return;
      if (st.run.state === 'parked') {
        endedBy = 'parked-stop';
        cli(c, ['stop', ...run]);
        return;
      }
      const failed = fire(l, c, run, devices, st);
      if (failed !== null) {
        devices.failed = failed;
        endedBy = 'device-failed';
        cli(c, ['stop', ...run]);
      }
    };
    if (!(await awaitEnd(status, supervisor, deadline, limits.pollMs, onStatus))) {
      endedBy = 'timeout';
      cli(c, ['stop', ...run]);
      if (!(await awaitEnd(status, supervisor, Date.now() + limits.stopGraceMs, limits.pollMs, () => {}))) {
        const owner = status().run.owner;
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
    hostDir: c.hostDir,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    endedBy,
    start: { code: s.status, signal: s.signal, stdout: s.stdout, stderr: s.stderr, ready },
    generation: ended.generation,
    exit: ended.exit,
    devices,
    status: status(),
  };
  writeFileSync(l.report, json(report), { flag: 'wx' });
  return report;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const report = await drive(args);
  process.stdout.write(`${JSON.stringify({ report: layout(args.dir).report, endedBy: report.endedBy, generation: report.generation, exit: report.exit, state: report.status.run.state, failed: report.devices.failed })}\n`);
  process.exitCode = report.endedBy === 'exit' ? 0 : 1;
}

