// Reconciler for an open `salvage.commit` intent (plan "Recovery"):
// - branch = new: the commit landed; finish the index reconcile (read-tree, restore rejected paths from
//   the verified copy-out), then the full postcondition must hold → done. A copy-out that does not verify
//   or a postcondition that still fails → park.
// - branch = old: nothing moved; if the worktree still yields the recorded approved set, rejected
//   manifest and tree → redo, which makes the same commit (deterministic inputs); if it changed → park.
// - anything else → park.
//
// Uses src/git/salvage.ts's pure helpers and git.ts plumbing only; src/recover/ops.ts assembles the op.
import { type IntentOf, parentUnit } from '../core/events.ts';
import type { Disposition, JournalView, Reconciler } from '../core/interfaces.ts';
import { refTarget } from '../git/git.ts';
import {
  type SalvageRules, SalvageUnmergedError, checkRejected, finishIndexReconcile, rederiveInputs, rejectedDir,
  salvagePostcondition,
} from '../git/salvage.ts';

export function reconcileSalvageCommit(rules: SalvageRules): Reconciler<'salvage.commit'> {
  return async function reconcile(
    intent: IntentOf<'salvage.commit'>,
    _view: JournalView,
  ): Promise<Extract<Disposition<'salvage.commit'>, { kind: 'done' | 'redo' | 'park' }>> {
    const { worktree, branch, old, rejectedManifestSha256 } = intent.expect;
    const next = intent.post.new;
    const park = (why: string) => ({ kind: 'park' as const, detail: `salvage.commit ${worktree}: ${why}` });
    const at = refTarget(worktree, branch);

    if (at === next) {
      const copied = checkRejected(rejectedDir(rules, rejectedManifestSha256), rejectedManifestSha256);
      if (copied.kind !== 'complete') return park(`rejected copy-out ${copied.detail}`);
      finishIndexReconcile(worktree, next, copied.manifest, parentUnit(intent.parent));
      const problem = salvagePostcondition(intent);
      return problem === null ? { kind: 'done', outcome: { kind: 'committed' } } : park(problem);
    }

    if (at === old) {
      try {
        const c = rederiveInputs(rules, intent);
        return typeof c === 'string' ? park(c) : { kind: 'redo' };
      } catch (err) {
        if (err instanceof SalvageUnmergedError) return park(err.message);
        throw err;
      }
    }

    return park(`${branch} at ${at ?? 'nothing'}: neither the recorded old ${old} nor the new ${next}`);
  };
}
