// Explicit campaign audit request, coalesced durably with milestone and final triggers.
import type { CommandId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import type { PlanM1 } from '../input/plan.ts';
import type { Effect } from './apply.ts';

export type AuditCommandContext = Readonly<{ journal: Journal; plan: () => PlanM1 }>;
export function requestAudit(ctx: AuditCommandContext, id: CommandId): Effect {
  const view = ctx.journal.view;
  if (!view.holistic().on || ctx.plan().holistic === undefined) return {kind: 'rejected', reason: 'audit: the arc has no holistic layer (no vision in force); nothing audits it'};
  if (!view.holistic().auditRequests.some((q) => q.command === id)) ctx.journal.fact({kind: 'audit-requested', command: id});
  return {kind: 'applied', verified: ['Campaign audit requested; it coalesces with owed milestone and final triggers.']};
}
