import type { Envelope } from './types.ts';
export const NODE_WIDTH = 248, NODE_HEIGHT = 128, LABEL_PX = 16, MIN_LABEL_PX = 11;
// The space belongs to the relationships: never compress these floors to fit.
export const ROW_GAP = 80, COLUMN_GAP = 384;
export type Point = { x: number; y: number };
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
    if (band.id !== 'unbound') { columnOf.set(band.id, columns.length); columns.push([band.id]); }
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
    const points=[...band.ids,...(band.id==='unbound'?[]:[band.id])].map(id=>positions.get(id)!);
    band.x=Math.min(...points.map(p=>p.x-NODE_WIDTH/2))-36;
    band.y=Math.min(...points.map(p=>p.y-NODE_HEIGHT/2))-48;
    band.width=Math.max(...points.map(p=>p.x+NODE_WIDTH/2))-band.x+36;
    band.height=Math.max(...points.map(p=>p.y+NODE_HEIGHT/2))-band.y+48;
  }
  return { compact: false, bands, positions, width: Math.max(0,x-COLUMN_GAP+36), height: Math.max(0,...bands.map(b=>b.y+b.height)), elapsed: performance.now()-started };
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
export function graphCurves(e: Envelope, positions: Map<string,Point>): EdgeCurve[] {
  const clearances=new Map<number,number[]>();
  const boxes=e.data.console.graph.units.map(u=>{const p=positions.get(u.id)!;const w=NODE_WIDTH;return {id:u.id,left:p.x-w/2-16,right:p.x+w/2+16,top:p.y-NODE_HEIGHT/2-16,bottom:p.y+NODE_HEIGHT/2+16};});
  const curves:EdgeCurve[]=[];
  // Quiet waits must not displace the visible unit relationships.
  const edges=[...e.data.console.graph.edges.entries()].sort((a,b)=>Number(a[1][0].startsWith('milestone:'))-Number(b[1][0].startsWith('milestone:')));
  for(const [edgeIndex,[source,target]] of edges){
    const p=positions.get(source)!,q=positions.get(target)!;
    const a={x:p.x+NODE_WIDTH/2+3,y:p.y},b={x:q.x-NODE_WIDTH/2-5,y:q.y};
    const yAt=(x:number, start=a, end=b)=>{
      let low=0,high=1;
      for(let i=0;i<16;i++){const t=(low+high)/2,u=1-t,px=u*u*u*start.x+3*u*u*t*(start.x+end.x)/2+3*u*t*t*(start.x+end.x)/2+t*t*t*end.x;if(px<x)low=t;else high=t;}
      const t=(low+high)/2;return start.y+(end.y-start.y)*(3*t*t-2*t*t*t);
    };
    const ranks=new Map<number,typeof boxes>();
    for(const box of boxes)if(box.id!==source&&box.id!==target&&box.left>a.x&&box.right<b.x)ranks.set(box.left,[...ranks.get(box.left)??[],box]);
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
    // tangent-continuous at its two clearance points; all x coordinates advance.
    const path=points.length===2?horizontalDiagonal(a,b):points.slice(1).reduce((path,p,i)=>path+' '+horizontalDiagonal(points[i]!,p).replace(/^M [^C]+/,' '),`M ${a.x} ${a.y}`);
    curves[edgeIndex]={source,target,points,path};
  }
  return curves;
}

/** The live units and only their direct unit neighbours, never transitive gate fan-out. */
export function activeFocus(e: Envelope) {
  const seeds=e.data.console.graph.units.filter(u=>!u.id.startsWith('milestone:')&&u.status==='active').map(u=>u.id);
  const neighbours=(ids:string[])=>{
    const result=new Set(ids);
    for(const [a,b] of e.data.console.graph.edges)if(!a.startsWith('milestone:')&&!b.startsWith('milestone:')&&(ids.includes(a)||ids.includes(b))){result.add(a);result.add(b);}
    return [...result];
  };
  return { seeds, ids:neighbours(seeds) };
}
/** Compact identifiers use the recorded system, never a guessed title fragment. */
export function compactIdentifier(e: Envelope, id: string) {
  if (id.startsWith('milestone:')) return id.slice(10);
  const systems=e.data.plan?.units.find(u=>u.id===id)?.systems??[];
  return [...systems, /^u\d+$/.test(id)?id.slice(1):id].join(' ');
}
