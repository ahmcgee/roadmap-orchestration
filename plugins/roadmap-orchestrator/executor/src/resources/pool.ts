// Capacity as pools of instances (M2, A3; SCHEMAS.md "M2: Resources"): what a request asks for, which units
// grant it, and whether it can ever be granted.
//
//   named resource       `{name, probe, teardown}`        its own single instance, the name
//   estate pool          `{name, pool:{size}, ...}`        instances `<name>#1..size`; a request takes one
//   `@cpu`               `plan.capacity.cpu`               tokens `@cpu#1..N`, N default availableParallelism()
//   `integration-slot`   built in                          a publication's
//
// Allocation is pure over the fold's resource table: named resources and the slot must be free, each pool gives
// its lowest free instance, `@cpu` its lowest free tokens. A unit is *dirty* while a residue keeps it out of use:
// cleanup-failed, or held by the reclaim or sweep that is cleaning its residue. Dirty units are never granted
// and make a waiter environment-blocked (F8) when the request cannot be met from healthy capacity.
//
// Instance binding (F7): every workload of a holder gets `RESOURCE_INSTANCE_<POOL>=<n>` per pool instance it
// holds (`instanceEnv`). The same map is in its probes' and teardowns' recipes, so a residue's recorded teardown
// replays the exact binding.
import { availableParallelism } from 'node:os';
import { RECLAIM_HOLDERS } from '../core/events.ts';
import {
  type ResourceName, type ResourceUnit, type UnitId, CPU_POOL, INTEGRATION_SLOT, type LaneId, compareResourceUnits, cpuToken,
  parseResourceUnit, poolInstance,
} from '../core/ids.ts';
import type { LaneDef, SpecM1 } from '../core/records.ts';
import { type ResourceEntry, FREE_RESOURCE } from '../core/state.ts';
import type { PlanM1, PlanUnit, ResourceDecl } from '../input/plan.ts';
import { CPU_COST, type ResourceRequest } from '../schedule/types.ts';

// ---------------------------------------------------------------------------------------------------
// Declarations and costs

/** The size of the built-in `@cpu` pool: `plan.capacity.cpu`, else the host's parallelism. */
export function cpuCapacity(plan: PlanM1, host: number = availableParallelism()): number {
  return plan.capacity?.cpu ?? host;
}

/** `@cpu` tokens a build of `unit` takes. */
export const buildCpu = (unit: PlanUnit): number => unit.cpu ?? CPU_COST.build;

/** `@cpu` tokens a lane takes: its own `cpu`, else its tier's default. */
export const laneCpu = (lane: LaneDef): number => lane.cpu ?? CPU_COST.lane[lane.tier];

/** The declaration a named resource or a pool is declared by; the slot has none, so it is a bug here. */
export function declOf(plan: PlanM1, name: ResourceName): ResourceDecl {
  const decl = plan.resources.find((d) => d.name === name);
  if (decl === undefined) throw new Error(`resource ${name} is not declared in the plan of arc ${plan.arc}`);
  return decl;
}

/**
 * A request from declared names: pools (declared with `pool`) take one instance each, the rest are named, and
 * `integration-slot` makes it a publication. `cpu` tokens are the caller's.
 */
export function requestOf(plan: PlanM1, names: readonly ResourceName[], cpu: number): ResourceRequest {
  if (new Set(names).size !== names.length) throw new Error(`duplicate resources in ${JSON.stringify(names)}`);
  const declared = names.filter((n) => n !== INTEGRATION_SLOT);
  return {
    named: declared.filter((n) => declOf(plan, n).pool === undefined).sort(),
    pools: declared.filter((n) => declOf(plan, n).pool !== undefined).sort(),
    cpu,
    publication: names.includes(INTEGRATION_SLOT),
  };
}

// ---------------------------------------------------------------------------------------------------
// Instance binding (F7)

/** The variable a workload reads its instance of `pool` from: upper case, `-` → `_` (slugs have no `_`: injective). */
export const instanceEnvVar = (pool: ResourceName): string => `RESOURCE_INSTANCE_${pool.toUpperCase().replaceAll('-', '_')}`;

/**
 * `RESOURCE_INSTANCE_<POOL>=<n>` for each pool instance among `units` (a holder's whole set). Named resources,
 * `@cpu` tokens and the slot bind nothing. Steps that launch a holder's workloads (build, lanes) set this map
 * into the launch env; probe and teardown recipes carry it (src/resources/teardown.ts).
 */
export function instanceEnv(units: readonly ResourceUnit[]): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const u of units) {
    const p = parseResourceUnit(u);
    if (p.type !== 'instance') continue;
    const name = instanceEnvVar(p.pool);
    if (Object.hasOwn(env, name)) throw new Error(`two instances of pool ${p.pool} in one holder's set: ${JSON.stringify(units)}`);
    env[name] = String(p.n);
  }
  return env;
}

// ---------------------------------------------------------------------------------------------------
// Allocation over the table

const entryOf = (table: ReadonlyMap<ResourceUnit, ResourceEntry>, u: ResourceUnit): ResourceEntry => table.get(u) ?? FREE_RESOURCE;
const free = (e: ResourceEntry): boolean => e.pending === null && e.status.state === 'free';

/**
 * Kept out of use by a residue: cleanup-failed, or held by the retry or sweep reclaiming it (a residue is
 * disposed before its unit is released, F2). A stage's teardown in progress is not dirty: it releases soon.
 */
export function isDirty(e: ResourceEntry): boolean {
  if (e.status.state === 'free') return false;
  return e.status.state === 'cleanup-failed' || (RECLAIM_HOLDERS as readonly string[]).includes(e.status.holder.type);
}

export const poolUnits = (plan: PlanM1, pool: ResourceName): readonly ResourceUnit[] => {
  const size = declOf(plan, pool).pool?.size;
  if (size === undefined) throw new Error(`resource ${pool} is not a pool`);
  return Array.from({ length: size }, (_, i) => poolInstance(pool, i + 1));
};

const cpuUnits = (n: number): readonly ResourceUnit[] => Array.from({ length: n }, (_, i) => cpuToken(i + 1));

/** The units a request would take now (lock order), or the units that block it (every busy candidate). */
export type Allocation = Readonly<{ kind: 'units'; units: readonly ResourceUnit[] }> | Readonly<{ kind: 'busy'; busy: readonly ResourceUnit[] }>;

export function allocate(table: ReadonlyMap<ResourceUnit, ResourceEntry>, plan: PlanM1, request: ResourceRequest): Allocation {
  const units: ResourceUnit[] = [];
  const busy: ResourceUnit[] = [];
  const single = (u: ResourceUnit): void => void (free(entryOf(table, u)) ? units.push(u) : busy.push(u));
  for (const name of request.named) {
    if (declOf(plan, name).pool !== undefined) throw new Error(`resource ${name} is a pool; a request takes one of its instances, not the name`);
    single(name);
  }
  for (const pool of request.pools) {
    const all = poolUnits(plan, pool);
    const first = all.find((u) => free(entryOf(table, u)));
    if (first === undefined) busy.push(...all);
    else units.push(first);
  }
  if (request.cpu > 0) {
    const all = cpuUnits(cpuCapacity(plan));
    if (request.cpu > all.length) throw new Error(`a request for ${request.cpu} ${CPU_POOL} tokens exceeds the pool's ${all.length}; plan load refuses it (overCapacity)`);
    const got = all.filter((u) => free(entryOf(table, u))).slice(0, request.cpu);
    if (got.length < request.cpu) busy.push(...all.filter((u) => !free(entryOf(table, u))));
    else units.push(...got);
  }
  if (request.publication) single(INTEGRATION_SLOT);
  if (units.length + busy.length === 0) throw new Error('an empty resource request');
  return busy.length > 0 ? { kind: 'busy', busy: [...busy].sort(compareResourceUnits) } : { kind: 'units', units: units.sort(compareResourceUnits) };
}

/**
 * Environment-blocked (F8): the request cannot be met from healthy capacity until a residue is disposed: a
 * named resource it wants is dirty, or a pool it wants has no healthy instance. Such a waiter is set aside:
 * never granted, never blocking backfill. `@cpu` tokens and the slot have no teardown, so they are never dirty.
 */
export function envBlocked(table: ReadonlyMap<ResourceUnit, ResourceEntry>, plan: PlanM1, request: ResourceRequest): boolean {
  if (request.named.some((n) => isDirty(entryOf(table, n)))) return true;
  return request.pools.some((p) => poolUnits(plan, p).every((u) => isDirty(entryOf(table, u))));
}

/** Two requests compete: a shared named resource, a shared pool (`@cpu` included), or both publications. */
export function overlaps(a: ResourceRequest, b: ResourceRequest): boolean {
  return a.named.some((n) => b.named.includes(n))
    || a.pools.some((p) => b.pools.includes(p))
    || (a.cpu > 0 && b.cpu > 0)
    || (a.publication && b.publication);
}

// ---------------------------------------------------------------------------------------------------
// Over capacity (plan load and apply)

/** `plan-invalid{over-capacity}`'s problem: a request that asks for more of a pool than it has. */
export type OverCapacity = Readonly<{
  type: 'over-capacity'; unit: UnitId | null; lane: LaneId | null; resource: ResourceName | typeof CPU_POOL; requested: number; total: number;
}>;

/**
 * Every request of `plan` over total capacity, as `plan-invalid` rows (src/preflight/checks.ts wires it).
 * `capacity.cpu`: the `@cpu` pool's size (`cpuCapacity`). `specs`: the units' loaded specs (their lanes).
 *
 * Only `@cpu` can be exceeded: a request takes one instance per pool and a pool has at least one, and a
 * judgment takes a single token. So the rows are a build's `unit.cpu ?? 4` and each active lane's cost (suite
 * lanes with unit null) against `capacity.cpu`.
 */
export function overCapacity(
  plan: PlanM1,
  capacity: Readonly<{ cpu: number }>,
  specs: ReadonlyMap<UnitId, SpecM1>,
): readonly Readonly<{ kind: 'plan-invalid'; problem: OverCapacity }>[] {
  const rows: OverCapacity[] = [];
  const check = (unit: UnitId | null, lane: LaneId | null, requested: number): void => {
    if (requested > capacity.cpu) rows.push({ type: 'over-capacity', unit, lane, resource: CPU_POOL, requested, total: capacity.cpu });
  };
  for (const lane of plan.suite.lanes) check(null, lane.id, laneCpu(lane));
  for (const unit of plan.units) {
    check(unit.id, null, buildCpu(unit));
    for (const lane of specs.get(unit.id)?.lanes ?? []) if (lane.state === 'active') check(unit.id, lane.id, laneCpu(lane));
  }
  return rows.map((problem) => ({ kind: 'plan-invalid', problem }));
}
