// Completed campaign-audit generations under the current vision.
import type { Sha256Hex } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';

/** Completed campaign-audit generations under the current vision. */
export function quiescentGenerations(view: JournalView, visionSha256: Sha256Hex): ReadonlySet<number> {
  return new Set(view.holistic().audits.filter((a) => a.started.visionSha256 === visionSha256 && a.ended?.outcome === 'completed').map((a) => a.started.generation));
}
