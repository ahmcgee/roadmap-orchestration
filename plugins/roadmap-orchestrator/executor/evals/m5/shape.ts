// The plan shape M5 needs from Phase 0 (plan §7 "Rung 4"): at least two milestones, a browser flow with its own design
// unit, and one milestone built on top of another. Shared by the driver's fail-fast and check.ts's `milestones-planned`.
// The slice and the milestone decomposition are the root agent's, so they are found by shape, never by id or by what
// each milestone drives: `browser` is the first milestone with a browser journey (its units all run after its design
// unit). The gating pair is `upstream` and `dependent`: a milestone at least one of whose units descends (through
// `after`) from a unit of another, upstream, milestone, the browser one preferred as upstream; either direction is a
// real gate (run 4, 2026-10-20, built the page on the keeper's settings). `held` lists those descending units: the
// milestone node holds each until `upstream` passes. The dependent milestone's other units are not held, by design.
import type { UnitId } from '../../src/core/ids.ts';
import { type Milestone, type PlanM1, designUnitOf, milestonesOf } from '../../src/input/plan.ts';

export type PlanShape =
  | Readonly<{ kind: 'ok'; browser: Milestone; upstream: Milestone; dependent: Milestone; held: readonly UnitId[] }>
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
  if (ms.length < 2) return { kind: 'off', problems: [`the plan has ${ms.length} milestones (${ms.map((m) => m.id).join(', ') || 'none'}), not two or more`] };
  const browser = ms.find((m) => m.journeys.some((j) => j.via === 'browser'));
  if (browser === undefined) return { kind: 'off', problems: [`no milestone has a browser journey (${ms.map((m) => `${m.id}: ${journeysOf(m)}`).join('; ')})`] };
  const problems: string[] = [];
  const design = designUnitOf(browser);
  if (design === null) problems.push(`${browser.id}'s design is supplied, not a design unit of the arc`);
  else {
    const before = browser.units.filter((u) => !ancestorsOf(plan, u).has(design));
    if (before.length > 0) problems.push(`${browser.id}'s units ${before.join(', ')} do not run after its design unit ${design}`);
  }
  const heldOf = (up: Milestone, m: Milestone): readonly UnitId[] => m.units.filter((u) => up.units.some((b) => ancestorsOf(plan, u).has(b)));
  const pairs = [browser, ...ms.filter((m) => m !== browser)].flatMap((up) => ms.filter((m) => m !== up && heldOf(up, m).length > 0).map((dependent) => ({ upstream: up, dependent })));
  const pair = pairs[0];
  if (pair === undefined) {
    problems.push(`no milestone descends from another (${ms.map((m) => `${m.id}: units ${m.units.join(', ')}`).join(' | ')})`);
  }
  return problems.length > 0 || pair === undefined ? { kind: 'off', problems } : { kind: 'ok', browser, ...pair, held: heldOf(pair.upstream, pair.dependent) };
}
