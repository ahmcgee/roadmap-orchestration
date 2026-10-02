// `audit [--lens <kind>…]` (M3 B7; DESIGN-1.0.md §2.5, plan "Commands"): a runtime fact, not a plan edit. The command
// records `audit-requested{command, lenses}` (lenses null: the arc's required lens set L); the cadence
// (src/holistic/cadence.ts) reads it as a `requested` trigger, and the scheduler's audit job runs it with the other owed
// triggers, coalesced, one audit at a time. A mutation with no scope: it touches no unit.
//
// Refused: an arc without the holistic layer (no vision in force, A5), and a lens outside L (an audit's lenses are
// always a subset of L, so a lens L lacks is a request nothing serves). The effect checks its postcondition first, so a
// re-run after a crash (recovery's `finish`) writes nothing twice.
import type { CommandId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import type { LensKindName } from '../core/records.ts';
import { type PlanM1, lensSetOf } from '../input/plan.ts';
import type { Effect } from './apply.ts';

/** What `audit` touches: the log, and the plan in force whose `holistic.audit` names L. */
export type AuditCommandContext = Readonly<{ journal: Journal; plan: () => PlanM1 }>;

export function requestAudit(ctx: AuditCommandContext, id: CommandId, lenses: readonly LensKindName[] | null): Effect {
  const view = ctx.journal.view;
  const holistic = ctx.plan().holistic;
  if (!view.holistic().on || holistic === undefined) return { kind: 'rejected', reason: 'audit: the arc has no holistic layer (no vision in force); nothing audits it' };
  const L = lensSetOf(holistic);
  const outside = (lenses ?? []).filter((l) => !L.includes(l));
  if (outside.length > 0) return { kind: 'rejected', reason: `audit: lens ${outside.join(', ')} is outside the arc's required lens set (${L.join(', ')})` };
  if (!view.holistic().auditRequests.some((q) => q.command === id)) ctx.journal.fact({ kind: 'audit-requested', command: id, lenses });
  return {
    kind: 'applied',
    verified: [`audit requested (${lenses === null ? `every lens of L: ${L.join(', ')}` : `lenses ${lenses.join(', ')}`}); it runs with the owed triggers, one audit at a time`],
  };
}
