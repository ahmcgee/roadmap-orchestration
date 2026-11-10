import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservationCache } from '../src/observation/cache.ts';
import { statusBytes, ConsoleError, type Envelope } from '../src/observation/protocol.ts';
import { ConsoleTemporal } from '../src/console/temporal-query.ts';
import { ConsoleActivity } from '../src/console/activity-query.ts';
import { CollectionPages, COLLECTION_RETENTION } from '../src/console/collection-pages.ts';
import { timelineIntervals } from '../src/console/tab-projections.ts';
import { unitSignal } from '../src/console/signals.ts';
import { timelineShape, intervalsShape, holdsShape, holisticShape } from '../src/console/view-shapes.ts';
import { intersects, instant } from '../src/console/query-params.ts';
import type { TimelineView, IntervalsView } from '../src/console/temporal-protocol.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { absPath } from '../src/core/values.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { consoleGet } from './helpers/console-http.ts';
const capture=(f:Awaited<ReturnType<typeof investigationFixture>>)=>new ObservationCache(f.hostDir,'temporal','repo').read({runDir:f.runDir,arc:f.arc});
function noMonolith(value:unknown){if(!value||typeof value!=='object')return;for(const [key,v] of Object.entries(value)){assert.ok(!['events','display','plan','body','report','raw','capture','transcript','console'].includes(key),key);noMonolith(v);}}

test('Timeline independent tracks and exact intervals reconcile at their captured window; Holistic sections retain evidence',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),before=[statusBytes(e,false),statusBytes(e,true)],tabs=new ConsoleTemporal(),activity=new ConsoleActivity();
 const tracks=tabs.timeline(e,{window:'arc'}) as TimelineView;assert.ok(timelineShape(tracks));noMonolith(tracks);
 const exact=tabs.timeline(e,{window:'arc'},'intervals') as IntervalsView;assert.ok(intervalsShape(exact));noMonolith(exact);
 assert.equal(tracks.rows.reduce((n,r)=>n+r.intervalCount,0),timelineIntervals(e).length);
 assert.equal(exact.page.matching,timelineIntervals(e).length);assert.equal(tracks.rows.find(r=>r.subject.id==='u7')!.intervalCount,5);
 const u7=tabs.timeline(e,{window:'arc',subject:'unit:u7'},'intervals') as IntervalsView;
 assert.deepEqual(u7.rows.filter(r=>r.stage==='build').map(r=>[r.attempt,r.round]),[[1,1],[2,2],[3,3]]);
 assert.equal(u7.rows.find(r=>r.stage==='build')!.endedAt,timelineIntervals(e).find(r=>r.id===u7.rows.find(r=>r.stage==='build')!.id)!.endedAt);
 assert.ok(holdsShape(tabs.timeline(e,{window:'arc'},'holds')));
 // The overview is the whole Arc whatever the window: every run counted once, slices aligned to the recorded range.
 const all=timelineIntervals(e),firstStart=all.map(i=>i.startedAt).sort()[0]!,narrowFrom=u7.rows[0]!.startedAt;
 const narrow=tabs.timeline(e,{from:narrowFrom,to:new Date(Date.parse(narrowFrom)+60_000).toISOString()}) as TimelineView;assert.ok(timelineShape(narrow));
 for(const view of [tracks,narrow]){const o=view.overview;assert.equal(o.buckets.reduce((n,b)=>n+b.count,0),all.length);assert.ok(Date.parse(o.range.from)<=Date.parse(firstStart));assert.ok(o.buckets.every(b=>(Date.parse(b.from)-Date.parse(o.range.from))%o.range.widthMs===0));}
 assert.ok(narrow.rows.length<tracks.rows.length,'tracks follow the window; the overview does not');
 const u7track=tracks.rows.find(r=>r.subject.id==='u7')!,u7state=e.data.display.status.units.find(u=>u.unit==='u7')!.state;assert.equal(u7track.state,u7state);assert.equal(u7track.signal,unitSignal(u7state));
 assert.ok(tracks.rows.filter(r=>r.subject.type!=='unit').every(r=>r.signal===null&&r.state===null),'jobs and Arc-wide runs have no unit state');
 for(const section of ['audits','findings','decisions']){const h=tabs.holistic(e,{section});assert.ok(holisticShape(h));noMonolith(h);assert.equal(h.section,section);assert.equal(h.counts.findings,1);assert.equal(h.enabled,true);if(section==='audits'){const r=h.rows[0]!;assert.equal(r.type,'audit');if(r.type==='audit'){assert.equal(r.findingCount,1);assert.match(r.detail.id,/-audit-ended$/);assert.ok(activity.index(e).entries.some(e=>e.row.id===r.detail.id));}}if(section==='findings'){const r=h.rows[0]!;assert.equal(r.type,'finding');if(r.type==='finding'){assert.deepEqual([r.id,r.claim.text,r.state],['F-1','Document empty input behavior','open']);assert.ok(r.detail);assert.deepEqual(r.claim.detail,r.detail);assert.ok(activity.index(e).entries.some(e=>e.row.id===r.detail!.id));}}}
 const decisions=tabs.holistic(e,{section:'decisions'});for(const r of decisions.rows)if(r.type==='decision'){assert.deepEqual(r.oneLine.detail,r.detail);if(r.detail)assert.ok(activity.index(e).entries.some(e=>e.row.id===r.detail!.id));}
 const missingDecisionSource={...e,data:{...e.data,display:{...e.data.display,status:{...e.data.display.status,decisionsSince:e.data.display.status.decisionsSince.map(d=>({...d,seq:(e.highWater+10) as typeof d.seq,oneLine:d.oneLine.repeat(30)}))}}}};
 const unknown=tabs.holistic(missingDecisionSource,{section:'decisions'});assert.ok(holisticShape(unknown));for(const r of unknown.rows)if(r.type==='decision'){assert.equal(r.at,null);assert.equal(r.detail,null);assert.equal(r.oneLine.detail,null);assert.equal(r.oneLine.truncated,true);assert.ok(r.oneLine.field);let full='',after=0;for(;;){const field=tabs.field(missingDecisionSource,r.oneLine.field!.key,{after:String(after)});assert.equal(field.offset,after);full+=field.text;if(field.next===null)break;after=field.next;}assert.equal(full,missingDecisionSource.data.display.status.decisionsSince.find(d=>d.id===r.recordId)!.oneLine);}
 const disabled={...e,data:{...e.data,display:{...e.data.display,status:{...e.data.display.status,holistic:false}}}};
 assert.equal(tabs.holistic(disabled,{}).enabled,false);
 assert.deepEqual([statusBytes(e,false),statusBytes(e,true)],before);
 assert.equal(timelineShape({...tracks,events:[]}),false);assert.equal(intervalsShape({...exact,rows:[{...exact.rows[0],body:'no'}]}),false);
 const h=tabs.holistic(e,{});assert.equal(holisticShape({...h,uiSchema:999}),false);
});

test('immutable keysets retain complete ordering, values, previous pages and asOf; foreign, changed, expired and evicted cursors refuse',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),pages=new CollectionPages();
 const rows=Array.from({length:73},(_,n)=>({id:`id-${n}`,value:73-n})),context={recorded:'captured'};
 const first=pages.page(e,'ranking',{sort:'descending'},25,undefined,()=>({rows,context}));
 rows[0]!.value=999;context.recorded='new';
 const newer={...e,highWater:e.highWater+1,revision:e.revision+1,observedAt:'2026-11-09T23:00:00.000Z'};
 const second=pages.page<(typeof rows)[number], typeof context>(newer,'ranking',{sort:'descending'},25,first.page.next!,()=>{throw Error('must not rebuild');});
 const previous=pages.page<(typeof rows)[number], typeof context>(newer,'ranking',{sort:'descending'},25,second.page.previous!,()=>{throw Error('must not rebuild');});
 assert.deepEqual(previous.rows,first.rows);assert.equal(previous.rows[0]!.value,73);assert.equal(previous.recorded,'captured');assert.deepEqual(second.page.asOf,first.page.asOf);
 const all=[...first.rows,...second.rows];let page=second;
 while(page.page.next){page=pages.page<(typeof rows)[number], typeof context>(newer,'ranking',{sort:'descending'},25,page.page.next,()=>{throw Error();});all.push(...page.rows);}
 assert.equal(all.length,73);assert.equal(new Set(all.map(r=>r.id)).size,73);assert.equal(page.page.next,null);
 for(const [env,query,cursor] of [[{...e,epoch:'foreign'},{sort:'descending'},first.page.next],[e,{sort:'ascending'},first.page.next],[e,{sort:'descending'},first.page.next+'x']] as const)assert.throws(()=>pages.page(env,'ranking',query,25,cursor!,()=>({rows,context})),(err:unknown)=>err instanceof ConsoleError&&err.code==='invalid');
 for(let n=0;n<COLLECTION_RETENTION.queries;n++)pages.page(e,'other',{n},25,undefined,()=>({rows,context}));
 assert.throws(()=>pages.page(e,'ranking',{sort:'descending'},25,first.page.next!,()=>({rows,context})),/expired/);
 const frozen=pages.page(e,'expiry',{},25,undefined,()=>({rows,context})),original=Date.now;t.mock.method(Date,'now',()=>original()+COLLECTION_RETENTION.idleMs+1);
 assert.throws(()=>pages.page(e,'expiry',{},25,frozen.page.next!,()=>({rows,context})),/expired/);
});

test('Timeline windows use actual overlaps, point records and strict RFC3339; filter enums and contradictory parameters refuse',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const e=capture(f),tabs=new ConsoleTemporal();
 const a='2026-11-01T00:00:00.000Z',b='2026-11-02T00:00:00.000Z',c='2026-11-03T00:00:00.000Z';
 assert.equal(intersects(a,c,b,c,c),true);assert.equal(intersects(a,b,b,c,c),false);assert.equal(intersects(b,b,b,c,c),true);assert.equal(intersects(c,c,b,c,c),false);assert.equal(intersects(a,null,b,c,c),true);
 for(const value of ['2026-02-30T00:00:00Z','2026-01-01','2026-01-01T24:00:00Z','2026-01-01T00:00:00+24:00'])assert.throws(()=>instant(value),/range/);
 assert.equal(instant('2024-02-29T00:00:00+01:00'),'2024-02-28T23:00:00.000Z');
 for(const params of [{limit:'0'},{limit:'200'},{from:b,to:a},{from:a,window:'arc'},{zone:'Mars/Base'},{unit:'u999'},{unit:'u1,u1'},{state:'invented'},{execution:'human'},{subject:'unit:u7'},{q:'x'.repeat(201)},{surprise:'1'}])assert.throws(()=>tabs.timeline(e,params as Record<string,string>),ConsoleError);
 assert.throws(()=>tabs.timeline(e,{window:'arc',subject:'unit:not-real'},'intervals'),/subject/);
 assert.throws(()=>tabs.timeline(e,{unit:'u7'},'holds'),/only time/);
 assert.throws(()=>tabs.holistic(e,{section:'invented'}),/section/);
 const unit=timelineIntervals(e).find(i=>i.subject.id==='u7')!,from=new Date(Date.parse(unit.startedAt)+1).toISOString();
 const overlapping=tabs.timeline(e,{from,to:new Date(Date.parse(unit.endedAt!)+1).toISOString(),subject:'unit:u7'},'intervals') as IntervalsView;
 assert.ok(overlapping.rows.some(i=>i.id===unit.id),'interval starting before window remains visible');
 const shifted={...e,checkedAt:new Date(Date.parse(e.checkedAt)+86400_000).toISOString()};
 const anchored=tabs.timeline(e,{window:'arc',limit:'25'},'intervals') as IntervalsView;
 if(anchored.page.next){const continued=tabs.timeline(shifted,{window:'arc',limit:'25',cursor:anchored.page.next},'intervals') as IntervalsView;assert.deepEqual(continued.bounds,anchored.bounds);assert.deepEqual(continued.scope,anchored.scope);}
});

test('Timeline and Holistic HTTP preserve admission, GET/HEAD/security, strict filters and no adapter dispatch',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
 for(const [path,shape] of [['timeline?window=arc',timelineShape],['timeline/intervals?window=arc',intervalsShape],['timeline/holds?window=arc',holdsShape],['holistic?section=findings',holisticShape]] as const){const r=await consoleGet(`${base}/${path}`);assert.equal(r.status,200,await r.clone().text());const raw=await r.json() as Envelope<unknown>;assert.equal(shape(raw.data),true);noMonolith(raw.data);assert.match(r.headers.get('cache-control')!,/no-store/);const head=await fetch(`${base}/${path}`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.ok(head.headers.get('content-security-policy'));}
 for(const path of ['timeline?unit=u1&unit=u2','timeline?limit=200','timeline?sort=invented','timeline?cursor=forged','timeline/intervals?subject=unit%3Au999','holistic?section=other','holistic?from=2026-01-01']){const r=await consoleGet(`${base}/${path}`);assert.equal(r.status,400,`${path}: ${await r.text()}`);}
 const wrong=await consoleGet(`${base}/timeline?epoch=wrong`);assert.equal(wrong.status,409);
 const current=await (await consoleGet(`${base}/shell`)).json() as Envelope<unknown>;
 const future=await consoleGet(`${base}/holistic?minHighWater=${current.highWater+1}`);assert.equal(future.status,503);
});

test('source-less oversized Holistic text retains exact Unicode through bounded identity-scoped field reads',async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const original=capture(f),tabs=new ConsoleTemporal(),s=original.data.display.status;
 const long='Recorded source-less text \\u0000 \\" 🛰️ <script>\n'.repeat(10000);
 assert.ok(s.decisionsSince.length>0);
 const e={...original,data:{...original.data,display:{...original.data.display,status:{...s,decisionsSince:s.decisionsSince.map(d=>({...d,seq:(original.highWater+10) as typeof d.seq,oneLine:long}))}}}};
 const page=tabs.holistic(e,{section:'decisions'});assert.ok(holisticShape(page));assert.ok(Buffer.byteLength(JSON.stringify({...e,data:page}))+1<=64*1024);
 const row=page.rows[0]!;assert.equal(row.type,'decision');if(row.type!=='decision')throw Error();assert.equal(row.at,null);assert.equal(row.detail,null);assert.equal(row.oneLine.detail,null);assert.ok(row.oneLine.field);assert.equal(row.oneLine.truncated,true);
 let text='',after=0,reads=0;for(;;){const field=tabs.field(e,row.oneLine.field.key,{after:String(after)});assert.equal(field.offset,after);assert.ok(Buffer.byteLength(JSON.stringify({...e,data:field}))+1<=16*1024);text+=field.text;reads++;if(field.next===null)break;after=field.next;}assert.equal(text,long);assert.ok(reads>100);
 assert.throws(()=>tabs.field({...e,epoch:'other'},row.oneLine.field!.key,{}),/no longer retained/);
 assert.throws(()=>tabs.field(e,row.oneLine.field!.key,{after:String(long.length+1)}),/exceeds/);
 assert.throws(()=>tabs.field(e,row.oneLine.field!.key,{after:'-1'}),/offset/);
 assert.throws(()=>tabs.field(e,row.oneLine.field!.key,{path:'/tmp/arbitrary'}),/unknown/);
});
