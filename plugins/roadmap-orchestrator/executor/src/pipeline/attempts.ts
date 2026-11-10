import type { UnitId } from '../core/ids.ts';
import type { Journal,JournalView } from '../core/interfaces.ts';
import { lineageBack } from '../input/lineage.ts';

/**
 * The total-attempt caps (`attempt-cap`): every build, and every build, lanes and gate attempt (a judged stage), of a unit's
 * whole lineage (the unit and each unit it re-enters; a re-entry's `reset` clears only chargeable failures). The diagnosis
 * marker M4 is due at half of each.
 */
export const ATTEMPT_CAPS = { builds: 16, judged: 40 } as const;

/** Every distinct build/lanes/gate attempt counts, including holds, crash attempts and uncharged reds. */
export function attemptSignals(journal: Journal, unit: UnitId, boundary: boolean): Readonly<{ builds: number; judged: number; capped: boolean }> {
  const count = journal.view.attemptCounts(unit);
  if ((count.builds >= ATTEMPT_CAPS.builds / 2 || count.judged >= ATTEMPT_CAPS.judged / 2) && !journal.view.ciFacts().some((f) => f.kind === 'attempt-marker' && f.unit === unit)) journal.fact({ kind: 'attempt-marker', unit, marker: 'M4', ...count });
  const capped = boundary && (count.builds >= ATTEMPT_CAPS.builds || count.judged >= ATTEMPT_CAPS.judged);
  if (capped && !journal.view.ciFacts().some((f) => f.kind === 'attempt-capped' && f.unit === unit)) journal.fact({ kind: 'attempt-capped', unit, ...count });
  return { ...count, capped };
}

/** dev.59 (scope item 4): a lineage's attempts against the caps, as `status`, the items and an apply's receipt show them. */
export type LineageAttempts = Readonly<{ lineage: readonly UnitId[]; builds: number; judged: number; buildCap: number; judgedCap: number }>;

/** `unit`'s lineage (the unit, then each unit it re-enters) and its attempt counts against the caps. */
export function lineageAttempts(view: JournalView, unit: UnitId): LineageAttempts {
  const { builds, judged } = view.attemptCounts(unit);
  return { lineage: lineageBack(view, unit), builds, judged, buildCap: ATTEMPT_CAPS.builds, judgedCap: ATTEMPT_CAPS.judged };
}

/** One sentence of `lineageAttempts`, for an item's recommendation and an apply's receipt. */
export function lineageAttemptsText(a: LineageAttempts): string {
  const who = a.lineage.length === 1 ? `Unit ${a.lineage[0]}` : `The lineage of ${a.lineage[0]} (with ${a.lineage.slice(1).join(', ')}, which it re-enters)`;
  return `${who} has run ${a.builds} of ${a.buildCap} builds and ${a.judged} of ${a.judgedCap} judged stages; these caps count the whole lineage, and a re-entry's \`reset\` clears only chargeable failures.`;
}
