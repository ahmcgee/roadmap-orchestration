import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Observations } from './helpers/observations.ts';
import {graphView} from '../src/console/views.ts';
const {graphData}=await import(new URL('../web-src/app/graph-data.ts',import.meta.url).href);
const { graphLayout } = await import(new URL('../web-src/app/graph-layout.ts', import.meta.url).href) as {
 graphLayout: (e: unknown) => { positions: Map<string,{x:number;y:number}>; bands: {id:string;ids:string[];x:number;width:number;height:number}[];elapsed:number };
};
import { assertGraphGeometry } from './helpers/graph-geometry.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';

test('milestone bands include all units and gates, preserve gate waits, and produce deterministic non-overlapping blocks',async t=>{
 const f=await investigationFixture(60);t.after(()=>f.close());
 const observed=new Observations(f.hostDir,'graph-layout','graph').read({runDir:f.runDir,arc:f.arc});
 const e=observed;
 assertGraphGeometry(e);
 const a=graphLayout(graphData({...observed,data:graphView(observed)})),b=graphLayout(graphData({...observed,data:graphView(observed)}));
 assert.deepEqual(a.positions,b.positions);assert.equal(a.positions.size,e.data.display.status.units.length+e.data.display.status.milestones.length);
 assert.equal(a.bands.filter(v=>v.id.startsWith('milestone:')).length,6);
 assert.ok(a.bands.some(v=>v.id==='unbound'),'units feeding no gate retain a final band');
 const all=a.bands.flatMap(v=>v.ids);assert.equal(all.length,60);assert.equal(new Set(all).size,60);
 for(let i=1;i<a.bands.length;i++)assert.ok(a.bands[i]!.x>a.bands[i-1]!.x+a.bands[i-1]!.width);
 for(const band of a.bands){
  if(band.id!=='unbound')for(const id of band.ids)assert.ok(a.positions.get(band.id)!.x>a.positions.get(id)!.x,'gate sits after its band');
  for(let i=0;i<band.ids.length;i++)for(let j=i+1;j<band.ids.length;j++){const p=a.positions.get(band.ids[i]!)!,q=a.positions.get(band.ids[j]!)!;assert.ok(Math.abs(p.x-q.x)>=248||Math.abs(p.y-q.y)>=128,'node rectangles do not overlap');}
 }
 for(const edge of e.data.display.status.edges)if(edge.type==='milestone')assert.ok(a.positions.get(edge.unit)!.x>a.positions.get(`milestone:${edge.milestone}`)!.x,'gated work follows the gate');
 assert.ok(a.elapsed>=0);
});

test('equal ranks retain dependency columns and one layout across focus contexts',async t=>{
 const f=await investigationFixture(60);t.after(()=>f.close());
 const observed=new Observations(f.hostDir,'graph-wrap','graph').read({runDir:f.runDir,arc:f.arc});
 const input=graphData({...observed,data:graphView(observed)}),a=graphLayout(input),unbound=a.bands.find(b=>b.id==='unbound')!;
 const columns=new Map<number,number>();for(const id of unbound.ids){const x=a.positions.get(id)!.x;columns.set(x,(columns.get(x)??0)+1);}
 assert.equal(columns.size,1,'unrelated equal-rank units do not invent wrapped dependency columns');assert.ok([...columns.values()].some(count=>count>10),'space remains available to a large rank');
 assert.equal(input.graph.edges.length,observed.data.display.status.edges.filter(e=>e.type==='after'||e.type==='milestone').length+(observed.data.plan?.milestones??[]).reduce((n,g)=>n+g.units.length,0),'ordering invents no semantic edges');
 const {graphLayout:layout,activeFocus}=await import(new URL('../web-src/app/graph-layout.ts',import.meta.url).href);
 const all=layout(input),repeat=layout(input);assert.deepEqual(all.positions,repeat.positions);
 const focus=activeFocus(input);assert.ok(focus.seeds.includes('u3'));assert.ok(focus.ids.includes('u4'),'direct downstream included');assert.ok(!focus.ids.includes('u60'),'unrelated work is outside the focus');
 assert.equal(all.positions.size,a.positions.size);assert.deepEqual(all.positions,a.positions,'Active derives a frame from the full layout');
 const idle=structuredClone(input);idle.graph.units.forEach((u:{status:string})=>{if(u.status==='active')u.status='pending';});
 assert.deepEqual(activeFocus(idle).seeds,[]);
});
