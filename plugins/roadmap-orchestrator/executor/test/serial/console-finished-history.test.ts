import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { consoleAgentFixture } from '../fixtures/console-agent.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';
test('finished history browser regressions with a real-sized retained stream',{timeout:90_000},async t=>{
 const f=await consoleAgentFixture();
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});const evidence=tmpDir('console-finished');const b=new ConsoleBrowser(evidence);
 t.after(async()=>{await b.close();await s.close();f.close();});await b.initialize();
 const url=`${s.url}/#/arcs/${f.arc}/graph/invocations/${f.routeId}`;const text=()=>b.evaluate<string>('() => document.body.innerText');
 const shots='/tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/webui/shots';
 await t.test('live tail and its working caret fit inside the default browser viewport',async()=>{
  await b.call('browser_navigate',{url});await until(async()=>/Agent is working/.test(await text()),12000,'live caret');f.append('Live message arrived while the agent is still working.');await until(async()=>/Live message arrived/.test(await text()),10000,'live append');
  assert.equal(await b.evaluate('() => { const r=document.querySelector(".history-live").getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight; }'),true);
  await b.call('browser_take_screenshot',{type:'png',filename:evidence+'/live.png',fullPage:false});copyFileSync(evidence+'/live.png',shots+'/agent-history-live.png');
 });
 for(let n=0;n<350;n++)f.append(`Recorded paragraph ${n}: ${'complete recorded evidence '.repeat(70)}`);f.finish();
 await t.test('B1 hundreds of KB finish loading instead of remaining Connecting',async()=>{await b.call('browser_navigate',{url});await until(async()=>/Finished/.test(await text())&&/Verified the change/.test(await text()),15_000,'finished retained history through small SSE notices');assert.doesNotMatch(await text(),/Connecting/);assert.match(await text(),/Load 50 earlier events/);await b.call('browser_take_screenshot',{type:'png',filename:evidence+'/finished.png',fullPage:false});copyFileSync(evidence+'/finished.png',shots+'/agent-history-finished.png');});
 await t.test('B2 transcript text is decoded, escaped and paged, with no raw JSON API link',async()=>{
  await b.call('browser_navigate',{url});await until(async()=>await b.evaluate('()=>document.querySelector("#detail-title")?.textContent==="Build, attempt 1"&&document.querySelector(".history-scroll")?.getAttribute("aria-label")==="Agent transcript"'),12_000,'agent history invocation and transcript view');
  assert.match(await text(),/Transcript text/);assert.doesNotMatch(await text(),/Raw transcript/);
  await b.evaluate('() => { [...document.querySelectorAll("summary")].find(s=>s.textContent==="Transcript text").parentElement.open=true;return true;}');await until(async()=>/Bytes 0/.test(await text()),10_000,'decoded transcript page');
  assert.match(await text(),/tool_use/);assert.match(await text(),/Next text page/);assert.equal(await b.evaluate('() => document.querySelectorAll("[role=dialog] script,[role=dialog] img").length'),0);
  assert.equal(await b.evaluate('() => [...document.querySelectorAll("a")].some(a=>a.textContent==="Raw transcript"&&a.href.includes("/api/"))'),false);
  const first=await b.evaluate<string>('() => [...document.querySelectorAll("details")].find(d=>d.querySelector("summary")?.textContent==="Transcript text").querySelector("pre").textContent');
  assert.equal(first,readFileSync(f.transcript).subarray(0,65536).toString('utf8'));
  await b.evaluate('() => { [...document.querySelectorAll("button")].find(b=>b.textContent==="Next text page").click();return true;}');await until(async()=>/Bytes 65536/.test(await text()),10_000,'second text page');assert.match(await text(),/Show earlier text/);
 });
 await t.test('unstructured check output keeps search and omits invented severity counts',async()=>{
  const version=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
  const e=await(await fetch(`${s.url}/api/${version}/arcs/${f.arc}/snapshot`)).json() as {data:{console:{activities:{kind:string;unit:string;routeId:string}[]}}};
  const command=e.data.console.activities.find(a=>a.kind==='deterministic'&&a.unit==='u1')!;
  writeFileSync(`${f.runDir}/inv/${command.routeId}/stdout`,'Warning: recorded text, severity metadata unavailable\n');
  await b.call('browser_navigate',{url:`${s.url}/#/arcs/${f.arc}/graph/invocations/${command.routeId}`});
  await until(async()=>/First output on this page/.test(await text()),10000,'readable command output');
  assert.match(await text(),/severity metadata unavailable/);assert.match(await b.call('browser_snapshot',{}),/Search log lines/);
  assert.doesNotMatch(await b.call('browser_snapshot',{}),/group "Levels"/);
  assert.equal(await b.evaluate('() => document.querySelectorAll("[aria-label=Levels]").length'),0);
 });

});
