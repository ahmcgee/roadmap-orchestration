import assert from 'node:assert/strict';
import {test} from 'node:test';
import {copyFileSync,mkdirSync} from 'node:fs';
import {serveConsole} from '../../src/console/http.ts';
import {gitCommonDir} from '../../src/git/git.ts';
import {absPath} from '../../src/core/values.ts';
import {round4Fixture} from '../fixtures/console-round4.ts';
import {ConsoleBrowser} from '../helpers/console-browser.ts';
import {tmpDir} from '../helpers/repo.ts';
import {until} from '../fixtures/exec-common.ts';
const shots='/tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/webui/shots';
test('round 4: readable recorded journeys and responsive console',{timeout:480000},async t=>{
 const f=await round4Fixture(),dir=tmpDir('console-round4'),b=new ConsoleBrowser(dir);
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(async()=>{await b.close();await s.close();f.close();});await b.initialize();mkdirSync(shots,{recursive:true});
 const body=()=>b.evaluate<string>('()=>document.body.innerText');const dialog=()=>b.evaluate<string>('()=>document.querySelector("[role=dialog]").innerText');
 const wait=(p:RegExp)=>until(async()=>p.test(await body()),12000,p.source);
 const go=async(path='overview')=>{await b.call('browser_navigate',{url:`${s.url}/#/runs/${f.arc}/${path}`});await wait(/Connected/);await b.evaluate('()=>{scrollTo(0,0);return true;}');};
 const click=async(role:string,name:string)=>{const snap=await b.call('browser_snapshot',{}),line=snap.split('\n').findLast(l=>l.includes(`${role} "${name}"`));assert.ok(line,`${role} ${name} absent`);await b.call('browser_click',{element:name,target:/\[ref=(\w+)\]/.exec(line)![1]});};
 const shot=async(name:string)=>{const file=dir+'/'+name+'.png';await b.call('browser_take_screenshot',{filename:file,type:'png',fullPage:!/history|detail|check/.test(name)});copyFileSync(file,shots+'/'+name+'.png');};
 await b.call('browser_resize',{width:1440,height:900});
 await t.test('C1 complete is Done; C2 meaningful waiting and labelled activity; C3 singular; L6 compact heading',async()=>{
  await go();await click('link','Open u1 details');await wait(/Journey/);const text=await dialog();
  assert.match(text,/Complete · attempt 1\s+Done/);assert.doesNotMatch(text,/In progress|1 rounds/);assert.match(text,/1 round ·/);
  assert.equal(await b.evaluate('()=>document.querySelector("#detail-title").textContent'),'u1');assert.match(text,/Publish multiplication support/);
  assert.match(text,/Agent · .* · \$1.25 · .* · Agent history ›/);
  const waits=await b.evaluate<string[]>('()=>[...document.querySelectorAll(".journey-wait")].map(e=>e.innerText)');assert.ok(waits.length>0);assert.ok(waits.every(w=>/Dependency: 1m 20s/.test(w)));await shot('round4-unit-detail');
 });
 await t.test('L1 default journey hides successful housekeeping, exposes failures, toggle restores steps',async()=>{
  await go();await click('link','Open u7 details');await wait(/Journey/);assert.doesNotMatch(await dialog(),/Stop workloads|Collect evidence|Save changes|Check · Check:/);assert.match(await dialog(),/Check: mul/);assert.match(await dialog(),/Release resources.*attempt 2[\s\S]*Cleanup failed/);
  await click('checkbox','Show housekeeping steps');assert.match(await dialog(),/Stop workloads/);assert.match(await dialog(),/Evidence captured/);await click('checkbox','Show housekeeping steps');assert.doesNotMatch(await dialog(),/Collect evidence/);
 });
 await t.test('L1 Activity toggle filters before paging and Recent activity omits successes',async()=>{
  await go();const recent=await b.evaluate<string>('()=>[...document.querySelectorAll(".panel")].find(p=>p.querySelector("h2")?.textContent==="Recent activity").innerText');assert.doesNotMatch(recent,/Stop workloads|Collect evidence|Save changes|Resources released/);assert.match(recent,/Cleanup failed/);
  await click('link','Activity');await wait(/What happened/);await until(async()=>/Cleanup failed/.test(await body()),10000,'failed housekeeping visible');assert.doesNotMatch(await body(),/Stop workloads|Collect evidence|Save changes/);await click('checkbox','Show housekeeping steps');await wait(/Collect evidence/);assert.match(await body(),/Resources released/);await shot('round4-activity');
 });
 await t.test('C4 finished agent has no live control or dangling separator',async()=>{
  await go();await click('link','Open u1 details');await click('link','Build attempt 1: agent history');await wait(/Verified the change/);assert.doesNotMatch(await dialog(),/Follow(ing)? live tail/);assert.equal(await b.evaluate('()=>document.querySelector(".history-links").childNodes[1]?.textContent?.trim()==="·"'),false);await click('button','Show earlier');await wait(/Earlier history/);assert.doesNotMatch(await dialog(),/Follow(ing)? live tail/);await click('button','Show latest');await until(async()=>!/Earlier history/.test(await dialog()),10000,'finished history returns to latest page');await shot('round4-agent-history-finished');
 });
 await t.test('L2 transcript uses at least 60% of drawer, tool disclosures attach once per input',async()=>{
  await go();await click('link','Live agent history: u3');await wait(/Expand full input/);
  const ratio=await b.evaluate<number>('()=>document.querySelector(".history-scroll").getBoundingClientRect().height/document.querySelector(".detailpanel").getBoundingClientRect().height');t.diagnostic(`Transcript uses ${(ratio*100).toFixed(1)}% of the 900px drawer`);assert.ok(ratio>=.6,`transcript/drawer ${ratio}`);
  assert.deepEqual(await b.evaluate('()=>[...document.querySelectorAll(".history-event")].filter(e=>e.textContent.includes("Expand full input")).map(e=>({count:[...e.querySelectorAll("summary")].filter(s=>s.textContent==="Expand full input (preview truncated)").length,attached:!!e.querySelector(".tool-input > details.history-expansion")}))'),[{count:1,attached:true},{count:1,attached:true}]);
  await b.evaluate('()=>{document.querySelector(".tool-input > details.history-expansion").open=true;return true;}');await wait(/Next input page/);assert.match(await b.evaluate<string>('()=>document.querySelector(".tool-input > details.history-expansion pre").textContent'),/long-a/);await b.evaluate('()=>{document.querySelector(".tool-input > details.history-expansion").open=false;return true;}');await shot('round4-agent-history-live');
 });
 await t.test('L3 stage CPU rows grouped by short unit, L4 waiting table and booking text',async()=>{
  await go();await click('link','Time & resources');await wait(/CPU evidence/);assert.match(await body(),/measured stages used under 10%/);assert.match(await body(),/Build · attempt 1 — used 5% of 4 reserved cores/);
  assert.doesNotMatch(await b.evaluate<string>(`()=>document.querySelector('table[aria-label="CPU evidence"]').innerText`),/\d+#\d+|Heavy over-reservation/);
  assert.equal(await b.evaluate(`()=>document.querySelectorAll('table[aria-label="Waiting by reason"] thead th').length`),3);assert.match(await body(),/u10 (held|holds) integration-slot .* at /);await shot('round4-time-resources');
 });
 await t.test('L5 every graph node text stays inside its rectangle, with one state',async()=>{
  await go();const bounds=await b.evaluate<{count:number;bad:string[]}>('()=>{const nodes=[...document.querySelectorAll(".graph g[role=button]")].filter(g=>g.querySelector("text"));return {count:nodes.length,bad:nodes.flatMap(g=>{const r=g.querySelector("rect").getBoundingClientRect();return [...g.querySelectorAll("text")].filter(t=>{const b=t.getBoundingClientRect();return b.left<r.left||b.right>r.right||b.top<r.top||b.bottom>r.bottom;}).map(t=>t.textContent);})};}');assert.ok(bounds.count>0);assert.deepEqual(bounds.bad,[]);assert.doesNotMatch(await b.evaluate<string>('()=>document.querySelector(".graph").textContent'),/Passed · .*Merged|Held · held/);await shot('round4-overview-live');
 });
 for(const [width,height] of [[1024,768],[390,844]])await t.test(`all views at ${width}×${height} fit the page`,async()=>{
  await b.call('browser_resize',{width,height});for(const [name,path,ready] of [['overview-live','overview','Now'],['units','units','Every unit'],['activity','activity','What happened'],['time-resources','resources','CPU evidence'],['attention','attention','Owner decision'],['unit-detail','overview/units/u7','Journey'],['agent-history-live',`overview/invocations/${f.live.routeId}`,'Agent is working'],['agent-history-finished',`overview/invocations/${f.finished.routeId}`,'Finished'],['check-log',`overview/invocations/${f.red.routeId}`,'First output']] as const){await go(path);await wait(new RegExp(ready));if(name==='units')assert.equal(await b.evaluate(`()=>{const a=document.querySelector('table[aria-label="All units"] tbody td a');const height=a.getBoundingClientRect().height;return height>0&&height<=2*parseFloat(getComputedStyle(a).lineHeight)+1;}`),true,'unit intent is at most two lines');assert.equal(await b.evaluate('()=>document.documentElement.scrollWidth<=innerWidth'),true,`${name} page overflows ${width}`);assert.equal(await b.evaluate('()=>{const p=document.querySelector(".detailpanel");return !p||p.scrollWidth<=p.clientWidth;}'),true,`${name} drawer overflows ${width}`);await shot(`round4-${name}-${width}`);}
 });
 await t.test('C4 an invocation settling while the reader is paused can show its latest finished page',async()=>{
  await go();await click('link','Live agent history: u3');await wait(/Agent is working/);for(let n=0;n<55;n++)f.live.append(`Settling history paragraph ${n}`);await wait(/Settling history paragraph 54/);
  await b.evaluate('()=>{document.querySelector(".history-scroll").scrollTop=0;return true;}');await wait(/Follow live tail/);f.finishLive();await wait(/Finished/);await wait(/Show latest/);assert.doesNotMatch(await dialog(),/Follow(ing)? live tail/);await click('button','Show latest');await wait(/Verified the change/);
 });
 f.complete();
 await t.test('finished overview fits desktop and phone',async()=>{for(const [width,height] of [[1440,900],[1024,768],[390,844]]){await b.call('browser_resize',{width,height});await go();await wait(/Outcome/);assert.equal(await b.evaluate('()=>document.documentElement.scrollWidth<=innerWidth'),true);await shot(`round4-overview-finished-${width}`);}});
});
