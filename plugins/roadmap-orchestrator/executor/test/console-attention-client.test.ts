import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleFixture } from './fixtures/console.ts';
import { Observations } from './helpers/observations.ts';
import { ConsoleMetadata } from '../src/console/metadata.ts';
import { ConsoleViews } from '../src/console/views.ts';
import { ConsoleAttention } from '../src/console/attention-query.ts';
import { requestDetail } from '../src/console/request-detail.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
const {ViewStore}=await import(new URL('../web-src/app/view-store.ts',import.meta.url).href);
function fixture(){const f=consoleFixture(),e=new Observations(f.hostDir,'attention-client','repo').read({runDir:f.runDir,arc:f.arc}),metadata=new ConsoleMetadata().read(e,new ConsoleViews(),e.arc);return {e,metadata};}

test('Attention initial notice deduplicates reads; changed versions preserve the frozen page until explicit refresh',async()=>{
 const {e,metadata}=fixture(),tabs=new ConsoleAttention(),first=tabs.read(e,{},metadata.viewVersions.attention);let finish:(v:unknown)=>void=()=>{},count=0;
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>{count++;return count===1?new Promise(r=>finish=r):{...e,data:{...first,viewVersion:'f'.repeat(64)}};});
 store.active.set('attention?',1);const task=store.load('attention?');store.notice(metadata);const duplicate=store.load('attention?');finish({...e,data:first});await Promise.all([task,duplicate]);assert.equal(count,1);
 store.notice({...metadata,revision:metadata.revision+1,viewVersions:{...metadata.viewVersions,attention:'f'.repeat(64)}});await store.load('attention?');assert.equal(count,1);assert.deepEqual(store.entry('attention?').value.data,first);
 await store.load('attention?',true);assert.equal(count,2);assert.equal(store.entry('attention?').value.data.viewVersion,'f'.repeat(64));
});

test('request-specific runtime schema and selected identity refuse malformed and foreign payloads',async()=>{
 const {e,metadata}=fixture(),r=e.data.requests[0]!;const detail=requestDetail(e,r.id,{});let value:any={...e,data:{...detail,events:[]}};
 const store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>value);store.notice(metadata);await store.load(`requests/${r.id}`);assert.equal(store.reload,true);assert.match(store.entry(`requests/${r.id}`).error,/Malformed/);
 value={...e,data:{...detail,id:'nu-999999'}};await store.load(`requests/${r.id}`,true);assert.match(store.entry(`requests/${r.id}`).error,/identity/);assert.equal(store.entry(`requests/${r.id}`).value,null);
});

test('source-less field return state clears on epoch reset and retains safe route preferences',()=>{
 const {e,metadata}=fixture(),store=new ViewStore(e.arc,CONSOLE_PROTOCOL,async()=>null);store.notice(metadata);
 store.ui.set('holistic-field:old-key',{text:'Previously captured field',next:null,total:25});store.ui.set('query:attention','q=compiler');store.notice({...metadata,epoch:'replacement'},true);
 assert.equal(store.ui.has('holistic-field:old-key'),false);assert.equal(store.ui.get('query:attention'),'q=compiler');
});
