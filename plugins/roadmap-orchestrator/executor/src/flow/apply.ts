// Applying an accepted flow proposal (plan "Decisions"): while one is `pending-apply`, new candidate starts are held
// (`flowApplyHolds`, consulted at candidate admission); once no candidate op is open the executor commits
// `flowRevision` as a revision with source `flow{proposal}` under the fence, writes it back to the live plan.json and
// journals `flow-applied{proposal, revision, preimage}`. The flow track (src/flow/track.ts) calls `applyPendingFlow`
// each tick. PLACEHOLDER (step B1, by agreement): step B2 replaces this module in place, keeping these signatures.
import type { Journal, JournalView } from '../core/interfaces.ts';
import { notYet } from '../core/notyet.ts';
import type { AbsPath } from '../core/values.ts';

export type FlowApplyContext = Readonly<{ runDir: AbsPath; repo: AbsPath; journal: Journal }>;

/** Applies the accepted proposal now `pending-apply`, when no candidate op is open (nothing pending: no effect). */
export async function applyPendingFlow(_ctx: FlowApplyContext): Promise<void> {
  return notYet('applyPendingFlow', 'B2');
}

/** Whether an accepted proposal is `pending-apply`: new candidate starts wait (`hold{cause: flow-apply}`). */
export function flowApplyHolds(_view: JournalView): boolean {
  return notYet('flowApplyHolds', 'B2');
}
