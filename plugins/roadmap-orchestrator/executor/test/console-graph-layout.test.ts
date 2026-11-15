import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Observations } from './helpers/observations.ts';
import {graphView} from '../src/console/views.ts';
const {graphData}=await import(new URL('../web-src/app/graph-data.ts',import.meta.url).href);
const { graphLayout, graphCurves, NODE_WIDTH } = await import(new URL('../web-src/app/graph-layout.ts', import.meta.url).href) as {
 graphLayout: (e: unknown) => { positions: Map<string,{x:number;y:number}>; bands: {id:string;kind:string;ids:string[];x:number;width:number;height:number}[];elapsed:number };
 graphCurves: (e: unknown, positions: Map<string,{x:number;y:number}>) => unknown[]; NODE_WIDTH: number;
};
import { assertGraphGeometry } from './helpers/graph-geometry.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';

test('milestone bands include all units and gates, preserve gate waits, and produce deterministic non-overlapping blocks',async t=>{
 const f=await investigationFixture(60);t.after(()=>f.close());
 const observed=new Observations(f.hostDir,'graph-layout','graph').read({runDir:f.runDir,arc:f.arc});
 const e=observed;
 assertGraphGeometry(e);
 const a=graphLayout(graphData({...observed,data:graphView(observed)},true)),b=graphLayout(graphData({...observed,data:graphView(observed)},true));
 assert.deepEqual(a.positions,b.positions);assert.equal(a.positions.size,e.data.display.status.units.length+e.data.display.status.milestones.length);
 assert.equal(a.bands.filter(v=>v.id.startsWith('milestone:')).length,6);
 assert.ok(a.bands.some(v=>v.id==='hardening'),'units feeding no gate retain a final band');
 const all=a.bands.flatMap(v=>v.ids);assert.equal(all.length,60);assert.equal(new Set(all).size,60);
 for(let i=1;i<a.bands.length;i++)assert.ok(a.bands[i]!.x>a.bands[i-1]!.x+a.bands[i-1]!.width);
 for(const band of a.bands){
  if(band.kind==='milestone')for(const id of band.ids)assert.ok(a.positions.get(band.id)!.x>a.positions.get(id)!.x,'gate sits after its band');
  for(let i=0;i<band.ids.length;i++)for(let j=i+1;j<band.ids.length;j++){const p=a.positions.get(band.ids[i]!)!,q=a.positions.get(band.ids[j]!)!;assert.ok(Math.abs(p.x-q.x)>=248||Math.abs(p.y-q.y)>=128,'node rectangles do not overlap');}
 }
 for(const edge of e.data.display.status.edges)if(edge.type==='milestone')assert.ok(a.positions.get(edge.unit)!.x>a.positions.get(`milestone:${edge.milestone}`)!.x,'gated work follows the gate');
 assert.ok(a.elapsed>=0);
});

test('equal ranks retain dependency columns and one layout across focus contexts',async t=>{
 const f=await investigationFixture(60);t.after(()=>f.close());
 const observed=new Observations(f.hostDir,'graph-wrap','graph').read({runDir:f.runDir,arc:f.arc});
 const input=graphData({...observed,data:graphView(observed)},true),a=graphLayout(input),unbound=a.bands.find(b=>b.id==='hardening')!;
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
 const unit=(id:string)=>({id,title:id,titleTruncated:false,signal:'pending',state:'ready',stage:'build',stageFinished:false,systems:[],lineageRef:null,origin:'planned',supersededBy:null,carriedBy:[]});
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
 return graphData({arc:'synthetic',revision:1,data:{units:ids.map(unit),milestones,noMilestone:{ids:['dA','dB','y','x','z','lone'],total:6,merged:0,withdrawn:0},groups:[{kind:'hardening',id:'hardening',label:'Hardening',ids:['dA','dB','y','x','z','lone']}],edges,focus:{activeIds:[],firstUncleared:'MS-A'}}});
}
type Laid={positions:Map<string,{x:number;y:number}>;bands:{id:string;kind:string;label:string;ids:string[];x:number;width:number}[];stations:{id:string;kind:string;label:string;passed:number;total:number;withdrawn:number;frame:string[];groups:string[]}[]};

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
 assert.equal(holder('lone'),'hardening','unconnected work keeps a trailing Hardening group');
 assert.ok(a.bands.filter(b=>b.id.startsWith('lead:')||b.id==='hardening').every(b=>b.kind==='outside'&&b.label==='Hardening'));
 for(let i=1;i<a.bands.length;i++)assert.ok(a.bands[i]!.x>a.bands[i-1]!.x+a.bands[i-1]!.width,'groups stay left to right');
 for(const b of a.bands)for(const id of [...b.ids,...(b.kind==='milestone'?[b.id]:[])]){const x=a.positions.get(id)!.x;assert.ok(x>b.x&&x<b.x+b.width,`${id} lies inside ${b.id}`);}
 assert.deepEqual(a.bands.map(b=>b.id),['lead:MS-A','milestone:MS-A','lead:MS-B','milestone:MS-B','lead:MS-C','milestone:MS-C','hardening']);
 // Counts are membership, never placement.
 assert.deepEqual(a.stations.map(s=>[s.id,s.passed,s.total]),[['milestone:MS-A',0,2],['milestone:MS-B',0,3],['milestone:MS-C',0,1],['hardening',0,6]]);
});

test('selecting a milestone frames its members, its gate and the units placed with it',()=>{
 const a=graphLayout(bandedArc()) as unknown as Laid,station=(id:string)=>a.stations.find(s=>s.id===id)!;
 assert.deepEqual(new Set(station('milestone:MS-A').frame),new Set(['dA','a1','a2','milestone:MS-A']));
 assert.deepEqual(new Set(station('milestone:MS-B').frame),new Set(['dB','y','b1','b2','b3','milestone:MS-B']));
 assert.deepEqual(station('milestone:MS-B').groups,['lead:MS-B','milestone:MS-B']);
 assert.deepEqual(new Set(station('hardening').frame),new Set(['dA','dB','y','x','z','lone']),'Hardening frames every Hardening unit, wherever it sits');
 assert.deepEqual(station('hardening').groups,['lead:MS-A','lead:MS-B','lead:MS-C','hardening']);
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

/** dev.81: an arc whose units of no milestone come from a design, walks, audits, polish and a deflake, with withdrawn units. */
function groupedArc(show=false) {
 const unit=(id:string,more:Record<string,unknown>={})=>({id,title:id,titleTruncated:false,signal:'pending',state:'ready',stage:'build',stageFinished:false,systems:[],lineageRef:null,origin:'planned',supersededBy:null,carriedBy:[],...more});
 const gone=(id:string,more:Record<string,unknown>)=>unit(id,{signal:'withdrawn',state:'superseded',...more});
 const milestone=(id:string,memberIds:string[],withdrawn=0)=>({id,state:'building',passed:false,memberIds,total:memberIds.length-withdrawn,merged:0,withdrawn,signal:'pending',reason:null,costUsd:0});
 const after=(source:string,target:string)=>({kind:'after',source,target,on:source,met:false});
 const milestones=[milestone('MS-A',['a1','a2','a2-r1'],1),milestone('MS-B',['b1'])];
 const units=[unit('a1'),gone('a2',{supersededBy:'a2-r1'}),unit('a2-r1'),unit('b1'),unit('dB'),unit('rA',{origin:'repair'}),unit('pA',{origin:'polish'}),
  unit('h1'),gone('h2',{state:'cut',carriedBy:['h3']}),unit('h3'),unit('x4',{origin:'repair'}),unit('x7',{origin:'repair'}),unit('fl',{origin:'deflake'})];
 const groups=[
  {kind:'milestone-repair',id:'milestone-repair:MS-A',label:'repair',milestone:'MS-A',ids:['rA']},{kind:'polish',id:'polish:MS-A',label:'polish',milestone:'MS-A',ids:['pA']},
  {kind:'design',id:'design:MS-B',label:'design',milestone:'MS-B',ids:['dB']},{kind:'hardening',id:'hardening',label:'Hardening',ids:['h1','h2','h3']},
  {kind:'audit',id:'audit:audit-7',label:'audit-7',job:'audit-7',ids:['x7']},{kind:'audit',id:'audit:audit-4',label:'audit-4',job:'audit-4',ids:['x4']},{kind:'deflake',id:'deflake',label:'Deflake',ids:['fl']},
 ];
 // h1 feeds MS-B's member, so it sits in the Hardening group just before MS-B; h2 (cut, carried by h3) and h3 trail.
 const edges=[after('a1','a2'),after('a2','b1'),after('a1','a2-r1'),after('h2','x4'),after('dB','b1'),after('h1','b1'),
  ...milestones.flatMap(m=>m.memberIds.map(id=>({kind:'feeds',source:id,target:`milestone:${m.id}`})))];
 return graphData({arc:'synthetic',revision:1,data:{units,milestones,noMilestone:{ids:groups.flatMap(g=>g.ids),total:9,merged:0,withdrawn:1},groups,edges,focus:{activeIds:[],firstUncleared:'MS-A'}}},show);
}

test('dev.81 D1: units of no milestone are drawn in their groups: a milestone\'s design before it, its repair and polish after, then Hardening, audits newest first, Deflake',()=>{
 const a=graphLayout(groupedArc(true)) as unknown as Laid;
 assert.deepEqual(a.bands.map(b=>[b.id,b.label]),[['milestone:MS-A','MS-A'],['milestone-repair:MS-A','repair'],['polish:MS-A','polish'],['lead:MS-B','Hardening'],['design:MS-B','design'],['milestone:MS-B','MS-B'],['hardening','Hardening'],['audit:audit-7','audit-7'],['audit:audit-4','audit-4'],['deflake','Deflake']]);
 for(let i=1;i<a.bands.length;i++)assert.ok(a.bands[i]!.x>a.bands[i-1]!.x+a.bands[i-1]!.width,'groups stay left to right');
 assert.deepEqual(a.stations.map(s=>[s.id,s.kind,s.label]),[['milestone:MS-A','milestone','MS-A'],['milestone:MS-B','milestone','MS-B'],['hardening','outside','Hardening'],['audit:audit-7','outside','audit-7'],['audit:audit-4','outside','audit-4'],['deflake','outside','Deflake']]);
 const station=(id:string)=>a.stations.find(s=>s.id===id)!;
 assert.deepEqual(station('milestone:MS-A').groups,['milestone:MS-A','milestone-repair:MS-A','polish:MS-A'],'a milestone frames the groups placed with it');
 assert.deepEqual(new Set(station('milestone:MS-A').frame),new Set(['a1','a2','a2-r1','milestone:MS-A','rA','pA']));
 assert.deepEqual(station('milestone:MS-B').groups,['lead:MS-B','design:MS-B','milestone:MS-B']);
 assert.deepEqual([station('hardening').passed,station('hardening').total,station('hardening').withdrawn],[0,2,1],'an outside station counts its own units, the withdrawn apart');
 assert.deepEqual(station('hardening').groups,['lead:MS-B','hardening']);
});

test('dev.81 D2: withdrawn units are hidden by default, their edges drawn to the unit that replaced them; shown, each sits in its own band beside its successor',()=>{
 const hidden=groupedArc(),h=graphLayout(hidden) as unknown as Laid;
 assert.equal(hidden.hiddenWithdrawn,2);assert.equal(hidden.withdrawn,2);
 assert.ok(!h.positions.has('a2')&&!h.positions.has('h2'),'hidden units are not drawn');
 const edges:string[]=hidden.graph.edges.map(([s,t]:[string,string])=>`${s}->${t}`);
 assert.ok(edges.includes('a2-r1->b1'),'a dependant of a superseded unit is drawn from its re-entry');
 assert.ok(edges.includes('h3->x4'),'a dependant of a cut unit is drawn from its carrier');
 assert.equal(edges.filter(e=>e==='a1->a2-r1').length,1,'a re-pointed edge that duplicates a drawn one is drawn once');
 assert.ok(edges.every(e=>!e.split('->').some(end=>end==='a2'||end==='h2')),'no edge ends at a hidden unit');
 assert.deepEqual(h.bands.find(b=>b.id==='milestone:MS-A')!.ids,['a1','a2-r1'],'the band keeps its live members');
 assert.equal(h.stations.find(s=>s.id==='milestone:MS-A')!.withdrawn,1,'counts stay as recorded');
 assert.equal(h.stations.find(s=>s.id==='hardening')!.withdrawn,1);
 const shown=groupedArc(true),s=graphLayout(shown) as unknown as Laid;
 assert.equal(shown.hiddenWithdrawn,0);
 assert.ok(s.bands.find(b=>b.id==='milestone:MS-A')!.ids.includes('a2'),'a withdrawn member stays in its milestone band');
 assert.ok(!s.bands.some(b=>/withdrawn/i.test(b.id+b.label)),'never a separate withdrawn group');
 for(const [gone,next] of [['a2','a2-r1'],['h2','h3']] as const){
  const p=s.positions.get(gone)!,q=s.positions.get(next)!;
  assert.equal(p.x,q.x,`${gone} shares ${next}'s column`);
  const column=[...s.positions].filter(([id,v])=>v.x===q.x&&!id.startsWith('milestone:')).sort((a,b)=>a[1].y-b[1].y).map(([id])=>id);
  assert.equal(column.indexOf(gone)+1,column.indexOf(next),`${gone} sits directly before ${next}`);
  assert.equal(s.bands.find(b=>b.ids.includes(gone))!.id,s.bands.find(b=>b.ids.includes(next))!.id,`${gone} and ${next} share a band`);
 }
});

test('dev.81 D2: a shown withdrawn unit whose successor sits left of its own dependency keeps its own column; no edge runs backwards',()=>{
 // The scale arc's shape: u2 depends on u1 and is superseded by u3, a re-entry that does not depend on u1.
 const unit=(id:string,more:Record<string,unknown>={})=>({id,title:id,titleTruncated:false,signal:'pending',state:'ready',stage:'build',stageFinished:false,systems:[],lineageRef:null,origin:'planned',supersededBy:null,carriedBy:[],...more});
 const memberIds=['u1','u2','u3'],milestones=[{id:'MS-A',state:'building',passed:false,memberIds,total:2,merged:0,withdrawn:1,signal:'pending',reason:null,costUsd:0}];
 const edges=[{kind:'after',source:'u1',target:'u2',on:'u1',met:false},...memberIds.map(id=>({kind:'feeds',source:id,target:'milestone:MS-A'}))];
 const input=graphData({arc:'synthetic',revision:1,data:{units:[unit('u1'),unit('u2',{signal:'withdrawn',state:'superseded',supersededBy:'u3'}),unit('u3')],milestones,noMilestone:{ids:[],total:0,merged:0,withdrawn:0},groups:[],edges,focus:{activeIds:[],firstUncleared:'MS-A'}}},true);
 const a=graphLayout(input) as unknown as Laid,p=(id:string)=>a.positions.get(id)!;
 assert.ok(p('u2').x>p('u1').x,'the withdrawn unit stays right of its dependency');
 assert.notEqual(p('u2').x,p('u3').x,'it does not take its successor\'s column');
 for(const c of graphCurves(input,a.positions) as {source:string;target:string;points:{x:number}[]}[])assert.ok(c.points.at(-1)!.x>c.points[0]!.x,`${c.source} -> ${c.target} advances`);
});
