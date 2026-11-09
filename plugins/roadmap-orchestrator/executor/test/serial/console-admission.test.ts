import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { absPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { serveConsole } from '../../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import { consoleGet } from '../helpers/console-http.ts';
import { consoleFixture } from '../fixtures/console.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { until } from '../fixtures/exec-common.ts';

test('300-unit cold browser preparation survives a worker delay beyond two seconds', {timeout:90_000}, async t => {
  const m = await generateScaleArc(tmpDir('console-admission-scale')), release = await ownScaleArc(m); t.after(release);
  const original = Worker.prototype.postMessage; const reads:string[] = [];
  t.mock.method(Worker.prototype,'postMessage',function(this:Worker,message:any,...rest:any[]) {
    if (message.kind==='read') {
      reads.push(message.path[2]);
      if (['shell','graph'].includes(message.path[2])) { setTimeout(()=>original.call(this,message,...rest),2300); return; }
    }
    return original.call(this,message,...rest);
  });
  const started = performance.now(), s = await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0}); t.after(()=>s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}`;
  const [shell,graph] = await Promise.all([
    consoleGet(`${base}/shell`).then(async r => { assert.equal(r.status,200); const e=await r.json() as any; return {e,ms:performance.now()-started}; }),
    consoleGet(`${base}/graph`).then(async r => { assert.equal(r.status,200); const e=await r.json() as any; return {e,ms:performance.now()-started}; }),
  ]);
  assert.equal(shell.e.data.progress.total,300); assert.equal(graph.e.data.units.length,300);
  assert.equal(shell.e.epoch,graph.e.epoch); assert.equal(shell.e.highWater,graph.e.highWater);
  assert.ok(Buffer.byteLength(JSON.stringify(shell.e))<=8192); assert.ok(Buffer.byteLength(JSON.stringify(graph.e))<=256*1024);
  const detailStart = performance.now(), detail = await consoleGet(`${base}/units/u1`), body = await detail.json() as any;
  assert.equal(detail.status,200); assert.equal(body.data.unit.id,'u1');
  assert.equal(reads.filter(x=>x==='shell').length,1); assert.equal(reads.filter(x=>x==='graph').length,1);
  assert.equal(reads.includes('snapshot'),false);
  const metadataResponse = await consoleGet(`${base}/metadata`), metadataBody = await metadataResponse.text();
  assert.equal(metadataResponse.status,200); assert.ok(Buffer.byteLength(metadataBody)<=4096);
  t.diagnostic(JSON.stringify({bytes:{shell:Buffer.byteLength(JSON.stringify(shell.e)+'\n'),graph:Buffer.byteLength(JSON.stringify(graph.e)+'\n'),metadata:Buffer.byteLength(metadataBody)},fixture:{units:300,events:m.events,invocations:m.invocations},timingMs:{firstShell:shell.ms,firstUsableGraph:graph.ms,selectedDetail:performance.now()-detailStart},rssBytes:process.memoryUsage().rss,node:process.version,logicalCpus:(await import('node:os')).availableParallelism()}));
});

test('Chromium waits through preparation and renders the existing console without a catch-up error', {timeout:45_000}, async t => {
  const f = consoleFixture(), original = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype,'postMessage',function(this:Worker,m:any,...rest:any[]) {
    if (m.kind==='read' && (['shell','graph'].includes(m.path[2]) || m.path.length===1)) { setTimeout(()=>original.call(this,m,...rest),2300); return; }
    return original.call(this,m,...rest);
  });
  const s = await serveConsole({...f,host:'127.0.0.1',port:0}); t.after(()=>s.close());
  const b = new ConsoleBrowser(tmpDir('console-admission-browser'),{settleMs:100}); t.after(()=>b.close()); await b.initialize();
  await b.call('browser_run_code_unsafe',{code:`async (page) => { await page.addInitScript(() => { window.__preparationResponses=[]; const original=window.fetch; window.fetch=async (...args) => { const r=await original(...args); window.__preparationResponses.push({url:String(args[0]),status:r.status}); return r; }; }); }`});
  await b.call('browser_navigate',{url:s.url});
  try { await until(async()=>b.evaluate(`()=>!!document.querySelector('.dag-canvas canvas') && document.body.innerText.includes('Connected')`),15000,'prepared Graph'); } catch(error) { t.diagnostic(await b.evaluate(`()=>JSON.stringify({text:document.body.innerText,responses:window.__preparationResponses})`)); throw error; }
  const text = await b.evaluate<string>('()=>document.body.innerText'); assert.doesNotMatch(text,/catch-up exceeded|Malformed observation payload/);
  const responses = await b.evaluate<{url:string;status:number}[]>('()=>window.__preparationResponses');
  assert.ok(responses.some(r=>r.url.endsWith('/arcs')&&r.status===202),'browser discovery also prepares instead of using the strict status deadline');
  assert.ok(responses.some(r=>r.url.includes('/graph')&&r.status===202));
  assert.ok(responses.some(r=>r.url.includes('/graph')&&r.url.includes('pending=')&&r.status===200));
  assert.equal(responses.some(r=>r.status===503),false);
  assert.equal(responses.some(r=>/\/(snapshot|status|activity)(?:\?|$)/.test(r.url)),false,'Graph boot fetches no adapter, canonical status or inactive-tab data');
  assert.equal(responses.filter(r=>r.url.includes('/graph')&&!r.url.includes('pending=')).length,1,'initial SSE notice does not duplicate Graph');
  assert.equal(responses.filter(r=>r.url.includes('/shell')&&!r.url.includes('pending=')).length,1,'initial SSE notice does not duplicate shell');
  await b.openUnit('u1');await until(async()=>b.evaluate(`()=>!!document.querySelector('.drawer .journey-pipeline')`),10_000,'selected unit DTO');
  await b.evaluate(`()=>{document.querySelector('[aria-label="Close details"]').click();return true;}`);
  await until(async()=>b.evaluate(`()=>!document.querySelector('.drawer')`),5000,'close DTO drawer');
  const after=await b.evaluate<{url:string;status:number}[]>('()=>window.__preparationResponses');
  assert.equal(after.some(r=>r.url.includes('/snapshot')),false,'opening and closing a drawer never loads the adapter');
  assert.equal(after.filter(r=>r.url.includes('/graph')&&!r.url.includes('pending=')).length,1,'drawer keeps the base Graph');
  assert.ok(after.some(r=>r.url.includes('/units/u1')&&r.status===200));
});
