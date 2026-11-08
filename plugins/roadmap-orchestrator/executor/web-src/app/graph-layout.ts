import dagre from '@dagrejs/dagre';
import type { Envelope } from './types.ts';
export const NODE_WIDTH = 248, NODE_HEIGHT = 80, LABEL_PX = 16, MIN_LABEL_PX = 11;
export type Band = { id: string; label: string; ids: string[]; passed: number; total: number; state: string; x: number; y: number; width: number; height: number };
export function graphLayout(e: Envelope) {
  const started = performance.now(), m = e.data.console;
  const gates = e.data.plan?.milestones ?? [];
  const assigned = new Map<string, number>();
  gates.forEach((gate, i) => { for (const id of gate.units) if (!assigned.has(id)) assigned.set(id, i); });
  for (const u of m.presentation.units) if (!assigned.has(u.id)) assigned.set(u.id, gates.length);
  for (const edge of e.data.display.status.edges) if (edge.type === 'milestone') {
    const index = gates.findIndex(g => g.id === edge.milestone);
    assigned.set(edge.unit, Math.max(assigned.get(edge.unit) ?? 0, index + 1));
  }
  for (let pass = 0; pass < gates.length + 1; pass++) for (const edge of e.data.display.status.edges) if (edge.type === 'after') assigned.set(edge.unit, Math.max(assigned.get(edge.unit) ?? 0, assigned.get(edge.effective) ?? 0));
  const bands: Band[] = gates.map(g => {
    const state = e.data.display.status.milestones.find(v => v.id === g.id);
    return { id: `milestone:${g.id}`, label: g.name ?? g.id, ids: [], passed: g.units.filter(id => m.graph.units.find(v => v.id === id)?.status === 'passed').length, total: g.units.length, state: state?.passed ? 'passed' : state?.state === 'walking' ? 'active' : state?.state === 'blocked' ? 'held' : 'pending', x: 0, y: 0, width: 0, height: 0 };
  });
  if ([...assigned.values()].some(i => i >= gates.length)) bands.push({ id: 'unbound', label: 'No milestone', ids: [], passed: 0, total: 0, state: 'pending', x: 0, y: 0, width: 0, height: 0 });
  for (const [id, index] of assigned) bands[Math.min(index, bands.length - 1)]?.ids.push(id);
  const last = bands.find(b => b.id === 'unbound');
  if (last) { last.total = last.ids.length; last.passed = last.ids.filter(id => m.graph.units.find(v => v.id === id)?.status === 'passed').length; }
  const positions = new Map<string, { x: number; y: number }>();
  for (const band of bands) {
    const ids = new Set(band.ids), graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR', nodesep: 20, ranksep: 56, marginx: 36, marginy: 48 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const id of band.ids) graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    // Only actual unit dependencies determine rank; gate placement is layout only.
    for (const [a,b] of m.graph.edges) if (ids.has(a) && ids.has(b)) graph.setEdge(a,b);
    dagre.layout(graph);
    const ranks = new Map<number, string[]>();
    for (const id of band.ids) { const x = graph.node(id).x; ranks.set(x, [...ranks.get(x) ?? [], id]); }
    let column = 36;
    const sources=new Set(e.data.console.graph.edges.filter(([a,b])=>a.startsWith('milestone:')&&ids.has(b)).map(([a])=>a));
    const header=48+sources.size*24;
    let height = header+120;
    for (const [, rank] of [...ranks].sort(([a],[b]) => a-b)) {
      rank.sort((a,b) => graph.node(a).y-graph.node(b).y || a.localeCompare(b));
      const columns = Math.ceil(rank.length / 10), rows = Math.ceil(rank.length / columns);
      height = Math.max(height, rows * (NODE_HEIGHT + 24) + header + 32);
      rank.forEach((id, i) => positions.set(id, {x: column + Math.floor(i / rows) * (NODE_WIDTH + 40) + NODE_WIDTH/2, y: header + (i % rows) * (NODE_HEIGHT + 24) + NODE_HEIGHT/2}));
      column += columns * (NODE_WIDTH + 40) + 16;
    }
    band.width = Math.max(220, column + (band.id === 'unbound' ? 0 : 160)); band.height = height;
    if (band.id !== 'unbound') positions.set(band.id, {x: band.width-80,y:height/2});
  }
  const columns = bands.length || 1;
  let y=0,width=0;
  for(let i=0;i<bands.length;i+=columns){
    const row=bands.slice(i,i+columns),rowHeight=Math.max(...row.map(b=>b.height));let x=0;
    for(const band of row){band.x=x;band.y=y+(rowHeight-band.height)/2;for(const id of [...band.ids,band.id]){const p=positions.get(id);if(p){p.x+=x;p.y+=band.y;}}x+=band.width+56;}
    width=Math.max(width,x-56);y+=rowHeight+96;
  }
  return { compact: false, bands, positions, width, height: Math.max(0,y-96), elapsed: performance.now()-started };
}
/** The live units and only their direct unit neighbours, never transitive gate fan-out. */
export function activeFocus(e: Envelope) {
  const units=e.data.console.presentation.units, active=e.data.console.graph.units.filter(u=>!u.id.startsWith('milestone:')&&u.status==='active').map(u=>u.id);
  const seeds=active.length?active:[...units].sort((a,b)=>{
    const changed=(u:typeof a)=>Math.max(0,...u.journey.flatMap(s=>[Date.parse(s.at)||0,Date.parse(s.endedAt??'')||0]));
    return changed(b)-changed(a)||a.id.localeCompare(b.id);
  }).slice(0,3).map(u=>u.id);
  const neighbours=(ids:string[])=>{
    const result=new Set(ids);
    for(const [a,b] of e.data.console.graph.edges)if(!a.startsWith('milestone:')&&!b.startsWith('milestone:')&&(ids.includes(a)||ids.includes(b))){result.add(a);result.add(b);}
    return [...result];
  };
  return { seeds, ids:neighbours(seeds), clusters:seeds.map(id=>neighbours([id])), recent:active.length===0 };
}
/** Compact identifiers use the recorded system, never a guessed title fragment. */
export function compactIdentifier(e: Envelope, id: string) {
  if (id.startsWith('milestone:')) return id.slice(10);
  const systems=e.data.plan?.units.find(u=>u.id===id)?.systems??[];
  return [...systems, /^u\d+$/.test(id)?id.slice(1):id].join(' ');
}
