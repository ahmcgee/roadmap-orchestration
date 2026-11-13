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

const add = <T extends Waited>(old: T, value: Waited): T => {
  const byReasonMs: Partial<Record<WaitReason, number>> = { ...old.byReasonMs };
  for (const reason of Object.keys(value.byReasonMs) as WaitReason[]) byReasonMs[reason] = (byReasonMs[reason] ?? 0) + value.byReasonMs[reason]!;
  return { ...old, totalMs: old.totalMs + value.totalMs, byReasonMs };
};

/**
 * Completed grants and admissions folded one event at a time (a pass of src/status/passes.ts): each measurement as it
 * completes, and the totals per unit stage and job stage. What it holds after n events is a function of those n alone.
 */
export class WaitingFold {
  readonly #measurements: WaitingMeasurement[] = [];
  readonly #pending = new Map<string, IntentOf<'resource.transition'>>();
  #unmeasured = 0;
  readonly #units = new Map<string, Waited & { unit: UnitId; stage: Stage }>();
  readonly #jobs = new Map<string, Waited & { job: JobId; stage: JobKind }>();
  #totals: WaitingTotals | null = null;
  step(e: Event): void {
    if (e.type === 'fact' && e.fact.kind === 'stage-admitted') this.#measured({ source: 'admission', unit: e.fact.unit, stage: e.fact.stage, at: e.at, waited: e.fact.waited });
    if (e.type === 'intent' && e.kind === 'resource.transition' && e.expect.edge.type === 'reserve') this.#pending.set(e.op, e);
    if (e.type !== 'done' || e.kind !== 'resource.transition') return;
    const grant = this.#pending.get(e.op);
    if (!grant) return;
    this.#pending.delete(e.op);
    if (grant.expect.waited === undefined) { this.#unmeasured++; this.#totals = null; }
    else this.#measured({ source: 'reservation', parent: grant.parent, at: e.at, waited: grant.expect.waited });
  }
  #measured(m: WaitingMeasurement): void {
    this.#measurements.push(m);
    this.#totals = null;
    const unit = (id: UnitId, stage: Stage, value: Waited) => {
      const key = `${id}/${stage}`;
      this.#units.set(key, add(this.#units.get(key) ?? { unit: id, stage, totalMs: 0, byReasonMs: {} }, value));
    };
    if (m.source === 'admission') unit(m.unit, m.stage, m.waited);
    else if (m.parent.type === 'stage') unit(m.parent.unit, m.parent.stage, m.waited);
    else if (m.parent.type === 'job') {
      const job = m.parent.job, stage = parseJobId(job).kind;
      this.#jobs.set(job, add(this.#jobs.get(job) ?? { job, stage, totalMs: 0, byReasonMs: {} }, m.waited));
    }
  }
  /** The completed measurements so far, in log order, and the grants that carried none. */
  get completed(): Readonly<{ measurements: readonly WaitingMeasurement[]; unmeasuredReservations: number }> {
    return { measurements: [...this.#measurements], unmeasuredReservations: this.#unmeasured };
  }
  get totals(): WaitingTotals {
    return this.#totals ??= { unmeasuredReservations: this.#unmeasured, byUnitStage: [...this.#units.values()], byJobStage: [...this.#jobs.values()] };
  }
}

/** Expose individual completed measurements before aggregation: overlapping reasons cannot be partitioned afterward. */
export function completedWaiting(events: readonly Event[]) {
  const fold = new WaitingFold();
  for (const e of events) fold.step(e);
  return fold.completed;
}

/** Completed grants and admissions only; a crash loses unrecorded measurements, never invents downtime. */
export function waitingTotals(events: readonly Event[]): WaitingTotals {
  const fold = new WaitingFold();
  for (const e of events) fold.step(e);
  return fold.totals;
}
