import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { ConsoleError, CONSOLE_PROTOCOL, statusBytes, type Envelope } from '../src/observation/protocol.ts';
import { ConsoleAttention } from '../src/console/attention-query.ts';
import { requestDetail, requestGuidance } from '../src/console/request-detail.ts';
import { needsUserRecord, needsUserAck, type NeedsUserRecord } from '../src/core/records.ts';
import { needsUserPath, needsUserAckPath } from '../src/needsuser.ts';
import { needsUserId } from '../src/core/ids.ts';
import { attentionShape, requestShape, contentShape } from '../src/console/view-shapes.ts';
import type { RequestView } from '../src/console/attention-protocol.ts';
import { applyContent } from '../web-src/app/detail-merge.ts';
import { absPath } from '../src/core/values.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { serveConsole } from '../src/console/http.ts';
import { consoleGet } from './helpers/console-http.ts';
const capture=(f:Awaited<ReturnType<typeof investigationFixture>>,cache=new ObservationCache(f.hostDir,'attention','repo'))=>cache.read({runDir:f.runDir,arc:f.arc});
function noMonolith(value:unknown){if(!value||typeof value!=='object')return;for(const [key,v] of Object.entries(value)){assert.ok(!['events','display','plan','body','report','raw','capture','transcript','console'].includes(key),key);noMonolith(v);}}
function fileRecord(f:Awaited<ReturnType<typeof investigationFixture>>,n:number,overrides:Partial<NeedsUserRecord>={}) {
  const r=needsUserRecord({v:2,id:`sup-1-${n}`,arc:f.arc,raisedAt:`2026-11-01T00:00:00.000Z`,blocking:true,subject:{type:'host'},reason:'supervisor-crash-limit',summary:'Duplicate request summary',recommendation:'Inspect the recorded environment.',options:[],evidence:[],...overrides},'fixture request');
  mkdirSync(join(f.runDir,'needs-user'),{recursive:true});writeFileSync(needsUserPath(f.runDir,r.id),JSON.stringify(r));return r;
}

test('Attention canonical file-only/open records, exact counts, frozen filtering and complete keysets preserve canonical bytes',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());for(let n=1;n<=62;n++)fileRecord(f,n);
 const cache=new ObservationCache(f.hostDir,'attention','repo'),e=capture(f,cache),before=[statusBytes(e,false),statusBytes(e,true)],tabs=new ConsoleAttention();
 const first=tabs.read(e,{limit:'25'});assert.ok(attentionShape(first));noMonolith(first);assert.deepEqual(first.counts,{total:65,blocking:64,informational:1});assert.equal(first.page.matching,65);
 assert.ok(first.rows.every(r=>r.blocking));assert.equal(first.rows.filter(r=>r.summary.text==='Duplicate request summary').length,25);
 const all=[...first.rows];let page=first;while(page.page.next){page=tabs.read(e,{limit:'25',cursor:page.page.next});all.push(...page.rows);}
 assert.equal(all.length,65);assert.equal(new Set(all.map(r=>r.id)).size,65);assert.equal(all.at(-1)!.blocking,false);
 const bySubject=tabs.read(e,{subjectType:'host',q:'duplicate',sort:'newest'});assert.equal(bySubject.page.matching,62);assert.equal(bySubject.counts.total,65);
 const info=tabs.read(e,{blocking:'0'});assert.equal(info.rows.length,1);assert.equal(info.rows[0]!.summary.text,'Review the revised plan');
 const second=tabs.read(e,{limit:'25',cursor:first.page.next!});assert.deepEqual(tabs.read(e,{limit:'25',cursor:second.page.previous!}).rows,first.rows);
 fileRecord(f,63);const newer=capture(f,cache);assert.equal(tabs.read(newer,{}).counts.total,66);assert.deepEqual(tabs.read(newer,{limit:'25',cursor:first.page.next!}).page.asOf,first.page.asOf);
 assert.deepEqual(tabs.read(newer,{limit:'25',cursor:second.page.previous!}).rows,first.rows);
 const r=needsUserAck({v:2,id:'sup-1-1',command:'cmd-0000000000000001',choice:null,at:'2026-11-02T00:00:00.000Z'},'fixture ack');writeFileSync(needsUserAckPath(f.runDir,r.id),JSON.stringify(r));
 const resolved=capture(f,cache);assert.equal(tabs.read(resolved,{}).counts.total,65);assert.ok(!tabs.read(resolved,{q:'sup-1-1'}).rows.some(r=>r.id==='sup-1-1'));
 assert.deepEqual([statusBytes(e,false),statusBytes(e,true)],before);
 for(const params of [{blocking:'yes'},{subjectType:'job'},{reason:'invented'},{limit:'0'},{limit:'200'},{sort:'rank'},{q:'x'.repeat(201)},{surprise:'1'},{subjectType:'unit,unit'},{cursor:first.page.next!,limit:'25',q:'changed'}])assert.throws(()=>tabs.read(e,params as Record<string,string>),ConsoleError);
 assert.throws(()=>tabs.read({...e,epoch:'foreign'},{limit:'25',cursor:first.page.next!}),/foreign/);
 assert.equal(attentionShape({...first,events:[]}),false);
});

test('selected requests retain exact recommendations/options/evidence and valid subject-aware command guidance',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),detail=requestDetail(e,f.request,{}) as RequestView;
 assert.ok(requestShape(detail));noMonolith(detail);assert.equal(detail.id,f.request);assert.equal(detail.open,true);assert.equal(detail.fields.summary,'Compiler process failed');
 assert.equal(detail.options[0]!.command,`roadmap ack ${f.request} --choice retry`);assert.equal(detail.guidance.command,null);assert.deepEqual(detail.affectedUnits.map(u=>u.id),['u6']);assert.equal(detail.evidenceRefs[0]!.invocation,f.finished.routeId);
 const original=e.data.requests.find(r=>r.id===f.request)!;
 assert.equal(requestGuidance({...original,options:[],subject:{type:'unit',unit:original.subject.type==='unit'?original.subject.unit:'u6' as never}}).command,null);
 assert.equal(requestGuidance({...original,options:[],subject:{type:'arc'}}).command,`roadmap ack ${f.request}`);
 assert.equal(requestGuidance({...original,options:[],reason:'pack-review',subject:{type:'host'}}).command,`roadmap ack ${f.request}`);
 const baseline=e.data.requests.find(r=>r.summary==='Baseline checks are failing')!,base=requestDetail(e,baseline.id,{}) as RequestView;
 assert.deepEqual(base.affectedUnits.map(u=>u.id),e.data.display.status.units.filter(u=>u.waitingFor?.admission.some(a=>a.type==='blocking-item'&&a.id===baseline.id)).map(u=>u.unit),'only matching recorded admission references establish affected units');
 const acked=e.data.events.find(ev=>ev.type==='fact'&&ev.fact.kind==='needs-user-acked')!;
 if(acked.type!=='fact'||acked.fact.kind!=='needs-user-acked')throw Error();
 const closed=requestDetail(e,acked.fact.id,{}) as RequestView;assert.equal(closed.open,false);assert.equal(closed.resolutionEvidence[0]!.kind,'acknowledged');assert.equal(closed.resolutionEvidence[0]!.source,'journal');assert.equal(closed.fields.summary,'Already answered request');assert.equal(closed.guidance.command,null);assert.ok(closed.options.every(o=>o.command===null));
 const declined={...e,data:{...e.data,events:e.data.events.map(ev=>ev===acked?{...acked,fact:{...acked.fact,command:null}}:ev)}} as Envelope;
 assert.equal((requestDetail(declined,acked.fact.id,{}) as RequestView).resolutionEvidence[0]!.kind,'declined');
 const absent={...e,data:{...e.data,requests:e.data.requests.filter(r=>r.id!==f.request)}};
 assert.deepEqual((requestDetail(absent,f.request,{}) as RequestView).resolutionEvidence,[{kind:'no-longer-open',source:'open-list',at:null,command:null,choice:null}]);
 for(const id of ['nu-999999','sup-99-99'])assert.throws(()=>requestDetail(e,id,{}),/not (recorded|retained)/);
 assert.throws(()=>requestDetail(e,'../outside',{}),/invalid request/);
 assert.throws(()=>requestDetail(e,f.request,{path:'/tmp/arbitrary'}),/unknown/);
 const staleSubject=fileRecord(f,1,{subject:{type:'unit',unit:'not-in-plan' as never}});assert.throws(()=>requestDetail(e,staleSubject.id,{}),/outside the verified/);const stale=requestDetail(capture(f),staleSubject.id,{}) as RequestView;assert.deepEqual(stale.affectedUnits.map(u=>u.id),['u7','u10','u14'],'supervisor reason preserves actual admission holds while excluding the stale subject');assert.ok(!stale.affectedUnits.some(u=>u.id==='not-in-plan'));assert.equal(stale.recordPreview?.subject.type,'unit');
 assert.equal(requestShape({...detail,raw:{}}),false);
});

test('selected request fields and nested lists reconstruct exactly within hard envelopes; revalidation refuses digest, identity, symlink and pruning changes',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const long='Exact recorded text \\" <script> 🛰️\n'.repeat(3000),r=fileRecord(f,1,{summary:long,recommendation:long,options:Array.from({length:130},(_,n)=>({id:`choice-${n}`,label:long.slice(0,300)+n})),evidence:Array.from({length:130},(_,n)=>absPath(`/recorded/path/${n}`))});
 const cache=new ObservationCache(f.hostDir,'attention','repo'),e=capture(f,cache);let d=requestDetail(e,r.id,{}) as RequestView;assert.ok(requestShape(d));assert.ok(Buffer.byteLength(JSON.stringify({...e,data:d}))+1<=32*1024);
 let reads=0;while(d.continuations?.length){const ref=d.continuations[0]!,page=requestDetail(e,r.id,{section:'content',cursor:ref.next});assert.ok(contentShape(page));assert.ok(Buffer.byteLength(JSON.stringify({...e,data:page}))+1<=16*1024);d=applyContent(d,page as never,ref);assert.ok(++reads<1000);}
 assert.equal(d.fields.summary,long);assert.equal(d.fields.recommendation,long);assert.equal(d.options.length,130);assert.deepEqual(d.options.map(o=>({id:o.id,label:o.label})),r.options);assert.deepEqual(d.evidenceRefs.map(p=>p.path),r.evidence);
 const original=needsUserPath(f.runDir,f.request),bytes=readFileSync(original);writeFileSync(original,Buffer.from(bytes.toString().replace('Compiler process failed','Compiler process changed')));
 assert.throws(()=>requestDetail(e,f.request,{}),/digest/);writeFileSync(original,bytes);
 rmSync(original);const pruned=requestDetail(e,f.request,{}) as RequestView;assert.equal(pruned.evidenceAvailability,'pruned');assert.equal(pruned.recordPreview,null);
 writeFileSync(original,bytes);const outside=join(f.d.repo,'outside-request.json');writeFileSync(outside,bytes);rmSync(original);symlinkSync(outside,original);assert.throws(()=>requestDetail(e,f.request,{}),/symlink|escape/);rmSync(original);writeFileSync(original,bytes);
 const filePath=needsUserPath(f.runDir,r.id);writeFileSync(needsUserAckPath(f.runDir,r.id),JSON.stringify(needsUserAck({v:2,id:r.id,command:'cmd-0000000000000008',choice:null,at:'2026-11-09T00:00:00.000Z'},'fixture retained ack')));rmSync(filePath);const prunedFile=requestDetail(capture(f,cache),r.id,{}) as RequestView;assert.equal(prunedFile.evidenceAvailability,'pruned');assert.equal(prunedFile.resolutionEvidence[0]!.source,'ack-file');writeFileSync(filePath,JSON.stringify({...r,arc:'foreign'}));assert.throws(()=>requestDetail(e,r.id,{}),/identity/);
});

test('Attention/request HTTP keeps strict filters, admission, GET/HEAD, security and bounded selected field reads',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
 for(const [path,shape] of [['attention',attentionShape],[`requests/${f.request}`,requestShape]] as const){const r=await consoleGet(`${base}/${path}`);assert.equal(r.status,200,await r.clone().text());const raw=await r.json() as Envelope<unknown>;assert.ok(shape(raw.data));noMonolith(raw.data);assert.match(r.headers.get('cache-control')!,/no-store/);const head=await fetch(`${base}/${path}`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.ok(head.headers.get('content-security-policy'));}
 for(const path of ['attention?blocking=all&blocking=1','attention?sort=invented','attention?offset=0','attention?cursor=forged',`requests/${f.request}?section=content`,`requests/${f.request}?path=/tmp/x`]){const r=await consoleGet(`${base}/${path}`);assert.equal(r.status,400,`${path}: ${await r.text()}`);}
 assert.equal((await consoleGet(`${base}/attention?epoch=wrong`)).status,409);assert.equal((await consoleGet(`${base}/requests/nu-999999`)).status,404);
});
