// The close-out settlement (run 10, E and F; DESIGN-1.0.md §2.10): what a holistic arc settles once nothing but the
// close-out stands between it and `complete` (the scheduler calls `settleCloseOut` when every completion blocker left is
// `generation-not-quiescent`, `close-out` or `obligations-not-discharged` and no obligation is observed not held, or none
// is left), so a non-blocking item or a finding nobody owns never holds completion or leaves the arc undispositioned:
//
//   E. Every open `bundle-request` (non-blocking, A9) is declined by the executor: in a corpus arc first a corpus amendment
//      `source: request{job, needsUser}` carrying its proposal to the next Phase 0, then `needs-user-declined{id, choice,
//      reason}`, which closes it as an acknowledgement would (its generation is quiescent again).
//   F. In a corpus arc, every active P2 or P3 finding that names no obligation is banked as `finding-deferred` debt (the
//      next Phase 0 dispositions it), then ruled `deferred` by `code{close-out}`. A finding with an obligation never banks
//      (correctness never banks): it keeps holding completion through its obligation, as before.
//
// Each step is idempotent by its source (the amendment's, the debt item's), so a crash between the two writes of one item
// is finished by the next settlement (crash labels `closeout.after-request-amendment`, `closeout.after-deferred-debt`).
import { crashPoint } from '../core/crash.ts';
import type { NeedsUserId } from '../core/ids.ts';
import { mintDebt } from '../debt/mint.ts';
import { recordOf } from '../needsuser.ts';
import { baselineDebtAt } from '../phase0/rows.ts';
import { appendAmendment } from './amendments.ts';
import type { CheckpointContext } from './bundle.ts';
import { isActive, ruleFinding } from './findings.ts';

/** The option an unanswered request is declined with: its `reject` or `decline`, null when it offers neither. */
const DECLINING = ['reject', 'decline'] as const;

/** Settles the close-out (see the header); whether it wrote anything (the caller re-reads the completion predicate). */
export function settleCloseOut(ctx: CheckpointContext): boolean {
  const corpus = ctx.plan().target === 'corpus';
  let wrote = false;
  for (const c of ctx.journal.view.holistic().checkpoints) {
    if (c.decided?.kind !== 'requested') continue;
    const id = c.decided.needsUser as NeedsUserId;
    if (ctx.journal.view.ackOf(id) !== null) continue;
    const item = recordOf(ctx.runDir, id);
    if (item.reason !== 'bundle-request') continue;
    const reason = `nobody answered ${id} by the close-out of arc ${ctx.journal.view.arc}: the executor declined it so the arc completes${corpus ? '; its proposal is a corpus amendment for the next Phase 0' : ''}`;
    if (corpus) {
      appendAmendment(ctx.journal, { source: { type: 'request', job: c.inputs.job, needsUser: id }, rules: [], proposal: item.summary, why: reason, evidence: item.evidence });
      crashPoint('closeout.after-request-amendment');
    }
    ctx.journal.fact({ kind: 'needs-user-declined', id, choice: item.options.find((o) => (DECLINING as readonly string[]).includes(o.id))?.id ?? null, reason });
    wrote = true;
  }
  if (!corpus) return wrote;
  const deferred = ctx.journal.view.holistic().findings.filter((f): f is typeof f & Readonly<{ severity: 'P2' | 'P3' }> => isActive(f) && f.severity !== 'P1' && f.obligation === null);
  if (deferred.length === 0) return wrote;
  const baseline = baselineDebtAt(ctx.repo, ctx.plan().baseline);
  for (const f of deferred) {
    const fact = mintDebt(baseline, ctx.journal.view.holistic().debt, {
      type: 'finding-deferred', finding: f.id, severity: f.severity, obligation: null, unit: f.owner, what: f.claim,
    });
    if (fact !== null) {
      ctx.journal.fact(fact);
      crashPoint('closeout.after-deferred-debt');
    }
    ruleFinding(ctx.journal, f.id, 'deferred', { type: 'code', reason: 'close-out' });
  }
  return true;
}
