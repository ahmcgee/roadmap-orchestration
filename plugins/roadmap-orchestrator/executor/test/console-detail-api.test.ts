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
