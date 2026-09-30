// The meter (plan "Commands, needs-user, meter", DESIGN §2.4 `spend`): per-role, per-seat and per-unit usage
// totals, folded from the log's `meter` and `usage-unavailable` facts, one per invocation. A call's usage
// counts whatever its outcome (a failed or malformed call still spent tokens: R29 "usage validity
// independent of outcome"), because the fact is written from result.json before the spawn's done, for
// every result.
//
// Smokes are charged to their backend, not to a seat (`bySmoke`), so seat spend is the units' and jobs' own. A job's
// lens or checkpoint call (M3, `MeterSubject.job`) is charged to its arc seat (`lens.arc`, `checkpoint.arc`): it
// counts in `byRole` and `bySeat` like a unit's call, and per job in `byJob` (never in `byUnit`).
//
// Totals are keyed by role (and seat tier) and routing revision, never by model: records carry `{role,
// tier, routingRev}` only. `byModel` derives a model view at render time from the revisions' routing tables
// and writes nothing. A fact names its seat's tier (lead ruling, 13b), so each seat total resolves to
// exactly one model.
import type { Event, Fact } from './core/events.ts';
import type { JobId, RoutingRev, UnitId } from './core/ids.ts';
import { type Backend, type ModelId, type Role, type RoutingTable, type SeatRef, atSeat, seatRef } from './routing/types.ts';

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

export type Meter = Readonly<{
  /** Ascending by role, then routingRev. */
  byRole: readonly RoleTotal[];
  /** Ascending by role, tier, routingRev: what `byModel` renders. */
  bySeat: readonly SeatTotal[];
  /** Ascending by unit, role, routingRev. */
  byUnit: readonly UnitTotal[];
  /** M3: the jobs' lens and checkpoint calls, ascending by job, role, routingRev. */
  byJob: readonly JobTotal[];
  /** Start-up smokes, ascending by backend, routingRev: in no role, seat or unit total. */
  bySmoke: readonly SmokeTotal[];
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
    if (s.type === 'job') {
      const jk = `${s.job} ${rk}`;
      jobs.set(jk, { job: s.job, role: s.role, routingRev: f.routingRev, ...add(jobs.get(jk) ?? ZERO, f) });
      continue;
    }
    const uk = `${s.unit} ${rk}`;
    units.set(uk, { unit: s.unit, role: s.role, routingRev: f.routingRev, ...add(units.get(uk) ?? ZERO, f) });
  }
  return { byRole: sorted(roles), bySeat: sorted(seats), byUnit: sorted(units), byJob: sorted(jobs), bySmoke: sorted(smokes) };
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
