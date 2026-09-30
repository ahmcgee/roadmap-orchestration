// The graph commands (M2, A5): runtime facts about the unit graph, not plan edits, so they are commands of their
// own rather than `apply` edit classes. Both are mutations with an empty scope (A12): they touch no unit's
// work, only what readiness and admission read next. Each effect checks its postcondition first, so a re-run
// after a crash (recovery's `finish`) applies nothing twice.
//
//   resolve-edge <edge> --evidence …   `edge-resolved{edge, command, evidence}`: the contingent edge's condition
//                                      is met, and the unit it gates may become ready. Rejected for an edge no
//                                      unit of the plan in force declares, and for one already resolved.
//   run-only <ids> | --clear           `run-only{command, units | null}`: admission is limited to these units
//                                      (checked at every admission boundary, ready.ts), or unlimited again.
//                                      Rejected for an id the plan in force does not list.
import type { CommandId, EdgeId, UnitId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { PlanM1 } from '../input/plan.ts';

/** What a graph command's effect may touch: the log, and the plan in force it checks ids against. */
export type GraphContext = Readonly<{ journal: Journal; plan: () => PlanM1 }>;

export type GraphEffect = Readonly<{ kind: 'applied'; verified: readonly string[] }> | Readonly<{ kind: 'rejected'; reason: string }>;

export function resolveEdge(ctx: GraphContext, id: CommandId, edge: EdgeId, evidence: string): GraphEffect {
  const owner = ctx.plan().units.find((u) => u.contingent.some((e) => e.id === edge));
  if (owner === undefined) return { kind: 'rejected', reason: `no unit of the plan in force has a contingent edge ${edge}` };
  const resolved = ctx.journal.view.edgeResolved(edge);
  if (resolved !== null && resolved.command !== id) return { kind: 'rejected', reason: `edge ${edge} is already resolved (by ${resolved.command})` };
  if (resolved === null) ctx.journal.fact({ kind: 'edge-resolved', edge, command: id, evidence });
  return { kind: 'applied', verified: [`edge ${edge} of unit ${owner.id} resolved`] };
}

export function runOnly(ctx: GraphContext, id: CommandId, units: readonly UnitId[] | null): GraphEffect {
  const planned = ctx.plan().units.map((u) => u.id);
  const unknown = (units ?? []).filter((u) => !planned.includes(u));
  if (unknown.length > 0) return { kind: 'rejected', reason: `unit ${unknown.join(', ')} is not in the plan in force` };
  if (canonicalJson(ctx.journal.view.runOnly()) !== canonicalJson(units)) ctx.journal.fact({ kind: 'run-only', command: id, units });
  return { kind: 'applied', verified: [units === null ? 'admission unlimited' : `admission limited to ${units.join(', ')}`] };
}
