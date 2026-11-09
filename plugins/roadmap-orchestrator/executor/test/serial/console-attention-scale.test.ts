import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { until } from '../fixtures/exec-common.ts';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { ObservationCache } from '../../src/observation/cache.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import { ConsoleAttention } from '../../src/console/attention-query.ts';
import { requestDetail } from '../../src/console/request-detail.ts';
import { serveConsole } from '../../src/console/http.ts';
import { consoleGet } from '../helpers/console-http.ts';
import type { RequestView } from '../../src/console/attention-protocol.ts';

test('300-unit/7-day Attention independent query, selected request cold routes, exact request evidence and decoded/DOM/heap budgets',{timeout:90_000},async t=>{
 const began=performance.now(),m=await generateScaleArc(tmpDir('console-attention-scale')),generationMs=performance.now()-began;
 const release=await ownScaleArc(m);t.after(release);
 const startCapture=performance.now(),e=new ObservationCache(absPath(m.hostDir),'attention-scale','repo').read({runDir:absPath(m.runDir),arc:arcId(m.arc)}),captureMs=performance.now()-startCapture;
 assert.equal(e.data.display.status.units.length,300);assert.equal(e.data.display.invocations.length,1088);assert.equal(e.data.events.length,7523);
 const tabs=new ConsoleAttention(),bytes=(data:unknown)=>Buffer.byteLength(JSON.stringify({...e,data}))+1;
 const projectionStart=performance.now();let page=tabs.read(e,{});const projectionMs=performance.now()-projectionStart,rows=[...page.rows];let largest=bytes(page);
 while(page.page.next){page=tabs.read(e,{cursor:page.page.next});rows.push(...page.rows);largest=Math.max(largest,bytes(page));}
 assert.equal(rows.length,m.openAttention);assert.equal(new Set(rows.map(r=>r.id)).size,m.openAttention);assert.equal(page.counts.total,m.openAttention);assert.ok(largest<=48*1024);
 let largestDetail=0;for(const row of rows){const d=requestDetail(e,row.id,{}) as RequestView,canonical=e.data.requests.find(r=>r.id===row.id)!;largestDetail=Math.max(largestDetail,bytes(d));assert.equal(d.open,true);assert.equal(d.fields.summary,canonical.summary);assert.equal(d.fields.recommendation,canonical.recommendation);assert.deepEqual(d.options.map(o=>({id:o.id,label:o.label})),canonical.options);assert.deepEqual(d.evidenceRefs.map(r=>r.path),canonical.evidence);}assert.ok(largestDetail<=32*1024);
 const serialize=performance.now(),encoded=JSON.stringify({...e,data:page}),serializationMs=performance.now()-serialize,parse=performance.now();JSON.parse(encoded);const parseMs=performance.now()-parse;
 const b=new ConsoleBrowser(tmpDir('console-attention-scale-browser'));t.after(()=>b.close());await b.initialize();await b.call('browser_resize',{width:1440,height:900});
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.addInitScript(()=>{window.__reads=[];const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/api/'))window.__reads.push({url:String(args[0]),status:r.status,atMs:performance.now(),bytes:new TextEncoder().encode(await r.clone().text()).length});return r;};});}`});
 const measured:Record<string,number>={largestList:largest,largestDetail},timing:Record<string,number>={generationMs,captureMs,projectionMs,serializationMs,parseMs};
 for(const deep of [false,true]){
  const cold=performance.now(),s=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});t.after(()=>s.close());
  await b.call('browser_navigate',{url:`${s.url}/#/arcs/${m.arc}/attention${deep?`/requests/${rows[0]!.id}`:''}`});
  await until(async()=>b.evaluate(`()=>document.querySelectorAll('.request-link').length===${m.openAttention}&&document.querySelector('.progress-count')?.textContent.includes('/300')${deep?"&&!!document.querySelector('.request-drawer .owner-notice')":''}`),10_000,'cold Attention');timing[deep?'deepUsableMs':'listUsableMs']=performance.now()-cold;
  const reads=await b.evaluate<{url:string;status:number;bytes:number;atMs:number}[]>(`()=>window.__reads`),successful=reads.filter(r=>r.status===200);
  assert.deepEqual(successful.map(r=>new URL(r.url,'http://console').pathname.split('/').at(-1)).sort(),['arcs','shell','attention',...(deep?[rows[0]!.id]:[])].sort(),JSON.stringify(reads));assert.ok(!reads.some(r=>/\/(snapshot|status|graph|timeline|activity|holistic|effort|resources)(?:\?|$)/.test(r.url)));
  const pair=successful.filter(r=>/\/(shell|attention)(?:\?|$)/.test(r.url)).reduce((n,r)=>n+r.bytes,0);assert.ok(pair<=56*1024);measured[deep?'deepCold':'listCold']=pair;
  timing[deep?'deepShellMs':'listShellMs']=successful.find(r=>/\/shell(?:\?|$)/.test(r.url))!.atMs;
  if(deep){measured['httpDetail']=successful.find(r=>r.url.includes('/requests/'))!.bytes;assert.ok(measured['httpDetail']!<=32*1024);}
  else {
   const detailStart=performance.now();await b.evaluate(`()=>{document.querySelector('.request-link').click();return true;}`);await until(async()=>b.evaluate(`()=>!!document.querySelector('.request-drawer .owner-notice')`),5000,'selected request detail');timing['selectedDetailMs']=performance.now()-detailStart;
   await b.evaluate(`()=>{document.querySelector('[aria-label="Close details"]').click();return true;}`);
   const heaps:number[]=[];let maxDom=0;
   for(let n=0;n<12;n++){
    await b.evaluate(`()=>{document.querySelector('.request-link').click();return true;}`);await until(async()=>b.evaluate(`()=>!!document.querySelector('.request-drawer .owner-notice')`),5000,'cycle request');maxDom=Math.max(maxDom,await b.evaluate<number>(`()=>document.querySelectorAll('*').length`));
    await b.evaluate(`()=>{document.querySelector('[aria-label="Close details"]').click();return true;}`);
    if(n===3||n===11){await b.call('browser_run_code_unsafe',{code:'async(page)=>{const c=await page.context().newCDPSession(page);await c.send("HeapProfiler.collectGarbage");await c.detach();}'});heaps.push(await b.evaluate<number>('()=>performance.memory.usedJSHeapSize'));}
   }
   assert.ok(maxDom<5000);assert.ok(heaps[1]!-heaps[0]!<12*1024*1024);t.diagnostic(JSON.stringify({attentionCycles:{count:12,heapBytes:heaps,maxDom}}));
   const times:number[]=[];for(let n=0;n<20;n++){const start=performance.now(),r=await consoleGet(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/attention`);assert.equal(r.status,200,await r.clone().text());await r.json();times.push(performance.now()-start);}times.sort((a,b)=>a-b);timing['warmP95Ms']=times[18]!;
  }
  await b.call('browser_resize',{width:390,height:844});assert.equal(await b.evaluate(`()=>document.documentElement.scrollWidth<=innerWidth&&(!document.querySelector('.drawer')||document.querySelector('.drawer').scrollWidth<=document.querySelector('.drawer').clientWidth)`),true);await b.call('browser_resize',{width:1440,height:900});await b.call('browser_navigate',{url:'about:blank'});await s.close();
 }
 t.diagnostic(JSON.stringify({attentionScale:{bytes:measured,timing,rss:process.memoryUsage().rss,node:process.version}}));
});
