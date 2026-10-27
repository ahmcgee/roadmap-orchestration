import type { MilestoneView } from '../status.ts';
import { displayIndex } from './lineage.ts';
import type { Display } from './types.ts';

type Member = { unit: string; effective: string; lineage: string[]; state: string };
const indexes = new WeakMap<Display, { membership: Map<string, string[]>; members: Map<string, Member[]> }>();
function index(display: Display) {
  let cached = indexes.get(display); if (cached) return cached;
  const units = displayIndex(display).units;
  const chains = new Map<string, string[]>();
  const lineage = (unit: string): string[] => {
    const cached = chains.get(unit); if (cached) return cached;
    const chain = [unit];
    while (true) {
      const next = units.get(chain.at(-1)!)?.supersededBy;
      if (!next || chain.includes(next)) break;
      chain.push(next);
    }
    chains.set(unit, chain); return chain;
  };
  const membership = new Map<string, string[]>(); const members = new Map<string, Member[]>();
  for (const [id, declared] of Object.entries(display.milestoneUnits)) {
    members.set(id, declared.map((unit) => {
      const chain = lineage(unit); const effective = chain.at(-1)!;
      for (const member of chain) {
        const list = membership.get(member) ?? [];
        if (!list.includes(id)) list.push(id);
        membership.set(member, list);
      }
      return { unit, effective, lineage: chain, state: units.get(effective)?.state ?? 'unavailable' };
    }));
  }
  cached = { membership, members }; indexes.set(display, cached); return cached;
}
export function milestoneMembership(display: Display, unit: string): string[] {
  return index(display).membership.get(unit) ?? [];
}
export function milestoneMembers(display: Display, id: string): Member[] {
  return index(display).members.get(id) ?? [];
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
