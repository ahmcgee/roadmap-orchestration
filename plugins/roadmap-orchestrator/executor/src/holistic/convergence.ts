// Status convergence counters derived from recorded revisions, and completed campaign-audit generations.
import { type NeedsUserId, type Sha256Hex } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { NeedsUserReason } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { DEFAULT_CONVERGENCE_K,type PlanM1 } from '../input/plan.ts';
import { readNeedsUser } from '../needsuser.ts';

/** A raised brake item: its id, the seq of its raise, and whether it was acknowledged. */
type Item = Readonly<{ id: NeedsUserId; seq: number; acked: boolean }>;

/** The raised items of `reason`, in raise order. */
export function itemsOf(view: JournalView, runDir: AbsPath, reason: NeedsUserReason): readonly Item[] {
  return view.opsOf('needsuser.raise').filter((i) => view.doneOf(i.op) !== null && readNeedsUser(runDir, i.expect.id)?.reason === reason)
    .map((i) => ({ id: i.expect.id, seq: Number(i.op.slice(i.op.lastIndexOf('/') + 1)), acked: view.ackOf(i.expect.id) !== null }));
}

export type Brakes = Readonly<{
  /** Open convergence notices (raised, not acknowledged). */
  open: readonly NeedsUserId[];
  /** The retired automatic amendment counter (zero), and the configured K. */
  count: number;
  k: number;
  /** Where the arc counter starts (seq): a publication, a latch, or an acknowledged bound. */
  since: number;
}>;

/**
 * The convergence notices as the log has them now. Root revisions do not consume an automatic amendment budget.
 */
export function brakesOf(
  view: JournalView, runDir: AbsPath, plan: PlanM1,
): Brakes {
  const bound = itemsOf(view, runDir, 'convergence-bound');
  const identity = itemsOf(view, runDir, 'convergence-identity');
  const fold = view.holistic();
  const since = Math.max(
    0,
    ...view.publications().map((p) => p.seq),
    ...fold.latched.map((l) => l.seq),
    ...bound.filter((b) => b.acked).map((b) => b.seq),
  );
  return {
    open: [...bound, ...identity].filter((i) => !i.acked).map((i) => i.id),
    count: 0,
    k: plan.limits?.convergenceK ?? DEFAULT_CONVERGENCE_K,
    since,
  };
}

/** Completed campaign-audit generations under the current vision. */
export function quiescentGenerations(view: JournalView, visionSha256: Sha256Hex): ReadonlySet<number> {
  return new Set(view.holistic().audits.filter((a) => a.started.visionSha256 === visionSha256 && a.ended?.outcome === 'completed').map((a) => a.started.generation));
}
