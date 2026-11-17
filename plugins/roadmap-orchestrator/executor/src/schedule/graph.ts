// The unit graph (M2): `after` edges with re-entry substituted (F15). A unit that another `reenters` is
// superseded: every edge on it stands for its lineage head. `effectiveGraph` builds that graph from a plan
// for validation (the classifier refuses an apply whose effective graph has a cycle, counting the edges
// that activate only after preparation); `effectiveDependency` resolves one edge at run time, where an edge
// moves to the head only once the head's preparation recorded an outcome. Arc feedback 2026-10-15: `holdCycle`, the
// cycle of approved repairs each held at its candidate by a finding another of them owns (src/schedule/scheduler.ts).
// dev.82 (E5b): `joinedCoRepairers`, two direct repairers of one finding joined through `after`, which never batch: the
// classifier refuses them, and the scheduler raises an adopted plan's as a blocking plan-defect.
import { type FindingId, type UnitId, canonicalIds } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { RepairRef } from '../core/records.ts';
import type { PlanUnit } from '../input/plan.ts';

export type GraphUnit = Pick<PlanUnit, 'id' | 'after' | 'reenters'>;

/** Old unit → the unit that re-enters it. Throws on two re-entries of one unit (a lineage is a chain). */
function successors(units: readonly GraphUnit[]): ReadonlyMap<UnitId, UnitId> {
  const next = new Map<UnitId, UnitId>();
  for (const u of units) {
    if (u.reenters === undefined) continue;
    const other = next.get(u.reenters.unit);
    if (other !== undefined) throw new Error(`units ${other} and ${u.id} both re-enter ${u.reenters.unit}; a lineage is a chain`);
    next.set(u.reenters.unit, u.id);
  }
  return next;
}

/** The head of `id`'s lineage in the plan: `id` itself unless a unit re-enters it, transitively. */
export function lineageHead(units: readonly GraphUnit[], id: UnitId): UnitId {
  const next = successors(units);
  const seen = new Set<UnitId>([id]);
  let head = id;
  for (let n = next.get(head); n !== undefined; n = next.get(head)) {
    if (seen.has(n)) throw new Error(`the lineage of ${id} re-enters itself at ${n}`);
    seen.add(n);
    head = n;
  }
  return head;
}

/**
 * The effective graph: every unit no other re-enters, mapped to its dependencies with each superseded unit
 * replaced by its lineage head (sorted, unique; an edge a unit would have on itself through its own lineage
 * is kept, so the cycle check sees it).
 */
export function effectiveGraph(units: readonly GraphUnit[]): ReadonlyMap<UnitId, readonly UnitId[]> {
  const superseded = new Set(successors(units).keys());
  const graph = new Map<UnitId, readonly UnitId[]>();
  for (const u of units) {
    if (superseded.has(u.id)) continue;
    graph.set(u.id, [...new Set(u.after.map((d) => lineageHead(units, d)))].sort());
  }
  return graph;
}

/** A dependency cycle of `graph` as the units along it, first repeated last, or null when it is acyclic. */
export function findCycle(graph: ReadonlyMap<UnitId, readonly UnitId[]>): readonly UnitId[] | null {
  const state = new Map<UnitId, 'visiting' | 'done'>();
  const path: UnitId[] = [];
  const visit = (u: UnitId): readonly UnitId[] | null => {
    const s = state.get(u);
    if (s === 'done') return null;
    if (s === 'visiting') return [...path.slice(path.indexOf(u)), u];
    state.set(u, 'visiting');
    path.push(u);
    for (const d of graph.get(u) ?? []) {
      const cycle = visit(d);
      if (cycle !== null) return cycle;
    }
    path.pop();
    state.set(u, 'done');
    return null;
  };
  for (const u of [...graph.keys()].sort()) {
    const cycle = visit(u);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * Arc feedback 2026-10-15: the findings of a cycle of finding holds, in canonical order, or null. `blocked`: each approved
 * repair waiting at its candidate that an active P1 holds (G10), with that finding and its owner, the repair fixing it on
 * its branch. A cycle (each unit held by a finding the next one owns) can only publish together: the findings along it.
 */
export function holdCycle(blocked: ReadonlyMap<UnitId, Readonly<{ finding: FindingId; owner: UnitId }>>): readonly FindingId[] | null {
  const cycle = findCycle(new Map([...blocked].map(([u, b]) => [u, [b.owner]])));
  return cycle === null ? null : canonicalIds(cycle.slice(0, -1).map((u) => blocked.get(u)!.finding));
}

/** dev.82 (E5b): two direct repairers of one finding, `path` from the dependent (first) to its dependency (last). */
export type CoRepairEdge = Readonly<{ finding: FindingId; path: readonly UnitId[] }>;

/**
 * dev.82 (E5b): the co-repairers joined through `after`. Each approved direct repairer of a finding is held at its
 * candidate until every other one waits there (R7), so a co-repairer that depends on another (transitively, over
 * `graph`'s edges through `open` units) waits on a merge that never comes. `repairers`: each finding's live direct
 * repairers. Each joined pair once, by its shortest dependency path.
 */
export function coRepairEdges(graph: ReadonlyMap<UnitId, readonly UnitId[]>, repairers: ReadonlyMap<FindingId, readonly UnitId[]>, open: (u: UnitId) => boolean): readonly CoRepairEdge[] {
  const out: CoRepairEdge[] = [];
  for (const [finding, units] of [...repairers].sort(([a], [b]) => a.localeCompare(b))) {
    const co = new Set(units);
    for (const from of [...co].sort()) {
      const via = new Map<UnitId, UnitId>();
      const queue: UnitId[] = [from];
      for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
        for (const d of graph.get(at) ?? []) {
          if (d === from || via.has(d) || !open(d)) continue;
          via.set(d, at);
          if (co.has(d)) {
            const path = [d];
            for (let p = at; p !== from; p = via.get(p)!) path.unshift(p);
            out.push({ finding, path: [from, ...path] });
          } else queue.push(d);
        }
      }
    }
  }
  return out;
}

/**
 * dev.82 (E5b): `coRepairEdges` over `units` (a plan's): the live repairers are the units neither cut nor terminal nor
 * published, by the findings `repairsOf` names (obligation repairs never batch).
 */
export function joinedCoRepairers(view: JournalView, units: readonly PlanUnit[], repairsOf: (u: PlanUnit) => readonly RepairRef[]): readonly CoRepairEdge[] {
  const published = new Set(view.publications().map((p) => p.unit));
  const open = new Set(units.filter((u) => u.cut === undefined && !published.has(u.id) && !['retired', 'cut', 'superseded'].includes(view.unit(u.id).status)).map((u) => u.id));
  const repairers = new Map<FindingId, UnitId[]>();
  for (const u of units) {
    if (!open.has(u.id)) continue;
    for (const r of repairsOf(u)) if (r.startsWith('F-')) repairers.set(r as FindingId, [...repairers.get(r as FindingId) ?? [], u.id]);
  }
  return coRepairEdges(effectiveGraph(units), new Map([...repairers].filter(([, us]) => us.length > 1)), (u) => open.has(u));
}

/** dev.82 (E5b): one joined pair in a sentence. */
export function coRepairText(e: CoRepairEdge): string {
  return `${e.path[0]} and ${e.path.at(-1)} both repair ${e.finding} directly, and ${e.path[0]} depends on ${e.path.at(-1)} through \`after\` (${e.path.join(' → ')}): `
    + `${e.path.at(-1)} is held at its candidate until ${e.path[0]} waits there too, which waits on its merge`;
}

/**
 * The unit an edge on `dep` waits for now: `dep`, or, once `dep` is superseded and its successor's
 * preparation recorded an outcome, that successor's (transitively). Before that the edge stays on the
 * superseded unit, which never merges, so its dependents wait (D1).
 */
export function effectiveDependency(view: JournalView, dep: UnitId): UnitId {
  let at = dep;
  for (;;) {
    const u = view.unit(at);
    if (u.status !== 'superseded' || u.supersededBy === null) return at;
    if (view.unit(u.supersededBy).lineage?.prepared !== true) return at;
    at = u.supersededBy;
  }
}
