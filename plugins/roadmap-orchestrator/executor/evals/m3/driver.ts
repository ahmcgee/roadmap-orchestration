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
// or a barrier file, never on timing, and each independent of the others' order. Each fires once (the acks once per
// item) and is recorded in the report (`devices`), which check.ts reads:
//
//   runOnly      before `start`, the driver creates the run dir and queues `run-only parse tidy`: `report` never
//                starts before audit A1 waits at its barrier
//   barrier      once audit-1's run of the money lane (I-2) waits at the barrier (`barriers/audit-1.money.reached`,
//                barrier.ts), and audit-1 is the cadence audit of tidy's publication S: `run-only parse report tidy`,
//                so `report` merges at S′ while A1 audits S
//   release      once `report` is merged: release the barrier. A1 then opens its P1 over I-2 and re-witnesses it on S′
//   staleApply   once the first `checkpoint-inputs` is in the log, whatever its trigger (an audit, or a design park):
//                the architect's edit of the plan's `direction` (setup.ts DIRECTION_EDITED) by `roadmap apply`, so
//                that checkpoint's bundle is stale whole
//   staleApplied once that apply's receipt is `applied`; under --fake it then releases the fake checkpoint call held at
//                `fake/ckpt-1.hold` (a real call takes longer than the apply; if not, the run fails, naming it)
//   acks         every `divergence-digest` and `convergence-bound` item, acknowledged once each as it opens
//   repair       G18: the unit the bundle revision admits (read from its `plan-applied{source: bundle}` change)
//   admitRepair  once an audit started after that revision (A2, the drift audit): `run-only` the plan units and the
//                repair, so the repair merges after A2's capture
//   unlimited    once the repair is merged: `run-only --clear`
//
// The run is stopped as `device-failed` (the reason in `devices.failed`, naming the observed job, trigger and
// outcome) as soon as the log leaves the story: the first checkpoint decides anything but `rejected{stale}` or applies
// its bundle; a bundle revision is anything but the one admit of an origin-`repair` unit; a checkpoint no-ops or asks
// the owner before the repair is admitted; audit-1 is not the cadence audit of tidy's publication, or ends without a
// witness P1 over I-2; the stale apply is rejected. Finding ids are never assumed: the P1 is found by its content.
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
import type { BundleOutcome, CheckpointTrigger } from '../../src/holistic/types.ts';
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
  barrier: { at: string; audit: string; runOnly: string } | null;
  release: { at: string } | null;
  staleApply: { command: string; checkpoint: string; trigger: string; seq: number } | null;
  staleApplied: { at: string } | null;
  acks: { needsUser: string; reason: string; ack: string }[];
  repair: { unit: string; job: string; rev: number; seq: number } | null;
  admitRepair: { runOnly: string; audit: string } | null;
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
const now = (): string => new Date().toISOString();
/** The items the driver acknowledges whenever they are open (story steps 5 and 6). */
const ACKED_REASONS: readonly string[] = ['divergence-digest', 'convergence-bound'];

/** A checkpoint trigger, as the device messages name it. */
const triggerText = (t: CheckpointTrigger): string => (t.type === 'audit' ? `audit ${t.job}` : `park of ${t.unit} at seq ${t.seq}`);
const outcomeText = (o: BundleOutcome): string => (o.kind === 'rejected' ? `rejected{${o.reason}}: ${o.detail}` : o.kind === 'requested' ? `requested (${o.needsUser})` : o.kind);

/** Rewrites the plan's `direction`, as the architect would, keeping every other byte of its JSON. */
function editDirection(l: Layout): void {
  const plan = JSON.parse(readFileSync(l.plan, 'utf8')) as Record<string, unknown>;
  writeFileSync(l.plan, json({ ...plan, direction: DIRECTION_EDITED }));
}

/** The origin a revision's kept plan gives `unit`. */
function originIn(l: Layout, planSha256: string, unit: string): string | undefined {
  const plan = JSON.parse(readFileSync(join(l.runDir, 'inputs', `${planSha256}.plan.json`), 'utf8')) as { units: { id: string; origin?: string }[] };
  const u = plan.units.find((x) => x.id === unit);
  return u === undefined ? undefined : u.origin ?? 'planned';
}

/** The integration head tidy's publication made, or null before it published. */
function tidyHead(events: readonly Event[]): string | null {
  const ff = events.find((e) => e.type === 'intent' && e.kind === 'integration.ff' && e.parent.type === 'stage' && e.parent.unit === 'tidy');
  if (ff === undefined || ff.type !== 'intent' || ff.kind !== 'integration.ff') return null;
  const done = events.some((e) => e.type === 'done' && e.op === ff.op && e.kind === 'integration.ff' && e.outcome.kind === 'published');
  return done ? ff.expect.new : null;
}

type Poll = Readonly<{ l: Layout; c: Cli; run: readonly string[]; fake: boolean; d: Devices; s: Status; events: readonly Event[] }>;

/**
 * Why the log has left the story, naming the facts it observed (job, trigger, outcome), or null. Checked at every
 * poll, before any device fires.
 */
function divergence(p: Poll): string | null {
  const { l, d, events } = p;
  const inputs = factsOf(events, 'checkpoint-inputs');
  const decided = factsOf(events, 'bundle-decided');
  const bundles = factsOf(events, 'plan-applied').filter((f) => f.source?.type === 'bundle');
  const triggerOf = (job: string): string => {
    const i = inputs.find((x) => x.job === job);
    return i === undefined ? 'unknown trigger' : triggerText(i.trigger);
  };
  const [first] = inputs;
  if (first !== undefined) {
    const firstDecision = decided.find((x) => x.job === first.job);
    if (bundles.some((b) => b.source?.type === 'bundle' && b.source.job === first.job)) {
      return `the first checkpoint ${first.job} (${triggerText(first.trigger)}) applied its bundle: the stale apply ${d.staleApply?.command ?? '(not yet submitted)'} did not commit before its staleness check`;
    }
    if (firstDecision !== undefined && !(firstDecision.outcome.kind === 'rejected' && firstDecision.outcome.reason === 'stale')) {
      return `the first checkpoint ${first.job} (${triggerText(first.trigger)}) decided ${outcomeText(firstDecision.outcome)}, not rejected{stale}`;
    }
  }
  for (const b of bundles) {
    if (b.source?.type !== 'bundle') continue;
    const added = b.changes.flatMap((x) => (x.type === 'unit-added' ? [x.unit] : []));
    const [unit] = added;
    const origin = unit === undefined ? undefined : originIn(l, b.planSha256, unit);
    if (added.length !== 1 || b.changes.length !== 1 || origin !== 'repair') {
      return `the bundle revision ${b.rev} of ${b.source.job} (${triggerOf(b.source.job)}) made ${JSON.stringify(b.changes)}${unit === undefined ? '' : ` (${unit}: origin ${origin})`}, not the one admit of a repair unit`;
    }
  }
  if (bundles.length === 0) {
    const settled = decided.find((x) => x.outcome.kind === 'no-op' || x.outcome.kind === 'requested');
    if (settled !== undefined) return `checkpoint ${settled.job} (${triggerOf(settled.job)}) decided ${outcomeText(settled.outcome)} while no repair is admitted: a bundle admitting the repair is required there`;
  }
  const audit1 = factsOf(events, 'audit-started').find((a) => a.job === BARRIER_JOB);
  if (d.barrier !== null && audit1 !== undefined) {
    const ended = factsOf(events, 'audit-ended').find((x) => x.job === BARRIER_JOB);
    const p1 = factsOf(events, 'finding-opened').find((f) => f.lens === 'witness' && f.severity === 'P1' && f.obligation === 'I-2');
    if (ended !== undefined && p1 === undefined) return `${BARRIER_JOB} ended ${ended.outcome} with findings ${JSON.stringify(ended.findings)}: no witness P1 over I-2`;
  }
  return null;
}

/**
 * One poll's worth of devices: fires every device whose condition holds now. Returns a failure reason when the run has
 * left the story or a device's own check fails (the caller stops the run), else null.
 */
function fire(p: Poll): string | null {
  const { l, c, run, d, s, events } = p;
  const failure = divergence(p);
  if (failure !== null) return failure;

  if (d.barrier === null && existsSync(barrierFile(l, BARRIER_JOB, 'reached'))) {
    const audit = factsOf(events, 'audit-started').find((a) => a.job === BARRIER_JOB);
    const s1 = tidyHead(events);
    if (audit === undefined) return `the money lane waits at ${BARRIER_JOB}'s barrier, but the log has no audit-started of ${BARRIER_JOB}`;
    if (!audit.triggers.some((t) => t.type === 'cadence') || audit.integrationSha !== s1) {
      return `${BARRIER_JOB} waits at the money barrier, but it was started by ${JSON.stringify(audit.triggers)} on ${audit.integrationSha}, not the cadence audit of tidy's publication (${s1 ?? 'tidy has not published'})`;
    }
    d.barrier = { at: now(), audit: audit.job, runOnly: submitted(cli(c, ['run-only', ...UNITS, ...run])) };
  }
  if (d.barrier !== null && d.release === null && merged(s, 'report')) {
    writeFileSync(barrierFile(l, BARRIER_JOB, 'release'), '', { flag: 'wx' });
    d.release = { at: now() };
  }

  const [first] = factsOf(events, 'checkpoint-inputs');
  if (d.staleApply === null && first !== undefined) {
    editDirection(l);
    d.staleApply = { command: submitted(cli(c, ['apply', ...run])), checkpoint: first.job, trigger: triggerText(first.trigger), seq: first.seq };
  }
  if (d.staleApply !== null && d.staleApplied === null) {
    const receipt = terminalReceipt(absPath(l.runDir), commandId(d.staleApply.command));
    if (receipt !== null) {
      if (receipt.state !== 'applied') return `the stale apply ${d.staleApply.command} was ${receipt.state}: ${JSON.stringify(receipt)}`;
      if (p.fake) writeFileSync(join(l.fake, `${FAKE_CKPT_HOLD}.release`), '', { flag: 'wx' });
      d.staleApplied = { at: now() };
    }
  }

  for (const item of s.needsUser) {
    if (!ACKED_REASONS.includes(item.reason) || d.acks.some((a) => a.needsUser === item.id)) continue;
    d.acks.push({ needsUser: item.id, reason: item.reason, ack: submitted(cli(c, ['ack', item.id, ...run])) });
  }

  if (d.repair === null) {
    const bundle = factsOf(events, 'plan-applied').find((f) => f.source?.type === 'bundle');
    const unit = bundle?.changes.find((x) => x.type === 'unit-added');
    if (bundle === undefined || bundle.source?.type !== 'bundle' || unit === undefined || unit.type !== 'unit-added') return null;
    d.repair = { unit: unit.unit, job: bundle.source.job, rev: bundle.rev, seq: bundle.seq };
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
    runOnly: null, barrier: null, release: null, staleApply: null, staleApplied: null, acks: [], repair: null, admitRepair: null, unlimited: null, failed: null,
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
