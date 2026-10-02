// Reconciler for an open `mutant.apply` intent (M3 step B3; plan "Crash safety"). The worktree is the intent's own
// scratch checkout, and its expected state is a pure function of the recorded `at` and patch (src/git/mutant.ts):
// - the worktree is exactly that state (the patched tree, or a clean checkout of `at` when the patch does not apply)
//   → done with that outcome;
// - nothing at the path, or a worktree git lists in any other state (an add or an apply cut short) → the worktree is
//   removed (`worktree remove --force`, prune) and the act redone: it re-makes the worktree and re-applies the patch;
// - content at the path that git does not list as a worktree → abort (recovery raises its needs-user); the stage attempt
//   runs again as a new attempt with its own worktree.
//
// Uses src/git/mutant.ts's pure helpers and git.ts plumbing only; src/recover/ops.ts assembles the op.
import { existsSync } from 'node:fs';
import type { IntentOf } from '../core/events.ts';
import type { Disposition, JournalView, Reconciler } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { worktreeList, worktreePrune, worktreeRemove } from '../git/git.ts';
import { mutantOutcome, mutantProblem } from '../git/mutant.ts';

export function reconcileMutantApply(repo: AbsPath, runDir: AbsPath): Reconciler<'mutant.apply'> {
  return async function reconcile(
    intent: IntentOf<'mutant.apply'>,
    _view: JournalView,
  ): Promise<Extract<Disposition<'mutant.apply'>, { kind: 'done' | 'redo' | 'abort' }>> {
    const { worktree } = intent.expect;
    const outcome = mutantOutcome(repo, runDir, intent);
    const isListed = worktreeList(repo).some((e) => e.path === worktree);
    if (isListed && mutantProblem(repo, intent.expect, outcome) === null) return { kind: 'done', outcome };
    if (isListed) worktreeRemove(repo, worktree);
    worktreePrune(repo);
    if (existsSync(worktree)) return { kind: 'abort', detail: `mutant.apply ${worktree}: content at the path that git does not list as a worktree` };
    return { kind: 'redo' };
  };
}
