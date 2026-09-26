// The meter (plan "Commands, needs-user, meter", DESIGN §2.4 `spend`): per-role, per-seat and per-unit usage
// totals, folded from the log's `meter` and `usage-unavailable` facts, one per invocation. A call's usage
// counts whatever its outcome (a failed or malformed call still spent tokens: R29 "usage validity
// independent of outcome"), because the fact is written from result.json before the spawn's done, for
// every result.
//
// Totals are keyed by role (and seat tier) and routing revision, never by model: records carry `{role,
// tier, routingRev}` only. `byModel` derives a model view at render time from the revisions' routing tables
// and writes nothing. A fact names its seat's tier (lead ruling, 13b), so each seat total resolves to
// exactly one model.
import type { Event, Fact } from './core/events.ts';
import type { RoutingRev, UnitId } from './core/ids.ts';
import { type ModelId, type Role, type RoutingTable, type SeatRef, atSeat, seatRef } from './routing/types.ts';

export type UsageTotals = Readonly<{
  /** Invocations with a usage fact: `known` ones plus `unavailable` ones. */
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Calls whose usage was unavailable (no result, absent from the output, malformed). */
  unavailable: number;
}>;

export type RoleTotal = Readonly<{ role: Role; routingRev: RoutingRev }> & UsageTotals;
export type SeatTotal = SeatRef & Readonly<{ routingRev: RoutingRev }> & UsageTotals;
export type UnitTotal = Readonly<{ unit: UnitId; role: Role; routingRev: RoutingRev }> & UsageTotals;

export type Meter = Readonly<{
  /** Ascending by role, then routingRev. */
  byRole: readonly RoleTotal[];
  /** Ascending by role, tier, routingRev: what `byModel` renders. */
  bySeat: readonly SeatTotal[];
  /** Ascending by unit, role, routingRev. Smokes (no unit) appear only in `byRole` and `bySeat`. */
  byUnit: readonly UnitTotal[];
}>;

type UsageFact = Extract<Fact, { kind: 'meter' | 'usage-unavailable' }>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const ZERO: UsageTotals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unavailable: 0 };

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
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <T>(m: ReadonlyMap<string, T>): T[] => [...m].sort(([a], [b]) => compare(a, b)).map(([, t]) => t);

/** Folds the usage facts of a log, in order. The journal's fold already refuses a second fact per invocation. */
export function meterOf(events: Iterable<Event>): Meter {
  const roles = new Map<string, Mutable<RoleTotal>>();
  const seats = new Map<string, Mutable<SeatTotal>>();
  const units = new Map<string, Mutable<UnitTotal>>();
  for (const e of events) {
    if (e.type !== 'fact' || (e.fact.kind !== 'meter' && e.fact.kind !== 'usage-unavailable')) continue;
    const f = e.fact;
    const rk = `${f.role} ${f.routingRev}`;
    roles.set(rk, { role: f.role, routingRev: f.routingRev, ...add(roles.get(rk) ?? ZERO, f) });
    const sk = `${f.role} ${f.tier} ${f.routingRev}`;
    seats.set(sk, { ...seatRef(f.role, f.tier), routingRev: f.routingRev, ...add(seats.get(sk) ?? ZERO, f) });
    if (f.unit === null) continue;
    const uk = `${f.unit.unit} ${rk}`;
    units.set(uk, { unit: f.unit.unit, role: f.role, routingRev: f.routingRev, ...add(units.get(uk) ?? ZERO, f) });
  }
  return { byRole: sorted(roles), bySeat: sorted(seats), byUnit: sorted(units) };
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
