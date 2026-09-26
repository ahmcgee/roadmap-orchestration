// Reconciler for an open `mergein.prepare` intent (plan "Recovery"), by HEAD and MERGE_HEAD:
// - HEAD = old, no MERGE_HEAD, index at old → redo (a clean merge re-makes the same commit from its
//   recorded inputs; a conflicting one re-runs the merge).
// - HEAD = the recorded clean merge → finish moving the index and files to it if the crash came first →
//   done clean-merged.
// - HEAD = old, MERGE_HEAD = T, the recorded conflicts unmerged → done conflicted (the pipeline resumes the
//   implementer with "resolve and commit").
// - no MERGE_HEAD, HEAD with parents [old, T] → done completed.
// - anything else → park.
//
// Uses src/git/mergein.ts's pure helpers and git.ts plumbing only; src/recover/ops.ts assembles the op.
import type { IntentOf } from '../core/events.ts';
import type { Disposition, JournalView } from '../core/interfaces.ts';
import { statusPorcelainV2Z } from '../git/git.ts';
import { classifyMergein, finishCleanMerge } from '../git/mergein.ts';

export async function reconcileMergein(
  intent: IntentOf<'mergein.prepare'>,
  _view: JournalView,
): Promise<Extract<Disposition<'mergein.prepare'>, { kind: 'done' | 'redo' | 'park' }>> {
  const { worktree, old } = intent.expect;
  const state = classifyMergein(intent);
  switch (state.kind) {
    case 'untouched':
      return { kind: 'redo' };
    case 'clean-merged': {
      if (state.indexAt === 'old') finishCleanMerge(worktree, old, state.next);
      const dirty = statusPorcelainV2Z(worktree, false);
      if (dirty.length > 0) return { kind: 'park', detail: `mergein.prepare ${worktree}: status not clean at the merge: ${dirty.map((s) => s.path).join(', ')}` };
      return { kind: 'done', outcome: { kind: 'clean-merged' } };
    }
    case 'conflicted':
      return { kind: 'done', outcome: { kind: 'conflicted' } };
    case 'completed':
      return { kind: 'done', outcome: { kind: 'completed', head: state.head } };
    case 'foreign':
      return { kind: 'park', detail: `mergein.prepare ${worktree}: ${state.detail}` };
  }
}
