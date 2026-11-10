import type { UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';

/** The members of `root`'s lineage in order: `root`, then each unit that re-entered the previous one. */
export function lineageMembers(view: JournalView, root: UnitId): readonly UnitId[] {
  const out: UnitId[] = [root];
  for (let next = view.unit(root).supersededBy; next !== null; next = view.unit(next).supersededBy) {
    if (out.includes(next)) throw new Error(`the lineage of ${root} re-enters itself at ${next}`);
    out.push(next);
  }
  return out;
}

/** The lineage behind `unit`, from the log: `unit`, then each unit it re-enters, back to the lineage's first unit. */
export function lineageBack(view: JournalView, unit: UnitId): readonly UnitId[] {
  const out = [unit];
  for (let l = view.unit(unit).lineage; l !== null; l = view.unit(l.reenters).lineage) out.push(l.reenters);
  return out;
}
