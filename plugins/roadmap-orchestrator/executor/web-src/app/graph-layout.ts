import dagre from '@dagrejs/dagre';
import type { Envelope } from './types.ts';
export type Band = { id: string; label: string; ids: string[]; passed: number; total: number; state: string; x: number; width: number; height: number };
export function graphLayout(e: Envelope) {
  const started = performance.now(), m = e.data.console;
  const gates = e.data.plan?.milestones ?? [];
  const assigned = new Map<string, number>();
  gates.forEach((gate, i) => { for (const id of gate.units) if (!assigned.has(id)) assigned.set(id, i); });
  for (const u of m.presentation.units) if (!assigned.has(u.id)) assigned.set(u.id, gates.length);
  // A unit behind a gate belongs after that gate, even when it feeds several later gates.
  for (const edge of e.data.display.status.edges) if (edge.type === 'milestone') {
    const index = gates.findIndex(g => g.id === edge.milestone);
    assigned.set(edge.unit, Math.max(assigned.get(edge.unit) ?? 0, index + 1));
  }
  for (let pass = 0; pass < gates.length + 1; pass++) for (const edge of e.data.display.status.edges) if (edge.type === 'after') assigned.set(edge.unit, Math.max(assigned.get(edge.unit) ?? 0, assigned.get(edge.effective) ?? 0));
  const bands: Band[] = gates.map(g => {
    const state = e.data.display.status.milestones.find(v => v.id === g.id);
    return { id: `milestone:${g.id}`, label: g.text || g.id, ids: [], passed: g.units.filter(id => m.graph.units.find(v => v.id === id)?.status === 'passed').length, total: g.units.length, state: state?.passed ? 'passed' : state?.state === 'walking' ? 'active' : state?.state === 'blocked' ? 'held' : 'pending', x: 0, width: 0, height: 0 };
  });
  if ([...assigned.values()].some(i => i >= gates.length)) bands.push({ id: 'unbound', label: 'No milestone', ids: [], passed: 0, total: 0, state: 'pending', x: 0, width: 0, height: 0 });
  for (const [id, index] of assigned) bands[Math.min(index, bands.length - 1)]?.ids.push(id);
  const last = bands.find(b => b.id === 'unbound');
  if (last) { last.total = last.ids.length; last.passed = last.ids.filter(id => m.graph.units.find(v => v.id === id)?.status === 'passed').length; }
  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const band of bands) {
    const ids = new Set(band.ids), graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR', nodesep: 20, ranksep: m.presentation.units.length<=4?24:64, marginx: 36, marginy: 48 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const id of band.ids) graph.setNode(id, { width: 176, height: 56 });
    if (band.id !== 'unbound') { ids.add(band.id); graph.setNode(band.id, { width: 48, height: 48 }); }
    for (const [a,b] of m.graph.edges) if (ids.has(a) && ids.has(b)) graph.setEdge(a,b);
    // Gates at the right end of each band; invisible layout-only links give unconnected blocks a track.
    if (band.id !== 'unbound') for (const id of band.ids) if (!graph.outEdges(id)?.length) graph.setEdge(id,band.id);
    dagre.layout(graph);
    band.x = x; band.width = Math.max(260, graph.graph().width ?? 0); band.height = Math.max(180, graph.graph().height ?? 0);
    for (const id of ids) { const point = graph.node(id); positions.set(id, { x: x + point.x, y: point.y }); }
    x += band.width + 56;
  }
  const height = Math.max(0, ...bands.map(b => b.height));
  for (const band of bands) for (const id of [...band.ids, band.id]) { const p = positions.get(id); if (p) p.y += (height - band.height) / 2; }
  return { bands, positions, height, elapsed: performance.now() - started };
}
