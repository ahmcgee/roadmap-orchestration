// Lane execution (plan "Pipeline", lanes and candidate rows; DESIGN-1.0.md §4 Verification, Lanes): the
// executor runs a series of lanes serially, verbatim, under their reservations, in a clean detached
// checkout, fast lanes before estate lanes, and keeps one evidence dir per lane. The same series runs a
// unit's spec lanes at the salvage SHA (set `spec`, the lanes stage) and the plan's suite on the candidate
// merge and on the integration tip alone (set `suite`, the candidate stage). Arc lanes (M3) run as a journey series
// (`runJourneySeries`, at the end of this file) under the same rules.
//
// Per lane: acquire its reservation (its declared resources and its `@cpu` tokens,
// `laneCpu`) through the stage's `acquire` (`LaneRuntime`) → occupancy probe → run (step 10's cycle) → `invoke`
// purpose `lane` with the exact argv, cwd and env (plus the unit's owner label and the holder's pool instance
// binding, `instanceEnv`, F7) → evidence snapshots → cleanup. The host is sampled at the lane's start and end
// into `<lane>/host.json`. The series stops at the first lane that does not pass: one failure is what a fix
// round needs, and nothing after it is spent. A wait for a lane's reservation that the stage's signal
// cancels (pause, stop) ends the series `interrupted`.
//
// A lane that runs red goes through the red-lane protocol (redlane.ts): a host signature on a busy host
// waits, holding nothing, for a clear host and reruns; a signature without that evidence is `blocked`; a spec lane's
// red repeating the unit's confirmed earlier red (`repeatOf`) is red without a rerun; any other red gets one diagnostic
// rerun (red then green is red, `flaky`). The class is persisted (`red.json`) before the decision. A rerun takes its own reservation,
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
// Lane reuse (M4a rev 3, F1a, R52): a spec series consults `reusablePass` before each lane. The unit's latest earlier
// execution of the lane is reused, not run, when it passed (not flaky, not a repeat), its spawn's identity
// (`LaneIdentity`: the normalised lane rev, the environment id, argv[0]'s resolved path and content hash) equals the
// lane's now, its series is certified, and it ran at this SHA, or the lane is fast, declares `inputs`, and the diff
// between the two SHAs touches none of them. An estate lane, and a lane whose argv[0] is a repository file, reuse only
// at the same SHA; an argv[0] that resolves nowhere never reuses. A reused lane records `lane-reused` and is skipped;
// its ledger entry is the earlier execution's record with `reused` set. A series whose every lane is reused still
// creates its verification checkout (the gate's cwd) and certifies it.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, matchesGlob } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, LaneIdentity, Parent, WitnessFor } from '../core/events.ts';
import {
  type EnvId, type InvocationId, type JobId, type LaneId, type LaneRev, type OpId, type ResourceInstance, type ResourceUnit, type Sha, type UnitId,
  invocationDirName, invocationId, laneRev, opKey, parseInvocationId, parseOpId, sha256,
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { HOST_SIGNATURES_DEV6 } from '../core/upgrade.ts';
import { type ObservationStore, type WitnessedEntry, keyOf, observationOf, observationStore, reuse, verdictOf } from '../holistic/observe.ts';
import { type ArcLaneDef, type ObligationDef, type Obligations, type WitnessRecord, isExempt, laneRevOf } from '../holistic/types.ts';
import { WITNESS_LINES, WITNESS_RECORD_FILE, collectWitness, envIdOf, hostIdentity, witnessEnv, witnessRecordOf, writeWitnessRecord } from '../holistic/witness.ts';
import { git, revParse } from '../git/git.ts';
import { candidateLaneDir, jobEvidenceRoot, jobLaneDir, witnessDir } from '../git/snapshot.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import { exclusivePublish, canonicalJson as fileJson, readJson } from '../core/fsx.ts';
import {
  type CommandVerdict, type IgnoredCensus, type LaneDef, type RedRev, type SpecM1, STDERR_FILE, STDOUT_FILE, type NeedsUserContent, ignoredCensus,
} from '../core/records.ts';
import { type AbsPath, type IsoTime, type RepoPath, type RepoPattern, absPath, isoTimeOf, repoPattern } from '../core/values.ts';
import { type EvidenceManifest, FILES_DIR, capturedEvidence, manifestPath, pathPattern, patternPath, readManifest } from '../git/evidence.ts';
import { ignoredWrites, planIgnored } from '../git/ignored.ts';
import { statusPorcelainV2Z } from '../git/git.ts';
import type { WorktreeCreateRequest } from '../git/worktree.ts';
import { type HostSample, readHostSample } from '../host/sample.ts';
import { HOST_SIGNATURES, HOST_SIGNATURES_REV, type HostSignatureId, outputSignatures, outputTail } from '../host/signatures.ts';
import { type Argv0, resolveArgv0 } from '../preflight/argv0.ts';
import type { LaneLedgerEntry, ObligationView } from '../prompts/inputs.ts';
import { instanceEnv, laneCpu, requestOf } from '../resources/pool.ts';
import { probe } from '../resources/probe.ts';
import {
  type JobHolder, type Reservation, type ResourceContext, type SpecLane, type StageHolder, cleanup, heldReservation, jobOwnerLabel, reserve, run,
} from '../resources/reserve.ts';
import { OWNER_ENV, ownerLabel } from '../resources/teardown.ts';
import { runnerFiles } from '../runner/files.ts';
import type { Acquire, Rank, ResourceRequest } from '../schedule/types.ts';
import { type StageContext, type StageParent, evidenceRoot, runOp } from './dispatch.ts';
import { invocationDir, invoke } from './invoke.ts';
import {
  type FailureSignature, type LaneCancel, type LaneHost, type RedClass, type RedEvidence, type RepeatOf, classifyRed, failureSignature, hostWasBusy,
  laneAbortReason, readRedClass, redLane, writeRedClass,
} from './redlane.ts';
import { evidenceSnapshotOp, worktreeCreateOp, worktreeRemoveOp } from '../recover/ops.ts';

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
 * read with `HOST_SIGNATURES_DEV6`).
 */
export type LaneRun = LaneLedgerEntry & Readonly<{
  inv: InvocationId; at: IsoTime; endedAt: IsoTime; fixDirs: readonly AbsPath[]; host: LaneHost | null; signatures: readonly HostSignatureId[];
  redRev: RedRev | null;
}>;

/** A red run whose output carried a host signature (F3): the signatures, and whether its host samples showed a busy host. */
export type HostSuspected = Readonly<{ signatures: readonly HostSignatureId[]; busy: boolean }>;

/**
 * One lane of a series: the run whose verdict counts, and the other run of a red lane (redlane.ts). After a
 * host-signature rerun the record is the rerun and `voided` the first run; after a diagnostic rerun it is the
 * first run and `diagnostic` the rerun; `flaky`: red, then green on the diagnostic rerun. `repeat`: a red that
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

/** What a lane reserves: its declared resources and its `@cpu` tokens; null when nothing. */
export function laneRequest(ctx: ResourceContext, lane: LaneDef): ResourceRequest | null {
  const cpu = laneCpu(lane);
  return lane.resources.length === 0 && cpu === 0 ? null : requestOf(ctx.plan(), lane.resources, cpu);
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
    lane: lane.id, argv: lane.argv, expectedExit: lane.expectedExit, exitCode: result?.exitCode ?? null, verdict, evidenceDir: dir,
    ignored: readCensus(dir), inv, at, endedAt: files.read('exit.json')?.endedAt ?? at, fixDirs: fixDirsOf(dir, lane),
    host: readLaneHost(dir), signatures: isRed(verdict) ? outputSignatures([join(invDir, STDOUT_FILE), join(invDir, STDERR_FILE)], redRev === null ? HOST_SIGNATURES_DEV6 : HOST_SIGNATURES) : [],
    // A run's own record; a reused lane's ledger entry sets it (`reusedRecord`).
    reused: null, redRev,
  };
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

/** A lane's record from its first run and its rerun, if any: the reading `redLane` made live (redlane.ts). */
function laneRecord(first: LaneRun, rerun: LaneRun | null): LaneRecord {
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
// Lane identity, history and reuse (M4a rev 3, F1a, F2)

/** A spec lane's reuse identity on this host now (R52), with argv[0] as it resolves. */
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

/** The identity a lane spawn was stamped with; null for an unstamped (1.0.0-dev.6) or suite lane run. */
function spawnIdentity(view: JournalView, inv: InvocationId): LaneIdentity | null {
  const intent = view.latestIntent(parseInvocationId(inv).op);
  if (intent.kind !== 'proc.spawn' || intent.expect.subject.purpose !== 'lane') throw new Error(`${inv} is no lane spawn`);
  return intent.expect.subject.identity ?? null;
}

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

/** The spec lane spawns of `unit`'s lane `lane` in series `parent` at `at` (the first run, then its rerun). */
function laneSpawns(view: JournalView, parent: StageParent, lane: LaneId, at: Sha): readonly IntentOf<'proc.spawn'>[] {
  return view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'lane' && s.set === 'spec' && s.lane === lane && s.at === at && sameParent(i.parent, parent);
  });
}

/** The record of a series' runs of `lane` (its first run and its rerun, if any), as the series combined them. */
function spawnRecord(ctx: StageContext, parent: StageParent, lane: LaneDef, spawns: readonly IntentOf<'proc.spawn'>[], root: AbsPath): LaneRecord {
  const [first, rerun, ...more] = spawns;
  if (first === undefined) throw new Error(`lane ${lane.id}: no spawn`);
  if (more.length > 0) throw new Error(`lane ${lane.id} ran ${spawns.length} times in series ${parent.unit} ${parent.stage}#${parent.attempt}; a lane runs at most twice`);
  return laneRecord(laneRun(ctx, first, lane, laneDir(root, lane, 'first')), rerun === undefined ? null : laneRun(ctx, rerun, lane, laneDir(root, lane, 'rerun')));
}

/** A reused lane's ledger entry: the execution `from` names, read back from its series, with `reused` set. */
function reusedRecord(ctx: StageContext, from: Readonly<{ parent: Parent; inv: InvocationId; at: Sha }>, lane: LaneDef): LaneRecord {
  const execution = stageParentOf(from.parent);
  const record = spawnRecord(ctx, execution, lane, laneSpawns(ctx.journal.view, execution, lane.id, from.at), specSeriesRoot(ctx.runDir, execution));
  if (record.inv !== from.inv) throw new Error(`lane ${lane.id} reused ${from.inv}, but its series counted ${record.inv}`);
  return { ...record, reused: { at: from.at, inv: from.inv } };
}

/**
 * The unit's spec lane `lane` across its series other than `exclude`, in log order: each series that ran it (every
 * spawn of it done; a series a crash cut short mid-lane is unknown and left out) and each that reused it.
 */
function laneHistory(ctx: StageContext, unit: UnitId, lane: LaneDef, exclude: StageParent): readonly LaneHistoryEntry[] {
  const view = ctx.journal.view;
  const groups = new Map<string, IntentOf<'proc.spawn'>[]>();
  for (const i of view.opsOf('proc.spawn')) {
    const s = i.expect.subject;
    if (s.purpose !== 'lane' || s.set !== 'spec' || s.unit !== unit || s.lane !== lane.id || sameParent(i.parent, exclude)) continue;
    const key = canonicalJson([i.parent, s.at]);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const ran: LaneHistoryEntry[] = [...groups.values()].flatMap((spawns) => {
    if (spawns.some((i) => view.doneOf(i.op) === null)) return [];
    const first = spawns[0]!;
    const s = first.expect.subject;
    if (s.purpose !== 'lane') throw new Error(`${first.op}: not a lane spawn`);
    const parent = stageParentOf(first.parent);
    const record = spawnRecord(ctx, parent, lane, spawns, specSeriesRoot(ctx.runDir, parent));
    return [{ seq: parseOpId(first.op).seq, parent, execution: parent, at: s.at, record, reused: false }];
  });
  const reused: LaneHistoryEntry[] = view.holistic().laneReuses
    .filter((r) => r.lane === lane.id && r.parent.type === 'stage' && r.parent.unit === unit && !sameParent(r.parent, exclude))
    .map((r) => ({ seq: r.seq, parent: stageParentOf(r.parent), execution: stageParentOf(r.from.parent), at: r.from.at, record: reusedRecord(ctx, r.from, lane), reused: true }));
  return [...ran, ...reused].sort((a, b) => a.seq - b.seq);
}

/** Whether the diff between two commits touches any of `patterns`. */
function touches(repo: AbsPath, from: Sha, to: Sha, patterns: readonly RepoPattern[]): boolean {
  const paths = git(repo, ['diff', '--name-only', '--no-renames', '-z', from, to]).split('\0').filter((p) => p !== '');
  return paths.some((p) => patterns.some((g) => matchesGlob(p, g)));
}

/**
 * The unit's latest earlier execution of spec lane `lane`, when series `parent` may reuse it at `at` (F1a, R52): a pass
 * (not flaky, not a repeat) whose spawn's identity equals `now`, in a certified series, at this SHA, or (a fast lane
 * declaring `inputs`, argv[0] a resolved program) at a SHA whose diff to this one touches none of its inputs.
 */
export function reusablePass(
  ctx: StageContext, parent: StageParent, lane: LaneDef, at: Sha, now: Readonly<{ identity: LaneIdentity; argv0: Argv0 }>,
): Readonly<{ from: Readonly<{ parent: StageParent; inv: InvocationId; at: Sha }>; record: LaneRecord }> | null {
  if (now.argv0.kind === 'not-found') return null;
  const latest = laneHistory(ctx, parent.unit, lane, parent).at(-1);
  if (latest === undefined) return null;
  const { record } = latest;
  if (record.verdict !== 'pass' || record.flaky || record.repeat !== null) return null;
  const was = spawnIdentity(ctx.journal.view, record.inv);
  if (was === null || canonicalJson(was) !== canonicalJson(now.identity)) return null;
  if (!certifiedRun(ctx, record.inv)) return null;
  if (latest.at !== at) {
    if (lane.tier !== 'fast' || lane.inputs === undefined || now.argv0.kind !== 'program' || touches(ctx.repo, latest.at, at, lane.inputs)) return null;
  }
  return { from: { parent: latest.execution, inv: record.inv, at: latest.at }, record: { ...record, reused: { at: latest.at, inv: record.inv } } };
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
 * `witnessed{purpose: witness}` fact: a journey lane's run, or a candidate suite lane that ran as the arc lane (F6).
 */
function keepWitness(
  ctx: Readonly<{ journal: StageContext['journal']; runDir: AbsPath; hostEnv: Readonly<Record<string, string | undefined>> }>,
  lane: ArcLaneDef, inv: InvocationId, dir: AbsPath, treeSha: Sha, forWhom: WitnessFor,
): WitnessRecord {
  const tests = collectWitness(lane.reporter, { witnessFile: absPath(join(dir, WITNESS_LINES)), stdoutFile: absPath(join(invocationDir(ctx.runDir, inv), STDOUT_FILE)) });
  const record = witnessRecordOf({ lane, envId: laneEnvId(ctx, lane), treeSha, inv, purpose: 'witness' }, tests);
  const recordsSha256 = writeWitnessRecord(dir, record);
  ctx.journal.fact({ kind: 'witnessed', lane: record.lane, laneRev: record.laneRev, envId: record.envId, treeSha, inv, recordsSha256, purpose: 'witness', for: forWhom });
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
 * One run of `lane`, its spawn stamped with `redRev` and (a spec lane) its reuse `identity`. `witness`: the arc lane a
 * candidate suite lane also runs as (F6): its reporter's env is added, writing where its witness record is kept.
 */
async function runLane(
  ctx: StageContext, parent: StageParent, lane: LaneDef, set: LaneSet, tree: AbsPath, at: Sha, dir: AbsPath, held: readonly ResourceUnit[],
  sampleHost: () => HostSample, identity: LaneIdentity | null, witness: ArcLaneDef | null,
): Promise<Ran> {
  const start = sampleHost();
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    origin: { type: 'new', key: opKey(`lane:${parent.unit}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
    subject: { purpose: 'lane', unit: parent.unit, lane: lane.id, set, at, redRev: HOST_SIGNATURES_REV, ...(identity === null ? {} : { identity }) },
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
        argv: lane.argv, cwd: absPath(join(tree, lane.cwd)), env: { ...env, ...extra }, stdinPath: null, stallMs: LANE_STALL_MS, graceMs: LANE_GRACE_MS,
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
 * `checkout` names, created just before the first lane that runs, keeping evidence under `root`. A spec series
 * reuses a lane's earlier pass where `reusablePass` allows. The caller records the stage outcome; the checkout stays
 * for the caller to keep or remove, certified when it was still clean. `entered`: the stage already holds the first
 * lane's set (`seriesEntry`), reserved, so its first run takes no reservation of its own (released unused when the
 * first lane is reused). `witnesses`: a candidate's suite lanes that also run as an identical arc lane (F6), by id.
 */
export async function runLaneSeries(
  ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], set: LaneSet, checkout: WorktreeCreateRequest, root: AbsPath,
  rt: LaneRuntime, entered: boolean, witnesses: ReadonlyMap<LaneId, ArcLaneDef> = new Map(),
): Promise<Series> {
  if (checkout.checkout.type !== 'detached') throw new Error(`a lane series runs in a detached checkout, not on ${checkout.checkout.branch}`);
  const ids = new Set<string>(lanes.map((l) => l.id));
  for (const id of ids) if (ids.has(`${id}${RERUN_SUFFIX}`)) throw new Error(`lanes ${id} and ${id}${RERUN_SUFFIX} of ${parent.unit}: the second's dir is the first's rerun dir`);
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

  const attempt = async (lane: LaneDef, which: Which, identity: LaneIdentity | null): Promise<Attempt> => {
    const request = laneRequest(ctx, lane);
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
      held = run(ctx, reserved, parent);
    }
    if (last.evidence === null) await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, checkout);
    const ran = await runLane(ctx, parent, lane, set, path, at, laneDir(root, lane, which), held?.resources ?? [], rt.sampleHost, identity, witnesses.get(lane.id) ?? null);
    last.evidence = ran.evidence;
    if (held !== null) {
      const cleaned = await cleanup(ctx, held, parent);
      if (cleaned.kind === 'cleanup-failed') return { kind: 'ended', end: { kind: 'cleanup-failed', failed: cleaned.failed }, ran };
    }
    return { kind: 'ran', ran };
  };

  for (const lane of lanes) {
    const now = set === 'spec' ? laneIdentity(ctx, lane) : null;
    const reusable = now === null ? null : reusablePass(ctx, parent, lane, at, now);
    if (reusable !== null) {
      // The stage's entry reservation was the first lane's: unused, it is released before the next lane takes its own.
      if (entry) {
        entry = false;
        const cleaned = await cleanup(ctx, heldReservation(ctx, holder, 'reserved'), parent);
        if (cleaned.kind === 'cleanup-failed') {
          end = { kind: 'cleanup-failed', failed: cleaned.failed };
          break;
        }
      }
      ctx.journal.fact({ kind: 'lane-reused', parent, lane: lane.id, from: reusable.from });
      crashPoint('lanes.after-reused', parent.unit);
      ledger.push(reusable.record);
      continue;
    }
    const identity = now?.identity ?? null;
    const first = await attempt(lane, 'first', identity);
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
    const repeat = identity !== null && failure.specific ? repeatOf(ctx, parent, lane, identity, failure.failure) : null;
    const cls = classifyRed(evidenceOf(red), repeat);
    writeRedClass(red.evidenceDir, cls, failure.failure, parent.unit);
    const rerun: { ran: Ran | null } = { ran: null };
    const result = await redLane<Ran, SeriesEnd>(cls, async () => {
      const again = await attempt(lane, 'rerun', identity);
      rerun.ran = again.ran;
      if (again.kind === 'ended') return { kind: 'ended', end: again.end };
      const ended = runEnd(again.ran);
      if (ended !== null) return { kind: 'ended', end: ended };
      return { kind: 'ran', run: again.ran, verdict: { red: isRed(again.ran.record.verdict), evidence: evidenceOf(again.ran.record) } };
    }, { sample: rt.sampleHost, signal: rt.signal });
    const record = laneRecord(red, rerun.ran?.record ?? null);
    ledger.push(record);
    if ((result.kind === 'reran' && result.verdict.kind !== 'blocked') || result.kind === 'repeat') witnessCounted(lane, record);
    if (result.kind === 'reran' && result.verdict.kind === 'pass') continue;
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
    if (end.kind !== 'green' || ledger.length === 0) return { end, ledger, tree: null, dirty: [] };
    // Every lane reused (F1a, Q3): the gate still reads a checkout of the commit, made and certified as any series'.
    // `_reused` cannot collide with a lane id, which starts with a letter.
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
      source: path, globs: dirty.map(pathPattern), dest: dirtyDir(root),
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

/**
 * The stage attempt of the unit's latest series of `set` that ran a lane, or (a spec series, F1a) reused one; null when
 * none did.
 */
export function latestSeries(view: JournalView, unit: UnitId, set: LaneSet): StageParent | null {
  let latest: Readonly<{ seq: number; parent: StageParent }> | null = null;
  for (const { op, expect: { subject: s }, parent } of view.opsOf('proc.spawn')) {
    if (s.purpose === 'lane' && s.unit === unit && s.set === set && parent.type === 'stage') latest = { seq: parseOpId(op).seq, parent };
  }
  if (set === 'spec') {
    for (const r of view.holistic().laneReuses) {
      if (r.parent.type === 'stage' && r.parent.unit === unit && (latest === null || r.seq > latest.seq)) latest = { seq: r.seq, parent: r.parent };
    }
  }
  return latest?.parent ?? null;
}

/**
 * The ledger of the series `parent` ran at commit `at` with evidence under `root`, in order (a candidate
 * attempt runs two: on the candidate, then on the integration tip alone), one record per lane: its first
 * run and its rerun, if any, combined as the series combined them, or (a spec series, F1a) the earlier execution it
 * reused, read back from that execution's series. `lanes` hold the definitions it ran, found by id.
 */
export function seriesLedger(ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], at: Sha, root: AbsPath): readonly LaneRecord[] {
  const defOf = (id: LaneId, by: string): LaneDef => {
    const lane = lanes.find((l) => l.id === id);
    if (lane === undefined) throw new Error(`lane ${id} of ${by} is not among the lanes given`);
    return lane;
  };
  const runs = new Map<LaneId, IntentOf<'proc.spawn'>[]>();
  for (const intent of ctx.journal.view.opsOf('proc.spawn')) {
    const s = intent.expect.subject;
    if (s.purpose !== 'lane' || s.at !== at || !sameParent(intent.parent, parent)) continue;
    runs.set(s.lane, [...(runs.get(s.lane) ?? []), intent]);
  }
  const ran = [...runs].map(([id, spawns]) => ({ seq: parseOpId(spawns[0]!.op).seq, record: spawnRecord(ctx, parent, defOf(id, spawns[0]!.op), spawns, root) }));
  const reused = ctx.journal.view.holistic().laneReuses.filter((r) => sameParent(r.parent, parent))
    .map((r) => ({ seq: r.seq, record: reusedRecord(ctx, r.from, defOf(r.lane, `lane-reused seq ${r.seq}`)) }));
  return [...ran, ...reused].sort((a, b) => a.seq - b.seq).map((e) => e.record);
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
 * Whether a suite lane and an arc lane are one execution (F6, R63): the same argv, cwd, declared env and expected exit,
 * so on the same tree the arc lane's run (with its reporter's env added) is the suite lane's run.
 */
export function sameExecution(suite: LaneDef, arc: ArcLaneDef): boolean {
  const shape = (l: LaneDef): string => canonicalJson({ argv: l.argv, cwd: l.cwd, set: l.env.set, pass: [...l.env.pass].sort(), expectedExit: l.expectedExit });
  return shape(suite) === shape(arc);
}

/** Each suite lane's identical arc lane among `arc` (the first, by `sameExecution`), by suite lane id. */
export function suiteStandIns(suite: readonly LaneDef[], arc: readonly ArcLaneDef[]): ReadonlyMap<LaneId, ArcLaneDef> {
  return new Map(suite.flatMap((s) => {
    const a = arc.find((l) => sameExecution(s, l));
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
  const removed = new Set(view.opsOf('worktree.remove').filter((i) => view.doneOf(i.op) !== null).map((i) => i.expect.path));
  for (const c of view.opsOf('worktree.create').filter((i) => same(i.parent) && view.doneOf(i.op) !== null && !removed.has(i.expect.path))) {
    let evidence = view.opsOf('evidence.snapshot').filter((i) => same(i.parent) && view.doneOf(i.op) !== null).at(-1)?.op;
    if (evidence === undefined) {
      evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${job}`, parent, {
        source: c.expect.path, globs: [], dest: absPath(join(jobEvidenceRoot(ctx.runDir, job), '_leftover')),
      })).op;
    }
    await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${job}`, parent, { path: c.expect.path, evidence: capturedEvidence(ctx.journal.view, evidence) });
  }
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
    const found = lane === undefined ? null : reuse(store, keyOf(tree, lane, laneEnvId(ctx, lane)));
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
      origin: { type: 'new', key: opKey(`lane:${who}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
      subject: {
        purpose: 'journey', lane: lane.def.id, laneRev: lane.laneRev, at, owner: owner.type === 'unit' ? { type: 'unit', unit: owner.parent.unit } : { type: 'job', job: owner.job },
        redRev: HOST_SIGNATURES_REV,
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
    const interrupted = outcome.result.verdict === 'cancelled' ? outcome.result.reason : null;
    const blocked = verdict === 'process-fault' ? `${outcome.inv} ended by ${runnerFiles(invDir, outcome.inv).read('exit.json')?.cause ?? 'unknown'}` : null;
    const signatures = isRed(verdict) ? outputSignatures([join(invDir, STDOUT_FILE), join(invDir, STDERR_FILE)]) : [];
    return { inv: outcome.inv, dir, verdict, exitCode: outcome.result.exitCode, evidence: { signatures, host }, interrupted, blocked, evidenceOp };
  };

  const attempt = async (lane: JourneyLane): Promise<JourneyAttempt> => {
    const request = laneRequest(ctx, lane.def);
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
      held = run(ctx, reserved, parent);
    }
    if (lastEvidence === null) await runOp(ctx.journal, worktreeCreateOp(ctx.repo), worktreeKey, parent, checkout);
    const ran = await runOne(lane, held?.resources ?? []);
    lastEvidence = ran.evidenceOp;
    if (held !== null) {
      const cleaned = await cleanup(ctx, held, parent);
      if (cleaned.kind === 'cleanup-failed') return { kind: 'ended', end: { kind: 'cleanup-failed', failed: cleaned.failed }, ran };
    }
    return { kind: 'ran', ran };
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
      const o = reuse(store, keyOf(treeSha, lane.witness, laneEnvId(ctx, lane.witness)));
      if (o !== null) {
        runs.push({ lane: lane.def.id, inv: null, verdict: null, flaky: false, dir: null, record: o.record });
        continue;
      }
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
      // After a host-signature rerun the rerun counts; after a diagnostic rerun the first run does (red, flaky when the rerun passed).
      result = again.reason === 'host-signature' ? counted(lane, again.rerun, false) : counted(lane, first.ran, again.verdict.kind === 'red' && again.verdict.flaky);
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
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${who}`, parent, { source: checkout.path, globs: dirty.map(pathPattern), dest: dirtyAt })).op;
  }
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), worktreeKey, parent, { path: checkout.path, evidence: capturedEvidence(ctx.journal.view, evidence) });
  if (dirty.length === 0 && head === at && end.kind !== 'blocked') {
    // Clean, still the commit, and removed: the series' observations may be reused (R51).
    crashPoint('lanes.after-census-before-certified', owner.type === 'unit' ? owner.parent.unit : undefined);
    ctx.journal.fact({ kind: 'series-certified', parent, checkout: checkout.path, at });
  }
  return { end, runs, treeSha, checkout: { dirty, movedTo: head === at ? null : head, evidence: dirtyAt } };
}

/** Whether a journey run counts as red (failed or stalled); a reused observation has no verdict of its own. */
export const journeyRed = (r: JourneyRun): boolean => r.verdict !== null && isRed(r.verdict);
