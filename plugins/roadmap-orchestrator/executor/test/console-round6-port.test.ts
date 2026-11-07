import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:net';
import {withConsolePort} from './helpers/console-port.ts';
import {ensureConsole,stopConsole} from '../src/console/lease.ts';
import {consoleFixture,setConsolePort} from './fixtures/console.ts';
test('R8 test port allocation retries a real bind collision, never other failures',async t=>{
 const f=consoleFixture();t.after(()=>stopConsole(f.repo));let attempts=0;let occupied=0;
 const lease=await withConsolePort(async port=>{
  setConsolePort(f.repo,port);attempts++;
  if(attempts!==1)return ensureConsole(f.repo,f.hostDir);
  const held=createServer();await new Promise<void>(r=>held.listen(port,'127.0.0.1',r));occupied=port;
  try{return await ensureConsole(f.repo,f.hostDir);}finally{await new Promise<void>(r=>held.close(()=>r()));}
 });
 assert.equal(attempts,2);assert.notEqual(lease.port,occupied);assert.notEqual(lease.port,4747);
 let calls=0;await assert.rejects(withConsolePort(async()=>{calls++;throw new Error('invalid evidence');}),/invalid evidence/);assert.equal(calls,1);
});
