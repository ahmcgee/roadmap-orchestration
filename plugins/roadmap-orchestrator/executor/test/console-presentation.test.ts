import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ObservationCache } from '../src/observation/cache.ts';
import { consoleModel } from '../src/console/model.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
const read=(f:Awaited<ReturnType<typeof investigationFixture>>)=>new ObservationCache(f.hostDir,'presentation-test','reader').read({runDir:f.runDir,arc:f.arc});
test('recorded executor states become plain journeys, stage-local attempts, verdicts, spend and wait reasons',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=read(f),m=consoleModel(e),p=m.presentation;
 assert.equal(p.run.state,'Running');assert.equal(p.units.length,14);
 assert.equal(p.units.find(u=>u.id==='u3')!.state,'Running');assert.equal(m.graph.units.find(u=>u.id==='u3')!.status,'active');
 const u=p.units.find(u=>u.id==='u7')!;assert.equal(u.title,'Review edge cases');assert.equal(u.rounds,3);assert.equal(u.spend,2.25);assert.equal(u.redChecks,1);
 assert.deepEqual(u.journey.filter(s=>s.stage==='build').map(s=>[s.attempt,s.round,s.outcome]),[[1,1,'Succeeded'],[2,2,'Succeeded'],[3,3,'Succeeded']]);
 const review=u.journey.find(s=>s.stage==='gate')!;assert.equal(review.attempt,1);assert.equal(review.outcome,'Changes requested');assert.deepEqual(review.findingTitles,['Handle empty input before multiplying']);
 assert.deepEqual(u.reasons,['Baseline hold: baseline checks are failing']);assert.equal(u.waitSince,null,'admission wait starts are not invented');
 assert.deepEqual(p.units.find(u=>u.id==='u4')!.reasons,['Dependency on u3']);assert.deepEqual(p.units.find(u=>u.id==='u5')!.reasons,['Milestone MS-1 has not passed']);
 assert.match(p.units.find(u=>u.id==='u11')!.reasons.join(' '),/pressure/);assert.ok(p.units.find(u=>u.id==='u11')!.waitSince);assert.ok(p.units.find(u=>u.id==='u8')!.reasons.includes('Integration queue position 1'));
 assert.equal(p.units.find(u=>u.id==='u14')!.lineage?.reenters,'u12');assert.equal(p.units.find(u=>u.id==='u12')!.state,'Replaced');assert.equal(p.units.find(u=>u.id==='u13')!.state,'Withdrawn');
 assert.ok(p.feed.some(row=>row.text==='Review sent u7 back: Handle empty input before multiplying'));assert.ok(p.feed.some(row=>row.text==='Plan revision 2 applied'));assert.ok(p.feed.some(row=>row.text==='Question raised: Already answered request'));
 assert.equal(p.holistic.activeFindings[0]!.claim,'Document empty input behavior');assert.equal(p.holistic.audits.length,1);
});
test('CPU uses measured cores over the recorded reservation; missing historical waiting remains unmeasured',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const m=consoleModel(read(f));const cpu=m.cpu.find(row=>row.unit==='u1')!;
 assert.equal(cpu.reserved,4);assert.equal(cpu.average,0.2);assert.equal(Math.round(cpu.average!/cpu.reserved!*100),5);assert.equal(m.tokenOccupancy,4);
 assert.equal(m.time.unmeasuredReservations,1);assert.deepEqual(m.presentation.waitReasons,{'CPU capacity':1200,'CPU pressure':2300,'Memory pressure':3400,'Integration slot':4500,'Baseline hold':5600});
 const queued=m.resources.bookings.filter(b=>b.state==='waiting'&&b.resource==='integration-slot');assert.deepEqual(queued.map(b=>b.label),['u8','u9']);assert.ok(queued[0]!.from<queued[1]!.from);
});
test('retained reports in the presentation obey the recorded digest and evidence containment',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=read(f),path=join(f.runDir,'inv',f.review.routeId,'result.json'),original=readFileSync(path);
 const result=JSON.parse(original.toString());result.outcome.value.findings[0].title='Unrecorded tampering';writeFileSync(path,JSON.stringify(result));assert.throws(()=>consoleModel(e),/recorded digest/);
 writeFileSync(path,original);assert.equal(consoleModel(e).presentation.units.find(u=>u.id==='u7')!.journey.find(s=>s.stage==='gate')!.findingTitles[0],'Handle empty input before multiplying');
 unlinkSync(path);symlinkSync('/etc/passwd',path);assert.throws(()=>consoleModel(e));unlinkSync(path);writeFileSync(path,original);
});
test('completed header and schedule keep the recorded run end after hours of observer checks',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());f.finishLive();f.complete();const e=read(f),m=consoleModel(e),later=consoleModel({...e,checkedAt:new Date(Date.parse(e.checkedAt)+7*3600_000).toISOString()});
 assert.equal(m.presentation.run.state,'Complete');assert.ok(m.presentation.run.endedAt);assert.equal(later.resources.now,m.resources.now);assert.equal(later.presentation.run.elapsedMs,m.presentation.run.elapsedMs);
});
test('activity GET pages a long journal without overlap, in reverse recorded order',async t=>{
 const {serveConsole}=await import('../src/console/http.ts');const {gitCommonDir}=await import('../src/git/git.ts');const {absPath}=await import('../src/core/values.ts');const {CONSOLE_PROTOCOL}=await import('../src/observation/protocol.ts');
 const f=await investigationFixture();t.after(()=>f.close());for(let n=0;n<40;n++){const p=f.begin('u7','build');f.journal.fact({kind:'stage-outcome',unit:p.unit,stage:'build',attempt:p.attempt,outcome:'success',class:'advance',chargeable:false});}
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const page=async(offset:number)=>(await(await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/activity?offset=${offset}`)).json() as {data:{rows:{id:number;text:string}[];more:boolean}}).data;
 const a=await page(0),b=await page(30);assert.equal(a.rows.length,30);assert.equal(a.more,true);assert.ok(b.rows.length>0);assert.ok(a.rows.every((r,i)=>i===0||a.rows[i-1]!.id>r.id));assert.ok(a.rows.at(-1)!.id>b.rows[0]!.id);assert.ok(a.rows.every(r=>/Build — Succeeded/.test(r.text)));
 assert.equal((await page(10000)).more,false);assert.deepEqual((await page(10000)).rows,[]);
});

test('short human titles strip paths, identifiers and later clauses, retain prose, and bound long intents', async () => {
 const {shortUnitTitle}=await import('../src/console/presentation.ts');
 assert.equal(shortUnitTitle('Add secure sign in in `src/auth/sign_in.ts`; preserve all existing routes.'),'Add secure sign in in');
 assert.equal(shortUnitTitle('Render catalog cards using src/catalog/*.tsx and catalogItem. Keep sorting stable.'),'Render catalog cards using and');
 assert.equal(shortUnitTitle('Validate contract:identity/session: cookie checks and token refresh.'),'Validate cookie checks and token refresh');
 assert.equal(shortUnitTitle('`src/a.ts`','u42'),'u42');
 const title=shortUnitTitle('Provide consistent keyboard navigation across every account settings section and every nested form field in the application');
 assert.ok(title.length<=60);assert.ok(title.endsWith('…'));assert.doesNotMatch(title,/form field/);
 const f=await investigationFixture();try{const p=consoleModel(read(f)).presentation;assert.equal(p.units.find(u=>u.id==='u7')!.title,'Review edge cases');assert.ok(p.units.every(u=>typeof u.intent==='string'));}finally{f.close();}
});
