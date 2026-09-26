// The meter (plan "Commands, needs-user, meter", DESIGN §2.4 `spend`): per-role and per-unit usage totals,
// folded from the log's `meter` and `usage-unavailable` facts, one per invocation. A call's usage counts
// whatever its outcome (a failed or malformed call still spent tokens: R29 "usage validity independent of
// outcome"), because the fact is written from result.json before the spawn's done, for every result.
//
// Totals are keyed by role and routing revision, never by model: records carry `{role, routingRev}` only.
// `byModel` derives a model view at render time from the revisions' routing tables and writes nothing. A
// fact does not carry the risk tier its seat resolved at, so a (role, routingRev) whose tiers name more than
// one model cannot be attributed to one: it is reported as ambiguous with the candidate models.
import type { Event, Fact } from './core/events.ts';
import type { RoutingRev, UnitId } from './core/ids.ts';
import { type ModelId, RISK_TIERS, type Role, type RoutingTable } from './routing/types.ts';

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
export type UnitTotal = Readonly<{ unit: UnitId; role: Role; routingRev: RoutingRev }> & UsageTotals;

export type Meter = Readonly<{
  /** Ascending by role, then routingRev. */
  byRole: readonly RoleTotal[];
  /** Ascending by unit, role, routingRev. Smokes (no unit) appear only in `byRole`. */
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

/** Folds the usage facts of a log, in order. The journal's fold already refuses a second fact per invocation. */
export function meterOf(events: Iterable<Event>): Meter {
  const roles = new Map<string, Mutable<RoleTotal>>();
  const units = new Map<string, Mutable<UnitTotal>>();
  for (const e of events) {
    if (e.type !== 'fact' || (e.fact.kind !== 'meter' && e.fact.kind !== 'usage-unavailable')) continue;
    const f = e.fact;
    const rk = `${f.role} ${f.routingRev}`;
    roles.set(rk, { role: f.role, routingRev: f.routingRev, ...add(roles.get(rk) ?? ZERO, f) });
    if (f.unit === null) continue;
    const uk = `${f.unit.unit} ${rk}`;
    units.set(uk, { unit: f.unit.unit, role: f.role, routingRev: f.routingRev, ...add(units.get(uk) ?? ZERO, f) });
  }
  return {
    byRole: [...roles].sort(([a], [b]) => compare(a, b)).map(([, t]) => t),
    byUnit: [...units].sort(([a], [b]) => compare(a, b)).map(([, t]) => t),
  };
}

export type ModelTotal =
  | Readonly<{ kind: 'model'; model: ModelId }> & UsageTotals
  /** A (role, routingRev) whose tiers resolve to several models: which one served a call is not recorded. */
  | Readonly<{ kind: 'ambiguous'; role: Role; routingRev: RoutingRev; models: readonly ModelId[] }> & UsageTotals;

/**
 * The render-time model view of per-role totals. `tables` maps each routing revision in the log to its
 * resolved table; a revision missing from it is a caller bug and throws.
 */
export function byModel(totals: readonly RoleTotal[], tables: ReadonlyMap<RoutingRev, RoutingTable>): readonly ModelTotal[] {
  const models = new Map<ModelId, Mutable<UsageTotals>>();
  const ambiguous: ModelTotal[] = [];
  for (const t of totals) {
    const table = tables.get(t.routingRev);
    if (table === undefined) throw new Error(`byModel: no routing table for revision ${t.routingRev}`);
    const seated = [...new Set(RISK_TIERS.map((tier) => table[t.role][tier].model))].sort(compare);
    const usage: UsageTotals = { calls: t.calls, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, unavailable: t.unavailable };
    const only = seated.length === 1 ? seated[0] : undefined;
    if (only === undefined) {
      ambiguous.push({ kind: 'ambiguous', role: t.role, routingRev: t.routingRev, models: seated, ...usage });
      continue;
    }
    const sum = models.get(only) ?? { ...ZERO };
    for (const k of Object.keys(ZERO) as (keyof UsageTotals)[]) sum[k] += usage[k];
    models.set(only, sum);
  }
  return [
    ...[...models].sort(([a], [b]) => compare(a, b)).map(([model, u]): ModelTotal => ({ kind: 'model', model, ...u })),
    ...ambiguous,
  ];
}
