import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { ConsoleActivity } from '../src/console/activity-query.ts';
import { activityPage } from '../src/console/activity-page.ts';

test('selected Activity page keeps its exact review summary without sweeping other reports; selected bytes stay digest checked',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=new ObservationCache(f.hostDir,'activity-page','repo').read({runDir:f.runDir,arc:f.arc}),a=new ConsoleActivity();
 const page=activityPage(e,a,{}),review=page.rows.find(r=>r.stage==='gate'&&r.subject.id==='u7'&&r.outcome==='revise')!;
 assert.equal(review.summary.text,'Review sent u7 back: Handle empty input before multiplying');
 const path=join(f.runDir,'inv',f.review.routeId,'result.json'),bytes=readFileSync(path);writeFileSync(path,'{}');
 assert.doesNotThrow(()=>activityPage(e,a,{q:'Build'}),'a filtered page does not read the excluded review');
 assert.throws(()=>activityPage(e,a,{stage:'gate'}),/digest/);writeFileSync(path,bytes);
 assert.equal(activityPage(e,a,{stage:'gate'}).rows.find(r=>r.outcome==='revise')!.summary.text,review.summary.text);
});

test('relative-window changes count new matches after the frozen end while the page keeps its original range',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const cache=new ObservationCache(f.hostDir,'activity-relative','repo'),read=()=>cache.read({runDir:f.runDir,arc:f.arc}),e=read(),a=new ConsoleActivity(),query={window:'24h',stage:'build'};
 const initial=a.page(e,query);
 const p=f.begin('u7','build');f.journal.fact({kind:'stage-outcome',unit:p.unit,stage:'build',attempt:p.attempt,outcome:'success',class:'advance',chargeable:false});
 const later=read();assert.equal(a.changes(later,{...query,anchor:initial.page.anchor}).newMatching,1);
 assert.deepEqual(initial.filters.to,e.checkedAt);assert.equal(initial.page.asOf.highWater,e.highWater);
});
