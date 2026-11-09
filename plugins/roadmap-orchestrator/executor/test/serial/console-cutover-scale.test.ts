import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { until } from '../fixtures/exec-common.ts';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import { consoleGet } from '../helpers/console-http.ts';

type Read={url:string;status:number;bytes:number;atMs:number};
const pathname=(url:string)=>new URL(url,'http://console').pathname;
test('all six typed routes meet combined cold/deep-link request and decoded budgets on the 300-unit week; cycles bound browser and isolated worker-host memory',{timeout:180_000},async t=>{
 const generationStart=performance.now(),m=await generateScaleArc(tmpDir('console-cutover-scale')),generationMs=performance.now()-generationStart,release=await ownScaleArc(m);t.after(release);
 assert.equal(m.units,300);assert.equal(m.milestones,10);assert.equal(m.invocations,1088);assert.equal(m.events,7523);
 const common=gitCommonDir(absPath(m.repo)),args={repo:absPath(m.repo),common,hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0};
 const b=new ConsoleBrowser(tmpDir('console-cutover-scale-browser'));t.after(()=>b.close());await b.initialize();await b.call('browser_resize',{width:1440,height:900});
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.addInitScript(()=>{window.__reads=[];window.__streams=[];const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/api/'))window.__reads.push({url:String(args[0]),status:r.status,bytes:new TextEncoder().encode(await r.clone().text()).length,atMs:performance.now()});return r;};const Original=window.EventSource;window.EventSource=class extends Original{constructor(url,...args){super(url,...args);window.__streams.push(String(url));}};});}`});
 const wait=(expr:string,label:string)=>until(async()=>b.evaluate(`()=>${expr}`),10_000,label);
 const routes=[
  {name:'graph',hash:'graph',endpoint:'graph',budget:264,ready:`!!document.querySelector('.dag-canvas canvas')`,link:`null`},
  {name:'activity',hash:'activity',endpoint:'activity',budget:72,ready:`!!document.querySelector('.activity-anchor')`,link:`document.querySelector('.activity-feed a')?.getAttribute('href')`},
  {name:'holistic',hash:'activity?view=holistic',endpoint:'holistic',budget:72,ready:`!!document.querySelector('table[aria-label="Holistic audits"] tbody tr')`,link:`document.querySelector('table[aria-label="Holistic audits"] a')?.getAttribute('href')`},
  {name:'timeline',hash:'timeline',endpoint:'timeline',budget:136,ready:`!!document.querySelector('table[aria-label="Invocation timeline"] tbody tr')`,link:`document.querySelector('table[aria-label="Invocation timeline"] a')?.getAttribute('href')`},
  {name:'effort',hash:'effort',endpoint:'effort',budget:136,ready:`!!document.querySelector('table[aria-label="All units"] tbody tr')`,link:`document.querySelector('table[aria-label="All units"] a')?.getAttribute('href')`},
  {name:'resources',hash:'resources',endpoint:'resources',budget:136,ready:`!!document.querySelector('table[aria-label="Resource bookings"]')`,link:`document.querySelector('table[aria-label="Resource bookings"] .resource-primary-link')?.getAttribute('href')`},
  {name:'attention',hash:'attention',endpoint:'attention',budget:56,ready:`!!document.querySelector('table[aria-label="Open human requests"] tbody tr')`,link:`document.querySelector('.request-link')?.getAttribute('href')`},
 ];
 const measurements:Record<string,unknown>={},deepLinks:{name:string;hash:string;endpoint:string;budget:number;detail:string;detailBudget:number}[]=[];
 for(const r of routes){
  await b.call('browser_navigate',{url:'about:blank'});const at=performance.now(),s=await serveConsole(args);
  try{
   await b.call('browser_navigate',{url:`${s.url}/#/arcs/${m.arc}/${r.hash}`});await wait(`${r.ready}&&document.querySelector('.progress-count')?.textContent.includes('/300')&&document.querySelector('.connection')?.textContent==='Connected'`,r.name+' cold').catch(async error=>{t.diagnostic(await b.evaluate(`()=>JSON.stringify({hash:location.hash,text:document.body.innerText,reads:window.__reads})`));throw error;});
   const usableMs=performance.now()-at;
   // Allow the initial SSE metadata and heartbeat to arrive before counting; neither may duplicate a view read.
   await b.evaluate(`()=>new Promise(resolve=>setTimeout(()=>resolve(true),1100))`);
   const reads=await b.evaluate<Read[]>(`()=>window.__reads`),success=reads.filter(v=>v.status===200);
   assert.deepEqual(success.map(v=>new URL(v.url,'http://console').pathname.split('/').at(-1)).sort(),['arcs','shell',r.endpoint].sort(),JSON.stringify({route:r.name,reads}));
   assert.ok(reads.every(v=>(v.status===200||v.status===202)&&['arcs','shell',r.endpoint].includes(pathname(v.url).split('/').at(-1)!)),JSON.stringify(reads));
   assert.equal(await b.evaluate(`()=>window.__streams.length`),1,'one metadata stream');
   const body=success.filter(v=>!pathname(v.url).endsWith('/arcs')).reduce((n,v)=>n+v.bytes,0);assert.ok(body<=r.budget*1024,`${r.name}: ${body}`);
   assert.ok(success.find(v=>pathname(v.url).endsWith('/arcs'))!.bytes<=1024);assert.ok(success.find(v=>/\/shell(?:\?|$)/.test(v.url))!.bytes<=8*1024);
   const link=await b.evaluate<string|null>(`()=>(${r.link})??null`);if(link&&!['activity','holistic','resources'].includes(r.name))deepLinks.push({name:r.name,hash:link,endpoint:r.endpoint,budget:r.budget,detail:r.name==='resources'?'resources/details/':r.name==='activity'||r.name==='holistic'?'activity/':r.name==='attention'?'requests/':'units/',detailBudget:r.name==='resources'||r.name==='activity'||r.name==='holistic'||r.name==='attention'?32:64});
   const warmUrl=new URL(success.find(v=>pathname(v.url).endsWith('/'+r.endpoint))!.url,s.url);warmUrl.searchParams.delete('pending');
   const warm:number[]=[];for(let n=0;n<20;n++){const start=performance.now(),response=await consoleGet(warmUrl.toString());assert.equal(response.status,200);await response.json();warm.push(performance.now()-start);}warm.sort((a,b)=>a-b);
   measurements[r.name]={warmP95Ms:warm[18],bytes:body,shellMs:success.find(v=>/\/shell(?:\?|$)/.test(v.url))!.atMs,usableMs,requests:success.map(v=>v.url),dom:await b.evaluate(`()=>document.querySelectorAll('*').length`)};
   await b.call('browser_resize',{width:390,height:844});assert.equal(await b.evaluate(`()=>document.documentElement.scrollWidth<=innerWidth`),true,r.name+' narrow');await b.call('browser_resize',{width:1440,height:900});
   t.diagnostic(JSON.stringify({coldRoute:r.name,...measurements[r.name] as object}));
  }finally{await b.call('browser_navigate',{url:'about:blank'});await s.close();}
 }
 // All deep links are discovered from actual typed rows, with no fabricated keys.
 const s=await serveConsole(args);t.after(()=>s.close());const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}`;
 const get=async(path:string)=>{const response=await consoleGet(`${base}/${path}`);assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).data;};
 const holistic=await get('holistic?section=audits');deepLinks.push({name:'holistic',hash:`#/arcs/${m.arc}/activity/events/${holistic.rows[0].detail.id}?view=holistic`,endpoint:'holistic',budget:72,detail:'activity/',detailBudget:32});
 const activity=await get('activity?window=arc');deepLinks.push({name:'activity-event',hash:`#/arcs/${m.arc}/activity/events/${activity.rows[0].detail.id}?window=arc`,endpoint:'activity',budget:72,detail:'activity/',detailBudget:32});
 const cpu=await get('resources?section=cpu&window=arc'),waiting=await get('resources?section=waiting&window=arc'),schedule=await get('resources?window=arc'),role=await get('effort?group=role&window=arc');
 const extra=[
  {name:'booking',row:schedule.rows[0],query:'window=arc',tab:'resources',detail:'resources/details/'},
  {name:'cpu',row:cpu.rows[0],query:'section=cpu&window=arc',tab:'resources',detail:'resources/details/'},
  {name:'waiting',row:waiting.overview.reasons[0],query:'section=waiting&window=arc',tab:'resources',detail:'resources/details/'},
  {name:'resource',row:{detailKey:schedule.rows[0].resourceKey},query:'window=arc',tab:'resources',detail:'resources/details/'},
  {name:'effort-scope',row:role.rows[0],query:'group=role&window=arc',tab:'effort',detail:'resources/details/'},
 ];
 for(const x of extra)deepLinks.push({name:x.name,hash:`#/arcs/${m.arc}/${x.tab}/${x.name==='effort-scope'?'scopes':'resources'}/${x.row.detailKey}?${x.query}`,endpoint:x.tab,budget:136,detail:x.detail,detailBudget:32});
 deepLinks.push({name:'graph-unit',hash:`#/arcs/${m.arc}/graph/units/u7`,endpoint:'graph',budget:264,detail:'units/',detailBudget:64},{name:'graph-milestone',hash:`#/arcs/${m.arc}/graph/units/milestone%3AMS-1`,endpoint:'graph',budget:264,detail:'milestones/',detailBudget:64});
 // Milestones use their native dedicated route through the established unit route resolver.
 for(const d of deepLinks){
  await b.call('browser_navigate',{url:'about:blank'});const at=performance.now();await b.call('browser_navigate',{url:s.url+'/'+d.hash});
  await wait(`!!document.querySelector('.drawer .unit-meta,.drawer .detail-facts,.drawer h3')&&document.querySelector('.progress-count')?.textContent.includes('/300')`,d.name+' deep link').catch(async error=>{t.diagnostic(await b.evaluate(`()=>JSON.stringify({hash:location.hash,text:document.body.innerText,reads:window.__reads})`));throw error;});
  await b.evaluate(`()=>new Promise(resolve=>setTimeout(()=>resolve(true),400))`);
  const reads=await b.evaluate<Read[]>(`()=>window.__reads`),success=reads.filter(v=>v.status===200),selected=success.filter(v=>v.url.includes('/'+d.detail));
  assert.equal(success.length,4,JSON.stringify({deep:d.name,reads}));assert.equal(selected.length,1,JSON.stringify({deep:d.name,reads}));assert.ok(selected[0]!.bytes<=d.detailBudget*1024);
  assert.deepEqual(success.filter(v=>v!==selected[0]).map(v=>new URL(v.url,'http://console').pathname.split('/').at(-1)).sort(),['arcs','shell',d.endpoint].sort());assert.ok(success.filter(v=>v!==selected[0]&&!pathname(v.url).endsWith('/arcs')).reduce((n,v)=>n+v.bytes,0)<=d.budget*1024);
  const allowed=new Set(success.map(v=>pathname(v.url)));assert.ok(reads.every(v=>allowed.has(pathname(v.url))&&(v.status===200||v.status===202)),JSON.stringify(reads));
  assert.ok(!reads.some(v=>/\/(snapshot|status)(?:\?|$)/.test(v.url)));measurements[d.name+'Detail']={bytes:selected[0]!.bytes,usableMs:performance.now()-at};
  await b.call('browser_resize',{width:390,height:844});assert.equal(await b.evaluate(`()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.drawer').scrollWidth<=document.querySelector('.drawer').clientWidth`),true,d.name+' drawer narrow');await b.call('browser_resize',{width:1440,height:900});
 }
 const heaps:number[]=[],dom:number[]=[];await b.call('browser_navigate',{url:'about:blank'});await b.call('browser_navigate',{url:`${s.url}/#/arcs/${m.arc}/graph`});await wait(`!!document.querySelector('.dag-canvas canvas')`,'cycle start');
 await b.evaluate(`()=>{window.__cycles=[];return true;}`);
 // Execute ordinary Playwright operations in one driver call per cycle. This
 // preserves all 84 tab visits/drawers without paying MCP settle for each poll.
 for(let cycle=0;cycle<12;cycle++){
  const steps=routes.map(r=>`{
    await page.evaluate(()=>{location.hash=${JSON.stringify(`#/arcs/${m.arc}/${r.hash}${!r.hash.includes('?')&&!['graph','attention'].includes(r.name)?'?window=arc':''}`)};});
    await page.waitForFunction(()=>${r.ready},{},{timeout:10000});
    const href=await page.evaluate(()=>(${r.link})??null);
    if(href){await page.evaluate(hash=>{location.hash=hash;},href);await page.waitForFunction(()=>!!document.querySelector('.drawer .unit-meta,.drawer .detail-facts,.drawer h3'),{},{timeout:10000});maxDom=Math.max(maxDom,await page.evaluate(()=>document.querySelectorAll('*').length));await page.evaluate(()=>document.querySelector('[aria-label="Close details"]').click());}
    maxDom=Math.max(maxDom,await page.evaluate(()=>document.querySelectorAll('*').length));
  }`).join('\n');
  await b.call('browser_run_code_unsafe',{code:`async(page)=>{
    let maxDom=0;${steps}
    let heap=null;if(${cycle===3||cycle===11}){const c=await page.context().newCDPSession(page);await c.send('HeapProfiler.collectGarbage');await c.detach();heap=await page.evaluate(()=>performance.memory.usedJSHeapSize);}
    await page.evaluate(value=>window.__cycles.push(value),{maxDom,heap});
  }`});
 }
 const cycles=await b.evaluate<{maxDom:number;heap:number|null}[]>(`()=>window.__cycles`);assert.equal(cycles.length,12);for(const cycle of cycles){dom.push(cycle.maxDom);if(cycle.heap!==null)heaps.push(cycle.heap);}
 assert.ok(Math.max(...dom)<6000,JSON.stringify(dom));assert.ok(heaps[1]!-heaps[0]!<12*1024*1024,JSON.stringify(heaps));
 await b.call('browser_navigate',{url:'about:blank'});await s.close();
 // RSS is process-wide in worker_threads. Isolate the unmodified worker in a
 // minimal process, and report that host's Node/bootstrap overhead explicitly.
 const child=fork(new URL('../fixtures/console-worker-host.ts',import.meta.url),[JSON.stringify({common,hostDir:m.hostDir,instance:'isolated-cutover',repoId:'isolated'})],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});t.after(()=>{if(child.connected)child.disconnect();});
 let next=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>(),stderr:string[]=[];child.stderr!.on('data',d=>stderr.push(String(d)));
 const ready=new Promise<any>((resolve,reject)=>{child.on('message',(m:any)=>{if(m.kind==='ready')resolve(m);else if(m.id!==undefined){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(Error(JSON.stringify(m.error)));else p?.resolve(m.value);}});child.once('error',reject);child.once('exit',code=>{if(code)reject(Error(stderr.join('')));for(const p of pending.values())p.reject(Error('isolated worker exited'));});});const initial=await ready;
 const ask=(kind:string,path?:string[],params?:Record<string,string>)=>new Promise<any>((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.send({id,kind,path,params});});
 const rss:number[]=[];for(let cycle=0;cycle<12;cycle++){for(const r of routes)await ask('read',['arcs',m.arc,r.endpoint],r.endpoint==='holistic'?{section:'audits'}:r.endpoint==='graph'||r.endpoint==='attention'?{}:{window:'arc'});if(cycle===3||cycle===11)rss.push((await ask('sample')).rss);}
 assert.ok(rss.every(n=>n<512*1024*1024),JSON.stringify(rss));assert.ok(rss[1]!-rss[0]!<64*1024*1024,JSON.stringify(rss));child.disconnect();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 console.log(JSON.stringify({cutoverScale:{fixture:{units:m.units,events:m.events,invocations:m.invocations},generationMs,routes:measurements,cycles:12,maxDom:Math.max(...dom),heapBytes:heaps,isolatedWorkerHost:{baselineRss:initial.baselineRss,readyRss:initial.rss,cycleRss:rss,note:'Process-wide RSS of minimal Node host plus unmodified observation worker; excludes fixture generator, browser and HTTP server'},node:process.version,cpus:availableParallelism()}}));
});
