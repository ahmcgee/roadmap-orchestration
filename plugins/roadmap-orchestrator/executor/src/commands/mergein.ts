// `roadmap merge-in <u>` (M3 step A3; DESIGN-1.0.md §2.3, §3.5 "Rebase-before-verify → merge-in"): the integration
// tip merged into a unit's branch, in its worktree, when the unit is not in a task (a mutation, scope {u}: it applies
// only once the unit's task ended). The effect, each step only where missing:
//
//   1. The plan (`mergein.prepare`'s prepare, src/git/mergein.ts): `merge-tree` of the branch and the integration tip.
//      A conflict is rejected with the conflicted paths and no act: nothing was begun, so nothing is aborted. A branch
//      that already contains the tip has nothing to merge (rejected).
//   2. A clean merge acts: the `mergein.prepare` op, parented by the command, makes the recorded merge commit, CASes the
//      branch and moves the worktree to it (its reconciler finishes it after a crash).
//   3. A park's open needs-user acknowledged by this command.
//   4. `merged-in{unit, command, integrationTip, head}`, the postcondition: the fold voids the approval (a new unit
//      commit) and sends the unit to its lanes (`entry`), whatever it had decided; the gate's diff base is recomputed
//      against the tip, which is now the merge base (`diffBase`).
//
// Refused: an unknown unit; one never dispatched or without a worktree (nothing merged into yet); a merged, cut,
// superseded or stopped unit; a worktree not clean or mid-merge; a conflict; nothing to merge.
import { existsSync } from 'node:fs';
import type { CommandId } from '../core/ids.ts';
import { type RepoPath, branchRef } from '../core/values.ts';
import { isAncestor } from '../git/ff.ts';
import { refTarget, revParse } from '../git/git.ts';
import { MergeinStateError, type MergeinRequest } from '../git/mergein.ts';
import { runPrepared, unitBranch, unitWorktree } from '../pipeline/dispatch.ts';
import { executorIdentity } from '../pipeline/stages.ts';
import { mergeinOp } from '../recover/ops.ts';
import { type CommandContext, type Effect, acknowledgePark, parentOf } from './apply.ts';

const MERGEABLE = new Set(['active', 'held', 'park-pending']);

export async function mergeIn(ctx: CommandContext, id: CommandId, unitId: string): Promise<Effect> {
  const view = ctx.journal.view;
  // Run again after a crash past the fact: it is the postcondition.
  const recorded = view.holistic().mergedIn.find((m) => m.command === id);
  if (recorded !== undefined) return { kind: 'applied', verified: [`integration ${recorded.integrationTip} merged into ${recorded.unit} at ${recorded.head}`] };
  const unit = ctx.plan().units.find((u) => u.id === unitId);
  if (unit === undefined) return { kind: 'rejected', reason: `unknown unit ${unitId}` };
  const u = view.unit(unit.id);
  if (!MERGEABLE.has(u.status) || u.open !== null) return { kind: 'rejected', reason: `unit ${unit.id} is ${u.status}: only an active, held or parked unit takes a merge-in` };
  const { arc, worktreeRoot, integrationBranch } = ctx.plan();
  const worktree = unitWorktree(worktreeRoot, arc, unit.id);
  const branch = unitBranch(arc, unit.id);
  if (view.dispatchOf(unit.id) === null || !existsSync(worktree) || refTarget(ctx.repo, branch) === null) {
    return { kind: 'rejected', reason: `unit ${unit.id} has no worktree on its branch yet: nothing to merge into` };
  }
  const op = mergeinOp(ctx.repo);
  // A merge-in this command began: recovery closed it, and its done record says how it ended.
  const begun = view.opsOf('mergein.prepare').find((i) => i.parent.type === 'command' && i.parent.command === id);
  let intent = begun;
  if (intent === undefined) {
    const tip = revParse(ctx.repo, branchRef(integrationBranch));
    if (isAncestor(ctx.repo, tip, revParse(worktree, 'HEAD'))) return { kind: 'rejected', reason: `unit ${unit.id}'s branch already contains the integration tip ${tip}: nothing to merge` };
    const request: MergeinRequest = {
      worktree, branch, integration: branchRef(integrationBranch), identity: executorIdentity(),
      message: `roadmap ${arc}: merge ${integrationBranch} into unit ${unit.id} (merge-in ${id})\n`,
    };
    let body;
    try {
      body = await op.prepare(request);
    } catch (error) {
      if (error instanceof MergeinStateError) return { kind: 'rejected', reason: `unit ${unit.id}: ${error.message}` };
      throw error;
    }
    const { merge } = body.expect;
    if (merge.type === 'conflicted') return { kind: 'rejected', reason: conflictText(unit.id, body.expect.integrationTip, merge.conflicts) };
    intent = await runPrepared(ctx.journal, op, `mergein:${unit.id}`, parentOf(id), body);
  }
  const done = ctx.journal.view.doneOf(intent.op);
  if (done === null || done.kind !== 'mergein.prepare' || done.outcome.kind !== 'clean-merged' || intent.post.type !== 'clean-merged') {
    throw new Error(`merge-in ${id} of ${unit.id}: its mergein.prepare ${intent.op} did not end clean-merged`);
  }
  const verified: string[] = [];
  if (u.status === 'park-pending' && u.decided !== null) verified.push(...acknowledgePark(ctx, id, unit.id, u.decided));
  ctx.journal.fact({ kind: 'merged-in', unit: unit.id, command: id, integrationTip: intent.expect.integrationTip, head: intent.post.new });
  verified.push(`integration ${intent.expect.integrationTip} merged into ${unit.id} at ${intent.post.new}; it re-enters at its lanes`);
  return { kind: 'applied', verified };
}

const conflictText = (unit: string, tip: string, conflicts: readonly RepoPath[]): string =>
  `merging integration ${tip} into unit ${unit} conflicts in ${conflicts.join(', ')}: nothing was merged; resolve by steering the unit or re-entering it`;
