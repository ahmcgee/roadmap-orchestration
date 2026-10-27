// The milestone node (dev.13, plan §3; SCHEMAS.md "dev.13", "The milestone node"): a milestone is a node in the DAG. A
// planned unit that descends from any unit of milestone M through `after` edges, and is not one of M's units, waits on
// M's node until `milestone-passed{M}`: the readiness of an unmerged `after` dependency (src/schedule/ready.ts). Code
// inserts the edge; the plan author writes nothing. `status` shows it (an `EdgeView` of type `milestone`).
//
// Lineages: every unit stands for its lineage, so a re-entry of one of M's units is one of M's units, an edge on a
// superseded unit is an edge on its lineage, and a re-entry of a gated unit is gated. Exempt: units whose lineage root is
// not planned (a repair, a checkpoint admit, a polish unit): fixes and polish never wait on a node.
//
// Pure over the plan in force and the log's view.
import type { MilestoneId, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type PlanM1, type PlanUnit, milestonesOf } from '../input/plan.ts';

/** The original unit of `id`'s lineage in the plan: `id` unless it re-enters another unit, transitively. */
function rootOf(units: ReadonlyMap<UnitId, PlanUnit>, id: UnitId): UnitId {
  const seen = new Set<UnitId>();
  let at = id;
  for (let u = units.get(at); u?.reenters !== undefined; u = units.get(at)) {
    if (seen.has(at)) throw new Error(`the lineage of ${id} re-enters itself at ${at}`);
    seen.add(at);
    at = u.reenters.unit;
  }
  return at;
}

const edgeCache = new WeakMap<PlanM1, ReadonlyMap<UnitId, readonly MilestoneId[]>>();

/**
 * The milestones each planned unit's node edges point at, by unit (only units with at least one): the milestones M one of
 * whose units (by lineage) the unit descends from through `after`, the unit not being one of M's own. In plan order.
 */
export function milestoneEdges(plan: PlanM1): ReadonlyMap<UnitId, readonly MilestoneId[]> {
  const cached = edgeCache.get(plan);
  if (cached) return cached;
  const milestones = milestonesOf(plan);
  if (milestones.length === 0) {
    const empty = new Map<UnitId, readonly MilestoneId[]>(); edgeCache.set(plan, empty); return empty;
  }
  const units = new Map(plan.units.map((u) => [u.id, u]));
  const roots = new Map<UnitId, UnitId>();
  const root = (id: UnitId): UnitId => {
    const known = roots.get(id);
    if (known !== undefined) return known;
    const r = rootOf(units, id); roots.set(id, r); return r;
  };
  // The dependency graph over lineage roots: every member's `after` edges belong to its lineage.
  const deps = new Map<UnitId, Set<UnitId>>();
  for (const u of plan.units) {
    const r = root(u.id);
    const set = deps.get(r) ?? new Set<UnitId>();
    for (const d of u.after) set.add(root(d));
    deps.set(r, set);
  }
  const memberships = milestones.map((m) => {
    const roots = m.units.map(root);
    return { id: m.id, roots, own: new Set(roots) };
  });
  const ancestors = new Map<UnitId, ReadonlySet<UnitId>>();
  const path = new Set<UnitId>();
  const ancestorsOf = (r: UnitId): ReadonlySet<UnitId> => {
    const known = ancestors.get(r);
    if (known !== undefined) return known;
    if (path.has(r)) throw new Error(`the plan's after edges have a cycle through ${r}`);
    path.add(r);
    const out = new Set<UnitId>();
    for (const d of deps.get(r) ?? []) {
      out.add(d);
      for (const a of ancestorsOf(d)) out.add(a);
    }
    path.delete(r);
    ancestors.set(r, out);
    return out;
  };
  const out = new Map<UnitId, MilestoneId[]>();
  for (const u of plan.units) {
    const r = root(u.id);
    if ((units.get(r)?.origin ?? 'planned') !== 'planned') continue;
    const above = ancestorsOf(r);
    for (const m of memberships) {
      if (m.own.has(r) || !m.roots.some((x) => above.has(x))) continue;
      const edges = out.get(u.id) ?? []; edges.push(m.id); out.set(u.id, edges);
    }
  }
  edgeCache.set(plan, out);
  return out;
}

/** Whether milestone `m`'s node passed (`milestone-passed{m}` is in the log). */
export const milestonePassed = (view: JournalView, m: MilestoneId): boolean =>
  view.walkFacts().some((x) => x.fact.kind === 'milestone-passed' && x.fact.milestone === m);

/** The seq of `milestone-passed{m}`, or null before it. */
export const milestonePassedSeq = (view: JournalView, m: MilestoneId): number | null =>
  view.walkFacts().find((x) => x.fact.kind === 'milestone-passed' && x.fact.milestone === m)?.seq ?? null;

/**
 * The readiness half (src/schedule/ready.ts): for each unit of the plan, the milestone nodes it waits on now (its node
 * edges whose milestone has not passed), in plan order; a unit with none is absent.
 */
export function milestoneWaits(view: JournalView, plan: PlanM1): ReadonlyMap<UnitId, readonly MilestoneId[]> {
  const out = new Map<UnitId, readonly MilestoneId[]>();
  const edges = milestoneEdges(plan);
  if (edges.size === 0) return out;
  const passed = new Set(view.walkFacts().flatMap(({ fact }) => fact.kind === 'milestone-passed' ? [fact.milestone] : []));
  for (const [unit, ms] of edges) {
    const open = ms.filter((m) => !passed.has(m));
    if (open.length > 0) out.set(unit, open);
  }
  return out;
}
