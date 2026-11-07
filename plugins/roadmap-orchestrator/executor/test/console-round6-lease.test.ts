import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {ensureConsole,readConsoleLease,serviceDir,stopConsole} from '../src/console/lease.ts';
import {consoleStatus} from '../src/console/client.ts';
import {selfIdentity,isAlive} from '../src/host/liveness.ts';
import {CONSOLE_PROTOCOL} from '../src/observation/protocol.ts';
import {consoleFixture,setConsolePort} from './fixtures/console.ts';
test('R3 version mismatch falls back locally; automatic ensure replaces the old process',async t=>{
 const f=consoleFixture();setConsolePort(f.repo,0);t.after(()=>stopConsole(f.repo));const old=await ensureConsole(f.repo,f.hostDir);
 const path=join(serviceDir(f.common),'lease.json');writeFileSync(path,JSON.stringify({...old,executorVersion:'older'}));
 const lines:string[]=[];assert.equal(JSON.parse(await consoleStatus(f,f.hostDir,false,l=>lines.push(l))).arc,f.arc);assert.match(lines.join('\n'),/protocol\/version mismatch.*using local observation/);
 const next=await ensureConsole(f.repo,f.hostDir);assert.notEqual(next.pid,old.pid);assert.equal(next.executorVersion,CONSOLE_PROTOCOL);assert.equal(isAlive(old,old.bootId),false);
});
test('R4 dead foreign-common leases can be replaced/stopped; live foreign leases name their path and pid',async t=>{
 const f=consoleFixture();setConsolePort(f.repo,0);const lease=await ensureConsole(f.repo,f.hostDir);await stopConsole(f.repo);const path=join(serviceDir(f.common),'lease.json');
 const dead={...lease,...selfIdentity(),start:selfIdentity().start+1,common:'/relocated/old-common'};
 writeFileSync(path,JSON.stringify(dead));assert.equal((await stopConsole(f.repo)).state,'stale');
 writeFileSync(path,JSON.stringify(dead));const next=await ensureConsole(f.repo,f.hostDir);t.after(async()=>{writeFileSync(path,JSON.stringify(next));await stopConsole(f.repo);});assert.equal(next.common,f.common);
 writeFileSync(path,JSON.stringify({...next,common:'/relocated/old-common'}));
 const refused=(e:unknown)=>e instanceof Error&&e.message.includes(path)&&e.message.includes(String(next.pid))&&e.message.includes('roadmap console stop');
 assert.throws(()=>readConsoleLease(f.common),refused);await assert.rejects(ensureConsole(f.repo,f.hostDir),refused);await assert.rejects(stopConsole(f.repo),refused);assert.equal(isAlive(next,next.bootId),true);
});
test('R7 checked observations never rewrite the service lease',async t=>{
 const f=consoleFixture();setConsolePort(f.repo,0);t.after(()=>stopConsole(f.repo));const lease=await ensureConsole(f.repo,f.hostDir);const path=join(serviceDir(f.common),'lease.json');
 const original=readFileSync(path,'utf8'),stamp=statSync(path,{bigint:true}).mtimeNs;
 await fetch(`${lease.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/snapshot`);await new Promise(r=>setTimeout(r,1200));
 assert.equal(readFileSync(path,'utf8'),original);assert.equal(statSync(path,{bigint:true}).mtimeNs,stamp);assert.equal(Object.hasOwn(JSON.parse(original),'lastObservation'),false);
});
