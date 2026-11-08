import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservationCache } from '../src/observation/cache.ts';
import { consoleModel } from '../src/console/model.ts';
import { cpuStageGroups, resourceQueue } from '../src/console/resources.ts';
import { mergeHistoryPages } from '../web-src/app/history-pages.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { invocationId, opId, jobId } from '../src/core/ids.ts';
import type { WorkRun } from '../src/status-work.ts';

test('Pass 0 uses recorded unit identity, CPU stage coverage, waiting counts and finding state',async t=>{
  const f=await investigationFixture();t.after(()=>f.close());
  const e=new ObservationCache(f.hostDir,'pass0','reader').read({runDir:f.runDir,arc:f.arc}),m=consoleModel(e);
  assert.equal(m.presentation.units.length,14);
  const unit=m.presentation.units.find(u=>u.id==='u7')!;
  assert.equal(unit.redChecks,1);assert.equal(unit.rounds,3);assert.equal(unit.spend,2.25);
  assert.equal(unit.spendCoverage.recorded,4);
  const cpu=m.cpuGroups.find(g=>g.parent.type==='stage'&&g.parent.unit==='u1')!;
  assert.equal(cpu.reservationPercent,5);assert.equal(cpu.averageCores,.2);assert.equal(cpu.reservedCores,4);
  assert.equal(cpu.measuredCalls,1);assert.equal(cpu.excludedCalls,0);
  assert.deepEqual(m.presentation.waitReasonCounts,{'CPU capacity':1,'CPU pressure':1,'Memory pressure':1,'Integration slot':1,'Baseline hold':1});
  assert.equal(m.time.unmeasuredReservations,1);
  assert.deepEqual(m.presentation.holistic.activeFindings.map(f=>[f.id,f.claim,f.state]),[['F-1','Document empty input behavior','open']]);
});

test('CPU groups weight matching calls and keep missing, zero-wall and over-reservation evidence explicit',async t=>{
  const f=await investigationFixture();t.after(()=>f.close());
  const e=new ObservationCache(f.hostDir,'cpu-math','reader').read({runDir:f.runDir,arc:f.arc});
  const base=e.data.display.status.units.flatMap(u=>u.work).find(w=>w.reservedCpu===4&&w.measured)!;
  const call=(n:number,reservedCpu:number|null,wallMs:number|null,runMs=0):WorkRun=>({...base,inv:invocationId(opId(f.arc,100000+n),1),reservedCpu,measured:wallMs===null?null:{wallMs,runMs,waitMs:99999}});
  const calls=[call(1,4,100,20),call(2,1,900,1800),call(3,null,1000,8000),call(4,4,0,0),call(5,4,null)];
  const [group]=cpuStageGroups(calls);
  assert.equal(group!.averageCores,1.82);assert.equal(group!.reservedCores,1.3);
  assert.equal(group!.reservationPercent,140,'do not average percentages, use demand, include unmatched reservations, or clamp above 100%');
  assert.equal(group!.measuredCalls,2);assert.equal(group!.excludedCalls,3);
  assert.equal(group!.unmeasuredCalls,1);assert.equal(group!.zeroWallCalls,1);assert.equal(group!.unreservedCalls,1);assert.equal(group!.unreservedAverageCores,8);
  assert.equal(group!.reservedCoreMs,1300);assert.equal(group!.runMs,1820);assert.equal(group!.wallMs,1000);
  assert.equal(group!.invocations.length,5);
  const missing=cpuStageGroups([call(1,4,null),call(2,4,0),call(3,null,100,50)])[0]!;
  assert.equal(missing.reservationPercent,null);assert.equal(missing.averageCores,null);assert.equal(missing.unreservedAverageCores,.5);
  assert.equal(cpuStageGroups([{...calls[0]!,parent:{type:'arc'}},{...calls[1]!,parent:{type:'job',job:jobId('audit',1)}},calls[0]!]).length,3,'Arc, job and stage parents stay separate');
});

test('resource queue preserves scheduler priority including unknown starts and non-age order',async t=>{
  const f=await investigationFixture();t.after(()=>f.close());
  const host=new ObservationCache(f.hostDir,'queue-order','reader').read({runDir:f.runDir,arc:f.arc}).data.display.status.host;
  const first=host.queue[0]!,second=host.queue[1]!;
  const queue=resourceQueue({...host,queue:[{...first,queuedAt:200},{...second,queuedAt:100}],jobQueue:[{holder:{type:'job',job:jobId('audit',1)},request:first.request,envBlocked:false}]});
  assert.deepEqual(queue.map(q=>q.label),['audit-1','u8','u9']);
  assert.equal(queue[0]!.queuedAt,undefined);assert.equal(queue[1]!.queuedAt,200);assert.equal(queue[2]!.queuedAt,100);
});

test('history page merges keep contiguous evidence, the correct cursor, and a bounded suffix',()=>{
  const page=(ids:number[],before:string|null,hasMore:boolean)=>({events:ids.map(n=>({id:String(n),text:`event ${n}`})),before,hasMore,state:'running'});
  const first=page([1,2,3],null,false),skipped=page([90,91,92],'90',true);
  assert.deepEqual(mergeHistoryPages(first,skipped),skipped,'a skipped live page cannot inherit Start of session');
  const joined=mergeHistoryPages(first,page([3,4,5],'3',true));
  assert.deepEqual(joined.events.map(e=>e.id),['1','2','3','4','5']);assert.equal(joined.before,null);assert.equal(joined.hasMore,false);
  const full=mergeHistoryPages(page(Array.from({length:190},(_,i)=>i+1),null,false),page(Array.from({length:50},(_,i)=>i+181),'181',true));
  assert.equal(full.events.length,200);assert.equal(full.events[0]!.id,'31');assert.equal(full.before,'31');assert.equal(full.hasMore,true);
});
