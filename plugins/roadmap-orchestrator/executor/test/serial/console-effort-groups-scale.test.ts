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
import { effortContributions } from '../../src/console/effort-contributions.ts';
import { ConsoleEffort } from '../../src/console/effort-query.ts';
import { effortShape, effortScopeShape } from '../../src/console/view-shapes.ts';
import { serveConsole } from '../../src/console/http.ts';
import { consoleGet } from '../helpers/console-http.ts';
test('300-unit role/system-set attribution, exhaustive selected evidence, bounded scope reads and repeated browser group/drawer cycles',{timeout:120_000},async t=>{
 const at=performance.now(),m=await generateScaleArc(tmpDir('console-effort-groups-scale')),generationMs=performance.now()-at,release=await ownScaleArc(m);t.after(release);
 const capture=performance.now(),e=new ObservationCache(absPath(m.hostDir),'groups-scale','repo').read({runDir:absPath(m.runDir),arc:arcId(m.arc)}),captureMs=performance.now()-capture;
 assert.equal(e.data.display.status.units.length,300);assert.equal(e.data.display.invocations.length,1088);assert.equal(e.data.events.length,7523);
 const tabs=new ConsoleEffort(),expected=effortContributions(e).map(c=>c.id).sort(),metrics=[];let largestView=0,largestDetail=0;
 for(const group of ['role','system-set'] as const){
  const start=performance.now(),query={window:'arc',group,sort:'spend'},first=tabs.read(e,query),rows=[...first.rows];let p=first;while(p.page.next){p=tabs.read(e,{...query,cursor:p.page.next});rows.push(...p.rows);assert.ok(effortShape(p));}
  const projectionMs=performance.now()-start,serialize=performance.now(),json=JSON.stringify({...e,data:first}),serializationMs=performance.now()-serialize,parse=performance.now();JSON.parse(json);const parseMs=performance.now()-parse;assert.ok(effortShape(first));largestView=Math.max(largestView,Buffer.byteLength(JSON.stringify({...e,data:first}))+1);assert.ok(Math.abs(rows.reduce((n,r)=>n+(r.spend.costUsd??0),0)-e.data.summary.spend.costUsd)<1e-9);
  for(const k of ['agentMs','commandMs','heldMs','queuedMs','unallocatedMs'] as const)assert.equal(rows.reduce((n,r)=>n+(r[k]??0),0),first.totals[k]??0);
  const all:string[]=[];for(const row of rows){let d=tabs.detail(e,row.detailKey!,{...query,section:'measurements',limit:'25'});const ids:string[]=[],amounts=[];
   for(;;){assert.ok(effortScopeShape(d));largestDetail=Math.max(largestDetail,Buffer.byteLength(JSON.stringify({...e,data:d}))+1);ids.push(...d.rows.map(r=>r.id));amounts.push(...d.rows);if(!d.page.next)break;d=tabs.detail(e,row.detailKey!,{...query,section:'measurements',limit:'25',cursor:d.page.next});}
   assert.equal(ids.length,row.contributorCount);assert.equal(new Set(ids).size,ids.length);assert.ok(Math.abs(amounts.reduce((n,c)=>n+(c.spend.costUsd??0),0)-(row.spend.costUsd??0))<1e-9);all.push(...ids);
  }
  assert.deepEqual(all.sort(),expected);metrics.push({group,groups:rows.length,contributions:all.length,projectionMs,serializationMs,parseMs});
 }
 assert.ok(largestView<=128*1024);assert.ok(largestDetail<=32*1024);
 const b=new ConsoleBrowser(tmpDir('console-effort-groups-scale-browser'));t.after(()=>b.close());await b.initialize();await b.call('browser_resize',{width:1440,height:900});
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.addInitScript(()=>{window.__reads=[];const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/api/'))window.__reads.push({url:String(args[0]),status:r.status,atMs:performance.now(),bytes:new TextEncoder().encode(await r.clone().text()).length});return r;};});}`});
 const start=performance.now(),s=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});t.after(()=>s.close());
 await b.call('browser_navigate',{url:`${s.url}/#/arcs/${m.arc}/effort?window=arc&group=role`});await until(async()=>b.evaluate(`()=>document.querySelectorAll('.effort-unit-link').length>0&&document.querySelector('.progress-count')?.textContent.includes('/300')`),10_000,'cold grouped Effort');const usableMs=performance.now()-start;
 let reads=await b.evaluate<{url:string;status:number;bytes:number;atMs:number}[]>(`()=>window.__reads`);assert.deepEqual(reads.filter(r=>r.status===200).map(r=>new URL(r.url,'http://console').pathname.split('/').at(-1)).sort(),['arcs','effort','shell']);
 const selected=performance.now();await b.evaluate(`()=>{document.querySelector('.effort-unit-link').click();return true;}`);await until(async()=>b.evaluate(`()=>!!document.querySelector('.effort-scope-drawer h3')`),5000,'selected scope');const selectedMs=performance.now()-selected,key=await b.evaluate<string>(`()=>location.hash.split('/scopes/')[1].split('?')[0]`);
 reads=await b.evaluate<{url:string;status:number;bytes:number;atMs:number}[]>(`()=>window.__reads`);assert.equal(reads.filter(r=>r.status===200).length,4);assert.ok(reads.find(r=>r.url.includes('/resources/details/'))!.bytes<=32*1024);
 const times:number[]=[];for(let n=0;n<20;n++){const a=performance.now(),r=await consoleGet(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/resources/details/${key}?window=arc&group=role&limit=25`);assert.equal(r.status,200,await r.clone().text());assert.ok(effortScopeShape((await r.json() as {data:unknown}).data));times.push(performance.now()-a);}times.sort((a,b)=>a-b);
 const heaps:number[]=[];let maxDom=0;for(let n=0;n<12;n++){
  await b.evaluate(`()=>{document.querySelector('[aria-label="Close details"]').click();const select=document.querySelector('[aria-label="Effort group"]');select.value='${n%2?'role':'system-set'}';select.dispatchEvent(new Event('change',{bubbles:true}));return true;}`);
  await until(async()=>b.evaluate(`()=>document.querySelectorAll('.effort-unit-link').length>0&&document.querySelector('table[aria-label="All units"]').textContent.includes('${n%2?'Recorded role':'System set'}')`),5000,'group switch');
  await b.evaluate(`()=>{document.querySelector('.effort-unit-link').click();return true;}`);await until(async()=>b.evaluate(`()=>!!document.querySelector('.effort-scope-drawer h3')`),5000,'scope cycle');maxDom=Math.max(maxDom,await b.evaluate<number>(`()=>document.querySelectorAll('*').length`));
  if(n===3||n===11){await b.call('browser_run_code_unsafe',{code:'async(page)=>{const c=await page.context().newCDPSession(page);await c.send("HeapProfiler.collectGarbage");await c.detach();}'});heaps.push(await b.evaluate<number>(`()=>performance.memory.usedJSHeapSize`));}
 }
 assert.ok(maxDom<6000);assert.ok(heaps[1]!-heaps[0]!<12*1024*1024);await b.call('browser_resize',{width:390,height:844});assert.equal(await b.evaluate(`()=>document.documentElement.scrollWidth<=innerWidth`),true);
 console.log(JSON.stringify({effortGroupsScale:{generationMs,captureMs,metrics,largestView,largestDetail,coldBytes:reads.filter(r=>r.status===200&&!r.url.endsWith('/arcs')&&!r.url.includes('/resources/details/')).reduce((n,r)=>n+r.bytes,0),selectedBodyBytes:reads.find(r=>r.url.includes('/resources/details/'))!.bytes,shellBodyMs:reads.find(r=>r.url.includes('/shell'))!.atMs,usableMs,selectedMs,warmScopeP95Ms:times[18],maxDom,heaps,rss:process.memoryUsage().rss,node:process.version}}));
});
