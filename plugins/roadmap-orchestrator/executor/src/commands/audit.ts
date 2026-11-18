// Explicit campaign audit request, coalesced durably with milestone and final triggers. dev.83: `--whole` reads the
// whole range from the arc's base; without it a pass reads only what no completed pass covered (src/holistic/audit.ts).
import type { CommandId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import type { PlanM1 } from '../input/plan.ts';
import type { Effect } from './apply.ts';

export type AuditCommandContext = Readonly<{ journal: Journal; plan: () => PlanM1 }>;
export function requestAudit(ctx: AuditCommandContext, id: CommandId, whole: boolean): Effect {
  const view = ctx.journal.view;
  if (!view.holistic().on || ctx.plan().holistic === undefined) return {kind: 'rejected', reason: 'audit: the arc has no holistic layer (no vision in force); nothing audits it'};
  if (!view.holistic().auditRequests.some((q) => q.command === id)) ctx.journal.fact({kind: 'audit-requested', command: id, ...(whole ? {whole: true} : {})});
  return {kind: 'applied', verified: [`Campaign audit requested${whole ? ' over the whole range' : ''}; it coalesces with owed milestone and final triggers.`]};
}
