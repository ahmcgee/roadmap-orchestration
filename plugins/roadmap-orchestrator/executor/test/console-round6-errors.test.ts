import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {serveConsole} from '../src/console/http.ts';
import {CONSOLE_PROTOCOL} from '../src/observation/protocol.ts';
import {consoleFixture} from './fixtures/console.ts';
test('R5 a 100 KiB observation error is a bounded notice and does not terminate the console', {timeout:15000},async t=>{
 const f=consoleFixture(),s=await serveConsole({...f,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const controller=new AbortController();t.after(()=>controller.abort());
 const response=await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/events`,{signal:controller.signal});
 const reader=response.body!.getReader();await reader.read();
 const config=join(f.common,'config'),original=readFileSync(config,'utf8');t.after(()=>writeFileSync(config,original));
 writeFileSync(config,original+'\n[core]\nbare = '+ 'x'.repeat(100*1024)+'\n');
 let frame='';while(!frame.includes('event: error\n')){const part=await reader.read();assert.equal(part.done,false);frame+=new TextDecoder().decode(part.value);}
 const error=frame.split('\n\n').find(f=>f.includes('event: error\n'))!;
 assert.ok(Buffer.byteLength(error)<4096);assert.match(error,/\(truncated, \d+ bytes\)/);
 writeFileSync(config,original);
 assert.equal((await fetch(s.url)).status,200,'HTTP service remains up');controller.abort();
});
