import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {Observations} from './helpers/observations.ts';
import {consoleFixture} from './fixtures/console.ts';
import {portableStatus} from './fixtures/status-parity.ts';
test('R1 streaming and unrelated-run churn never blocks or causes a capture; receipts do',async t=>{
 const f=consoleFixture(),cache=new Observations(f.hostDir,'test','test'),arc=cache.arc(f);
 const first=cache.read(f);
 const captures=()=>arc.messages.filter(m=>m.kind==='observation').length;
 const files=[...['stdout','stderr','runner.log'].map(n=>join(f.runDir,'inv','999-1',n)),join(f.hostDir,'supervisor.test.out'),join(f.hostDir,'supervisor.test.err'),join(f.common,'roadmap-runtime','unrelated','sched.json')];
 for(const p of files){mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,'');}
 const writer=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {appendFileSync}=require('node:fs');function tick(){for(const p of workerData)appendFileSync(p,'x');}tick();parentPort.postMessage('ready');setInterval(tick,5);`,{eval:true,workerData:files});
 t.after(()=>writer.terminate());await new Promise(r=>writer.once('message',r));
 const began=performance.now();const cold=new Observations(f.hostDir,'cold','test').read(f);
 assert.ok(performance.now()-began<1500,'cold observation succeeds promptly during churn');
 assert.deepEqual(portableStatus(cold.data.display.status),portableStatus(first.data.display.status));
 for(let i=0;i<3;i++)cache.read(f);
 assert.equal(captures(),1,'log writes and other runs cause no capture');
 const path=join(f.runDir,'commands','receipts','cmd-0000000000000001.rejected.json');const receipt=JSON.parse(readFileSync(path,'utf8'));receipt.reason='R6 receipt change';writeFileSync(path,JSON.stringify(receipt));
 cache.read(f);
 assert.equal(captures(),2,'real input causes a capture');
 const work=arc.messages.filter(m=>m.kind==='observation').at(-1)!;
 assert.ok(work.kind==='observation'&&work.work.eventsFolded===0&&work.work.recordReads<=2,'the capture read what changed, not the arc again');
});
