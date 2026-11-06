import type { Event, IntentOf } from '../core/events.ts';
import { type JobId, type JobKind, type UnitId, parseJobId } from '../core/ids.ts';
import type { Stage } from '../core/records.ts';
import type { Waited, WaitReason } from '../core/waiting.ts';

export type WaitingTotals = Readonly<{
  unmeasuredReservations: number;
  byUnitStage: readonly (Waited & Readonly<{ unit: UnitId; stage: Stage }>)[];
  byJobStage: readonly (Waited & Readonly<{ job: JobId; stage: JobKind }>)[];
}>;

/** Completed grants and admissions only; a crash loses unrecorded measurements, never invents downtime. */
export function waitingTotals(events: readonly Event[]): WaitingTotals {
  const units = new Map<string, Waited & { unit: UnitId; stage: Stage }>();
  const jobs = new Map<string, Waited & { job: JobId; stage: JobKind }>();
  const pending = new Map<string, IntentOf<'resource.transition'>>();
  let unmeasuredReservations = 0;
  const add = <T extends Waited>(old: T, value: Waited): T => {
    const byReasonMs: Partial<Record<WaitReason, number>> = { ...old.byReasonMs };
    for (const reason of Object.keys(value.byReasonMs) as WaitReason[]) byReasonMs[reason] = (byReasonMs[reason] ?? 0) + value.byReasonMs[reason]!;
    return { ...old, totalMs: old.totalMs + value.totalMs, byReasonMs };
  };
  const unit = (id: UnitId, stage: Stage, value: Waited) => {
    const key = `${id}/${stage}`;
    units.set(key, add(units.get(key) ?? { unit: id, stage, totalMs: 0, byReasonMs: {} }, value));
  };
  for (const event of events) {
    if (event.type === 'fact' && event.fact.kind === 'stage-admitted') unit(event.fact.unit, event.fact.stage, event.fact.waited);
    if (event.type === 'intent' && event.kind === 'resource.transition' && event.expect.edge.type === 'reserve') pending.set(event.op, event);
    if (event.type !== 'done' || event.kind !== 'resource.transition') continue;
    const grant = pending.get(event.op);
    if (grant === undefined) continue;
    pending.delete(event.op);
    const value = grant.expect.waited;
    if (value === undefined) { unmeasuredReservations++; continue; }
    const parent = grant.parent;
    if (parent.type === 'stage') unit(parent.unit, parent.stage, value);
    if (parent.type === 'job') {
      const stage = parseJobId(parent.job).kind;
      jobs.set(parent.job, add(jobs.get(parent.job) ?? { job: parent.job, stage, totalMs: 0, byReasonMs: {} }, value));
    }
  }
  return { unmeasuredReservations, byUnitStage: [...units.values()], byJobStage: [...jobs.values()] };
}
