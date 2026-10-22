// The systems map (dev.17, DESIGN-1.0.md §4 "Lane topology"; SCHEMAS.md "dev.17"): what the repo is made of, so a lane
// runs where a change can reach it and is reused where none did. Committed by the owner in `.roadmap/config.json`
// `systemsMap`; a start and every apply record the map of the repo config the executor read (`plan-applied.systemsMap`,
// null when the config has none), and every reader takes it from the revision in force (`systemsMapInForce`).
//
//   "systemsMap": {
//     "systems":   { "<system>": { "paths": [<glob>...], "tests"?: [<glob>...], "dependsOn"?: [<system>...] } },
//     "shared"?:   [ { "paths": [<glob>...], "dependents": [<system>...] } ],     lockfile, build config: touching one touches its dependents
//     "contracts"?: { "<repo path>": [<system>...] },                              a contract's consuming systems
//     "docs"?:     [<glob>...]                                                    the docs class: no lane's input unless it lists `docs`
//   }
//
// A path's class (`pathClass`): the systems whose `paths` or `tests` match it, the dependents of a shared area matching it
// and the consumers of a contract it is, all together; else `docs` when a docs glob matches it; else `unmapped`.
// `dependsOn` closes it over dependents: a system touched touches every system that depends on it, transitively.
//
// Selection (`laneSelected`): a lane listing systems runs on a diff when a path of it is unmapped (fail-safe), or its class
// meets the lane's systems (`docs` included when the lane lists it); a lane listing none always runs. A docs-only diff
// selects no lane that does not list `docs`.
//
// A lane's input (`inLaneInput`), what its reuse key hashes (src/pipeline/reusekey.ts): every unmapped path and every path
// whose class meets the lane's systems closed over what they depend on (a lane listing none: every path but the docs
// class), the docs class when the lane lists `docs`. Paths that belong to other systems only are left out, so a change
// there keeps the lane's key.
import { type LaneId, type SystemName, DOCS_SYSTEM, systemName } from '../core/ids.ts';
import type { LaneDef } from '../core/records.ts';
import { type Read, Fields, SchemaError, arrayOf, assertUnique, object } from '../core/validate.ts';
import { type RepoPath, type RepoPattern, matchesPattern, repoPath, repoPattern } from '../core/values.ts';
import { systemsMapDefault } from '../core/upgrade.ts';

export type SystemDef = Readonly<{ paths: readonly RepoPattern[]; tests: readonly RepoPattern[]; dependsOn: readonly SystemName[] }>;
export type SharedArea = Readonly<{ paths: readonly RepoPattern[]; dependents: readonly SystemName[] }>;
export type SystemsMap = Readonly<{
  systems: Readonly<Record<SystemName, SystemDef>>;
  shared: readonly SharedArea[];
  contracts: Readonly<Record<RepoPath, readonly SystemName[]>>;
  docs: readonly RepoPattern[];
}>;

const patterns = arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true });
const names = arrayOf((v, p) => systemName(v, p), { nonEmpty: true });

const systemDef = object((f): SystemDef => ({
  paths: f.get('paths', patterns), tests: f.optional('tests', patterns) ?? [], dependsOn: f.optional('dependsOn', names) ?? [],
}));

/** Reads `systemsMap` (see the header): every name it uses declared, `docs` never declared as a system. */
export const systemsMap: Read<SystemsMap> = object((f) => {
  const systems = f.get('systems', (value, path) => {
    const g = new Fields(value, path);
    const out: Record<SystemName, SystemDef> = {};
    const keys = Object.keys(value as object);
    if (keys.length === 0) throw new SchemaError(path, 'at least one system', value);
    for (const key of keys) {
      const name = systemName(key, `${path}.${key}`);
      if (name === DOCS_SYSTEM) throw new SchemaError(`${path}.${key}`, `a system name other than ${DOCS_SYSTEM} (the docs class)`, key);
      out[name] = g.get(key, systemDef);
    }
    g.end();
    return out;
  });
  const shared = f.optional('shared', arrayOf(object((g): SharedArea => ({ paths: g.get('paths', patterns), dependents: g.get('dependents', names) })))) ?? [];
  const contracts = f.optional('contracts', (value, path) => {
    const g = new Fields(value, path);
    const out: Record<RepoPath, readonly SystemName[]> = {};
    for (const key of Object.keys(value as object)) out[repoPath(key, `${path}.${key}`)] = g.get(key, names);
    g.end();
    return out;
  }) ?? {};
  const docs = f.optional('docs', patterns) ?? [];
  const known = (name: SystemName, at: string): void => {
    if (!Object.hasOwn(systems, name)) throw new SchemaError(at, 'a system the map declares', name);
  };
  for (const [name, def] of Object.entries(systems) as [SystemName, SystemDef][]) {
    assertUnique(def.dependsOn, (d) => d, `${f.path}.systems.${name}.dependsOn`);
    def.dependsOn.forEach((d, i) => known(d, `${f.path}.systems.${name}.dependsOn[${i}]`));
  }
  shared.forEach((s, i) => s.dependents.forEach((d, j) => known(d, `${f.path}.shared[${i}].dependents[${j}]`)));
  for (const [path, consumers] of Object.entries(contracts)) consumers.forEach((c, j) => known(c, `${f.path}.contracts.${path}[${j}]`));
  return { systems, shared, contracts, docs };
});

/**
 * The systems map of the revision in force: what its `plan-applied` recorded (null: the repo config had none), or none for
 * a revision a dev.16 executor applied (`systemsMapDefault`, logged).
 */
export function systemsMapInForce(applied: Readonly<{ systemsMap?: SystemsMap | null }> | null): SystemsMap | null {
  if (applied === null) return null;
  return applied.systemsMap === undefined ? systemsMapDefault() : applied.systemsMap;
}

/** What a path belongs to: systems (with their dependents), the docs class, or nothing (`unmapped`). */
export type PathClass = Readonly<{ kind: 'systems'; systems: ReadonlySet<SystemName> }> | Readonly<{ kind: 'docs' }> | Readonly<{ kind: 'unmapped' }>;

/** Every system that depends on one of `systems`, transitively, with them. */
export function dependentsClosure(map: SystemsMap, systems: Iterable<SystemName>): ReadonlySet<SystemName> {
  const out = new Set(systems);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, def] of Object.entries(map.systems) as [SystemName, SystemDef][]) {
      if (!out.has(name) && def.dependsOn.some((d) => out.has(d))) {
        out.add(name);
        grew = true;
      }
    }
  }
  return out;
}

/** Every system one of `systems` depends on, transitively, with them. */
export function dependenciesClosure(map: SystemsMap, systems: Iterable<SystemName>): ReadonlySet<SystemName> {
  const out = new Set<SystemName>();
  const visit = (s: SystemName): void => {
    if (out.has(s) || s === DOCS_SYSTEM) return;
    out.add(s);
    for (const d of map.systems[s]?.dependsOn ?? []) visit(d);
  };
  for (const s of systems) visit(s);
  return out;
}

const CLASSES = new WeakMap<SystemsMap, Map<string, PathClass>>();

/** A path's class under `map` (see the header), memoised per map. */
export function pathClass(map: SystemsMap, path: RepoPath): PathClass {
  const memo = CLASSES.get(map) ?? new Map<string, PathClass>();
  CLASSES.set(map, memo);
  const known = memo.get(path);
  if (known !== undefined) return known;
  const hit = (globs: readonly RepoPattern[]): boolean => globs.some((g) => matchesPattern(path, g));
  const direct = new Set<SystemName>();
  for (const [name, def] of Object.entries(map.systems) as [SystemName, SystemDef][]) if (hit(def.paths) || hit(def.tests)) direct.add(name);
  for (const s of map.shared) if (hit(s.paths)) for (const d of s.dependents) direct.add(d);
  for (const c of map.contracts[path] ?? []) direct.add(c);
  const out: PathClass = direct.size > 0 ? { kind: 'systems', systems: dependentsClosure(map, direct) } : hit(map.docs) ? { kind: 'docs' } : { kind: 'unmapped' };
  memo.set(path, out);
  return out;
}

/** Whether `lane` runs on a diff of `paths` (see the header). No map: every lane runs. */
export function laneSelected(map: SystemsMap | null, lane: Pick<LaneDef, 'systems'>, paths: readonly RepoPath[]): boolean {
  if (map === null || lane.systems === undefined) return true;
  const wanted = new Set<SystemName>(lane.systems);
  return paths.some((p) => {
    const c = pathClass(map, p);
    if (c.kind === 'unmapped') return true;
    if (c.kind === 'docs') return wanted.has(DOCS_SYSTEM);
    return [...c.systems].some((s) => wanted.has(s));
  });
}

/** The selected lanes of `lanes` on a diff of `paths`, in order. */
export const selectedLanes = <L extends LaneDef>(map: SystemsMap | null, lanes: readonly L[], paths: readonly RepoPath[]): readonly L[] =>
  lanes.filter((l) => laneSelected(map, l, paths));

/** A predicate over repo paths: whether a path is in `lane`'s input (see the header). No map: every path. */
export function laneInput(map: SystemsMap | null, lane: Pick<LaneDef, 'systems'>): (path: RepoPath) => boolean {
  if (map === null) return () => true;
  if (lane.systems === undefined) return (p) => pathClass(map, p).kind !== 'docs';
  const docs = lane.systems.includes(DOCS_SYSTEM);
  const closure = dependenciesClosure(map, lane.systems);
  return (p) => {
    const c = pathClass(map, p);
    if (c.kind === 'unmapped') return true;
    if (c.kind === 'docs') return docs;
    return [...c.systems].some((s) => closure.has(s));
  };
}

/**
 * The leaf test files of `lane` among `paths` (src/pipeline/lanes.ts `testOnlyRun`): paths matching a `tests` glob of the
 * lane's systems closed over their dependencies (a lane listing none: of every system). Helpers, fixtures and test
 * config match no `tests` glob, so they are never leaf test files.
 */
export function laneTestFiles(map: SystemsMap, lane: Pick<LaneDef, 'systems'>, paths: readonly RepoPath[]): readonly RepoPath[] {
  const systems = lane.systems === undefined ? Object.keys(map.systems) as SystemName[] : [...dependenciesClosure(map, lane.systems)];
  const globs = systems.flatMap((s) => map.systems[s]?.tests ?? []);
  return paths.filter((p) => globs.some((g) => matchesPattern(p, g)));
}

/**
 * Phase 0 (dev.17): every system a lane lists that the map does not declare (`docs` needs a docs class), as `[lane, system]`;
 * with no map, every system any lane lists.
 */
export function unknownLaneSystems(map: SystemsMap | null, lanes: readonly Pick<LaneDef, 'id' | 'systems'>[]): readonly Readonly<{ lane: LaneId; system: SystemName }>[] {
  return lanes.flatMap((l) => (l.systems ?? []).filter((s) => map === null || (s === DOCS_SYSTEM ? map.docs.length === 0 : !Object.hasOwn(map.systems, s)))
    .map((system) => ({ lane: l.id, system })));
}
