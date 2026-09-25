// Reconciler for an open `candidate.merge` intent (plan "Recovery"):
// - ref = new (and the postcondition holds) → done.
// - ref = the recorded old, or still absent when none was recorded → redo; the recorded inputs make the
//   same commit.
// - anything else (someone else moved the executor-owned candidate ref) → abort; the caller parks the
//   unit with a needs-user.
//
// Imports from src/git/candidate.ts, which imports this module back to build its op record: an ESM cycle
// that is safe because both sides only reference each other's function declarations at call time.
import type { IntentOf } from '../core/events.ts';
import type { Disposition, JournalView, Reconciler } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { candidatePostcondition } from '../git/candidate.ts';
import { refTarget } from '../git/git.ts';

export function reconcileCandidate(repo: AbsPath): Reconciler<'candidate.merge'> {
  return async function reconcile(
    intent: IntentOf<'candidate.merge'>,
    _view: JournalView,
  ): Promise<Extract<Disposition<'candidate.merge'>, { kind: 'done' | 'redo' | 'abort' }>> {
    const { ref, old } = intent.expect;
    const next = intent.post.new;
    const at = refTarget(repo, ref);
    if (at === next) {
      const problem = candidatePostcondition(repo, intent);
      return problem === null ? { kind: 'done', outcome: { kind: 'merged' } } : { kind: 'abort', detail: `candidate.merge ${ref}: ${problem}` };
    }
    if (at === old) return { kind: 'redo' };
    return { kind: 'abort', detail: `candidate.merge ${ref}: at ${at ?? 'nothing'}, neither the recorded old ${old ?? 'absent'} nor the new ${next}` };
  };
}
