import assert from 'node:assert/strict';
import { test } from 'node:test';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { Observations } from './helpers/observations.ts';
import { ConsoleResources } from '../src/console/resource-query.ts';
import { resourcesShape, resourceDetailShape } from '../src/console/view-shapes.ts';
import { canonicalJson } from '../src/core/json.ts';
import { statusBytes, CONSOLE_PROTOCOL, ConsoleError, type Envelope } from '../src/observation/protocol.ts';
import { completedWaiting } from '../src/status/waiting.ts';
import { cpuStageGroups } from '../src/console/resources.ts';
import { absPath } from '../src/core/values.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { serveConsole } from '../src/console/http.ts';
import { consoleGet } from './helpers/console-http.ts';
import { unitId, opKey, resourceUnit, arcId, jobId, findingId } from '../src/core/ids.ts';
import type { ResourceCpu, ResourceWait, ResourceBooking, ResourceView } from '../src/console/resource-protocol.ts';
const capture=(f:Awaited<ReturnType<typeof investigationFixture>>,cache=new Observations(f.hostDir,'resource','repo'))=>cache.read({runDir:f.runDir,arc:f.arc});
function noMonolith(v:unknown){if(!v||typeof v!=='object')return;for(const [k,value] of Object.entries(v)){assert.ok(!['events','display','body','report','raw','console','plan','transcript','capture'].includes(k),k);noMonolith(value);}}
test('Resources sections preserve canonical holders, scheduler order, weighted CPU, exact wait contributions and separate unknown coverage',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),before=[statusBytes(e,false),statusBytes(e,true)],tabs=new ConsoleResources();
 for(const section of ['schedule','cpu','waiting','now']){const h=tabs.read(e,{section,...(section==='now'?{}:{window:'arc'})});assert.ok(resourcesShape(h),section);noMonolith(h);assert.equal(resourcesShape({...h,events:[]}),false);}
 const schedule=tabs.read(e,{window:'arc'});assert.equal(schedule.section,'schedule');assert.ok(schedule.rows.every(r=>'holder' in r));assert.equal(schedule.now.integration.rows[0]!.holder,'u10');assert.deepEqual(schedule.now.queues.rows.map(r=>[r.position,r.subject.id]),[[1,'u8'],[2,'u9']]);assert.ok(schedule.now.blockers.rows.some(r=>r.subject.id==='u11'));assert.equal(schedule.now.cpuReservation!.capacity,16);
 const cpu=tabs.read(e,{section:'cpu',window:'arc'}),rows=cpu.rows as ResourceCpu[],u=rows.find(r=>r.subject.id==='u1')!;assert.equal(u.stage,'build');assert.equal(u.attempt,1);assert.equal(u.averageCores,.2);assert.equal(u.weightedReservedCores,4);assert.equal(u.reservationPercent,5);assert.equal(cpu.coverage.under10Stages,1);assert.equal(cpu.coverage.measuredStages,1);
 const calls=tabs.detail(e,u.detailKey,{section:'cpu',window:'arc'});assert.ok(resourceDetailShape(calls));assert.equal(calls.rows.length,u.callCount);assert.ok(calls.rows.every(r=>'reservedCpu' in r));
 const original=cpuStageGroups([...e.data.display.status.host.work,...e.data.display.status.units.flatMap(u=>u.work)]);assert.deepEqual(rows.map(r=>r.reservationPercent).sort(),original.map(r=>r.reservationPercent).sort());
 const wait=tabs.read(e,{section:'waiting',window:'arc'}),canonical=completedWaiting(e.data.events);assert.equal(wait.overview.totalWaitingMs,canonical.measurements.reduce((n,m)=>n+m.waited.totalMs,0));assert.equal(wait.coverage.unmeasuredReservations,1);assert.equal(tabs.read(e,{section:'waiting'}).coverage.unmeasuredReservations,null);
 const expected=[['Baseline hold',5600,1],['CPU capacity',1200,1],['CPU pressure',2300,1],['Integration slot',4500,1],['Memory pressure',3400,1]];assert.deepEqual(wait.overview.reasons.map(r=>[r.label,r.totalMs,r.count]),expected);
 for(const reason of wait.overview.reasons){const d=tabs.detail(e,reason.detailKey,{section:'waiting',window:'arc'});assert.ok(resourceDetailShape(d));assert.equal(d.rows.length,reason.count);assert.equal(d.rows.reduce((n,w)=>n+('reasons' in w?w.reasons.find(r=>r.reason===reason.reason)!.ms:0),0),reason.totalMs);}
 assert.equal(tabs.read(e,{section:'cpu',window:'arc',stage:'snapshot'}).page.matching,0,'a supported stage without measurements is a valid empty filter');assert.equal(tabs.read(e,{section:'waiting',window:'arc',reason:'admission-hold:paused'}).page.matching,0,'a supported reason without measurements is a valid empty filter');
 assert.deepEqual([statusBytes(e,false),statusBytes(e,true)],before);
 for(const params of [{section:'unknown'},{section:'schedule',stage:'build'},{section:'cpu',resource:'integration-slot'},{section:'waiting',utilization:'all'},{section:'now',window:'arc'},{section:'cpu',sort:'duration'},{section:'waiting',sort:'unit'},{unit:'foreign'},{q:'x'.repeat(201)},{limit:'30'},{from:'2026-02-30T00:00:00Z'},{window:'arc',from:'2026-01-01T00:00:00Z'},{unit:'u1,u1'},{surprise:'1'}])assert.throws(()=>tabs.read(e,params as Record<string,string>),ConsoleError);
});
test('Resources booking boundaries span cleaning, retain pool instances, exact 805 ms, and terminal clipping without a fabricated release',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const first=capture(f),origin=Date.parse(first.data.events[0]!.at),holder={type:'stage' as const,unit:unitId('u1'),stage:'build' as const,attempt:1};
 t.mock.timers.enable({apis:['Date'],now:origin+1284});
 function transition(name:string,edge:{type:'reserve'}|{type:'release'}|{type:'clean';from:'reserved'}|{type:'reclaim'}){const op=f.journal.begin({kind:'resource.transition',key:opKey(name),parent:{type:'arc'},deadlineAt:null,body:()=>({expect:{holder,resources:[resourceUnit('short-slot')],edge,...(edge.type==='reserve'?{waited:{totalMs:0,byReasonMs:{}}}:{})},post:null})});f.journal.done(op.op,'resource.transition',{kind:'transitioned'},null);}
 transition('short-hold',{type:'reserve'});t.mock.timers.tick(805);transition('short-clean',{type:'clean',from:'reserved'});transition('short-release',{type:'release'});t.mock.timers.tick(1500);
 const e=capture(f);t.mock.timers.reset();const tabs=new ConsoleResources(),h=tabs.read(e,{window:'arc',resource:'short-slot'}),b=h.rows[0] as ResourceBooking;assert.equal(h.page.matching,1);assert.equal(Date.parse(b.startedAt)-origin,1284);assert.equal(Date.parse(b.endedAt!)-Date.parse(b.startedAt),805);assert.equal(b.state,'done');
 const d=tabs.detail(e,b.detailKey,{window:'arc'});assert.equal(d.booking!.id,b.id);assert.deepEqual(d.rows,[b]);assert.ok(resourceDetailShape(d));assert.throws(()=>tabs.detail({...e,arc:arcId('other')},b.detailKey,{window:'arc'}),/not recorded/);
 const now=tabs.read(e,{section:'now'});const integration=now.now.integration.rows[0]!;const resource=tabs.detail(e,integration.detailKey,{section:'now'});assert.equal(resource.kind,'resource');assert.equal(resource.scope.basis,'recorded-arc','selected resource history has lifetime scope even when opened from Now');assert.ok(resource.rows.length);assert.ok(resource.rows.every(r=>'resource' in r&&r.resource==='integration-slot'));
});
test('Schedule lanes keep pool instance identity, count crowded lanes in clusters, overview spans the whole arc, history leads with the current holder',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const origin=Date.parse(capture(f).data.events[0]!.at);let n=0;
 t.mock.timers.enable({apis:['Date'],now:origin+60_000});
 const transition=(unit:string,resource:string,edge:{type:'reserve'}|{type:'release'}|{type:'clean';from:'reserved'})=>{const op=f.journal.begin({kind:'resource.transition',key:opKey(`lane-${n++}`),parent:{type:'arc'},deadlineAt:null,body:()=>({expect:{holder:{type:'stage' as const,unit:unitId(unit),stage:'build' as const,attempt:1},resources:[resourceUnit(resource)],edge,...(edge.type==='reserve'?{waited:{totalMs:0,byReasonMs:{}}}:{})},post:null})});f.journal.done(op.op,'resource.transition',{kind:'transitioned'},null);};
 for(let i=0;i<20;i++){transition('u1','db#1',{type:'reserve'});t.mock.timers.tick(1000);transition('u1','db#1',{type:'clean',from:'reserved'});transition('u1','db#1',{type:'release'});t.mock.timers.tick(60_000);}
 transition('u2','db#2',{type:'reserve'});t.mock.timers.tick(1000);
 const e=capture(f);t.mock.timers.reset();const tabs=new ConsoleResources(),v=tabs.read(e,{window:'arc',resource:'db'});assert.ok(resourcesShape(v));
 const lanes=v.overview.lanes!.rows;assert.deepEqual(lanes.map(l=>[l.id,l.resource,l.instance,l.count,l.open]),[['db#1','db','db#1',20,0],['db#2','db','db#2',1,1]]);
 const crowded=lanes[0]!.marks;assert.ok(crowded.length<=16);assert.ok(crowded.some(m=>m.type==='cluster'));assert.equal(crowded.reduce((n,m)=>n+(m.type==='cluster'?m.count:1),0),20,'a cluster counts every booking it groups');
 assert.deepEqual(lanes[1]!.marks.map(m=>m.type==='booking'?[m.holder,m.unitRef,m.state,m.endedAt]:null),[['u2','u2','holding',null]]);
 const narrow=tabs.read(e,{from:new Date(origin).toISOString(),to:new Date(origin+120_000).toISOString(),resource:'db'});assert.deepEqual(narrow.overview.lanes!.rows.map(l=>[l.id,l.count]),[['db#1',1]]);
 for(const view of [v,narrow])assert.equal(view.overview.arc!.buckets.reduce((n,b)=>n+b.count,0),21,'the overview counts every matching booking whatever the window');
 const history=tabs.detail(e,lanes[0]!.resourceKey,{window:'arc'}),starts=history.rows.map(r=>(r as ResourceBooking).startedAt);assert.equal(history.page.matching,20);assert.deepEqual(starts,[...starts].sort().reverse(),'newest first');
 assert.equal(tabs.read(e,{section:'cpu',window:'arc'}).overview.lanes,null);
});
test('Resources immutable pages preserve original CPU evidence and wait/booking order through append, bind identity/query and explicitly evict',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());for(let n=0;n<62;n++)f.journal.fact({kind:'stage-admitted',unit:unitId('u7'),stage:'build',waited:{totalMs:n,byReasonMs:{'cpu-tokens':n}}});
 const cache=new Observations(f.hostDir,'resource','repo'),e=capture(f,cache),tabs=new ConsoleResources(),params={section:'waiting',window:'arc',limit:'25',sort:'duration',direction:'desc'},first=tabs.read(e,params);assert.equal(first.rows.length,25);const all=[...first.rows];let page=first;while(page.page.next){page=tabs.read(e,{...params,cursor:page.page.next});all.push(...page.rows);}assert.equal(new Set(all.map(r=>r.id)).size,all.length);assert.equal(all.length,first.page.matching);
 const reason=first.overview.reasons.find(r=>r.reason==='cpu-tokens')!,d=tabs.detail(e,reason.detailKey,{...params,limit:'25'});assert.equal(d.rows.length,25);let detail=d;const contributions=[...d.rows];while(detail.page.next){detail=tabs.detail(e,reason.detailKey,{...params,cursor:detail.page.next});contributions.push(...detail.rows);}assert.equal(contributions.length,reason.count);
 f.finishLive();const newer=capture(f,cache);const second=tabs.read(newer,{...params,cursor:first.page.next!});assert.deepEqual(second.page.asOf,first.page.asOf);assert.deepEqual(tabs.read(newer,{...params,cursor:second.page.previous!}).rows,first.rows);
 assert.deepEqual(tabs.detail(newer,reason.detailKey,{...params,cursor:d.page.next!}).page.asOf,d.page.asOf);
 for(const changed of [{...newer,epoch:'foreign'},{...newer,instance:'foreign'}])assert.throws(()=>tabs.read(changed,{...params,cursor:first.page.next!}),/foreign/);
 assert.throws(()=>tabs.read(newer,{...params,direction:'asc',cursor:first.page.next!}),/foreign/);assert.throws(()=>tabs.read(newer,{...params,cursor:'forged'}),/invalid/);
 for(let n=0;n<33;n++)tabs.read(newer,{...params,q:String(n)});assert.throws(()=>tabs.read(newer,{...params,cursor:first.page.next!}),/expired/);
});
test('Resources HTTP admits typed sections/details and retains HEAD, schema, security, high-water, exact keys and encoded-path refusal',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/resources`;
 const r=await consoleGet(base+'?window=arc');assert.equal(r.status,200,await r.clone().text());const e=await r.json() as Envelope<ResourceView>;assert.ok(resourcesShape(e.data));noMonolith(e.data);assert.match(r.headers.get('cache-control')!,/no-store/);assert.ok(r.headers.get('content-security-policy'));assert.equal(r.headers.get('access-control-allow-origin'),null);
 const key=(e.data.rows[0] as ResourceBooking).detailKey,detail=await consoleGet(base+'/details/'+key+'?window=arc');assert.equal(detail.status,200,await detail.clone().text());assert.ok(resourceDetailShape((await detail.json() as Envelope<unknown>).data));
 const head=await fetch(base+'?section=cpu&window=arc',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 for(const q of ['limit=30','section=cpu&state=done','q=one&q=two','cursor=forged','offset=0','state=imaginary'])assert.equal((await consoleGet(base+'?'+q)).status,400,q);
 assert.equal((await consoleGet(base+'?epoch=foreign')).status,409);assert.equal((await consoleGet(base+'?minHighWater=99999999')).status,503);
 assert.equal((await consoleGet(base+'/details/'+key.replace(/.$/,'z'))).status,400);assert.equal((await consoleGet(base+'/details/booking-'+'0'.repeat(64))).status,404);assert.equal((await consoleGet(base+'/details/a%2fb')).status,400);
});
test('Resources CPU uses weighted matched samples with unequal reservations, unknown/zero denominators and above-100% values',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),all=e.data.display.status.units.flatMap(u=>u.work);assert.ok(all.length>=5);const parent=all[0]!.parent;
 const work=all.slice(0,5).map((w,n)=>({...w,parent,reservedCpu:[2,4,null,4,4][n]!,cpuBasis:{kind:'explicit' as const,value:4},measured:n===4?null:{wallMs:[10,100,25,0][n]!,runMs:[40,200,50,0][n]!,waitMs:0}}));
 const units=e.data.display.status.units.map((u,n)=>({...u,work:n===0?work:[]})),sample={...e,data:{...e.data,display:{...e.data.display,status:{...e.data.display.status,host:{...e.data.display.status.host,work:[]},units}}}};
 const tabs=new ConsoleResources(),page=tabs.read(sample,{section:'cpu',window:'arc'}),r=page.rows[0] as ResourceCpu;assert.equal(page.rows.length,1);assert.equal(r.measuredRunMs,240);assert.equal(r.measuredWallMs,110);assert.equal(r.reservedCoreMs,420);assert.equal(r.averageCores,240/110);assert.equal(r.weightedReservedCores,420/110);assert.equal(r.reservationPercent,100*240/420);assert.equal(r.unreservedAverageCores,2);assert.equal(r.measuredCalls,2);assert.equal(r.excludedCalls,3);assert.equal(r.unmeasuredCalls,1);assert.equal(r.zeroWallCalls,1);assert.equal(r.unreservedCalls,1);
 const only={...sample,data:{...sample.data,display:{...sample.data.display,status:{...sample.data.display.status,units:units.map((u,n)=>({...u,work:n===0?[work[0]!]:[]}))}}}};assert.equal((tabs.read(only,{section:'cpu',window:'arc',utilization:'over100'}).rows[0] as ResourceCpu).reservationPercent,200);
 assert.equal(tabs.read(sample,{section:'cpu',window:'arc',utilization:'under10'}).rows.length,0);assert.equal(tabs.read(sample,{section:'cpu',window:'arc',utilization:'unmeasured'}).rows.length,1);
});
test('Resources pages every named reason and reconstructs exact selected large contributions through bounded field continuation',async t=>{
 const {applyContent}=await import('../web-src/app/detail-merge.ts');const f=await investigationFixture();t.after(()=>f.close());const byReasonMs=Object.fromEntries(Array.from({length:500},(_,n)=>[`named-resource:slot${n}-${'a'.repeat(50)}`,n%100]));f.journal.fact({kind:'stage-admitted',unit:unitId('u7'),stage:'build',waited:{totalMs:100,byReasonMs}});
 const e=capture(f),tabs=new ConsoleResources(),params={section:'waiting',window:'arc'},view=tabs.read(e,params);assert.equal(view.overview.reasonCount,505);assert.equal(view.overview.reasons.length,25);let page=tabs.reasons(e,params);const reasons=[...page.rows];while(page.page.next){page=tabs.reasons(e,{...params,cursor:page.page.next});reasons.push(...page.rows);}assert.equal(reasons.length,505);assert.equal(new Set(reasons.map(r=>r.reason)).size,505);
 const measurement=(view.rows as ResourceWait[]).find(w=>w.reasonCount===500)!;assert.equal(measurement.reasons.length,8);let detail=tabs.detail(e,measurement.detailKey,params),reads=0,largest=Buffer.byteLength(JSON.stringify({...e,data:detail}))+1;assert.ok(detail.continuations?.length);while(detail.continuations?.length){const ref=detail.continuations[0]!,part=tabs.content(e,measurement.detailKey,{section:'content',cursor:ref.next});largest=Math.max(largest,Buffer.byteLength(JSON.stringify({...e,data:part}))+1);detail=applyContent(detail,part,ref);assert.ok(++reads<1000);}assert.equal(largest<=32*1024,true);assert.deepEqual(Object.fromEntries((detail.rows[0] as ResourceWait).reasons.map(r=>[r.reason,r.ms])),byReasonMs);const {_anchored,...wire}=detail as typeof detail&{_anchored?:boolean};assert.ok(resourceDetailShape(wire));
});
test('Resource ownership links only exact recorded holder parents and launch sequences within recorded ownership boundaries',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),reserve=e.data.events.find(ev=>ev.type==='intent'&&ev.kind==='resource.transition'&&ev.expect.edge.type==='reserve'&&ev.expect.holder.type==='stage'&&ev.expect.holder.unit==='u1')!;assert.ok(reserve.type==='intent'&&reserve.kind==='resource.transition');
 // Use the fixture's validated holder, parent, operation and times with one named resource.
 const {parseEventLine}=await import('../src/core/events.ts');
 const changed=parseEventLine(canonicalJson({...reserve,expect:{...reserve.expect,resources:[resourceUnit('owned-slot')]}}));
 const sample={...e,data:{...e.data,events:e.data.events.map(ev=>ev===reserve?changed:ev)}},tabs=new ConsoleResources();const b=tabs.read(sample,{window:'arc',resource:'owned-slot'}).rows[0] as ResourceBooking;const d=tabs.detail(sample,b.detailKey,{window:'arc',evidence:'calls'});assert.equal(d.counts.calls,1);assert.equal(d.evidence,'calls');assert.ok(resourceDetailShape(d));assert.equal(d.rows[0]!.id,f.finished.inv);assert.equal((d.rows[0] as import('../src/console/resource-protocol.ts').ResourceCpuCall).invocation,f.finished.routeId);assert.equal(d.counts.bookings,1);
});

test('Resources Now keeps exact job/docs/batch identities and canonical priority without inventing a job ID or queue age',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),h=e.data.display.status.host,request=h.queue[0]!.request;
 const jobQueue=[{holder:{type:'job' as const,job:jobId('audit',1)},request,envBlocked:false},{holder:{type:'docs' as const,pub:jobId('docs',1)},request,envBlocked:false,queuedAt:200},{holder:{type:'batch' as const,finding:findingId('F-1'),attempt:1},request,envBlocked:false,queuedAt:100}];
 const sample={...e,data:{...e.data,display:{...e.data.display,status:{...e.data.display.status,host:{...h,jobQueue}}}}};const data=new ConsoleResources().read(sample,{section:'now'});assert.ok(resourcesShape(data));assert.deepEqual(data.now.queues.rows.map(q=>[q.position,q.subject.type,q.subject.id]),[[1,'job',jobId('audit',1)],[2,'job',jobId('docs',1)],[3,'arc',e.arc],[4,'unit','u8'],[5,'unit','u9']]);assert.match(data.now.queues.rows[2]!.subject.title,/F-1:1/);assert.equal(data.now.queues.rows[0]!.queuedAt,null);assert.equal(data.now.unknownQueueStarts,1);
});
