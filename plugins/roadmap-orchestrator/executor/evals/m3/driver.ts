// The M3 paid fixture, step 2: `node evals/m3/driver.ts <dir> --profile default|claude-only [--fake <story>]` runs
// `roadmap start` against a fixture laid out by setup.ts, applies the forcing devices as the run reaches them, waits
// for it to end, and writes `<dir>/report.json` for check.ts.
//
// Real run (no --fake): `bin/roadmap`, the host's real CLIs and the host dir /var/tmp/roadmap; hard timeout 180 min.
// Paid: once per merged batch, `--profile default` (evals/README.md). Fake run (--fake <story>, evals/m3/scenario.ts):
// the fake backends behind PATH shims play the story, the CLI runs through test/fixtures/exec-cli.ts with a host dir
// inside the fixture; hard timeout 15 min. `claude-only` takes `codex` off PATH as in evals/m1/driver.ts.
//
// The forcing devices (plan "Fixture evals/m3/", story steps 1–11), each a durable gate on the log, `roadmap status`
// or a barrier file, never on timing. Each fires once and is recorded in the report (`devices`), which check.ts reads:
//
//   runOnly      before `start`, the driver creates the run dir and queues `run-only parse tidy`: `report` never
//                starts before audit A1 waits at its barrier
//   barrier      once audit-1's run of the money lane (I-2) waits at the barrier (`barriers/audit-1.money.reached`,
//                barrier.ts): `run-only parse report tidy`, so `report` merges at S′ while A1 audits S
//   release      once `report` is merged: release the barrier. A1 then opens its P1 over I-2 and re-witnesses it on S′
//   staleApply   once the first checkpoint's `checkpoint-inputs` is in the log: the architect's edit of the plan's
//                `direction` (setup.ts DIRECTION_EDITED) by `roadmap apply`, so that checkpoint's bundle is stale whole
//   staleApplied once that apply's receipt is `applied`; under --fake it then releases the fake checkpoint call held at
//                `fake/ckpt-1.hold` (a real call takes long enough; if it does not, the check fails the story)
//   repair       G18: once a `plan-applied{source: bundle}` adds a unit, its id (the repair)
//   admitRepair  once an audit started after that revision (A2, the drift audit): `run-only` the plan units and the
//                repair, so the repair merges after A2's capture
//   digest       once a `divergence-digest` item is open: `ack` it
//   bound        once a `convergence-bound` item is open: `ack` it
//   unlimited    once the repair is merged: `run-only --clear`
//
// Device failures stop the run (`endedBy: device-failed`, the reason in `devices.failed`): the first checkpoint
// decided anything but `rejected{stale}`; a checkpoint no-ops, or asks the owner, before a bundle applied (a bundle is
// required there); a bundle revision adds no unit, or one whose origin is not `repair`; the stale apply is rejected.
// As in M1 and M2, a run parked on a blocking needs-user is stopped (`parked-stop`), and the hard timeout stops,
// then SIGKILLs. The driver refuses a fixture dir that already holds a report or a run dir: a fixture is set up and
// run once.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { terminalReceipt } from '../../src/commands/queue.ts';
import { isAlive, statOf } from '../../src/contain/proc.ts';
import type { Event, Fact } from '../../src/core/events.ts';
import { readJson } from '../../src/core/fsx.ts';
import { arcId, commandId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { type ProcIdentity, executorExitReason } from '../../src/core/records.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { EXIT_REASON_FILE, type ExitReason } from '../../src/executor.ts';
import { HOST_DIR, hostPath } from '../../src/host/hostdir.ts';
import { type ProfileName, profileName } from '../../src/routing/types.ts';
import type { ArcState, Status } from '../../src/status.ts';
import { executorLogs, lastLine } from '../../src/supervisor.ts';
import { writeShims } from '../../test/fakes/shim.ts';
import { BARRIER_JOB, FAKE_CKPT_HOLD, FIRST, type Layout, UNITS, barrierFile, layout } from './layout.ts';
import { type StoryName, storyName, storySteps } from './scenario.ts';
import { DIRECTION_EDITED, json } from './setup.ts';

const BIN_ROADMAP = fileURLToPath(new URL('../../bin/roadmap', import.meta.url));
const EXEC_CLI = fileURLToPath(new URL('../../test/fixtures/exec-cli.ts', import.meta.url));

export const REPORT_SCHEMA = 'roadmap/m3-report';
const TIMEOUTS = {
  real: { runMs: 180 * 60_000, stopGraceMs: 5 * 60_000, pollMs: 5_000 },
  fake: { runMs: 15 * 60_000, stopGraceMs: 60_000, pollMs: 250 },
} as const;
const CLI_TIMEOUT_MS = 60_000;

export type EndedBy = 'exit' | 'parked-stop' | 'device-failed' | 'timeout' | 'start-failed';
export type Ready = Readonly<{ kind: 'ready'; generation: number; supervisor: number }>;

/** The forcing devices as the driver applied them, in order; null until each fired. */
export type Devices = {
  runOnly: string | null;
  barrier: { at: string; runOnly: string } | null;
  release: { at: string } | null;
  staleApply: { command: string; checkpoint: string; seq: number } | null;
  staleApplied: { at: string } | null;
  repair: { unit: string; job: string; rev: number; seq: number } | null;
  admitRepair: { runOnly: string; audit: string } | null;
  digest: { needsUser: string; ack: string } | null;
  bound: { needsUser: string; ack: string } | null;
  unlimited: string | null;
  failed: string | null;
};

export type Report = Readonly<{
  schema: typeof REPORT_SCHEMA;
  profile: ProfileName;
  /** The story's name for a fake run, null for a real one. */
  fake: StoryName | null;
  /** The host dir the run claimed. */
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

type Args = Readonly<{ dir: string; profile: ProfileName; fake: StoryName | null }>;

function parseArgs(argv: readonly string[]): Args {
  const usage = 'usage: node evals/m3/driver.ts <dir> --profile default|claude-only [--fake <story>]';
  const [dir, ...rest] = argv;
  if (dir === undefined || dir.startsWith('--')) throw new Error(usage);
  let profile: ProfileName | null = null;
  let fake: StoryName | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (value === undefined) throw new Error(usage);
    if (rest[i] === '--profile' && profile === null) profile = profileName(value, 'profile');
    else if (rest[i] === '--fake' && fake === null) fake = storyName(value);
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
  if (!existsSync(l.plan)) throw new Error(`${args.dir} holds no fixture: run evals/m3/setup.ts first`);
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

type Seq<F> = F & { seq: number };
const factsOf = <K extends Fact['kind']>(events: readonly Event[], kind: K): readonly Seq<Extract<Fact, { kind: K }>>[] =>
  events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [{ ...(e.fact as Extract<Fact, { kind: K }>), seq: e.seq }] : []));

const merged = (s: Status, unit: string): boolean => s.units.find((u) => u.unit === unit)?.status === 'retired';
const openItem = (s: Status, reason: string) => s.needsUser.find((n) => n.reason === reason);
const now = (): string => new Date().toISOString();

/** Rewrites the plan's `direction`, as the architect would, keeping every other byte of its JSON. */
function editDirection(l: Layout): void {
  const plan = JSON.parse(readFileSync(l.plan, 'utf8')) as Record<string, unknown>;
  writeFileSync(l.plan, json({ ...plan, direction: DIRECTION_EDITED }));
}

type Poll = Readonly<{ l: Layout; c: Cli; run: readonly string[]; fake: boolean; d: Devices; s: Status; events: readonly Event[] }>;

/** Why the checkpoints so far break the story, or null. */
function checkpointFailure(p: Poll): string | null {
  const decided = factsOf(p.events, 'bundle-decided');
  const [first] = factsOf(p.events, 'checkpoint-inputs');
  if (first === undefined) return null;
  const bundleApplied = factsOf(p.events, 'plan-applied').some((f) => f.source?.type === 'bundle');
  const firstDecision = decided.find((x) => x.job === first.job);
  if (bundleApplied && firstDecision === undefined) return `the first checkpoint ${first.job}'s bundle applied: the stale apply did not make it stale`;
  if (firstDecision !== undefined && !(firstDecision.outcome.kind === 'rejected' && firstDecision.outcome.reason === 'stale')) {
    return `the first checkpoint ${first.job} decided ${JSON.stringify(firstDecision.outcome)}, not rejected{stale}`;
  }
  if (!bundleApplied) {
    const noBundle = decided.find((x) => x.outcome.kind === 'no-op' || x.outcome.kind === 'requested');
    if (noBundle !== undefined) return `checkpoint ${noBundle.job} decided ${noBundle.outcome.kind} before any bundle applied: a checkpoint no-oped where a bundle is required`;
  }
  return null;
}

/**
 * One poll's worth of devices: fires every device whose condition holds now, in order. Returns a failure reason
 * when a device's own check fails (the caller stops the run), else null.
 */
function fire(p: Poll): string | null {
  const { l, c, run, d, s, events } = p;
  const failure = checkpointFailure(p);
  if (failure !== null) return failure;
  if (d.barrier === null) {
    if (!existsSync(barrierFile(l, BARRIER_JOB, 'reached'))) return null;
    d.barrier = { at: now(), runOnly: submitted(cli(c, ['run-only', ...UNITS, ...run])) };
  }
  if (d.release === null) {
    if (!merged(s, 'report')) return null;
    writeFileSync(barrierFile(l, BARRIER_JOB, 'release'), '', { flag: 'wx' });
    d.release = { at: now() };
  }
  if (d.staleApply === null) {
    const [first] = factsOf(events, 'checkpoint-inputs');
    if (first === undefined) return null;
    editDirection(l);
    d.staleApply = { command: submitted(cli(c, ['apply', ...run])), checkpoint: first.job, seq: first.seq };
  }
  if (d.staleApplied === null) {
    const receipt = terminalReceipt(absPath(l.runDir), commandId(d.staleApply.command));
    if (receipt === null) return null;
    if (receipt.state !== 'applied') return `the stale apply ${d.staleApply.command} was ${receipt.state}: ${JSON.stringify(receipt)}`;
    if (p.fake) writeFileSync(join(l.fake, `${FAKE_CKPT_HOLD}.release`), '', { flag: 'wx' });
    d.staleApplied = { at: now() };
  }
  for (const item of [['digest', 'divergence-digest'], ['bound', 'convergence-bound']] as const) {
    const open = openItem(s, item[1]);
    if (d[item[0]] === null && open !== undefined) d[item[0]] = { needsUser: open.id, ack: submitted(cli(c, ['ack', open.id, ...run])) };
  }
  if (d.repair === null) {
    const bundle = factsOf(events, 'plan-applied').find((f) => f.source?.type === 'bundle');
    if (bundle === undefined || bundle.source?.type !== 'bundle') return null;
    const added = bundle.changes.flatMap((x) => (x.type === 'unit-added' ? [x.unit] : []));
    const [unit] = added;
    if (unit === undefined || added.length !== 1) return `the bundle revision ${bundle.rev} (${bundle.source.job}) adds ${JSON.stringify(added)}, not one repair unit`;
    const origin = s.units.find((u) => u.unit === unit)?.priority?.origin;
    if (origin !== undefined && origin !== 'repair') return `the bundle revision ${bundle.rev} adds ${unit} of origin ${origin}, not repair`;
    d.repair = { unit, job: bundle.source.job, rev: bundle.rev, seq: bundle.seq };
  }
  if (d.admitRepair === null) {
    const audit = factsOf(events, 'audit-started').find((f) => f.seq > d.repair!.seq);
    if (audit === undefined) return null;
    d.admitRepair = { runOnly: submitted(cli(c, ['run-only', ...UNITS, d.repair.unit, ...run])), audit: audit.job };
  }
  if (d.unlimited === null && merged(s, d.repair.unit)) d.unlimited = submitted(cli(c, ['run-only', '--clear', ...run]));
  return null;
}

export async function drive(args: Args): Promise<Report> {
  const l = layout(args.dir);
  const c = prepare(args);
  const limits = args.fake === null ? TIMEOUTS.real : TIMEOUTS.fake;
  const run = ['--repo', l.repo, '--arc', l.arc];
  const status = (): Status => JSON.parse(cli(c, ['status', ...run])) as Status;
  const devices: Devices = {
    runOnly: null, barrier: null, release: null, staleApply: null, staleApplied: null, repair: null, admitRepair: null, digest: null, bound: null, unlimited: null, failed: null,
  };
  const startedAt = new Date();
  const deadline = startedAt.getTime() + limits.runMs;

  // `report` is kept out from the first dispatch: the run dir is created for the queue, which the arc's first
  // scheduler iteration reads.
  mkdirSync(l.runDir, { recursive: true });
  devices.runOnly = submitted(cli(c, ['run-only', ...FIRST, ...run]));

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
      const { events } = readJournal(absPath(l.runDir), arcId(l.arc));
      const failed = fire({ l, c, run, fake: args.fake !== null, d: devices, s: st, events });
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
    fake: args.fake,
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
