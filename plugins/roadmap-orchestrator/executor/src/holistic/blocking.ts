// Pending obligation delivery and repair ownership, shared by status and audit cadence.
import type { UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { effectiveDependency } from '../schedule/graph.ts';
import { isActive } from './findings.ts';
import { type ObligationDef, isMustHold } from './types.ts';

/** The effective (lineage-head) units of `units` not merged yet, ascending, each once. */
export function unmergedOf(view: JournalView, units: readonly UnitId[]): readonly UnitId[] {
  return [...new Set(units.map((u) => effectiveDependency(view, u)).filter((u) => view.unit(u).status !== 'retired'))].sort();
}

/** The same pending deliverers or repair owners status exposes as blockingUnits. */
export function obligationBlockingUnits(view: JournalView, o: ObligationDef): readonly UnitId[] {
  const fold = view.holistic();
  const latched = new Set(fold.latched.map((l) => l.obligation));
  const owners = fold.findings.flatMap((f) => isActive(f) && f.obligation === o.id && f.owner !== null ? [f.owner] : []);
  return unmergedOf(view, isMustHold(o, latched) ? owners : o.deliveredBy);
}
