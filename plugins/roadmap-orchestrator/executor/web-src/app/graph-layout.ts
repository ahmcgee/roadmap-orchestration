import dagre from '@dagrejs/dagre';
import type { Envelope } from './types.ts';
export const NODE_WIDTH = 248, NODE_HEIGHT = 80, LABEL_PX = 16, MIN_LABEL_PX = 11;
export type Band = { id: string; label: string; ids: string[]; passed: number; total: number; state: string; x: number; y: number; width: number; height: number };
export function graphLayout(e: Envelope, aspect?: number) {
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
    return { id: `milestone:${g.id}`, label: g.text || g.id, ids: [], passed: g.units.filter(id => m.graph.units.find(v => v.id === id)?.status === 'passed').length, total: g.units.length, state: state?.passed ? 'passed' : state?.state === 'walking' ? 'active' : state?.state === 'blocked' ? 'held' : 'pending', x: 0, y: 0, width: 0, height: 0 };
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
    let height = 180;
    for (const [, rank] of [...ranks].sort(([a],[b]) => a-b)) {
      rank.sort((a,b) => graph.node(a).y-graph.node(b).y || a.localeCompare(b));
      const columns = Math.ceil(rank.length / 10), rows = Math.ceil(rank.length / columns);
      height = Math.max(height, rows * (NODE_HEIGHT + 20) + 76);
      rank.forEach((id, i) => positions.set(id, {x: column + Math.floor(i / rows) * (NODE_WIDTH + 40) + NODE_WIDTH/2, y: 64 + (i % rows) * (NODE_HEIGHT + 20) + NODE_HEIGHT/2}));
      column += columns * (NODE_WIDTH + 40) + 16;
    }
    band.width = Math.max(220, column + (band.id === 'unbound' ? 0 : 80)); band.height = height;
    if (band.id !== 'unbound') positions.set(band.id, {x: band.width-40,y:height/2});
  }
  // All is an overview: wrap whole bands in plan order to use the actual viewport
  // aspect ratio. Active and milestone views retain the left-to-right line.
  let columns = bands.length || 1;
  if (aspect) {
    let best = Infinity;
    for (let count=1; count<=bands.length; count++) {
      let width=0,height=0;
      for (let i=0;i<bands.length;i+=count) { const row=bands.slice(i,i+count);width=Math.max(width,row.reduce((n,b)=>n+b.width+56,0));height+=Math.max(...row.map(b=>b.height))+96; }
      const score=Math.abs(Math.log(width / height / aspect));
      if(score<best){best=score;columns=count;}
    }
  }
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
/** Bring the live neighbourhood together without duplicating units or changing edges.
 * The rest of the arc remains below it, available by panning or explicit focus. */
export function activeLayout(e: Envelope, base: ReturnType<typeof graphLayout>, ids: string[], phone: boolean) {
  const positions=new Map([...base.positions].map(([id,p])=>[id,{...p}]));
  const graph=new dagre.graphlib.Graph();graph.setGraph({rankdir:phone?'TB':'LR',nodesep:24,ranksep:phone?38:64,marginx:36,marginy:64});graph.setDefaultEdgeLabel(()=>({}));
  for(const id of ids)graph.setNode(id,{width:NODE_WIDTH,height:NODE_HEIGHT});
  for(const [a,b] of e.data.console.graph.edges)if(ids.includes(a)&&ids.includes(b))graph.setEdge(a,b);
  dagre.layout(graph);
  const width=Math.max(280,graph.graph().width??280),height=Math.max(180,graph.graph().height??180);
  // Keep the complete original graph below the focused neighbourhood.
  for(const p of positions.values())p.y+=height+160;
  for(const id of ids){const p=graph.node(id);positions.set(id,{x:p.x,y:p.y});}
  const focused:Band={id:'active-context',label:'Active and direct neighbours',ids,passed:0,total:ids.length,state:'active',x:0,y:0,width,height};
  return {...base,positions,bands:[focused,...base.bands.map(b=>({...b,y:b.y+height+160,ids:b.ids.filter(id=>!ids.includes(id))}))],width:Math.max(width,base.width),height:base.height+height+160};
}

/** Compact identifiers use the recorded system, never a guessed title fragment. */
export function compactIdentifier(e: Envelope, id: string) {
  if (id.startsWith('milestone:')) return id.slice(10);
  const systems=e.data.plan?.units.find(u=>u.id===id)?.systems??[];
  return [...systems, /^u\d+$/.test(id)?id.slice(1):id].join(' ');
}
/** Pack the All view by readable identifier widths. Only positions change; every
 * dependency remains an individual edge. Eight model pixels per screen pixel
 * leave room for full titles when the user zooms back in. */
export function overviewLayout(e: Envelope, base: ReturnType<typeof graphLayout>, width: number, height: number, measure: (text: string)=>number) {
  const narrow=width<=640, scale=8, gap=narrow?2:12, row=narrow?12:28, bandGap=narrow?0:24;
  const columns=narrow?1:Math.min(5,Math.max(1,Math.floor(width/260)));
  const bandWidth=(width-bandGap*(columns-1))/columns;
  const positions=new Map<string,{x:number;y:number}>(), sizes=new Map<string,{width:number;height:number}>();
  const packed=base.bands.map(b=>{
    const rows: {used:number;items:{id:string;width:number}[]}[]=[{used:narrow?88:0,items:[]}];
    // Stable width-first packing avoids wasting a whole row on a long system name.
    const items=b.ids.map(id=>({id,width:Math.ceil(measure(compactIdentifier(e,id)))+(narrow?4:16)})).sort((a,b)=>b.width-a.width||a.id.localeCompare(b.id,undefined,{numeric:true}));
    for(const item of items){let r=rows.find(r=>r.used+item.width<=bandWidth);if(!r){r={used:0,items:[]};rows.push(r);}r.items.push(item);r.used+=item.width+gap;}
    return {band:b,rows,height:rows.length*row+(narrow?0:26)};
  });
  const naturalHeight=Array.from({length:Math.ceil(packed.length/columns)},(_,i)=>Math.max(...packed.slice(i*columns,(i+1)*columns).map(b=>b.height))).reduce((a,b)=>a+b+bandGap,0)-bandGap;
  // Use spare vertical room between bands, keeping the last row above the controls.
  const extra=Math.max(0,(height-naturalHeight)/Math.max(1,Math.ceil(packed.length/columns)-1));
  let y=0;
  const bands:Band[]=[];
  for(let i=0;i<packed.length;i+=columns){
    const group=packed.slice(i,i+columns),groupHeight=Math.max(...group.map(b=>b.height));
    group.forEach(({band,rows},column)=>{
      const x=column*(bandWidth+bandGap), header=narrow?0:26;
      rows.forEach((r,j)=>{let cursor=j===0&&narrow?88:0;for(const item of r.items){positions.set(item.id,{x:(x+cursor+item.width/2)*scale,y:(y+header+j*row+row/2)*scale});sizes.set(item.id,{width:(item.width-gap)*scale,height:(row-(narrow?1:6))*scale});cursor+=item.width+gap;}});
      if(band.id!=='unbound'){positions.set(band.id,{x:(x+(narrow?72:bandWidth-20))*scale,y:(y+(narrow?row/2:10))*scale});sizes.set(band.id,{width:28*scale,height:11*scale});}
      bands.push({...band,x:x*scale,y:y*scale,width:bandWidth*scale,height:groupHeight*scale});
    });
    y+=groupHeight+bandGap+extra;
  }
  return {...base,compact:true,bands,positions,sizes,width:width*scale,height:(y-bandGap-extra)*scale};
}
