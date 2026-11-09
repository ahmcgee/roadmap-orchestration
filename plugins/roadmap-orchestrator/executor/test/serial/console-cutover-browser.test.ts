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
import { needsUserPath, needsUserAckPath } from '../../src/needsuser.ts';
import { needsUserRecord, needsUserAck } from '../../src/core/records.ts';
import { consoleGet } from '../helpers/console-http.ts';

test('Activity independently announces file-only requests without moving journal pages or fetching Attention', {timeout:60_000}, async t=>{
 const f=await investigationFixture();t.after(()=>f.close());
 for(let n=0;n<60;n++){const p=f.begin('u7','build');f.journal.fact({kind:'stage-outcome',unit:p.unit,stage:'build',attempt:p.attempt,outcome:'success',class:'advance',chargeable:false});}
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const evidenceDir=tmpDir('console-current-request-notice'),b=new ConsoleBrowser(evidenceDir);t.after(()=>b.close());await b.initialize();await b.call('browser_resize',{width:1440,height:900});
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.addInitScript(()=>{window.__reads=[];const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/api/'))window.__reads.push({url:String(args[0]),status:r.status});return r;};});}`});
 const wait=(expr:string,label:string)=>until(async()=>b.evaluate(`()=>${expr}`),10_000,label);
 const click=(label:string)=>b.evaluate(`()=>{[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(label)}).click();return true;}`);
 await b.call('browser_navigate',{url:`${s.url}/#/arcs/${f.arc}/activity?window=arc&limit=25`});await wait(`document.querySelectorAll('.activity-feed li').length===25&&document.querySelector('.connection')?.textContent==='Connected'`,'Activity connected');
 assert.equal(await b.evaluate(`()=>!!document.querySelector('.activity-current-requests [role="status"]')`),false,'initial notice is deduplicated');
 await click('Earlier activity');await wait(`location.hash.includes('cursor=')`,'older page');
 const page=()=>b.evaluate<string>(`()=>JSON.stringify({anchor:document.querySelector('.activity-anchor').textContent,rows:[...document.querySelectorAll('.activity-feed a')].map(a=>[a.href,a.textContent])})`);
 await b.evaluate(`()=>{document.getElementById('content').scrollTop=450;return true;}`);const before=await page(),scroll=await b.evaluate<number>(`()=>document.getElementById('content').scrollTop`),top=await b.evaluate<number>(`()=>document.querySelector('.activity-feed').getBoundingClientRect().top`);
 const journal=join(f.runDir,'events.jsonl'),bytes=readFileSync(journal),base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
 const metadata=async()=>await(await consoleGet(`${base}/metadata`)).json() as {epoch:string;highWater:number};const initial=await metadata();
 const file=needsUserRecord({v:2,id:'sup-1-1',arc:f.arc,raisedAt:'2026-10-01T00:00:00.000Z',blocking:true,subject:{type:'host'},reason:'supervisor-crash-limit',summary:'Current file-only host request',recommendation:'Inspect the host.',options:[],evidence:[]},'current request fixture');writeFileSync(needsUserPath(f.runDir,file.id),JSON.stringify(file));
 await wait(`document.querySelector('.activity-current-requests')?.textContent.includes('Current human requests may have changed')&&document.querySelector('.tab-badge')?.textContent==='4'`,'independent current request notice');
 assert.equal(await page(),before);assert.equal(await b.evaluate<number>(`()=>document.getElementById('content').scrollTop`),scroll);assert.ok(Math.abs(await b.evaluate<number>(`()=>document.querySelector('.activity-feed').getBoundingClientRect().top`)-top)<2);
 assert.equal((await metadata()).highWater,initial.highWater);assert.deepEqual(readFileSync(journal),bytes);

 // Retain both actual notice states for visual review, using real file-only
 // fixture records and the public theme control, without a production hook.
 await b.evaluate(`()=>{document.getElementById('content').scrollTop=0;document.querySelector('[aria-label^="Theme:"]').click();return true;}`);
 await wait(`document.documentElement.dataset.theme==='light'`,'light request notice');
 await b.call('browser_take_screenshot',{filename:join(evidenceDir,'notice-light.png'),fullPage:false,scale:'css'});
 await b.evaluate(`()=>{document.querySelector('[aria-label^="Theme:"]').click();return true;}`);await wait(`document.documentElement.dataset.theme==='dark'`,'dark request notice');
 await b.call('browser_take_screenshot',{filename:join(evidenceDir,'notice-dark.png'),fullPage:false,scale:'css'});
 await b.evaluate(`()=>{document.getElementById('content').scrollTop=${scroll};return true;}`);
 t.diagnostic(JSON.stringify({requestNoticeShots:[join(evidenceDir,'notice-light.png'),join(evidenceDir,'notice-dark.png')]}));

 const reads=await b.evaluate<{url:string;status:number}[]>(`()=>window.__reads`);assert.ok(!reads.some(r=>/\/(attention|requests|status|snapshot)(?:\/|\?|$)/.test(r.url)));assert.equal(reads.filter(r=>r.url.includes('activity/changes')).length,0,'file-only change does not pretend to be a journal append');
 await click('Dismiss request notice');assert.equal(await b.evaluate(`()=>!!document.querySelector('.activity-current-requests [role="status"]')`),false);
 writeFileSync(needsUserPath(f.runDir,file.id),JSON.stringify({...file,recommendation:'Inspect the retained host evidence.'}));await wait(`!!document.querySelector('.activity-current-requests [role="status"]')`,'same-count request update');
 await b.evaluate(`()=>{document.querySelector('.activity-current-requests a').click();return true;}`);await wait(`document.querySelector('table[aria-label="Open human requests"]')?.textContent.includes('Current file-only host request')`,'notice opens current Attention');
 await b.evaluate(`()=>{history.back();return true;}`);await wait(`!!document.querySelector('.activity-feed')`,'Back to captured Activity');assert.equal(await page(),before);assert.ok(Math.abs(await b.evaluate<number>(`()=>document.getElementById('content').scrollTop`)-scroll)<4);
 await click('Holistic review');await wait(`!!document.querySelector('[aria-label="Holistic sections"]')`,'Holistic');
 const ack=needsUserAck({v:2,id:file.id,command:'cmd-0000000000000004',choice:null,at:new Date().toISOString()},'current request acknowledgement');writeFileSync(needsUserAckPath(f.runDir,file.id),JSON.stringify(ack));
 await wait(`!!document.querySelector('.activity-current-requests [role="status"]')&&document.querySelector('.tab-badge')?.textContent==='3'`,'request settlement on Holistic');assert.deepEqual(readFileSync(journal),bytes);
 await b.call('browser_resize',{width:390,height:844});assert.equal(await b.evaluate(`()=>document.documentElement.scrollWidth<=innerWidth`),true);await b.call('browser_resize',{width:1440,height:900});
 // Replacement invalidates the local comparison; no stale request notice survives a new epoch.
 writeFileSync(journal+'.replacement',bytes);renameSync(journal+'.replacement',journal);
 await until(async()=>(await metadata()).epoch!==initial.epoch,10_000,'new epoch');await wait(`!document.querySelector('.activity-current-requests [role="status"]')`,'request comparison reset');
});

test('expanded CPU and resource evidence preserve captured values, disclosure, scroll and Back across append and explicit reset', {timeout:60_000}, async t=>{
 const f=await investigationFixture();t.after(()=>f.close());const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
 const b=new ConsoleBrowser(tmpDir('console-cutover-resource-state'));t.after(()=>b.close());await b.initialize();await b.call('browser_resize',{width:1440,height:900});
 const wait=(expr:string,label:string)=>until(async()=>b.evaluate(`()=>${expr}`),10_000,label);
 await b.call('browser_navigate',{url:`${s.url}/#/arcs/${f.arc}/resources?section=cpu&window=arc`});await wait(`!!document.querySelector('table[aria-label="CPU evidence"] details[open]')`,'expanded CPU');
 await b.evaluate(`()=>{document.getElementById('content').scrollTop=600;document.querySelector('table[aria-label="CPU evidence"] .resource-primary-link').focus({preventScroll:true});return true;}`);
 const cpu=await b.evaluate<string>(`()=>document.querySelector('table[aria-label="CPU evidence"]').textContent`),scroll=await b.evaluate<number>(`()=>document.getElementById('content').scrollTop`);
 await b.call('browser_press_key',{key:'Enter'});await wait(`!!document.querySelector('.resource-detail-drawer h3')`,'CPU detail');
 const evidence=await b.evaluate<string>(`()=>document.querySelector('table[aria-label="Selected resource evidence"]').textContent`);await b.evaluate(`()=>{document.querySelector('.drawer-body').scrollTop=350;return true;}`);const drawerScroll=await b.evaluate<number>(`()=>document.querySelector('.drawer-body').scrollTop`);
 f.finishLive();await wait(`document.body.innerText.includes('Updates available')`,'CPU append notice');
 assert.equal(await b.evaluate(`()=>document.querySelector('table[aria-label="CPU evidence"]').textContent`),cpu);assert.equal(await b.evaluate(`()=>document.querySelector('table[aria-label="Selected resource evidence"]').textContent`),evidence);
 await b.evaluate(`()=>{document.querySelector('table[aria-label="Selected resource evidence"] a[href*="/units/"]').click();return true;}`);await wait(`!!document.querySelector('.unit-meta')`,'selected evidence unit');
 await b.evaluate(`()=>{history.back();return true;}`);await wait(`!!document.querySelector('.resource-detail-drawer h3')`,'Back to CPU evidence');assert.equal(await b.evaluate(`()=>document.querySelector('table[aria-label="Selected resource evidence"]').textContent`),evidence);assert.ok(Math.abs(await b.evaluate<number>(`()=>document.querySelector('.drawer-body').scrollTop`)-drawerScroll)<4);
 await b.call('browser_press_key',{key:'Escape'});assert.ok(Math.abs(await b.evaluate<number>(`()=>document.getElementById('content').scrollTop`)-scroll)<4);assert.equal(await b.evaluate(`()=>!!document.querySelector('table[aria-label="CPU evidence"] details[open]')`),true);
 await b.evaluate(`()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='Reset view').click();return true;}`);await wait(`!location.hash.includes('window=arc')&&!!document.querySelector('table[aria-label="CPU evidence"]')`,'explicit Resource reset');
 // A resource ownership selection remains readable when the captured history becomes terminal.
 await b.evaluate(`()=>{[...document.querySelectorAll('[aria-label="Resource sections"] button')].find(b=>b.textContent==='Schedule').click();return true;}`);await wait(`!!document.querySelector('table[aria-label="Resource bookings"] .resource-primary-link')`,'Schedule');
 await b.evaluate(`()=>{document.querySelector('table[aria-label="Resource bookings"] .resource-primary-link').click();return true;}`);await wait(`!!document.querySelector('.resource-detail-drawer h3')`,'booking detail');const booking=await b.evaluate<string>(`()=>document.querySelector('table[aria-label="Selected resource evidence"]').textContent`);
 f.complete();await wait(`document.querySelector('.resources-panel')?.textContent.includes('Finished arc')`,'completion on captured Resources');const terminal=await b.evaluate<string>(`()=>document.querySelector('table[aria-label="Selected resource evidence"]').textContent`);assert.equal(terminal.split('Open for ')[0],booking.split('Open for ')[0]);assert.match(terminal,/Clipped at Arc end; release not recorded/);await new Promise(r=>setTimeout(r,1100));assert.equal(await b.evaluate(`()=>document.querySelector('table[aria-label="Selected resource evidence"]').textContent`),terminal);
});
