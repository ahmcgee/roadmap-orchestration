// Lane execution (plan "Pipeline", lanes and candidate rows; DESIGN-1.0.md §4 Verification, Lanes): the
// executor runs a series of lanes serially, verbatim, under their reservations, in a clean detached
// checkout, fast lanes before estate lanes, and keeps one evidence dir per lane. The same series runs a
// unit's spec lanes at the salvage SHA (set `spec`, the lanes stage) and the plan's suite on the candidate
// merge and on the integration tip alone (set `suite`, the candidate stage).
//
// Per lane: acquire its reservation (its declared resources and, outside a legacy arc, its `@cpu` tokens,
// `laneCpu`) through the stage's `acquire` (`LaneRuntime`) → occupancy probe → run (step 10's cycle) → `invoke`
// purpose `lane` with the exact argv, cwd and env (plus the unit's owner label and the holder's pool instance
// binding, `instanceEnv`, F7) → evidence snapshots → cleanup. The host is sampled at the lane's start and end
// into `<lane>/host.json`. The series stops at the first lane that does not pass: one failure is what a fix
// round needs, and nothing after it is spent. A wait for a lane's reservation that the stage's signal
// cancels (pause, stop) ends the series `interrupted`.
//
// A lane that runs red goes through the red-lane protocol (redlane.ts): a host signature on a busy host
// waits, holding nothing, for a clear host and reruns; a signature without that evidence is `blocked`; any
// other red gets one diagnostic rerun (red then green is red, `flaky`). A rerun takes its own reservation,
// runs in the same checkout at the same SHA and keeps its evidence in `<lane>.rerun/`. The ledger holds one
// record per lane (`LaneRecord`): the run whose verdict counts, with the other run attached.
//
// A lane runs under the runner's stall watchdog (LANE_STALL_MS without progress: no CPU time, no output, no
// process started or ended) and a distant deadline (LANE_DEADLINE_MS), the backstop for a busy loop. A long
// suite that is working is never cut short. A stalled lane is red, a verdict on the tree: it hung, and the fix
// round reads its output. A deadline kill or a lost runner is `blocked`, no verdict. The checkout is created just before the first lane runs, so a series that
// ends before any lane ran leaves no tree behind.
//
// After its snapshots, each lane's census of the gitignored files it wrote is recorded (`ignored.json`, write-
// once, before the stage outcome), and a lane that did not pass also gets its undeclared ignored output
// captured, within caps, into `ignored` (src/git/ignored.ts). The gate's ledger and a fix round show the census.
//
// After the series the checkout must still be clean: a lane that wrote a tracked or unignored file into
// it is never certified under a SHA (`dirty`). The dirty paths are snapshotted before anything removes the
// tree. The checkout is removed with `worktree.remove`, which cites a done evidence snapshot of this series.
//
// Everything a later stage needs from a series (its ledger, its checkout, its dirty paths) is read back
// from the journal and the invocation files (`seriesLedger`, `seriesTree`, `seriesDirty`), never kept in
// memory, so a restarted executor sees the series exactly as it ran.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IntentOf } from '../core/events.ts';
import { type InvocationId, type LaneId, type OpId, type ResourceInstance, type ResourceUnit, type Sha, type UnitId, invocationId, opKey } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { exclusivePublish, canonicalJson as fileJson, readJson } from '../core/fsx.ts';
import {
  type CommandVerdict, type IgnoredCensus, type LaneDef, type SpecM1, STDERR_FILE, STDOUT_FILE, type NeedsUserContent, ignoredCensus,
} from '../core/records.ts';
import { DEV1_LANE_DEADLINE_MS, isLegacy } from '../core/upgrade.ts';
import { type AbsPath, type IsoTime, type RepoPath, type RepoPattern, absPath, isoTimeOf, repoPattern } from '../core/values.ts';
import { type EvidenceManifest, FILES_DIR, capturedEvidence, manifestPath, pathPattern, patternPath, readManifest } from '../git/evidence.ts';
import { ignoredWrites, planIgnored } from '../git/ignored.ts';
import { statusPorcelainV2Z } from '../git/git.ts';
import type { WorktreeCreateRequest } from '../git/worktree.ts';
import { type HostSample, readHostSample } from '../host/sample.ts';
import { type HostSignatureId, outputSignatures } from '../host/signatures.ts';
import type { LaneLedgerEntry } from '../prompts/inputs.ts';
import { instanceEnv, laneCpu, requestOf } from '../resources/pool.ts';
import { probe } from '../resources/probe.ts';
import {
  type Reservation, type ResourceContext, type SpecLane, type StageHolder, cleanup, heldReservation, reserve, run,
} from '../resources/reserve.ts';
import { OWNER_ENV, ownerLabel } from '../resources/teardown.ts';
import { runnerFiles } from '../runner/files.ts';
import type { Acquire, Rank, ResourceRequest } from '../schedule/types.ts';
import { type StageContext, type StageParent, evidenceRoot, runOp } from './dispatch.ts';
import { invocationDir, invoke } from './invoke.ts';
import { type LaneHost, type RedEvidence, abortReason, classifyRed, redLane } from './redlane.ts';
import { evidenceSnapshotOp, worktreeCreateOp, worktreeRemoveOp } from '../recover/ops.ts';

/** A lane with no progress this long has hung. Default, unmeasured: re-derive once arcs have measured stalls. */
export const LANE_STALL_MS = 10 * 60_000;
/** A lane's deadline: only the backstop for a busy loop, which the stall watchdog cannot see. */
export const LANE_DEADLINE_MS = 6 * 60 * 60_000;
const LANE_GRACE_MS = 5_000;

/**
 * One run of a lane: what the gate reads (`LaneLedgerEntry`, whose `evidenceDir` holds every snapshot of the
 * run, and its ignored-output census), plus its invocation, its times, and `fixDirs`: the snapshot `files`
 * dirs a fix round reads, the lane's stdout and stderr first, then its declared outputs, then its captured
 * ignored output when it has any. `host`: its host samples (null when none were recorded: a lane an older
 * executor ran, or a crash before the write). `signatures`: the host signatures in a red run's output (empty
 * for any other verdict).
 */
export type LaneRun = LaneLedgerEntry & Readonly<{
  inv: InvocationId; at: IsoTime; endedAt: IsoTime; fixDirs: readonly AbsPath[]; host: LaneHost | null; signatures: readonly HostSignatureId[];
}>;

/**
 * One lane of a series: the run whose verdict counts, and the other run of a red lane (redlane.ts). After a
 * host-signature rerun the record is the rerun and `voided` the first run; after a diagnostic rerun it is the
 * first run and `diagnostic` the rerun; `flaky`: red, then green on the diagnostic rerun.
 */
export type LaneRecord = LaneRun & Readonly<{ voided: LaneRun | null; diagnostic: LaneRun | null; flaky: boolean }>;

/** A series' checkout, and the done evidence snapshot its removal cites. */
export type VerificationTree = Readonly<{ path: AbsPath; at: Sha; evidence: OpId }>;

/** Which lanes a series runs: the unit's spec lanes, or the plan's executor-only suite. */
export type LaneSet = 'spec' | 'suite';

export type SeriesEnd =
  | Readonly<{ kind: 'green' }>
  /** A lane failed or stalled (a flaky lane included: `lane.flaky`). */
  | Readonly<{ kind: 'red'; lane: LaneRecord }>
  /** Ended by its runner's deadline or lost with it, or a host signature without a verdict (redlane.ts). */
  | Readonly<{ kind: 'blocked'; lane: LaneRecord | null; detail: string }>
  | Readonly<{ kind: 'interrupted'; reason: 'pause' | 'stop' }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[] }>;

export type Series = Readonly<{
  end: SeriesEnd;
  /** Every lane that ran, in order. */
  ledger: readonly LaneRecord[];
  /** null when no lane ran. */
  tree: VerificationTree | null;
  /** Paths the lanes left dirty in the checkout; non-empty means not certified. */
  dirty: readonly RepoPath[];
}>;

/**
 * What a series needs from its stage beyond the context: `acquire` for each lane's reservation (the arbiter's,
 * with the waiter's `rank`), the stage's cancel `signal` (aborted with reason `pause` or `stop`), which also
 * cancels a wait for a clear host, and `sampleHost`, the host sampler (`readHostSample`).
 */
export type LaneRuntime = Readonly<{ acquire: Acquire; rank: () => Rank; signal: AbortSignal; sampleHost: () => HostSample }>;

/**
 * An `acquire` that reserves at once and fails loud on a busy resource, for a context with one unit in flight
 * (the tests', and the serial arc's until the scheduler's arbiter replaces it), where a busy resource is a leak.
 * A cancelled signal is honoured.
 */
export function reserveNow(ctx: ResourceContext): Acquire {
  return (request, holder, _rank, signal) => {
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
    if (holder.type !== 'stage' && holder.type !== 'publication') throw new Error(`${canonicalJson(holder)} does not acquire`);
    const parent = { type: 'stage', unit: holder.unit, stage: holder.type === 'stage' ? holder.stage : 'candidate', attempt: holder.attempt } as const;
    const got = reserve(ctx, holder, request, parent);
    if (got.state === 'refused') throw new Error(`${canonicalJson(holder)}: resources ${got.busy.join(', ')} are held by another`);
    return Promise.resolve({ kind: 'granted', units: got.resources });
  };
}

/** The runtime a stage gives its series: the context's `acquire`, the unit's rank, the task signal, the real host sampler. */
export function laneRuntime(ctx: StageContext, unit: UnitId): LaneRuntime {
  return { acquire: ctx.acquire, rank: () => ctx.rank(unit), signal: ctx.signal, sampleHost: readHostSample };
}

/** Fast lanes first, then estate; declared order within a tier. */
export function seriesOrder<L extends LaneDef>(lanes: readonly L[]): readonly L[] {
  return [...lanes.filter((l) => l.tier === 'fast'), ...lanes.filter((l) => l.tier === 'estate')];
}

/** The spec's series: struck and deferred lanes do not run. */
export function laneOrder(spec: SpecM1): readonly SpecLane[] {
  return seriesOrder(spec.lanes.filter((l) => l.state === 'active'));
}

/**
 * The lane's declared env verbatim (`set`, and `pass` copied from the host), plus the unit's owner label and
 * `RESOURCE_INSTANCE_<POOL>` for each pool instance the lane's holder holds (`held`, F7).
 */
export function laneEnv(ctx: StageContext, unit: UnitId, lane: LaneDef, held: readonly ResourceUnit[]): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...lane.env.set };
  for (const name of lane.env.pass) {
    const value = ctx.hostEnv[name];
    // Startup refuses a lane whose declared variable the host lacks (spec-lane-unrunnable).
    if (value === undefined) throw new Error(`lane ${lane.id} passes ${name}, which the executor's environment lacks`);
    env[name] = value;
  }
  const executor: Record<string, string> = { [OWNER_ENV]: ownerLabel(ctx.plan().arc, unit), ...instanceEnv(held) };
  for (const [name, value] of Object.entries(executor)) {
    if (Object.hasOwn(env, name)) throw new Error(`lane ${lane.id} declares ${name}, which the executor sets`);
    env[name] = value;
  }
  return env;
}

/** What a lane reserves: its declared resources, and its `@cpu` tokens outside a legacy arc; null when nothing. */
export function laneRequest(ctx: ResourceContext, lane: LaneDef): ResourceRequest | null {
  const cpu = isLegacy(ctx.journal.view) ? 0 : laneCpu(lane);
  return lane.resources.length === 0 && cpu === 0 ? null : requestOf(ctx.plan(), lane.resources, cpu);
}

/** Wall time of a series, from the first lane's start to the last lane's end: the fix window's measure. */
export function seriesDurationMs(ledger: readonly LaneRecord[]): number {
  const first = ledger[0];
  const last = ledger[ledger.length - 1];
  if (first === undefined || last === undefined) return 0;
  return new Date(last.endedAt).getTime() - new Date(first.at).getTime();
}

/**
 * Where a series keeps its evidence: one dir per lane under `root`. A lanes attempt's series uses the
 * attempt's evidence root; a candidate attempt runs two suite series, each under its own subdir.
 */
export const specSeriesRoot = (runDir: AbsPath, parent: StageParent): AbsPath => evidenceRoot(runDir, parent);

const IGNORED_FILE = 'ignored.json';
const HOST_FILE = 'host.json';
/** A rerun's dir beside its lane's: `<lane>.rerun`. */
export const RERUN_SUFFIX = '.rerun';

/** A lane's first run, or its rerun (redlane.ts). */
type Which = 'first' | 'rerun';

const laneDir = (root: AbsPath, lane: LaneDef, which: Which): AbsPath => absPath(join(root, which === 'first' ? lane.id : `${lane.id}${RERUN_SUFFIX}`));

/** The snapshot dirs a fix round reads from a run's dir. */
function fixDirsOf(dir: AbsPath, lane: LaneDef): readonly AbsPath[] {
  const fixDirs = [absPath(join(dir, 'output', FILES_DIR))];
  if (lane.evidenceGlobs.length > 0) fixDirs.push(absPath(join(dir, 'tree', FILES_DIR)));
  // The ignored snapshot runs only with at least one file to capture, so its manifest means files.
  if (existsSync(manifestPath(ignoredDir(dir)))) fixDirs.push(absPath(join(ignoredDir(dir), FILES_DIR)));
  return fixDirs;
}

const ignoredDir = (dir: AbsPath): AbsPath => absPath(join(dir, 'ignored'));

/** The manifest of a lane's done `tree` snapshot. */
function treeManifest(dir: AbsPath): EvidenceManifest {
  const tree = absPath(join(dir, 'tree'));
  const manifest = readManifest(tree);
  if (manifest === null) throw new Error(`lane evidence ${tree}: the tree snapshot has no manifest`);
  return manifest;
}

/** The lane's census, or null when none was recorded (a lane an older executor ran, or a crash before the write). */
function readCensus(dir: AbsPath): IgnoredCensus | null {
  const path = join(dir, IGNORED_FILE);
  return existsSync(path) ? ignoredCensus(readJson(path), path) : null;
}

function hostSample(value: unknown, path: string): HostSample {
  if (typeof value !== 'object' || value === null) throw new Error(`${path}: not a host sample: ${JSON.stringify(value)}`);
  const v = value as Record<string, unknown>;
  const num = (key: string, positive: boolean): number => {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (positive && n === 0)) throw new Error(`${path}.${key}: ${JSON.stringify(n)} is not a ${positive ? 'positive' : 'non-negative'} number`);
    return n;
  };
  const keys = Object.keys(v).sort();
  if (canonicalJson(keys) !== canonicalJson(['cpus', 'load1', 'memAvailableKb', 'memTotalKb'])) throw new Error(`${path}: host sample keys ${keys.join(', ')}`);
  return { load1: num('load1', false), cpus: num('cpus', true), memTotalKb: num('memTotalKb', true), memAvailableKb: num('memAvailableKb', false) };
}

/** A run's host samples (`host.json`), or null when none were recorded (an older executor, or a crash before the write). */
function readLaneHost(dir: AbsPath): LaneHost | null {
  const path = join(dir, HOST_FILE);
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path}: not an object`);
  const { start, end, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new Error(`${path}: unknown keys ${Object.keys(rest).join(', ')}`);
  return { start: hostSample(start, `${path}.start`), end: hostSample(end, `${path}.end`) };
}

const isRed = (verdict: CommandVerdict): boolean => verdict === 'fail' || verdict === 'stall';

/**
 * A lane run's record, read from its spawn and invocation files: what ran (the definition), how it ended
 * (result.json, or none when lost with its runner), when (a lane's deadline is its start plus
 * LANE_DEADLINE_MS, or 1.0.0-dev.1's fixed deadline for a lane it launched, so launch.json carries the start;
 * exit.json the end), its evidence dir's census and host samples, and a red run's host signatures. The live
 * series and every later reader build records here, so they are the same record.
 */
function laneRun(ctx: StageContext, intent: IntentOf<'proc.spawn'>, lane: LaneDef, dir: AbsPath): LaneRun {
  if (intent.parent.type !== 'stage') throw new Error(`lane spawn ${intent.op} has no stage parent`);
  const inv = invocationId(intent.op, intent.ordinal);
  const invDir = invocationDir(ctx.runDir, inv);
  const files = runnerFiles(invDir, inv);
  const launch = files.read('launch.json');
  if (launch === null) throw new Error(`lane ${lane.id} ${inv}: no launch.json`);
  const result = files.read('result.json');
  if (result !== null && result.type !== 'command') throw new Error(`${inv}: a lane produced a ${result.type} result`);
  const at = isoTimeOf(new Date(new Date(launch.deadlineAt).getTime() - (launch.stallMs === null ? DEV1_LANE_DEADLINE_MS : LANE_DEADLINE_MS)));
  const verdict: CommandVerdict = result?.verdict ?? 'process-fault';
  return {
    lane: lane.id, argv: lane.argv, expectedExit: lane.expectedExit, exitCode: result?.exitCode ?? null, verdict, evidenceDir: dir,
    ignored: readCensus(dir), inv, at, endedAt: files.read('exit.json')?.endedAt ?? at, fixDirs: fixDirsOf(dir, lane),
    host: readLaneHost(dir), signatures: isRed(verdict) ? outputSignatures([join(invDir, STDOUT_FILE), join(invDir, STDERR_FILE)]) : [],
  };
}

const evidenceOf = (r: LaneRun): RedEvidence => ({ signatures: r.signatures, host: r.host });

/** A lane's record from its first run and its rerun, if any: the reading `redLane` made live (redlane.ts). */
function laneRecord(first: LaneRun, rerun: LaneRun | null): LaneRecord {
  if (rerun === null) return { ...first, voided: null, diagnostic: null, flaky: false };
  if (!isRed(first.verdict)) throw new Error(`lane ${first.lane} was rerun after a ${first.verdict} run (${first.inv})`);
  const cls = classifyRed(evidenceOf(first));
  switch (cls.kind) {
    case 'host-signature':
      return { ...rerun, voided: first, diagnostic: null, flaky: false };
    case 'diagnostic':
      return { ...first, voided: null, diagnostic: rerun, flaky: rerun.verdict === 'pass' };
    case 'signature-without-evidence':
      throw new Error(`lane ${first.lane} was rerun after a signature without host evidence (${first.inv})`);
  }
}

function spawnOf(view: JournalView, op: OpId): IntentOf<'proc.spawn'> {
  const intent = view.latestIntent(op);
  if (intent.kind !== 'proc.spawn') throw new Error(`${op} is a ${intent.kind} op, not proc.spawn`);
  return intent;
}

type Ran = Readonly<{ record: LaneRun; evidence: OpId; interrupted: 'pause' | 'stop' | null; blocked: string | null }>;

async function runLane(
  ctx: StageContext, parent: StageParent, lane: LaneDef, set: LaneSet, tree: AbsPath, at: Sha, dir: AbsPath, held: readonly ResourceUnit[],
  sampleHost: () => HostSample,
): Promise<Ran> {
  const start = sampleHost();
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    origin: { type: 'new', key: opKey(`lane:${parent.unit}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
    subject: { purpose: 'lane', unit: parent.unit, lane: lane.id, set, at },
    launch: () => ({
      argv: lane.argv, cwd: absPath(join(tree, lane.cwd)), env: laneEnv(ctx, parent.unit, lane, held), stdinPath: null, stallMs: LANE_STALL_MS, graceMs: LANE_GRACE_MS,
      terminal: { type: 'command', purpose: 'lane', expectedExit: lane.expectedExit },
    }),
  });
  const end = sampleHost();
  const invDir = invocationDir(ctx.runDir, outcome.inv);

  // One evidence dir per run: its stdout and stderr, and its declared evidence from the checkout.
  let evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
    source: invDir, globs: [repoPattern(STDOUT_FILE), repoPattern(STDERR_FILE)], dest: absPath(join(dir, 'output')),
  })).op;
  if (lane.evidenceGlobs.length > 0) {
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: tree, globs: lane.evidenceGlobs, dest: absPath(join(dir, 'tree')),
    })).op;
  }

  // The ignored-output census, from the lane's start and verdict as its files record them; a lane that did
  // not pass also gets its undeclared ignored output captured.
  const spawned = spawnOf(ctx.journal.view, outcome.op);
  const ended = laneRun(ctx, spawned, lane, dir);
  const declared = lane.evidenceGlobs.length === 0 ? [] : treeManifest(dir).files.map((f) => f.path);
  const writes = ignoredWrites(tree, new Date(ended.at).getTime());
  const plan = planIgnored(writes, { passed: ended.verdict === 'pass', declared: new Set(declared), excludes: lane.evidenceExcludes });
  if (plan.capture.length > 0) {
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: tree, globs: plan.capture, dest: ignoredDir(dir),
    })).op;
  }
  exclusivePublish(join(dir, IGNORED_FILE), fileJson(plan.census));
  exclusivePublish(join(dir, HOST_FILE), fileJson({ start, end } satisfies LaneHost));

  const record = laneRun(ctx, spawned, lane, dir);
  const exit = runnerFiles(invDir, outcome.inv).read('exit.json');
  const interrupted = outcome.kind === 'result' && outcome.result.type === 'command' && outcome.result.verdict === 'cancelled' ? outcome.result.reason : null;
  const blocked = outcome.kind === 'lost' ? `${outcome.inv} was lost with its runner` : record.verdict === 'process-fault' ? `${outcome.inv} ended by ${exit?.cause ?? 'unknown'}` : null;
  return { record, evidence, interrupted, blocked };
}

/** One run of a lane under its reservation: it ran (its cleanup passed), or the series ends without a verdict. */
type Attempt =
  | Readonly<{ kind: 'ran'; ran: Ran }>
  /** Before it ran (a cancelled wait, occupancy), or after it ran (its cleanup failed: `ran` is kept). */
  | Readonly<{ kind: 'ended'; end: SeriesEnd; ran: Ran | null }>;

/** How a single run ends the series without a verdict (cancelled, or blocked), or null when it has one. */
function runEnd(r: Ran): SeriesEnd | null {
  if (r.interrupted !== null) return { kind: 'interrupted', reason: r.interrupted };
  if (r.blocked !== null) return { kind: 'blocked', lane: laneRecord(r.record, null), detail: r.blocked };
  return null;
}

/**
 * A series' entry reservation (F6): its first lane's set, which the lanes stage takes before its first journaled
 * op and hands to `runLaneSeries` as `entered`. Null when the series has no lane or its first lane asks for nothing.
 */
export function seriesEntry(ctx: ResourceContext, lanes: readonly LaneDef[]): ResourceRequest | null {
  const first = lanes[0];
  return first === undefined ? null : laneRequest(ctx, first);
}

/**
 * Runs `lanes` (in series order) one at a time, each under its reservation, in the detached checkout
 * `checkout` names, created just before the first lane, keeping evidence under `root`. The caller records
 * the stage outcome; the checkout stays for the caller to keep or remove. `entered`: the stage already holds
 * the first lane's set (`seriesEntry`), reserved, so its first run takes no reservation of its own.
 */
export async function runLaneSeries(
  ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], set: LaneSet, checkout: WorktreeCreateRequest, root: AbsPath,
  rt: LaneRuntime, entered: boolean,
): Promise<Series> {
  if (checkout.checkout.type !== 'detached') throw new Error(`a lane series runs in a detached checkout, not on ${checkout.checkout.branch}`);
  const ids = new Set<string>(lanes.map((l) => l.id));
  for (const id of ids) if (ids.has(`${id}${RERUN_SUFFIX}`)) throw new Error(`lanes ${id} and ${id}${RERUN_SUFFIX} of ${parent.unit}: the second's dir is the first's rerun dir`);
  const { path } = checkout;
  const { at } = checkout.checkout;
  const holder: StageHolder = { type: 'stage', unit: parent.unit, stage: parent.stage, attempt: parent.attempt };
  const ledger: LaneRecord[] = [];
  // Written by each run (`attempt`): the series' last done evidence snapshot.
  const last: { evidence: OpId | null } = { evidence: null };
  let end: SeriesEnd = { kind: 'green' };
  if (entered && seriesEntry(ctx, lanes) === null) throw new Error(`series ${parent.unit} ${parent.stage}#${parent.attempt}: entered, but its first lane asks for nothing`);
  // The stage's entry reservation, for the first run of the first lane only.
  let entry = entered;

  const attempt = async (lane: LaneDef, which: Which): Promise<Attempt> => {
    const request = laneRequest(ctx, lane);
    let held: Reservation<'running', StageHolder> | null = null;
    if (request !== null) {
      if (!entry) {
        const grant = await rt.acquire(request, holder, rt.rank, rt.signal);
        if (grant.kind === 'cancelled') return { kind: 'ended', end: { kind: 'interrupted', reason: abortReason(rt.signal) }, ran: null };
      }
      entry = false;
      const reserved = heldReservation(ctx, holder, 'reserved');
      const occupancy = await probe(ctx, reserved, parent);
      if (occupancy.kind === 'parked') {
        const cleaned = await cleanup(ctx, reserved, parent);
        return { kind: 'ended', end: cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'occupied', needsUser: occupancy.needsUser }, ran: null };
      }
      held = run(ctx, reserved, parent);
    }
    if (last.evidence === null) await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, checkout);
    const ran = await runLane(ctx, parent, lane, set, path, at, laneDir(root, lane, which), held?.resources ?? [], rt.sampleHost);
    last.evidence = ran.evidence;
    if (held !== null) {
      const cleaned = await cleanup(ctx, held, parent);
      if (cleaned.kind === 'cleanup-failed') return { kind: 'ended', end: { kind: 'cleanup-failed', failed: cleaned.failed }, ran };
    }
    return { kind: 'ran', ran };
  };

  for (const lane of lanes) {
    const first = await attempt(lane, 'first');
    if (first.kind === 'ended') {
      if (first.ran !== null) ledger.push(laneRecord(first.ran.record, null));
      end = first.end;
      break;
    }
    const stopped = runEnd(first.ran);
    if (stopped !== null || !isRed(first.ran.record.verdict)) {
      ledger.push(laneRecord(first.ran.record, null));
      if (stopped === null) continue;
      end = stopped;
      break;
    }
    // Red: the red-lane protocol, with at most one rerun under its own reservation.
    const rerun: { ran: Ran | null } = { ran: null };
    const result = await redLane<Ran, SeriesEnd>(evidenceOf(first.ran.record), async () => {
      const again = await attempt(lane, 'rerun');
      rerun.ran = again.ran;
      if (again.kind === 'ended') return { kind: 'ended', end: again.end };
      const ended = runEnd(again.ran);
      if (ended !== null) return { kind: 'ended', end: ended };
      return { kind: 'ran', run: again.ran, verdict: { red: isRed(again.ran.record.verdict), evidence: evidenceOf(again.ran.record) } };
    }, { sample: rt.sampleHost, signal: rt.signal });
    const record = laneRecord(first.ran.record, rerun.ran?.record ?? null);
    ledger.push(record);
    if (result.kind === 'reran' && result.verdict.kind === 'pass') continue;
    switch (result.kind) {
      case 'reran':
        end = result.verdict.kind === 'blocked' ? { kind: 'blocked', lane: record, detail: result.verdict.detail } : { kind: 'red', lane: record };
        break;
      case 'blocked':
        end = { kind: 'blocked', lane: record, detail: result.detail };
        break;
      case 'interrupted':
        end = result;
        break;
      case 'ended':
        end = result.end.kind === 'blocked' ? { ...result.end, lane: record } : result.end;
        break;
    }
    break;
  }
  if (last.evidence === null) return { end, ledger, tree: null, dirty: [] };
  let evidence: OpId = last.evidence;
  const dirty = dirtyPaths(path);
  if (dirty.length > 0) {
    // Preserve what the lanes wrote before any removal discards it. `_dirty` cannot collide with a lane
    // id, which starts with a letter.
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: path, globs: dirty.map(pathPattern), dest: dirtyDir(root),
    })).op;
  }
  return { end, ledger, tree: { path, at, evidence }, dirty };
}

const dirtyDir = (root: AbsPath): AbsPath => absPath(join(root, '_dirty'));

/** Tracked or unignored changes in a checkout; ignored files never count. */
export function dirtyPaths(tree: AbsPath): readonly RepoPath[] {
  return statusPorcelainV2Z(tree, false).map((s) => s.path);
}

/**
 * `worktree.remove` of a verification checkout `created` made (any series, any attempt), from the stage
 * attempt `parent`. It cites the series' last done evidence snapshot; a series that captured none (a crash
 * cut its stage short once the checkout existed, so no lane finished) first gets one, under its own evidence
 * root, of what the checkout holds beyond its commit and of the lanes' declared evidence (`laneGlobs`): a
 * complete manifest, of zero files when nothing ran (lead ruling, 14c). Never an unrecorded removal.
 */
export async function removeCheckout(
  ctx: StageContext, created: IntentOf<'worktree.create'>, parent: StageParent, laneGlobs: readonly RepoPattern[],
): Promise<void> {
  if (created.expect.checkout.type !== 'detached' || created.parent.type !== 'stage') throw new Error(`${created.expect.path} is not a verification checkout`);
  const view = ctx.journal.view;
  const { path } = created.expect;
  const series = created.parent;
  let evidence = view.opsOf('evidence.snapshot').filter((i) => sameParent(i.parent, series) && view.doneOf(i.op) !== null).at(-1)?.op;
  if (evidence === undefined) {
    const globs = [...new Set<RepoPattern>([...dirtyPaths(path).map(pathPattern), ...laneGlobs])].sort();
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: path, globs, dest: absPath(join(evidenceRoot(ctx.runDir, series), '_leftover')),
    })).op;
  }
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, { path, evidence: capturedEvidence(ctx.journal.view, evidence) });
}

/** The unit's verification checkouts still present: created (done) by one of its stage attempts and not removed. */
export function presentCheckouts(view: JournalView, unit: UnitId): readonly IntentOf<'worktree.create'>[] {
  const removed = new Set(view.opsOf('worktree.remove').filter((i) => view.doneOf(i.op) !== null).map((i) => i.expect.path));
  return view.opsOf('worktree.create').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.expect.checkout.type === 'detached'
    && view.doneOf(i.op) !== null && !removed.has(i.expect.path));
}

/** `worktree.remove` of a series checkout, citing the series' last done evidence snapshot. */
export async function removeVerificationTree(ctx: StageContext, tree: VerificationTree, parent: StageParent): Promise<void> {
  const evidence = capturedEvidence(ctx.journal.view, tree.evidence);
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, { path: tree.path, evidence });
}

// ---------------------------------------------------------------------------------------------------
// A series, read back from the journal

const sameParent = (a: IntentOf<'proc.spawn'>['parent'], b: StageParent): boolean => canonicalJson(a) === canonicalJson(b);

/** The stage attempt that ran the unit's latest series of `set`, or null when none ran a lane. */
export function latestSeries(view: JournalView, unit: UnitId, set: LaneSet): StageParent | null {
  const spawns = view.opsOf('proc.spawn');
  for (let i = spawns.length - 1; i >= 0; i--) {
    const { expect: { subject: s }, parent } = spawns[i]!;
    if (s.purpose === 'lane' && s.unit === unit && s.set === set && parent.type === 'stage') return parent;
  }
  return null;
}

/**
 * The ledger of the series `parent` ran at commit `at` with evidence under `root`, in order (a candidate
 * attempt runs two: on the candidate, then on the integration tip alone), one record per lane: its first
 * run and its rerun, if any, combined as the series combined them. `lanes` hold the definitions it ran, found
 * by id.
 */
export function seriesLedger(ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], at: Sha, root: AbsPath): readonly LaneRecord[] {
  const runs = new Map<LaneId, IntentOf<'proc.spawn'>[]>();
  for (const intent of ctx.journal.view.opsOf('proc.spawn')) {
    const s = intent.expect.subject;
    if (s.purpose !== 'lane' || s.at !== at || !sameParent(intent.parent, parent)) continue;
    runs.set(s.lane, [...(runs.get(s.lane) ?? []), intent]);
  }
  return [...runs].map(([id, spawns]) => {
    const [first, rerun, ...more] = spawns;
    const lane = lanes.find((l) => l.id === id);
    if (first === undefined) throw new Error(`lane ${id}: no spawn`);
    if (lane === undefined) throw new Error(`lane ${id} of ${first.op} is not among the lanes given`);
    if (more.length > 0) throw new Error(`lane ${id} ran ${spawns.length} times in series ${parent.unit} ${parent.stage}#${parent.attempt} at ${at}; a lane runs at most twice`);
    return laneRecord(laneRun(ctx, first, lane, laneDir(root, lane, 'first')), rerun === undefined ? null : laneRun(ctx, rerun, lane, laneDir(root, lane, 'rerun')));
  });
}

/**
 * The checkout the series `parent` ran in, while the journal says it is still there (created, and not
 * removed since), with the series' last done evidence snapshot for its removal to cite.
 */
export function seriesTree(view: JournalView, parent: StageParent): VerificationTree | null {
  const of = (i: Readonly<{ parent: IntentOf<'proc.spawn'>['parent']; op: OpId }>): boolean => sameParent(i.parent, parent) && view.doneOf(i.op) !== null;
  const created = view.opsOf('worktree.create').filter(of).at(-1);
  if (created === undefined) return null;
  if (created.expect.checkout.type !== 'detached') throw new Error(`series ${parent.unit} ${parent.stage}#${parent.attempt} created a branch checkout`);
  const { path } = created.expect;
  if (view.opsOf('worktree.remove').some((i) => i.expect.path === path && view.doneOf(i.op) !== null)) return null;
  const evidence = view.opsOf('evidence.snapshot').filter(of).at(-1);
  if (evidence === undefined) throw new Error(`the checkout ${path} of series ${parent.unit} ${parent.stage}#${parent.attempt} has no done evidence snapshot`);
  return { path, at: created.expect.checkout.at, evidence: evidence.op };
}

/** The paths a series left dirty in its checkout: the globs of the `_dirty` snapshot under its evidence root. */
export function seriesDirty(view: JournalView, root: AbsPath): readonly RepoPath[] {
  const dest = dirtyDir(root);
  const snap = view.opsOf('evidence.snapshot').find((i) => i.expect.dest === dest);
  return snap === undefined ? [] : snap.expect.globs.map(patternPath);
}
