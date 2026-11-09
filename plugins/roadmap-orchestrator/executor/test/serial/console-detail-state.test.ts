import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { investigationFixture } from '../fixtures/console-investigations.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';
import { absPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { serveConsole } from '../../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import { consoleGet } from '../helpers/console-http.ts';

test('paged and expanded detail, tab sorting and reading position survive append and Back; epoch reset clears old detail', {timeout:90_000}, async t=>{
 const f=await investigationFixture(60,{},60);t.after(()=>f.close());
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const b=new ConsoleBrowser(tmpDir('console-detail-state'),{settleMs:100});t.after(()=>b.close());await b.initialize();
 await b.call('browser_resize',{width:1440,height:900});
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.addInitScript(()=>{window.__details=[];const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/units/')){const d=await r.clone().json();window.__details.push({url:String(args[0]),highWater:d.highWater,epoch:d.epoch});}return r;};});}`});
 const nav=async(tail:string)=>{await b.evaluate(tail==='effort'?`()=>{[...document.querySelectorAll('.tabs a')].find(a=>a.textContent==='Effort').click();return true;}`:`()=>{location.hash='#/arcs/${f.arc}/${tail}';return true;}`);};
 const ready=async(id:string)=>until(async()=>b.evaluate(`()=>!!document.querySelector('.drawer .unit-meta')?.textContent.includes('${id}')`),10_000,`detail ${id}`);
 await b.call('browser_navigate',{url:`${s.url}/#/arcs/${f.arc}/graph/units/u1`});await ready('u1');
 await b.evaluate(`()=>{[...document.querySelectorAll('.drawer button')].find(e=>e.textContent==='Show more (25 of 60)').click();return true;}`);
 await until(async()=>b.evaluate(`()=>[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (50 of 60)')`),5000,'acceptance second page');
 await b.evaluate(`()=>{document.querySelector('.journey-details').open=true;document.querySelector('.drawer-body').scrollTop=500;return true;}`);
 await until(async()=>b.evaluate(`()=>document.querySelector('.journey-details').open&&document.querySelector('.drawer-body').scrollTop>400`),5000,'expanded reading position');
 const position=await b.evaluate<number>(`()=>document.querySelector('.drawer-body').scrollTop`);
 await nav('graph/units/milestone%3AMS-1');await until(async()=>b.evaluate(`()=>!!document.querySelector('.outstanding-units')`),5000,'milestone');
 await b.evaluate(`()=>{history.back();return true;}`);await ready('u1');
 assert.equal(await b.evaluate(`()=>document.querySelector('.journey-details').open`),true);
 assert.equal(await b.evaluate(`()=>[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (50 of 60)')`),true);
 assert.ok(Math.abs(await b.evaluate<number>(`()=>document.querySelector('.drawer-body').scrollTop`)-position)<4);
 const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`,before=await (await consoleGet(`${base}/metadata`)).json() as any;
 f.finishLive(); // A real recorded append on u3 must not discard u1's anchored page.
 await until(async()=>{const m=await (await consoleGet(`${base}/metadata`)).json() as any;return m.highWater>before.highWater;},5000,'append verification');
 await until(async()=>b.evaluate(`()=>window.__details.some(d=>d.url.includes('/units/u1')&&d.highWater>${before.highWater})`),8000,'detail revalidation after append');
 assert.equal(await b.evaluate(`()=>document.querySelector('.journey-details').open`),true);
 assert.equal(await b.evaluate(`()=>[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (50 of 60)')`),true);
 await b.evaluate(`()=>{[...document.querySelectorAll('.drawer button')].find(e=>e.textContent==='Show more (50 of 60)').click();return true;}`);
 await until(async()=>b.evaluate(`()=>document.querySelectorAll('.drawer section li').length>=60&&!document.body.innerText.includes('Show more (50 of 60)')`),5000,'anchored final page after unrelated append');
 await nav('effort');await until(async()=>b.evaluate(`()=>!!document.querySelector('[aria-label="All units"]')`),10_000,'Effort');
 await b.evaluate(`()=>{document.querySelector('[aria-label="Sort by red checks"]').click();return true;}`);
 await until(async()=>b.evaluate(`()=>document.querySelector('[aria-label="Sort by red checks"]').closest('th').getAttribute('aria-sort')==='descending'`),5000,'server Effort ranking');
 await b.evaluate(`()=>{document.getElementById('content').scrollTop=700;return true;}`);
 const first=await b.evaluate<string>(`()=>document.querySelector('[aria-label="All units"] tbody tr td').textContent`),scroll=await b.evaluate<number>(`()=>document.getElementById('content').scrollTop`);
 await nav('graph');await until(async()=>b.evaluate(`()=>!!document.querySelector('.dag-canvas canvas')`),5000,'Graph return');
 await b.evaluate(`()=>{history.back();return true;}`);
 await until(async()=>b.evaluate(`()=>!!document.querySelector('[aria-label="All units"] th[aria-sort="descending"]')`),5000,'sort return');
 assert.equal(await b.evaluate(`()=>document.querySelector('[aria-label="All units"] tbody tr td').textContent`),first);
 assert.ok(Math.abs(await b.evaluate<number>(`()=>document.getElementById('content').scrollTop`)-scroll)<4);
 // Repeated production navigations and drawer cycles, with Chromium GC only in
 // the test driver, measure retained heap rather than arbitrary GC scheduling.
 const heaps:number[]=[];let maxDom=0;
 for(let n=0;n<16;n++){
  await nav(`graph/units/u${n%10+1}`);await ready(`u${n%10+1}`);
  await nav('effort');await until(async()=>b.evaluate(`()=>!!document.querySelector('[aria-label="All units"]')`),5000,'cycle Effort');
  maxDom=Math.max(maxDom,await b.evaluate<number>('()=>document.getElementsByTagName("*").length'));
  if(n===3||n===15){await b.call('browser_run_code_unsafe',{code:'async(page)=>{const c=await page.context().newCDPSession(page);await c.send("HeapProfiler.collectGarbage");await c.detach();}'});heaps.push(await b.evaluate<number>('()=>performance.memory.usedJSHeapSize'));}
 }
 assert.ok(maxDom<6000,`bounded DOM ${maxDom}`);assert.ok(heaps[1]!-heaps[0]!<12*1024*1024,`heap growth ${heaps}`);
 await nav('graph/units/u1');await ready('u1');
 assert.equal(await b.evaluate(`()=>[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (25 of 60)')`),true,'u1 pages were evicted from the eight-entity return cache');
 // Exercise the server's real bounded generation eviction and its UI recovery.
 for(let n=0;n<70;n++){const response=await consoleGet(`${base}/units/u2`);assert.equal(response.status,200);await response.arrayBuffer();}
 await b.evaluate(`()=>{[...document.querySelectorAll('.drawer button')].find(e=>e.textContent==='Show more (25 of 60)').click();return true;}`);
 await until(async()=>b.evaluate(`()=>!!document.querySelector('.drawer [role="alert"]')?.textContent.includes('expired')`),5000,'evicted page gives explicit reset');
 await b.evaluate(`()=>{[...document.querySelectorAll('.drawer button')].find(e=>e.textContent==='Reload detail').click();return true;}`);
 await ready('u1');
 await until(async()=>b.evaluate(`()=>!document.querySelector('.drawer [role="alert"]')&&[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (25 of 60)')`),5000,'detail reload admits a fresh cursor');
 await b.evaluate(`()=>{[...document.querySelectorAll('.drawer button')].find(e=>e.textContent==='Show more (25 of 60)').click();return true;}`);
 await until(async()=>b.evaluate(`()=>[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (50 of 60)')`),5000,'paging recovers after eviction');
 await b.evaluate(`()=>{document.querySelector('.journey-details').open=true;return true;}`);
 const journal=join(f.runDir,'events.jsonl'),bytes=readFileSync(journal);writeFileSync(journal+'.replacement',bytes);renameSync(journal+'.replacement',journal);
 await until(async()=>{const m=await (await consoleGet(`${base}/metadata`)).json() as any;return m.epoch!==before.epoch;},8000,'replacement epoch');
 await until(async()=>b.evaluate(`()=>!!document.querySelector('.drawer .unit-meta')&&!document.querySelector('.journey-details').open`),10_000,'reset discards expanded old detail');
 assert.equal(await b.evaluate(`()=>[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (25 of 60)')`),true);
 await nav('effort');await until(async()=>b.evaluate(`()=>!!document.querySelector('[aria-label="All units"] th[aria-sort="descending"]')`),5000,'sort preference after reset');
 assert.doesNotMatch(await b.evaluate<string>('()=>document.body.innerText'),/Console rendering failed|foreign detail cursor/);
 t.diagnostic(JSON.stringify({cycles:16,heapBytes:heaps,maxDom,detailScroll:position,tabScroll:scroll}));
});

test('long recorded acceptance remains exactly readable through bounded HTTP field continuation and Back', {timeout:45_000}, async t=>{
 const long='Recorded acceptance: '+('Unicode 𝄞界 and escaped "evidence". '.repeat(600));
 const f=await investigationFixture(14,{u1:long},60);t.after(()=>f.close());
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const b=new ConsoleBrowser(tmpDir('console-detail-fields'),{settleMs:100});t.after(()=>b.close());await b.initialize();
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.addInitScript(()=>{window.__fieldBytes=[];const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/units/'))window.__fieldBytes.push(new TextEncoder().encode(await r.clone().text()).length);return r;};});}`});
 await b.call('browser_navigate',{url:`${s.url}/#/arcs/${f.arc}/graph/units/u1`});
 await until(async()=>b.evaluate(`()=>!!document.querySelector('.detail-continuations')`),10_000,'field continuation affordance');
 const read=`()=>[...document.querySelectorAll('.drawer section')].find(e=>e.querySelector('h3')?.textContent==='Acceptance')?.querySelector('li')?.textContent??''`;
 assert.ok((await b.evaluate<string>(read)).length<long.length);
 for(let n=0;n<20;n++){
  const length=(await b.evaluate<string>(read)).length;if(length===long.length)break;
  await b.evaluate(`()=>{[...document.querySelectorAll('.detail-continuations button')].find(e=>e.textContent==='Read more acceptance · 1').click();return true;}`);
  await until(async()=>(await b.evaluate<string>(read)).length>length,5000,'next exact acceptance part');
 }
 assert.equal(await b.evaluate(read),long);
 await b.evaluate(`()=>{[...document.querySelectorAll('.drawer button')].find(e=>e.textContent==='Show more (25 of 60)').click();return true;}`);
 await until(async()=>b.evaluate(`()=>[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (50 of 60)')`),5000,'second acceptance page');
 await b.evaluate(`()=>{location.hash='#/arcs/${f.arc}/graph/units/u2';return true;}`);
 await until(async()=>b.evaluate(`()=>!!document.querySelector('.drawer .unit-meta')?.textContent.includes('u2')`),5000,'next unit');
 await b.evaluate(`()=>{history.back();return true;}`);
 await until(async()=>b.evaluate(`()=>!!document.querySelector('.drawer .unit-meta')?.textContent.includes('u1')`),5000,'restored full field');
 assert.equal(await b.evaluate(read),long);
 assert.equal(await b.evaluate(`()=>[...document.querySelectorAll('.drawer button')].some(e=>e.textContent==='Show more (50 of 60)')`),true);
 const bytes=await b.evaluate<number[]>('()=>window.__fieldBytes');assert.ok(bytes.length>4);assert.ok(bytes.every(n=>n<=64*1024));
 t.diagnostic(JSON.stringify({recordedCharacters:long.length,selectedReads:bytes.length,maximumDecodedBytes:Math.max(...bytes)}));
});
