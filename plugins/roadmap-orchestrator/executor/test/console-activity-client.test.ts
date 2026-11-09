import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleFixture } from './fixtures/console.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { ConsoleActivity } from '../src/console/activity-query.ts';
import { ConsoleMetadata } from '../src/console/metadata.ts';
import { ConsoleViews } from '../src/console/views.ts';
const {ViewStore}=await import(new URL('../web-src/app/view-store.ts',import.meta.url).href);
const {activityParams,dayRange,shiftDay}=await import(new URL('../web-src/app/activity-query.ts',import.meta.url).href);
test('Activity calendar navigation uses actual IANA day boundaries, including short/long DST days',()=>{
 assert.deepEqual(dayRange('2026-03-08','America/New_York'),{from:'2026-03-08T05:00:00.000Z',to:'2026-03-09T04:00:00.000Z'});
 assert.deepEqual(dayRange('2026-11-01','America/New_York'),{from:'2026-11-01T04:00:00.000Z',to:'2026-11-02T05:00:00.000Z'});
 assert.deepEqual(dayRange('2026-11-09','UTC'),{from:'2026-11-09T00:00:00.000Z',to:'2026-11-10T00:00:00.000Z'});
 assert.equal(shiftDay('2026-12-31',1),'2027-01-01');assert.throws(()=>dayRange('2026-02-30','UTC'));assert.throws(()=>dayRange('2011-12-30','Pacific/Apia'));
 assert.deepEqual([...activityParams(new URLSearchParams('q=Build&cursor=opaque&view=events'))],[['q','Build'],['window','24h'],['zone','UTC']]);
});
test('Activity pages remain frozen through notices and cached Back; refresh and schema refusal are explicit',async()=>{
 const f=consoleFixture(),e=new ObservationCache(f.hostDir,'activity-client','repo').read({runDir:f.runDir,arc:f.arc});
 const notice=new ConsoleMetadata().read(e,new ConsoleViews(),e.arc),activity=new ConsoleActivity(),page=activity.page(e,{});let reads=0;
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>{reads++;return {...e,data:page};});store.notice(notice);
 const path='activity?window=arc';await store.load(path);const before=store.entry(path).value;
 store.notice({...notice,highWater:e.highWater+1,revision:e.revision+1,viewVersions:{...notice.viewVersions,activity:'f'.repeat(64)}});
 await store.load(path);assert.equal(reads,1);assert.equal(store.entry(path).value,before);
 // A manual reload has to be admitted at the new prefix and validated as Activity.
 store.read=async()=>({...e,highWater:e.highWater+1,revision:e.revision+1,data:{...page,raw:{events:[]}}});await store.load(path,true);
 assert.match(store.entry(path).error,/Malformed/);assert.equal(store.entry(path).value,before);assert.equal(store.reload,true);
});
