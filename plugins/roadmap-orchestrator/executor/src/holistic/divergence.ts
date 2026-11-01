// Recorded divergences and acknowledged digest coverage, used by status and compensating revisions.
import type {DivergenceId} from '../core/ids.ts';
import type {JournalView} from '../core/interfaces.ts';
import type {HolisticFold} from '../core/state.ts';

function covered(view: JournalView): ReadonlySet<DivergenceId> {
  return new Set(view.holistic().digests.filter((d) => view.ackOf(d.needsUser) !== null).flatMap((d) => d.ids));
}

/** Every divergence not covered by an acknowledged digest, ascending (`status.divergences`). */
export function uncoveredDivergences(view: JournalView): HolisticFold['divergences'] {
  const done = covered(view);
  return view.holistic().divergences.filter((d) => !done.has(d.id));
}
