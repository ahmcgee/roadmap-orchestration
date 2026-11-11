import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { until } from '../fixtures/exec-common.ts';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { Observations } from '../helpers/observations.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import { ConsoleTemporal } from '../../src/console/temporal-query.ts';
import { ConsoleActivity } from '../../src/console/activity-query.ts';
import type { TimelineView, IntervalsView, HoldsView } from '../../src/console/temporal-protocol.ts';
import { serveConsole } from '../../src/console/http.ts';
import { consoleGet } from '../helpers/console-http.ts';

test('300-unit/7-day Timeline and Holistic typed pages, all six parks, cold browser request counts and decoded ceilings',{timeout:90_000},async t=>{
 const generation=performance.now(),m=await generateScaleArc(tmpDir('console-temporal-scale'));const generationMs=performance.now()-generation;
 const release=await ownScaleArc(m);t.after(release);
 const capture=performance.now(),e=new Observations(absPath(m.hostDir),'temporal-scale','repo').read({runDir:absPath(m.runDir),arc:arcId(m.arc)}),captureMs=performance.now()-capture;
 assert.equal(e.data.display.status.units.length,300);assert.equal(e.data.display.invocations.length,1088);assert.equal(e.data.events.length,7523);
 const tabs=new ConsoleTemporal(),activity=new ConsoleActivity(),bytes=(data:unknown)=>Buffer.byteLength(JSON.stringify({...e,data}))+1,measured:Record<string,number>={};
 const projected=performance.now();let tracks=tabs.timeline(e,{window:'arc'}) as TimelineView;const projectionMs=performance.now()-projected,serial=performance.now(),serialized=JSON.stringify({...e,data:tracks}),serializationMs=performance.now()-serial,parsed=performance.now();JSON.parse(serialized);const parseMs=performance.now()-parsed;const allTracks=[...tracks.rows];let largest=bytes(tracks);
 while(tracks.page.next){tracks=tabs.timeline(e,{window:'arc',cursor:tracks.page.next}) as TimelineView;allTracks.push(...tracks.rows);largest=Math.max(largest,bytes(tracks));}
 measured['tracks']=largest;assert.ok(largest<=128*1024);assert.equal(new Set(allTracks.map(r=>r.id)).size,allTracks.length);assert.equal(allTracks.reduce((n,r)=>n+r.intervalCount,0),1088);assert.equal(allTracks.reduce((n,r)=>n+r.openCount,0),6);
 const sliceOf=(at:string)=>{const lo=Date.parse(tracks.scope.from!),w=(Date.parse(tracks.scope.to!)-lo)/16;return Math.max(0,Math.min(15,Math.floor((Date.parse(at)-lo)/w)));};
 for(const track of allTracks){for(const mark of track.marks)if(mark.type==='cluster')assert.equal(sliceOf(mark.from),sliceOf(mark.to),'a cluster groups runs that start in one slice of the window');assert.ok(track.marks.length<=32);assert.equal(track.marks.reduce((n,m)=>n+(m.type==='cluster'?m.count:1),0),track.intervalCount);if(track.subject.type!=='unit')assert.equal(track.detail,null);}
 let intervals=tabs.timeline(e,{window:'arc'},'intervals') as IntervalsView;const allIntervals=[...intervals.rows];largest=bytes(intervals);
 while(intervals.page.next){intervals=tabs.timeline(e,{window:'arc',cursor:intervals.page.next},'intervals') as IntervalsView;allIntervals.push(...intervals.rows);largest=Math.max(largest,bytes(intervals));}
 measured['intervals']=largest;assert.ok(largest<=128*1024);assert.equal(allIntervals.length,1088);assert.equal(new Set(allIntervals.map(i=>i.id)).size,1088);
 const holds=tabs.timeline(e,{window:'arc'},'holds') as HoldsView;assert.equal(holds.rows.length,6);assert.equal(holds.page.matching,6);assert.equal(holds.rows.filter(h=>h.closure).length,6);
 assert.deepEqual(holds.rows.map(h=>h.startSeq).sort((a,b)=>a-b),e.data.events.flatMap(ev=>ev.type==='fact'&&ev.fact.kind==='backend-park'?[Number(ev.seq)]:[]));
 for(const section of ['audits','findings','decisions']){let h=tabs.holistic(e,{section});const rows=[...h.rows];largest=bytes(h);while(h.page.next){h=tabs.holistic(e,{section,cursor:h.page.next});rows.push(...h.rows);largest=Math.max(largest,bytes(h));}measured[section]=largest;assert.ok(largest<=64*1024);assert.equal(rows.length,h.counts[section as 'audits'|'findings'|'decisions']);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);}
 const b=new ConsoleBrowser(tmpDir('console-temporal-scale-browser'),{settleMs:100});t.after(()=>b.close());await b.initialize();await b.call('browser_resize',{width:1440,height:900});
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.addInitScript(()=>{window.__reads=[];const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/api/'))window.__reads.push({url:String(args[0]),status:r.status,atMs:performance.now(),bytes:new TextEncoder().encode(await r.clone().text()).length});return r;};});}`});
 const timing:Record<string,number>={generationMs,captureMs,projectionMs,serializationMs,parseMs};
 for(const [view,hash,ready,budget] of [['timeline',`timeline?window=arc`,`document.querySelectorAll('table[aria-label="Invocation timeline"] tbody tr').length===50`,136],['holistic',`activity?view=holistic`,`!!document.querySelector('table[aria-label="Holistic audits"]')`,72]] as const){
  const start=performance.now(),s=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});t.after(()=>s.close());
  await b.call('browser_navigate',{url:`${s.url}/#/arcs/${m.arc}/${hash}`});
  await until(async()=>b.evaluate(`()=>${ready}&&document.querySelector('.progress-count')?.textContent.includes('/300')`),10_000,`cold ${view}`);timing[`${view}UsableMs`]=performance.now()-start;
  const reads=await b.evaluate<{url:string;status:number;bytes:number;atMs:number}[]>(`()=>window.__reads`),successful=reads.filter(r=>r.status===200);
  assert.deepEqual(successful.map(r=>new URL(r.url,'http://console').pathname.split('/').at(-1)).sort(),['arcs','shell',view].sort(),JSON.stringify(reads));
  assert.equal(reads.some(r=>/\/(snapshot|status|resources|effort|attention|graph)(?:\?|$)/.test(r.url)),false);
  assert.equal(reads.some(r=>/timeline\/intervals|timeline\/holds|activity\/changes/.test(r.url)),false,'no unselected exact intervals or initial changes reads');
  timing[`${view}ShellBodyMs`]=successful.find(r=>/\/shell(?:\?|$)/.test(r.url))!.atMs;
  measured[`${view}BrowserCold`]=successful.filter(r=>!r.url.endsWith('/arcs')).reduce((n,r)=>n+r.bytes,0);assert.ok(measured[`${view}BrowserCold`]!<=budget*1024);
  if(view==='timeline'){
   // All six overnight parks read on the whole-arc overview and as pinned hold bands in the whole-arc window.
   assert.equal(await b.evaluate<number>(`()=>document.querySelectorAll('.timeline-overview-hold').length`),6);
   assert.equal(await b.evaluate<number>(`()=>document.querySelectorAll('table[aria-label="Backend availability"] .timeline-hold[href*="/timeline/events/"]').length`),6);
   const first=await b.evaluate<string>(`()=>document.querySelector('table[aria-label="Invocation timeline"] tbody tr').textContent`);
   await b.evaluate(`()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='Next page').click();return true;}`);
   await until(async()=>b.evaluate(`()=>location.hash.includes('cursor=')&&document.querySelector('table[aria-label="Invocation timeline"] tbody tr')?.textContent!==${JSON.stringify(first)}`),5000,'second track page');
   const frozen=await b.evaluate<string>(`()=>document.querySelector('table[aria-label="Invocation timeline"] tbody tr').textContent`),hash=await b.evaluate<string>(`()=>location.hash`);
   const intervalStart=performance.now();await b.evaluate(`()=>{document.querySelector('table[aria-label="Invocation timeline"] tbody tr button').click();return true;}`);
   await until(async()=>b.evaluate(`()=>document.querySelectorAll('table[aria-label="Exact invocation intervals"] tbody tr').length>0`),5000,'page-two track intervals');
   timing['selectedIntervalsMs']=performance.now()-intervalStart;
   assert.equal(await b.evaluate<string>(`()=>document.querySelector('table[aria-label="Invocation timeline"] tbody tr').textContent`),frozen.replace('Show runs','Hide runs'));
   assert.equal(await b.evaluate<string>(`()=>new URLSearchParams(location.hash.split('?')[1]).get('cursor')`),new URLSearchParams(hash.split('?')[1]).get('cursor'));
   const detailStart=performance.now();await b.evaluate(`()=>{document.querySelector('table[aria-label="Exact invocation intervals"] a').click();return true;}`);
   await until(async()=>b.evaluate(`()=>!!document.querySelector('.drawer .invocation-facts')&&!!document.querySelector('.drawer .history-controls,.drawer [aria-label="Recorded check output"]')`),10_000,'selected invocation default evidence');
   timing['selectedInvocationMs']=performance.now()-detailStart;
   await b.evaluate(`()=>{document.querySelector('[aria-label="Close details"]').click();return true;}`);
  }
  const times:number[]=[];for(let n=0;n<20;n++){const began=performance.now(),r=await consoleGet(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/${view}?${view==='timeline'?'window=arc':'section=audits'}`);assert.equal(r.status,200,await r.clone().text());await r.json();times.push(performance.now()-began);}times.sort((a,b)=>a-b);timing[`${view}WarmP95`]=times[18]!;
  assert.ok(await b.evaluate<number>(`()=>document.querySelectorAll('*').length`)<5000);
  await b.call('browser_resize',{width:390,height:844});assert.equal(await b.evaluate(`()=>document.documentElement.scrollWidth<=innerWidth`),true);await b.call('browser_resize',{width:1440,height:900});
  await b.call('browser_navigate',{url:'about:blank'});await s.close();
 }
 console.log(JSON.stringify({temporalScale:{bytes:measured,timing,rss:process.memoryUsage().rss,node:process.version}}));
});
