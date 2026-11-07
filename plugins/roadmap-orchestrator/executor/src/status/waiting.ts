import type { Event, IntentOf, Parent } from '../core/events.ts';
import { type JobId, type JobKind, type UnitId, parseJobId } from '../core/ids.ts';
import type { Stage } from '../core/records.ts';
import type { Waited, WaitReason } from '../core/waiting.ts';

export type WaitingTotals = Readonly<{
  unmeasuredReservations: number;
  byUnitStage: readonly (Waited & Readonly<{ unit: UnitId; stage: Stage }>)[];
  byJobStage: readonly (Waited & Readonly<{ job: JobId; stage: JobKind }>)[];
}>;

export type WaitingMeasurement = Readonly<{ source: 'admission'; unit: UnitId; stage: Stage; at: string; waited: Waited }>
  | Readonly<{ source: 'reservation'; parent: Parent; at: string; waited: Waited }>;

/** Expose individual completed measurements before aggregation: overlapping reasons cannot be partitioned afterward. */
export function completedWaiting(events: readonly Event[]) {
  const measurements: WaitingMeasurement[] = [];
  const pending = new Map<string, IntentOf<'resource.transition'>>();
  let unmeasuredReservations = 0;
  for (const e of events) {
    if (e.type === 'fact' && e.fact.kind === 'stage-admitted') measurements.push({ source: 'admission', unit: e.fact.unit, stage: e.fact.stage, at: e.at, waited: e.fact.waited });
    if (e.type === 'intent' && e.kind === 'resource.transition' && e.expect.edge.type === 'reserve') pending.set(e.op, e);
    if (e.type !== 'done' || e.kind !== 'resource.transition') continue;
    const grant = pending.get(e.op);
    if (!grant) continue;
    pending.delete(e.op);
    if (grant.expect.waited === undefined) unmeasuredReservations++;
    else measurements.push({ source: 'reservation', parent: grant.parent, at: e.at, waited: grant.expect.waited });
  }
  return { measurements, unmeasuredReservations };
}

/** Completed grants and admissions only; a crash loses unrecorded measurements, never invents downtime. */
export function waitingTotals(events: readonly Event[]): WaitingTotals {
  const units = new Map<string, Waited & { unit: UnitId; stage: Stage }>();
  const jobs = new Map<string, Waited & { job: JobId; stage: JobKind }>();
  const add = <T extends Waited>(old: T, value: Waited): T => {
    const byReasonMs: Partial<Record<WaitReason, number>> = { ...old.byReasonMs };
    for (const reason of Object.keys(value.byReasonMs) as WaitReason[]) byReasonMs[reason] = (byReasonMs[reason] ?? 0) + value.byReasonMs[reason]!;
    return { ...old, totalMs: old.totalMs + value.totalMs, byReasonMs };
  };
  const unit = (id: UnitId, stage: Stage, value: Waited) => {
    const key = `${id}/${stage}`;
    units.set(key, add(units.get(key) ?? { unit: id, stage, totalMs: 0, byReasonMs: {} }, value));
  };
  const { measurements, unmeasuredReservations } = completedWaiting(events);
  for (const m of measurements) {
    if (m.source === 'admission') unit(m.unit, m.stage, m.waited);
    else if (m.parent.type === 'stage') unit(m.parent.unit, m.parent.stage, m.waited);
    else if (m.parent.type === 'job') {
      const job = m.parent.job, stage = parseJobId(job).kind;
      jobs.set(job, add(jobs.get(job) ?? { job, stage, totalMs: 0, byReasonMs: {} }, m.waited));
    }
  }
  return { unmeasuredReservations, byUnitStage: [...units.values()], byJobStage: [...jobs.values()] };
}
