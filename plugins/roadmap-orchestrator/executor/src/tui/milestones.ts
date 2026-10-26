import type { MilestoneView } from '../status.ts';
import type { Display } from './types.ts';

function lineage(display: Display, unit: string): string[] {
  const members = [unit];
  while (true) {
    const next = display.status.units.find((u) => u.unit === members.at(-1))?.supersededBy;
    if (!next || members.includes(next)) return members;
    members.push(next);
  }
}
export function milestoneMembership(display: Display, unit: string): string[] {
  return Object.entries(display.milestoneUnits).filter(([, units]) => units.some((id) => lineage(display, id).includes(unit))).map(([id]) => id);
}
export function milestoneMembers(display: Display, id: string) {
  return (display.milestoneUnits[id] ?? []).map((unit) => {
    const chain = lineage(display, unit); const effective = chain.at(-1)!;
    return { unit, effective, lineage: chain, state: display.status.units.find((u) => u.unit === effective)?.state ?? 'unavailable' };
  });
}
export function milestoneProgress(display: Display, id: string): string {
  const members = milestoneMembers(display, id);
  return `${members.filter((u) => u.state === 'merged').length}/${members.length} units merged`;
}

/** Canonical walking covers both a due walk and an open walk; do not imply activity for a due job. */
export function milestonePhase(milestone: MilestoneView): string {
  return milestone.state === 'walking' && !milestone.walks.some((walk) => walk.outcome === null)
    ? 'walkthrough pending' : milestone.state;
}
