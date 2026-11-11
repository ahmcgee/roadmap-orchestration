import assert from 'node:assert/strict';
import {test} from 'node:test';
import {round4Fixture} from './fixtures/console-round4.ts';
import { Observations } from './helpers/observations.ts';
import {unitView} from '../src/console/details.ts';
import type {UnitView} from '../src/console/detail-protocol.ts';
import {buildActivityIndex} from '../src/console/activity-index.ts';
test('terminal completion, meaningful waits and housekeeping are faithful to recorded evidence',async t=>{
 const f=await round4Fixture();t.after(()=>f.close());const e=new Observations(f.hostDir,'round4','reader').read({runDir:f.runDir,arc:f.arc});const d=unitView(e,'u1') as UnitView,u=d.unit;
 assert.equal(d.journey.rows.find(s=>s.stage==='retire')!.outcome,'Done');assert.ok(u.endedAt);
 assert.deepEqual(d.waiting.rows.map(w=>[w.totalMs,w.reasons]),[[80000,[{reason:'Dependency',ms:80000}]]]);
 const rows=buildActivityIndex(e).entries.map(e=>e.row).filter(r=>r.kind==='stage-outcome');
 assert.equal(rows.filter(r=>r.housekeeping).length,4);assert.ok(rows.some(r=>/Release resources.*Cleanup failed/.test(r.summary.text)&&!r.housekeeping));
});
test('Activity filters housekeeping before paging, preserves failures, and validates its toggle',async t=>{
 const {serveConsole}=await import('../src/console/http.ts');const {gitCommonDir}=await import('../src/git/git.ts');const {absPath}=await import('../src/core/values.ts');const {CONSOLE_PROTOCOL}=await import('../src/observation/protocol.ts');
 const f=await round4Fixture();t.after(()=>f.close());
 for(let n=0;n<35;n++){const p=f.begin('u7','quiesce');f.journal.fact({kind:'stage-outcome',unit:p.unit,stage:'quiesce',attempt:p.attempt,outcome:'empty',class:'advance',chargeable:false});}
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const {consoleGet}=await import('./helpers/console-http.ts');
 const url=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/activity`;
 const page=async(query:string)=>(await(await consoleGet(url+query)).json() as {data:import('../src/console/activity-protocol.ts').ActivityView}).data;
 const ordinary=await page('?limit=25'),all=await page('?limit=25&housekeeping=1');assert.ok(ordinary.rows.some(r=>/Cleanup failed/.test(r.summary.text)));assert.ok(ordinary.rows.every(r=>!r.housekeeping));assert.equal(all.rows.length,25);assert.ok(all.rows.every(r=>r.housekeeping));assert.ok(all.page.next);
 const earlier=await page('?limit=25&housekeeping=1&cursor='+encodeURIComponent(all.page.next!));assert.ok(earlier.rows.some(r=>/Cleanup failed/.test(r.summary.text)));const originalThirty=[...all.rows,...earlier.rows].slice(0,30);assert.equal(originalThirty.length,30);assert.ok(originalThirty.every(r=>r.housekeeping));assert.equal((await fetch(url+'?housekeeping=maybe')).status,400);
 assert.equal((await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/activity-legacy`)).status,404);
});
