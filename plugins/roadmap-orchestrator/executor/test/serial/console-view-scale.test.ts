import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { Observations } from '../helpers/observations.ts';
import { canonicalJson } from '../../src/core/json.ts';
import { ConsoleViews } from '../../src/console/views.ts';
import { projectionIndex, timelineIntervals, effortRows, attentionSummaries, cpuSummaries, bookingSummaries, waitingMeasurements, stageSummaries, holisticSummaries } from '../../src/console/tab-projections.ts';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import type { Page } from '../../src/console/view-protocol.ts';
import type { Envelope } from '../../src/observation/protocol.ts';
import { unitView, invocationView } from '../../src/console/details.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { until } from '../fixtures/exec-common.ts';
import { consoleGet } from '../helpers/console-http.ts';

test('300-unit/7-day projection budgets preserve every relationship and independently bounded tab row contracts', {timeout:90_000}, async t => {
  const generated = performance.now(), m = await generateScaleArc(tmpDir('console-view-scale'));
  const generationMs = performance.now() - generated;
  const release = await ownScaleArc(m); t.after(release);
  const start = performance.now(), e = new Observations(absPath(m.hostDir),'view-scale','reader').read({runDir:absPath(m.runDir),arc:arcId(m.arc)});
  const captureMs = performance.now() - start, views = new ConsoleViews(), shellStart = performance.now(), shell = views.shell(e);
  const shellMs = performance.now() - shellStart, graphStart = performance.now(), graph = views.graph(e), graphMs = performance.now() - graphStart;
  assert.equal(e.data.display.status.units.length,300); assert.equal(e.data.events.length,7523); assert.equal(e.data.display.invocations.length,1088);
  const sourceEdges = e.data.display.status.edges;
  assert.equal(graph.edges.filter(edge => edge.kind === 'after').length,663);
  assert.equal(graph.edges.filter(edge => edge.kind === 'contingent').length,4);
  assert.equal(graph.edges.filter(edge => edge.kind === 'milestone').length,sourceEdges.filter(edge => edge.type === 'milestone').length);
  assert.equal(graph.edges.filter(edge => edge.kind === 'feeds').length,300);
  const after = graph.edges.filter(edge => edge.kind === 'after');
  for (const edge of sourceEdges) if (edge.type === 'after') assert.ok(after.some(row => row.source === edge.effective && row.target === edge.unit && row.on === edge.on && row.met === edge.met));
  assert.equal(graph.units.length,300); assert.equal(graph.milestones.length,10); assert.equal(graph.focus.activeIds.length,6);
  assert.deepEqual(graph.focus.activeIds,e.data.display.status.units.filter(u => u.state === 'running' || u.state === 'preparing').map(u => u.unit));
  assert.equal(shell.spend.costUsd,e.data.summary.spend.costUsd); assert.equal(shell.attention.total,11);
  const indexStart = performance.now(), index = projectionIndex(e), indexMs = performance.now()-indexStart;
  const intervals = timelineIntervals(e,index), effort = effortRows(e,index), requests = attentionSummaries(e), cpu = cpuSummaries(e), bookings = bookingSummaries(e.data.events), waits = waitingMeasurements(e,index), stages = stageSummaries(e), holistic = holisticSummaries(e);
  assert.equal(intervals.length,1088); assert.equal(intervals.filter(i => i.endedAt === null).length,6);
  assert.equal(e.data.display.invocations.filter(i => i.execution === 'agent' && i.endedAt === null).length,4);
  assert.equal(m.stageAttempts,1412);
  assert.ok(intervals.some(i => i.subject.type === 'job'));
  assert.ok(intervals.filter(i => i.subject.type === 'job').every(i => i.round === null),'unit journey rounds are not invented for Arc/job work');
  assert.equal(stages.length,1411,'the legacy journey definition counts recorded rows, not inherited attempt-base counters');
  assert.equal(stages.filter(s => s.unit === 'u167').length,4);
  assert.equal(e.data.display.status.units.find(u => u.unit === 'u167')!.attempts,5,'re-entry retains one inherited attempt without inventing its timestamp');
  assert.equal(effort.filter(r => r.subject.type === 'unit').length,300);
  assert.equal(requests.length,11);
  assert.ok(Math.abs(effort.reduce((n,r) => n + (r.spend.costUsd ?? 0),0) - shell.spend.costUsd) < 1e-9);
  const {data:_data,...metadata} = e;
  const envelopeBytes = (data:unknown) => Buffer.byteLength(canonicalJson({...metadata,data})+'\n');
  const measured: Record<string,number> = {shell:envelopeBytes(shell),graph:envelopeBytes(graph)};
  assert.ok(measured['shell']! <= 8*1024,JSON.stringify(measured)); assert.ok(measured['graph']! <= 256*1024,JSON.stringify(measured));
  // Pass 1 measures row contracts with full envelope/page allowance. These are NOT final tab endpoints:
  // query scopes, timeline overview/marks, cursors and backend holds are later-pass work.
  for (const [name,rows,budget] of [
    ['intervals',intervals,128],['effort',effort,128],['attention',requests,48],['cpu',cpu,128],['bookings',bookings,128],['waiting',waits.rows,128],['stages',stages,64],['holistic',holistic,64],
  ] as const) {
    let largest = 0;
    for (let offset=0;offset<rows.length;offset+=50) {
      const page: Page<unknown> = {rows:rows.slice(offset,offset+50),page:{anchor:'a'.repeat(256),next:'n'.repeat(512),previous:'p'.repeat(512),limit:50,matching:rows.length,returned:rows.slice(offset,offset+50).length,asOf:{epoch:e.epoch,highWater:e.highWater,observedAt:e.observedAt}}};
      largest=Math.max(largest,envelopeBytes(page));
    }
    measured[name]=largest; assert.ok(largest<=budget*1024,`${name}: ${largest} > ${budget} KiB`);
  }
  let largestUnit=0,largestInvocation=0;
  for(const unit of graph.units)largestUnit=Math.max(largestUnit,envelopeBytes(unitView(e,unit.id,{})));
  for(const i of intervals.filter((_,n)=>n%100===0))largestInvocation=Math.max(largestInvocation,envelopeBytes(invocationView(e,i.id)));
  measured['unitDetail']=largestUnit;measured['invocationDetail']=largestInvocation;
  assert.ok(largestUnit<=64*1024);assert.ok(largestInvocation<=16*1024);
  const serializedStart=performance.now(), bytes=canonicalJson({...metadata,data:graph})+'\n', serializationMs=performance.now()-serializedStart;
  const parseStart=performance.now(); JSON.parse(bytes); const parseMs=performance.now()-parseStart;
  const httpStart=performance.now(), server=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});
  t.after(()=>server.close());
  const base=`${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}`;
  const shellResponse=await consoleGet(`${base}/shell`), shellBody=await shellResponse.text(), firstShellHttpMs=performance.now()-httpStart;
  assert.equal(shellResponse.status,200,shellBody); measured['httpShell']=Buffer.byteLength(shellBody);assert.ok(measured['httpShell']<=8*1024);
  const graphResponse=await consoleGet(`${base}/graph`), graphBody=await graphResponse.text();
  assert.equal(graphResponse.status,200,graphBody.slice(0,500));measured['httpGraph']=Buffer.byteLength(graphBody);assert.ok(measured['httpGraph']<=256*1024);
  assert.deepEqual(JSON.parse(graphBody).data,graph);
  const httpTimes:number[]=[];
  for(let i=0;i<20;i++){const started=performance.now(),r=await consoleGet(`${base}/graph`);assert.equal(r.status,200);await r.json();httpTimes.push(performance.now()-started);}
  httpTimes.sort((a,b)=>a-b);
  const times:number[]=[];
  for(let i=0;i<100;i++){const started=performance.now();assert.equal(views.graph(e),graph);times.push(performance.now()-started);}
  times.sort((a,b)=>a-b);
  const browser=new ConsoleBrowser(tmpDir('console-view-client-scale'),{settleMs:100});t.after(()=>browser.close());await browser.initialize();
  await browser.call('browser_run_code_unsafe',{code:`async(page)=>{await page.addInitScript(()=>{window.__viewBodies=[];const get=window.fetch;window.fetch=async(...args)=>{const r=await get(...args);const body=await r.clone().text();window.__viewBodies.push({url:String(args[0]),status:r.status,bytes:new TextEncoder().encode(body).length});return r;};});}`});
  const coldServer=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});t.after(()=>coldServer.close());
  const browserStart=performance.now();await browser.call('browser_navigate',{url:coldServer.url});
  await until(async()=>browser.evaluate(`()=>!!document.querySelector('.dag-canvas canvas')&&document.body.innerText.includes('Connected')`),15_000,'300-unit DTO Graph');
  const browserGraphMs=performance.now()-browserStart;
  const bodies=await browser.evaluate<{url:string;status:number;bytes:number}[]>('()=>window.__viewBodies');
  assert.equal(bodies.some(r=>/\/(snapshot|status|activity)(?:\?|$)/.test(r.url)),false);
  for(const name of ['shell','graph'])assert.equal(bodies.filter(r=>r.status===200&&r.url.includes('/'+name)).length,1);
  const decoded=bodies.filter(r=>r.status===200&&/\/(shell|graph)(?:\?|$)/.test(r.url)).reduce((n,r)=>n+r.bytes,0);
  assert.ok(decoded<=264*1024);measured['browserGraphColdLoad']=decoded;
  const selectedStart=performance.now();await browser.openUnit('u167');await until(async()=>browser.evaluate(`()=>document.querySelector('.drawer .unit-meta')?.textContent.includes('u167')`),10_000,'selected DTO detail');
  const browserDetailMs=performance.now()-selectedStart;
  await browser.evaluate(`()=>{location.hash='#/arcs/${m.arc}/graph/units/milestone%3AMS-3';return true;}`);
  await until(async()=>browser.evaluate(`()=>!!document.querySelector('.drawer .outstanding-units')`),10_000,'unit to milestone DTO transition');
  assert.doesNotMatch(await browser.evaluate<string>('()=>document.body.innerText'),/Console rendering failed/);
  await browser.evaluate(`()=>{history.back();return true;}`);
  await until(async()=>browser.evaluate(`()=>document.querySelector('.drawer .unit-meta')?.textContent.includes('u167')`),10_000,'Back restores selected unit');
  // Full-scale return cycles supplement the long-field/paging fixture. Preserve
  // the 300-unit population and the existing 90-second file deadline.
  const cycleHeaps:number[]=[];let cycleMaxDom=0;
  for(let n=0;n<12;n++){
    const id=`u${(n*23)%300+1}`;
    await browser.evaluate(`()=>{location.hash='#/arcs/${m.arc}/graph/units/${id}';return true;}`);
    await until(async()=>browser.evaluate(`()=>!!document.querySelector('.drawer .unit-meta')?.textContent.includes('${id}')`),10_000,'full-scale cycle detail');
    await browser.evaluate(`()=>{location.hash='#/arcs/${m.arc}/effort';return true;}`);
    await until(async()=>browser.evaluate(`()=>!!document.querySelector('[aria-label="All units"]')`),10_000,'full-scale cycle Effort');
    cycleMaxDom=Math.max(cycleMaxDom,await browser.evaluate<number>('()=>document.getElementsByTagName("*").length'));
    await browser.evaluate(`()=>{location.hash='#/arcs/${m.arc}/graph';return true;}`);
    await until(async()=>browser.evaluate(`()=>!!document.querySelector('.dag-canvas canvas')`),5000,'full-scale cycle Graph');
    if(n===3||n===11){await browser.call('browser_run_code_unsafe',{code:'async(page)=>{const c=await page.context().newCDPSession(page);await c.send("HeapProfiler.collectGarbage");await c.detach();}'});cycleHeaps.push(await browser.evaluate<number>('()=>performance.memory.usedJSHeapSize'));}
  }
  assert.ok(cycleMaxDom<15000,`full-scale DOM ${cycleMaxDom}`);
  assert.ok(cycleHeaps[1]!-cycleHeaps[0]!<16*1024*1024,`full-scale retained heap ${cycleHeaps}`);
  t.diagnostic(JSON.stringify({browserTimingMs:{usableGraph:browserGraphMs,selectedDetail:browserDetailMs},browserHeap:await browser.evaluate('()=>performance.memory?.usedJSHeapSize??null'),cycles:{count:12,heapBytes:cycleHeaps,maxDom:cycleMaxDom}}));
  t.diagnostic(JSON.stringify({fixture:{units:m.units,days:7,events:m.events,invocations:m.invocations},bytes:measured,timingMs:{generation:generationMs,capture:captureMs,shell:shellMs,graph:graphMs,index:indexMs,serialization:serializationMs,nodeParse:parseMs,warmProjectionP95:times[94],firstShellHttp:firstShellHttpMs,warmGraphHttpP95:httpTimes[18]},rssBytes:process.memoryUsage().rss}));
  // No capture metadata is accidentally carried into the wire data.
  assert.equal('capture' in (JSON.parse(bytes) as Envelope<Record<string,unknown>>).data,false);
});
