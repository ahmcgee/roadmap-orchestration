// Read-only execution detail shared by JSON status and the observer worker.
import type { CpuBasis } from './core/cpu.ts';
import type { Event, Parent } from './core/events.ts';
import { invocationId, parseResourceUnit, type InvocationId, type LaneId, type ResourceUnit } from './core/ids.ts';
import type { CommandVerdict, ExitCause, LaunchCpu } from './core/records.ts';
import { boundsOfRecord, isRed } from './core/records.ts';
import { exitCpuOf, reservationCpuBasisOf, reservationTokenWaitOf } from './core/upgrade.ts';
import { canonicalJson } from './core/json.ts';
import type { PlanUnit } from './input/plan.ts';
import type { StageContext, StageParent } from './pipeline/dispatch.ts';
import { verificationWorktree } from './pipeline/dispatch.ts';
import { unitTip } from './pipeline/gate.ts';
import { invocationDir } from './pipeline/invoke.ts';
import { laneOrder, laneRecordIn, seriesOrder, specSeriesRoot } from './pipeline/lanes.ts';
import { fastSuiteLanes, fastSuiteRoot, loadUnitSpec, previousLaneReds } from './pipeline/stages.ts';
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
const same = (a: Parent, b: Parent): boolean => canonicalJson(a) === canonicalJson(b);

/** Match each launch to the reservation actually held at its journal position, never today's cost estimate. */
export function workRuns(ctx: Pick<StageContext, 'journal' | 'runDir'>, events: readonly Event[]): readonly WorkRun[] {
  const held = new Map<string, { resources: readonly ResourceUnit[]; basis: CpuBasis | null; wait: number | null }>();
  const rows: WorkRun[] = [];
  for (const e of events) {
    if (e.type !== 'intent') continue;
    const key = canonicalJson(e.parent);
    if (e.kind === 'resource.transition') {
      const x = e.expect;
      if (x.edge.type === 'reserve' && x.resources.some((r) => parseResourceUnit(r).type === 'cpu')) {
        held.set(key, { resources: x.resources, basis: reservationCpuBasisOf(x), wait: reservationTokenWaitOf(x) });
      } else if (x.edge.type === 'release' && x.resources.some((r) => parseResourceUnit(r).type === 'cpu')) held.delete(key);
      continue;
    }
    if (e.kind !== 'proc.spawn') continue;
    const s = e.expect.subject;
    const build = s.purpose === 'backend' && s.role === 'build';
    if (!build && !['lane', 'journey', 'proof', 'mutant'].includes(s.purpose)) continue;
    const inv = invocationId(e.op, e.ordinal);
    const exit = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('exit.json');
    const reservation = held.get(key);
    rows.push({ inv, cause: exit?.cause ?? null, parent: e.parent, kind: build ? 'build' : 'lane', lane: 'lane' in s ? s.lane : null,
      reservedCpu: reservation ? reservation.resources.filter((r) => parseResourceUnit(r).type === 'cpu').length : null,
      cpuBasis: reservation?.basis ?? null, measured: exit === null ? null : exitCpuOf(exit),
      tokenWaitMs: reservation?.wait ?? null, resources: reservation?.resources ?? [] });
  }
  return rows;
}

/** The current certification series in the executor's own order. Historical evidence stays on its invocation. */
export function certification(ctx: StageContext, unit: PlanUnit, events: readonly Event[], runs: readonly WorkRun[], queuedAttempt?: number): Certification {
  const view = ctx.journal.view;
  const state = view.unit(unit.id);
  const allowance = boundsOfRecord(view.dispatchOf(unit.id)).certifications - 1;
  const used = state.counters.unchargedLanesReds;
  const empty = { used, allowance, left: Math.max(0, allowance - used), attempt: null, lanes: [] };
  const attempt = queuedAttempt ?? (state.open?.stage === 'lanes' ? state.open.attempt : view.completedLanes(unit.id));
  if (attempt === null) return empty;
  const parent: StageParent = { type: 'stage', unit: unit.id, stage: 'lanes', attempt };
  const checkout = view.opsOf('worktree.create').find((i) => i.expect.path === verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, attempt));
  if (!checkout && queuedAttempt === undefined && state.open?.stage !== 'lanes') return { ...empty, attempt };
  const at = checkout?.expect.checkout.type === 'detached' ? checkout.expect.checkout.at : unitTip(ctx, unit.id);
  const { spec } = loadUnitSpec(ctx, unit);
  const previous = events.flatMap((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === unit.id
    && e.fact.stage === 'lanes' && e.fact.class !== 'hold' && e.fact.attempt < attempt ? [e.fact.attempt] : []).at(-1) ?? null;
  const reds = previousLaneReds(ctx, unit, spec, previous);
  const groups = [
    { set: 'spec' as const, lanes: seriesOrder(laneOrder(spec), reds.spec), root: specSeriesRoot(ctx.runDir, parent) },
    { set: 'suite' as const, lanes: seriesOrder(fastSuiteLanes(ctx, spec, at), reds.suite), root: fastSuiteRoot(ctx.runDir, parent, 'suite') },
  ];
  return { ...empty, attempt: parent.attempt, lanes: groups.flatMap(({ set, lanes, root }) => lanes.map((lane) => {
    const spawns = view.opsOf('proc.spawn').filter((s) => same(s.parent, parent) && s.expect.subject.purpose === 'lane' && s.expect.subject.set === set && s.expect.subject.at === at && s.expect.subject.lane === lane.id);
    const last = spawns.at(-1);
    const live = last !== undefined && view.doneOf(last.op) === null;
    // Reading the aggregate before settlement would falsely turn an unfinished run into a process fault.
    const record = live ? null : laneRecordIn(ctx, parent, lane, set, at, root);
    const inv = live ? invocationId(last.op, last.ordinal) : record?.inv ?? null;
    const run = runs.find((r) => r.inv === inv);
    const verdict = record?.verdict ?? null;
    return { id: lane.id, set, redFirst: reds[set].has(lane.id),
      state: live ? 'running' as const : record?.reused ? 'reused' as const : verdict === 'pass' && !record?.flaky ? 'green' as const
        : verdict !== null && (isRed(verdict) || record?.flaky) ? 'red' as const : verdict !== null ? 'blocked' as const : 'queued' as const,
      verdict, flaky: record?.flaky ?? false, inv,
      holds: live ? (run?.resources ?? []).filter((r) => parseResourceUnit(r).type !== 'cpu') : [] };
  })) };
}
