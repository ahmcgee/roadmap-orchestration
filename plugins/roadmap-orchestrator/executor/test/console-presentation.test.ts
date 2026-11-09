import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ObservationCache } from '../src/observation/cache.ts';
import { unitView } from '../src/console/details.ts';
import type { UnitView } from '../src/console/detail-protocol.ts';
import { graphView, shellView, arcBounds } from '../src/console/views.ts';
import { effortRows, resourceNow, waitingMeasurements, holisticSummaries } from '../src/console/tab-projections.ts';
import { ConsoleActivity } from '../src/console/activity-query.ts';
import { activityPage } from '../src/console/activity-page.ts';
import { reasonWords } from '../src/console/vocabulary.ts';
const detail=(e:ReturnType<typeof read>,id:string)=>unitView(e,id) as UnitView;
import { investigationFixture } from './fixtures/console-investigations.ts';
const read=(f:Awaited<ReturnType<typeof investigationFixture>>)=>new ObservationCache(f.hostDir,'presentation-test','reader').read({runDir:f.runDir,arc:f.arc});
test('recorded executor states become plain journeys, stage-local attempts, verdicts, spend and wait reasons',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=read(f),shell=shellView(e),graph=graphView(e);
 assert.equal(shell.lifecycle.state,'running');assert.equal(graph.units.length,14);
 assert.equal(detail(e,'u3').unit.state,'Running');assert.equal(graph.units.find(u=>u.id==='u3')!.signal,'active');
 const d=detail(e,'u7'),u=d.unit,effort=effortRows(e).find(u=>u.subject.id==='u7')!;
 assert.equal(u.title,'Implement the stated acceptance');assert.ok(d.acceptance.rows.includes('Review edge cases'),'acceptance stays available separately from the intent title');assert.equal(u.rounds,3);assert.equal(u.spend.costUsd,2.25);assert.equal(effort.lifetime.redChecks,1);
 assert.deepEqual(d.journey.rows.filter(s=>s.stage==='build').map(s=>[s.attempt,s.round,s.outcome]),[[1,1,'Succeeded'],[2,2,'Succeeded'],[3,3,'Succeeded']]);
 const review=d.journey.rows.find(s=>s.stage==='gate')!;assert.equal(review.attempt,1);assert.equal(review.outcome,'Changes requested');assert.deepEqual(review.findingTitles,['Handle empty input before multiplying']);
 assert.deepEqual(u.reasons,['Baseline hold: baseline checks are failing']);assert.equal(u.waitSince,null,'admission wait starts are not invented');
 assert.deepEqual(detail(e,'u4').unit.reasons,['Dependency on u3']);assert.deepEqual(detail(e,'u5').unit.reasons,['Milestone MS-1 has not passed']);
 assert.match(detail(e,'u11').unit.reasons.join(' '),/pressure/);assert.ok(detail(e,'u11').unit.waitSince);assert.ok(detail(e,'u8').unit.reasons.includes('Integration queue position 1'));
 assert.equal(detail(e,'u14').unit.lineage?.reenters,'u12');assert.equal(detail(e,'u12').unit.state,'Replaced');assert.equal(detail(e,'u13').unit.state,'Withdrawn');
 const activity=new ConsoleActivity();let page=activityPage(e,activity,{limit:'25',window:'arc'}),rows=[...page.rows];while(page.page.next){page=activityPage(e,activity,{limit:'25',window:'arc',cursor:page.page.next});rows.push(...page.rows);}
 assert.equal(rows.length,page.page.matching);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
 assert.ok(rows.some(row=>row.summary.text==='Review sent u7 back: Handle empty input before multiplying'));assert.ok(rows.some(row=>row.summary.text==='Plan revision 2 applied'));assert.ok(rows.some(row=>row.summary.text==='Question raised: Already answered request'));
 const holistic=holisticSummaries(e);assert.equal(holistic.find(r=>r.type==='finding')!.claim.text,'Document empty input behavior');assert.equal(holistic.filter(r=>r.type==='audit').length,1);
});
test('CPU uses measured cores over the recorded reservation; missing historical waiting remains unmeasured',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=read(f),work=e.data.display.status.units.find(u=>u.unit==='u1')!.work.find(w=>w.measured)!;
 const reserved=work.reservedCpu!,average=work.measured!.runMs/work.measured!.wallMs,now=resourceNow(e),waiting=waitingMeasurements(e);
 assert.equal(reserved,4);assert.equal(average,0.2);assert.equal(Math.round(average/reserved*100),5);assert.equal(now.cpuReservation!.used,4);
 assert.equal(waiting.unmeasuredReservations,1);assert.deepEqual(Object.fromEntries(waiting.rows.flatMap(w=>w.reasons).map(r=>[reasonWords(r.reason),r.ms])),{'CPU capacity':1200,'CPU pressure':2300,'Memory pressure':3400,'Integration slot':4500,'Baseline hold':5600});
 const queued=now.queues.filter(q=>q.publication);assert.deepEqual(queued.map(b=>b.unitId),['u8','u9']);assert.ok(Date.parse(queued[0]!.queuedAt!)<Date.parse(queued[1]!.queuedAt!));
});
test('retained reports in the presentation obey the recorded digest and evidence containment',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=read(f),path=join(f.runDir,'inv',f.review.routeId,'result.json'),original=readFileSync(path);
 const result=JSON.parse(original.toString());result.outcome.value.findings[0].title='Unrecorded tampering';writeFileSync(path,JSON.stringify(result));assert.throws(()=>detail(e,'u7'),/recorded digest/);
 writeFileSync(path,original);assert.equal(detail(e,'u7').journey.rows.find(s=>s.stage==='gate')!.findingTitles[0],'Handle empty input before multiplying');
 unlinkSync(path);symlinkSync('/etc/passwd',path);assert.throws(()=>detail(e,'u7'));unlinkSync(path);writeFileSync(path,original);
});
test('completed header and schedule keep the recorded run end after hours of observer checks',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());f.finishLive();f.complete();const e=read(f),later={...e,checkedAt:new Date(Date.parse(e.checkedAt)+7*3600_000).toISOString()},shell=shellView(e),bounds=arcBounds(e);
 assert.equal(shell.lifecycle.state,'complete');assert.ok(shell.lifecycle.endedAt);assert.equal(arcBounds(later).to,bounds.to);assert.equal(Date.parse(shellView(later).lifecycle.endedAt!)-Date.parse(shellView(later).lifecycle.startedAt!),Date.parse(shell.lifecycle.endedAt!)-Date.parse(shell.lifecycle.startedAt!));
});
test('activity GET pages a long journal without overlap, in reverse recorded order',async t=>{
 const {serveConsole}=await import('../src/console/http.ts');const {gitCommonDir}=await import('../src/git/git.ts');const {absPath}=await import('../src/core/values.ts');const {CONSOLE_PROTOCOL}=await import('../src/observation/protocol.ts');
 const f=await investigationFixture();t.after(()=>f.close());for(let n=0;n<40;n++){const p=f.begin('u7','build');f.journal.fact({kind:'stage-outcome',unit:p.unit,stage:'build',attempt:p.attempt,outcome:'success',class:'advance',chargeable:false});}
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const {consoleGet}=await import('./helpers/console-http.ts');
 const url=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/activity?limit=25`;
 const page=async(cursor?:string)=>(await(await consoleGet(url+(cursor?'&cursor='+encodeURIComponent(cursor):''))).json() as {epoch:string;highWater:number;data:import('../src/console/activity-protocol.ts').ActivityView});
 const first=await page(),second=await page(first.data.page.next!),a=first.data,b=second.data;
 assert.equal(a.rows.length,25);assert.ok(a.page.next);assert.ok(b.rows.length>0);
 assert.ok(a.rows.every((r,i)=>i===0||a.rows[i-1]!.seq>r.seq));assert.ok(a.rows.at(-1)!.seq>b.rows[0]!.seq);assert.ok(a.rows.every(r=>/Build — Succeeded/.test(r.summary.text)));
 const originalThirty=[...a.rows,...b.rows].slice(0,30);assert.equal(originalThirty.length,30);assert.ok(originalThirty.every((r,i)=>i===0||originalThirty[i-1]!.seq>r.seq));assert.ok(originalThirty.every(r=>/Build — Succeeded/.test(r.summary.text)));
 const ids=[...a.rows,...b.rows].map(r=>r.id);let last=b;
 while(last.page.next){last=(await page(last.page.next)).data;ids.push(...last.rows.map(r=>r.id));}
 assert.equal(new Set(ids).size,ids.length);assert.equal(ids.length,a.page.matching);assert.equal(last.page.next,null);
 const empty=(await(await consoleGet(`${url}&afterSeq=${first.highWater}&epoch=${encodeURIComponent(first.epoch)}`)).json() as {data:import('../src/console/activity-protocol.ts').ActivityView}).data;
 assert.equal(empty.page.next,null);assert.deepEqual(empty.rows,[]);
});

test('short human titles strip paths, identifiers and later clauses, retain prose, and bound long intents', async () => {
 const {shortUnitTitle}=await import('../src/console/vocabulary.ts');
 assert.equal(shortUnitTitle('Add secure sign in in `src/auth/sign_in.ts`; preserve all existing routes.'),'Add secure sign in in');
 assert.equal(shortUnitTitle('Render catalog cards using src/catalog/*.tsx and catalogItem. Keep sorting stable.'),'Render catalog cards using and');
 assert.equal(shortUnitTitle('Validate contract:identity/session: cookie checks and token refresh.'),'Validate cookie checks and token refresh');
 assert.equal(shortUnitTitle('`src/a.ts`','u42'),'u42');
 const title=shortUnitTitle('Provide consistent keyboard navigation across every account settings section and every nested form field in the application');
 assert.ok(title.length<=96);assert.match(title,/^Provide consistent/);assert.ok(title.endsWith('…'));assert.equal(title.indexOf('…'),title.length-1,'long actions are only elided at the tail');
 const f=await investigationFixture();try{const e=read(f);assert.equal(detail(e,'u7').unit.title,'Implement the stated acceptance');assert.ok(e.data.display.status.units.every(u=>typeof detail(e,u.unit).intent.text==='string'));}finally{f.close();}
});

 test('short titles preserve distinguishing subjects after long shared prefixes',async()=>{
 const {shortUnitTitle}=await import('../src/console/vocabulary.ts');
 const titles=['catalog','billing','search'].map(subject=>shortUnitTitle(`Implement optimistic concurrency checks for the ${subject} service`));
 assert.equal(new Set(titles).size,3);
 for(const [i,title] of titles.entries()){assert.ok(title.length<=96);assert.ok(title.endsWith(`${['catalog','billing','search'][i]} service`));}
 const short='Implement optimistic concurrency checks for the catalog';
 assert.equal(shortUnitTitle(short),short,'a complete title inside the budget has no ellipsis');
 });

test('three-line title budget preserves the full action, system and slice',async()=>{
 const {shortUnitTitle}=await import('../src/console/vocabulary.ts');
 for(const system of ['analytics','catalog','notifications']){
  const title=`Implement optimistic concurrency checks for the ${system} system, slice 167`;
  assert.equal(shortUnitTitle(title+'. Read src/service.ts before editing.'),title);
 }
});

test('an explicit intent heading preserves a human title and its domain terms',async()=>{
  const { shortUnitTitle } = await import('../src/console/vocabulary.ts');
  assert.equal(shortUnitTitle('# Validate sign-up payloads before persistence\n\nValidate src/identity/signup.ts.'),'Validate sign-up payloads before persistence');
  const long=shortUnitTitle(`# ${'Tenant-scoped rollout checks '.repeat(10)}\n\nDetails.`);
  assert.ok(long.length<=96);assert.ok(long.endsWith('…'));
});
