import assert from 'node:assert/strict';
import { test } from 'node:test';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { unitView, milestoneView, invocationView, invocationSummaries } from '../src/console/details.ts';
import { consoleModel } from '../src/console/model.ts';
import { unitShape, milestoneShape, invocationShape } from '../src/console/view-shapes.ts';
import { statusBytes, CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { absPath } from '../src/core/values.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { serveConsole } from '../src/console/http.ts';
import { unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { invocationIdOf } from '../src/core/ids.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { boundDetail, contentDetail } from '../src/console/detail-content.ts';
import { contentShape } from '../src/console/view-shapes.ts';
import { applyContent, mergeDetailPage } from '../web-src/app/detail-merge.ts';
import { consoleGet } from './helpers/console-http.ts';
function noWorkingSet(value:unknown){if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){assert.ok(!['events','body','plan','display','estate','raw','report'].includes(key),key);noWorkingSet(child);}}
test('selected unit, milestone and invocation preserve detail meaning without canonical working sets',async t=>{
 const f=await investigationFixture(60);t.after(()=>f.close());
 const e=new ObservationCache(f.hostDir,'detail','repo').read({runDir:f.runDir,arc:f.arc}),before=statusBytes(e,false),model=consoleModel(e);
 for(const original of model.presentation.units){
  const detail=unitView(e,original.id,{}) as any;assert.ok(unitShape(detail));noWorkingSet(detail);
  assert.equal(detail.unit.title,original.title);assert.equal(detail.unit.attempts,original.attempts);assert.equal(detail.unit.state,original.state);assert.equal(detail.unit.stage,original.stage);
  assert.deepEqual(detail.journey.rows,original.journey.slice(0,25));assert.deepEqual(detail.acceptance.rows,original.acceptance.slice(0,25));
  assert.equal(detail.invocations.total,model.activities.filter(a=>a.unit===original.id).length);
  assert.ok(Buffer.byteLength(JSON.stringify({...e,data:detail}))<=64*1024);
 }
 for(const g of e.data.plan!.milestones!){const d=milestoneView(e,g.id,{});assert.ok(milestoneShape(d));assert.equal(d.total,g.units.length);assert.equal(d.members.rows.length,Math.min(25,g.units.length));noWorkingSet(d);}
 for(const a of invocationSummaries(e)){const d=invocationView(e,a.routeId);assert.ok(invocationShape(d));assert.equal(d.invocation.id,a.id);assert.ok(Buffer.byteLength(JSON.stringify({...e,data:d}))<16*1024);noWorkingSet(d);}
 assert.equal(statusBytes(e,false),before);assert.throws(()=>unitView(e,'foreign',{}),/applied plan/);assert.throws(()=>invocationView(e,'999999-1'),/not recorded/);
});
test('selected detail paging binds the capture, entity and section; field continuation reconstructs exact text',async t=>{
 const f=await investigationFixture(60);t.after(()=>f.close());const e=new ObservationCache(f.hostDir,'detail-pages','repo').read({runDir:f.runDir,arc:f.arc});
 // A long recorded specification field and acceptance list exercise explicit continuation.
 const copy=structuredClone(e),entry=copy.data.display.estate.find(x=>x.kind==='specification'&&x.id==='u1')!,body=JSON.parse(entry.body),intent='# Recorded intent\n'+('Native retained instructions. '.repeat(1000));
 body.intent=intent;body.acceptance=Array.from({length:77},(_,i)=>({clause:`Recorded acceptance ${i}`}));entry.body=JSON.stringify(body);
 const fifty=unitView(copy,'u1',{section:'acceptance',limit:'50'}) as any;assert.equal(fifty.acceptance.rows.length,50);
 assert.throws(()=>unitView(copy,'u1',{section:'acceptance',cursor:fifty.acceptance.next,limit:'25'}),/foreign/);
 assert.equal((unitView(copy,'u1',{section:'acceptance',cursor:fifty.acceptance.next,limit:'50'}) as any).acceptance.rows.length,27);
 let d=unitView(copy,'u1',{}) as any,all=[...d.acceptance.rows],text=d.intent.text,cursor=d.acceptance.next;assert.ok(cursor);assert.ok(d.intent.next);
 assert.throws(()=>unitView(copy,'u2',{section:'acceptance',cursor}),/foreign/);
 assert.throws(()=>unitView(copy,'u1',{section:'waiting',cursor}),/foreign/);
 assert.throws(()=>unitView(copy,'u1',{section:'acceptance',cursor:cursor+'x'}),/invalid/);
 assert.throws(()=>unitView({...copy,data:{...copy.data,capture:{...copy.data.capture,source:'changed'}}},'u1',{section:'acceptance',cursor}),/changed/);
 const appended={...copy,highWater:copy.highWater+1,data:{...copy.data,capture:{...copy.data.capture,source:'unrelated-append'}}};
 const anchored=unitView(appended,'u1',{section:'acceptance',cursor}) as any;assert.deepEqual(anchored.acceptance.rows,body.acceptance.slice(25,50).map((a:any)=>a.clause));assert.equal(anchored.acceptance.asOf.highWater,copy.highWater);
 assert.throws(()=>unitView({...copy,epoch:'replacement'},'u1',{section:'acceptance',cursor}),/foreign/);
 while(cursor){const next=unitView(copy,'u1',{section:'acceptance',cursor}) as any;all.push(...next.acceptance.rows);cursor=next.acceptance.next;}
 assert.deepEqual(all,body.acceptance.map((a:any)=>a.clause));
 cursor=d.intent.next;while(cursor){const next=unitView(copy,'u1',{section:'intent',cursor}) as any;text+=next.intent.text;cursor=next.intent.next;}
 assert.equal(text,intent);
});
test('selected HTTP endpoints retain admission, HEAD, security and route/query refusal',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
 for(const route of ['units/u1','units/u1?section=summary','milestones/MS-1','invocations/999999-1']){
  const r=await consoleGet(`${base}/${route}`);assert.equal(r.status,route.includes('999999')?404:200);assert.equal(r.headers.get('cache-control'),'no-store');assert.ok(r.headers.get('content-security-policy')?.includes("default-src 'self'"));
 }
 const head=await fetch(`${base}/units/u1`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 for(const route of ['units/u1?limit=26','units/u1?section=intent&limit=25','units/u1?typo=1','units/u1?section=typo','units/u1?cursor=x','units/u1?section=intent&cursor=x','invocations/not-an-id','milestones/missing?section=bad'])assert.equal((await consoleGet(`${base}/${route}`)).status,400,route);
 assert.equal((await consoleGet(`${base}/units/u1?epoch=old`)).status,409);assert.equal((await consoleGet(`${base}/units/u1?minHighWater=9999999`)).status,503);
});

test('adversarial selected fields and nested lists obey hard byte ceilings and reconstruct exactly',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=new ObservationCache(f.hostDir,'detail-hard-bytes','repo').read({runDir:f.runDir,arc:f.arc});
 const original=unitView(e,'u7',{}) as any;
 const text='Recorded \"\n𝄞界'.repeat(1500);
 original.unit.title=text;original.acceptance.rows=Array.from({length:25},()=>text);original.acceptance.total=25;
 original.requests.rows=[{id:'human-recorded',summary:text,recommendation:text}];original.requests.total=1;
 original.journey.rows[0].findingTitles=Array.from({length:80},(_,n)=>`${n}: ${text}`);
 original.journey.rows[0].notes=Array.from({length:70},(_,n)=>`${n}: recorded note`);
 original.journey.rows[0].activities=Array.from({length:500},(_,n)=>`${n+1}-1`);
 let bounded=boundDetail(e,'unit:u7',original,64*1024) as any;
 assert.ok(unitShape(bounded));assert.ok(Buffer.byteLength(JSON.stringify({...e,data:bounded})+'\n')<=64*1024);
 let count=0,maximum=0;
 while(bounded.continuations.length){
  const used=bounded.continuations[0],r=contentDetail(e,'unit:u7',used.next,64*1024);
  assert.ok(contentShape(r));const bytes=Buffer.byteLength(JSON.stringify({...e,data:r})+'\n');maximum=Math.max(maximum,bytes);assert.ok(bytes<=64*1024);
  let parent=bounded;for(const key of r.content.path.slice(0,-1))parent=parent[key];const key=r.content.path.at(-1)!;
  if(r.content.kind==='text')parent[key]=parent[key].slice(0,r.content.offset)+r.content.value;
  else parent[key].splice(r.content.offset,parent[key].length-r.content.offset,...r.content.value);
  bounded.continuations=[...bounded.continuations.slice(1),...r.continuations];assert.ok(++count<3000);
 }
 for(const key of ['unit','acceptance','requests','journey'])assert.deepEqual(bounded[key],original[key],key);
 const inv=invocationView(e,f.finished.routeId);inv.actor.model=text;inv.actor.requestedModel=text;
 inv.related.rows=Array.from({length:100},(_,n)=>({id:`u${n+1}`,title:text,state:'Pending',signal:'pending',source:inv.invocation.routeId,target:`u${n+1}`,unmet:false}));inv.related.total=100;
 const small=boundDetail(e,`invocation:${f.finished.routeId}`,inv,16*1024) as any;
 assert.ok(invocationShape(small));assert.ok(Buffer.byteLength(JSON.stringify({...e,data:small})+'\n')<=16*1024);
 const ref=small.continuations[0];assert.throws(()=>contentDetail(e,'unit:u1',ref.next,16*1024),/foreign/);assert.throws(()=>contentDetail({...e,epoch:'other'},`invocation:${f.finished.routeId}`,ref.next,16*1024),/foreign/);assert.throws(()=>contentDetail(e,`invocation:${f.finished.routeId}`,ref.next+'x',16*1024),/invalid/);
 const next=contentDetail(e,`invocation:${f.finished.routeId}`,ref.next,16*1024);assert.ok(Buffer.byteLength(JSON.stringify({...e,data:next})+'\n')<=16*1024);
 t.diagnostic(JSON.stringify({fieldReads:count,largestUnitFieldBytes:maximum,invocationBytes:Buffer.byteLength(JSON.stringify({...e,data:small})+'\n')}));
});
test('selected metadata records lineage, blockers, coverage and evidence availability; corruption never becomes absence',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=new ObservationCache(f.hostDir,'detail-metadata','repo').read({runDir:f.runDir,arc:f.arc});
 const reentry=unitView(e,'u14',{}) as any;assert.deepEqual(reentry.unit.lineage,e.data.display.status.units.find(u=>u.unit==='u14')!.lineage);
 assert.equal((unitView(e,'u12',{}) as any).supersededBy,'u14');
 const blocked=unitView(e,'u11',{}) as any;assert.equal(blocked.currentBlockers.pressureBlocked,true);assert.equal(blocked.currentBlockers.resources.cpu,4);
 const measured=unitView(e,'u1',{}) as any;assert.deepEqual(measured.coverage.money,{recorded:1,estimated:0,unavailable:0});assert.equal(measured.coverage.execution.measured,1);
 assert.equal(measured.coverage.waiting.unmeasured,0);assert.equal((unitView(e,'u10',{}) as any).coverage.waiting.unmeasured,1);
 const detail=invocationView(e,f.finished.routeId);assert.equal(detail.detailAvailability.result,'available');assert.equal(detail.detailAvailability.history,'available');assert.equal(detail.detailAvailability.prompt,'available');assert.equal(detail.detailAvailability.logs.runner,'unavailable','missing optional logs do not establish that a file was never recorded or was pruned');assert.equal(invocationView(e,f.activeCheck.routeId).detailAvailability.history,'not-applicable');
 assert.equal(invocationView(e,f.live.routeId).detailAvailability.result,'not-recorded');
 const dir=invocationDir(e.data.display.run.runDir,invocationIdOf(f.finished.inv)),result=join(dir,'result.json');
 unlinkSync(result);assert.equal(invocationView(e,f.finished.routeId).detailAvailability.result,'pruned');
 writeFileSync(result,'{}');assert.throws(()=>invocationView(e,f.finished.routeId));unlinkSync(result);symlinkSync('/etc/passwd',result);assert.throws(()=>invocationView(e,f.finished.routeId),/symlink|escapes/);
});
test('bounded collection generations expire explicitly and preserve frozen order through selected appends',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=new ObservationCache(f.hostDir,'detail-generations','repo').read({runDir:f.runDir,arc:f.arc});
 const entry=e.data.display.estate.find(x=>x.kind==='specification'&&x.id==='u1')!,spec=JSON.parse(entry.body);spec.acceptance=Array.from({length:80},(_,n)=>({clause:`recorded ${n}`}));entry.body=JSON.stringify(spec);
 const first=unitView(e,'u1',{}) as any,cursor=first.acceptance.next;
 spec.acceptance.unshift({clause:'new selected row'});entry.body=JSON.stringify(spec);
 const second=unitView({...e,highWater:e.highWater+1},'u1',{section:'acceptance',cursor}) as any;
 assert.deepEqual(second.acceptance.rows,Array.from({length:25},(_,n)=>`recorded ${n+25}`));assert.equal(second.acceptance.total,80);
 for(let n=0;n<70;n++)unitView(e,'u1',{});
 assert.throws(()=>unitView(e,'u1',{section:'acceptance',cursor}),/expired/);
});

test('fields larger than the retention budget expand from verified sources with fingerprints and frozen order',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=new ObservationCache(f.hostDir,'detail-oversize','repo').read({runDir:f.runDir,arc:f.arc});
 const entry=e.data.display.estate.find(x=>x.kind==='specification'&&x.id==='u1')!,spec=JSON.parse(entry.body),large='Recorded oversized clause. '.repeat(700000);
 spec.acceptance=Array.from({length:40},(_,n)=>({id:`A${n+1}`,clause:n===0?large:`Recorded clause ${n+1}`,failLoudIfUndelivered:true,state:'active'}));entry.body=JSON.stringify(spec);
 const first=unitView(e,'u1',{}) as any;assert.ok(unitShape(first));assert.ok(Buffer.byteLength(JSON.stringify({...e,data:first})+'\n')<=64*1024);
 const field=first.continuations.find((r:any)=>r.path.join('.')==='acceptance.rows.0');assert.ok(field);
 const appended={...e,highWater:e.highWater+1};
 const expanded=unitView(appended,'u1',{section:'content',cursor:field.next}) as any;assert.ok(contentShape(expanded));assert.equal(expanded.content.value,large.slice(field.offset,field.offset+4096));
 const second=unitView(appended,'u1',{section:'acceptance',cursor:first.acceptance.next}) as any;assert.deepEqual(second.acceptance.rows,spec.acceptance.slice(25).map((a:any)=>a.clause));
 spec.acceptance[0].clause='Changed recorded field';entry.body=JSON.stringify(spec);
 assert.throws(()=>unitView(e,'u1',{section:'content',cursor:field.next}),/changed/);
});

test('appended bounded pages rebase nested list and text continuations without overwriting earlier evidence',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=new ObservationCache(f.hostDir,'detail-merge','repo').read({runDir:f.runDir,arc:f.arc});
 const base=unitView(e,'u1',{}) as any,large='Exact Unicode 𝄞 evidence. '.repeat(400);
 const next=structuredClone(base);next.acceptance.rows=Array.from({length:100},(_,n)=>`${n} ${large}`);next.acceptance.total=101;
 const page=boundDetail(e,'unit:u1',next,64*1024) as any;
 const old={...base,acceptance:{...base.acceptance,rows:['Keep earlier recorded clause']},continuations:[]};
 let merged=mergeDetailPage(old,page,'acceptance'),guard=0;
 while(merged.continuations.length){const used=merged.continuations[0],reply=contentDetail(e,'unit:u1',used.next,64*1024);merged=applyContent(merged,reply,used);assert.ok(++guard<1000);}
 assert.deepEqual(merged.acceptance.rows,['Keep earlier recorded clause',...next.acceptance.rows]);
 // Intent chunks can themselves need byte continuation after earlier chunks.
 const intentPage=boundDetail(e,'unit:u1',{...base,intent:{text:large,next:null}},64*1024) as any;
 let text=mergeDetailPage({...base,intent:{text:'Earlier intent\n',next:'pending'},continuations:[]},intentPage,'intent');
 while(text.continuations.length){const used=text.continuations[0];text=applyContent(text,contentDetail(e,'unit:u1',used.next,64*1024),used);}
 assert.equal(text.intent.text,'Earlier intent\n'+large);
});
