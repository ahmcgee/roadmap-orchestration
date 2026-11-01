// Bank active P2 findings as debt and release P3 findings at close-out.
// Obligation correctness stays a completion blocker; settlement is idempotent by source.
import { crashPoint } from '../core/crash.ts';
import { mintDebt } from '../debt/mint.ts';
import { baselineDebtAt } from '../phase0/rows.ts';
import type { RevisionContext } from './admission.ts';
import { isActive,ruleFinding } from './findings.ts';

/** Settles the close-out (see the header); whether it wrote anything (the caller re-reads the completion predicate). */
export function settleCloseOut(ctx: RevisionContext): boolean {
  const corpus = ctx.plan().target === 'corpus';
  let wrote = false;
  if (!corpus) return wrote;
  // A vacuous witness of an obligation is about the test, not the obligation's truth: it closes out like any other finding.
  const open = ctx.journal.view.holistic().findings.filter((f) => isActive(f) && f.severity !== 'P1' && (f.obligation === null || f.lens === 'vacuity'));
  if (open.length === 0) return wrote;
  for (const f of open) if (f.severity === 'P3') ruleFinding(ctx.journal, f.id, 'released', { type: 'code', reason: 'close-out' });
  const deferred = open.filter((f) => f.severity === 'P2');
  if (deferred.length === 0) return true;
  const baseline = baselineDebtAt(ctx.repo, ctx.plan().baseline);
  for (const f of deferred) {
    const fact = mintDebt(baseline, ctx.journal.view.holistic().debt, {
      type: 'finding-deferred', finding: f.id, severity: f.severity, obligation: f.obligation, witness: f.lens === 'vacuity', unit: f.owner, what: f.claim,
    });
    if (fact !== null) {
      ctx.journal.fact(fact);
      crashPoint('closeout.after-deferred-debt');
    }
    ruleFinding(ctx.journal, f.id, 'deferred', { type: 'code', reason: 'close-out' });
  }
  return true;
}
