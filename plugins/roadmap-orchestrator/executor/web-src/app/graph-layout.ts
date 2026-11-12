import type { GraphData } from './graph-data.ts';
export const NODE_WIDTH = 248, NODE_HEIGHT = 128, LABEL_PX = 16, MIN_LABEL_PX = 11;
/** Titles show once a card holds readable text and its status row: the model font grows so titles stay at 11 px or more. */
export const TITLE_MIN_ZOOM = .5;
/** Compact identifiers sit right of the status glyph; these reserve the glyph's width (left inset, glyph, gap) in screen pixels. */
export const TINY_ZOOM = .25, TINY_GLYPH_RESERVE = 10, GLYPH_RESERVE = 18;
export const MIN_ID_PX = 10;
/** A compact id too long for its card keeps at least this many characters around its ellipsis (fewer stop telling ids
 * apart), or the Graph moves to the label-less whole-arc tier. */
export const MIN_ID_CHARS = 6;
// The space belongs to the relationships: never compress these floors to fit.
export const ROW_GAP = 80, COLUMN_GAP = 384;
export type Point = { x: number; y: number };
/** A drawn group of units. A milestone band holds exactly its members and its gate; an outside group holds units of no
 * milestone, placed where they sit in the flow (just before the band whose work needs them, or after the last band). */
export type Band = { id: string; kind: 'milestone' | 'outside'; label: string; ids: string[]; x: number; y: number; width: number; height: number };
/** A line-map station: one per milestone, then No milestone. Counts are membership (console/milestones.ts), never placement.
 * `frame` is what selecting it shows: a milestone's members, its gate and the outside units placed just before it. */
export type Station = { id: string; label: string; passed: number; total: number; withdrawn: number; state: string; frame: string[]; groups: string[] };
export function graphLayout(e: GraphData) {
  const started = performance.now(), m = e;
  const gates = e.milestones ?? [];
  // Membership decides a member's band. Dependencies never move a member out of it.
  const memberOf = new Map<string, number>();
  gates.forEach((gate, i) => { for (const id of gate.units) if (!memberOf.has(id)) memberOf.set(id, i); });
  const parentsOf = new Map<string, string[]>(), childrenOf = new Map<string, string[]>(), waitsOn = new Map<string, number[]>();
  for (const edge of e.dependencies) {
    if (edge.type === 'after') { parentsOf.set(edge.unit, [...parentsOf.get(edge.unit) ?? [], edge.effective]); childrenOf.set(edge.effective, [...childrenOf.get(edge.effective) ?? [], edge.unit]); }
    else waitsOn.set(edge.unit, [...waitsOn.get(edge.unit) ?? [], gates.findIndex(g => g.id === edge.milestone)]);
  }
  // Dependencies before dependants; input order breaks ties, so the layout stays deterministic.
  const flow: string[] = [], pending = new Map(m.units.map(u => [u.id, (parentsOf.get(u.id) ?? []).length]));
  const ready = m.units.filter(u => pending.get(u.id) === 0).map(u => u.id);
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!; flow.push(id);
    for (const child of childrenOf.get(id) ?? []) { const left = pending.get(child)! - 1; pending.set(child, left); if (left === 0) ready.push(child); }
  }
  if (flow.length !== m.units.length) throw new Error(`graph dependencies form a cycle through ${m.units.filter(u => pending.get(u.id)! > 0).map(u => u.id).join(', ')}`);
  // A unit of no milestone takes slot k: the outside group just before band k (gates.length: after the last band).
  // It comes after the latest milestone it waits on, directly or through what it depends on, and as late as the
  // earliest band that needs it allows, so it sits beside the work it feeds. Waiting wins over feeding: a member that
  // needs a unit placed after its own band keeps its band, and that edge is drawn running backwards.
  const earliest = new Map<string, number>(), slot = new Map<string, number>();
  for (const id of flow) if (!memberOf.has(id)) {
    let after = -Infinity;
    for (const gate of waitsOn.get(id) ?? []) after = Math.max(after, gate + 1);
    for (const parent of parentsOf.get(id) ?? []) after = Math.max(after, memberOf.has(parent) ? memberOf.get(parent)! + 1 : earliest.get(parent)!);
    earliest.set(id, after);
  }
  for (const id of [...flow].reverse()) if (!memberOf.has(id)) {
    let needed = Infinity;
    for (const child of childrenOf.get(id) ?? []) needed = Math.min(needed, memberOf.get(child) ?? slot.get(child)!);
    const after = earliest.get(id)!;
    // Unconnected to any milestone: the trailing No milestone group.
    slot.set(id, needed < Infinity ? Math.max(after, needed) : after > -Infinity ? after : gates.length);
  }
  const outside = (k: number) => m.units.filter(u => slot.get(u.id) === k).map(u => u.id);
  const group = (id: string, kind: Band['kind'], label: string, ids: string[]): Band => ({ id, kind, label, ids, x: 0, y: 0, width: 0, height: 0 });
  const bands: Band[] = [], stations: Station[] = [];
  gates.forEach((g, i) => {
    const lead = outside(i), members = g.units.filter(id => memberOf.get(id) === i), id = `milestone:${g.id}`;
    if (lead.length) bands.push(group(`lead:${g.id}`, 'outside', 'No milestone', lead));
    bands.push(group(id, 'milestone', g.name ?? g.id, members));
    stations.push({ id, label: g.name ?? g.id, passed: g.merged, total: g.total, withdrawn: g.withdrawn, state: g.signal, frame: [...lead, ...members, id], groups: [...lead.length ? [`lead:${g.id}`] : [], id] });
  });
  const trailing = outside(gates.length);
  if (trailing.length) bands.push(group('unbound', 'outside', 'No milestone', trailing));
  const unplaced = m.units.filter(u => !memberOf.has(u.id)).map(u => u.id);
  if (unplaced.length) stations.push({ id: 'unbound', label: 'No milestone', passed: e.noMilestone.merged, total: e.noMilestone.total, withdrawn: e.noMilestone.withdrawn, state: 'pending', frame: unplaced, groups: bands.filter(b => b.kind === 'outside').map(b => b.id) });
  const assigned = new Set(bands.flatMap(b => b.ids));
  const positions = new Map<string, Point>();
  const unitEdges = m.graph.edges.filter(([a,b]) => assigned.has(a) && (assigned.has(b) || b.startsWith('milestone:')));
  const incoming = new Map<string, string[]>();
  for (const [a,b] of unitEdges) incoming.set(b, [...incoming.get(b) ?? [], a]);
  const columns: string[][] = [], columnOf = new Map<string, number>();
  for (const band of bands) {
    const ids = new Set(band.ids), ranks = new Map(band.ids.map(id => [id, 0]));
    // Longest dependency distance within the milestone, independent of status
    // and focus. Stable input order is also the tie-break for disconnected work.
    for (let pass = 0; pass < band.ids.length; pass++) {
      let changed = false;
      for (const id of band.ids) for (const parent of incoming.get(id) ?? []) if (ids.has(parent)) {
        const rank = Math.min(band.ids.length - 1, ranks.get(parent)! + 1);
        if (rank > ranks.get(id)!) { ranks.set(id, rank); changed = true; }
      }
      if (!changed) break;
    }
    for (let rank = 0; rank <= Math.max(0, ...ranks.values()); rank++) {
      const members = band.ids.filter(id => ranks.get(id) === rank);
      if (members.length) { for (const id of members) columnOf.set(id, columns.length); columns.push(members); }
    }
    if (band.kind === 'milestone') { columnOf.set(band.id, columns.length); columns.push([band.id]); }
  }
  // Include intermediate vertices while ordering, so a distant dependency has
  // a voice in every column it crosses. These are layout constraints, never
  // rendered junctions or routes: rendering uses the two actual endpoints.
  const ordered = columns.map(c => [...c]);
  const parents = new Map<string,string[]>(), children = new Map<string,string[]>();
  m.graph.edges.forEach(([a,b],i) => {
    if (a.startsWith('milestone:')) return;
    const first = columnOf.get(a), last = columnOf.get(b);
    if (first === undefined || last === undefined || first >= last) return;
    let previous = a;
    for (let column = first + 1; column <= last; column++) {
      const next = column === last ? b : `through:${i}:${column}`;
      if (column !== last) ordered[column]!.push(next);
      parents.set(next, [...parents.get(next) ?? [], previous]);
      children.set(previous, [...children.get(previous) ?? [], next]); previous = next;
    }
  });
  const order = new Map<string,number>();
  const refresh = (column:string[]) => column.forEach((id,i) => order.set(id,i));
  ordered.forEach(refresh);
  for (let sweep = 0; sweep < 8; sweep++) {
    const forward = sweep % 2 === 0, neighbours = forward ? parents : children;
    for (const column of forward ? ordered : [...ordered].reverse()) {
      const barycentre = (id:string) => { const adjacent=neighbours.get(id) ?? []; return adjacent.length ? adjacent.reduce((sum,n)=>sum+order.get(n)!,0)/adjacent.length : order.get(id)!; };
      const scores = new Map(column.map(id=>[id,barycentre(id)]));
      column.sort((a,b)=>scores.get(a)!-scores.get(b)! || order.get(a)!-order.get(b)!);
      refresh(column);
    }
  }
  let x = 36;
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i]!, width = NODE_WIDTH;
    column.sort((a,b)=>order.get(a)!-order.get(b)!);
    // Virtual vertices reserve breathing room for long edges, but not lanes.
    let y = 64;
    for (const id of ordered[i]!) {
      if (columnOf.has(id)) { positions.set(id,{x:x+width/2,y:y+NODE_HEIGHT/2}); y += NODE_HEIGHT+ROW_GAP; }
      else y += 20;
    }
    x += width + COLUMN_GAP;
  }
  // Align each rank to the barycentre of its actual dependencies without
  // changing its order or the minimum vertical separation.
  for (let sweep = 0; sweep < 4; sweep++) for (const column of columns) {
    let bottom = -Infinity;
    for (const id of column) {
      const p=positions.get(id)!, adjacent=incoming.get(id) ?? [];
      const desired=adjacent.length ? adjacent.reduce((sum,n)=>sum+positions.get(n)!.y,0)/adjacent.length : p.y;
      p.y=Math.max(bottom+NODE_HEIGHT+ROW_GAP,desired); bottom=p.y;
    }
  }
  for (const band of bands) {
    const points=[...band.ids,...(band.kind==='milestone'?[band.id]:[])].map(id=>positions.get(id)!);
    band.x=Math.min(...points.map(p=>p.x-NODE_WIDTH/2))-36;
    band.y=Math.min(...points.map(p=>p.y-NODE_HEIGHT/2))-48;
    band.width=Math.max(...points.map(p=>p.x+NODE_WIDTH/2))-band.x+36;
    band.height=Math.max(...points.map(p=>p.y+NODE_HEIGHT/2))-band.y+48;
  }
  return { compact: false, bands, stations, positions, width: Math.max(0,x-COLUMN_GAP+36), height: Math.max(0,...bands.map(b=>b.y+b.height)), elapsed: performance.now()-started };
}

/** Dagster's horizontal diagonal. No global lanes, trunks or off-region turns. */
export function horizontalDiagonal(a: Point, b: Point) {
  const middle = (a.x+b.x)/2;
  return `M ${a.x} ${a.y} C ${middle} ${a.y}, ${middle} ${b.y}, ${b.x} ${b.y}`;
}
export type EdgeCurve = { source:string; target:string; points: Point[]; path:string };
/** A direct S, with local bows only where a skipped rank contains a card.
 * Each bow clears that card in its immediate neighbourhood. It never sends a
 * relationship to a band boundary, shared corridor, or outside its endpoints.
 */
export function graphCurves(e: GraphData, positions: Map<string,Point>): EdgeCurve[] {
  const clearances=new Map<number,number[]>();
  const boxes=e.graph.units.map(u=>{const p=positions.get(u.id)!;const w=NODE_WIDTH;return {id:u.id,left:p.x-w/2-16,right:p.x+w/2+16,top:p.y-NODE_HEIGHT/2-16,bottom:p.y+NODE_HEIGHT/2+16};});
  // A dependency whose dependant sits to its left (a member needing work placed after its own band) runs backwards:
  // it is routed exactly as a forward one in the mirrored plane, so it leaves the source's left side, enters the
  // target's right side, and bows around cards between them the same way.
  const mirrored=boxes.map(box=>({...box,left:-box.right,right:-box.left}));
  const curves:EdgeCurve[]=[];
  // Quiet waits must not displace the visible unit relationships.
  const edges=[...e.graph.edges.entries()].sort((a,b)=>Number(a[1][0].startsWith('milestone:'))-Number(b[1][0].startsWith('milestone:')));
  for(const [edgeIndex,[source,target]] of edges){
    const p=positions.get(source)!,q=positions.get(target)!,dir=q.x<p.x?-1:1,plane=dir===1?boxes:mirrored;
    const a={x:dir*p.x+NODE_WIDTH/2+3,y:p.y},b={x:dir*q.x-NODE_WIDTH/2-5,y:q.y};
    const yAt=(x:number, start=a, end=b)=>{
      let low=0,high=1;
      for(let i=0;i<16;i++){const t=(low+high)/2,u=1-t,px=u*u*u*start.x+3*u*u*t*(start.x+end.x)/2+3*u*t*t*(start.x+end.x)/2+t*t*t*end.x;if(px<x)low=t;else high=t;}
      const t=(low+high)/2;return start.y+(end.y-start.y)*(3*t*t-2*t*t*t);
    };
    const ranks=new Map<number,typeof plane>();
    for(const box of plane)if(box.id!==source&&box.id!==target&&box.left>a.x&&box.right<b.x)ranks.set(box.left,[...ranks.get(box.left)??[],box]);
    const points=[a,b], cleared=new Set<number>();
    const sorted=[...ranks].sort(([a],[b])=>a-b);
    // Adding a local bow can intersect a neighbouring rank that the original
    // S cleared. Recheck only those remaining ranks until every span is clear.
    // Each iteration adds at least one rank, so work is bounded by column count.
    for (let pass=0; pass<sorted.length; pass++) {
      let changed=false;
      for(const [key,rank] of sorted) {
        if(cleared.has(key))continue;
        const left=rank[0]!.left,right=Math.max(...rank.map(n=>n.right));
        const index=points.findIndex((p,i)=>i>0&&p.x>left),start=points[index-1]!,end=points[index]!;
        const ys=[yAt(left,start,end),yAt(right,start,end)],lo=Math.min(...ys),hi=Math.max(...ys);
        if(!rank.some(n=>n.top<hi&&n.bottom>lo))continue;
        const middle=yAt((left+right)/2), intervals=rank.map(n=>[n.top,n.bottom]).sort((a,b)=>a[0]!-b[0]!);
        // Independent bows must not merge into a shared segment beside a card.
        const clearance=8+(edgeIndex%23)*1.5;
        const safe=(y:number)=>intervals.every(([top,bottom])=>y<top!||y>bottom!)&&Math.abs(y-middle)<=NODE_HEIGHT;
        const candidates=[middle,...intervals.flatMap(([top,bottom])=>[top!-clearance,bottom!+clearance])].filter(safe);
        const used=clearances.get(key)??[];
        // If two independent bows happen to coincide, separate them locally
        // by at least 1.5 world pixels. Never move either edge to a shared lane.
        candidates.sort((x,y)=>Math.abs(x-middle)-Math.abs(y-middle)||x-y);
        const available=(y:number)=>safe(y)&&used.every(other=>Math.abs(other-y)>=1.5);
        let y=candidates[0]!;
        if(!available(y)) {
          search: for(const candidate of candidates)for(let step=0;step<=32;step++)for(const sign of [-1,1]) {
            const value=candidate+sign*step*1.5;
            if(available(value)){y=value;break search;}
          }
          // Extremely dense stress graphs can fill the local gap. Retain a
          // distinct path without widening the bow beyond the adjacent card.
          if(used.includes(y))for(let step=1;step<=1024;step++) {
            const value=candidates[0]!+(step%2?1:-1)*Math.ceil(step/2)/32;
            if(safe(value)&&!used.includes(value)){y=value;break;}
          }
        }
        clearances.set(key,[...used,y]);
        points.splice(index,0,{x:left-16,y},{x:right+16,y});cleared.add(key);changed=true;
      }
      if(!changed)break;
    }
    // At clear spans this is exactly one horizontal diagonal. A local bow is
    // tangent-continuous at its two clearance points; all x coordinates advance
    // (toward the target: a backward edge's advance leftwards).
    const real=points.map(p=>({x:dir*p.x,y:p.y}));
    const path=real.length===2?horizontalDiagonal(real[0]!,real[1]!):real.slice(1).reduce((path,p,i)=>path+' '+horizontalDiagonal(real[i]!,p).replace(/^M [^C]+/,' '),`M ${real[0]!.x} ${real[0]!.y}`);
    curves[edgeIndex]={source,target,points:real,path};
  }
  return curves;
}

/** The live units and only their direct unit neighbours, never transitive gate fan-out. */
export function activeFocus(e: GraphData) {
  const seeds=e.graph.units.filter(u=>!u.id.startsWith('milestone:')&&u.status==='active').map(u=>u.id);
  const neighbours=(ids:string[])=>{
    const result=new Set(ids);
    for(const [a,b] of e.graph.edges)if(!a.startsWith('milestone:')&&!b.startsWith('milestone:')&&(ids.includes(a)||ids.includes(b))){result.add(a);result.add(b);}
    return [...result];
  };
  return { seeds, ids:neighbours(seeds) };
}
/** One name per unit at every tier: its id. The recorded system is secondary text, shown only when it fits. */
export function compactIdentifier(e: GraphData, id: string) {
  return id.startsWith('milestone:') ? id.slice(10) : id;
}
export function compactSystem(e: GraphData, id: string): string | null {
  return e.units.find(u => u.id === id)?.systems[0] ?? null;
}
