import { unitWaitReason } from './execution.ts';
import { displayIndex, specificationRevision } from './lineage.ts';
import type { Display, Entry } from './types.ts';
import { milestoneMembership, milestoneMembers, milestoneProgress, milestonePhase } from './milestones.ts';
import { pretty } from './types.ts';
export type GraphRow = Entry & { from: string[]; depth: number; markerState?: string; waitReason?: string; replaces?: string; replacedBy?: string; specRevision?: number; redirected?: { declared: string; effective: string }[] };
const cache = new WeakMap<Display, { full: GraphRow[]; open: GraphRow[]; settled: Set<string> }>();
export function settledNodeIds(display: Display): ReadonlySet<string> {
  graph(display, true); return cache.get(display)!.settled;
}

/** Stable Kahn order with actual dependency nodes, including milestone membership and contingent conditions. */
export function graph(display: Display, full: boolean): GraphRow[] {
  const cached = cache.get(display); if (cached) return full ? cached.full : cached.open;
  const estateById = displayIndex(display).estate;
  const nodes = new Map<string, GraphRow>();
  const add = (id: string, state: string, stage: string, value: unknown): void => {
    nodes.set(id, { id, label: `${id} · ${stage} · ${state}`, state, body: pretty(value), links: [], provenance: `journal seq ${display.seq}`,
      from: [], depth: 0 });
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
    const definition = estateById.get(m.id);
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
      const estate = estateById.get(row.id);
      if (estate) row.links = [estate.id, ...estate.links];
      ordered.push(row); remaining.delete(id);
    }
  }
  const settled = new Set(ordered.filter((row) => ['merged', 'cut', 'superseded', 'passed', 'settled'].includes(row.state)).map((row) => row.id));
  const open = ordered.filter((row) => !settled.has(row.id));
  cache.set(display, { full: ordered, open, settled });
  return full ? ordered : open;
}
