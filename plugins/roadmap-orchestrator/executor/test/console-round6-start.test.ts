import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {serveConsole} from '../src/console/http.ts';
import {consoleCommon,readConsoleLease} from '../src/console/lease.ts';
import {absPath} from '../src/core/values.ts';
import {consoleFixture,setConsolePort} from './fixtures/console.ts';
import {setupExec,cli,execEnv,hostLockHeld,until} from './fixtures/exec-common.ts';
import {startCli,startLine,pausedFromTheStart,idle,smokes,launchDirect,ownerOf,supervisorOf,kill} from './fixtures/sup-common.ts';
import {commitAll} from './helpers/repo.ts';
import {statOf} from '../src/contain/proc.ts';
import {runFixture} from './helpers/proc.ts';
import {assertNoSurvivors} from './helpers/reap.ts';
after(assertNoSurvivors);
test('R6 second repo starts and resumes while console address is occupied; explicit console start still refuses',{timeout:30000},async t=>{
 const first=consoleFixture(),server=await serveConsole({...first,host:'127.0.0.1',port:0});t.after(()=>server.close());
 const r=setupExec(t,{steps:smokes(2)});setConsolePort(r.repo,Number(new URL(server.url).port));commitAll(r.repo,'console bind fixture');await pausedFromTheStart(r);
 const exit=await startCli(r);assert.equal(exit.code,0,exit.stdout+exit.stderr);const line=startLine(exit);assert.equal(line.kind,'ready');await idle(r,line.generation!);assert.equal(hostLockHeld(r),true);
 assert.equal((exit.stderr.match(/WARNING: Roadmap console/g)||[]).length,1);assert.match(exit.stderr,/127\.0\.0\.1:\d+/);assert.ok(exit.stderr.includes(join(r.repo,'.roadmap','config.json')));assert.match(exit.stderr,/webConsole.port.*EADDRINUSE/s);assert.equal(readConsoleLease(consoleCommon(absPath(r.repo))),null);
 const explicit=await runFixture('exec-cli.ts',[r.hostDir,'console','start','--repo',r.repo],{env:process.env,timeoutMs:15000});assert.notEqual(explicit.code,0);assert.match(explicit.stderr,/webConsole.port.*EADDRINUSE/s);assert.equal((await fetch(server.url)).status,200);
 await kill(supervisorOf(r));await kill(ownerOf(r)!.executor!);
 const resumed=await runFixture('exec-cli.ts',[r.hostDir,'resume-arc','--repo',r.repo],{env:execEnv(r),timeoutMs:20000});assert.equal(resumed.code,0,resumed.stdout+resumed.stderr);const next=startLine(resumed);assert.equal(next.kind,'ready');assert.ok(next.generation!>line.generation!);await idle(r,next.generation!);assert.match(resumed.stderr,/WARNING:.*webConsole.port.*EADDRINUSE/s);
 await cli(r,['stop']);await until(()=>!hostLockHeld(r),15000,'stop');
});
test('R6 direct supervise proceeds on a non-EADDRINUSE bind failure',{timeout:30000},async t=>{
 const r=setupExec(t,{steps:smokes(1)});const path=join(r.repo,'.roadmap','config.json'),config=JSON.parse(readFileSync(path,'utf8'));config.webConsole.host='192.0.2.1';writeFileSync(path,JSON.stringify(config));commitAll(r.repo,'console bind fixture');await pausedFromTheStart(r);
 const supervisor=launchDirect(r,300000);t.after(async()=>{if(statOf(supervisor.pid)?.start===supervisor.start)await kill(supervisor);});await until(()=>ownerOf(r)?.executor!=null,15000,'direct supervisor owner despite bind error');await idle(r,ownerOf(r)!.generation);assert.equal(readConsoleLease(consoleCommon(absPath(r.repo))),null);await cli(r,['stop']);
});
