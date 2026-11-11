import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleFixture } from './fixtures/console.ts';
import { Observations } from './helpers/observations.ts';
import { shellView, graphView } from '../src/console/views.ts';
import { ConsoleMetadata } from '../src/console/metadata.ts';
import { ConsoleViews } from '../src/console/views.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
const {ViewStore}=await import(new URL('../web-src/app/view-store.ts',import.meta.url).href);
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
test('reset aborts obsolete work; prior-instance and lower-prefix responses never replace admitted content',async()=>{
 const {e,notice}=fixture();let finish:(v:unknown)=>void=()=>{};
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>new Promise(r=>finish=r));
 const task=store.load('shell');store.notice({...notice,instance:'new-instance'},true);finish({...e,data:shellView(e)});await task;
 assert.equal(store.entry('shell').value,null);assert.equal(store.identity.instance,'new-instance');
 assert.throws(()=>store.notice(notice),/conflict/);
 store.read=async()=>({...e,instance:'new-instance',highWater:e.highWater-1,data:shellView(e)});
 await store.load('shell');assert.match(store.entry('shell').error,/advanced/);assert.equal(store.entry('shell').value,null);
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
