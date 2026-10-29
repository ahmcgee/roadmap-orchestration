// Ordering parks are design escalations with explicit blockers, never dependencies guessed from prose.
import type { ParkRecord } from '../core/events.ts';
import type { UnitId } from '../core/ids.ts';
import type { OrderingWait } from '../core/ordering.ts';
import type { StageContext } from '../pipeline/dispatch.ts';
import { effectiveGraph, findCycle } from '../schedule/graph.ts';

export const orderingOf = (park: ParkRecord | null): OrderingWait | null => park?.class === 'operator' ? park.ordering ?? null : null;

/** Check the declared units and the combined plan/park graph before accepting a judgment's wait. */
export function orderingReasons(ctx: StageContext, unit: UnitId, ordering: OrderingWait | null): readonly string[] {
  if (ordering === null) return [];
  const plan = ctx.plan();
  const view = ctx.journal.view;
  const reasons = ordering.blockers.flatMap((b) => {
    if (b === unit) return [`ordering blocker ${b} is the unit itself`];
    if (!plan.units.some((u) => u.id === b)) return [`ordering blocker ${b} is not a unit in the plan`];
    const status = view.unit(b).status;
    return status === 'cut' || status === 'superseded' ? [`ordering blocker ${b} is ${status}, so it cannot merge`] : [];
  });
  if (reasons.length > 0) return reasons;
  const graph = new Map(effectiveGraph(plan.units));
  for (const u of plan.units) {
    const wait = u.id === unit ? ordering : orderingOf(view.unit(u.id).park?.park ?? null);
    if (wait !== null) graph.set(u.id, [...(graph.get(u.id) ?? []), ...wait.blockers]);
  }
  const cycle = findCycle(graph);
  return cycle === null ? [] : [`ordering wait creates a dependency cycle: ${cycle.join(' -> ')}`];
}

/** The normal unpark transition restores the pre-park decision; its fold also verifies the exact park and merges. */
export function wakeOrdering(ctx: StageContext): void {
  const view = ctx.journal.view;
  for (const unit of ctx.plan().units) {
    const state = view.unit(unit.id);
    const park = state.park;
    if (state.status !== 'park-pending' || park === null) continue;
    const ordering = orderingOf(park.park);
    if (ordering !== null && ordering.blockers.every((b) => view.unit(b).status === 'retired')) {
      ctx.journal.fact({ kind: 'unparked', unit: unit.id, command: null, parkSeq: park.seq });
    }
  }
}
