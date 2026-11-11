import assert from 'node:assert/strict';
import { test } from 'node:test';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { Observations } from './helpers/observations.ts';
import { ConsoleEffort } from '../src/console/effort-query.ts';
import { effortShape } from '../src/console/view-shapes.ts';
import { statusBytes, CONSOLE_PROTOCOL, ConsoleError, type Envelope } from '../src/observation/protocol.ts';
import { completedWaiting } from '../src/status/waiting.ts';
import { meterOf } from '../src/meter.ts';
import { systemName } from '../src/core/ids.ts';
import { fact } from '../src/core/events.ts';
import { absPath } from '../src/core/values.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { serveConsole } from '../src/console/http.ts';
import { consoleGet } from './helpers/console-http.ts';
const capture=(f:Awaited<ReturnType<typeof investigationFixture>>,cache=new Observations(f.hostDir,'effort','repo'))=>cache.read({runDir:f.runDir,arc:f.arc});
function noMonolith(v:unknown){if(!v||typeof v!=='object')return;for(const [k,value] of Object.entries(v)){assert.ok(!['events','display','body','report','raw','console','plan','transcript','capture'].includes(k),k);noMonolith(value);}}
const row=(h:ReturnType<ConsoleEffort['read']>,id:string)=>h.rows.find(r=>r.subject.id===id)!;
test('Effort reconciles once-counted completion totals, all-unit lifetime rankings, current blockers and separate coverage without canonical changes',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),before=[statusBytes(e,false),statusBytes(e,true)],tabs=new ConsoleEffort(),h=tabs.read(e,{window:'arc'});
 assert.ok(effortShape(h));noMonolith(h);assert.equal(h.rows.filter(r=>r.subject.type==='unit').length,14);
 // Counts name what they count over the whole filtered population; every bucket sits on a histogram slot.
 assert.equal(h.rowCounts.unit,14);assert.equal(Object.values(h.rowCounts).reduce((n,c)=>n+c,0),h.page.matching);
 const blocked=tabs.read(e,{window:'arc',blocked:'1'});assert.equal(Object.values(blocked.rowCounts).reduce((n,c)=>n+c,0),blocked.page.matching);
 for(const b of h.buckets){const at=Date.parse(b.from)-Date.parse(h.histogram.from);assert.equal(at%h.histogram.widthMs,0);assert.ok(at>=0&&Date.parse(b.to)<=Date.parse(h.histogram.to));}assert.equal(h.totals.spend.costUsd,e.data.summary.spend.costUsd);
 const calls=e.data.display.invocations.filter(i=>i.endedAt&&i.work?.measured&&i.execution),agents=calls.filter(i=>i.execution==='agent'),commands=calls.filter(i=>i.execution==='command');
 assert.equal(h.totals.agentMs,agents.reduce((n,i)=>n+i.work!.measured!.wallMs,0));assert.equal(h.totals.commandMs,commands.reduce((n,i)=>n+i.work!.measured!.wallMs,0));assert.equal(h.totals.coverage.execution.measured,calls.length);
 const waits=completedWaiting(e.data.events);assert.equal((h.totals.heldMs??0)+(h.totals.queuedMs??0)+(h.totals.unallocatedMs??0),waits.measurements.reduce((n,m)=>n+m.waited.totalMs,0));assert.equal(h.totals.coverage.waiting.measured,waits.measurements.length);assert.equal(h.totals.coverage.waiting.unmeasuredReservations,1);
 for(const k of ['agentMs','commandMs','heldMs','queuedMs','unallocatedMs'] as const)assert.equal(h.buckets.reduce((n,b)=>n+(b[k]??0),0),h.totals[k]??0);
 assert.equal(h.buckets.reduce((n,b)=>n+(b.spend.costUsd??0),0),h.totals.spend.costUsd);assert.equal((h.attribution.unit.spend.costUsd??0)+(h.attribution.arcJob.spend.costUsd??0),h.totals.spend.costUsd);
 assert.equal(row(h,'u7').lifetime.rounds,3);assert.equal(row(h,'u7').lifetime.redChecks,1);assert.equal(row(h,'u7').lifetime.spend.costUsd,2.25);assert.equal(row(h,'u5').agentMs,null);
 for(const [id,text] of [['u8','Integration queue position 1'],['u9','Integration queue position 2'],['u7','Baseline hold']] as const)assert.ok(row(h,id).blockers.reasons.some(r=>r.text.includes(text)));
 assert.ok(tabs.read(e,{window:'arc',blocked:'1'}).rows.every(r=>r.blockers.count>0));assert.equal(tabs.read(e,{window:'arc',q:'u7'}).rows.length,1);
 assert.equal(tabs.read(e,{window:'arc',sort:'redChecks'}).rows[0]!.subject.id,'u7');assert.equal(tabs.read(e,{window:'arc',sort:'elapsed'}).rows[0]!.subject.id,'u3');
 assert.deepEqual(tabs.read(e,{sort:'redChecks',direction:'asc'}).rows.filter(r=>r.subject.type==='unit').map(r=>r.subject.id),['u1','u2','u3','u4','u5','u6','u8','u9','u10','u11','u12','u13','u14','u7']);
 const empty=tabs.read(e,{from:'2100-01-01T00:00:00Z',to:'2100-01-02T00:00:00Z'});assert.equal(empty.rows.length,14);assert.equal(empty.totals.agentMs,null);assert.equal(empty.totals.spend.costUsd,null);assert.equal(empty.totals.coverage.waiting.unmeasuredReservations,null);
 assert.deepEqual([statusBytes(e,false),statusBytes(e,true)],before);assert.equal(effortShape({...h,events:[]}),false);
 for(const params of [{group:'unknown'},{metric:'cpu'},{sort:'rank'},{direction:'sideways'},{blocked:'true'},{unit:'foreign'},{system:'unknown'},{milestone:'missing'},{q:'x'.repeat(201)},{limit:'200'},{from:'2026-02-30T00:00:00Z'},{window:'arc',from:'2026-01-01T00:00:00Z'},{unit:'u1,u1'},{surprise:'1'}])assert.throws(()=>tabs.read(e,params as Record<string,string>),ConsoleError);
});
test('Effort completion boundaries keep zero/absent work, meter timestamps, delegated charges and overlapping mixed waiting distinct',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),tabs=new ConsoleEffort(),i=e.data.display.invocations.find(i=>i.endedAt&&i.work?.measured)!;
 const start=i.endedAt!,to=new Date(Date.parse(start)+1).toISOString();
 const only={...e,data:{...e.data,display:{...e.data.display,invocations:[{...i,work:{...i.work!,measured:{wallMs:0,runMs:0,waitMs:0}}}]}}};
 const zero=tabs.read(only,{from:start,to});assert.equal(i.execution==='agent'?zero.totals.agentMs:zero.totals.commandMs,0);assert.equal(zero.totals.coverage.execution.measured,1);
 const before=tabs.read(only,{from:new Date(Date.parse(start)-1).toISOString(),to:start});assert.equal(before.totals.agentMs,null);assert.equal(before.totals.commandMs,null);
 const {work:_work,...withoutWork}=i;const missing={...only,data:{...only.data,display:{...only.data.display,invocations:[withoutWork]}}};assert.equal(tabs.read(missing,{from:start,to}).totals.coverage.execution.unmeasured,1);
 const source=e.data.events.find(ev=>ev.type==='fact'&&ev.fact.kind==='meter')!;assert.ok(source.type==='fact'&&source.fact.kind==='meter');
 const charged=fact({...source.fact,session:'11111111-1111-4111-8111-111111111111',usage:{...source.fact.usage,costUsd:2.5,costEstimated:true},delegated:[{class:'economy',inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,costUsd:1.25}]},'meter');
 const changed={...e,data:{...e.data,events:e.data.events.map(ev=>ev===source?{...source,fact:charged}:ev)}};
 const canonical=meterOf(changed.data.events),value=tabs.read(changed,{window:'arc'});assert.equal(value.totals.spend.costUsd,[...canonical.byRole,...canonical.bySmoke].reduce((n,r)=>n+r.costUsd,0));assert.ok(value.totals.spend.estimated>0);
 const meterWindow=tabs.read(changed,{from:source.at,to:new Date(Date.parse(source.at)+1).toISOString()});assert.ok((meterWindow.totals.spend.costUsd??0)>=2.5,'cost assigned at recorded meter event');
 const admission=e.data.events.find(ev=>ev.type==='fact'&&ev.fact.kind==='stage-admitted')!;assert.ok(admission.type==='fact'&&admission.fact.kind==='stage-admitted');
 const mixed=fact({...admission.fact,waited:{totalMs:100,byReasonMs:{'cpu-pressure':80,'admission-hold:base-red':90}}},'admission');
 const mixedEnvelope={...e,data:{...e.data,events:[{...admission,fact:mixed}]}};const w=tabs.read(mixedEnvelope,{window:'arc'});assert.equal(w.totals.heldMs,0);assert.equal(w.totals.queuedMs,0);assert.equal(w.totals.unallocatedMs,100);
 // Multi-system membership selects a unit once, even when it matches both memberships.
 const plan=e.data.plan!;const multi={...e,data:{...e.data,plan:{...plan,units:plan.units.map(u=>u.id==='u7'?{...u,systems:[systemName('one'),systemName('two')]}:u)}}};
 const both=tabs.read(multi,{window:'arc',system:'one,two'});assert.equal(both.rows.length,1);assert.equal(both.rows[0]!.subject.id,'u7');assert.equal(both.totals.spend.costUsd,2.25);
});
test('Effort HTTP validates DTO/schema, strict queries and unchanged observer admission/security',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/effort`;
 const r=await consoleGet(base+'?window=arc');assert.equal(r.status,200,await r.clone().text());const raw=await r.json() as Envelope<unknown>;assert.ok(effortShape(raw.data));noMonolith(raw.data);assert.match(r.headers.get('cache-control')!,/no-store/);assert.ok(r.headers.get('content-security-policy'));assert.equal(r.headers.get('access-control-allow-origin'),null);
 const head=await fetch(base,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 for(const q of ['limit=30','sort=unknown','q=one&q=two','cursor=forged','offset=0','state=imaginary']){const bad=await consoleGet(base+'?'+q);assert.equal(bad.status,400,await bad.text());}
 assert.equal((await consoleGet(base+'?epoch=foreign')).status,409);assert.equal((await consoleGet(base+'?minHighWater=99999999')).status,503);
});
test('Effort keysets retain full-population null-last ranking and original values/order/asOf across completions, with strict identity and query binding',async t=>{
 const f=await investigationFixture(65);t.after(()=>f.close());const cache=new Observations(f.hostDir,'effort','repo'),e=capture(f,cache),tabs=new ConsoleEffort(),params={window:'arc',sort:'work',limit:'25'};
 const first=tabs.read(e,params),all=[...first.rows];let page=first;while(page.page.next){page=tabs.read(e,{...params,cursor:page.page.next});all.push(...page.rows);}
 assert.equal(all.length,65);assert.equal(new Set(all.map(r=>r.id)).size,65);assert.equal(all[0]!.subject.id,tabs.read(e,{...params,limit:'100'}).rows[0]!.subject.id);
 const values=all.map(r=>r.agentMs===null&&r.commandMs===null?null:(r.agentMs??0)+(r.commandMs??0));assert.ok(values.every((v,n)=>!n||v===null||values[n-1]!==null&&values[n-1]!>=v));
 const second=tabs.read(e,{...params,cursor:first.page.next!});assert.deepEqual(tabs.read(e,{...params,cursor:second.page.previous!}).rows,first.rows);
 f.finishLive();const newer=capture(f,cache);assert.ok(newer.highWater>e.highWater);assert.deepEqual(tabs.read(newer,{...params,cursor:second.page.previous!}).rows,first.rows);assert.deepEqual(tabs.read(newer,{...params,cursor:first.page.next!}).page.asOf,first.page.asOf);
 assert.throws(()=>tabs.read(newer,{...params,direction:'asc',cursor:first.page.next!}),/foreign/);assert.throws(()=>tabs.read({...newer,epoch:'foreign'},{...params,cursor:first.page.next!}),/foreign/);assert.throws(()=>tabs.read({...newer,instance:'foreign'},{...params,cursor:first.page.next!}),/foreign/);
 for(let n=0;n<33;n++)tabs.read(newer,{...params,q:String(n)});assert.throws(()=>tabs.read(newer,{...params,cursor:first.page.next!}),/expired/);
});
test('Effort client freezes ranked pages through semantic notices, validates route allowlists and resets old epochs',async t=>{
 const {ViewStore}=await import('../web-src/app/view-store.ts');const {ConsoleMetadata}=await import('../src/console/metadata.ts');const {ConsoleViews}=await import('../src/console/views.ts');
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),notice=new ConsoleMetadata().read(e,new ConsoleViews(),f.arc),data=new ConsoleEffort().read(e,{window:'arc'},notice.viewVersions.effort);let calls=0,value={...e,data};
 const store=new ViewStore(f.arc,CONSOLE_PROTOCOL,async()=>{calls++;return value;});store.notice(notice);await store.load('effort?window=arc');assert.equal(calls,1);assert.equal(store.entry('effort?window=arc').error,'');
 store.notice({...notice,revision:notice.revision+1,viewVersions:{...notice.viewVersions,effort:'f'.repeat(64)}});await store.load('effort?window=arc');assert.equal(calls,1);assert.deepEqual(store.entry('effort?window=arc').value!.data,data);
 value={...e,revision:e.revision+1,data:{...data,viewVersion:'f'.repeat(64)}};await store.load('effort?window=arc',true);assert.equal(calls,2);assert.equal(store.entry('effort?window=arc').value!.data.viewVersion,'f'.repeat(64));
 value={...e,revision:e.revision+2,data:{...data,raw:{}} as typeof data};await store.load('effort?window=arc',true);assert.match(store.entry('effort?window=arc').error,/Malformed/);
 store.notice({...notice,epoch:'new'},true);assert.equal(store.entries.size,0);
});
