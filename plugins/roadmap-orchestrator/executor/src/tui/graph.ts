import { unitWaitReason } from './execution.ts';
import { specificationRevision } from './lineage.ts';
import type { Display, Entry } from './types.ts';
import { milestoneMembership, milestoneMembers, milestoneProgress, milestonePhase } from './milestones.ts';
import { pretty } from './types.ts';
export type GraphRow = Entry & { from: string[]; depth: number; members: string[]; markerState?: string; waitReason?: string; replaces?: string; replacedBy?: string; specRevision?: number; redirected?: { declared: string; effective: string }[] };
const settled = (state: string): boolean => ['merged', 'cut', 'superseded', 'passed'].includes(state);

/** Do not call cuts, superseded work, milestones or conditions completed units. */
export function historyLabel(display: Display, members: readonly string[]): string {
  const units = members.map((id) => display.status.units.find((u) => u.unit === id));
  const allUnits = units.every((u) => u !== undefined);
  const adjective = allUnits && units.every((u) => u!.state === 'merged') ? 'completed' : 'settled';
  return `${members.length} ${adjective} ${allUnits ? 'unit' : 'item'}${members.length === 1 ? '' : 's'}`;
}

/** Stable Kahn order with actual dependency nodes, including milestone membership and contingent conditions. */
export function graph(display: Display, expanded: boolean): GraphRow[] {
  const nodes = new Map<string, GraphRow>();
  const add = (id: string, state: string, stage: string, value: unknown): void => {
    nodes.set(id, { id, label: `${id} · ${stage} · ${state}`, state, body: pretty(value), links: [], provenance: `journal seq ${display.seq}`,
      from: [], depth: 0, members: [] });
  };
  for (const u of display.status.units) { add(u.unit, u.state, u.stage, u); nodes.get(u.unit)!.kind = 'unit-status'; nodes.get(u.unit)!.description = 'Execution status. Related documents contains the specification, implementation plan and planning inputs.'; }
  for (const unit of display.status.units) {
    const membership = milestoneMembership(display, unit.unit);
    if (membership.length) nodes.get(unit.unit)!.label = `${unit.unit} [${membership.join(', ')}] · ${unit.stage} · ${unit.state}`;
    const row = nodes.get(unit.unit)!;
    const waitReason = unitWaitReason(unit);
    if (waitReason) row.waitReason = waitReason;
    if (unit.lineage) row.replaces = unit.lineage.reenters;
    if (unit.supersededBy) row.replacedBy = unit.supersededBy;
    const revision = specificationRevision(display, unit.unit);
    if (revision !== undefined) row.specRevision = revision;
    if (row.replaces || row.replacedBy) row.description = `${row.replaces ? `Replaces ${row.replaces}. ` : ''}${row.replacedBy ? `Replaced by ${row.replacedBy}. ` : ''}This is replacement history, not a prerequisite. Related documents opens the other version and its recorded work.`;
  }
  for (const m of display.status.milestones) {
    const definition = display.estate.find((e) => e.id === m.id);
    add(m.id, m.state, 'milestone', { phase: milestonePhase(m), ...m, goal: definition?.description, units: milestoneMembers(display, m.id) });
    const row = nodes.get(m.id)!; row.kind = 'milestone-status';
    const phase = milestonePhase(m);
    row.markerState = phase === 'walkthrough pending' ? 'waiting' : m.state === 'settled' && m.passed ? 'complete' : m.state;
    row.label = `${m.id} · milestone · ${phase} · ${milestoneProgress(display, m.id)}`;
    row.description = phase === 'walkthrough pending' ? `Walkthrough pending; no open walkthrough is recorded.${display.status.run.owner.state !== 'alive' ? ' Executor is stopped.' : ''}` : definition?.description ?? 'Delivery checkpoint: member units, walkthroughs, gate and follow-up work.';
    row.from.push(...milestoneMembers(display, m.id).map((u) => u.effective));
  }
  for (const edge of display.status.edges) {
    if (edge.type === 'contingent') {
      add(edge.edge, edge.resolved ? 'passed' : 'waiting', `condition: ${edge.condition}`, edge);
      nodes.get(edge.unit)?.from.push(edge.edge);
    } else {
      const node = nodes.get(edge.unit);
      node?.from.push(edge.type === 'after' ? edge.effective : edge.milestone);
      if (node && edge.type === 'after' && edge.on !== edge.effective) (node.redirected ??= []).push({ declared: edge.on, effective: edge.effective });
    }
  }
  const ordered: GraphRow[] = [];
  const remaining = new Set(nodes.keys());
  while (remaining.size) {
    const ready = [...remaining].filter((id) => [...nodes.get(id)!.from, ...(nodes.get(id)!.replaces ? [nodes.get(id)!.replaces!] : [])].every((dep) => !remaining.has(dep))).sort();
    // A malformed graph stays inspectable; canonical validation normally excludes cycles.
    if (!ready.length) ready.push([...remaining].sort()[0]!);
    for (const id of ready) {
      const row = nodes.get(id)!;
      row.depth = row.from.length ? 1 + Math.max(...row.from.map((dep) => nodes.get(dep)?.depth ?? 0)) : 0;
      row.body = pretty({ ...(row.waitReason ? { reason: row.waitReason } : {}), ...(row.replaces ? { replaces: row.replaces } : {}), ...(row.replacedBy ? { replacedBy: row.replacedBy } : {}), ...(row.specRevision !== undefined ? { specificationRevision: row.specRevision } : {}), node: JSON.parse(row.body), dependencies: row.from, ...(row.redirected ? { redirectedDependencies: row.redirected } : {}) });
      const estate = display.estate.find((e) => e.id === row.id);
      if (estate) row.links = [estate.id, ...estate.links];
      ordered.push(row); remaining.delete(id);
    }
  }
  if (expanded) return ordered;
  // Connected settled components collapse, retaining every external edge and the exact member set.
  const hidden = new Set(ordered.filter((r) => r.kind !== 'milestone-status' && !r.replaces && !r.replacedBy && settled(r.state)).map((r) => r.id));
  const membership = (id: string) => milestoneMembership(display, id).join(', ');
  const groups: GraphRow[] = [];
  const aliases = new Map<string, string>();
  while (hidden.size) {
    const root = [...hidden][0]!;
    const members = new Set([root]); hidden.delete(root);
    for (const id of members) for (const r of ordered) {
      if (hidden.has(r.id) && membership(r.id) === membership(root) && (r.from.includes(id) || nodes.get(id)!.from.includes(r.id))) { members.add(r.id); hidden.delete(r.id); }
    }
    const ids = [...members].sort();
    const id = `history:${ids[0]}`;
    for (const member of ids) aliases.set(member, id);
    groups.push({ id, label: `${historyLabel(display, ids)}${membership(root) ? ` [${membership(root)}]` : ''} [Enter to expand]`, state: 'history', markerState: ids.every((id) => ['merged', 'passed'].includes(nodes.get(id)!.state)) ? 'complete' : 'history', body: ids.join('\n'), links: ids,
      provenance: `journal seq ${display.seq}`, members: ids, depth: Math.min(...ids.map((x) => nodes.get(x)!.depth)),
      from: [...new Set(ids.flatMap((x) => nodes.get(x)!.from).filter((x) => !members.has(x)))] });
  }
  const result: GraphRow[] = [];
  const emitted = new Set<string>();
  for (const row of ordered) {
    const alias = aliases.get(row.id);
    const value = alias ? groups.find((g) => g.id === alias)! : row;
    if (emitted.has(value.id)) continue;
    emitted.add(value.id);
    result.push({ ...value, from: value.from.map((id) => aliases.get(id) ?? id) });
  }
  return result;
}
