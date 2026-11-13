// Read-only execution detail shared by JSON status and the observer worker.
import type { CpuBasis } from './core/cpu.ts';
import type { Event,Parent } from './core/events.ts';
import { invocationId,parseResourceUnit,type InvocationId,type LaneId,type OpId,type ResourceUnit,type UnitId } from './core/ids.ts';
import { canonicalJson } from './core/json.ts';
import { exitCpuOf,reservationCpuBasisOf,reservationTokenWaitOf } from './core/projections.ts';
import type { CommandVerdict,ExitCause,LaunchCpu } from './core/records.ts';
import { boundsOfRecord,isRed } from './core/records.ts';
import type { PlanUnit } from './input/plan.ts';
import type { StageContext,StageParent } from './pipeline/dispatch.ts';
import { matchesVerificationPath,verificationWorktree } from './pipeline/dispatch.ts';
import { unitTip } from './pipeline/gate.ts';
import { invocationDir } from './pipeline/invoke.ts';
import { laneOrder,laneSpawns,laneSummaryIn,seriesOrder,specSeriesRoot } from './pipeline/lanes.ts';
import { fastSuiteLaneReader,fastSuiteRoot,loadUnitSpec,previousLaneReds } from './pipeline/stages.ts';
import { runnerFiles } from './runner/files.ts';

export type WorkRun = Readonly<{
  inv: InvocationId; cause: ExitCause | null; parent: Parent; kind: 'build' | 'lane'; lane: LaneId | null;
  reservedCpu: number | null; cpuBasis: CpuBasis | null; measured: LaunchCpu | null;
  tokenWaitMs: number | null; resources: readonly ResourceUnit[];
}>;
export type Certification = Readonly<{
  used: number; allowance: number; left: number; attempt: number | null;
  lanes: readonly Readonly<{ id: LaneId; set: 'spec' | 'suite'; redFirst: boolean;
    state: 'queued' | 'running' | 'red' | 'green' | 'reused' | 'blocked'; verdict: CommandVerdict | null;
    flaky: boolean; inv: InvocationId | null; holds: readonly ResourceUnit[] }> [];
}>;

type Reservation = Readonly<{ resources: readonly ResourceUnit[]; basis: CpuBasis | null; wait: number | null }>;
/** A spawn a work run is read for, with the CPU reservation its parent held at its journal position (null: none). */
type ReservedSpawn = Readonly<{ op: OpId; ordinal: number; parent: Parent; build: boolean; lane: LaneId | null; reservation: Reservation | null }>;

/**
 * Each build and lane-like spawn matched to the reservation actually held at its journal position, never today's cost
 * estimate: folded one event at a time (a pass of src/status/passes.ts). The runs' exit records are read by `workRunsOf`.
 */
export class ReservationFold {
  readonly #held = new Map<string, Reservation>();
  readonly #spawns: ReservedSpawn[] = [];
  step(e: Event): void {
    if (e.type !== 'intent') return;
    if (e.kind === 'resource.transition') {
      const x = e.expect;
      if (!x.resources.some((r) => parseResourceUnit(r).type === 'cpu')) return;
      const key = canonicalJson(e.parent);
      if (x.edge.type === 'reserve') {
        this.#held.set(key, { resources: x.resources, basis: reservationCpuBasisOf(x), wait: reservationTokenWaitOf(x) });
      } else if (x.edge.type === 'release') this.#held.delete(key);
      return;
    }
    if (e.kind !== 'proc.spawn') return;
    const s = e.expect.subject;
    const build = s.purpose === 'backend' && s.role === 'build';
    if (!build && !['lane', 'journey', 'proof', 'mutant'].includes(s.purpose)) return;
    this.#spawns.push({ op: e.op, ordinal: e.ordinal, parent: e.parent, build, lane: 'lane' in s ? s.lane : null, reservation: this.#held.get(canonicalJson(e.parent)) ?? null });
  }
  get spawns(): readonly ReservedSpawn[] { return [...this.#spawns]; }
}

/** The work runs of the spawns `fold` matched, each with its exit record as the runner wrote it (absent: still running). */
export function workRunsOf(ctx: Pick<StageContext, 'runDir'>, fold: ReservationFold): readonly WorkRun[] {
  const readExit = (inv: InvocationId) => runnerFiles(invocationDir(ctx.runDir, inv), inv).read('exit.json');
  return fold.spawns.map(({ op, ordinal, parent, build, lane, reservation }) => {
    const inv = invocationId(op, ordinal), exit = readExit(inv);
    return { inv, cause: exit?.cause ?? null, parent, kind: build ? 'build' : 'lane', lane,
      reservedCpu: reservation ? reservation.resources.filter((r) => parseResourceUnit(r).type === 'cpu').length : null,
      cpuBasis: reservation?.basis ?? null, measured: exit === null ? null : exitCpuOf(exit),
      tokenWaitMs: reservation?.wait ?? null, resources: reservation?.resources ?? [] };
  });
}

/** Match each launch to the reservation actually held at its journal position, never today's cost estimate. */
export function workRuns(ctx: Pick<StageContext, 'journal' | 'runDir'>, events: readonly Event[]): readonly WorkRun[] {
  const fold = new ReservationFold();
  for (const e of events) fold.step(e);
  return workRunsOf(ctx, fold);
}

/** Each unit's completed `lanes` attempts (holds left out), in log order: folded one event at a time (src/status/passes.ts). */
export class LanesAttemptsFold {
  readonly #attempts = new Map<UnitId, readonly number[]>();
  step(e: Event): void {
    if (e.type !== 'fact' || e.fact.kind !== 'stage-outcome' || !('unit' in e.fact) || e.fact.stage !== 'lanes' || e.fact.class === 'hold') return;
    const f = e.fact;
    this.#attempts.set(f.unit, [...(this.#attempts.get(f.unit) ?? []), f.attempt]);
  }
  get attempts(): ReadonlyMap<UnitId, readonly number[]> { return new Map(this.#attempts); }
}

/** The current certification series in the executor's own order. Historical evidence stays on its invocation. */
export function certificationReader(ctx: StageContext, lanes: LanesAttemptsFold, runs: readonly WorkRun[]) {
  const suiteLanes = fastSuiteLaneReader(ctx);
  const runsByInv = new Map(runs.map((r) => [r.inv, r] as const));
  const attempts = lanes.attempts;
  return (unit: PlanUnit, queuedAttempt?: number): Certification => {
    const view = ctx.journal.view;
    const state = view.unit(unit.id);
    const allowance = boundsOfRecord(view.dispatchOf(unit.id)).certifications - 1;
    const used = state.counters.unchargedLanesReds;
    const empty = { used, allowance, left: Math.max(0, allowance - used), attempt: null, lanes: [] };
    const attempt = queuedAttempt ?? (state.open?.stage === 'lanes' ? state.open.attempt : view.completedLanes(unit.id));
    if (attempt === null) return empty;
    const parent: StageParent = { type: 'stage', unit: unit.id, stage: 'lanes', attempt };
    const checkout = view.opsOfParent('worktree.create', parent).filter((i) => matchesVerificationPath(i.expect.path, verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id), attempt)).at(-1);
    if (!checkout && queuedAttempt === undefined && state.open?.stage !== 'lanes') return { ...empty, attempt };
    const at = checkout?.expect.checkout.type === 'detached' ? checkout.expect.checkout.at : unitTip(ctx, unit.id);
    const { spec } = loadUnitSpec(ctx, unit);
    const previous = attempts.get(unit.id)?.findLast((a) => a < attempt) ?? null;
    const reds = previousLaneReds(ctx, unit, spec, previous);
    const groups = [
      { set: 'spec' as const, lanes: seriesOrder(laneOrder(spec), reds.spec), root: specSeriesRoot(ctx.runDir, parent) },
      { set: 'suite' as const, lanes: seriesOrder(suiteLanes(spec, at), reds.suite), root: fastSuiteRoot(ctx.runDir, parent, 'suite') },
    ];
    // laneSpawns reads the journal's canonical parent index, shared with the summary and executor lane readers.
    return { ...empty, attempt: parent.attempt, lanes: groups.flatMap(({ set, lanes, root }) => lanes.map((lane) => {
      const spawns = laneSpawns(view, parent, lane.id, at, set);
      const last = spawns.at(-1);
      const live = last !== undefined && view.doneOf(last.op) === null;
      // Reading the aggregate before settlement would falsely turn an unfinished run into a process fault.
      const record = live ? null : laneSummaryIn(ctx, parent, lane, set, at, root);
      const inv = live ? invocationId(last.op, last.ordinal) : record?.inv ?? null;
      const run = inv === null ? undefined : runsByInv.get(inv);
      const verdict = record?.verdict ?? null;
      return { id: lane.id, set, redFirst: reds[set].has(lane.id),
        state: live ? 'running' as const : record?.reused ? 'reused' as const : verdict === 'pass' && !record?.flaky ? 'green' as const
          : verdict !== null && (isRed(verdict) || record?.flaky) ? 'red' as const : verdict !== null ? 'blocked' as const : 'queued' as const,
        verdict, flaky: record?.flaky ?? false, inv,
        holds: live ? (run?.resources ?? []).filter((r) => parseResourceUnit(r).type !== 'cpu') : [] };
    })) };
  };
}

export function certification(ctx: StageContext, unit: PlanUnit, events: readonly Event[], runs: readonly WorkRun[], queuedAttempt?: number): Certification {
  const lanes = new LanesAttemptsFold();
  for (const e of events) lanes.step(e);
  return certificationReader(ctx, lanes, runs)(unit, queuedAttempt);
}
