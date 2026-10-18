// The meter (plan "Commands, needs-user, meter", DESIGN §2.4 `spend`): per-role, per-seat and per-unit usage
// totals, folded from the log's `meter` and `usage-unavailable` facts, one per invocation. A call's usage
// counts whatever its outcome (a failed or malformed call still spent tokens: R29 "usage validity
// independent of outcome"), because the fact is written from result.json before the spawn's done, for
// every result.
//
// Smokes are charged to their backend, not to a seat (`bySmoke`), so seat spend is the units' and jobs' own. A job's
// lens or checkpoint call (M3, `MeterSubject.job`), and a pack review's (M4a, job `review-<n>`), is charged to its arc
// seat (`lens.arc`, `checkpoint.arc`, `packReview.arc`): it counts in `byRole` and `bySeat` like a unit's call, and per
// job in `byJob` (never in `byUnit`).
//
// Totals are keyed by role (and seat tier) and routing revision, never by model: records carry `{role,
// tier, routingRev}` only. `byModel` derives a model view at render time from the revisions' routing tables
// and writes nothing. A fact names its seat's tier (lead ruling, 13b), so each seat total resolves to
// exactly one model.
//
// Subagents (2026-10-16): a Claude call's totals include what its subagents spent, and its fact names that share per usage
// class (`delegated`, classes.ts `delegateClass`). `delegatedBySeat` keeps it per seat; `byClass` renders spend per class:
// each seat's own share (its totals less the delegated) on the seat's class from the revision's class table, each
// delegated share on its own class. `byModel` counts a seat's own share only (a subagent's model is not a seat's).
import type { Event, Fact } from './core/events.ts';
import type { JobId, RoutingRev, UnitId } from './core/ids.ts';
import type { ClassUsage } from './core/records.ts';
import {
  type Backend, type ClassTable, type ModelId, type Role, type RoutingTable, type SeatRef, type ModelClass, MODEL_CLASSES, atSeat, seatRef,
} from './routing/types.ts';

export type UsageTotals = Readonly<{
  /** Invocations with a usage fact: `known` ones plus `unavailable` ones. */
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** CLI-reported turns and list-price cost (Claude); a call that reports none adds nothing. */
  turns: number;
  costUsd: number;
  /** Calls whose usage was unavailable (no result, absent from the output, malformed). */
  unavailable: number;
}>;

export type RoleTotal = Readonly<{ role: Role; routingRev: RoutingRev }> & UsageTotals;
export type SeatTotal = SeatRef & Readonly<{ routingRev: RoutingRev }> & UsageTotals;
export type UnitTotal = Readonly<{ unit: UnitId; role: Role; routingRev: RoutingRev }> & UsageTotals;
export type SmokeTotal = Readonly<{ backend: Backend; routingRev: RoutingRev }> & UsageTotals;
export type JobTotal = Readonly<{ job: JobId; role: Role; routingRev: RoutingRev }> & UsageTotals;
/** Tokens and list-price cost: what a usage class's share counts (no calls or turns: those are a seat's). */
export type ClassTotals = Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }>;
/** One seat's delegated spend on one usage class. */
export type DelegatedTotal = SeatRef & Readonly<{ routingRev: RoutingRev; class: ModelClass }> & ClassTotals;
export type ClassTotal = Readonly<{ class: ModelClass }> & ClassTotals;

export type Meter = Readonly<{
  /** Ascending by role, then routingRev. */
  byRole: readonly RoleTotal[];
  /** Ascending by role, tier, routingRev: what `byModel` renders. */
  bySeat: readonly SeatTotal[];
  /** Ascending by unit, role, routingRev. */
  byUnit: readonly UnitTotal[];
  /** M3: the jobs' lens and checkpoint calls (M4a: and pack review calls), ascending by job, role, routingRev. */
  byJob: readonly JobTotal[];
  /** Start-up smokes, ascending by backend, routingRev: in no role, seat or unit total. */
  bySmoke: readonly SmokeTotal[];
  /** The share of `bySeat` its subagents spent, per usage class: ascending by role, tier, routingRev, class. */
  delegatedBySeat: readonly DelegatedTotal[];
}>;

type UsageFact = Extract<Fact, { kind: 'meter' | 'usage-unavailable' }>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const ZERO: UsageTotals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0, unavailable: 0 };

function add(t: UsageTotals, f: UsageFact): UsageTotals {
  if (f.kind === 'usage-unavailable') return { ...t, calls: t.calls + 1, unavailable: t.unavailable + 1 };
  const u = f.usage;
  return {
    ...t,
    calls: t.calls + 1,
    input: t.input + u.inputTokens,
    output: t.output + u.outputTokens,
    // A backend that reports no cache figure contributes nothing to it.
    cacheRead: t.cacheRead + (u.cacheReadTokens ?? 0),
    cacheWrite: t.cacheWrite + (u.cacheWriteTokens ?? 0),
    turns: t.turns + (u.turns ?? 0),
    costUsd: t.costUsd + (u.costUsd ?? 0),
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <T>(m: ReadonlyMap<string, T>): T[] => [...m].sort(([a], [b]) => compare(a, b)).map(([, t]) => t);

/** Folds the usage facts of a log, in order. The journal's fold already refuses a second fact per invocation. */
export function meterOf(events: Iterable<Event>): Meter {
  const roles = new Map<string, Mutable<RoleTotal>>();
  const seats = new Map<string, Mutable<SeatTotal>>();
  const units = new Map<string, Mutable<UnitTotal>>();
  const smokes = new Map<string, Mutable<SmokeTotal>>();
  const jobs = new Map<string, Mutable<JobTotal>>();
  const delegated = new Map<string, DelegatedTotal>();
  for (const e of events) {
    if (e.type !== 'fact' || (e.fact.kind !== 'meter' && e.fact.kind !== 'usage-unavailable')) continue;
    const f = e.fact;
    const s = f.subject;
    if (s.type === 'smoke') {
      const k = `${s.backend} ${f.routingRev}`;
      smokes.set(k, { backend: s.backend, routingRev: f.routingRev, ...add(smokes.get(k) ?? ZERO, f) });
      continue;
    }
    const rk = `${s.role} ${f.routingRev}`;
    roles.set(rk, { role: s.role, routingRev: f.routingRev, ...add(roles.get(rk) ?? ZERO, f) });
    const sk = `${s.role} ${s.tier} ${f.routingRev}`;
    seats.set(sk, { ...seatRef(s.role, s.tier), routingRev: f.routingRev, ...add(seats.get(sk) ?? ZERO, f) });
    for (const c of f.kind === 'meter' ? f.delegated ?? [] : []) {
      const dk = `${sk} ${MODEL_CLASSES.indexOf(c.class)}`;
      delegated.set(dk, { ...seatRef(s.role, s.tier), routingRev: f.routingRev, class: c.class, ...plusClass(delegated.get(dk) ?? NO_CLASS_SPEND, c) });
    }
    if (s.type === 'job') {
      const jk = `${s.job} ${rk}`;
      jobs.set(jk, { job: s.job, role: s.role, routingRev: f.routingRev, ...add(jobs.get(jk) ?? ZERO, f) });
      continue;
    }
    const uk = `${s.unit} ${rk}`;
    units.set(uk, { unit: s.unit, role: s.role, routingRev: f.routingRev, ...add(units.get(uk) ?? ZERO, f) });
  }
  return { byRole: sorted(roles), bySeat: sorted(seats), byUnit: sorted(units), byJob: sorted(jobs), bySmoke: sorted(smokes), delegatedBySeat: sorted(delegated) };
}

const NO_CLASS_SPEND: ClassTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
const plusClass = (t: ClassTotals, c: ClassUsage): ClassTotals => ({
  input: t.input + c.inputTokens, output: t.output + c.outputTokens, cacheRead: t.cacheRead + c.cacheReadTokens, cacheWrite: t.cacheWrite + c.cacheWriteTokens,
  costUsd: t.costUsd + c.costUsd,
});
const sameSeat = (a: SeatRef & Readonly<{ routingRev: RoutingRev }>, b: SeatRef & Readonly<{ routingRev: RoutingRev }>): boolean =>
  a.role === b.role && a.tier === b.tier && a.routingRev === b.routingRev;

/** Each seat total less what its subagents spent (`delegatedBySeat`): the seat's own model's share. */
export function ownShare(meter: Pick<Meter, 'bySeat' | 'delegatedBySeat'>): readonly SeatTotal[] {
  return meter.bySeat.map((t) => {
    const d = meter.delegatedBySeat.filter((x) => sameSeat(x, t));
    const less = (k: keyof ClassTotals): number => d.reduce((a, x) => a + x[k], 0);
    return {
      ...t, input: t.input - less('input'), output: t.output - less('output'), cacheRead: t.cacheRead - less('cacheRead'), cacheWrite: t.cacheWrite - less('cacheWrite'),
      costUsd: t.costUsd - less('costUsd'),
    };
  });
}

/**
 * The render-time class view of the meter, in `MODEL_CLASSES` order (a class with no spend left out): each seat's own share
 * on the class its revision seats there (`classes`), each delegated share on its class. A revision missing from `classes`
 * is a caller bug and throws; the caller passes only resolvable seats (`meter.bySeat` filtered as for `byModel`).
 */
export function byClass(meter: Pick<Meter, 'bySeat' | 'delegatedBySeat'>, classes: ReadonlyMap<RoutingRev, ClassTable>): readonly ClassTotal[] {
  const sums = new Map<ModelClass, Mutable<ClassTotals>>();
  const into = (c: ModelClass, t: ClassTotals): void => {
    const sum = sums.get(c) ?? { ...NO_CLASS_SPEND };
    for (const k of Object.keys(NO_CLASS_SPEND) as (keyof ClassTotals)[]) sum[k] += t[k];
    sums.set(c, sum);
  };
  for (const t of ownShare(meter)) {
    const table = classes.get(t.routingRev);
    if (table === undefined) throw new Error(`byClass: no class table for revision ${t.routingRev}`);
    into(atSeat(table, t), t);
  }
  for (const d of meter.delegatedBySeat) if (meter.bySeat.some((t) => sameSeat(t, d))) into(d.class, d);
  return MODEL_CLASSES.flatMap((c) => {
    const t = sums.get(c);
    return t === undefined ? [] : [{ class: c, ...t }];
  });
}

export type ModelTotal = Readonly<{ model: ModelId }> & UsageTotals;

/**
 * The render-time model view of per-seat totals, ascending by model. `tables` maps each routing revision
 * in the log to its resolved table; a revision missing from it is a caller bug and throws.
 */
export function byModel(totals: readonly SeatTotal[], tables: ReadonlyMap<RoutingRev, RoutingTable>): readonly ModelTotal[] {
  const models = new Map<ModelId, Mutable<UsageTotals>>();
  for (const t of totals) {
    const table = tables.get(t.routingRev);
    if (table === undefined) throw new Error(`byModel: no routing table for revision ${t.routingRev}`);
    const model = atSeat(table, t).model;
    const sum = models.get(model) ?? { ...ZERO };
    for (const k of Object.keys(ZERO) as (keyof UsageTotals)[]) sum[k] += t[k];
    models.set(model, sum);
  }
  return [...models].sort(([a], [b]) => compare(a, b)).map(([model, u]) => ({ model, ...u }));
}
