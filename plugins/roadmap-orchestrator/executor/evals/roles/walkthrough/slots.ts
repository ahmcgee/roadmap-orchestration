// Slot assignment: where each family sits in a trial's product, from the cell's seed, so that no plant masks another.
//
// - One slot per page. W1 holds the page whose last step it changes (J-1 the record form, J-2 the limit form, J-3 the
//   statement's print link), W2's twin holds the print view, and W2 to W7 take one page each.
// - W1 sits in its own journey's last step: the slots of that journey are on its earlier pages, which the walk reaches
//   before the dead end. A W1 on J-3 would leave the print view behind its dead end, so it is not drawn while W2's twin
//   holds the print view.
// - W7 needs a form, W6 a page with a primary action; W8 takes a CLI command, W13 a quickstart command.
// The draw is a seeded backtracking search over shuffled candidates: the same seed gives the same assignment.
import { rng } from '../gen/prng.ts';
import { FAMILIES, FAMILY_IDS, FLOW_PAGE, type FamilyId, type FamilyTable, type PageId, type Position, type SlotState } from './families.ts';

export type Slot = Readonly<{ family: FamilyId; state: SlotState; at: Position }>;

/** The page a slot occupies, or null for a slot off the dashboard. */
export function pageOf(s: Slot): PageId | null {
  if (s.at.kind === 'page') return s.at.page;
  if (s.at.kind === 'flow') return FLOW_PAGE[s.at.journey];
  return null;
}

/** The families with the fewest positions first, so the search prunes early. */
const ORDER: readonly FamilyId[] = ['W1', 'W7', 'W6', 'W2', 'W3', 'W4', 'W5', 'W8', 'W13', 'W9', 'W10', 'W11', 'W12'];

/**
 * Every family's slot for a product whose `planted` families carry their plant (the rest their twin), drawn from `seed`
 * over the positions of `families` (a cell's forms, fixture.ts).
 */
export function assignSlots(seed: string, planted: readonly FamilyId[], families: FamilyTable = FAMILIES): readonly Slot[] {
  for (const f of planted) if (!(FAMILY_IDS as readonly string[]).includes(f)) throw new Error(`no family ${f}`);
  const g = rng(`slots:${seed}`);
  const state = (f: FamilyId): SlotState => (planted.includes(f) ? 'plant' : 'twin');
  const candidates = new Map(ORDER.map((f) => {
    const fam = families[f];
    const at = state(f) === 'twin' && fam.twinAt !== null ? [fam.twinAt] : g.shuffle(fam.positions);
    return [f, at] as const;
  }));
  const chosen: Slot[] = [];
  const fits = (s: Slot): boolean => {
    const p = pageOf(s);
    if (p !== null && chosen.some((c) => pageOf(c) === p)) return false;
    const w2Twin = (s.family === 'W2' && s.state === 'twin') || chosen.some((c) => c.family === 'W2' && c.state === 'twin');
    const w1OnPrint = (s.family === 'W1' && s.at.kind === 'flow' && s.at.journey === 'J-3') || chosen.some((c) => c.family === 'W1' && c.at.kind === 'flow' && c.at.journey === 'J-3');
    return !(w2Twin && w1OnPrint);
  };
  const search = (i: number): boolean => {
    if (i === ORDER.length) return true;
    const f = ORDER[i]!;
    for (const at of candidates.get(f)!) {
      const s: Slot = { family: f, state: state(f), at };
      if (!fits(s)) continue;
      chosen.push(s);
      if (search(i + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  if (!search(0)) throw new Error(`no slot assignment for seed ${seed}`);
  return FAMILY_IDS.map((f) => chosen.find((s) => s.family === f)!);
}
