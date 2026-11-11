import assert from 'node:assert/strict';
import { test } from 'node:test';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { Observations } from './helpers/observations.ts';
import { ConsoleEffort } from '../src/console/effort-query.ts';
import { effortContributions, systemSetKey } from '../src/console/effort-contributions.ts';
import { effortShape, effortScopeShape } from '../src/console/view-shapes.ts';
import type { EffortTotals, EffortGroup, EffortScopeView } from '../src/console/effort-protocol.ts';
import { statusBytes, CONSOLE_PROTOCOL, ConsoleError } from '../src/observation/protocol.ts';
import { unitId, systemName } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { serveConsole } from '../src/console/http.ts';
import { consoleGet } from './helpers/console-http.ts';
function reconciles(rows:EffortTotals[],total:EffortTotals){
 for(const k of ['agentMs','commandMs','heldMs','queuedMs','unallocatedMs'] as const)assert.equal(rows.reduce((n,r)=>n+(r[k]??0),0),total[k]??0,k);
 assert.ok(Math.abs(rows.reduce((n,r)=>n+(r.spend.costUsd??0),0)-(total.spend.costUsd??0))<1e-9);
 for(const kind of ['money','execution','waiting'] as const)for(const k of Object.keys(total.coverage[kind])){if(k==='unmeasuredReservations')continue;assert.equal(rows.reduce((n,r)=>n+(r.coverage[kind] as Record<string,number>)[k]!,0),(total.coverage[kind] as Record<string,number>)[k],`${kind}.${k}`);}
}
function pages(tabs:ConsoleEffort,e:Parameters<ConsoleEffort['read']>[0],key:string,query:Record<string,string>,section:'subjects'|'measurements'){
 let p=tabs.detail(e,key,{...query,section,limit:'25'});const rows=[...p.rows],asOf=p.page.asOf;
 assert.ok(effortScopeShape(p));assert.ok(Buffer.byteLength(JSON.stringify({...e,data:p}))+1<=32*1024);
 while(p.page.next){p=tabs.detail(e,key,{...query,section,limit:'25',cursor:p.page.next});assert.deepEqual(p.page.asOf,asOf);rows.push(...p.rows);assert.ok(effortScopeShape(p));}
 assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);assert.equal(rows.length,p.page.matching);return {data:p,rows};
}
test('Effort role/system-set groups partition every work/charge/wait exactly once, expose all selected evidence and preserve canonical bytes',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=new Observations(f.hostDir,'effort-groups','repo').read({runDir:f.runDir,arc:f.arc}),tabs=new ConsoleEffort(),before=[statusBytes(e,false),statusBytes(e,true)],units=tabs.read(e,{window:'arc'});
 const contributions=effortContributions(e);assert.ok(contributions.some(c=>c.role!==null&&c.invocation));assert.ok(contributions.some(c=>c.kind==='waiting'&&c.role===null));
 for(const group of ['role','system-set'] as EffortGroup[]){
  const h=tabs.read(e,{window:'arc',group});assert.ok(effortShape(h));assert.deepEqual(h.totals,units.totals);reconciles(h.rows,h.totals);
  const ids:string[]=[];
  for(const row of h.rows){assert.ok(row.detailKey);const subjects=pages(tabs,e,row.detailKey!,{window:'arc',group},'subjects'),measurements=pages(tabs,e,row.detailKey!,{window:'arc',group},'measurements');
   reconciles(subjects.rows,row);reconciles(measurements.rows,row);assert.equal(subjects.rows.length,measurements.data.counts.subjects);assert.equal(measurements.rows.length,row.contributorCount);ids.push(...measurements.rows.map(r=>r.id));
   assert.equal(row.lifetime.elapsedMs,null,'no aggregate wall-time fabrication');
   if(group==='role'&&row.subject.type==='unattributed'){assert.equal(row.heldMs,h.totals.heldMs);assert.equal(row.queuedMs,h.totals.queuedMs);assert.ok(measurements.rows.every(r=>'role' in r&&r.role===null));assert.equal(measurements.data.filter.role,'unattributed');}
   const filter=measurements.data.filter,query={window:'arc',...Object.fromEntries(Object.entries(filter).filter((entry):entry is [string,string]=>entry[1]!==null))};
   if(Object.values(filter).some(v=>v!==null))reconciles(tabs.read(e,query).rows,row);
  }
  assert.deepEqual(ids.sort(),contributions.map(c=>c.id).sort());
 }
 assert.deepEqual([statusBytes(e,false),statusBytes(e,true)],before);
});
test('System sets preserve every membership, never multiply charges, retain empty groups and filter before ranking/window/counts',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const original=new Observations(f.hostDir,'effort-groups','repo').read({runDir:f.runDir,arc:f.arc}),plan=original.data.plan!,e={...original,data:{...original.data,plan:{...plan,units:plan.units.map(u=>u.id==='u7'?{...u,systems:[systemName('two'),systemName('one')]}:u)}}},tabs=new ConsoleEffort();
 const h=tabs.read(e,{window:'arc',group:'system-set'}),r=h.rows.find(r=>r.systems.includes('one'))!;assert.equal(h.rows[0]!.subject.type,'system-set');assert.deepEqual(r.systems,['one','two']);assert.equal(r.spend.costUsd,2.25);reconciles(h.rows,h.totals);
 assert.equal(tabs.read(e,{window:'arc',group:'system-set',system:'one,two'}).rows.length,1);
 const selected=tabs.read(e,{window:'arc',systemSet:systemSetKey(['two','one'])});assert.equal(selected.rows.length,1);assert.equal(selected.rows[0]!.subject.id,'u7');assert.equal(selected.totals.spend.costUsd,2.25);
 const empty=tabs.read(e,{from:'2100-01-01T00:00:00Z',to:'2100-01-02T00:00:00Z',group:'system-set'});assert.ok(empty.rows.length>0);assert.ok(empty.rows.every(r=>r.agentMs===null&&r.spend.costUsd===null));
 const only=tabs.read(e,{window:'arc',group:'role',unit:'u7',sort:'spend'});reconciles(only.rows,only.totals);assert.equal(only.totals.spend.costUsd,2.25);
 const values=only.rows.map(r=>r.spend.costUsd);assert.ok(values.every((v,n)=>!n||v===null||values[n-1]!==null&&values[n-1]!>=v));
 const c=effortContributions(e).find(c=>c.role!==null&&c.kind==='money')!,at=c.at,to=new Date(Date.parse(at)+1).toISOString(),bounded=tabs.read(e,{group:'role',from:at,to});reconciles(bounded.rows,bounded.totals);assert.ok(bounded.totals.spend.recorded>0);
 // A retained charge subject itself records the role even when invocation metadata is absent.
 const meterOnly={...e,data:{...e.data,display:{...e.data.display,invocations:[]}}},meterGroups=tabs.read(meterOnly,{window:'arc',group:'role'});
 assert.equal(meterGroups.rows.find(r=>r.subject.id==='role:build')!.spend.costUsd,5.25);
 assert.equal(meterGroups.rows.find(r=>r.subject.id==='role:verifier')!.spend.costUsd,0.75);
 reconciles(meterGroups.rows,meterGroups.totals);
 const unplanned={...meterOnly,data:{...meterOnly.data,events:meterOnly.data.events.map(ev=>ev.type==='fact'&&ev.fact.kind==='meter'&&ev.fact.subject.type==='seat'?{...ev,fact:{...ev.fact,subject:{...ev.fact.subject,unit:unitId('retained-only')}}}:ev)}};
 const outside=tabs.read(unplanned,{window:'arc',group:'system-set'}).rows.find(r=>r.subject.type==='unattributed')!;
 assert.ok(outside.detailKey);const evidence=tabs.detail(unplanned,outside.detailKey!,{window:'arc',group:'system-set',section:'measurements'});
 assert.ok(evidence.rows.length>0);assert.ok(evidence.rows.every(r=>r.unitRef===null),'unplanned unit identity stays readable without a broken unit target');
 for(const params of [{group:'role',sort:'elapsed'},{group:'system-set',sort:'rounds'},{role:'nonexistent'},{systemSet:'forged'},{subject:'job:absent'}])assert.throws(()=>tabs.read(e,params),ConsoleError);
});
test('Selected Effort scope has immutable exhaustive evidence pages, strict query/identity binding and explicit eviction/reset',async t=>{
 const f=await investigationFixture(65);t.after(()=>f.close());for(let n=0;n<30;n++)f.journal.fact({kind:'stage-admitted',unit:unitId('u7'),stage:'build',waited:{totalMs:n,byReasonMs:{'cpu-tokens':n}}});const cache=new Observations(f.hostDir,'groups','repo'),e=cache.read({runDir:f.runDir,arc:f.arc}),tabs=new ConsoleEffort(),group='role',h=tabs.read(e,{window:'arc',group}),r=h.rows.find(r=>r.contributorCount>25)!;assert.ok(r);
 const params={window:'arc',group,section:'measurements',limit:'25'},first=tabs.detail(e,r.detailKey!,params);assert.ok(first.page.next);const second=tabs.detail(e,r.detailKey!,{...params,cursor:first.page.next!});assert.deepEqual(tabs.detail(e,r.detailKey!,{...params,cursor:second.page.previous!}).rows,first.rows);
 f.finishLive();const newer=cache.read({runDir:f.runDir,arc:f.arc});assert.ok(newer.highWater>e.highWater);assert.deepEqual(tabs.detail(newer,r.detailKey!,{...params,cursor:second.page.previous!}).rows,first.rows);assert.deepEqual(tabs.detail(newer,r.detailKey!,{...params,cursor:first.page.next!}).page.asOf,first.page.asOf);
 for(const changed of [{...params,section:'subjects'},{...params,unit:'u7'},{...params,group:'system-set'}])assert.throws(()=>tabs.detail(newer,r.detailKey!,{...changed,cursor:first.page.next!}),/foreign/);
 for(const property of ['arc','epoch','instance','repoId'] as const)assert.throws(()=>tabs.detail({...newer,[property]:'foreign'},r.detailKey!,{...params,cursor:first.page.next!}),/foreign/);
 assert.throws(()=>tabs.detail(e,'effort-'+'f'.repeat(64),params),/not recorded/);assert.throws(()=>tabs.detail(e,'../outside',params),/invalid/);
 for(let n=0;n<33;n++)tabs.read(newer,{window:'arc',q:String(n)});assert.throws(()=>tabs.detail(newer,r.detailKey!,{...params,cursor:first.page.next!}),/expired/);
});
test('Scope HTTP and client admit only the selected typed identity with bounded GET/HEAD and no monolith fallback',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=new Observations(f.hostDir,'groups','repo').read({runDir:f.runDir,arc:f.arc}),tabs=new ConsoleEffort(),r=tabs.read(e,{window:'arc',group:'role'}).rows[0]!,key=r.detailKey!;
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/resources/details/${key}`;
 const response=await consoleGet(base+'?window=arc&group=role');assert.equal(response.status,200,await response.clone().text());const raw=await response.json() as {data:EffortScopeView};assert.ok(effortScopeShape(raw.data));assert.equal(raw.data.page.limit,25,'selected evidence defaults to one bounded detail page');assert.match(response.headers.get('cache-control')!,/no-store/);assert.equal(response.headers.get('access-control-allow-origin'),null);
 const head=await fetch(base+'?window=arc&group=role',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 for(const q of ['section=unknown','offset=0','group=role&group=unit','cursor=forged'])assert.equal((await consoleGet(base+'?'+q)).status,400);
 assert.equal((await consoleGet(base+'?group=role&epoch=foreign')).status,409);assert.equal((await consoleGet(base+'?group=role&minHighWater=99999999')).status,503);assert.equal((await consoleGet(base+'?group=system-set')).status,404);
 const {ViewStore}=await import('../web-src/app/view-store.ts'),{ConsoleMetadata}=await import('../src/console/metadata.ts'),{ConsoleViews}=await import('../src/console/views.ts');
 let value={...e,data:tabs.detail(e,key,{window:'arc',group:'role'})},calls=0;const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>{calls++;return value;}),path=`resources/details/${key}?window=arc&group=role`;
 store.notice(new ConsoleMetadata().read(e,new ConsoleViews(),f.arc));await store.load(path);assert.equal(store.entry(path).error,'');assert.equal(calls,1);
 value={...value,data:{...value.data,key:'effort-'+'f'.repeat(64)}};await store.load(path,true);assert.match(store.entry(path).error,/identity mismatch/);
 value={...value,data:{...value.data,key,raw:{}} as typeof value.data};await store.load(path,true);assert.match(store.entry(path).error,/Malformed/);
});
