// The unit graph (M2): `after` edges with re-entry substituted (F15). A unit that another `reenters` is
// superseded: every edge on it stands for its lineage head. `effectiveGraph` builds that graph from a plan
// for validation (the classifier refuses an apply whose effective graph has a cycle, counting the edges
// that activate only after preparation); `effectiveDependency` resolves one edge at run time, where an edge
// moves to the head only once the head's preparation recorded an outcome.
import type { UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
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
