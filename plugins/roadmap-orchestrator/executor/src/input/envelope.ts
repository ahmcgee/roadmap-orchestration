// A re-entry's scope envelope (M4a rev 3, F5): the union of every lineage member's dispatched scopes, and the rule that
// lets a re-entry leave it on an active ruling applying to the new unit whose statement names exactly the added patterns
// (`scopeGrowthReason`'s rule, factored here). PLACEHOLDER (step N0, H3): step N3 replaces this module in place.
import type { UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { notYet } from '../core/notyet.ts';
import type { RepoPattern } from '../core/values.ts';

/** The patterns every member of `root`'s lineage was dispatched with, ascending. */
export function lineageEnvelope(_view: JournalView, _root: UnitId): readonly RepoPattern[] {
  return notYet('lineageEnvelope', 'N3');
}
