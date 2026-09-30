// Reconciler for an open `docs.commit` intent (M3 step A4; plan "Crash safety"), as for a candidate:
// - ref = new (and the postcondition holds) → done.
// - ref = the recorded old, or still absent when none was recorded → redo; the recorded inputs make the same commit.
// - anything else (someone else moved the executor-owned docs ref) → abort; recovery raises its needs-user, and the
//   revision the publication carried is aborted with it (its `ff` never began).
//
// Uses src/git/docs.ts's pure helpers and git.ts plumbing only; src/recover/ops.ts assembles the op.
import type { IntentOf } from '../core/events.ts';
import type { Disposition, JournalView, Reconciler } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { docsPostcondition } from '../git/docs.ts';
import { refTarget } from '../git/git.ts';

export function reconcileDocsCommit(repo: AbsPath): Reconciler<'docs.commit'> {
  return async function reconcile(
    intent: IntentOf<'docs.commit'>,
    _view: JournalView,
  ): Promise<Extract<Disposition<'docs.commit'>, { kind: 'done' | 'redo' | 'abort' }>> {
    const { ref, old } = intent.expect;
    const next = intent.post.new;
    const at = refTarget(repo, ref);
    if (at === next) {
      const problem = docsPostcondition(repo, intent);
      return problem === null ? { kind: 'done', outcome: { kind: 'committed' } } : { kind: 'abort', detail: `docs.commit ${ref}: ${problem}` };
    }
    if (at === old) return { kind: 'redo' };
    return { kind: 'abort', detail: `docs.commit ${ref}: at ${at ?? 'nothing'}, neither the recorded old ${old ?? 'absent'} nor the new ${next}` };
  };
}
