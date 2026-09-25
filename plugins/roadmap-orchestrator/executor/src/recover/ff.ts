// Reconciler for an open `integration.ff` intent (plan "Recovery"):
// - ref = new, or new an ancestor of ref → done published, after asserting the provenance (new^1 = T,
//   new^2 = the approved unit commit); a publication without it → recovery-required.
// - ref = old (T) → the CAS never happened: redo it only if the caller's fingerprint re-check says the
//   approval still holds; otherwise done unpublished at T (the caller re-gates).
// - advanced past old without new → done unpublished at the new tip (fresh candidate).
// - anything else (integration rewound or rewritten) → recovery-required; the caller raises a needs-user.
//
// Imports from src/git/ff.ts, which imports this module back to build its op record: an ESM cycle that is
// safe because both sides only reference each other's function declarations at call time.
import type { IntentOf } from '../core/events.ts';
import type { Disposition, JournalView, Reconciler } from '../core/interfaces.ts';
import type { ApprovalFingerprint } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { observeIntegration, provenanceProblem } from '../git/ff.ts';

export function reconcileIntegrationFf(repo: AbsPath, fingerprintValid: (fingerprint: ApprovalFingerprint) => boolean): Reconciler<'integration.ff'> {
  return async function reconcile(
    intent: IntentOf<'integration.ff'>,
    _view: JournalView,
  ): Promise<Extract<Disposition<'integration.ff'>, { kind: 'done' | 'redo' | 'recovery-required' }>> {
    const { ref, old, fingerprint } = intent.expect;
    const next = intent.expect.new;
    const seen = observeIntegration(repo, ref, old, next);
    switch (seen.kind) {
      case 'published': {
        const problem = provenanceProblem(repo, next, old, fingerprint.unitCommit);
        if (problem !== null) return { kind: 'recovery-required', detail: `integration.ff ${ref}: published without provenance: ${problem}` };
        return { kind: 'done', outcome: { kind: 'published' } };
      }
      case 'pending':
        return fingerprintValid(fingerprint) ? { kind: 'redo' } : { kind: 'done', outcome: { kind: 'unpublished', tip: old } };
      case 'advanced':
        return { kind: 'done', outcome: { kind: 'unpublished', tip: seen.tip } };
      case 'foreign':
        return { kind: 'recovery-required', detail: `integration.ff ${ref}: at ${seen.observed ?? 'nothing'}, neither T ${old}, a descendant of it, nor the publication ${next}` };
    }
  };
}
