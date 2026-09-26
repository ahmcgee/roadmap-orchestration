// Reconciler for an open `snapshot.publish` intent (plan "Recovery"):
// - ref = new and the tree verifies against its own manifest at the recorded mark → done.
// - ref = the recorded old, or still absent when none was recorded → redo; the recorded inputs make the
//   same commit.
// - anything else → abort; the caller parks with a needs-user.
//
// Uses src/git/snapshot.ts's pure helpers and git.ts plumbing only; src/recover/ops.ts assembles the op.
import type { IntentOf } from '../core/events.ts';
import type { Disposition, JournalView, Reconciler } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { refTarget } from '../git/git.ts';
import { snapshotPostcondition } from '../git/snapshot.ts';

export function reconcileSnapshot(repo: AbsPath): Reconciler<'snapshot.publish'> {
  return async function reconcile(
    intent: IntentOf<'snapshot.publish'>,
    _view: JournalView,
  ): Promise<Extract<Disposition<'snapshot.publish'>, { kind: 'done' | 'redo' | 'abort' }>> {
    const { ref, old } = intent.expect;
    const next = intent.post.new;
    const at = refTarget(repo, ref);
    if (at === next) {
      const problem = snapshotPostcondition(repo, intent);
      return problem === null ? { kind: 'done', outcome: { kind: 'published' } } : { kind: 'abort', detail: `snapshot.publish ${ref}: ${problem}` };
    }
    if (at === old) return { kind: 'redo' };
    return { kind: 'abort', detail: `snapshot.publish ${ref}: at ${at ?? 'nothing'}, neither the recorded old ${old ?? 'absent'} nor the new ${next}` };
  };
}
