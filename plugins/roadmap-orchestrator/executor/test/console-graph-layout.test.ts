import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservationCache } from '../src/observation/cache.ts';
import { consoleModel } from '../src/console/model.ts';
const { graphLayout } = await import(new URL('../web-src/app/graph-layout.ts', import.meta.url).href) as {
 graphLayout: (e: unknown) => { positions: Map<string,{x:number;y:number}>; bands: {id:string;ids:string[];x:number;width:number;height:number}[];elapsed:number };
};
import { investigationFixture } from './fixtures/console-investigations.ts';

test('milestone bands include all units and gates, preserve gate waits, and produce deterministic non-overlapping blocks',async t=>{
 const f=await investigationFixture(60);t.after(()=>f.close());
 const observed=new ObservationCache(f.hostDir,'graph-layout','graph').read({runDir:f.runDir,arc:f.arc});
 const {events:_,...data}=observed.data;const e={...observed,data:{...data,console:consoleModel(observed)}};
 const a=graphLayout(e),b=graphLayout(e);
 assert.deepEqual(a.positions,b.positions);assert.equal(a.positions.size,e.data.console.graph.units.length);
 assert.equal(a.bands.filter(v=>v.id.startsWith('milestone:')).length,6);
 assert.ok(a.bands.some(v=>v.id==='unbound'),'units feeding no gate retain a final band');
 const all=a.bands.flatMap(v=>v.ids);assert.equal(all.length,60);assert.equal(new Set(all).size,60);
 for(let i=1;i<a.bands.length;i++)assert.ok(a.bands[i]!.x>a.bands[i-1]!.x+a.bands[i-1]!.width);
 for(const band of a.bands){
  if(band.id!=='unbound')for(const id of band.ids)assert.ok(a.positions.get(band.id)!.x>a.positions.get(id)!.x,'gate sits after its band');
  for(let i=0;i<band.ids.length;i++)for(let j=i+1;j<band.ids.length;j++){const p=a.positions.get(band.ids[i]!)!,q=a.positions.get(band.ids[j]!)!;assert.ok(Math.abs(p.x-q.x)>=248||Math.abs(p.y-q.y)>=80,'node rectangles do not overlap');}
 }
 for(const edge of e.data.display.status.edges)if(edge.type==='milestone')assert.ok(a.positions.get(edge.unit)!.x>a.positions.get(`milestone:${edge.milestone}`)!.x,'gated work follows the gate');
 assert.ok(a.elapsed>=0);
});

test('large equal ranks wrap into layout-only columns and All matches the viewport aspect',async t=>{
 const f=await investigationFixture(60);t.after(()=>f.close());
 const observed=new ObservationCache(f.hostDir,'graph-wrap','graph').read({runDir:f.runDir,arc:f.arc});const {events:_,...data}=observed.data;
 const e={...observed,data:{...data,console:consoleModel(observed)}};
 const a=graphLayout(e),unbound=a.bands.find(b=>b.id==='unbound')!;
 const columns=new Map<number,number>();for(const id of unbound.ids){const x=a.positions.get(id)!.x;columns.set(x,(columns.get(x)??0)+1);}
 assert.ok(columns.size>1);assert.ok([...columns.values()].every(count=>count<=10),'no same-rank column becomes a tower');
 assert.equal(e.data.console.graph.edges.length,consoleModel(observed).graph.edges.length,'wrapping invents no semantic edges');
 const {graphLayout:layout,activeFocus,activeLayout}=await import(new URL('../web-src/app/graph-layout.ts',import.meta.url).href);
 const all=layout(e,1.8),repeat=layout(e,1.8);assert.deepEqual(all.positions,repeat.positions);
 assert.ok(Math.abs(Math.log(all.width/all.height/1.8))<Math.abs(Math.log(a.bands.reduce((n,b)=>n+b.width+56,0)/Math.max(...a.bands.map(b=>b.height))/1.8)),'All uses more of the viewport');
 const focus=activeFocus(e);assert.ok(focus.seeds.includes('u3'));assert.ok(focus.ids.includes('u4'),'direct downstream included');assert.ok(!focus.ids.includes('u60'),'unrelated work is outside the focus');
 const current=activeLayout(e,a,focus.ids,false);assert.equal(current.positions.size,a.positions.size);assert.equal(new Set(current.bands.flatMap((b:{ids:string[]})=>b.ids)).size,60);
 const idle=structuredClone(e);idle.data.console.graph.units.forEach(u=>{if(u.status==='active')u.status='pending';});
 assert.equal(activeFocus(idle).recent,true);assert.equal(activeFocus(idle).seeds.length,3);
});
