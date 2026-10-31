import type { UnitId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';

/** Every distinct build/lanes/gate attempt counts, including holds, crash attempts and uncharged reds. */
export function attemptSignals(journal: Journal, unit: UnitId, boundary: boolean): Readonly<{ builds: number; judged: number; capped: boolean }> {
  const count = journal.view.attemptCounts(unit);
  if ((count.builds >= 8 || count.judged >= 20) && !journal.view.ciFacts().some((f) => f.kind === 'attempt-marker' && f.unit === unit)) journal.fact({ kind: 'attempt-marker', unit, marker: 'M4', ...count });
  const capped = boundary && (count.builds >= 16 || count.judged >= 40);
  if (capped && !journal.view.ciFacts().some((f) => f.kind === 'attempt-capped' && f.unit === unit)) journal.fact({ kind: 'attempt-capped', unit, ...count });
  return { ...count, capped };
}
