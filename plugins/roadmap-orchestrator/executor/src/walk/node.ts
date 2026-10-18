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

/**
 * The milestones each planned unit's node edges point at, by unit (only units with at least one): the milestones M one of
 * whose units (by lineage) the unit descends from through `after`, the unit not being one of M's own. In plan order.
 */
export function milestoneEdges(plan: PlanM1): ReadonlyMap<UnitId, readonly MilestoneId[]> {
  const milestones = milestonesOf(plan);
  if (milestones.length === 0) return new Map();
  const units = new Map(plan.units.map((u) => [u.id, u]));
  const root = (id: UnitId): UnitId => rootOf(units, id);
  // The dependency graph over lineage roots: every member's `after` edges belong to its lineage.
  const deps = new Map<UnitId, Set<UnitId>>();
  for (const u of plan.units) {
    const r = root(u.id);
    const set = deps.get(r) ?? new Set<UnitId>();
    for (const d of u.after) set.add(root(d));
    deps.set(r, set);
  }
  const ancestors = new Map<UnitId, ReadonlySet<UnitId>>();
  const ancestorsOf = (r: UnitId, path: ReadonlySet<UnitId> = new Set()): ReadonlySet<UnitId> => {
    const known = ancestors.get(r);
    if (known !== undefined) return known;
    if (path.has(r)) throw new Error(`the plan's after edges have a cycle through ${r}`);
    const out = new Set<UnitId>();
    for (const d of deps.get(r) ?? []) {
      out.add(d);
      for (const a of ancestorsOf(d, new Set([...path, r]))) out.add(a);
    }
    ancestors.set(r, out);
    return out;
  };
  const out = new Map<UnitId, MilestoneId[]>();
  for (const u of plan.units) {
    const r = root(u.id);
    if ((units.get(r)?.origin ?? 'planned') !== 'planned') continue;
    const above = ancestorsOf(r);
    for (const m of milestones) {
      const own = new Set(m.units.map(root));
      if (own.has(r) || ![...own].some((x) => above.has(x))) continue;
      out.set(u.id, [...(out.get(u.id) ?? []), m.id]);
    }
  }
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
  for (const [unit, ms] of milestoneEdges(plan)) {
    const open = ms.filter((m) => !milestonePassed(view, m));
    if (open.length > 0) out.set(unit, open);
  }
  return out;
}
