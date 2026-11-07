import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openJournal,readJournal} from '../src/core/log.ts';
import {invocationDirName,opKey} from '../src/core/ids.ts';
import {absPath} from '../src/core/values.ts';
import {invocationDir} from '../src/pipeline/invoke.ts';
import {launchSha256} from '../src/runner/launch.ts';
import type {LaunchFile} from '../src/core/records.ts';
import {gitCommonDir} from '../src/git/git.ts';
import {serveConsole} from '../src/console/http.ts';
import {CONSOLE_PROTOCOL} from '../src/observation/protocol.ts';
import {consoleAgentFixture} from './fixtures/console-agent.ts';
test('R2 abort during delayed catch-up releases histories; seventeen subsequent opens succeed',{timeout:30000},async t=>{
 const f=await consoleAgentFixture();t.after(()=>f.close());const j=openJournal(f.runDir,f.arc);t.after(()=>j.close());
 const template=JSON.parse(readFileSync(join(invocationDir(f.runDir,f.inv),'launch.json'),'utf8')) as LaunchFile;
 const source=readJournal(f.runDir,f.arc).events.find(e=>e.type==='intent'&&e.kind==='proc.spawn'&&e.op===template.op);assert.ok(source&&source.type==='intent'&&source.kind==='proc.spawn');
 const ids:string[]=[];
 for(let n=0;n<17;n++){let launch!:LaunchFile;const spawned=j.begin({kind:'proc.spawn',key:opKey(`disconnect-${n}`),parent:source.parent,deadlineAt:null,body:(op,inv)=>{launch={...template,op,inv};return {expect:{...source.expect,launchSha256:launchSha256(launch)},post:null};}});const dir=invocationDir(f.runDir,spawned.inv);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'launch.json'),JSON.stringify(launch));writeFileSync(join(dir,'stdout'),'');ids.push(invocationDirName(spawned.inv));}
 const original=Worker.prototype.postMessage;let gate:((send:()=>void)=>void)|null=null;let removes=0,unpins=0;
 t.mock.method(Worker.prototype,'postMessage',function(this:Worker,m:any,...rest:any[]){if(m.kind==='history-unsubscribe')removes++;if(m.kind==='unsubscribe')unpins++;if(m.kind==='subscribe'&&gate){const g=gate;gate=null;g(()=>original.call(this,m,...rest));return;}return original.call(this,m,...rest);});
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());const base=`${s.url}/api/${CONSOLE_PROTOCOL}/runs/${f.arc}`;
 for(const id of ids.slice(0,16)){
  const c=new AbortController();let release!:()=>void;const delayed=new Promise<void>(r=>{gate=send=>{release=send;r();};});const response=fetch(`${base}/events?invocation=${id}`,{signal:c.signal}).catch(()=>null);
  await delayed;c.abort();await response;await new Promise(r=>setTimeout(r,15));release();await s.ask({kind:'read',path:['runs'],params:{}});await new Promise(r=>setTimeout(r,10));
 }
 for(const id of ids){const c=new AbortController();try{const response=await fetch(`${base}/events?invocation=${id}`,{signal:c.signal});assert.equal(response.status,200,await (response.status===200?Promise.resolve(''):response.text()));await response.body!.getReader().read();}finally{c.abort();}await new Promise(r=>setTimeout(r,15));}
 assert.ok(removes>=17,'history subscriptions released');assert.ok(unpins>=17,'arc subscriptions released');
});
test('R2 subscribe/remove/subscribe control messages retain their order instead of coalescing',async t=>{
 const {consoleFixture}=await import('./fixtures/console.ts');const f=consoleFixture();const original=Worker.prototype.postMessage;const controls:string[]=[];
 t.mock.method(Worker.prototype,'postMessage',function(this:Worker,m:any,...rest:any[]){if(m.kind==='subscribe')controls.push('subscribe');if(m.kind==='unsubscribe')controls.push('remove');return original.call(this,m,...rest);});
 const s=await serveConsole({...f,host:'127.0.0.1',port:0});t.after(()=>s.close());
 await Promise.all([s.ask({kind:'subscribe',arc:f.arc}),s.ask({kind:'unsubscribe',arc:f.arc}),s.ask({kind:'subscribe',arc:f.arc})]);
 assert.deepEqual(controls,['subscribe','remove','subscribe']);
});
