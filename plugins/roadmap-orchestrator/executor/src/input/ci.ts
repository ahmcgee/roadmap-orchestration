import type { LaneDef, SpecM1 } from '../core/records.ts';
import type { PlanM1, PlanUnit } from './plan.ts';

/** Lane placement is an authoring constraint, also applied to executor-authored revisions. */
export function lanePlacementReasons(lane: LaneDef, unit?: PlanUnit): readonly string[] {
  const out: string[] = [];
  const local = lane.cadence === 'build' || lane.cadence === 'unit';
  const whole = lane.inputs?.some((p) => p === '**' || p === '**/*' || p === '*') ?? false;
  if (local && (lane.cost === 'expensive' || whole || (unit?.spike === undefined && (lane.placement === 'shared-resource' || lane.placement === 'cross-system')))) out.push(`lane ${lane.id}: expensive or whole-repo lanes must move to candidate`);
  if ((lane.cadence === 'batch' || lane.cadence === 'milestone') && lane.placement !== 'shared-resource' && lane.placement !== 'cross-system') out.push(`lane ${lane.id}: milestone lanes must declare shared-resource or cross-system placement; expensive local lanes move to candidate`);
  if (unit !== undefined && unit.spike === undefined && (lane.kind === 'integration' || lane.placement === 'shared-resource' || lane.placement === 'cross-system' || !local)) out.push(`unit ${unit.id}: integration lane ${lane.id} belongs on a candidate or milestone, except in a spike`);
  return out;
}
export function ciReasons(plan: PlanM1, specs: readonly SpecM1[]): readonly string[] {
  const out = plan.suite.lanes.flatMap((l) => lanePlacementReasons(l));
  for (const lane of [...plan.suite.lanes, ...specs.flatMap((s) => s.lanes)]) if (lane.capture !== undefined) {
    const pool = plan.resources.find((r) => r.name === lane.capture!.port);
    if (pool?.pool === undefined) out.push(`capture lane ${lane.id}: port resource ${lane.capture.port} must be a declared slot pool`);
    if (lane.capture.script[0] === undefined || lane.capture.script.every((a) => !a.includes('/') || a.startsWith('/'))) out.push(`capture lane ${lane.id}: declare a repo capture script path`);
  }
  for (const u of plan.units) if (u.spike !== undefined && (u.spike.question.trim() === '' || u.resources.length === 0)) out.push(`spike ${u.id}: resources and a non-empty question are required; new resources require the owner`);
  for (const s of specs) {
    const u = plan.units.find((u) => u.id === s.unit);
    for (const l of s.lanes.filter((l) => l.state === 'active')) out.push(...lanePlacementReasons(l, u));
    for (const id of s.forces ?? []) {
      const lane = plan.suite.lanes.find((l) => l.id === id);
      if (lane !== undefined && u?.spike === undefined && (lane.cost === 'expensive' || lane.kind === 'integration' || lane.placement === 'shared-resource' || lane.placement === 'cross-system')) out.push(`unit ${s.unit}: forced integration lane ${id} must move to candidate or milestone`);
    }
  }
  for (const m of plan.milestones ?? []) for (const id of m.lanes ?? []) {
    const lane = plan.suite.lanes.find((l) => l.id === id);
    if (lane === undefined) out.push(`milestone ${m.id}: unknown lane ${id}`);
    else if (!['batch', 'milestone'].includes(lane.cadence)) out.push(`milestone ${m.id}: lane ${id} must declare milestone cadence`);
  }
  return out;
}
