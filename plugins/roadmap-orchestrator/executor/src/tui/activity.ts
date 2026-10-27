import { unitFamily } from './lineage.ts';
import type { GraphRow } from './graph.ts';
import { milestoneMembers } from './milestones.ts';
import type { Display, Invocation } from './types.ts';

export type ActivityContext = { id: string; label: string; invocations: Set<string> };

const contexts = new WeakMap<Display, WeakMap<GraphRow, ActivityContext>>();

/** Match recorded membership only; prerequisite/dependent units are not the selected unit. */
export function activityContext(display: Display, node: GraphRow): ActivityContext {
  let cache = contexts.get(display);
  if (!cache) { cache = new WeakMap(); contexts.set(display, cache); }
  const cached = cache.get(node); if (cached) return cached;
  const members = [node.id];
  const subjects = new Set(members);
  const family = node.kind === 'unit-status' ? unitFamily(display, node.id) : [];
  for (const id of family) subjects.add(id);
  for (const id of members) {
    for (const member of milestoneMembers(display, id)) for (const unit of member.lineage) subjects.add(unit);
    for (const walk of display.status.milestones.find((m) => m.id === id)?.walks ?? []) subjects.add(walk.job);
    for (const edge of display.status.edges) if (edge.type === 'contingent' && edge.edge === id) subjects.add(edge.unit);
  }
  const context = { id: node.id, label: `${node.id}${family.length > 1 ? ' · lineage' : ''}`,
    invocations: new Set(display.invocations.filter((inv) => subjects.has(inv.unit) || (inv.milestone !== undefined && subjects.has(inv.milestone)) || inv.relatedUnits?.some((unit) => subjects.has(unit))).map((inv) => inv.id)) };
  cache.set(node, context); return context;
}

/** Product scope takes precedence over the executor seat used to schedule it. */
export function scopeLabel(inv: Invocation): string {
  return inv.milestone ? `Milestone ${inv.milestone}` : inv.scope === 'arc' ? 'Arc-wide' : '';
}
