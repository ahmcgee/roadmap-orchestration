import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Observations } from './helpers/observations.ts';
import {graphView} from '../src/console/views.ts';
const {graphData}=await import(new URL('../web-src/app/graph-data.ts',import.meta.url).href);
const { graphLayout, graphCurves, NODE_WIDTH } = await import(new URL('../web-src/app/graph-layout.ts', import.meta.url).href) as {
 graphLayout: (e: unknown) => { positions: Map<string,{x:number;y:number}>; bands: {id:string;ids:string[];x:number;width:number;height:number}[];elapsed:number };
 graphCurves: (e: unknown, positions: Map<string,{x:number;y:number}>) => unknown[]; NODE_WIDTH: number;
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

/** A synthetic arc shaped like the field failure: each milestone's members depend on a design unit that belongs to no milestone. */
function bandedArc() {
 const unit=(id:string)=>({id,title:id,titleTruncated:false,signal:'pending',state:'ready',stage:'build',stageFinished:false,systems:[],lineageRef:null});
 const milestone=(id:string,memberIds:string[])=>({id,state:'building',passed:false,memberIds,total:memberIds.length,merged:0,withdrawn:0,signal:'pending',reason:null,costUsd:0});
 const after=(source:string,target:string)=>({kind:'after',source,target,on:source,met:false});
 const waits=(gate:string,target:string)=>({kind:'milestone',source:`milestone:${gate}`,target,passed:false});
 const milestones=[milestone('MS-A',['a1','a2']),milestone('MS-B',['b1','b2','b3']),milestone('MS-C',['c1'])];
 const ids=['a1','a2','b1','b2','b3','c1','dA','dB','y','x','z','lone'];
 const edges=[
  after('dA','a1'),after('dA','a2'),   // MS-A's members need its design unit
  waits('MS-A','dB'),after('dB','b1'), // MS-B's design waits for MS-A and feeds MS-B
  after('a2','y'),after('y','b2'),     // a no-milestone unit between a member of MS-A and one of MS-B
  waits('MS-B','x'),                   // waits for MS-B, nothing needs it
  waits('MS-B','z'),after('z','a1'),   // a member of MS-A needs a unit that waits for MS-B: a backward edge
  after('c1','a2'),                    // a member of MS-A needs a member of MS-C: a backward edge
  after('b1','b2'),after('b2','b3'),
  ...milestones.flatMap(m=>m.memberIds.map(id=>({kind:'feeds',source:id,target:`milestone:${m.id}`}))),
 ];
 return graphData({arc:'synthetic',revision:1,data:{units:ids.map(unit),milestones,noMilestone:{ids:['dA','dB','y','x','z','lone'],total:6,merged:0,withdrawn:0},edges,focus:{activeIds:[],firstUncleared:'MS-A'}}});
}
type Laid={positions:Map<string,{x:number;y:number}>;bands:{id:string;kind:string;ids:string[];x:number;width:number}[];stations:{id:string;passed:number;total:number;frame:string[];groups:string[]}[]};

test('a milestone keeps its members; units of no milestone sit where they flow, between the right bands',()=>{
 const input=bandedArc(),a=graphLayout(input) as unknown as Laid;
 assert.deepEqual([...a.positions],[...(graphLayout(input) as unknown as Laid).positions],'deterministic');
 const band=(id:string)=>a.bands.find(b=>b.id===id)!;
 assert.deepEqual(band('milestone:MS-A').ids,['a1','a2'],'members stay in their band although they depend on later work');
 assert.deepEqual(band('milestone:MS-B').ids,['b1','b2','b3']);
 assert.deepEqual(band('milestone:MS-C').ids,['c1']);
 const holder=(id:string)=>a.bands.find(b=>b.ids.includes(id))!.id;
 assert.equal(holder('dA'),'lead:MS-A','a design unit sits at the start of the milestone it feeds');
 assert.equal(holder('dB'),'lead:MS-B','after the milestone it waits for, before the one it feeds');
 assert.equal(holder('y'),'lead:MS-B','after the member it needs, before the member that needs it');
 assert.equal(holder('x'),'lead:MS-C','after the milestone it waits for');
 assert.equal(holder('z'),'lead:MS-C','waiting wins over feeding: it stays after the milestone it waits for');
 assert.equal(holder('lone'),'unbound','unconnected work keeps a No milestone group');
 assert.ok(a.bands.filter(b=>b.id.startsWith('lead:')||b.id==='unbound').every(b=>b.kind==='outside'));
 for(let i=1;i<a.bands.length;i++)assert.ok(a.bands[i]!.x>a.bands[i-1]!.x+a.bands[i-1]!.width,'groups stay left to right');
 for(const b of a.bands)for(const id of [...b.ids,...(b.kind==='milestone'?[b.id]:[])]){const x=a.positions.get(id)!.x;assert.ok(x>b.x&&x<b.x+b.width,`${id} lies inside ${b.id}`);}
 assert.deepEqual(a.bands.map(b=>b.id),['lead:MS-A','milestone:MS-A','lead:MS-B','milestone:MS-B','lead:MS-C','milestone:MS-C','unbound']);
 // Counts are membership, never placement.
 assert.deepEqual(a.stations.map(s=>[s.id,s.passed,s.total]),[['milestone:MS-A',0,2],['milestone:MS-B',0,3],['milestone:MS-C',0,1],['unbound',0,6]]);
});

test('selecting a milestone frames its members, its gate and the units placed with it',()=>{
 const a=graphLayout(bandedArc()) as unknown as Laid,station=(id:string)=>a.stations.find(s=>s.id===id)!;
 assert.deepEqual(new Set(station('milestone:MS-A').frame),new Set(['dA','a1','a2','milestone:MS-A']));
 assert.deepEqual(new Set(station('milestone:MS-B').frame),new Set(['dB','y','b1','b2','b3','milestone:MS-B']));
 assert.deepEqual(station('milestone:MS-B').groups,['lead:MS-B','milestone:MS-B']);
 assert.deepEqual(new Set(station('unbound').frame),new Set(['dA','dB','y','x','z','lone']),'No milestone frames every unit of no milestone');
 assert.deepEqual(station('unbound').groups,['lead:MS-A','lead:MS-B','lead:MS-C','unbound']);
});

test('an edge into an earlier band is drawn backwards, directly, between the two cards',()=>{
 const input=bandedArc(),a=graphLayout(input) as unknown as Laid;
 const curves=graphCurves(input,a.positions) as {source:string;target:string;points:{x:number;y:number}[]}[];
 const backward=curves.filter(c=>a.positions.get(c.target)!.x<a.positions.get(c.source)!.x).map(c=>`${c.source}->${c.target}`).sort();
 assert.deepEqual(backward,['c1->a2','z->a1'],'nodes are not moved to avoid them');
 for(const c of curves){
  const p=a.positions.get(c.source)!,q=a.positions.get(c.target)!,first=c.points[0]!,last=c.points.at(-1)!;
  if(q.x<p.x){
   assert.equal(first.x,p.x-NODE_WIDTH/2-3,'leaves the source on its left side');assert.equal(last.x,q.x+NODE_WIDTH/2+5,'enters the target on its right side');
   for(let i=1;i<c.points.length;i++)assert.ok(c.points[i]!.x<c.points[i-1]!.x,'advances toward the target without turning back');
  }else assert.equal(first.x,p.x+NODE_WIDTH/2+3);
 }
});
