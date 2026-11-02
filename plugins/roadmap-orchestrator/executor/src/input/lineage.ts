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

