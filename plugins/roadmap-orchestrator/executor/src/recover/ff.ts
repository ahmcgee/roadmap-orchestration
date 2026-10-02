// Reconciler for an open `integration.ff` intent (plan "Recovery"):
// - ref = new, or new an ancestor of ref → done published, after asserting the provenance (a unit's: new^1 = T,
//   new^2 = the approved unit commit; a docs publication's: new's one parent T); a publication without it →
//   recovery-required.
// - ref = old (T) → the CAS never happened. A unit's is redone only if the caller's re-check says the approval still
//   holds and the unit is still eligible (G10: no active P1 blocks an obligation it selects); otherwise done
//   unpublished at T (the unit's ff stage then records `fingerprint-invalid` or `finding-blocked`). A docs
//   publication's is redone: its lanes passed before its intent was written, and it holds the slot, so nothing else
//   moved integration. A repair batch's is never redone: done unpublished at T, its job dead with it; the batch runs
//   again (src/pipeline/integrate.ts `publishBatch`), re-checking every member's fingerprint and eligibility (G5, G10).
// - advanced past old without new → done unpublished at the new tip (fresh candidate).
// - anything else (integration rewound or rewritten) → recovery-required; the caller raises a needs-user.
//
// Uses src/git/ff.ts's pure helpers and git.ts plumbing only; src/recover/ops.ts assembles the op.
import type { IntentOf } from '../core/events.ts';
import type { Disposition, JournalView, Reconciler } from '../core/interfaces.ts';
import type { ApprovalFingerprint } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { observeIntegration, publicationProblem } from '../git/ff.ts';

/**
 * Whether a unit `ff` whose CAS never happened may be redone: its approval fingerprint still holds at T and the unit
 * is still eligible (G10). Asked only of a unit `ff`.
 */
export type UnitRedo = (fingerprint: ApprovalFingerprint) => boolean;

export function reconcileIntegrationFf(repo: AbsPath, unitRedo: UnitRedo): Reconciler<'integration.ff'> {
  return async function reconcile(
    intent: IntentOf<'integration.ff'>,
    _view: JournalView,
  ): Promise<Extract<Disposition<'integration.ff'>, { kind: 'done' | 'redo' | 'recovery-required' }>> {
    const { ref, old } = intent.expect;
    const next = intent.expect.new;
    const seen = observeIntegration(repo, ref, old, next);
    switch (seen.kind) {
      case 'published': {
        const problem = publicationProblem(repo, intent.expect);
        if (problem !== null) return { kind: 'recovery-required', detail: `integration.ff ${ref}: published without provenance: ${problem}` };
        return { kind: 'done', outcome: { kind: 'published' } };
      }
      case 'pending': {
        // A unit's CAS is redone while its approval holds and it is eligible; a docs publication's always; a batch's never.
        const subject = intent.expect.subject;
        const redo = subject === undefined ? unitRedo(intent.expect.fingerprint) : subject.type === 'docs';
        return redo ? { kind: 'redo' } : { kind: 'done', outcome: { kind: 'unpublished', tip: old } };
      }
      case 'advanced':
        return { kind: 'done', outcome: { kind: 'unpublished', tip: seen.tip } };
      case 'foreign':
        return { kind: 'recovery-required', detail: `integration.ff ${ref}: at ${seen.observed ?? 'nothing'}, neither T ${old}, a descendant of it, nor the publication ${next}` };
    }
  };
}
