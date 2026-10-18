// The plan shape M5 needs from Phase 0 (plan §7 "Rung 4"): two milestones, a browser flow with its own design unit and a
// shell milestone (the keeper's CLI and settings file) built on top of it. Shared by the driver's fail-fast and check.ts's
// `milestones-planned`. Milestone ids are the root agent's to choose, so the two are found by shape, never by id:
// `browser` is the first milestone with a browser journey, `shell` the first other milestone whose journeys are all
// shell journeys and whose every unit descends from a unit of `browser` (so the milestone node holds it until `browser`
// passes).
import type { UnitId } from '../../src/core/ids.ts';
import { type Milestone, type PlanM1, designUnitOf, milestonesOf } from '../../src/input/plan.ts';

export type PlanShape =
  | Readonly<{ kind: 'ok'; browser: Milestone; shell: Milestone }>
  | Readonly<{ kind: 'off'; problems: readonly string[] }>;

/** Every unit `unit` runs after, directly or transitively. */
export function ancestorsOf(plan: PlanM1, unit: UnitId): ReadonlySet<UnitId> {
  const after = new Map(plan.units.map((u) => [u.id, u.after]));
  const seen = new Set<UnitId>();
  const stack = [...(after.get(unit) ?? [])];
  while (stack.length > 0) {
    const u = stack.pop()!;
    if (seen.has(u)) continue;
    seen.add(u);
    stack.push(...(after.get(u) ?? []));
  }
  return seen;
}

const journeysOf = (m: Milestone): string => m.journeys.map((j) => `${j.id} ${j.via}`).join(', ');

export function planShape(plan: PlanM1): PlanShape {
  const ms = milestonesOf(plan);
  if (ms.length < 2) return { kind: 'off', problems: [`the plan has ${ms.length} milestones (${ms.map((m) => m.id).join(', ') || 'none'}), not two`] };
  const browser = ms.find((m) => m.journeys.some((j) => j.via === 'browser'));
  if (browser === undefined) return { kind: 'off', problems: [`no milestone has a browser journey (${ms.map((m) => `${m.id}: ${journeysOf(m)}`).join('; ')})`] };
  const problems: string[] = [];
  const design = designUnitOf(browser);
  if (design === null) problems.push(`${browser.id}'s design is supplied, not a design unit of the arc`);
  else {
    const before = browser.units.filter((u) => !ancestorsOf(plan, u).has(design));
    if (before.length > 0) problems.push(`${browser.id}'s units ${before.join(', ')} do not run after its design unit ${design}`);
  }
  const built = (m: Milestone): boolean => m.units.every((u) => browser.units.some((b) => ancestorsOf(plan, u).has(b)));
  const shell = ms.find((m) => m !== browser && m.journeys.every((j) => j.via === 'shell') && built(m));
  if (shell === undefined) {
    problems.push(`no shell milestone descends from ${browser.id} (${ms.filter((m) => m !== browser).map((m) => `${m.id}: ${journeysOf(m)}; units ${m.units.join(', ')}`).join(' | ')})`);
  }
  return problems.length > 0 || shell === undefined ? { kind: 'off', problems } : { kind: 'ok', browser, shell };
}
