// Lane execution (plan "Pipeline", lanes and candidate rows; DESIGN-1.0.md §4 Verification, Lanes): the
// executor runs a series of lanes serially, verbatim, under their reservations, in a clean detached
// checkout, in cadence order (build, unit, candidate, batch; dev.17), and keeps one evidence dir per lane. The same series
// runs a unit's spec lanes at the salvage SHA (set `spec`, the lanes stage), the plan's build and unit suite lanes and the
// lanes the unit forces at the salvage SHA and on the unit's diff base (set `suite`, the lanes stage, stages.ts
// `fastSuite`) and the plan's suite lanes up to `candidate` the candidate merge selects on the candidate merge and on the
// integration tip alone (set `suite`, the candidate stage). Arc lanes (M3) and every lane of a job (a publication, a batch
// point) run as a journey series (`runJourneySeries`, at the end of this file) under the same rules.
//
// Per lane: acquire its reservation (its declared resources, its environment's unit and its `@cpu` tokens,
// `laneCpu`) through the stage's `acquire` (`LaneRuntime`) → occupancy probe → its environment up and probed (dev.17,
// src/resources/environments.ts; a failure ends the series `env-unavailable`, no verdict) → run (step 10's cycle) → `invoke`
// purpose `lane` with the exact argv, cwd and env (plus the unit's owner label and the holder's pool instance
// binding, `instanceEnv`, F7) → evidence snapshots → cleanup. The host is sampled at the lane's start and end
// into `<lane>/host.json`. The series stops at the first lane that does not pass: one failure is what a fix
// round needs, and nothing after it is spent. A wait for a lane's reservation that the stage's signal
// cancels (pause, stop) ends the series `interrupted`.
//
// A lane that runs red goes through the red-lane protocol (redlane.ts): a host signature on a busy host
// waits, holding nothing, for a clear host and reruns; a signature without that evidence is `blocked`; a spec lane's
// red repeating the unit's confirmed earlier red (`repeatOf`) is red without a rerun; any other red gets one diagnostic
// rerun (red then green is `flaky`: dev.17, a flake recorded with the tree it was seen on, `observeFlake`, `flakeOn`; a
// flake of the tip's is the flaky ledger's and forgiven, so the green rerun counts, unless the unit deflakes that lane or
// the red ran on a saturated host; a flake on the unit's own commit is its red, dev.21, unless it stands as a tip flake;
// else red). The class is persisted (`red.json`) before the decision. A rerun takes its own reservation,
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
//
// Series certificates (M4a rev 3, Q12, R51): a series whose checkout was still clean after its lanes (and, for a journey
// series, was removed) records `series-certified{parent, checkout, at}`. Only a certified series' runs are ever reused;
// a missing certificate (a crash before it, a dirty checkout, a 1.0.0-dev.6 series) is unknown, never clean.
//
// Lane reuse (M4a rev 3, F1a, R52; dev.17, the one reuse key, src/git/reusekey.ts): a series consults `reusablePass` before
// each lane (but a candidate's stand-in for an arc lane, F6). The latest earlier execution of the lane in any series of the
// run (any unit's, spec or suite) is reused, not run, when it is a clean pass (passed, not flaky, not a repeat, its series
// certified) whose spawn's identity (`LaneIdentity`: the normalised lane rev, the environment id, argv[0]'s resolved path
// and content hash) equals the lane's now and whose commit holds the same input for the lane (`inputShaOf`: its systems'
// paths, or the whole tree but the docs class). An argv[0] that resolves nowhere never reuses. A reused lane records
// `lane-reused{set, at}` and is skipped; its ledger entry is the earlier execution's record with `reused` set. A green spec
// series that ran no lane (every lane reused, or a spec declaring none: a repair unit whose checks are its witnesses, paid
// M4a run 11) still creates its verification checkout (the gate's cwd) and certifies it.
//
// Test-only runs (dev.17, `testOnlyRun`): with no reusable pass, a lane declaring `testArgv` whose latest clean pass's input
// differs from now only in leaf test files of its systems (src/input/systems.ts `laneTestFiles`) runs `testArgv` over the
// changed files that exist, its spawn naming them (`files`); with none left (only deletions) it reuses that pass. A
// stochastic lane never runs test-only.
//
// Stochastic lanes (dev.17, `Stochastic`): up to `runs` runs, each its own spawn and reservation (`<lane>.runs/<n>/` past
// the first), stopping once `minPasses` passed or can no longer pass; the lane passes with `minPasses` passes, and its
// record is its last passing run (else its last run). Never the red-lane protocol, never flaky. A deflake unit's
// verification (dev.17, `verify` on its spawns) runs its lane the same way with every run required to pass.
import { resourceEnvironments } from '../input/plan.ts';
import { cpuCost, laneCpuKey } from '../resources/calibrate.ts';
import { CPU_COST } from '../schedule/types.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { FlakeOn, IntentOf, LaneIdentity, Parent, WitnessFor } from '../core/events.ts';
import {
  type EnvId, type InvocationId, type JobId, type LaneId, type LaneRev, type OpId, type ResourceInstance, type ResourceName, type ResourceUnit, type Sha, type UnitId,
  invocationDirName, invocationId, laneRev, opKey, parseInvocationId, parseOpId, sha256,
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { HOST_SIGNATURES_DEV6, spawnPressureOf } from '../core/upgrade.ts';
import { type ObservationStore, type WitnessedEntry, observationOf, observationStore, reuse, verdictOf } from '../holistic/observe.ts';
import { type ReuseKey, inputShaOf } from '../git/reusekey.ts';
import { type SystemsMap, laneInput, laneTestFiles, systemsMapInForce } from '../input/systems.ts';
import { type ArcLaneDef, type ObligationDef, type Obligations, type WitnessRecord, isExempt, laneRevOf } from '../holistic/types.ts';
import { WITNESS_LINES, WITNESS_RECORD_FILE, collectWitness, envIdOf, hostIdentity, witnessEnv, witnessRecordOf, writeWitnessRecord } from '../holistic/witness.ts';
import { git, revParse } from '../git/git.ts';
import { isAncestor } from '../git/ff.ts';
import { candidateLaneDir, jobEvidenceRoot, jobLaneDir, witnessDir } from '../git/snapshot.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import { exclusivePublish, canonicalJson as fileJson, readJson } from '../core/fsx.ts';
import {
  type CommandVerdict, type IgnoredCensus, isRed, type LaneDef, type RedRev, type SpecM1, STDERR_FILE, STDOUT_FILE, type NeedsUserContent, ignoredCensus,
  LANE_CADENCES, TEST_FILES_TOKEN, cadenceAtOrBefore,
} from '../core/records.ts';
import { type AbsPath, type IsoTime, type RepoPath, type RepoPattern, absPath, branchRef, isoTimeOf, repoPath, repoPattern } from '../core/values.ts';
import { type EvidenceManifest, FILES_DIR, capturedEvidence, manifestPath, namedPathGlobs, patternPath, readManifest } from '../git/evidence.ts';
import { ignoredWrites, planIgnored } from '../git/ignored.ts';
import { statusPorcelainV2Z } from '../git/git.ts';
import { type WorktreeCreateRequest, removedSince, standing } from '../git/worktree.ts';
import { type HostSample, readHostSample } from '../host/sample.ts';
import { PRESSURE_SATURATED } from '../host/pressure.ts';
import { HOST_SIGNATURES, HOST_SIGNATURES_REV, type HostSignatureId, outputSignatures, outputTail } from '../host/signatures.ts';
import { type Argv0, resolveArgv0 } from '../preflight/argv0.ts';
import type { BuildLane, LaneLedgerEntry, ObligationView } from '../prompts/inputs.ts';
import { instanceEnv, laneCpu, requestOf } from '../resources/pool.ts';
import { releaseEnvironment, useEnvironment } from '../resources/environments.ts';
import { probe } from '../resources/probe.ts';
import {
  type JobHolder, type Reservation, type ResourceContext, type SpecLane, type StageHolder, cleanup, heldReservation, jobOwnerLabel, reserve, run,
} from '../resources/reserve.ts';
import { OWNER_ENV, ownerLabel } from '../resources/teardown.ts';
import { runnerFiles } from '../runner/files.ts';
import type { Acquire, Rank, ResourceRequest } from '../schedule/types.ts';
import { type StageContext, type StageParent, evidenceRoot, runOp, verificationWorktree } from './dispatch.ts';
import { invocationDir, invoke } from './invoke.ts';
import {
  type FailureSignature, type LaneCancel, type LaneHost, type RedClass, type RedEvidence, type RepeatOf, classifyRed, failureSignature, hostWasBusy,
  laneAbortReason, laneCancelOf, readRedClass, redLane, writeRedClass,
} from './redlane.ts';
import { evidenceSnapshotOp, worktreeCreateOp, worktreeRemoveOp } from '../recover/ops.ts';
import { flakeOf, observeFlake } from './deflake.ts';
import type { FlakyEvent } from '../core/flaky.ts';

/**
 * The tree a flake of a run at `at` was seen on (dev.21, src/core/events.ts `FlakeOn`): a unit's own (`unit`) when a unit
 * stage other than the candidate ran it on a commit the integration tip does not contain, so the commit holds the unit's
 * unmerged work; else the tip's. `stage` null: a job's run.
 */
export function flakeOn(ctx: ResourceContext, stage: StageParent | null, at: Sha): FlakeOn {
  if (stage === null || stage.stage === 'candidate') return 'tip';
  return isAncestor(ctx.repo, at, revParse(ctx.repo, branchRef(ctx.plan().integrationBranch))) ? 'tip' : 'unit';
}

/** A lane with no progress this long has hung. Default, unmeasured: re-derive once arcs have measured stalls. */
export const LANE_STALL_MS = 10 * 60_000;
/** A lane's deadline: only the backstop for a busy loop, which the stall watchdog cannot see. */
export const LANE_DEADLINE_MS = 6 * 60 * 60_000;
export const LANE_GRACE_MS = 5_000;

/**
 * One run of a lane: what the gate reads (`LaneLedgerEntry`, whose `evidenceDir` holds every snapshot of the
 * run, and its ignored-output census), plus its invocation, its times, and `fixDirs`: the snapshot `files`
 * dirs a fix round reads, the lane's stdout and stderr first, then its declared outputs, then its captured
 * ignored output when it has any. `host`: its host samples (null when none were recorded: a lane an older
 * executor ran, or a crash before the write). `signatures`: the host signatures in a red run's output (empty
 * for any other verdict), by the table its spawn was stamped with (`redRev`; null: an unstamped 1.0.0-dev.6 run,
 * read with `HOST_SIGNATURES_DEV6`). `pressure` (M4b rev 3): its spawn's pressure (null: lost, no schedstat, under
 * `PRESSURE_MIN_WALL_MS`, or before rev 3), which the starved classification reads (RC-11).
 */
export type LaneRun = LaneLedgerEntry & Readonly<{
  inv: InvocationId; at: IsoTime; endedAt: IsoTime; fixDirs: readonly AbsPath[]; host: LaneHost | null; signatures: readonly HostSignatureId[];
  redRev: RedRev | null; pressure: number | null;
}>;

/** A red run whose output carried a host signature (F3): the signatures, and whether its host samples showed a busy host. */
export type HostSuspected = Readonly<{ signatures: readonly HostSignatureId[]; busy: boolean }>;

/**
 * One lane of a series: the run whose verdict counts, and the other run of a red lane (redlane.ts). After a
 * host-signature rerun the record is the rerun and `voided` the first run; after a diagnostic rerun it is the
 * first run and `diagnostic` the rerun; `flaky`: red, then green on the diagnostic rerun. dev.17: a flake the flaky
 * ledger forgave (src/pipeline/deflake.ts) is the green rerun, `flaky`, with the red run `voided`. `repeat`: a red that
 * repeated the unit's earlier red (no rerun, F2). `hostSuspected`: the first run's host signatures (F3).
 */
export type LaneRecord = LaneRun & Readonly<{
  voided: LaneRun | null; diagnostic: LaneRun | null; flaky: boolean; repeat: RepeatOf | null; hostSuspected: HostSuspected | null;
}>;

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
  /** `preempt` only in a candidate's suite (M3, A7). */
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[] }>
  /** dev.17: a lane's environment did not come up or failed its probe (src/resources/environments.ts); no verdict. */
  | Readonly<{ kind: 'env-unavailable'; environment: ResourceName; detail: string }>;

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
 * with the waiter's `rank`), the stage's cancel `signal` (aborted with reason `pause` or `stop`, or `preempt` for a candidate's suite), which also
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

/** In cadence order (build, unit, candidate, batch); declared order within a cadence. */
export function seriesOrder<L extends LaneDef>(lanes: readonly L[]): readonly L[] {
  return LANE_CADENCES.flatMap((c) => lanes.filter((l) => l.cadence === c));
}

/** The spec's series: struck and deferred lanes do not run. */
export function laneOrder(spec: SpecM1): readonly SpecLane[] {
  return seriesOrder(spec.lanes.filter((l) => l.state === 'active'));
}

/**
 * The suite lanes a unit's lanes stage runs after its green spec series (the 2026-10-15 batch; dev.17): the plan's build and
 * unit suite lanes, then the lanes it forces (`forced`, stages.ts `forcedLanes`) of a later cadence, in series order, less
 * each one identical to an active spec lane (`sameExecution`), whose pass the spec series already is.
 */
export function stageSuiteLanes(suite: readonly LaneDef[], spec: SpecM1, forced: ReadonlySet<LaneId>): readonly LaneDef[] {
  const active = laneOrder(spec);
  return seriesOrder(suite.filter((l) => (cadenceAtOrBefore(l.cadence, 'unit') || forced.has(l.id)) && !active.some((s) => sameExecution(l, s))));
}

/** The suite lanes a builder runs before its final report: the build-cadence ones of `stageSuiteLanes`. */
export const builderSuiteLanes = (suite: readonly LaneDef[], spec: SpecM1): readonly BuildLane[] =>
  stageSuiteLanes(suite, spec, new Set()).filter((l): l is BuildLane => l.cadence === 'build');

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

/** A lane's resources, explicit/inherited environments and calibrated `@cpu` tokens; null when nothing. */
export function laneRequest(ctx: ResourceContext, lane: LaneDef): ResourceRequest | null {
  const basis = cpuCost(ctx, laneCpuKey(lane), CPU_COST.lane[lane.cadence], lane.cpu);
  const cpu = laneCpu(lane, basis);
  const names = lane.environment === undefined ? lane.resources : [...lane.resources, lane.environment];
  return names.length === 0 && cpu === 0 ? null : requestOf(ctx.plan(), names, cpu, basis);
}

/**
 * Wall time of a series, from the first lane's start to the last lane's end: the fix window's measure. A reused lane
 * ran in an earlier series, so it is not this series' time.
 */
export function seriesDurationMs(ledger: readonly LaneRecord[]): number {
  const ran = ledger.filter((l) => l.reused === null);
  const first = ran[0];
  const last = ran[ran.length - 1];
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

/** A stochastic lane's runs past the first: `<lane>.runs/<n>/`. */
export const RUNS_SUFFIX = '.runs';

/** A lane's first run, its rerun (redlane.ts), or a stochastic lane's run `n` (n ≥ 2). */
type Which = 'first' | 'rerun' | number;

const laneDir = (root: AbsPath, lane: LaneDef, which: Which): AbsPath =>
  absPath(typeof which === 'number' ? join(root, `${lane.id}${RUNS_SUFFIX}`, String(which)) : join(root, which === 'first' ? lane.id : `${lane.id}${RERUN_SUFFIX}`));

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

/**
 * A lane run's record, read from its spawn and invocation files: what ran (the definition), how it ended
 * (result.json, or none when lost with its runner), when (a lane's deadline is its start plus
 * LANE_DEADLINE_MS, so launch.json carries the start;
 * exit.json the end), its evidence dir's census and host samples, and a red run's host signatures. The live
 * series and every later reader build records here, so they are the same record.
 */
function laneRun(ctx: StageContext, intent: IntentOf<'proc.spawn'>, lane: LaneDef, dir: AbsPath): LaneRun {
  if (intent.parent.type !== 'stage') throw new Error(`lane spawn ${intent.op} has no stage parent`);
  const subject = intent.expect.subject;
  if (subject.purpose !== 'lane') throw new Error(`${intent.op} spawned a ${subject.purpose}, not a lane`);
  const redRev = subject.redRev ?? null;
  const inv = invocationId(intent.op, intent.ordinal);
  const invDir = invocationDir(ctx.runDir, inv);
  const files = runnerFiles(invDir, inv);
  const launch = files.read('launch.json');
  if (launch === null) throw new Error(`lane ${lane.id} ${inv}: no launch.json`);
  const result = files.read('result.json');
  if (result !== null && result.type !== 'command') throw new Error(`${inv}: a lane produced a ${result.type} result`);
  const at = isoTimeOf(new Date(new Date(launch.deadlineAt).getTime() - LANE_DEADLINE_MS));
  const verdict: CommandVerdict = result?.verdict ?? 'process-fault';
  return {
    lane: lane.id, argv: subject.files === undefined ? lane.argv : testArgvOf(lane, subject.files), expectedExit: lane.expectedExit, exitCode: result?.exitCode ?? null, verdict, evidenceDir: dir,
    ignored: readCensus(dir), inv, at, endedAt: files.read('exit.json')?.endedAt ?? at, fixDirs: fixDirsOf(dir, lane),
    host: readLaneHost(dir), signatures: isRed(verdict) ? outputSignatures([join(invDir, STDOUT_FILE), join(invDir, STDERR_FILE)], redRev === null ? HOST_SIGNATURES_DEV6 : HOST_SIGNATURES) : [],
    // A run's own record; a reused lane's ledger entry sets it (`reusedRecord`).
    reused: null, redRev, pressure: donePressure(ctx.journal.view, intent.op),
  };
}

/** A closed spawn's pressure (M4b rev 3); null while open, lost or aborted. */
function donePressure(view: JournalView, op: OpId): number | null {
  const done = view.doneOf(op);
  return done !== null && done.kind === 'proc.spawn' && done.outcome.kind === 'result' ? spawnPressureOf(done.outcome) : null;
}

const evidenceOf = (r: LaneRun): RedEvidence => ({ signatures: r.signatures, host: r.host });

/**
 * A red run's class: persisted in its `red.json` when its spawn was stamped (null while none is written: not yet
 * decided, or a crash before), re-derived with the frozen 1.0.0-dev.6 table when not (Q20); null for a run that is not red.
 */
function redClassOf(run: LaneRun): RedClass | null {
  if (!isRed(run.verdict)) return null;
  if (run.redRev === null) return classifyRed(evidenceOf(run), null);
  return readRedClass(run.evidenceDir)?.class ?? null;
}

/**
 * 1.0.0-dev.6 adoption (temporary scaffolding, deleted with `HOST_SIGNATURES_DEV6`): the class of an unstamped red run,
 * which dev.6 never persisted, re-derived from its raw evidence with the frozen table, as `redClassOf` does; null once
 * that evidence is gone (gc, or a run dir restored from the snapshot ref, which never carries raw output).
 */
export function dev6RedClass(runDir: AbsPath, inv: InvocationId, dir: AbsPath): RedClass | null {
  const invDir = invocationDir(runDir, inv);
  const output = [join(invDir, STDOUT_FILE), join(invDir, STDERR_FILE)];
  if (!output.every((f) => existsSync(f))) return null;
  return classifyRed({ signatures: outputSignatures(output, HOST_SIGNATURES_DEV6), host: readLaneHost(dir) }, null);
}

/**
 * A lane's record from its first run and its rerun, if any: the reading `redLane` made live (redlane.ts). `forgiven`: the
 * flake's `flake-observed` fact forgave it (dev.17), so the green rerun counts.
 */
function laneRecord(first: LaneRun, rerun: LaneRun | null, forgiven = false): LaneRecord {
  const cls = redClassOf(first);
  const base = {
    voided: null, diagnostic: null, flaky: false, repeat: cls?.kind === 'repeat' ? { attempt: cls.attempt, inv: cls.inv } : null,
    hostSuspected: first.signatures.length === 0 ? null : { signatures: first.signatures, busy: hostWasBusy(first.host) },
  };
  if (rerun === null) return { ...first, ...base };
  if (!isRed(first.verdict)) throw new Error(`lane ${first.lane} was rerun after a ${first.verdict} run (${first.inv})`);
  if (cls === null) throw new Error(`lane ${first.lane} was rerun after ${first.inv}, whose red class (red.json) was never written: a stamped run's class is written before any rerun`);
  switch (cls.kind) {
    case 'host-signature':
      return { ...rerun, ...base, voided: first };
    case 'diagnostic':
      if (forgiven) {
        if (rerun.verdict !== 'pass') throw new Error(`lane ${first.lane}: a forgiven flake whose rerun ${rerun.inv} did not pass`);
        return { ...rerun, ...base, voided: first, flaky: true };
      }
      return { ...first, ...base, diagnostic: rerun, flaky: rerun.verdict === 'pass' };
    case 'signature-without-evidence':
      throw new Error(`lane ${first.lane} was rerun after a signature without host evidence (${first.inv})`);
    case 'repeat':
      throw new Error(`lane ${first.lane} was rerun after a repeat of ${cls.inv} (${first.inv})`);
  }
}

/** A red run's failure signature (redlane.ts `failureSignature`) from its output files, its checkout masked. */
function failureOf(runDir: AbsPath, inv: InvocationId, verdict: CommandVerdict, exitCode: number | null, checkout: AbsPath): FailureSignature {
  const invDir = invocationDir(runDir, inv);
  return failureSignature({ verdict, exitCode, stderr: outputTail(join(invDir, STDERR_FILE)), stdout: outputTail(join(invDir, STDOUT_FILE)), checkout });
}

// ---------------------------------------------------------------------------------------------------
// Lane identity, history and reuse (M4a rev 3, F1a, F2; dev.17, the one reuse key)

/** A lane's reuse identity on this host now (R52), with argv[0] as it resolves. */
export function laneIdentity(ctx: Readonly<{ hostEnv: Readonly<Record<string, string | undefined>> }>, lane: LaneDef): Readonly<{ identity: LaneIdentity; argv0: Argv0 }> {
  const argv0 = resolveArgv0(lane, ctx.hostEnv);
  return {
    identity: {
      laneRev: laneRevOf(lane), envId: envIdOf(lane, hostIdentity(), ctx.hostEnv),
      argv0: argv0.kind === 'program' ? { path: argv0.realpath, sha256: sha256(sha256Hex(readFileSync(argv0.realpath))) } : null,
    },
    argv0,
  };
}

/** What a reuse reads: the journal, the repo and (for a lane's identity) the executor's environment. */
type ReuseContext = Readonly<{ journal: Readonly<{ view: JournalView }>; repo: AbsPath; runDir: AbsPath; hostEnv: Readonly<Record<string, string | undefined>> }>;

/** The systems map of the revision in force (src/input/systems.ts). */
export const mapInForce = (view: JournalView): SystemsMap | null => systemsMapInForce(view.planApplied());

/** `lane`'s input on commit `at` under the map in force (src/git/reusekey.ts). */
export const laneInputAt = (ctx: Pick<ReuseContext, 'journal' | 'repo'>, lane: LaneDef, at: Sha): Sha =>
  inputShaOf(ctx.repo, revParse(ctx.repo, `${at}^{tree}`), lane, mapInForce(ctx.journal.view));

/** What a run of a lane at a commit is reused by now: its identity, argv[0], and its input on the commit. */
export type LaneNow = Readonly<{ identity: LaneIdentity; argv0: Argv0; inputSha: Sha }>;

export function laneNow(ctx: ReuseContext, lane: LaneDef, at: Sha): LaneNow {
  return { ...laneIdentity(ctx, lane), inputSha: laneInputAt(ctx, lane, at) };
}

/** An arc lane's reuse key on `tree` (a tree id) in environment `envId`: what its observation is stored under. */
export const arcLaneKey = (ctx: Pick<ReuseContext, 'journal' | 'repo'>, tree: Sha, lane: ArcLaneDef, envId: EnvId): ReuseKey =>
  ({ lane: lane.id, laneRev: laneRevOf(lane), envId, inputSha: inputShaOf(ctx.repo, tree, lane, mapInForce(ctx.journal.view)) });

/** The identity a lane or journey spawn was stamped with; null for an unstamped one (never reused). */
function spawnIdentity(view: JournalView, inv: InvocationId): LaneIdentity | null {
  const intent = view.latestIntent(parseInvocationId(inv).op);
  if (intent.kind !== 'proc.spawn') throw new Error(`${inv} is a ${intent.kind} op, not a spawn`);
  const s = intent.expect.subject;
  if (s.purpose !== 'lane' && s.purpose !== 'journey') throw new Error(`${inv} is no lane spawn`);
  return s.identity ?? null;
}

const sameIdentity = (a: LaneIdentity | null | undefined, b: LaneIdentity): boolean => a !== null && a !== undefined && canonicalJson(a) === canonicalJson(b);

/**
 * Whether the run `inv` (a lane or journey spawn) belongs to a certified series: a `series-certified` fact under its
 * parent, at its SHA, after it, whose checkout holds the run's cwd (Q12, R51). Absence is unknown, never clean.
 */
export function certifiedRun(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>, inv: InvocationId): boolean {
  const view = ctx.journal.view;
  const { op } = parseInvocationId(inv);
  const intent = view.latestIntent(op);
  if (intent.kind !== 'proc.spawn') throw new Error(`${inv} is a ${intent.kind} op, not a spawn`);
  const s = intent.expect.subject;
  if (s.purpose !== 'lane' && s.purpose !== 'journey') throw new Error(`${inv} spawned a ${s.purpose}, which runs no lane series`);
  const launch = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('launch.json');
  if (launch === null) return false;
  const seq = parseOpId(op).seq;
  const parent = canonicalJson(intent.parent);
  return view.holistic().certificates.some((c) => canonicalJson(c.parent) === parent && c.at === s.at && c.seq > seq
    && (launch.cwd === c.checkout || launch.cwd.startsWith(`${c.checkout}/`)));
}

/**
 * One entry of a unit's spec lane history, in log order: a series that ran the lane (`execution` its own) or reused
 * it (`execution` the series that ran it). `record`: the execution's record.
 */
type LaneHistoryEntry = Readonly<{ seq: number; parent: StageParent; execution: StageParent; at: Sha; record: LaneRecord; reused: boolean }>;

const stageParentOf = (p: Parent): StageParent => {
  if (p.type !== 'stage') throw new Error(`${canonicalJson(p)} is no stage attempt`);
  return p;
};

/** The `set` lane spawns of lane `lane` in series `parent` at `at` (the first run, then its rerun or a stochastic lane's runs). */
function laneSpawns(view: JournalView, parent: StageParent, lane: LaneId, at: Sha, set: LaneSet = 'spec'): readonly IntentOf<'proc.spawn'>[] {
  return view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'lane' && s.set === set && s.lane === lane && s.at === at && sameParent(i.parent, parent);
  });
}

/** dev.17: a deflake unit's verification of `lane`: `runs` runs, every one passing (src/pipeline/deflake.ts `verifyRunsOf`). */
const verifiedLane = (lane: LaneDef, runs: number): LaneDef => ({ ...lane, stochastic: { runs, minPasses: runs } });

/** A stochastic lane's record from its runs (see the header): its last passing run once `minPasses` passed, else its last run. */
function stochasticRecord(lane: LaneDef, runs: readonly LaneRun[]): LaneRecord {
  const s = lane.stochastic;
  if (s === undefined) throw new Error(`lane ${lane.id} is not stochastic`);
  if (runs.length > s.runs) throw new Error(`stochastic lane ${lane.id} ran ${runs.length} times; it runs at most ${s.runs}`);
  const passed = runs.filter((r) => r.verdict === 'pass');
  const counted = passed.length >= s.minPasses ? passed.at(-1) : runs.at(-1);
  if (counted === undefined) throw new Error(`stochastic lane ${lane.id}: no run`);
  return { ...counted, voided: null, diagnostic: null, flaky: false, repeat: null, hostSuspected: null };
}

/** The record of a series' runs of `lane` (its first run and its rerun, or a stochastic lane's runs), as the series combined them. */
function spawnRecord(ctx: StageContext, parent: StageParent, lane: LaneDef, spawns: readonly IntentOf<'proc.spawn'>[], root: AbsPath): LaneRecord {
  const [first, rerun, ...more] = spawns;
  if (first === undefined) throw new Error(`lane ${lane.id}: no spawn`);
  const verify = first.expect.subject.purpose === 'lane' ? first.expect.subject.verify : undefined;
  const runs = verify === undefined ? lane : verifiedLane(lane, verify);
  if (runs.stochastic !== undefined) return stochasticRecord(runs, spawns.map((s, i) => laneRun(ctx, s, lane, laneDir(root, lane, i === 0 ? 'first' : i + 1))));
  if (more.length > 0) throw new Error(`lane ${lane.id} ran ${spawns.length} times in series ${parent.unit} ${parent.stage}#${parent.attempt}; a lane runs at most twice`);
  const red = laneRun(ctx, first, lane, laneDir(root, lane, 'first'));
  return laneRecord(red, rerun === undefined ? null : laneRun(ctx, rerun, lane, laneDir(root, lane, 'rerun')), flakeOf(ctx.journal.view, red.inv)?.forgiven ?? false);
}

/**
 * The evidence root of the series a certified run's first spawn `inv` ran in: the parent dir of where its output was
 * snapshotted (`<root>/<lane>/output`), or null when nothing was snapshotted (a crash cut its series short).
 */
function seriesRootOf(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>, inv: InvocationId): AbsPath | null {
  const source = invocationDir(ctx.runDir, inv);
  const snap = ctx.journal.view.opsOf('evidence.snapshot').find((i) => i.expect.source === source);
  return snap === undefined ? null : absPath(dirname(dirname(snap.expect.dest)));
}

/** One series' execution of a lane, read back: its series, set and commit, its spawns' identity and its record. */
type Execution = Readonly<{ seq: number; parent: StageParent; set: LaneSet; at: Sha; identity: LaneIdentity | null; spawns: readonly IntentOf<'proc.spawn'>[] }>;

/** Every series execution of lane `lane` in the run (any unit, any set), every spawn of it done, in log order. */
function executionsOf(view: JournalView, lane: LaneId): readonly Execution[] {
  const groups = new Map<string, IntentOf<'proc.spawn'>[]>();
  for (const i of view.opsOf('proc.spawn')) {
    const s = i.expect.subject;
    if (s.purpose !== 'lane' || s.lane !== lane) continue;
    const key = canonicalJson([i.parent, s.set, s.at]);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.values()].flatMap((spawns) => {
    if (spawns.some((i) => view.doneOf(i.op) === null)) return [];
    const first = spawns[0]!;
    const s = first.expect.subject;
    if (s.purpose !== 'lane') throw new Error(`${first.op}: not a lane spawn`);
    return [{ seq: parseOpId(first.op).seq, parent: stageParentOf(first.parent), set: s.set, at: s.at, identity: s.identity ?? null, spawns }];
  }).sort((a, b) => a.seq - b.seq);
}

/** An execution's record, read from its own series' evidence root; null when that series snapshotted nothing. */
function executionRecord(ctx: StageContext, lane: LaneDef, e: Execution): LaneRecord | null {
  const root = seriesRootOf(ctx, invocationId(e.spawns[0]!.op, e.spawns[0]!.ordinal));
  return root === null ? null : spawnRecord(ctx, e.parent, lane, e.spawns, root);
}

/** A clean pass (F1a, R51): passed, not flaky, not a repeat, in a certified series. */
const cleanPass = (ctx: StageContext, r: LaneRecord): boolean => r.verdict === 'pass' && !r.flaky && r.repeat === null && certifiedRun(ctx, r.inv);

/** A reused lane's ledger entry: the execution `from` names, read back from its series, with `reused` set. */
function reusedRecord(ctx: StageContext, from: Readonly<{ parent: Parent; inv: InvocationId; at: Sha }>, lane: LaneDef): LaneRecord {
  const execution = stageParentOf(from.parent);
  const intent = ctx.journal.view.latestIntent(parseInvocationId(from.inv).op);
  if (intent.kind !== 'proc.spawn' || intent.expect.subject.purpose !== 'lane') throw new Error(`lane ${lane.id} reused ${from.inv}, which is no lane spawn`);
  const spawns = laneSpawns(ctx.journal.view, execution, lane.id, from.at, intent.expect.subject.set);
  const root = spawns[0] === undefined ? null : seriesRootOf(ctx, invocationId(spawns[0].op, spawns[0].ordinal));
  if (root === null) throw new Error(`lane ${lane.id} reused ${from.inv}, whose series snapshotted nothing`);
  const record = spawnRecord(ctx, execution, lane, spawns, root);
  if (record.inv !== from.inv) throw new Error(`lane ${lane.id} reused ${from.inv}, but its series counted ${record.inv}`);
  return { ...record, reused: { at: from.at, inv: from.inv } };
}

/**
 * The unit's spec lane `lane` across its series other than `exclude`, in log order: each series that ran it (every
 * spawn of it done; a series a crash cut short mid-lane is unknown and left out) and each that reused it.
 */
function laneHistory(ctx: StageContext, unit: UnitId, lane: LaneDef, exclude: StageParent): readonly LaneHistoryEntry[] {
  const view = ctx.journal.view;
  const ran: LaneHistoryEntry[] = executionsOf(view, lane.id)
    .filter((e) => e.set === 'spec' && e.parent.unit === unit && !sameParent(e.parent, exclude))
    .map((e) => ({ seq: e.seq, parent: e.parent, execution: e.parent, at: e.at, record: spawnRecord(ctx, e.parent, lane, e.spawns, specSeriesRoot(ctx.runDir, e.parent)), reused: false }));
  const reused: LaneHistoryEntry[] = view.holistic().laneReuses
    .filter((r) => r.lane === lane.id && (r.set ?? 'spec') === 'spec' && r.parent.type === 'stage' && r.parent.unit === unit && !sameParent(r.parent, exclude))
    .map((r) => ({ seq: r.seq, parent: stageParentOf(r.parent), execution: stageParentOf(r.from.parent), at: r.from.at, record: reusedRecord(ctx, r.from, lane), reused: true }));
  return [...ran, ...reused].sort((a, b) => a.seq - b.seq);
}

/** The paths the diff between two commits touches (renames as a delete and an add). */
function diffPaths(repo: AbsPath, from: Sha, to: Sha): readonly RepoPath[] {
  return git(repo, ['diff', '--name-only', '--no-renames', '-z', from, to]).split('\0').filter((p) => p !== '').map((p) => repoPath(p));
}

/** A reused execution: what `lane-reused` names, and its record. */
export type Reusable = Readonly<{ from: Readonly<{ parent: StageParent; inv: InvocationId; at: Sha }>; record: LaneRecord }>;

/**
 * The newest series execution of `lane` in the run whose identity is `now`'s and whose commit holds `now`'s input, when it
 * is a clean pass that series `parent` may reuse at `at` (F1a, R52; dev.17: any unit's, any set's); null otherwise (none,
 * or the newest on this input is not a clean pass).
 */
export function reusablePass(ctx: StageContext, parent: StageParent, lane: LaneDef, at: Sha, now: LaneNow): Reusable | null {
  if (now.argv0.kind === 'not-found') return null;
  const executions = executionsOf(ctx.journal.view, lane.id).filter((e) => !sameParent(e.parent, parent) || e.at !== at);
  for (let i = executions.length - 1; i >= 0; i--) {
    const e = executions[i]!;
    if (!sameIdentity(e.identity, now.identity)) continue;
    if (e.at !== at && laneInputAt(ctx, lane, e.at) !== now.inputSha) continue;
    const record = executionRecord(ctx, lane, e);
    if (record === null || !cleanPass(ctx, record)) return null;
    return { from: { parent: e.parent, inv: record.inv, at: e.at }, record: { ...record, reused: { at: e.at, inv: record.inv } } };
  }
  return null;
}

/**
 * A test-only run of `lane` at `at` (see the header), or null: the newest execution with `now`'s identity is a clean pass
 * whose input differs from `now`'s only in leaf test files of the lane's systems. `files`: those that exist at `at`
 * (empty: deletions only, so `base` is reused); `base`: that pass.
 */
export function testOnlyRun(ctx: StageContext, lane: LaneDef, at: Sha, now: LaneNow): Readonly<{ files: readonly RepoPath[]; base: Reusable }> | null {
  const map = mapInForce(ctx.journal.view);
  if (lane.testArgv === undefined || lane.stochastic !== undefined || map === null || now.argv0.kind === 'not-found') return null;
  const e = executionsOf(ctx.journal.view, lane.id).filter((x) => sameIdentity(x.identity, now.identity)).at(-1);
  if (e === undefined) return null;
  const record = executionRecord(ctx, lane, e);
  if (record === null || !cleanPass(ctx, record)) return null;
  const changed = diffPaths(ctx.repo, e.at, at).filter(laneInput(map, lane));
  const tests = laneTestFiles(map, lane, changed);
  if (changed.length === 0 || tests.length !== changed.length) return null;
  const present = new Set(git(ctx.repo, ['ls-tree', '-r', '-z', '--name-only', at, '--', ...tests]).split('\0').filter((p) => p !== ''));
  return { files: tests.filter((t) => present.has(t as string)), base: { from: { parent: e.parent, inv: record.inv, at: e.at }, record: { ...record, reused: { at: e.at, inv: record.inv } } } };
}

/** `testArgv` with its `{files}` element replaced by `files` (repo paths), one argument each, relative to the lane's cwd. */
export const testArgvOf = (lane: LaneDef, files: readonly RepoPath[]): readonly string[] => {
  if (lane.testArgv === undefined) throw new Error(`lane ${lane.id} declares no testArgv`);
  return lane.testArgv.flatMap((a): readonly string[] => (a === TEST_FILES_TOKEN ? files.map((f) => posix.relative(lane.cwd, f)) : [a]));
};

/**
 * Whether `lane`'s newest run in the run on `now`'s input with `now`'s identity, a series' or a journey's, is a clean pass
 * (dev.17): a batch point skips the lane then ("its systems unchanged since its last green"). A journey run is clean when
 * it passed alone (no rerun of it in its series) or as a stochastic lane, in a certified series.
 */
export function passedOnInput(ctx: StageContext, lane: LaneDef, now: LaneNow): boolean {
  if (now.argv0.kind === 'not-found') return false;
  const view = ctx.journal.view;
  type Hit = Readonly<{ seq: number; clean: () => boolean; at: Sha }>;
  const hits: Hit[] = executionsOf(view, lane.id).filter((e) => sameIdentity(e.identity, now.identity)).map((e) => ({
    seq: e.seq, at: e.at, clean: () => {
      const r = executionRecord(ctx, lane, e);
      return r !== null && cleanPass(ctx, r);
    },
  }));
  const journeys = new Map<string, IntentOf<'proc.spawn'>[]>();
  for (const i of view.opsOf('proc.spawn')) {
    const s = i.expect.subject;
    if (s.purpose !== 'journey' || s.lane !== lane.id || !sameIdentity(s.identity, now.identity)) continue;
    const key = canonicalJson([i.parent, s.at]);
    journeys.set(key, [...(journeys.get(key) ?? []), i]);
  }
  for (const spawns of journeys.values()) {
    if (spawns.some((i) => view.doneOf(i.op) === null)) continue;
    const first = spawns[0]!;
    const s = first.expect.subject;
    if (s.purpose !== 'journey') throw new Error(`${first.op}: not a journey spawn`);
    const verdicts = spawns.map((i) => runnerFiles(invocationDir(ctx.runDir, invocationId(i.op, i.ordinal)), invocationId(i.op, i.ordinal)).read('result.json'));
    const passes = verdicts.filter((r) => r?.type === 'command' && r.verdict === 'pass').length;
    hits.push({
      seq: parseOpId(first.op).seq, at: s.at,
      clean: () => (lane.stochastic === undefined ? spawns.length === 1 && passes === 1 : passes >= lane.stochastic.minPasses)
        && spawns.every((i) => certifiedRun(ctx, invocationId(i.op, i.ordinal))),
    });
  }
  const newest = hits.sort((a, b) => a.seq - b.seq).filter((h) => laneInputAt(ctx, lane, h.at) === now.inputSha).at(-1);
  return newest !== undefined && newest.clean();
}

/**
 * The unit's earlier red this red run of spec lane `lane` repeats (F2, R53), or null: the latest earlier red execution
 * of the lane, with no pass of it since, confirmed and not flaky (its persisted class a diagnostic whose rerun stayed
 * red, or itself a repeat), with the same failure signature, and its spawn's lane rev and environment equal to `now`'s.
 * The caller passes only a specific signature; the host's state is `classifyRed`'s.
 */
function repeatOf(ctx: StageContext, parent: StageParent, lane: LaneDef, now: LaneIdentity, failure: FailureSignature['failure']): RepeatOf | null {
  const history = laneHistory(ctx, parent.unit, lane, parent);
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    const r = e.record;
    if (e.reused || r.verdict === 'pass') return null;
    if (!isRed(r.verdict)) continue;
    if (r.flaky) return null;
    const red = readRedClass(r.evidenceDir);
    const confirmed = red !== null && ((red.class.kind === 'diagnostic' && r.diagnostic !== null) || red.class.kind === 'repeat');
    if (!confirmed || red.failure !== failure) return null;
    const was = spawnIdentity(ctx.journal.view, r.inv);
    if (was === null || was.laneRev !== now.laneRev || was.envId !== now.envId) return null;
    return { attempt: e.execution.attempt, inv: r.inv };
  }
  return null;
}

/**
 * Keeps a counted witness run's record (`witness.json`, in `dir`, where its reporter wrote) and names it by its
 * `witnessed{purpose: witness}` fact: a journey lane's run, or a candidate suite lane that ran as the arc lane (F6). The
 * fact names the lane's input on the tree (dev.17), its observation's reuse key.
 */
function keepWitness(
  ctx: Readonly<{ journal: StageContext['journal']; runDir: AbsPath; repo: AbsPath; hostEnv: Readonly<Record<string, string | undefined>> }>,
  lane: ArcLaneDef, inv: InvocationId, dir: AbsPath, treeSha: Sha, forWhom: WitnessFor,
): WitnessRecord {
  const tests = collectWitness(lane.reporter, { witnessFile: absPath(join(dir, WITNESS_LINES)), stdoutFile: absPath(join(invocationDir(ctx.runDir, inv), STDOUT_FILE)) });
  const record = witnessRecordOf({ lane, envId: laneEnvId(ctx, lane), treeSha, inv, purpose: 'witness' }, tests);
  const recordsSha256 = writeWitnessRecord(dir, record);
  const inputSha = inputShaOf(ctx.repo, treeSha, lane, mapInForce(ctx.journal.view));
  ctx.journal.fact({
    kind: 'witnessed', lane: record.lane, laneRev: record.laneRev, envId: record.envId, treeSha, inv, recordsSha256, purpose: 'witness', for: forWhom, inputSha,
  });
  return record;
}

function spawnOf(view: JournalView, op: OpId): IntentOf<'proc.spawn'> {
  const intent = view.latestIntent(op);
  if (intent.kind !== 'proc.spawn') throw new Error(`${op} is a ${intent.kind} op, not proc.spawn`);
  return intent;
}

type Ran = Readonly<{ record: LaneRun; evidence: OpId; interrupted: LaneCancel | null; blocked: string | null }>;

/**
 * Where a candidate suite lane running as arc lane `witness` (F6) has its reporter write, and its record kept: the dir a
 * `witnessed{for: candidate}` fact names (`witnessDir`).
 */
const suiteWitnessDir = (runDir: AbsPath, parent: StageParent, witness: ArcLaneDef, inv: InvocationId): AbsPath =>
  candidateLaneDir(runDir, parent.unit, parent.attempt, 'arc', witness.id, invocationDirName(inv));

/**
 * One run of `lane`, its spawn stamped with `redRev` and its reuse `identity`. `witness`: the arc lane a candidate suite lane
 * also runs as (F6): its reporter's env is added, writing where its witness record is kept. `files`: a test-only run's
 * (`testOnlyRun`), its `testArgv` over them; null: the lane's argv.
 */
async function runLane(
  ctx: StageContext, parent: StageParent, lane: LaneDef, set: LaneSet, tree: AbsPath, at: Sha, dir: AbsPath, held: readonly ResourceUnit[],
  sampleHost: () => HostSample, identity: LaneIdentity, witness: ArcLaneDef | null, files: readonly RepoPath[] | null, verify: number | null,
): Promise<Ran> {
  const start = sampleHost();
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    cpuKey: laneCpuKey(lane),
    origin: { type: 'new', key: opKey(`lane:${parent.unit}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
    subject: {
      purpose: 'lane', unit: parent.unit, lane: lane.id, set, at, redRev: HOST_SIGNATURES_REV, identity, ...(files === null ? {} : { files: [...files].sort() }),
      ...(verify === null ? (lane.stochastic === undefined ? {} : { stochastic: lane.stochastic }) : { verify }),
    },
    launch: (invDir) => {
      const env = laneEnv(ctx, parent.unit, lane, held);
      let extra: Readonly<Record<string, string>> = {};
      if (witness !== null) {
        const witnessAt = candidateLaneDir(ctx.runDir, parent.unit, parent.attempt, 'arc', witness.id, basename(invDir));
        mkdirSync(witnessAt, { recursive: true });
        extra = witnessEnv(witness.reporter, absPath(join(witnessAt, WITNESS_LINES)));
        for (const name of Object.keys(extra)) if (Object.hasOwn(env, name)) throw new Error(`lane ${lane.id} declares ${name}, which the executor sets`);
      }
      return {
        argv: files === null ? lane.argv : testArgvOf(lane, [...files].sort()), cwd: absPath(join(tree, lane.cwd)), env: { ...env, ...extra }, stdinPath: null,
        stallMs: LANE_STALL_MS, graceMs: LANE_GRACE_MS,
        terminal: { type: 'command', purpose: 'lane', expectedExit: lane.expectedExit },
      };
    },
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
  const interrupted = outcome.kind === 'result' && outcome.result.type === 'command' && outcome.result.verdict === 'cancelled' ? laneCancelOf(outcome.inv, outcome.result.reason) : null;
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
 * `checkout` names, created just before the first lane that runs, keeping evidence under `root`. A spec series
 * reuses a lane's earlier pass where `reusablePass` allows. The caller records the stage outcome; the checkout stays
 * for the caller to keep or remove, certified when it was still clean. `entered`: the stage already holds the first
 * lane's set (`seriesEntry`), reserved, so its first run takes no reservation of its own (released unused when the
 * first lane is reused). `witnesses`: a candidate's suite lanes that also run as an identical arc lane (F6), by id.
 * `verify` (dev.17): a deflake unit's verification runs per lane (src/pipeline/deflake.ts `verifyRunsOf`): that lane runs
 * fresh, that many times, every run passing. A flaky lane (red, then green on its diagnostic rerun) is recorded in the
 * flaky ledger (`observeFlake`) and passes when the ledger forgives it. `carry` (dev.17, a verified docs-only change:
 * src/pipeline/docsonly.ts): passes reused in place of `reusablePass`, by lane id.
 */
export async function runLaneSeries(
  ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], set: LaneSet, checkout: WorktreeCreateRequest, root: AbsPath,
  rt: LaneRuntime, entered: boolean, witnesses: ReadonlyMap<LaneId, ArcLaneDef> = new Map(), verify: ReadonlyMap<LaneId, number> = new Map(),
  carry: ReadonlyMap<LaneId, Reusable> = new Map(),
): Promise<Series> {
  if (checkout.checkout.type !== 'detached') throw new Error(`a lane series runs in a detached checkout, not on ${checkout.checkout.branch}`);
  const ids = new Set<string>(lanes.map((l) => l.id));
  for (const id of ids) {
    for (const suffix of [RERUN_SUFFIX, RUNS_SUFFIX]) if (ids.has(`${id}${suffix}`)) throw new Error(`lanes ${id} and ${id}${suffix} of ${parent.unit}: the second's dir is the first's ${suffix === RERUN_SUFFIX ? 'rerun' : 'runs'} dir`);
  }
  if (witnesses.size > 0 && (set !== 'suite' || parent.stage !== 'candidate')) throw new Error(`series ${parent.unit} ${parent.stage}#${parent.attempt}: only a candidate's suite runs lanes as arc lanes`);
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
  // The suite's runs that were also an arc lane's (F6) are witnessed on the commit's tree.
  const treeSha = witnesses.size > 0 ? revParse(ctx.repo, `${at}^{tree}`) : null;
  const witnessCounted = (lane: LaneDef, record: LaneRecord): void => {
    const witness = witnesses.get(lane.id);
    if (witness === undefined || treeSha === null) return;
    keepWitness(ctx, witness, record.inv, suiteWitnessDir(ctx.runDir, parent, witness, record.inv), treeSha, { type: 'candidate', unit: parent.unit, attempt: parent.attempt });
  };

  const attempt = async (lane: LaneDef, which: Which, identity: LaneIdentity, files: readonly RepoPath[] | null, verifyRuns: number | null = null): Promise<Attempt> => {
    const request = laneRequest(ctx, lane);
    const environments: ResourceName[] = [];
    let held: Reservation<'running', StageHolder> | null = null;
    if (request !== null) {
      if (!entry) {
        const grant = await rt.acquire(request, holder, rt.rank, rt.signal);
        if (grant.kind === 'cancelled') return { kind: 'ended', end: { kind: 'interrupted', reason: laneAbortReason(rt.signal) }, ran: null };
      }
      entry = false;
      const reserved = heldReservation(ctx, holder, 'reserved');
      const occupancy = await probe(ctx, reserved, parent);
      if (occupancy.kind === 'parked') {
        const cleaned = await cleanup(ctx, reserved, parent);
        return { kind: 'ended', end: cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'occupied', needsUser: occupancy.needsUser }, ran: null };
      }
      // dev.17: the lane's environment, its unit reserved above: up when it is not, then its probe.
      for (const name of resourceEnvironments(ctx.plan(), request.named)) {
        const env = await useEnvironment(ctx, name, parent);
        if (env.kind === 'unavailable') {
          const cleaned = await cleanup(ctx, reserved, parent);
          for (const used of environments) releaseEnvironment(ctx.journal, used);
          return {
            kind: 'ended', ran: null,
            end: cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'env-unavailable', environment: env.environment, detail: env.detail },
          };
        }
        environments.push(name);
      }
      held = run(ctx, reserved, parent);
    }
    try {
      if (last.evidence === null) await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, checkout);
      const ran = await runLane(ctx, parent, lane, set, path, at, laneDir(root, lane, which), held?.resources ?? [], rt.sampleHost, identity, witnesses.get(lane.id) ?? null, files, verifyRuns);
      last.evidence = ran.evidence;
      if (held !== null) {
        const cleaned = await cleanup(ctx, held, parent);
        if (cleaned.kind === 'cleanup-failed') return { kind: 'ended', end: { kind: 'cleanup-failed', failed: cleaned.failed }, ran };
      }
      return { kind: 'ran', ran };
    } finally {
      for (const name of environments) releaseEnvironment(ctx.journal, name);
    }
  };

  /**
   * A stochastic lane's runs (see the header): its record (null when it never ran), and how it ends the series (null: it
   * passed).
   */
  const stochastic = async (lane: LaneDef, identity: LaneIdentity, verifyRuns: number | null = null): Promise<Readonly<{ record: LaneRecord | null; end: SeriesEnd | null }>> => {
    const s = lane.stochastic;
    if (s === undefined) throw new Error(`lane ${lane.id} is not stochastic`);
    const runs: LaneRun[] = [];
    for (let n = 1; n <= s.runs; n++) {
      const a = await attempt(lane, n === 1 ? 'first' : n, identity, null, verifyRuns);
      if (a.ran !== null) runs.push(a.ran.record);
      const record = runs.length === 0 ? null : stochasticRecord(lane, runs);
      const stopped = a.kind === 'ended' ? a.end : runEnd(a.ran);
      if (stopped !== null) return { record, end: stopped.kind === 'blocked' && record !== null ? { ...stopped, lane: record } : stopped };
      const passes = runs.filter((r) => r.verdict === 'pass').length;
      if (passes >= s.minPasses) return { record, end: null };
      if (passes + (s.runs - n) < s.minPasses) break;
    }
    const record = stochasticRecord(lane, runs);
    return { record, end: { kind: 'red', lane: record } };
  };

  for (const lane of lanes) {
    const now = laneNow(ctx, lane, at);
    // dev.17: a deflake unit's verification runs its lane fresh, `runs` times, every run passing (never reused, never test-only).
    const verifyRuns = verify.get(lane.id);
    if (verifyRuns !== undefined) {
      if (witnesses.has(lane.id) || lane.stochastic !== undefined) throw new Error(`lane ${lane.id} of ${parent.unit}: a verification lane is neither an arc lane's stand-in nor stochastic`);
      const ran = await stochastic(verifiedLane(lane, verifyRuns), now.identity, verifyRuns);
      if (ran.record !== null) ledger.push(ran.record);
      if (ran.end !== null) {
        end = ran.end;
        break;
      }
      continue;
    }
    // A stand-in for an arc lane always runs: its run is also the arc lane's witness (F6).
    const reusable = witnesses.has(lane.id) ? null : carry.get(lane.id) ?? reusablePass(ctx, parent, lane, at, now);
    const partial = reusable !== null || witnesses.has(lane.id) ? null : testOnlyRun(ctx, lane, at, now);
    const carried = reusable ?? (partial !== null && partial.files.length === 0 ? partial.base : null);
    if (carried !== null) {
      // The stage's entry reservation was the first lane's: unused, it is released before the next lane takes its own.
      if (entry) {
        entry = false;
        const cleaned = await cleanup(ctx, heldReservation(ctx, holder, 'reserved'), parent);
        if (cleaned.kind === 'cleanup-failed') {
          end = { kind: 'cleanup-failed', failed: cleaned.failed };
          break;
        }
      }
      ctx.journal.fact({ kind: 'lane-reused', parent, lane: lane.id, from: carried.from, set, at });
      crashPoint('lanes.after-reused', parent.unit);
      ledger.push(carried.record);
      continue;
    }
    const { identity } = now;
    const files = partial?.files ?? null;
    if (lane.stochastic !== undefined) {
      const ran = await stochastic(lane, identity);
      if (ran.record !== null) ledger.push(ran.record);
      if (ran.end !== null) {
        end = ran.end;
        break;
      }
      continue;
    }
    const first = await attempt(lane, 'first', identity, files);
    if (first.kind === 'ended') {
      if (first.ran !== null) ledger.push(laneRecord(first.ran.record, null));
      end = first.end;
      break;
    }
    const stopped = runEnd(first.ran);
    if (stopped !== null || !isRed(first.ran.record.verdict)) {
      const record = laneRecord(first.ran.record, null);
      ledger.push(record);
      if (stopped === null) {
        witnessCounted(lane, record);
        continue;
      }
      end = stopped;
      break;
    }
    // Red: its class decided and persisted first (a spec lane may repeat the unit's earlier red), then the red-lane
    // protocol, with at most one rerun under its own reservation.
    const red = first.ran.record;
    const failure = failureOf(ctx.runDir, red.inv, red.verdict, red.exitCode, path);
    const repeat = set === 'spec' && failure.specific ? repeatOf(ctx, parent, lane, identity, failure.failure) : null;
    const cls = classifyRed(evidenceOf(red), repeat);
    writeRedClass(red.evidenceDir, cls, failure.failure, parent.unit);
    const rerun: { ran: Ran | null } = { ran: null };
    const result = await redLane<Ran, SeriesEnd>(cls, async () => {
      const again = await attempt(lane, 'rerun', identity, files);
      rerun.ran = again.ran;
      if (again.kind === 'ended') return { kind: 'ended', end: again.end };
      const ended = runEnd(again.ran);
      if (ended !== null) return { kind: 'ended', end: ended };
      return { kind: 'ran', run: again.ran, verdict: { red: isRed(again.ran.record.verdict), evidence: evidenceOf(again.ran.record) } };
    }, { sample: rt.sampleHost, signal: rt.signal });
    const again = rerun.ran?.record ?? null;
    // dev.17: red then green on the diagnostic rerun is a flake, recorded with the tree it was seen on; forgiven as the
    // ledger decides (src/pipeline/deflake.ts `flakeForgiven`: a unit's own flake is its red). A red run on a saturated host
    // is the host's (RC-11: the stage holds it for its rerun), never a flake.
    const hostRed = red.pressure !== null && red.pressure >= PRESSURE_SATURATED;
    const forgiven = result.kind === 'reran' && result.reason === 'diagnostic' && result.verdict.kind === 'red' && result.verdict.flaky && again !== null && !hostRed
      && observeFlake(ctx, { type: 'unit', unit: parent.unit }, lane.id, set, flakeOn(ctx, parent, at), { tree: now.inputSha, env: identity.envId, failing: [], red: red.inv, green: again.inv });
    const record = laneRecord(red, again, forgiven);
    ledger.push(record);
    if ((result.kind === 'reran' && result.verdict.kind !== 'blocked') || result.kind === 'repeat') witnessCounted(lane, record);
    if ((result.kind === 'reran' && result.verdict.kind === 'pass') || forgiven) continue;
    switch (result.kind) {
      case 'repeat':
        end = { kind: 'red', lane: record };
        break;
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
  if (last.evidence === null) {
    if (end.kind !== 'green' || set !== 'spec') return { end, ledger, tree: null, dirty: [] };
    // No lane ran: every lane reused (F1a, Q3), or the spec declares none (a repair unit's, paid M4a run 11). The gate
    // still reads a checkout of the commit, made and certified as any series'. `_reused` cannot collide with a lane id,
    // which starts with a letter.
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, checkout);
    last.evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: path, globs: [], dest: absPath(join(root, '_reused')),
    })).op;
  }
  let evidence: OpId = last.evidence;
  const dirty = dirtyPaths(path);
  if (dirty.length > 0) {
    // Preserve what the lanes wrote before any removal discards it. `_dirty` cannot collide with a lane
    // id, which starts with a letter.
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: path, ...namedPathGlobs(path, dirty), dest: dirtyDir(root),
    })).op;
  } else if (end.kind !== 'blocked') {
    // The census was clean: the series' passes may be reused (Q12). A blocked lane may have been lost with its runner,
    // still writing, so its series is never certified.
    crashPoint('lanes.after-census-before-certified', parent.unit);
    ctx.journal.fact({ kind: 'series-certified', parent, checkout: path, at });
  }
  return { end, ledger, tree: { path, at, evidence }, dirty };
}

const dirtyDir = (root: AbsPath): AbsPath => absPath(join(root, '_dirty'));

/** Tracked or unignored changes in a checkout; ignored files never count. */
export function dirtyPaths(tree: AbsPath): readonly RepoPath[] {
  return statusPorcelainV2Z(tree, false).map((s) => s.path);
}

/** A snapshot request's `globs` and `notRegular` for a checkout's dirty paths (src/git/evidence.ts `namedPathGlobs`). */
export const dirtySnapshot = (tree: AbsPath): ReturnType<typeof namedPathGlobs> => namedPathGlobs(tree, dirtyPaths(tree));

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
    const dirty = dirtySnapshot(path);
    const globs = [...new Set<RepoPattern>([...dirty.globs, ...laneGlobs])].sort();
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: path, globs, notRegular: dirty.notRegular, dest: absPath(join(evidenceRoot(ctx.runDir, series), '_leftover')),
    })).op;
  }
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, { path, evidence: capturedEvidence(ctx.journal.view, evidence) });
}

/** The unit's verification checkouts still present: created (done) by one of its stage attempts and not removed. */
export function presentCheckouts(view: JournalView, unit: UnitId): readonly IntentOf<'worktree.create'>[] {
  return view.opsOf('worktree.create').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.expect.checkout.type === 'detached'
    && standing(view, i));
}

/** `worktree.remove` of a series checkout, citing the series' last done evidence snapshot. */
export async function removeVerificationTree(ctx: StageContext, tree: VerificationTree, parent: StageParent): Promise<void> {
  const evidence = capturedEvidence(ctx.journal.view, tree.evidence);
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, { path: tree.path, evidence });
}

// ---------------------------------------------------------------------------------------------------
// A series, read back from the journal

const sameParent = (a: IntentOf<'proc.spawn'>['parent'], b: StageParent): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * The stage attempt of the unit's latest spec series: the latest lanes attempt that ran a lane, reused one (F1a), or
 * created its own verification checkout (`verificationWorktree`; a series that ran no lane, Q3); null when none did. The
 * lanes attempt's other checkouts (D1's witness journey, D2's smoke) never name it.
 */
export function latestSpecSeries(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; plan: StageContext['plan'] }>, unit: UnitId): StageParent | null {
  const view = ctx.journal.view;
  const { worktreeRoot, arc } = ctx.plan();
  const latest: { seq: number; parent: StageParent | null } = { seq: -1, parent: null };
  const see = (seq: number, parent: Parent): void => {
    if (parent.type !== 'stage' || parent.unit !== unit || seq <= latest.seq) return;
    latest.seq = seq;
    latest.parent = parent;
  };
  for (const { op, expect: { subject: s }, parent } of view.opsOf('proc.spawn')) if (s.purpose === 'lane' && s.set === 'spec') see(parseOpId(op).seq, parent);
  for (const r of view.holistic().laneReuses) if ((r.set ?? 'spec') === 'spec') see(r.seq, r.parent);
  for (const i of view.opsOf('worktree.create')) {
    const p = i.parent;
    if (p.type === 'stage' && p.stage === 'lanes' && i.expect.path === verificationWorktree(worktreeRoot, arc, p.unit, p.attempt)) see(parseOpId(i.op).seq, p);
  }
  return latest.parent;
}

/**
 * The ledger of the `set` series `parent` ran at commit `at` with evidence under `root`, in order (a candidate
 * attempt runs two: on the candidate, then on the integration tip alone; a lanes attempt its spec series, then its stage
 * suite series at the same commit, then the stage suite on the unit's diff base), one record per lane: its first
 * run and its rerun (or a stochastic lane's runs), combined as the series combined them, or (F1a; dev.17 any series) the
 * earlier execution it reused, read back from that execution's series. `lanes` hold the definitions it ran, found by id.
 */
export function seriesLedger(ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], set: LaneSet, at: Sha, root: AbsPath): readonly LaneRecord[] {
  const defOf = (id: LaneId, by: string): LaneDef => {
    const lane = lanes.find((l) => l.id === id);
    if (lane === undefined) throw new Error(`lane ${id} of ${by} is not among the lanes given`);
    return lane;
  };
  const runs = new Map<LaneId, IntentOf<'proc.spawn'>[]>();
  for (const intent of ctx.journal.view.opsOf('proc.spawn')) {
    const s = intent.expect.subject;
    if (s.purpose !== 'lane' || s.set !== set || s.at !== at || !sameParent(intent.parent, parent)) continue;
    runs.set(s.lane, [...(runs.get(s.lane) ?? []), intent]);
  }
  const ran = [...runs].map(([id, spawns]) => ({ seq: parseOpId(spawns[0]!.op).seq, record: spawnRecord(ctx, parent, defOf(id, spawns[0]!.op), spawns, root) }));
  // A reuse names its series' set and commit (dev.17); one recorded before names a spec series at its commit.
  const reused = ctx.journal.view.holistic().laneReuses.filter((r) => sameParent(r.parent, parent) && (r.set ?? 'spec') === set && (r.at ?? at) === at)
    .map((r) => ({ seq: r.seq, record: reusedRecord(ctx, r.from, defOf(r.lane, `lane-reused seq ${r.seq}`)) }));
  return [...ran, ...reused].sort((a, b) => a.seq - b.seq).map((e) => e.record);
}

/**
 * One lane's record in the series `parent` at `at` (null when it neither ran nor was reused there), whatever else ran beside it: a reader
 * of one lane (the gate's regenerate checks, gate.ts) is not refused for a lane a revision has since dropped from the plan.
 */
export function laneRecordIn(ctx: StageContext, parent: StageParent, lane: LaneDef, set: LaneSet, at: Sha, root: AbsPath): LaneRecord | null {
  const spawns = ctx.journal.view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'lane' && s.set === set && s.at === at && s.lane === lane.id && sameParent(i.parent, parent);
  });
  if (spawns.length > 0) return spawnRecord(ctx, parent, lane, spawns, root);
  const reused = ctx.journal.view.holistic().laneReuses.find((r) => r.lane === lane.id && sameParent(r.parent, parent) && (r.set ?? 'spec') === set && (r.at ?? at) === at);
  return reused === undefined ? null : reusedRecord(ctx, reused.from, lane);
}

/**
 * The checkout the series `parent` ran in at `path` (its own: a lanes attempt may make other checkouts, Q3), while the
 * journal says it is still there (created, and not removed since), with the series' last done evidence snapshot for its
 * removal to cite.
 */
export function seriesTree(view: JournalView, parent: StageParent, path: AbsPath): VerificationTree | null {
  const of = (i: Readonly<{ parent: IntentOf<'proc.spawn'>['parent']; op: OpId }>): boolean => sameParent(i.parent, parent) && view.doneOf(i.op) !== null;
  const created = view.opsOf('worktree.create').filter((i) => of(i) && i.expect.path === path).at(-1);
  if (created === undefined) return null;
  if (created.expect.checkout.type !== 'detached') throw new Error(`series ${parent.unit} ${parent.stage}#${parent.attempt} created a branch checkout`);
  if (removedSince(view, path, created.op)) return null;
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

// ---------------------------------------------------------------------------------------------------
// Journey series (M3 B2; DESIGN-1.0.md §2.8 "Journey lanes"; plan "Journey lanes and the held-claims brake")
//
// Arc lanes (and a job's suite lanes) run owned by no unit, under the same arbiter, locks, watchdog, evidence and
// red-lane rules as a series: in a unit's candidate under its stage holder (`owner: unit`), and under a job's holder
// `job{job}` (a docs publication, a repair batch, the baseline job, an audit). Per lane: its reservation (a unit's
// through its stage's `acquire`; a job's first of every unit, `acquireFirst`), the occupancy probe, the run as a
// `journey{lane, laneRev, at, owner}` spawn with the lane's env plus the owner label, the instance binding and a
// witness run's reporter env (`witnessEnv`), evidence snapshots, cleanup. A red run goes through the red-lane protocol
// (redlane.ts): the run whose verdict counts is the one recorded.
//
// Evidence is per execution and immutable: each run has its own dir, named by its kind, lane and invocation (a job's
// `jobLaneDir`, a candidate's `candidateLaneDir`, src/git/snapshot.ts), holding its `output`, its declared `tree`
// evidence and `host.json`. A witness run's reporter writes `witness.lines` there, and its record is kept there as
// `witness.json` (`witnessDir`), named by the `witnessed` fact of the counted run only (a diagnostic rerun or a voided run
// is kept, never named), so the observation store (`observations`) holds exactly the verdicts that count. After the last
// lane the checkout must still be the commit (the checkout's integrity, as a unit's suite): the paths a lane left dirty
// are snapshotted (`_dirty-<checkout>`) and a moved HEAD recorded, and either refuses the certification (the caller's).
//
// Lane reuse (§9): a witness lane whose observation on the tree already exists (all four keys equal, its record's
// hash checked when it entered the store) is not run again; the series reads the kept record (`reuse` option; the
// baseline job runs every lane afresh). Only an observation of a certified series is reused (R51, `certifiedRun`):
// after its lanes the series' checkout was clean and was removed, then `series-certified` was recorded.

/**
 * One lane a journey series runs: a suite lane (a job's; `witness` null), or an arc lane, whose run is a witness.
 * `suite`: its exit verdict is a suite lane's (a suite lane, or an arc lane standing in for an identical suite lane,
 * F6), so it always runs: an observation carries no exit verdict.
 */
export type JourneyLane = Readonly<{ def: LaneDef; laneRev: LaneRev; witness: ArcLaneDef | null; suite: boolean }>;

/** A suite lane's rev, as an arc lane's (`laneRevOf`): what its `journey` spawn names. */
export const suiteLaneRev = (lane: LaneDef): LaneRev => laneRev(sha256Hex(canonicalJson(lane)).slice(0, 16));
export const suiteJourneyLane = (def: LaneDef): JourneyLane => ({ def, laneRev: suiteLaneRev(def), witness: null, suite: true });
export const arcJourneyLane = (def: ArcLaneDef): JourneyLane => ({ def, laneRev: laneRevOf(def), witness: def, suite: false });
/** An arc lane run once as itself and as the identical suite lane it stands in for (F6, `sameExecution`). */
export const standInJourneyLane = (def: ArcLaneDef): JourneyLane => ({ ...arcJourneyLane(def), suite: true });

/**
 * Whether a suite lane and another lane are one execution (F6, R63): the same argv, cwd, declared env and expected exit,
 * so on the same tree the other's run is the suite lane's: an arc lane's (with its reporter's env added), or a spec
 * lane's (`fastSuiteLanes`).
 */
export function sameExecution(suite: LaneDef, other: LaneDef): boolean {
  const shape = (l: LaneDef): string => canonicalJson({ argv: l.argv, cwd: l.cwd, set: l.env.set, pass: [...l.env.pass].sort(), expectedExit: l.expectedExit });
  return shape(suite) === shape(other);
}

/** Each suite lane's identical arc lane among `arc` (the first, by `sameExecution`), by suite lane id; never a stochastic lane's. */
export function suiteStandIns(suite: readonly LaneDef[], arc: readonly ArcLaneDef[]): ReadonlyMap<LaneId, ArcLaneDef> {
  return new Map(suite.flatMap((s) => {
    const a = s.stochastic === undefined ? arc.find((l) => sameExecution(s, l)) : undefined;
    return a === undefined ? [] : [[s.id, a] as const];
  }));
}

/** Who runs a journey series: a unit's candidate stage attempt (its stage holder), or a durable job. */
export type JourneyOwner =
  | Readonly<{ type: 'unit'; parent: StageParent; rt: LaneRuntime }>
  | Readonly<{ type: 'job'; job: JobId; acquireFirst: AcquireFirst }>;

/** What a journey series needs: the reservation cycle's context and the executor's environment. */
export type JourneyContext = ResourceContext & Readonly<{ hostEnv: Readonly<Record<string, string | undefined>> }>;

/**
 * One lane of a journey series: the run whose verdict counts (`inv`, `verdict`, `dir`, `flaky` after a diagnostic
 * rerun that passed), or a reused observation (`inv`, `verdict` and `dir` null). `record`: a witness lane's record.
 */
export type JourneyRun = Readonly<{
  lane: LaneId; inv: InvocationId | null; verdict: CommandVerdict | null; flaky: boolean; dir: AbsPath | null; record: WitnessRecord | null;
}>;

export type JourneyEnd =
  /** Every lane ran or was reused (or `stop` ended the series at a lane that ran). */
  | Readonly<{ kind: 'ran' }>
  /** A lane's runner was lost or ended by its deadline, or the red-lane protocol gave no verdict. */
  | Readonly<{ kind: 'blocked'; lane: LaneId; detail: string }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  /** A lane's resources could not be cleaned: residues of the unit's stage attempt, or job-owned (G4). */
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[] }>
  /** A unit's series only: its stage was paused, stopped or preempted. */
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>;

/**
 * The checkout after the lanes: the paths they left dirty (tracked or unignored changes, snapshotted under `evidence`)
 * and the HEAD they moved it to (null: still at the commit). Either refuses certification.
 */
export type JourneyCheckout = Readonly<{ dirty: readonly RepoPath[]; movedTo: Sha | null; evidence: AbsPath }>;

/** `checkout` null: no lane ran, so no checkout was made. */
export type JourneySeries = Readonly<{ end: JourneyEnd; runs: readonly JourneyRun[]; treeSha: Sha; checkout: JourneyCheckout | null }>;

/** Whether a series' checkout was still its commit after the lanes (a series that made none is). */
export const intact = (series: JourneySeries): boolean => series.checkout === null || (series.checkout.dirty.length === 0 && series.checkout.movedTo === null);

/** A job's waits are never cancelled: a job runs to its end once begun. */
const NEVER = new AbortController().signal;

/**
 * The checkouts a job created and did not remove (a crash or a restart cut it short): each removed, citing the job's
 * last done evidence snapshot, or one made of nothing under `<job evidence root>/_leftover` when it took none.
 */
export async function removeJobCheckouts(ctx: ResourceContext, job: JobId): Promise<void> {
  const view = ctx.journal.view;
  const parent: Parent = { type: 'job', job };
  const same = (p: Parent): boolean => canonicalJson(p) === canonicalJson(parent);
  for (const c of view.opsOf('worktree.create').filter((i) => same(i.parent) && standing(view, i))) {
    let evidence = view.opsOf('evidence.snapshot').filter((i) => same(i.parent) && view.doneOf(i.op) !== null).at(-1)?.op;
    if (evidence === undefined) {
      evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${job}`, parent, {
        source: c.expect.path, globs: [], dest: absPath(join(jobEvidenceRoot(ctx.runDir, job), '_leftover')),
      })).op;
    }
    await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${job}`, parent, { path: c.expect.path, evidence: capturedEvidence(ctx.journal.view, evidence) });
  }
}

/** A job's kinds of journey series: the baseline's, an audit's lanes, a re-witness (an audit's or a checkpoint's), a batch point's (dev.17). */
export type JobSeriesKind = 'checkout' | 'lanes' | 'rewitness' | 'batch';

/**
 * The checkout of a job's next journey series of kind `what`: `<worktreeRoot>/<arc>/<job>.<what>-<n>`, n one past the
 * checkouts of that kind the job has begun. A job may run such a series more than once (resumed after it was cut short,
 * a baseline re-run on a tip a plan revision left unwitnessed, a re-witness asked again), so each series gets a checkout
 * of its own: its certificate (one `series-certified` per parent and checkout), its `_dirty-<checkout>` evidence and its
 * runs' cwd (`certifiedRun`) name that series alone, and `removeJobCheckouts` never mistakes it for an earlier one.
 */
export function jobSeriesCheckout(ctx: Pick<ResourceContext, 'journal' | 'plan'>, job: JobId, what: JobSeriesKind): AbsPath {
  const parent = canonicalJson({ type: 'job', job } satisfies Parent);
  const stem = `${job}.${what}-`;
  const begun = ctx.journal.view.opsOf('worktree.create').filter((i) => canonicalJson(i.parent) === parent && basename(i.expect.path).startsWith(stem)).length;
  return absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${stem}${begun + 1}`));
}

/** Where a witness run's record is kept: `witness.json` in its execution's dir (what a `witnessed` fact names). */
export const witnessRecordPath = (runDir: AbsPath, fact: Parameters<typeof witnessDir>[1]): AbsPath => absPath(join(witnessDir(runDir, fact), WITNESS_RECORD_FILE));

type WitnessedView = Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>;

/** The observations of `witnessed` facts, the latest per key (src/holistic/observe.ts). */
function storeOf(ctx: WitnessedView, witnessed: readonly WitnessedEntry[]): ObservationStore {
  return observationStore(witnessed.flatMap((w) => {
    const path = witnessRecordPath(ctx.runDir, w);
    const o = observationOf(w, existsSync(path) ? readFileSync(path, 'utf8') : null);
    return o === null ? [] : [o];
  }));
}

/** Every certifying observation the log's `witnessed` facts name, the latest per key (src/holistic/observe.ts). */
export function observations(ctx: WitnessedView): ObservationStore {
  return storeOf(ctx, ctx.journal.view.holistic().witnessed);
}

/** The observations a journey series may reuse: those of certified series only (R51). */
export function certifiedObservations(ctx: WitnessedView): ObservationStore {
  return storeOf(ctx, ctx.journal.view.holistic().witnessed.filter((w) => w.purpose === 'witness' && certifiedRun(ctx, w.inv)));
}

/**
 * Obligations as a judgment reads them (the gate's selected ones, a lens's), each with its observation on `commit`'s
 * tree in this host's environment: the reusable one (all four keys), or null when none is there (never run, stale, a
 * split parent, which is never witnessed directly).
 */
export function observedViews(
  ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; repo: AbsPath; hostEnv: Readonly<Record<string, string | undefined>> }>,
  obligations: Obligations | null, defs: readonly ObligationDef[], commit: Sha,
): readonly ObligationView[] {
  if (defs.length === 0) return [];
  if (obligations === null) throw new Error('obligation views outside a holistic arc with obligations');
  const tree = revParse(ctx.repo, `${commit}^{tree}`);
  const store = observations(ctx);
  const lanes = new Map(obligations.lanes.map((l) => [l.id, l]));
  const latched = new Set(ctx.journal.view.holistic().latched.map((l) => l.obligation));
  return defs.map((o) => {
    const lane = o.witness === null ? undefined : lanes.get(o.witness.lane);
    const found = lane === undefined ? null : reuse(store, arcLaneKey(ctx, tree, lane, laneEnvId(ctx, lane)));
    return { obligation: o, exempt: isExempt(o), latched: latched.has(o.id), observation: found === null || o.witness === null ? null : { key: found.key, verdict: verdictOf(found.record, o.witness) } };
  });
}

/** The environment identity of an arc lane on this host (its passed-through variables' values). */
export const laneEnvId = (ctx: Readonly<{ hostEnv: Readonly<Record<string, string | undefined>> }>, lane: ArcLaneDef): EnvId => envIdOf(lane, hostIdentity(), ctx.hostEnv);

/** One run of a journey lane, before the red-lane protocol reads it. */
type JourneyRan = Readonly<{
  inv: InvocationId; dir: AbsPath; verdict: CommandVerdict; exitCode: number | null; evidence: RedEvidence; interrupted: LaneCancel | null; blocked: string | null; evidenceOp: OpId;
}>;

/** One run of a lane under its reservation: it ran (its cleanup passed), or the series ends without a verdict. */
type JourneyAttempt = Readonly<{ kind: 'ran'; ran: JourneyRan }> | Readonly<{ kind: 'ended'; end: JourneyEnd; ran: JourneyRan | null }>;

/**
 * Runs `lanes` one at a time for `owner` in the detached checkout `checkout` (created before the first lane that runs,
 * checked for integrity after the last, then removed citing the series' last evidence snapshot), keeping each run's
 * evidence in its own execution's dir. A witness
 * lane's counted run becomes a `witness.json` and a `witnessed{purpose: witness}` fact (`for: candidate{unit, attempt}`
 * or `job{job}`). The series ends at the first lane without a verdict, or where `stop` says.
 */
export async function runJourneySeries(
  ctx: JourneyContext, owner: JourneyOwner, lanes: readonly JourneyLane[], checkout: WorktreeCreateRequest,
  opts: Readonly<{ reuse: boolean; stop: (run: JourneyRun) => boolean }>,
): Promise<JourneySeries> {
  if (checkout.checkout.type !== 'detached') throw new Error(`a journey series runs in a detached checkout, not on ${checkout.checkout.branch}`);
  const { at } = checkout.checkout;
  const arc = ctx.plan().arc;
  const treeSha = revParse(ctx.repo, `${at}^{tree}`);
  const who = owner.type === 'unit' ? owner.parent.unit : owner.job;
  const parent: Parent = owner.type === 'unit' ? owner.parent : { type: 'job', job: owner.job };
  const holder: StageHolder | JobHolder = owner.type === 'unit'
    ? { type: 'stage', unit: owner.parent.unit, stage: owner.parent.stage, attempt: owner.parent.attempt }
    : { type: 'job', job: owner.job };
  const signal = owner.type === 'unit' ? owner.rt.signal : NEVER;
  const sampleHost = owner.type === 'unit' ? owner.rt.sampleHost : readHostSample;
  const label = owner.type === 'unit' ? ownerLabel(arc, owner.parent.unit) : jobOwnerLabel(arc, owner.job);
  const worktreeKey = owner.type === 'unit' ? `worktree:${who}:verify` : `worktree:${who}`;
  const store = opts.reuse ? certifiedObservations(ctx) : null;
  // Each execution's own evidence dir, named by its invocation once the spawn's intent names it (the launch).
  const dirOf = (lane: JourneyLane, invDir: string): AbsPath => {
    const kind = lane.witness === null ? 'suite' : 'arc';
    return owner.type === 'unit'
      ? candidateLaneDir(ctx.runDir, owner.parent.unit, owner.parent.attempt, kind, lane.def.id, basename(invDir))
      : jobLaneDir(ctx.runDir, owner.job, kind, lane.def.id, basename(invDir));
  };
  const runs: JourneyRun[] = [];
  let lastEvidence: OpId | null = null;
  let end: JourneyEnd = { kind: 'ran' };

  const envOf = (lane: JourneyLane, held: readonly ResourceUnit[], witnessFile: AbsPath): Readonly<Record<string, string>> => {
    const env: Record<string, string> = { ...lane.def.env.set };
    for (const name of lane.def.env.pass) {
      const value = ctx.hostEnv[name];
      if (value === undefined) throw new Error(`lane ${lane.def.id} passes ${name}, which the executor's environment lacks`);
      env[name] = value;
    }
    const executor: Record<string, string> = { [OWNER_ENV]: label, ...instanceEnv(held), ...(lane.witness === null ? {} : witnessEnv(lane.witness.reporter, witnessFile)) };
    for (const [name, value] of Object.entries(executor)) {
      if (Object.hasOwn(env, name)) throw new Error(`lane ${lane.def.id} declares ${name}, which the executor sets`);
      env[name] = value;
    }
    return env;
  };

  const runOne = async (lane: JourneyLane, held: readonly ResourceUnit[]): Promise<JourneyRan> => {
    const start = sampleHost();
    const outcome = await invoke(ctx.journal, ctx.containment, {
      runDir: ctx.runDir,
      cpuKey: laneCpuKey(lane.def),
      origin: { type: 'new', key: opKey(`lane:${who}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
      subject: {
        purpose: 'journey', lane: lane.def.id, laneRev: lane.laneRev, at, owner: owner.type === 'unit' ? { type: 'unit', unit: owner.parent.unit } : { type: 'job', job: owner.job },
        redRev: HOST_SIGNATURES_REV,
        // dev.17: a suite lane's run carries its reuse identity, so a batch point finds its clean passes (`passedOnInput`).
        ...(lane.witness === null ? { identity: laneIdentity(ctx, lane.def).identity } : {}),
      },
      launch: (invDir) => {
        mkdirSync(dirOf(lane, invDir), { recursive: true });
        return {
          argv: lane.def.argv, cwd: absPath(join(checkout.path, lane.def.cwd)), env: envOf(lane, held, absPath(join(dirOf(lane, invDir), WITNESS_LINES))), stdinPath: null,
          stallMs: LANE_STALL_MS, graceMs: LANE_GRACE_MS, terminal: { type: 'command', purpose: 'lane', expectedExit: lane.def.expectedExit },
        };
      },
    });
    const endSample = sampleHost();
    const invDir = invocationDir(ctx.runDir, outcome.inv);
    const dir = dirOf(lane, invDir);
    mkdirSync(dir, { recursive: true });
    let evidenceOp = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${who}`, parent, {
      source: invDir, globs: [repoPattern(STDOUT_FILE), repoPattern(STDERR_FILE)], dest: absPath(join(dir, 'output')),
    })).op;
    if (lane.def.evidenceGlobs.length > 0) {
      evidenceOp = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${who}`, parent, { source: checkout.path, globs: lane.def.evidenceGlobs, dest: absPath(join(dir, 'tree')) })).op;
    }
    const host: LaneHost = { start, end: endSample };
    exclusivePublish(join(dir, HOST_FILE), fileJson(host));
    if (outcome.kind === 'lost') {
      return { inv: outcome.inv, dir, verdict: 'process-fault', exitCode: null, evidence: { signatures: [], host }, interrupted: null, blocked: `${outcome.inv} was lost with its runner`, evidenceOp };
    }
    if (outcome.result.type !== 'command') throw new Error(`${outcome.inv}: a lane produced a ${outcome.result.type} result`);
    const { verdict } = outcome.result;
    const interrupted = outcome.result.verdict === 'cancelled' ? laneCancelOf(outcome.inv, outcome.result.reason) : null;
    const blocked = verdict === 'process-fault' ? `${outcome.inv} ended by ${runnerFiles(invDir, outcome.inv).read('exit.json')?.cause ?? 'unknown'}` : null;
    const signatures = isRed(verdict) ? outputSignatures([join(invDir, STDOUT_FILE), join(invDir, STDERR_FILE)]) : [];
    return { inv: outcome.inv, dir, verdict, exitCode: outcome.result.exitCode, evidence: { signatures, host }, interrupted, blocked, evidenceOp };
  };

  const attempt = async (lane: JourneyLane): Promise<JourneyAttempt> => {
    const request = laneRequest(ctx, lane.def);
    const environments: ResourceName[] = [];
    let held: Reservation<'running', StageHolder | JobHolder> | null = null;
    if (request !== null) {
      const grant = owner.type === 'unit'
        ? await owner.rt.acquire(request, holder, owner.rt.rank, signal)
        : await owner.acquireFirst(request, { type: 'job', job: owner.job }, NEVER);
      if (grant.kind === 'cancelled') {
        if (owner.type === 'job') throw new Error(`${owner.job}: a lane wait was cancelled, and nothing cancels it`);
        return { kind: 'ended', end: { kind: 'interrupted', reason: laneAbortReason(signal) }, ran: null };
      }
      const reserved = heldReservation(ctx, holder, 'reserved');
      const occupancy = await probe(ctx, reserved, parent);
      if (occupancy.kind === 'parked') {
        const cleaned = await cleanup(ctx, reserved, parent);
        return { kind: 'ended', end: cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'occupied', needsUser: occupancy.needsUser }, ran: null };
      }
      // dev.17: a suite lane's environment (an arc lane names none). One that does not come up gives no verdict: the
      // series is blocked, and its job retries on the no-verdict backoff.
      for (const name of resourceEnvironments(ctx.plan(), request.named)) {
        const env = await useEnvironment(ctx, name, parent);
        if (env.kind === 'unavailable') {
          const cleaned = await cleanup(ctx, reserved, parent);
          for (const used of environments) releaseEnvironment(ctx.journal, used);
          return {
            kind: 'ended', ran: null,
            end: cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'blocked', lane: lane.def.id, detail: `environment ${env.environment}: ${env.detail}` },
          };
        }
        environments.push(name);
      }
      held = run(ctx, reserved, parent);
    }
    try {
      if (lastEvidence === null) await runOp(ctx.journal, worktreeCreateOp(ctx.repo), worktreeKey, parent, checkout);
      const ran = await runOne(lane, held?.resources ?? []);
      lastEvidence = ran.evidenceOp;
      if (held !== null) {
        const cleaned = await cleanup(ctx, held, parent);
        if (cleaned.kind === 'cleanup-failed') return { kind: 'ended', end: { kind: 'cleanup-failed', failed: cleaned.failed }, ran };
      }
      return { kind: 'ran', ran };
    } finally {
      for (const name of environments) releaseEnvironment(ctx.journal, name);
    }
  };

  /** A run's own end without a verdict (cancelled, blocked), or null. */
  const noVerdict = (lane: JourneyLane, r: JourneyRan): JourneyEnd | null => {
    if (r.interrupted !== null) return { kind: 'interrupted', reason: r.interrupted };
    if (r.blocked !== null) return { kind: 'blocked', lane: lane.def.id, detail: r.blocked };
    return null;
  };

  /** The counted run's witness record kept and named by its `witnessed` fact; null for a suite lane. */
  const witness = (lane: JourneyLane, r: JourneyRan): WitnessRecord | null => {
    if (lane.witness === null) return null;
    return keepWitness(ctx, lane.witness, r.inv, r.dir, treeSha,
      owner.type === 'unit' ? { type: 'candidate', unit: owner.parent.unit, attempt: owner.parent.attempt } : { type: 'job', job: owner.job });
  };

  const counted = (lane: JourneyLane, r: JourneyRan, flaky: boolean): JourneyRun => ({ lane: lane.def.id, inv: r.inv, verdict: r.verdict, flaky, dir: r.dir, record: witness(lane, r) });

  for (const lane of lanes) {
    if (store !== null && lane.witness !== null && !lane.suite) {
      const o = reuse(store, arcLaneKey(ctx, treeSha, lane.witness, laneEnvId(ctx, lane.witness)));
      if (o !== null) {
        runs.push({ lane: lane.def.id, inv: null, verdict: null, flaky: false, dir: null, record: o.record });
        continue;
      }
    }
    if (lane.def.stochastic !== undefined) {
      if (lane.witness !== null) throw new Error(`journey lane ${lane.def.id}: an arc lane is never stochastic`);
      // Stochastic (dev.17): up to `runs` runs, stopping once `minPasses` passed or can no longer pass; never flaky.
      const s = lane.def.stochastic;
      const ran: JourneyRan[] = [];
      let stoppedAt: JourneyEnd | null = null;
      for (let n = 1; n <= s.runs; n++) {
        const a = await attempt(lane);
        if (a.ran !== null) ran.push(a.ran);
        stoppedAt = a.kind === 'ended' ? a.end : noVerdict(lane, a.ran);
        if (stoppedAt !== null) break;
        const passes = ran.filter((r) => r.verdict === 'pass').length;
        if (passes >= s.minPasses || passes + (s.runs - n) < s.minPasses) break;
      }
      if (stoppedAt !== null) {
        end = stoppedAt;
        break;
      }
      const passed = ran.filter((r) => r.verdict === 'pass');
      const result = counted(lane, (passed.length >= s.minPasses ? passed.at(-1) : ran.at(-1))!, false);
      runs.push(result);
      if (opts.stop(result)) break;
      continue;
    }
    const first = await attempt(lane);
    if (first.kind === 'ended') {
      end = first.end;
      break;
    }
    const stopped = noVerdict(lane, first.ran);
    if (stopped !== null) {
      end = stopped;
      break;
    }
    let result: JourneyRun;
    if (!isRed(first.ran.verdict)) result = counted(lane, first.ran, false);
    else {
      // Red: its class persisted first (a journey lane has no repeat class: its runs carry no reuse identity), then the
      // red-lane protocol, with at most one rerun under its own reservation.
      const red = first.ran;
      const cls = classifyRed(red.evidence, null);
      writeRedClass(red.dir, cls, failureOf(ctx.runDir, red.inv, red.verdict, red.exitCode, checkout.path).failure, owner.type === 'unit' ? owner.parent.unit : undefined);
      const again = await redLane<JourneyRan, JourneyEnd>(cls, async () => {
        const next = await attempt(lane);
        if (next.kind === 'ended') return { kind: 'ended', end: next.end };
        const none = noVerdict(lane, next.ran);
        if (none !== null) return { kind: 'ended', end: none };
        return { kind: 'ran', run: next.ran, verdict: { red: isRed(next.ran.verdict), evidence: next.ran.evidence } };
      }, { sample: sampleHost, signal });
      if (again.kind === 'repeat') throw new Error(`journey lane ${lane.def.id}: a repeat class without a repeat`);
      if (again.kind === 'ended') {
        end = again.end;
        break;
      }
      if (again.kind === 'interrupted') {
        end = again;
        break;
      }
      if (again.kind === 'blocked') {
        end = { kind: 'blocked', lane: lane.def.id, detail: again.detail };
        break;
      }
      if (again.verdict.kind === 'blocked') {
        end = { kind: 'blocked', lane: lane.def.id, detail: again.verdict.detail };
        break;
      }
      // After a host-signature rerun the rerun counts; after a diagnostic rerun the first run does (red, flaky when the rerun
      // passed), unless the flaky ledger forgave the flake (dev.17; a unit's own is its red, dev.21): then the rerun counts.
      const flaky = again.reason === 'diagnostic' && again.verdict.kind === 'red' && again.verdict.flaky;
      const forgiven = flaky && observeFlake(ctx, owner.type === 'unit' ? { type: 'unit', unit: owner.parent.unit } : { type: 'job', job: owner.job }, lane.def.id,
        lane.witness === null ? 'suite' : 'arc', flakeOn(ctx, owner.type === 'unit' ? owner.parent : null, at), journeyFlake(ctx, lane, treeSha, red, again.rerun));
      result = again.reason === 'host-signature' || forgiven ? counted(lane, again.rerun, forgiven) : counted(lane, first.ran, flaky);
    }
    runs.push(result);
    if (opts.stop(result)) break;
  }
  if (lastEvidence === null) return { end, runs, treeSha, checkout: null };
  // The checkout's integrity: what the lanes tested must be the commit itself.
  const dirty = dirtyPaths(checkout.path);
  const head = revParse(checkout.path, 'HEAD');
  const seriesRoot = owner.type === 'unit' ? absPath(join(evidenceRoot(ctx.runDir, owner.parent), 'journey')) : jobEvidenceRoot(ctx.runDir, owner.job);
  const dirtyAt = absPath(join(seriesRoot, `_dirty-${basename(checkout.path)}`));
  let evidence: OpId = lastEvidence;
  if (dirty.length > 0) {
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${who}`, parent, { source: checkout.path, ...namedPathGlobs(checkout.path, dirty), dest: dirtyAt })).op;
  }
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), worktreeKey, parent, { path: checkout.path, evidence: capturedEvidence(ctx.journal.view, evidence) });
  if (dirty.length === 0 && head === at && end.kind !== 'blocked') {
    // Clean, still the commit, and removed: the series' observations may be reused (R51).
    crashPoint('lanes.after-census-before-certified', owner.type === 'unit' ? owner.parent.unit : undefined);
    ctx.journal.fact({ kind: 'series-certified', parent, checkout: checkout.path, at });
  }
  return { end, runs, treeSha, checkout: { dirty, movedTo: head === at ? null : head, evidence: dirtyAt } };
}

/**
 * dev.17: a journey lane's flake (red run `red`, green rerun `green`) as the flaky ledger records it: the lane's input and
 * environment, and the tests an arc lane's reporter named failing in the red run.
 */
function journeyFlake(ctx: JourneyContext, lane: JourneyLane, treeSha: Sha, red: JourneyRan, green: JourneyRan): FlakyEvent {
  const map = mapInForce(ctx.journal.view);
  if (lane.witness === null) {
    return { tree: inputShaOf(ctx.repo, treeSha, lane.def, map), env: laneIdentity(ctx, lane.def).identity.envId, failing: [], red: red.inv, green: green.inv };
  }
  const env = laneEnvId(ctx, lane.witness);
  const tests = collectWitness(lane.witness.reporter, {
    witnessFile: absPath(join(red.dir, WITNESS_LINES)), stdoutFile: absPath(join(invocationDir(ctx.runDir, red.inv), STDOUT_FILE)),
  }) ?? [];
  return { tree: arcLaneKey(ctx, treeSha, lane.witness, env).inputSha, env, failing: tests.filter((t) => t.outcome === 'fail').map((t) => t.testId), red: red.inv, green: green.inv };
}

/** Whether a journey run counts as red (failed or stalled); a reused observation has no verdict of its own. */
export const journeyRed = (r: JourneyRun): boolean => r.verdict !== null && isRed(r.verdict);
