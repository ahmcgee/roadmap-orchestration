// The M3 paid fixture, step 2: `node evals/m3/driver.ts <dir> --profile default|claude-only [--fake <story>]` runs
// `roadmap start` against a fixture laid out by setup.ts, applies the forcing devices as the run reaches them, waits
// for it to end, and writes `<dir>/report.json` for check.ts.
//
// Real run (no --fake): `bin/roadmap`, the host's real CLIs and the host dir /var/tmp/roadmap; hard timeout 240 min.
// Either run has the fixture's fake `gh` (setup.ts, `forge/bin`) first on PATH: the corpus arc's Phase-0 rows and
// checkpoints read the forge, and the fixture has no real one.
// Paid: once per merged batch, `--profile default` (evals/README.md). Fake run (--fake <story>, evals/m3/scenario.ts):
// the fake backends behind PATH shims play the story, the CLI runs through test/fixtures/exec-cli.ts with a host dir
// inside the fixture; hard timeout 15 min. `claude-only` takes `codex` off PATH as in evals/m1/driver.ts.
//
// The story is branch-tolerant (DESIGN-1.0.md §10 M3, after three paid runs whose judges refused the regression):
// branch R (regressed: tidy merges, the audit finds I-2's P1, a repair is admitted and merges), branch P (prevented:
// tidy is redirected, parked or cut upstream and a checkpoint disposes of it) or branch L (latent: tidy merges with I-2's
// witness held, the lenses find the defect it cannot see, a repair is admitted and merges). The driver records the
// branch the log shows (`devices.branch`) and every branch runs to the end. The forcing devices, each a durable gate on the log, `roadmap
// status` or a barrier file, never on timing, and each independent of the others' order; each is recorded in the
// report (`devices`), which check.ts reads:
//
//   acks         first at every poll, whatever the branch: every `divergence-digest` and `convergence-bound` item,
//                acknowledged once each as it opens; every `bundle-request` (a convergence brake, a draining arc, a
//                re-evaluation) answered as an architect who trusts the checkpoint would: `ack <id> --choice apply`
//                when the item offers `apply` (the next job of its trigger enacts the bundle), a plain `ack` when it
//                offers nothing
//   runOnly      before `start`, the driver creates the run dir and queues `run-only parse tidy`: `report` never
//                starts before the regression's audit (R) or the bundle's drift audit (P)
//   branch       R once tidy published S and the first audit of S waits at the money barrier, or I-2's witness ran on S
//                not held; L once it ran on S held (tidy published, the regression latent: the lenses find what the
//                witness cannot see, a checkpoint repair follows, paid run 9); P once a bundle revision cuts,
//                respecifies or re-enters tidy before it published
//   barrier      R only: once the first audit to see the regression waits at the money barrier (barrier.ts writes
//                `barriers/money.reached` with its job id) and it is the cadence audit of tidy's publication S:
//                `run-only parse report tidy`, so `report` merges at S′ while A1 audits S
//   release      once `report` is merged: release the barrier. A1 then opens its P1 over I-2 and re-witnesses it on S′
//   staleApply   once the first `checkpoint-inputs` is in the log, whatever its trigger (an audit, or a design park):
//                the architect's edit of the plan's `direction` (setup.ts DIRECTION_EDITED) by `roadmap apply`, so
//                that checkpoint's bundle is stale whole
//   staleApplied once that apply's receipt is `applied`; under --fake it then releases the fake checkpoint call held at
//                `fake/ckpt-1.hold` (a real call takes longer than the apply; if not, the run fails, naming it)
//   added        G18: every unit a bundle revision adds (read from its `plan-applied{source: bundle}` change)
//   admit        once an audit started after the first bundle revision (the drift audit): `run-only` every plan unit
//                not cut or superseded and every added unit (re-issued as more are added), so they merge after the
//                drift audit's capture
//   unlimited    once every added unit is merged: `run-only --clear`
//
// The run is stopped as `device-failed` (the reason in `devices.failed`, naming the observed job, trigger, outcome or
// item) only when it is off the story in any branch: the first checkpoint decides anything but `rejected{stale}`
// or applies its bundle; a checkpoint disposes of nothing before any bundle applied (a no-op, or a request with
// nothing to apply); an `owner-request` opens (an owner-only act, A16, which the driver never answers); in branch R,
// the barrier's audit is not the cadence audit of S, or ends without a witness P1 over I-2; the stale apply is
// rejected. A stall ends at the hard timeout. Finding ids are never assumed: the P1 is found by its content.
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
import { type NeedsUserId, arcId, commandId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { type ProcIdentity, executorExitReason } from '../../src/core/records.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { EXIT_REASON_FILE, type ExitReason } from '../../src/executor.ts';
import { HOST_DIR, hostPath } from '../../src/host/hostdir.ts';
import { type ProfileName, profileName } from '../../src/routing/types.ts';
import type { ArcState, Status } from '../../src/status.ts';
import { executorLogs, lastLine } from '../../src/supervisor.ts';
import type { BundleOutcome, CheckpointTrigger } from '../../src/holistic/types.ts';
import { readNeedsUser } from '../../src/needsuser.ts';
import { revParse } from '../../src/git/git.ts';
import { witnessDir } from '../../src/git/snapshot.ts';
import { verdictOf } from '../../src/holistic/observe.ts';
import { type ObservationVerdict, parseObligations, witnessRecord } from '../../src/holistic/types.ts';
import { WITNESS_RECORD_FILE } from '../../src/holistic/witness.ts';
import { writeShims } from '../../test/fakes/shim.ts';
import { FAKE_CKPT_HOLD, FIRST, type Layout, MONEY_LANE, type StoryBranch, UNITS, barrierFile, layout } from './layout.ts';
import { type StoryName, storyName, storySteps } from './scenario.ts';
import { DIRECTION_EDITED, json } from './setup.ts';

const BIN_ROADMAP = fileURLToPath(new URL('../../bin/roadmap', import.meta.url));
const EXEC_CLI = fileURLToPath(new URL('../../test/fixtures/exec-cli.ts', import.meta.url));

export const REPORT_SCHEMA = 'roadmap/m3-report';
const TIMEOUTS = {
  real: { runMs: 240 * 60_000, stopGraceMs: 5 * 60_000, pollMs: 5_000 },
  fake: { runMs: 15 * 60_000, stopGraceMs: 60_000, pollMs: 250 },
} as const;
const CLI_TIMEOUT_MS = 60_000;

export type EndedBy = 'exit' | 'parked-stop' | 'device-failed' | 'timeout' | 'start-failed';
export type Ready = Readonly<{ kind: 'ready'; generation: number; supervisor: number }>;

/** The forcing devices as the driver applied them, in order; null until each fired. */
export type Devices = {
  runOnly: string | null;
  branch: { branch: StoryBranch; why: string; at: string } | null;
  barrier: { at: string; audit: string; runOnly: string } | null;
  release: { at: string } | null;
  staleApply: { command: string; checkpoint: string; trigger: string; seq: number } | null;
  staleApplied: { at: string } | null;
  acks: { needsUser: string; reason: string; choice: string | null; ack: string }[];
  added: { unit: string; job: string; rev: number; seq: number }[];
  admit: { runOnly: string; audit: string; units: readonly string[] } | null;
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
  // The fixture's fake forge (setup.ts) goes first on PATH in a real run too: the fixture has no real forge.
  let path = [l.forgeBin, ...(process.env['PATH'] ?? '').split(':').filter((d) => d !== '')];
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
/** The items the driver acknowledges whenever they are open (story steps 5 and 6, and the bundle requests). */
const ACKED_REASONS: readonly string[] = ['divergence-digest', 'convergence-bound', 'bundle-request'];
/** The unit whose change regresses I-2 in branch R, and which branch P stops upstream. */
const TIDY = 'tidy';
/** The changes by which a bundle revision disposes of tidy (branch P). */
const DISPOSALS: readonly string[] = ['unit-cut', 'unit-changed', 'spec', 'unit-reentered', 'unit-removed'];

/** A checkpoint trigger, as the device messages name it. */
const triggerText = (t: CheckpointTrigger): string => (t.type === 'audit' ? `audit ${t.job}` : `park of ${t.unit} at seq ${t.seq}`);
const outcomeText = (o: BundleOutcome): string => (o.kind === 'rejected' ? `rejected{${o.reason}}: ${o.detail}` : o.kind === 'requested' ? `requested (${o.needsUser})` : o.kind);

/** Rewrites the plan's `direction`, as the architect would, keeping every other byte of its JSON. */
function editDirection(l: Layout): void {
  const plan = JSON.parse(readFileSync(l.plan, 'utf8')) as Record<string, unknown>;
  writeFileSync(l.plan, json({ ...plan, direction: DIRECTION_EDITED }));
}

/** The integration head tidy's publication made, or null before it published. */
function tidyHead(events: readonly Event[]): string | null {
  const ff = events.find((e) => e.type === 'intent' && e.kind === 'integration.ff' && e.parent.type === 'stage' && e.parent.unit === TIDY);
  if (ff === undefined || ff.type !== 'intent' || ff.kind !== 'integration.ff') return null;
  const done = events.some((e) => e.type === 'done' && e.op === ff.op && e.kind === 'integration.ff' && e.outcome.kind === 'published');
  return done ? ff.expect.new : null;
}

type Poll = Readonly<{ l: Layout; c: Cli; run: readonly string[]; fake: boolean; d: Devices; s: Status; events: readonly Event[] }>;

/**
 * Why the run is off the story in any branch, naming the facts it observed (job, trigger, outcome, item), or null:
 * the first checkpoint not rejected stale (or applying its bundle); a checkpoint that disposes of nothing before any
 * bundle applied (a no-op, or a request with nothing to apply); an open `owner-request`; in branch R, the audit held at
 * the barrier ending without a witness P1 over I-2.
 */
function offStory(p: Poll): string | null {
  const { l, d, s, events } = p;
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
  if (bundles.length === 0) {
    const applicable = (o: BundleOutcome): boolean => o.kind === 'requested' && (readNeedsUser(absPath(l.runDir), o.needsUser as NeedsUserId)?.options.some((x) => x.id === 'apply') ?? false);
    const settled = decided.find((x) => x.outcome.kind === 'no-op' || (x.outcome.kind === 'requested' && !applicable(x.outcome)));
    if (settled !== undefined) return `checkpoint ${settled.job} (${triggerOf(settled.job)}) decided ${outcomeText(settled.outcome)} before any bundle applied: it disposes of nothing`;
  }
  const owner = s.needsUser.find((n) => n.reason === 'owner-request');
  if (owner !== undefined) return `owner-request ${owner.id} is open (an owner-only act the driver never answers): ${readNeedsUser(absPath(l.runDir), owner.id)?.summary ?? '(no record)'}`;
  if (d.barrier !== null) {
    const ended = factsOf(events, 'audit-ended').find((x) => x.job === d.barrier!.audit);
    const p1 = factsOf(events, 'finding-opened').find((f) => f.lens === 'witness' && f.severity === 'P1' && f.obligation === 'I-2');
    if (ended !== undefined && p1 === undefined) return `branch R: ${d.barrier.audit} ended ${ended.outcome} with findings ${JSON.stringify(ended.findings)}: no witness P1 over I-2`;
  }
  return null;
}

/** I-2's verdict in the witness record a `witnessed` fact names (its witness as the fixture's obligations file has it). */
function i2Verdict(l: Layout, f: Extract<Fact, { kind: 'witnessed' }>): ObservationVerdict {
  const witness = parseObligations(JSON.parse(readFileSync(l.obligations, 'utf8'))).obligations.find((o) => o.id === 'I-2')?.witness ?? null;
  if (witness === null) throw new Error('the fixture\'s I-2 has no witness');
  const path = join(witnessDir(absPath(l.runDir), f), WITNESS_RECORD_FILE);
  return verdictOf(witnessRecord(JSON.parse(readFileSync(path, 'utf8')), path), witness);
}

/**
 * The branch the log shows, once it shows one. Tidy published S: R once the first audit of S waits at the money barrier
 * (the regression is on S) or I-2's witness ran on S not held; L once it ran there held (paid run 9: the witness cannot
 * see what is left, the lenses can). P when a bundle disposed of tidy unpublished.
 */
function branchOf(l: Layout, events: readonly Event[]): Readonly<{ branch: StoryBranch; why: string }> | null {
  const head = tidyHead(events);
  if (head !== null) {
    if (existsSync(barrierFile(l, 'reached'))) return { branch: 'R', why: `tidy published ${head}; the first audit of it waits at the money barrier` };
    const tree = revParse(absPath(l.repo), `${head}^{tree}`);
    const onS = factsOf(events, 'witnessed').filter((f) => f.lane === MONEY_LANE && f.treeSha === tree && f.purpose === 'witness');
    const first = onS[0];
    if (first === undefined) return null;
    const v = i2Verdict(l, first);
    return v === 'held'
      ? { branch: 'L', why: `tidy published ${head}; I-2 is held there (seq ${first.seq})` }
      : { branch: 'R', why: `tidy published ${head}; I-2 is ${v} there (seq ${first.seq})` };
  }
  for (const b of factsOf(events, 'plan-applied')) {
    if (b.source?.type !== 'bundle') continue;
    const disposal = b.changes.find((x) => DISPOSALS.includes(x.type) && 'unit' in x && x.unit === TIDY);
    if (disposal !== undefined) return { branch: 'P', why: `${b.source.job}'s revision ${b.rev} made ${disposal.type} of tidy before it published` };
  }
  return null;
}

/**
 * One poll's worth of devices: the acks first (they never depend on the branch), then every device whose condition
 * holds now. Returns a failure reason when the run is off the story or a device's own check fails (the caller stops
 * the run), else null.
 */
function fire(p: Poll): string | null {
  const { l, c, run, d, s, events } = p;
  for (const item of s.needsUser) {
    if (!ACKED_REASONS.includes(item.reason) || d.acks.some((a) => a.needsUser === item.id)) continue;
    const offered = readNeedsUser(absPath(l.runDir), item.id)?.options.some((o) => o.id === 'apply') ?? false;
    const choice = item.reason === 'bundle-request' && offered ? 'apply' : null;
    d.acks.push({ needsUser: item.id, reason: item.reason, choice, ack: submitted(cli(c, ['ack', item.id, ...(choice === null ? [] : ['--choice', choice]), ...run])) });
  }
  const failure = offStory(p);
  if (failure !== null) return failure;
  if (d.branch === null) {
    const b = branchOf(l, events);
    if (b !== null) d.branch = { ...b, at: now() };
  }

  // Branch R: the first audit to see the regression waits at the money barrier; report merges meanwhile (S′).
  const reached = barrierFile(l, 'reached');
  if (d.barrier === null && existsSync(reached)) {
    const job = readFileSync(reached, 'utf8').trim();
    const audit = factsOf(events, 'audit-started').find((a) => a.job === job);
    const s1 = tidyHead(events);
    if (audit === undefined) return `the money lane waits at the barrier for ${job}, but the log has no audit-started of ${job}`;
    if (!audit.triggers.some((t) => t.type === 'cadence') || audit.integrationSha !== s1) {
      return `branch R: ${job} waits at the money barrier, but it was started by ${JSON.stringify(audit.triggers)} on ${audit.integrationSha}, not the cadence audit of tidy's publication (${s1 ?? 'tidy has not published'})`;
    }
    d.barrier = { at: now(), audit: job, runOnly: submitted(cli(c, ['run-only', ...UNITS, ...run])) };
  }
  if (d.barrier !== null && d.release === null && merged(s, 'report')) {
    writeFileSync(barrierFile(l, 'release'), '', { flag: 'wx' });
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

  // G18: every unit a bundle revision adds, read from its `plan-applied{source: bundle}` change.
  const bundles = factsOf(events, 'plan-applied').filter((f) => f.source?.type === 'bundle');
  for (const b of bundles) {
    for (const x of b.changes) {
      if (x.type !== 'unit-added' || b.source?.type !== 'bundle' || d.added.some((a) => a.unit === x.unit)) continue;
      d.added.push({ unit: x.unit, job: b.source.job, rev: b.rev, seq: b.seq });
    }
  }
  const [firstBundle] = bundles;
  if (firstBundle === undefined) return null;
  // Once an audit started after the first bundle revision (the drift audit), every unit still to run may: the plan's
  // units not cut or superseded, and every added one (re-issued as more are added).
  const audit = factsOf(events, 'audit-started').find((f) => f.seq > firstBundle.seq);
  if (audit === undefined) return null;
  const units = [...new Set([...s.units.filter((u) => u.status !== 'cut' && u.status !== 'superseded').map((u) => u.unit as string), ...d.added.map((a) => a.unit)])].sort();
  if (d.unlimited === null && (d.admit === null || units.some((u) => !d.admit!.units.includes(u)))) {
    d.admit = { runOnly: submitted(cli(c, ['run-only', ...units, ...run])), audit: audit.job, units };
  }
  if (d.admit !== null && d.unlimited === null && d.added.every((a) => merged(s, a.unit))) d.unlimited = submitted(cli(c, ['run-only', '--clear', ...run]));
  return null;
}

export async function drive(args: Args): Promise<Report> {
  const l = layout(args.dir);
  const c = prepare(args);
  const limits = args.fake === null ? TIMEOUTS.real : TIMEOUTS.fake;
  const run = ['--repo', l.repo, '--arc', l.arc];
  const status = (): Status => JSON.parse(cli(c, ['status', ...run])) as Status;
  const devices: Devices = {
    runOnly: null, branch: null, barrier: null, release: null, staleApply: null, staleApplied: null, acks: [], added: [], admit: null, unlimited: null, failed: null,
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
