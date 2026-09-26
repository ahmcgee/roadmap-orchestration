// Lane execution (plan "Pipeline", lanes and candidate rows; DESIGN-1.0.md §4 Verification, Lanes): the
// executor runs a series of lanes serially, verbatim, under their reservations, in a clean detached
// checkout, fast lanes before estate lanes, and keeps one evidence dir per lane. The same series runs a
// unit's spec lanes at the salvage SHA (set `spec`, the lanes stage) and the plan's suite on the candidate
// merge and on the integration tip alone (set `suite`, the candidate stage).
//
// Per lane: reserve its declared resources → occupancy probe → run (step 10's cycle) → `invoke` purpose
// `lane` with the exact argv, cwd and env (plus the unit's owner label) → evidence snapshots → cleanup.
// The series stops at the first lane that does not pass: one failure is what a fix round needs, and
// nothing after it is spent. The checkout is created just before the first lane runs, so a series that
// ends before any lane ran leaves no tree behind.
//
// After the series the checkout must still be clean: a lane that wrote a tracked or unignored file into
// it is never certified under a SHA (`dirty`). The dirty paths are snapshotted before anything removes the
// tree. The checkout is removed with `worktree.remove`, which cites a done evidence snapshot of this series.
//
// Everything a later stage needs from a series (its ledger, its checkout, its dirty paths) is read back
// from the journal and the invocation files (`seriesLedger`, `seriesTree`, `seriesDirty`), never kept in
// memory, so a restarted executor sees the series exactly as it ran.
import { join } from 'node:path';
import type { IntentOf } from '../core/events.ts';
import { type InvocationId, type OpId, type Sha, type UnitId, invocationId, opKey } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { type CommandVerdict, type LaneDef, type SpecM1, STDERR_FILE, STDOUT_FILE, type NeedsUserContent } from '../core/records.ts';
import { type AbsPath, type IsoTime, type RepoPath, absPath, isoTimeOf, repoPath, repoPattern } from '../core/values.ts';
import { FILES_DIR, capturedEvidence, evidenceSnapshotOp } from '../git/evidence.ts';
import { statusPorcelainV2Z } from '../git/git.ts';
import { type WorktreeCreateRequest, worktreeCreateOp, worktreeRemoveOp } from '../git/worktree.ts';
import type { LaneLedgerEntry } from '../prompts/inputs.ts';
import { probe } from '../resources/probe.ts';
import { type SpecLane, cleanup, reserve, run } from '../resources/reserve.ts';
import { OWNER_ENV, ownerLabel } from '../resources/teardown.ts';
import { runnerFiles } from '../runner/files.ts';
import { type StageContext, type StageParent, cancelledFor, evidenceRoot, runOp } from './dispatch.ts';
import { invocationDir, invoke } from './invoke.ts';

/** A lane's deadline. Default, unmeasured: lane durations are measured per invocation from arc 2 on. */
export const LANE_DEADLINE_MS = 30 * 60_000;
const LANE_GRACE_MS = 5_000;

/**
 * One lane the executor ran: what the gate reads (`LaneLedgerEntry`, whose `evidenceDir` holds every
 * snapshot of the lane), plus its invocation, its times, and `fixDirs`: the snapshot `files` dirs a fix
 * round reads, the lane's stdout and stderr first, then its declared outputs.
 */
export type LaneRecord = LaneLedgerEntry & Readonly<{ inv: InvocationId; at: IsoTime; endedAt: IsoTime; fixDirs: readonly AbsPath[] }>;

/** A series' checkout, and the done evidence snapshot its removal cites. */
export type VerificationTree = Readonly<{ path: AbsPath; at: Sha; evidence: OpId }>;

/** Which lanes a series runs: the unit's spec lanes, or the plan's executor-only suite. */
export type LaneSet = 'spec' | 'suite';

export type SeriesEnd =
  | Readonly<{ kind: 'green' }>
  | Readonly<{ kind: 'red'; lane: LaneRecord }>
  /** Ended by its runner (deadline) or lost with it: no product verdict. */
  | Readonly<{ kind: 'blocked'; lane: LaneRecord | null; detail: string }>
  | Readonly<{ kind: 'interrupted'; reason: 'pause' | 'stop' }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly string[] }>;

export type Series = Readonly<{
  end: SeriesEnd;
  /** Every lane that ran, in order. */
  ledger: readonly LaneRecord[];
  /** null when no lane ran. */
  tree: VerificationTree | null;
  /** Paths the lanes left dirty in the checkout; non-empty means not certified. */
  dirty: readonly RepoPath[];
}>;

/** Fast lanes first, then estate; declared order within a tier. */
export function seriesOrder<L extends LaneDef>(lanes: readonly L[]): readonly L[] {
  return [...lanes.filter((l) => l.tier === 'fast'), ...lanes.filter((l) => l.tier === 'estate')];
}

/** The spec's series: struck and deferred lanes do not run. */
export function laneOrder(spec: SpecM1): readonly SpecLane[] {
  return seriesOrder(spec.lanes.filter((l) => l.state === 'active'));
}

/** The lane's declared env verbatim (`set`, and `pass` copied from the host), plus the unit's owner label. */
export function laneEnv(ctx: StageContext, unit: UnitId, lane: LaneDef): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...lane.env.set };
  for (const name of lane.env.pass) {
    const value = ctx.hostEnv[name];
    // Startup refuses a lane whose declared variable the host lacks (spec-lane-unrunnable).
    if (value === undefined) throw new Error(`lane ${lane.id} passes ${name}, which the executor's environment lacks`);
    env[name] = value;
  }
  if (Object.hasOwn(env, OWNER_ENV)) throw new Error(`lane ${lane.id} declares ${OWNER_ENV}, which the executor sets`);
  env[OWNER_ENV] = ownerLabel(ctx.plan.arc, unit);
  return env;
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

/** A lane's dir under its series' evidence root, and the snapshot dirs a fix round reads from it. */
function laneDirs(root: AbsPath, lane: LaneDef): Readonly<{ dir: AbsPath; fixDirs: readonly AbsPath[] }> {
  const dir = absPath(join(root, lane.id));
  const fixDirs = [absPath(join(dir, 'output', FILES_DIR))];
  if (lane.evidenceGlobs.length > 0) fixDirs.push(absPath(join(dir, 'tree', FILES_DIR)));
  return { dir, fixDirs };
}

/**
 * A lane's record, read from its spawn and invocation files: what ran (the definition), how it ended
 * (result.json, or none when lost with its runner), when (a lane's deadline is its start plus
 * LANE_DEADLINE_MS, so launch.json carries the start; exit.json the end). The live series and every later
 * reader build records here, so they are the same record.
 */
function laneRecord(ctx: StageContext, intent: IntentOf<'proc.spawn'>, lane: LaneDef, root: AbsPath): LaneRecord {
  if (intent.parent.type !== 'stage') throw new Error(`lane spawn ${intent.op} has no stage parent`);
  const inv = invocationId(intent.op, intent.ordinal);
  const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
  const launch = files.read('launch.json');
  if (launch === null) throw new Error(`lane ${lane.id} ${inv}: no launch.json`);
  const result = files.read('result.json');
  if (result !== null && result.type !== 'command') throw new Error(`${inv}: a lane produced a ${result.type} result`);
  const at = isoTimeOf(new Date(new Date(launch.deadlineAt).getTime() - LANE_DEADLINE_MS));
  const { dir, fixDirs } = laneDirs(root, lane);
  const verdict: CommandVerdict = result?.verdict ?? 'process-fault';
  return {
    lane: lane.id, argv: lane.argv, expectedExit: lane.expectedExit, exitCode: result?.exitCode ?? null, verdict, evidenceDir: dir,
    inv, at, endedAt: files.read('exit.json')?.endedAt ?? at, fixDirs,
  };
}

function spawnOf(view: JournalView, op: OpId): IntentOf<'proc.spawn'> {
  const intent = view.latestIntent(op);
  if (intent.kind !== 'proc.spawn') throw new Error(`${op} is a ${intent.kind} op, not proc.spawn`);
  return intent;
}

type Ran = Readonly<{ record: LaneRecord; evidence: OpId; interrupted: 'pause' | 'stop' | null; blocked: string | null }>;

async function runLane(ctx: StageContext, parent: StageParent, lane: LaneDef, set: LaneSet, tree: AbsPath, at: Sha, root: AbsPath): Promise<Ran> {
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    origin: { type: 'new', key: opKey(`lane:${parent.unit}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
    subject: { purpose: 'lane', unit: parent.unit, lane: lane.id, set, at },
    launch: () => ({
      argv: lane.argv, cwd: absPath(join(tree, lane.cwd)), env: laneEnv(ctx, parent.unit, lane), stdinPath: null, graceMs: LANE_GRACE_MS,
      terminal: { type: 'command', purpose: 'lane', expectedExit: lane.expectedExit },
    }),
  });
  const invDir = invocationDir(ctx.runDir, outcome.inv);

  // One evidence dir per lane: its stdout and stderr, and its declared evidence from the checkout.
  const { dir } = laneDirs(root, lane);
  let evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
    source: invDir, globs: [repoPattern(STDOUT_FILE), repoPattern(STDERR_FILE)], dest: absPath(join(dir, 'output')),
  })).op;
  if (lane.evidenceGlobs.length > 0) {
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: tree, globs: lane.evidenceGlobs, dest: absPath(join(dir, 'tree')),
    })).op;
  }

  const record = laneRecord(ctx, spawnOf(ctx.journal.view, outcome.op), lane, root);
  const exit = runnerFiles(invDir, outcome.inv).read('exit.json');
  const interrupted = cancelledFor(invDir, outcome.inv);
  const blocked = outcome.kind === 'lost' ? `${outcome.inv} was lost with its runner` : record.verdict === 'process-fault' ? `${outcome.inv} ended by ${exit?.cause ?? 'unknown'}` : null;
  return { record, evidence, interrupted, blocked };
}

/**
 * Runs `lanes` (in series order) one at a time, each under its reservation, in the detached checkout
 * `checkout` names, created just before the first lane, keeping evidence under `root`. The caller records
 * the stage outcome; the checkout stays for the caller to keep or remove.
 */
export async function runLaneSeries(
  ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], set: LaneSet, checkout: WorktreeCreateRequest, root: AbsPath,
): Promise<Series> {
  if (checkout.checkout.type !== 'detached') throw new Error(`a lane series runs in a detached checkout, not on ${checkout.checkout.branch}`);
  const { path } = checkout;
  const { at } = checkout.checkout;
  const holder = { type: 'stage', unit: parent.unit, stage: parent.stage, attempt: parent.attempt } as const;
  const ledger: LaneRecord[] = [];
  let evidence: OpId | null = null;
  let end: SeriesEnd = { kind: 'green' };

  for (const lane of lanes) {
    let held = null;
    if (lane.resources.length > 0) {
      const reserved = reserve(ctx, holder, lane.resources, parent);
      // M1 runs one unit at a time and every holder releases before its stage ends: a busy resource is a leak.
      if (reserved.state === 'refused') throw new Error(`lane ${lane.id} of ${parent.unit}: resources ${reserved.busy.join(', ')} are held by another`);
      const occupancy = await probe(ctx, reserved, parent);
      if (occupancy.kind === 'parked') {
        const cleaned = await cleanup(ctx, reserved, parent);
        end = cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'occupied', needsUser: occupancy.needsUser };
        break;
      }
      held = run(ctx, reserved, parent);
    }
    if (evidence === null) await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, checkout);
    const ran = await runLane(ctx, parent, lane, set, path, at, root);
    evidence = ran.evidence;
    ledger.push(ran.record);
    if (held !== null) {
      const cleaned = await cleanup(ctx, held, parent);
      if (cleaned.kind === 'cleanup-failed') {
        end = { kind: 'cleanup-failed', failed: cleaned.failed };
        break;
      }
    }
    if (ran.interrupted !== null) end = { kind: 'interrupted', reason: ran.interrupted };
    else if (ran.blocked !== null) end = { kind: 'blocked', lane: ran.record, detail: ran.blocked };
    else if (ran.record.verdict === 'fail') end = { kind: 'red', lane: ran.record };
    if (end.kind !== 'green') break;
  }
  if (evidence === null) return { end, ledger, tree: null, dirty: [] };
  const dirty = dirtyPaths(path);
  if (dirty.length > 0) {
    // Preserve what the lanes wrote before any removal discards it. `_dirty` cannot collide with a lane
    // id, which starts with a letter.
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: path, globs: dirty.map((p) => repoPattern(p)), dest: dirtyDir(root),
    })).op;
  }
  return { end, ledger, tree: { path, at, evidence }, dirty };
}

const dirtyDir = (root: AbsPath): AbsPath => absPath(join(root, '_dirty'));

/** Tracked or unignored changes in a checkout; ignored files never count. */
export function dirtyPaths(tree: AbsPath): readonly RepoPath[] {
  return statusPorcelainV2Z(tree, false).map((s) => s.path);
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
 * attempt runs two: on the candidate, then on the integration tip alone); `lanes` hold the definitions it
 * ran, found by id.
 */
export function seriesLedger(ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], at: Sha, root: AbsPath): readonly LaneRecord[] {
  return ctx.journal.view.opsOf('proc.spawn').flatMap((intent) => {
    const s = intent.expect.subject;
    if (s.purpose !== 'lane' || s.at !== at || !sameParent(intent.parent, parent)) return [];
    const lane = lanes.find((l) => l.id === s.lane);
    if (lane === undefined) throw new Error(`lane ${s.lane} of ${intent.op} is not among the lanes given`);
    return [laneRecord(ctx, intent, lane, root)];
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
  return snap === undefined ? [] : snap.expect.globs.map((g) => repoPath(g));
}
