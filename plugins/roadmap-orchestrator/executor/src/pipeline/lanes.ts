// Lane execution (plan "Pipeline", lanes row; DESIGN-1.0.md §4 Verification, Lanes): the executor runs a
// unit's spec lanes serially, verbatim, under their reservations, in a clean detached checkout of the
// salvage SHA, fast lanes before estate lanes, and keeps one evidence dir per lane.
//
// Per lane: reserve its declared resources → occupancy probe → run (step 10's cycle) → `invoke` purpose
// `lane` with the spec's exact argv, cwd and env (plus the unit's owner label) → evidence snapshots →
// cleanup. The series stops at the first lane that does not pass: one failure is what a fix round needs,
// and nothing after it is spent. The checkout is created just before the first lane runs, so a series that
// ends before any lane ran leaves no tree behind.
//
// After the series the checkout must still be clean: a lane that wrote a tracked or unignored file into
// it is never certified under a SHA (`dirty`). The dirty paths are snapshotted before anything removes the
// tree. The checkout is removed with `worktree.remove`, which cites a done evidence snapshot of this series.
import { join } from 'node:path';
import type { OpId, Sha, UnitId } from '../core/ids.ts';
import { type InvocationId, opKey } from '../core/ids.ts';
import type { CommandVerdict, SpecM1 } from '../core/records.ts';
import { STDERR_FILE, STDOUT_FILE } from '../core/records.ts';
import { type AbsPath, type IsoTime, type RepoPath, absPath, isoTimeOf, repoPattern } from '../core/values.ts';
import { FILES_DIR, capturedEvidence, evidenceSnapshotOp } from '../git/evidence.ts';
import { statusPorcelainV2Z } from '../git/git.ts';
import { worktreeCreateOp, worktreeRemoveOp } from '../git/worktree.ts';
import type { LaneLedgerEntry } from '../prompts/inputs.ts';
import { type NeedsUserContent, probe } from '../resources/probe.ts';
import { type SpecLane, cleanup, reserve, run } from '../resources/reserve.ts';
import { OWNER_ENV, ownerLabel } from '../resources/teardown.ts';
import { runnerFiles } from '../runner/files.ts';
import { type StageContext, type StageParent, cancelledFor, evidenceRoot, runOp, verificationWorktree } from './dispatch.ts';
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

/** A lanes attempt's checkout, and the done evidence snapshot its removal cites. */
export type VerificationTree = Readonly<{ path: AbsPath; at: Sha; evidence: OpId }>;

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

/** Fast lanes first, then estate; spec order within a tier; struck and deferred lanes do not run. */
export function laneOrder(spec: SpecM1): readonly SpecLane[] {
  const active = spec.lanes.filter((l) => l.state === 'active');
  return [...active.filter((l) => l.tier === 'fast'), ...active.filter((l) => l.tier === 'estate')];
}

/** The lane's declared env verbatim (`set`, and `pass` copied from the host), plus the unit's owner label. */
export function laneEnv(ctx: StageContext, unit: UnitId, lane: SpecLane): Readonly<Record<string, string>> {
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

type Ran = Readonly<{ record: LaneRecord; evidence: OpId; interrupted: 'pause' | 'stop' | null; blocked: string | null }>;

async function runLane(ctx: StageContext, parent: StageParent, lane: SpecLane, tree: AbsPath, at: Sha): Promise<Ran> {
  const started = isoTimeOf(new Date());
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    origin: { type: 'new', key: opKey(`lane:${parent.unit}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
    subject: { purpose: 'lane', unit: parent.unit, lane: lane.id, set: 'spec', at },
    launch: () => ({
      argv: lane.argv, cwd: absPath(join(tree, lane.cwd)), env: laneEnv(ctx, parent.unit, lane), stdinPath: null, graceMs: LANE_GRACE_MS,
      terminal: { type: 'command', purpose: 'lane', expectedExit: lane.expectedExit },
    }),
  });
  const invDir = invocationDir(ctx.runDir, outcome.inv);
  const exit = runnerFiles(invDir, outcome.inv).read('exit.json');
  let exitCode: number | null = null;
  let verdict: CommandVerdict = 'process-fault';
  if (outcome.kind === 'result') {
    if (outcome.result.type !== 'command') throw new Error(`${outcome.inv}: a lane produced a ${outcome.result.type} result`);
    ({ exitCode, verdict } = outcome.result);
  }

  // One evidence dir per lane: its stdout and stderr, and its declared evidence from the checkout.
  const dir = absPath(join(evidenceRoot(ctx.runDir, parent), lane.id));
  const fixDirs = [absPath(join(dir, 'output', FILES_DIR))];
  let evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
    source: invDir, globs: [repoPattern(STDOUT_FILE), repoPattern(STDERR_FILE)], dest: absPath(join(dir, 'output')),
  })).op;
  if (lane.evidenceGlobs.length > 0) {
    evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
      source: tree, globs: lane.evidenceGlobs, dest: absPath(join(dir, 'tree')),
    })).op;
    fixDirs.push(absPath(join(dir, 'tree', FILES_DIR)));
  }

  const record: LaneRecord = {
    lane: lane.id, argv: lane.argv, expectedExit: lane.expectedExit, exitCode, verdict, evidenceDir: dir,
    inv: outcome.inv, at: started, endedAt: exit?.endedAt ?? isoTimeOf(new Date()), fixDirs,
  };
  const interrupted = cancelledFor(invDir, outcome.inv);
  const blocked = outcome.kind === 'lost' ? `${outcome.inv} was lost with its runner` : verdict === 'process-fault' ? `${outcome.inv} ended by ${exit?.cause ?? 'unknown'}` : null;
  return { record, evidence, interrupted, blocked };
}

/**
 * Runs the unit's active lanes at `at`, one at a time, each under its reservation. The caller records
 * the stage outcome; the checkout stays for the caller to keep (green) or remove.
 */
export async function runLaneSeries(ctx: StageContext, parent: StageParent, spec: SpecM1, at: Sha): Promise<Series> {
  const holder = { type: 'stage', unit: parent.unit, stage: parent.stage, attempt: parent.attempt } as const;
  const ledger: LaneRecord[] = [];
  const path = verificationWorktree(ctx.plan.worktreeRoot, ctx.plan.arc, parent.unit, parent.attempt);
  let evidence: OpId | null = null;
  let end: SeriesEnd = { kind: 'green' };

  for (const lane of laneOrder(spec)) {
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
    if (evidence === null) {
      await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, { path, checkout: { type: 'detached', at } });
    }
    const ran = await runLane(ctx, parent, lane, path, at);
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
      source: path, globs: dirty.map((p) => repoPattern(p)), dest: absPath(join(evidenceRoot(ctx.runDir, parent), '_dirty')),
    })).op;
  }
  return { end, ledger, tree: { path, at, evidence }, dirty };
}

/** Tracked or unignored changes in a checkout; ignored files never count. */
export function dirtyPaths(tree: AbsPath): readonly RepoPath[] {
  return statusPorcelainV2Z(tree, false).map((s) => s.path);
}

/** `worktree.remove` of a verification checkout, citing the series' last done evidence snapshot. */
export async function removeVerificationTree(ctx: StageContext, tree: VerificationTree, parent: StageParent): Promise<void> {
  const evidence = capturedEvidence(ctx.journal.view, tree.evidence);
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${parent.unit}:verify`, parent, { path: tree.path, evidence });
}
