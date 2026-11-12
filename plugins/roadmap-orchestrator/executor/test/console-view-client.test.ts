import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleFixture } from './fixtures/console.ts';
import { Observations } from './helpers/observations.ts';
import { shellView, graphView } from '../src/console/views.ts';
import { ConsoleMetadata } from '../src/console/metadata.ts';
import { ConsoleViews } from '../src/console/views.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
const {ViewStore,lagState}=await import(new URL('../web-src/app/view-store.ts',import.meta.url).href);
function fixture(){const f=consoleFixture(),e=new Observations(f.hostDir,'client','repo').read({runDir:f.runDir,arc:f.arc});return {e,notice:new ConsoleMetadata().read(e,new ConsoleViews(),e.arc)};}
test('initial semantic notice coalesces pending reads; heartbeat and cached Back need no fetch',async()=>{
 const {e,notice}=fixture();let finish:(v:unknown)=>void=()=>{},count=0;
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>{count++;return new Promise(r=>finish=r);});
 const pending=store.load('graph');store.notice({...notice,revision:notice.revision+2});const duplicate=store.load('graph');
 finish({...e,data:graphView(e)});await Promise.all([pending,duplicate]);
 assert.equal(count,1);assert.equal(store.entry('graph').value.data.units.length,3);
 assert.equal(store.identity.revision,notice.revision+2,'a clock-only newer notice remains the watermark');
 store.notice({...notice,revision:notice.revision+3,checkedAt:new Date(Date.parse(notice.checkedAt)+1000).toISOString()});
 await store.load('graph');assert.equal(count,1);assert.equal(store.entry('graph').error,'');
});
test('reset aborts obsolete work; prior-instance responses and responses older than the view\'s own content never replace it',async()=>{
 const {e,notice}=fixture();let finish:(v:unknown)=>void=()=>{};
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>new Promise(r=>finish=r));
 const task=store.load('shell');store.notice({...notice,instance:'new-instance'},true);finish({...e,data:shellView(e)});await task;
 assert.equal(store.entry('shell').value,null);assert.equal(store.identity.instance,'new-instance');
 assert.throws(()=>store.notice(notice),/conflict/);
 // dev.71: a view a capture behind the notices is shown (T6); one behind the view's own content is not.
 store.read=async()=>({...e,instance:'new-instance',data:shellView(e)});await store.load('shell');
 const shown=store.entry('shell').value;assert.equal(shown.highWater,e.highWater);
 store.read=async()=>({...e,instance:'new-instance',highWater:e.highWater-1,data:shellView(e)});
 await store.load('shell',true);assert.match(store.entry('shell').error,/Overtaken/);assert.equal(store.entry('shell').value,shown);
});
test('client validates route-specific allowlists, UI schema and entity identity',async()=>{
 const {e,notice}=fixture();let value:any={...e,data:{...shellView(e),raw:{events:[]}}};
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>value);store.notice(notice);await store.load('shell');
 assert.equal(store.reload,true);assert.match(store.entry('shell').error,/Malformed/);assert.equal(store.entry('shell').value,null);
 value={...e,arc:'foreign',data:shellView(e)};await store.load('shell',true);assert.match(store.entry('shell').error,/identity/);
 assert.throws(()=>store.notice({...notice,uiSchema:999}),/schema/);
});

test('a semantic change during a pending read coalesces into one follow-up for the mounted route',async()=>{
 const {e,notice}=fixture(),old=graphView(e),next={...old,viewVersion:'f'.repeat(64)};let finish:(v:unknown)=>void=()=>{},count=0;
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>{count++;return count===1?new Promise(r=>finish=r):{...e,revision:e.revision+1,data:next};});
 store.active.set('graph',1);store.notice(notice);const task=store.load('graph');
 store.notice({...notice,revision:notice.revision+1,viewVersions:{...notice.viewVersions,graph:next.viewVersion}});
 const duplicate=store.load('graph');finish({...e,data:old});await Promise.all([task,duplicate]);if(store.entry('graph').task)await store.entry('graph').task;
 assert.equal(count,2);assert.equal(store.entry('graph').value.data.viewVersion,next.viewVersion);
});

test('route and return caches bound inactive data and clear detail state on epoch reset',async()=>{
 const {e,notice}=fixture(),store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>({...e,data:{}}));
 for(let n=0;n<90;n++){store.ui.set(`detail:units/u${n}`,{text:'recorded text'.repeat(10000)});store.trimUi();}
 assert.ok(store.ui.size<=64);assert.ok([...store.ui.values()].reduce((n:number,v:unknown)=>n+JSON.stringify(v).length*2,0)<=4*1024*1024);
 store.ui.set('effort.sort',{key:'redChecks',descending:true});store.ui.set('scroll:route',500);store.ui.set('disclosures:route',{Journey:true});
 store.notice(notice);store.notice({...notice,epoch:'replacement'},true);
 assert.equal([...store.ui.keys()].some((k:string)=>/^(detail:|scroll:|disclosures:)/.test(k)),false);
 assert.deepEqual(store.ui.get('effort.sort'),{key:'redChecks',descending:true});
});

test('T5: the lag and the connection come from pulses in the browser\'s own clock; the line shows past 5 s and clears under 2 s',async t=>{
 const {e,notice}=fixture(),store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>({}));
 // The browser's clock is 30 s ahead of the server's: only the pulse's age counts, measured where it was received.
 const real=Date.now(),skew=30_000;t.mock.method(Date,'now',()=>real+skew);
 store.connected=true;store.opened=true;store.notice(notice);
 const pulse=(asOfAgeMs:number)=>store.pulse({arc:e.arc,asOfAgeMs,behind:asOfAgeMs>0});
 pulse(800);assert.deepEqual(lagState(store,real+skew),{connection:'connected',lag:{shown:false,ageMs:800}});
 pulse(6_000);assert.deepEqual(lagState(store,real+skew).lag,{shown:true,ageMs:6_000});
 pulse(3_000);assert.equal(lagState(store,real+skew).lag.shown,true,'stays shown at 3 s');
 pulse(1_500);assert.equal(lagState(store,real+skew).lag.shown,false,'clears under 2 s');
 pulse(4_000);assert.equal(lagState(store,real+skew).lag.shown,false,'4 s does not show it again');
 assert.throws(()=>store.pulse({arc:'other',asOfAgeMs:0,behind:false}),/Malformed pulse/);
 // Silence: the stream object is still open, but nothing has arrived for over five seconds.
 assert.equal(lagState(store,real+skew+4_900).connection,'connected');
 assert.equal(lagState(store,real+skew+5_100).connection,'reconnecting');
 store.connected=false;assert.equal(lagState(store,real+skew).connection,'reconnecting');
 const fresh=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>({}));
 assert.equal(lagState(fresh,real).connection,'connecting');assert.equal(lagState(fresh,real,true).connection,'offline');
});

test('T6: a view response a capture behind a notice admitted while it was in flight is shown, with no error, and loads once more',async()=>{
 const {e,notice}=fixture(),old=graphView(e),next={...old,viewVersion:'e'.repeat(64)};let finish:(v:unknown)=>void=()=>{},more:(v:unknown)=>void=()=>{},count=0;
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>{count++;return new Promise(r=>{if(count===1)finish=r;else more=r;});});
 store.active.set('graph',1);store.notice(notice);const task=store.load('graph');
 store.notice({...notice,highWater:e.highWater+5,revision:notice.revision+1,viewVersions:{...notice.viewVersions,graph:next.viewVersion}});
 finish({...e,data:old});await task;
 assert.equal(store.entry('graph').error,'');assert.equal(store.entry('graph').value.highWater,e.highWater,'the earlier capture is shown');
 assert.equal(store.identity.highWater,e.highWater+5,'the view never moves the identity back');
 assert.equal(count,2,'one follow-up load, as the version differs from the notice\'s');
 more({...e,highWater:e.highWater+5,revision:e.revision+1,data:next});await store.entry('graph').task;
 assert.equal(store.entry('graph').value.data.viewVersion,next.viewVersion);assert.equal(count,2);
});

test('T7: a request carries the watermark of what its own view already shows, and none before it shows anything',async()=>{
 const {e,notice}=fixture(),paths:string[]=[];
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async(path:string)=>{paths.push(path);return {...e,data:shellView(e)};});
 store.notice({...notice,highWater:e.highWater+3,revision:notice.revision+1});
 await store.load('shell');
 const first=new URL(paths[0]!,'http://console').searchParams;
 assert.equal(first.get('epoch'),e.epoch);assert.equal(first.has('minHighWater'),false);
 await store.load('shell',true);
 assert.equal(new URL(paths[1]!,'http://console').searchParams.get('minHighWater'),String(e.highWater),'the value\'s mark, not the notice\'s');
});

test('T8: a failed refresh keeps the view and retries after 1 s, then 2 s; success clears the error and timer; leaving the view cancels it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {e,notice}=fixture();let calls=0,fail=false;
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>{calls++;if(fail)throw new Error('Failed to fetch');return {...e,data:shellView(e)};});
 const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();const task=store.entry('shell').task;if(task)await task;};
 store.active.set('shell',1);store.notice(notice);await store.load('shell');const shown=store.entry('shell').value;
 fail=true;await store.load('shell',true);
 assert.equal(calls,2);assert.equal(store.entry('shell').value,shown,'the view keeps its data');assert.match(store.entry('shell').error,/Failed to fetch/);
 t.mock.timers.tick(999);await settle();assert.equal(calls,2);
 t.mock.timers.tick(1);await settle();assert.equal(calls,3,'retried after 1 s');
 t.mock.timers.tick(1_999);await settle();assert.equal(calls,3);
 t.mock.timers.tick(1);await settle();assert.equal(calls,4,'then after 2 s');
 assert.equal(store.entry('shell').failures,3);
 fail=false;t.mock.timers.tick(4_000);await settle();assert.equal(calls,5);
 assert.equal(store.entry('shell').error,'');assert.equal(store.entry('shell').retry,undefined,'success clears the timer');
 t.mock.timers.tick(60_000);await settle();assert.equal(calls,5);
 fail=true;await store.load('shell',true);assert.equal(calls,6);assert.notEqual(store.entry('shell').retry,undefined);
 store.active.delete('shell');store.abort('shell');
 t.mock.timers.tick(60_000);await settle();assert.equal(calls,6,'leaving the view cancels its retry');
});
