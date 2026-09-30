// INTERIM (M3 step B6, while B3 lands in parallel): the two ruling functions of B3's findings store
// (src/holistic/findings.ts, commit 8aa3eed), copied verbatim so the checkpoint's finding dispositions compile and
// test against their canonical names. At merge, B3's file replaces this one whole.
import type { FindingId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import type { FindingState } from '../core/state.ts';
import type { FindingDisposition, FindingRuledBy, FindingStateName } from './types.ts';

const ACTIVE: ReadonlySet<FindingStateName> = new Set(['open', 'owned', 'fixed-on-branch']);
/** Open, owned or fixed-on-branch: not yet resolved or ruled. */
export const isActive = (f: FindingState): boolean => ACTIVE.has(f.state);

/**
 * Why `disposition` by `by` may not rule `finding`, or null when it may. Only an active finding is ruled; P1s never bank:
 * deferring or accepting one takes a disposition ruling (a checkpoint or code may only dismiss it).
 */
export function rulingRefusal(finding: FindingState, disposition: FindingDisposition, by: FindingRuledBy): string | null {
  if (!isActive(finding)) return `finding ${finding.id} is ${finding.state}`;
  if (finding.severity === 'P1' && disposition !== 'dismissed' && by.type !== 'ruling') return `finding ${finding.id} is a P1: P1s never bank (only a disposition ruling ${disposition === 'deferred' ? 'defers' : 'accepts'} one)`;
  return null;
}

/** Rules a finding; refuses loudly what `rulingRefusal` refuses (a caller validates a checkpoint's dispositions first). */
export function ruleFinding(journal: Journal, id: FindingId, disposition: FindingDisposition, by: FindingRuledBy): void {
  const finding = journal.view.holistic().findings.find((f) => f.id === id);
  if (finding === undefined) throw new Error(`finding ${id} was never opened`);
  const refusal = rulingRefusal(finding, disposition, by);
  if (refusal !== null) throw new Error(`ruling ${id} ${disposition}: ${refusal}`);
  journal.fact({ kind: 'finding-transition', id, to: { state: 'ruled', disposition, by } });
}
