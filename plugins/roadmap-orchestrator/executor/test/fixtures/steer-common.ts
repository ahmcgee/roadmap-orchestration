// Shared by the steer tests and steer-child.ts: a unit-common arc's StageContext whose `plan()` and `routing(unit)`
// follow the log, as the executor's contexts do (src/executor.ts `contexts`): the plan in force, and each revision's
// routing resolved from its plan-applied provenance with the unit's layer on top. `contextFor`'s own never follow an
// apply, and `steer --class` is one.
import type { UnitId } from '../../src/core/ids.ts';
import { requirePlanInForce, routingProvenanceOf } from '../../src/input/inforce.ts';
import type { PlanUnit } from '../../src/input/plan.ts';
import type { StageContext } from '../../src/pipeline/dispatch.ts';
import { type ResolvedRouting, provenanceStack, resolveRouting } from '../../src/routing/layers.ts';
import type { ArcRun } from './unit-common.ts';

/** `r`'s stage context with `plan()` and `routing(unit)` read from the log at each call (default profile, no repo config). */
export function followingContext(r: ArcRun): StageContext {
  const inForce = () => requirePlanInForce(r.ctx.runDir, r.journal.view);
  const routing = (unit: UnitId | null): ResolvedRouting => {
    const { plan, fact } = inForce();
    // A revision recorded without provenance (rev 1 of these arcs) is rebuilt from its plan, as the executor does.
    const provenance = fact.routingProvenance ?? routingProvenanceOf({ profile: 'default', config: null }, plan);
    return resolveRouting(provenanceStack(provenance, plan.holistic !== undefined, unit));
  };
  return { ...r.ctx, plan: () => inForce().plan, routing };
}

/** The plan unit `id` as the plan in force now lists it. */
export function unitInForce(ctx: StageContext, id: string): PlanUnit {
  const u = ctx.plan().units.find((x) => x.id === id);
  if (u === undefined) throw new Error(`no unit ${id} in the plan in force`);
  return u;
}
