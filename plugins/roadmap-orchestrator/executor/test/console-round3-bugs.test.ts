import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SseWriter } from '../src/console/sse.ts';
import { HistoryTail } from '../src/tui/history.ts';
import { serveConsole } from '../src/console/http.ts';
import { arcBounds } from '../src/console/views.ts';
import { Observations } from './helpers/observations.ts';
import { absPath } from '../src/core/values.ts';
import { arcId } from '../src/core/ids.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { consoleAgentFixture } from './fixtures/console-agent.ts';
import { parityArc } from './fixtures/status-parity.ts';
import { tmpDir } from './helpers/repo.ts';

test('B1 backpressure waits for drain, preserves queued notices, and bounds a permanently stalled consumer', async () => {
 const output = new PassThrough({ highWaterMark: 8 }); const writer = new SseWriter(output, 100);
 writer.send('revision', {revision:1}); writer.send('history', {cursor:20});
 assert.equal(output.destroyed,false); let text=''; output.on('data', chunk => {text+=chunk;});
 await new Promise(r=>setTimeout(r,20)); assert.match(text,/event: revision/); assert.match(text,/event: history/); assert.doesNotMatch(text,/slow consumer/); output.destroy();
 const stalled = new PassThrough({highWaterMark:8}); const bounded = new SseWriter(stalled,30); bounded.send('revision',{revision:1});
 await new Promise(r=>setTimeout(r,60)); assert.equal(stalled.destroyed,true);
});
test('B1 a finished hundreds-of-KB transcript yields small notices and a readable GET history', async t => {
 const f=await consoleAgentFixture();t.after(()=>f.close());
 for(let n=0;n<350;n++) f.append(`message ${n}: `+'readable '.repeat(150)); f.finish();
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;const c=new AbortController();t.after(()=>c.abort());
 const response=await fetch(`${base}/events?invocation=${f.routeId}`,{signal:c.signal});const reader=response.body!.getReader();let text='';
 while(!text.includes('event: history\n')) {const r=await reader.read();assert.equal(r.done,false);text+=new TextDecoder().decode(r.value);}
 for(const frame of text.split('\n\n').filter(Boolean)){assert.ok(Buffer.byteLength(frame)<4096);assert.doesNotMatch(frame,/"events"|"display"|"console"|slow consumer/);}
 const page=await(await fetch(`${base}/invocations/${f.routeId}/history`)).json() as {data:{events:{text?:string}[];state:string}};
 assert.equal(page.data.state,'success');assert.ok(page.data.events.some(e=>e.text?.includes('Verified the change')));c.abort();
});
test('B3 completed run resource axis stays at its recorded end across later observations',()=>{
 const f=parityArc();const e=new Observations(f.hostDir,'i','r').read({runDir:f.runDir,arc:arcId(f.d.arc)});
 const at=new Date(Date.parse(e.data.events[0]!.at)+120000).toISOString();
 const done={...e.data.events.at(-1)!,type:'fact',at,fact:{kind:'arc-completed'}} as unknown as typeof e.data.events[number];
 const bounds=arcBounds({...e,checkedAt:new Date(Date.parse(at)+7*3600000).toISOString(),data:{...e.data,events:[...e.data.events,done]}});
 assert.equal((Date.parse(bounds.to!)-Date.parse(bounds.from!))/1000,120);assert.equal(bounds.to,at);
});
test('B4 CLI housekeeping is collapsed session metadata, never raw transcript events',()=>{
 const path=join(tmpDir('session-metadata'),'stdout');writeFileSync(path,JSON.stringify({type:'system',subtype:'init',model:'claude-test',tools:['Read','Bash']})+'\n');
 appendFileSync(path,JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed'}})+'\n');
 appendFileSync(path,JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Working on the unit.'}]}})+'\n');
 const tail=new HistoryTail();tail.read(path);const page=tail.page(path);
 assert.deepEqual(page.events.map(e=>e.text),['Working on the unit.']);assert.equal(page.session.model,'claude-test');assert.deepEqual(page.session.tools,['Read','Bash']);assert.match(page.session.notices.join(' '),/allowed/);
});
