import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commandBody, receipt } from '../src/core/records.ts';
import { commandId, opId } from '../src/core/ids.ts';
import { isoTime } from '../src/core/values.ts';
import { writeReceipt, receiptPath, submitCommand, incomingPath } from '../src/commands/queue.ts';
import { setupArc, contextFor, applyBody } from './fixtures/unit-common.ts';

const stamp = isoTime('2026-11-06T00:00:00.000Z');

test('review.resolution-readers-preserve-absence-and-writers-preserve-bytes', () => {
  const r = contextFor(setupArc({ steps: [] }));
  try {
    const body = applyBody(r.d);
    assert.equal(Object.hasOwn(commandBody(body, 'apply'), 'resolves'), false);
    const command = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(incomingPath(r.ctx.runDir, command.id), 'utf8')).body, 'resolves'), false);
    const value = { v: 2 as const, command: commandId('cmd-0000000000000011'), state: 'applied' as const, at: stamp, op: opId(r.ctx.plan().arc, 1), verified: ['paused'] };
    assert.equal(Object.hasOwn(receipt(value, 'receipt'), 'resolved'), false);
    writeReceipt(r.ctx.runDir, value);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath(r.ctx.runDir, value.command, 'applied'), 'utf8')), value, 'validation never serializes a read-time default');
  } finally { r.journal.close(); }
});

for (const mode of ['fresh', 'legacy'] as const) test(`review.resolution-warning-is-read-only: ${mode}`, () => {
  const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import {readFileSync,writeFileSync} from 'node:fs';
    import {setImmediate as tick} from 'node:timers/promises';
    import {setupArc,contextFor,applyBody} from ${JSON.stringify(moduleUrl('./fixtures/unit-common.ts'))};
    import {submitCommand,writeReceipt,readCommand,readReceipt,incomingPath,receiptPath} from ${JSON.stringify(moduleUrl('../src/commands/queue.ts'))};
    import {commandId,opId} from ${JSON.stringify(moduleUrl('../src/core/ids.ts'))};
    const warnings=[];process.on('warning',w=>{if(w.message.includes('absent apply resolves/receipt resolved'))warnings.push(w.message)});
    const r=contextFor(setupArc({steps:[]}));
    try {
      const legacy=${JSON.stringify(mode)}==='legacy';
      const body=legacy?applyBody(r.d):{type:'pause',target:{type:'all'}};
      const command=submitCommand(r.ctx.runDir,r.ctx.plan().arc,body);
      const value={v:2,command:command.id,state:'applied',at:command.at,op:opId(r.ctx.plan().arc,1),verified:['effect']};
      writeReceipt(r.ctx.runDir,value);
      await tick();assert.equal(warnings.length,0,'validating a new write never warns');
      const paths=[incomingPath(r.ctx.runDir,command.id),receiptPath(r.ctx.runDir,command.id,'applied')];
      const bytes=paths.map(p=>readFileSync(p));
      for(let n=0;n<2;n++){readReceipt(r.ctx.runDir,command.id,'applied');readCommand(r.ctx.runDir,command.id,r.ctx.plan().arc)}
      await tick();assert.equal(warnings.length,legacy?1:0,'only an absent legacy apply field read from disk warns, once');
      paths.forEach((p,n)=>assert.deepEqual(readFileSync(p),bytes[n]));
      if(!legacy){
        const modern=submitCommand(r.ctx.runDir,r.ctx.plan().arc,{...applyBody(r.d),resolves:[]});
        writeReceipt(r.ctx.runDir,{...value,command:modern.id,resolved:[]});
        readCommand(r.ctx.runDir,modern.id,r.ctx.plan().arc);readReceipt(r.ctx.runDir,modern.id,'applied');
        await tick();assert.equal(warnings.length,0,'explicit current apply measurements never warn');
      }
    }finally{r.journal.close()}
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
});
