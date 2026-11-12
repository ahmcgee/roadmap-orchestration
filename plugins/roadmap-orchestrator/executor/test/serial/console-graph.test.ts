import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { investigationFixture } from '../fixtures/console-investigations.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';

const corpus = JSON.parse(readFileSync(new URL('../helpers/scale-corpus.json',import.meta.url),'utf8'));
const scaleTitle = (id:string):string => corpus.systems[Object.keys(corpus.systems)[(Number(id.slice(1))-1)%8]!][Math.floor((Number(id.slice(1))-1)/8)].title;

async function assertRenderedLabels(b:ConsoleBrowser,mode:'active'|'all'|'zoomed',width:number){
 const result=await b.evaluate<{count:number;bad:unknown[];overlaps:string[];coordinates:Record<string,unknown>;tier:string;hidden:string[];badEdges:string[]}>(`()=>{
  const cy=document.querySelector('.dag-canvas')._cyreg.cy,all=cy.nodes('[gate]'),extent=cy.extent();
  const nodes=all.filter(n=>{const box=n.boundingBox({includeLabels:false});return box.x2>extent.x1&&box.x1<extent.x2&&box.y2>extent.y1&&box.y1<extent.y2;});
  const bad=nodes.filter(n=>{
    const label=n.style('label'),px=parseFloat(n.style('font-size'))*cy.zoom(),w=n.renderedWidth(),h=n.renderedHeight();
    const context=document.createElement('canvas').getContext('2d');context.font=n.style('font-weight')+' '+px+'px "Mona Sans SemiCondensed"';
    const textWidth=Math.max(...label.split('\\n').map(line=>context.measureText(line).width));
    if(n.hasClass('extreme'))return label!=='';
    return !label.trim()||px<(n.hasClass('overview')?10:11)-.001||textWidth>w+.5||label.split('\\n').length*px*1.1>h+.5;
  }).map(n=>({id:n.id(),label:n.style('label'),px:parseFloat(n.style('font-size'))*cy.zoom(),w:n.renderedWidth(),h:n.renderedHeight()}));
  const boxes=all.map(n=>({id:n.id(),box:n.renderedBoundingBox({includeLabels:false})})),overlaps=[];
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(a.box.x1<b.box.x2-.5&&a.box.x2>b.box.x1+.5&&a.box.y1<b.box.y2-.5&&a.box.y2>b.box.y1+.5)overlaps.push(a.id+':'+b.id);}
  return {tier:document.querySelector('.graph-view').dataset.detailTier,hidden:all.filter(n=>!n.visible()).map(n=>n.id()),badEdges:cy.edges('[kind="dependency"], [kind="feeds"]').filter(e=>!e.visible()).map(e=>e.id()),count:nodes.length,bad,overlaps,coordinates:Object.fromEntries(all.map(n=>[n.id(),n.position()]))};
 }`);
 assert.ok(['full','minimal','status'].includes(result.tier),'only in-place tiers exist');
 assert.deepEqual(result.hidden,[],'every node stays drawn');
 assert.deepEqual(result.badEdges,[],'every unit dependency and feed stays drawn');
 assert.ok(result.count>0,`${width} ${mode}: nodes rendered`);
 if(mode==='all')assert.equal(result.count,310,'All includes every unit and gate in the viewport');
 assert.deepEqual(result.bad,[],`${width} ${mode}: text fits boxes and meets the title/identifier legibility threshold`);
 assert.deepEqual(result.overlaps,[],`${width}: world boxes never overlap`);
 return result.coordinates;
}
async function assertActiveFrame(b:ConsoleBrowser){
 await new Promise(r=>setTimeout(r,350));
 const result=await b.evaluate<{outside:string[];count:number;zoom:number;expected:number;clipped:string[]}>(`()=>{
   const el=document.querySelector('.dag-canvas'),cy=el._cyreg.cy,c=el.getBoundingClientRect(),t=document.querySelector('.graph-toolbar').getBoundingClientRect();
   const controls=[...document.querySelectorAll('.graph-legend,.key-toggle,.graph-scale,.graph-minimap,.filter-popover')].map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height&&r.top>t.bottom),bottom=Math.min(c.bottom,...controls.map(r=>r.top));
   const nodes=cy.nodes('[state="active"][gate=0]'),width=Math.max(...nodes.map(n=>n.position().x+n.width()/2))-Math.min(...nodes.map(n=>n.position().x-n.width()/2)),height=Math.max(...nodes.map(n=>n.position().y+n.height()/2))-Math.min(...nodes.map(n=>n.position().y-n.height()/2));
   return {zoom:cy.zoom(),expected:Math.max(cy.minZoom(),Math.min(1,(c.width-48-80)/width,(bottom-t.bottom-80)/height)),clipped:[...document.querySelectorAll('.dag-canvas,.graph-edges,.node-signals,.band-captions,.band-headings,.wait-bus-labels')].filter(el=>getComputedStyle(el).clipPath!=='none').map(el=>el.className),count:nodes.length,outside:nodes.filter(n=>{const b=n.renderedBoundingBox({includeLabels:false});return b.x1<24||b.x2>c.width-24||b.y1<t.bottom-c.top||b.y2>bottom-c.top;}).map(n=>n.id())};
 }`);
 assert.ok(result.count>0);assert.ok(Math.abs(result.zoom-result.expected)<1e-10,'Active uses the largest fitting zoom and excludes neighbours');assert.deepEqual(result.clipped,[],'nothing clips graph content into a full-width blank band');assert.deepEqual(result.outside,[],'every active box fits clear of the toolbar and bottom controls');
}

async function hoverNode(b:ConsoleBrowser,id:string){
 const point=await b.evaluate<{x:number;y:number}>(`()=>{const el=document.querySelector('.dag-canvas'),p=el._cyreg.cy.getElementById('${id}').renderedPosition(),r=el.getBoundingClientRect();return {x:r.left+p.x,y:r.top+p.y};}`);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.mouse.move(${point.x},${point.y});}`});
 await until(async()=>await b.evaluate(`()=>document.querySelector('.graph-hover')?.textContent.includes(${JSON.stringify(scaleTitle(id))})`),5000,'real pointer hover title card');
 assert.equal(await b.evaluate('()=>document.querySelectorAll(".drawer").length'),0);
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return cy.edges('.trace').length>0&&cy.edges('.trace').every(e=>parseFloat(e.style('width'))*cy.zoom()>=2&&(e.source().id()==='${id}'||e.target().id()==='${id}'));}`),true,'hover traces real routes at two rendered pixels');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".graph-hover").innerText'),/\d+ runs?\b/);
 return point;
}


test('Graph stations, keyboard selection, same-tab non-modal drawers, saved size and themes work at desktop and phone widths', {timeout:120_000},async t=>{
 const f=await investigationFixture(60),b=new ConsoleBrowser(tmpDir('console-graph'));
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});
 t.after(async()=>{await b.close();await s.close();f.close();});await b.initialize();
 await b.call('browser_resize',{width:1440,height:900});await b.call('browser_navigate',{url:s.url});
 await until(async()=>await b.evaluate('()=>document.querySelectorAll(".dag-canvas canvas").length>0'),10_000,'canvas rendered');
 assert.equal(await b.evaluate('()=>document.querySelectorAll(".station").length'),7);
 assert.equal(await b.evaluate('()=>document.querySelectorAll(".unit-list").length'),0);
 assert.equal(await b.evaluate('()=>document.querySelector(".focus-control button:first-child").getAttribute("aria-pressed")'),'true','Active is the default');
 await assertActiveFrame(b);
 await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;cy.panBy({x:47,y:-23});cy.zoom({level:cy.zoom()*1.1,renderedPosition:{x:720,y:450}});return true;}`);
 const beforeRevision=await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return {pan:cy.pan(),zoom:cy.zoom()};}`);
 f.finishLive();
 const schedPath=join(f.runDir,'sched.json'),sched=JSON.parse(readFileSync(schedPath,'utf8'));sched.tasks=sched.tasks.filter((task:{unit:string})=>task.unit!=='u3');writeFileSync(schedPath,JSON.stringify(sched));
 await until(async()=>await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.getElementById('u3').data('state')!=='active'`),10_000,'real journal revision reaches graph');
 assert.deepEqual(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return {pan:cy.pan(),zoom:cy.zoom()};}`),beforeRevision,'a live revision never moves a panned and zoomed viewport');
 await b.call('browser_press_key',{key:'a'});
 assert.equal(await b.evaluate('()=>document.querySelector(".focus-control button:first-child").getAttribute("aria-pressed")'),'true');

 await b.evaluate('()=>{document.querySelector(".station").click();return true;}');
 await until(async()=>await b.evaluate('()=>document.querySelector(".station").getAttribute("aria-pressed")==="true"'),5000,'station focus');
 assert.equal(await b.evaluate('()=>document.querySelectorAll(".band-focused").length'),1);
 await b.call('browser_press_key',{key:'/'});
 const snap=await b.call('browser_snapshot',{}),search=snap.split('\n').find(l=>l.includes('textbox "Search units"'))!;
 await b.call('browser_type',{element:'Search units',target:/\[ref=(\w+)\]/.exec(search)![1],text:'u60'});
 await b.call('browser_press_key',{key:'Enter'});
 assert.equal(await b.evaluate('()=>document.querySelectorAll(".drawer").length'),1,'explicit search opens details directly');assert.equal(await b.evaluate('()=>document.querySelector(".dag-canvas")._cyreg.cy.nodes(":selected").id()'),'u60');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".graph-selection").innerText'),/Implement the stated acceptance/);
 await new Promise(r=>setTimeout(r,400));
 const viewport=await b.evaluate<{pan:{x:number;y:number};zoom:number}>('()=>{const cy=document.querySelector(".dag-canvas")._cyreg.cy;return{pan:cy.pan(),zoom:cy.zoom()};}');
 await until(async()=>await b.evaluate('()=>document.querySelector(".unit-meta>span")?.textContent==="u60"'),5000,'search activation opens');
 assert.match(await b.evaluate<string>('()=>location.hash'),/\/graph\/units\/u60$/);
 assert.equal(await b.evaluate('()=>document.querySelector(".drawer").getAttribute("aria-modal")'),'false');
 assert.equal(await b.evaluate('()=>document.querySelector("main").inert'),false);
 assert.equal(await b.evaluate('()=>document.querySelector(".dag-canvas").getBoundingClientRect().width'),1440,'drawer overlays the full-width graph');
 await b.evaluate('()=>{document.querySelector(".drawer-resize").focus();return true;}');
 await b.call('browser_press_key',{key:'ArrowLeft'});
 assert.equal(await b.evaluate('()=>document.querySelector(".drawer").getBoundingClientRect().width'),560);
 await b.call('browser_press_key',{key:'Escape'});
 assert.deepEqual(await b.evaluate('()=>{const cy=document.querySelector(".dag-canvas")._cyreg.cy;return{pan:cy.pan(),zoom:cy.zoom()};}'),viewport,'opening and closing keeps the graph viewport');
 await b.openUnit('u60');assert.equal(await b.evaluate('()=>document.querySelector(".drawer").getBoundingClientRect().width'),560,'width persists');
 await b.call('browser_press_key',{key:'Escape'});
 await b.evaluate('()=>{document.querySelector(".filter-popover").open=true;[...document.querySelectorAll(".status-filters button")].find(e=>e.getAttribute("aria-label")==="Filter held").click();document.querySelector(".arc-bar>button:last-child").click();return true;}');
 assert.equal(await b.evaluate('()=>[...document.querySelectorAll(".status-filters button")].find(e=>e.getAttribute("aria-label")==="Filter held").getAttribute("aria-pressed")'),'true');
 await until(async()=>await b.evaluate('()=>document.documentElement.dataset.theme===\"light\"'),5000,'light theme');
 await b.evaluate('()=>{document.querySelector(\".arc-bar>button:last-child\").click();return true;}');
 await until(async()=>await b.evaluate('()=>document.documentElement.dataset.theme===\"dark\"'),5000,'dark theme');
 assert.equal(await b.evaluate('()=>document.documentElement.dataset.theme'),'dark');
 assert.equal(await b.evaluate('()=>getComputedStyle(document.documentElement).getPropertyValue("--paper").trim().toLowerCase()'),'#14161a');
 await b.evaluate(`()=>{location.hash='#/arcs/${f.arc}/activity/units/u3';return true;}`);
 await until(async()=>await b.evaluate('()=>document.querySelector(".unit-meta>span")?.textContent==="u3"'),5000,'same-tab unit route');
 assert.equal(await b.evaluate('()=>document.querySelector(".tabs [aria-current]").textContent'),'Activity');
 await b.evaluate('()=>{document.querySelector(".invocation-row").click();return true;}');
 await until(async()=>await b.evaluate('()=>location.hash.includes("/activity/invocations/")'),5000,'same-tab invocation');
 await b.evaluate('()=>{document.querySelector(".back-to-unit").click();return true;}');
 await until(async()=>await b.evaluate('()=>location.hash.endsWith("/activity/units/u3")'),5000,'back keeps the tab');
 await b.call('browser_press_key',{key:'Escape'});
 assert.match(await b.evaluate<string>('()=>location.hash'),/\/activity$/);
 await b.call('browser_resize',{width:390,height:844});
 await b.evaluate(`()=>{location.hash='#/arcs/${f.arc}/graph';return true;}`);
 await until(async()=>await b.evaluate('()=>document.querySelector(".dag-canvas")?.getBoundingClientRect().height>=innerHeight*.7'),5000,'phone canvas');
 assert.equal(await b.evaluate('()=>document.documentElement.scrollWidth<=innerWidth'),true);
 assert.equal(await b.evaluate('()=>document.querySelector(".arc-id").getBoundingClientRect().width>0'),true);
 await b.openUnit('u60');assert.equal(await b.evaluate('()=>document.querySelector(".drawer").getBoundingClientRect().width'),390);
 assert.equal(await b.evaluate('()=>document.querySelector(".drawer").scrollWidth<=390'),true);
});

test('scale Graph keeps one layout, preserves every edge, uses bounded labels, and supports exact tracing and touch', {timeout:180_000},async t=>{
 const {generateScaleArc,ownScaleArc}=await import('../helpers/scale-arc.ts');
 const fixture=await generateScaleArc(tmpDir('graph-scale-live')),release=await ownScaleArc(fixture),b=new ConsoleBrowser(tmpDir('graph-scale-browser'));
 const s=await serveConsole({repo:absPath(fixture.repo),common:gitCommonDir(absPath(fixture.repo)),hostDir:absPath(fixture.hostDir),host:'127.0.0.1',port:0});
 t.after(async()=>{await b.close();await s.close();release();});await b.initialize();
 await b.call('browser_resize',{width:1440,height:900});await b.call('browser_navigate',{url:s.url});
 await until(async()=>await b.evaluate('()=>!!document.querySelector(".dag-canvas canvas")'),10_000,'scale graph canvas');
 await new Promise(r=>setTimeout(r,350));const coordinates=await assertRenderedLabels(b,'active',1440);
 const counts=await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return {active:cy.nodes('[state="active"][gate=0]').length,dependencies:cy.edges('[kind="dependency"]').length,waits:cy.edges('[kind="waits"]').length,feeds:cy.edges('[kind="feeds"]').length,bundles:cy.edges('[kind="bundle"]').length,hiddenWaits:cy.edges('[kind="waits"]').every(e=>e.style('display')==='none')};}`) as any;
 assert.ok(counts.active>=4);assert.equal(counts.dependencies,663);assert.equal(counts.waits,1004);assert.equal(counts.feeds,300);assert.ok(counts.hiddenWaits);assert.equal(counts.bundles,0,'milestone waits have no bundled routes');
 await assertActiveFrame(b);
 await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,n=cy.getElementById('u226');cy.viewport({zoom:.8,pan:{x:720-n.position('x')*.8,y:320-n.position('y')*.8}});return true;}`);await new Promise(r=>setTimeout(r,160));
 assert.equal(await b.evaluate(`()=>{const marks=[...document.querySelectorAll('.node-status-row .signal')];return marks.length>0&&marks.every(n=>n.querySelector('svg path,svg circle')&&n.getBoundingClientRect().width>=8&&n.closest('.node-status-row').getBoundingClientRect().height>=15);}`),true,'full-card status rows keep a visible glyph and readable slot');
 await b.call('browser_press_key',{key:'a'});await new Promise(r=>setTimeout(r,350));
 await b.evaluate(`()=>{document.querySelector('.dag-canvas').focus();return true;}`);await b.call('browser_press_key',{key:'ArrowRight'});
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,n=cy.nodes(':selected')[0],p=n.renderedPosition();return n.data('state')==='active'&&p.x>0&&p.x<cy.width()&&p.y>60&&p.y<cy.height()-40;}`),true,'first arrow selects a visible active unit');
 await b.call('browser_press_key',{key:'Enter'});await until(async()=>await b.evaluate('()=>!!document.querySelector(".drawer")'),5000,'keyboard details');await b.call('browser_press_key',{key:'Escape'});
 await until(async()=>await b.evaluate('()=>!document.querySelector(".drawer")&&document.activeElement===document.querySelector(".dag-canvas")'),5000,'keyboard focus returns');
 await b.evaluate(`()=>{document.querySelector('.dag-canvas')._cyreg.cy.zoom(.4);return true;}`);await new Promise(r=>setTimeout(r,350));
 await assertRenderedLabels(b,'zoomed',1440);
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return cy.nodes('[gate=0]').every(n=>n.hasClass('overview')&&n.style('label').split(' ')[0]===n.data('compact')&&parseFloat(n.style('font-size'))*cy.zoom()>=10);}`),true,'mid zoom leads every label with the unit id');
 await b.evaluate(`()=>{document.querySelector('[aria-label="All focus"]').click();return true;}`);await new Promise(r=>setTimeout(r,350));
 assert.deepEqual(await assertRenderedLabels(b,'all',1440),coordinates,'All changes the viewport, never node positions');
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return document.querySelector('.graph-view').dataset.detailTier==='status'&&cy.nodes('[gate]').every(n=>n.visible()&&n.style('label')===''&&parseFloat(n.style('text-opacity'))===0)&&!!document.querySelector('.graph-minimap');}`),true,'All at 300 units keeps status-only unit boxes in place and preserves the minimap');
 const allZoom=await b.evaluate<number>(`()=>document.querySelector('.dag-canvas')._cyreg.cy.zoom()`);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{const box=await page.locator('.dag-canvas').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);for(let i=0;i<32;i++){await page.mouse.wheel(0,700);await page.waitForTimeout(80);}}`});
 await new Promise(r=>setTimeout(r,160));
 const minimum=await b.evaluate<{zoom:number;min:number;nodes:number;dependencies:number}>(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return{zoom:cy.zoom(),min:cy.minZoom(),nodes:cy.nodes('[gate=0]').filter(n=>n.visible()).length,dependencies:cy.edges('[kind="dependency"]').filter(e=>e.visible()).length};}`);
 assert.ok(Math.abs(minimum.min/allZoom-.6)<.01,'minimum zoom is 0.6 × All framing');
 assert.equal(minimum.zoom,minimum.min,'real wheel zoom stops at the minimum');
 assert.equal(minimum.nodes,300,'every unit stays rendered at minimum zoom');
 assert.equal(minimum.dependencies,663,'every unit dependency stays drawn at minimum zoom');
 assert.deepEqual(await assertRenderedLabels(b,'all',1440),coordinates,'minimum zoom keeps the same layout');
 // Zoom back in: every original dependency is drawable, and gate surfaces occlude the buses.
 await b.call('browser_press_key',{key:'a'});
 const overviewState=await b.evaluate<{badEdges:string[];transparentGates:string[]}>(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return {badEdges:cy.edges('[kind="dependency"]').filter(e=>{const a=e.sourceEndpoint(),b=e.targetEndpoint();return !e.visible()||!a||!b||![a.x,a.y,b.x,b.y].every(Number.isFinite);}).map(e=>e.id()),transparentGates:cy.nodes('[gate=1]').filter(n=>parseFloat(n.style('background-opacity'))!==1).map(n=>n.id())};}`);
 assert.deepEqual(overviewState.badEdges,[],'every dependency restores on zoom-in');assert.deepEqual(overviewState.transparentGates,[],'opaque gates mask connectors');
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,buses=[...document.querySelectorAll('.wait-bus-label')];const actual=buses.flatMap(b=>[...b.querySelectorAll('button')].map(n=>'milestone:'+b.querySelector('summary').getAttribute('aria-label').split(':')[0]+'>'+n.textContent)).sort(),expected=cy.edges('[kind="waits"]').map(e=>e.source().id()+'>'+e.target().id()).sort();return JSON.stringify(actual)===JSON.stringify(expected)&&document.querySelectorAll('.wait-buses,.wait-target-tick').length===0;}`),true,'prerequisite disclosures retain every exact gate relationship without bus routes');
 assert.equal(await b.evaluate(`()=>document.querySelector('.station-current')?.getAttribute('aria-description')`),'Next milestone to clear');
 await b.evaluate(`()=>{document.querySelectorAll('.station')[1].click();return true;}`);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{const summary=page.locator('.wait-bus-label>summary').filter({hasText:'30 units here depend on MS-1'}).first();await summary.hover();await summary.focus();await summary.locator('..').getByRole('button',{name:'u31',exact:true}).click();}`});
 await until(async()=>await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return cy.getElementById('u31').selected()&&cy.edges('.exact').length===1&&cy.edges('.exact').every(e=>e.visible());}`),5000,'passed gate links stay navigable');
 await b.evaluate(`()=>{document.querySelectorAll('.station')[5].click();return true;}`);await new Promise(r=>setTimeout(r,350));
 assert.deepEqual(await b.evaluate(`()=>Object.fromEntries(document.querySelector('.dag-canvas')._cyreg.cy.nodes('[gate]').map(n=>[n.id(),n.position()]))`),coordinates,'Milestone uses the identical full layout');
 await new Promise(r=>setTimeout(r,350));await assertRenderedLabels(b,'active',1440);
 await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,n=cy.getElementById('u226');cy.viewport({zoom:.4,pan:{x:720-n.position('x')*.4,y:320-n.position('y')*.4}});cy.nodes().unselect();return true;}`);
 assert.equal(await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.getElementById('u226').hasClass('overview')`),true,'hover preview works in the compact identifier tier');
 await hoverNode(b,'u226');assert.equal(await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.getElementById('u226').selected()`),false,'hover previews without selection');
 await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;cy.getElementById('u299').select();return true;}`);await new Promise(r=>setTimeout(r,350));await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,n=cy.getElementById('u226');cy.viewport({zoom:.4,pan:{x:720-n.position('x')*.4,y:320-n.position('y')*.4}});return true;}`);await hoverNode(b,'u226');
 assert.equal(await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.edges('.chain').length`),0,'hover takes priority over the selected neighborhood');
 assert.equal(await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.getElementById('u226').hasClass('dim')`),false,'hover restores emphasis to a unit outside the selected neighborhood');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.mouse.move(0,0);}`});
 await until(async()=>await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.edges('.chain').length>0`),5000,'pointer exit restores the selected neighborhood');
 await hoverNode(b,'u226');

 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.locator('.graph-hover button').click();}`});await until(async()=>await b.evaluate('()=>document.querySelector(".unit-meta>span")?.textContent==="u226"'),5000,'hover details opens its unit');await b.call('browser_press_key',{key:'Escape'});
 await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;cy.getElementById('u226').select();return true;}`);
 await until(async()=>await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return cy.edges('.exact').length===cy.getElementById('u226').incomers('edge[kind="waits"]').length&&cy.edges('.exact').length>0&&cy.edges('.exact').every(e=>e.visible());}`),5000,'unit exact gate relations');assert.match(await b.evaluate<string>('()=>document.querySelector(".exact-relations").innerText'),/Gate prerequisites|MS-3/);
 await b.evaluate(`()=>{document.querySelector('.dag-canvas')._cyreg.cy.getElementById('milestone:MS-3').select();return true;}`);await until(async()=>await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return cy.edges('.exact').length===cy.getElementById('milestone:MS-3').outgoers('edge[kind="waits"]').length&&cy.edges('.exact').length>30;}`),5000,'gate exact linked units');
 await b.call('browser_resize',{width:390,height:844});await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;cy.nodes().unselect();cy.emit('tap');document.querySelector('[aria-label="Active focus"]').click();return true;}`);
 await assertActiveFrame(b);await new Promise(r=>setTimeout(r,350));await assertRenderedLabels(b,'active',390);
 assert.equal(await b.evaluate(`()=>document.querySelector('.dag-canvas').clientHeight>=innerHeight*.7`),true);
 assert.equal(await b.evaluate('()=>document.querySelector(".active-pager")'),null);
 await b.evaluate(`()=>{document.querySelectorAll('.station')[5].click();return true;}`);await new Promise(r=>setTimeout(r,350));await assertRenderedLabels(b,'active',390);
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,p=cy.getElementById('milestone:MS-6').renderedPosition();return document.querySelectorAll('.band-focused').length===1&&p.x>0&&p.x<cy.width()&&p.y>48&&p.y<cy.height()-40;}`),true,'phone station frames its labelled gate');
 await b.evaluate(`()=>{document.querySelector('[aria-label="All focus"]').click();return true;}`);await new Promise(r=>setTimeout(r,350));assert.deepEqual(await assertRenderedLabels(b,'all',390),coordinates);
 await b.evaluate(`()=>{document.querySelector('[aria-label="Active focus"]').click();return true;}`);await assertActiveFrame(b);await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,n=cy.getElementById('u226');cy.viewport({zoom:.8,pan:{x:190-n.position('x')*.8,y:320-n.position('y')*.8}});return true;}`);
 const point=await b.evaluate<{x:number;y:number}>(`()=>{const el=document.querySelector('.dag-canvas'),p=el._cyreg.cy.getElementById('u226').renderedPosition(),r=el.getBoundingClientRect();return{x:p.x+r.left,y:p.y+r.top};}`);
 const touch=async()=>b.call('browser_run_code_unsafe',{code:`async(page)=>{const client=await page.context().newCDPSession(page);await client.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:${point.x},y:${point.y}}]});await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await client.detach();}`});
 await touch();await until(async()=>await b.evaluate('()=>!!document.querySelector(".graph-hover")'),5000,'first native touch previews');assert.equal(await b.evaluate('()=>document.querySelectorAll(".drawer").length'),0);assert.ok((await b.evaluate<string>('()=>document.querySelector(".graph-hover").innerText')).includes(scaleTitle('u226')));
 await touch();await until(async()=>await b.evaluate('()=>document.querySelector(".unit-meta>span")?.textContent==="u226"'),5000,'second native touch opens details');
});

test('50-unit design arc exposes explicit milestone health, gate states, Markdown and exact drawer dependencies', {timeout:120_000},async t=>{
 const {generateScaleArc,ownScaleArc}=await import('../helpers/scale-arc.ts');
 const fixture=await generateScaleArc(tmpDir('graph-design'),{preset:'design'}),release=await ownScaleArc(fixture),b=new ConsoleBrowser(tmpDir('graph-design-browser'));
 const server=await serveConsole({repo:absPath(fixture.repo),common:gitCommonDir(absPath(fixture.repo)),hostDir:absPath(fixture.hostDir),host:'127.0.0.1',port:0});
 t.after(async()=>{await b.close();await server.close();release();});await b.initialize();await b.call('browser_resize',{width:1440,height:900});await b.call('browser_navigate',{url:server.url});
 await until(async()=>await b.evaluate('()=>!!document.querySelector(".dag-canvas canvas")'),10_000,'design graph');
 assert.equal(await b.evaluate('()=>document.querySelectorAll(".station").length'),5);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{
   await page.getByRole('button',{name:'All focus',exact:true}).click();
 }`});
 await until(async()=>await b.evaluate(`()=>document.querySelector('.graph-view').dataset.detailTier==='minimal'&&!document.querySelector('.dag-canvas')._cyreg.cy.animated()`),5000,'50-unit All framing settles with identifiers');
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,nodes=cy.nodes('[gate]'),box=nodes.renderedBoundingBox({includeLabels:false});return nodes.length===55&&nodes.every(n=>n.visible()&&n.style('label').trim()&&parseFloat(n.style('font-size'))*cy.zoom()>=10)&&box.x1>=0&&box.x2<=cy.width()&&box.y1>=0&&box.y2<=cy.height();}`),true,'All fits every unit at tier 2 at 1440');
 const ink=await b.evaluate<{count:number;outside:string[];badArrows:number;clipped:string[]}>(`()=>{
   const stage=document.querySelector('.graph-stage').getBoundingClientRect(),paths=[...document.querySelectorAll('.graph-edge')];
   return {count:paths.length,outside:paths.filter(p=>{const r=p.getBoundingClientRect();return r.left<stage.left||r.right>stage.right||r.top<stage.top||r.bottom>stage.bottom;}).map(p=>p.dataset.source+'>'+p.dataset.target),badArrows:paths.filter(p=>getComputedStyle(p).markerEnd==='none').length,clipped:[...document.querySelectorAll('.dag-canvas,.graph-edges,.node-signals')].filter(el=>getComputedStyle(el).clipPath!=='none').map(el=>el.className)};
 }`);
 assert.equal(ink.count,110,'all sixty dependencies and fifty gate feeds have actual SVG ink');assert.deepEqual(ink.outside,[],'every All-view curve stays on screen');assert.equal(ink.badArrows,0);assert.deepEqual(ink.clipped,[]);
 const geometry=await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.nodes('[gate]').map(n=>({id:n.id(),position:n.position(),width:n.width(),height:n.height()}))`);
 const fade=await b.evaluate<{out:number;hidden:boolean;inside:number;shown:boolean}>(`async()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,n=cy.nodes('[gate=0]')[0];cy.zoom(.4);await new Promise(r=>setTimeout(r,160));cy.zoom(.075);await new Promise(r=>setTimeout(r,60));const out=parseFloat(n.style('text-opacity'));await new Promise(r=>setTimeout(r,120));const hidden=n.style('label')===''&&parseFloat(n.style('text-opacity'))===0;cy.zoom(.4);await new Promise(r=>setTimeout(r,60));const inside=parseFloat(n.style('text-opacity'));await new Promise(r=>setTimeout(r,120));return{out,hidden,inside,shown:parseFloat(n.style('text-opacity'))===1};}`);
 assert.ok(fade.out>0&&fade.out<1,'text fades out over the tier boundary');
 assert.equal(fade.hidden,true,'status tier settles without text');
 assert.ok(fade.inside>0&&fade.inside<1,'identifiers fade back in');
 assert.equal(fade.shown,true,'identifiers finish appearing after 120 ms');
 for(const level of [.8,.62,.4,.3,.075]){
   await b.evaluate(`()=>{document.querySelector('.dag-canvas')._cyreg.cy.zoom(${level});return true;}`);
   await new Promise(r=>setTimeout(r,160));
   assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,nodes=cy.nodes('[gate]'),tier=document.querySelector('.graph-view').dataset.detailTier;return ['full','minimal','status'].includes(tier)&&nodes.every(n=>n.visible()&&n.hasClass('overview')===(tier!=='full')&&(tier==='status'?n.style('label')===''&&parseFloat(n.style('text-opacity'))===0:!!n.style('label').trim()&&parseFloat(n.style('text-opacity'))===1));}`),true,'LOD is uniform at '+level);
   assert.deepEqual(await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.nodes('[gate]').map(n=>({id:n.id(),position:n.position(),width:n.width(),height:n.height()}))`),geometry,'node geometry stays fixed at '+level);
 }
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.emulateMedia({reducedMotion:'reduce'});}`});
 for(const level of [.8,.075]){
   assert.equal(await b.evaluate(`async()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;cy.zoom(${level});await new Promise(requestAnimationFrame);return cy.nodes('[gate]').every(n=>!n.animated()&&parseFloat(n.style('text-opacity'))===(${level}===.8?1:0));}`),true,'reduced motion switches text immediately');
 }
 assert.equal(await b.evaluate(`()=>getComputedStyle(document.querySelector('.node-signal')).transitionDuration`),'0s','reduced motion disables status text transitions');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.emulateMedia({reducedMotion:'no-preference'});}`});
 await b.call('browser_press_key',{key:'a'});
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{
   await page.locator('.station').filter({hasText:'MS-3 Concurrency'}).hover();
   await page.waitForSelector('.station-health');
   await page.mouse.move(720,880);
 }`});
 await until(async()=>await b.evaluate('()=>!document.querySelector(".station-health")'),5000,'hover panel dismisses after pointer exit');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{
   await page.locator('.station').filter({hasText:'MS-3 Concurrency'}).focus();
   await page.keyboard.press('Tab');
 }`});
 // Focus can move into another station; leaving the entire station region dismisses it.
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.locator('.dag-canvas').focus();}`});
 await until(async()=>await b.evaluate('()=>!document.querySelector(".station-health")'),5000,'focus panel dismisses on leaving region');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{
   await page.locator('.station').filter({hasText:'MS-3 Concurrency'}).hover();
   await page.locator('.dag-canvas').focus();await page.keyboard.press('ArrowRight');
 }`});
 assert.equal(await b.evaluate('()=>!document.querySelector(".station-health,.graph-hover")'),true,'selection dismisses graph popovers');
 await b.call('browser_press_key',{key:'Enter'});
 await until(async()=>await b.evaluate('()=>!!document.querySelector(".drawer")'),5000,'keyboard opens sheet');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{for(let i=0;i<30;i++){await page.keyboard.press('Tab');if(!await page.locator('.drawer').evaluate(el=>el.contains(document.activeElement)))throw new Error('Tab escaped at '+i);}for(let i=0;i<30;i++){await page.keyboard.press('Shift+Tab');if(!await page.locator('.drawer').evaluate(el=>el.contains(document.activeElement)))throw new Error('Shift+Tab escaped at '+i);}await page.locator('.unit-dependencies summary').first().click();await page.keyboard.press('Escape');}`});
 assert.equal(await b.evaluate('()=>!!document.querySelector(".drawer")&&!document.querySelector(".unit-dependencies details").open'),true,'first Escape closes inner disclosure');
 await b.call('browser_press_key',{key:'Escape'});
 await until(async()=>await b.evaluate('()=>!document.querySelector(".drawer")&&document.activeElement===document.querySelector(".dag-canvas")'),5000,'hash route closes and restores focus');
 assert.equal(await b.evaluate('()=>!document.querySelector(".drawer")&&document.activeElement===document.querySelector(".dag-canvas")'),true,'next Escape closes sheet and returns graph focus');

 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,origin=document.querySelector('.dag-canvas').getBoundingClientRect();const labels=[...document.querySelectorAll('.band-headings>div,.wait-bus-label>summary')].filter(n=>getComputedStyle(n).display!=='none'&&getComputedStyle(n.parentElement).display!=='none');return labels.every(n=>{const r=n.getBoundingClientRect();return cy.nodes('[gate]').every(node=>{const b=node.renderedBoundingBox({includeLabels:false});return r.right<=origin.left+b.x1||r.left>=origin.left+b.x2||r.bottom<=origin.top+b.y1||r.top>=origin.top+b.y2;});});}`),true,'band and bus captions never overlap a node');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".station-current").textContent'),/MS-3 Concurrency and retries.*Next to clear/);
 const coords=await b.evaluate(`()=>Object.fromEntries(document.querySelector('.dag-canvas')._cyreg.cy.nodes('[gate]').map(n=>[n.id(),n.position()]))`);
 await b.evaluate(`()=>{document.querySelector('.dag-canvas')._cyreg.cy.getElementById('u39').select();return true;}`);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.locator('.station').filter({hasText:'MS-4 Observability'}).hover();}`});
 assert.match(await b.evaluate<string>('()=>document.querySelector(".station-health").textContent'),/Show 2 on hold units/);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.getByRole('button',{name:'Show 2 on hold units',exact:true}).click();}`});
 assert.deepEqual(await b.evaluate(`()=>Object.fromEntries(document.querySelector('.dag-canvas')._cyreg.cy.nodes('[gate]').map(n=>[n.id(),n.position()]))`),coords,'held targets frame units without re-layout');
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return ['u37','u38'].every(id=>{const n=cy.getElementById(id),p=n.renderedPosition();return !n.hasClass('dim')&&p.x>0&&p.x<cy.width()&&p.y>60&&p.y<cy.height();})&&cy.edges('[kind="dependency"]').length===60;}`),true,'exact held members stay highlighted with all dependencies retained');
 await b.openUnit('u39');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".unit-dependencies").textContent'),/Depends on \(1\).*Used by \(1\)/s);
 assert.equal(await b.evaluate('()=>document.querySelector(".unit-dependencies details").open'),false);
 assert.equal(await b.evaluate('()=>document.querySelectorAll(".intent .history-markdown h3").length'),0,'repeated title heading is omitted in collapsed intent');
 assert.equal(await b.evaluate('()=>document.querySelectorAll(".intent code").length>0'),true,'intent keeps path chips');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".drawer-body").textContent'),/No check results recorded/);
 assert.match(await b.evaluate<string>('()=>document.querySelector(".drawer").innerText'),/Waits for milestone[\s\S]*MS-3[\s\S]*pending[\s\S]*Build is currently running/);
 assert.doesNotMatch(await b.evaluate<string>('()=>document.querySelector(".drawer").innerText'),/Current blocker|Waits on/);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.locator('.unit-gates a').filter({hasText:'MS-3 Concurrency and retries: pending'}).click();}`});
 await until(async()=>await b.evaluate('()=>document.querySelector("#detail-title")?.textContent==="MS-3 Concurrency and retries"'),5000,'named gate sheet');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".drawer").innerText'),/8 of 9 units merged[\s\S]*1 withdrawn[\s\S]*Not passed yet[\s\S]*Outstanding units \(1\)[\s\S]*u30[\s\S]*Withdrawn units \(1\)[\s\S]*u29/s, 'dev.59: the superseded u29 is withdrawn from the count and listed apart');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.getByRole('button',{name:'Focus this milestone',exact:true}).click();}`});
 await until(async()=>await b.evaluate('()=>!document.querySelector(".drawer")&&document.querySelector(".station[aria-pressed=true]")?.textContent.includes("MS-3")'),5000,'gate focus control');
 await b.openUnit('u39');

 assert.doesNotMatch(await b.evaluate<string>('()=>document.querySelector(".drawer-body").textContent'),/Check: null/);
 await b.evaluate('()=>{document.querySelector(".unit-dependencies details").open=true;document.querySelector(".dependency-row").focus();return true;}');
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,edges=cy.edges('.trace');return edges.length===1&&edges[0].source().id()==='u31'&&edges[0].target().id()==='u39';}`),true,'dependency row highlights its one exact edge');
 const viewport=await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return {zoom:cy.zoom(),pan:cy.pan()};}`);
 await b.call('browser_press_key',{key:'Enter'});await until(async()=>await b.evaluate('()=>document.querySelector(".unit-meta>span")?.textContent==="u31"'),5000,'dependency drawer navigation');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".dependency-back").textContent'),/Back to u39/);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.locator('.dependency-back').click();}`});await until(async()=>await b.evaluate('()=>document.querySelector(".unit-meta>span")?.textContent==="u39"'),5000,'back to dependent');
 assert.deepEqual(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return {zoom:cy.zoom(),pan:cy.pan()};}`),viewport,'drawer navigation preserves the underlying graph');
 await b.evaluate('()=>{[...document.querySelectorAll(".intent button")].find(b=>b.textContent==="Show full intent").click();return true;}');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".intent h3 + div").textContent'),/^Emit counters for ingest latency and drop rate/,'full original intent remains available');
 await b.call('browser_press_key',{key:'Escape'});await b.call('browser_press_key',{key:'Escape'});await b.call('browser_press_key',{key:'Escape'});await b.evaluate('()=>{document.querySelector(".dag-canvas")._cyreg.cy.getElementById("u39").select();return true;}');
 assert.match(await b.evaluate<string>('()=>document.querySelector(".exact-relations").textContent'),/Waits for milestone \(1\).*MS-3 Pending/s);
 await b.evaluate(`()=>{document.querySelector('.dag-canvas')._cyreg.cy.getElementById('u37').select();return true;}`);
 assert.match(await b.evaluate<string>('()=>document.querySelector(".exact-relations").textContent'),/Waits for milestone.*MS-1 Passed.*MS-2 Passed.*MS-3 Pending/s);
 await b.openUnit('u10');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.locator('.invocation-row').filter({hasText:'Build'}).first().click();}`});
 await until(async()=>await b.evaluate('()=>document.querySelectorAll(".successful-command").length>0&&document.querySelectorAll(".history-diff-line").length>0'),5000,'compact successful commands and visible diffs');
 assert.equal(await b.evaluate(`()=>[...document.querySelectorAll('.successful-command')].every(d=>!d.open&&d.querySelector('summary').getBoundingClientRect().height>=28&&d.querySelector('summary').getBoundingClientRect().height<=32)`),true,'successful commands start as one 28–32px row');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.locator('.successful-command>summary').first().click();}`});
 assert.equal(await b.evaluate(`()=>document.querySelector('.successful-command').open&&document.querySelector('.successful-command .history-command').getBoundingClientRect().height>0`),true,'raw command expands on demand');
 await b.call('browser_press_key',{key:'Escape'});
 assert.equal(await b.evaluate('()=>!!document.querySelector(".drawer")&&!document.querySelector(".successful-command").open'),true,'Escape closes raw command before sheet');
 await b.call('browser_press_key',{key:'Escape'});
 await until(async()=>await b.evaluate('()=>!document.querySelector(".drawer")&&document.activeElement===document.querySelector(".dag-canvas")'),5000,'command sheet closes to graph');
});


for(const preset of ['design','default'] as const)test(`${preset} cold Active frames every live box in both themes; canonical controls, stations and root pinch`,{timeout:180_000},async t=>{
 const {generateScaleArc,ownScaleArc}=await import('../helpers/scale-arc.ts');
 const fixture=await generateScaleArc(tmpDir('activeframe-'+preset),preset==='design'?{preset:'design'}:{}),release=await ownScaleArc(fixture),b=new ConsoleBrowser(tmpDir('activeframe-browser-'+preset));
 const server=await serveConsole({repo:absPath(fixture.repo),common:gitCommonDir(absPath(fixture.repo)),hostDir:absPath(fixture.hostDir),host:'127.0.0.1',port:0});
 t.after(async()=>{await b.close();await server.close();release();});await b.initialize();await b.call('browser_resize',{width:1440,height:900});
 for(const theme of ['light','dark']){
   await b.call('browser_navigate',{url:server.url});
   await b.evaluate(`()=>{localStorage.setItem('roadmap.theme','${theme}');return true;}`);
   await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.reload();await page.waitForSelector('.dag-canvas canvas');}`});
   await assertActiveFrame(b);
   assert.equal(await b.evaluate(`()=>document.documentElement.dataset.theme`),theme);
 }
 assert.deepEqual(await b.evaluate(`()=>[...document.querySelectorAll('.focus-control button')].map(n=>({text:n.textContent,title:n.title}))`),[{text:'Active',title:'All active units'},{text:'All',title:'The whole graph'}]);
 assert.equal(await b.evaluate(`()=>!document.querySelector('[aria-label="Fit graph"],[title*="Fit current focus"],[aria-label="Milestone focus"],[aria-label="Switch arc"],.arc-switcher,.active-pager')`),true);
 const view=()=>b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return {zoom:cy.zoom(),pan:cy.pan()};}`);
 const active=await view();
 await b.openUnit('u1');await new Promise(r=>setTimeout(r,350));assert.equal((await view() as {zoom:number}).zoom,(active as {zoom:number}).zoom,'search and drawer opening preserve zoom');
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,n=cy.getElementById('u1'),box=n.renderedBoundingBox({includeLabels:false}),drawer=document.querySelector('.drawer').getBoundingClientRect(),canvas=document.querySelector('.dag-canvas').getBoundingClientRect();return box.x1>=24-1e-6&&box.x2+canvas.left<=drawer.left-24+1e-6;}`),true,'minimum pan keeps the drawer unit unobscured');
 await b.call('browser_press_key',{key:'Escape'});await until(async()=>await b.evaluate(`()=>!document.querySelector('.drawer')&&document.activeElement===document.querySelector('.dag-canvas')`),5000,'drawer closes before graph shortcut');await b.call('browser_press_key',{key:'a'});await new Promise(r=>setTimeout(r,350));assert.deepEqual(await view(),active);
 await b.evaluate(`()=>{document.querySelector('.dag-canvas')._cyreg.cy.panBy({x:103,y:37});document.querySelector('[aria-label="Active focus"]').click();return true;}`);await new Promise(r=>setTimeout(r,350));
 assert.deepEqual(await view(),active,'selected Active segment reapplies exactly the canonical framing');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.mouse.move(0,0);await page.locator('.dag-canvas').focus();await page.keyboard.press('f');await page.waitForTimeout(350);}`});
 const all=await view();assert.notDeepEqual(all,active,'f frames the whole graph');
 await b.evaluate(`()=>{document.querySelector('.dag-canvas')._cyreg.cy.panBy({x:57,y:-36});document.querySelector('[aria-label="All focus"]').click();return true;}`);await new Promise(r=>setTimeout(r,350));assert.deepEqual(await view(),all,'selected All segment reapplies exactly its framing');
 await b.call('browser_press_key',{key:'a'});await new Promise(r=>setTimeout(r,350));assert.deepEqual(await view(),active,'a restores Active');
 await b.evaluate(`()=>{document.querySelectorAll('.station')[2].click();return true;}`);await new Promise(r=>setTimeout(r,350));
 const {graphLayout}=await import(new URL('../../web-src/app/graph-layout.ts',import.meta.url).href);const {graphData}=await import(new URL('../../web-src/app/graph-data.ts',import.meta.url).href);const dto=await server.ask({kind:'read',path:['arcs',fixture.arc,'graph'],params:{}});const ids=[...graphLayout(graphData(dto)).stations[2].frame,'milestone:MS-3'];
 assert.equal(await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,gate=cy.getElementById('milestone:MS-3'),box=gate.renderedBoundingBox({includeLabels:false}),stage=document.querySelector('.dag-canvas').getBoundingClientRect(),toolbar=document.querySelector('.graph-toolbar').getBoundingClientRect();return ${JSON.stringify(ids)}.every(id=>{const b=cy.getElementById(id).renderedBoundingBox({includeLabels:false});return b.x1>=24&&b.x2<=cy.width()-24&&b.y1>=toolbar.bottom-stage.top&&b.y2<=cy.height();})&&gate.length>0&&box.x1>=24&&box.x2<=cy.width()-24&&box.y1>=toolbar.bottom-stage.top&&box.y2<=cy.height()&&document.querySelectorAll('.station[aria-pressed=true]').length===1;}`),true,'station frames every band unit and its gate');
 const band=await view();
 await b.evaluate(`()=>{document.querySelectorAll('.station')[2].click();return true;}`);await new Promise(r=>setTimeout(r,250));assert.deepEqual(await view(),band,'second station click clears without reframing');assert.equal(await b.evaluate(`()=>document.querySelectorAll('.station[aria-pressed=true]').length`),0);
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.locator('.station').nth(2).focus();await page.keyboard.press('Enter');await page.waitForTimeout(350);}`});
 assert.deepEqual(await view(),band,'Enter on a focused station frames its band');
 await b.call('browser_press_key',{key:'Escape'});assert.deepEqual(await view(),band,'Escape clears station without reframing');assert.equal(await b.evaluate(`()=>document.querySelectorAll('.station[aria-pressed=true]').length`),0);
 await b.call('browser_press_key',{key:'a'});await new Promise(r=>setTimeout(r,350));
 for(const selector of ['.dag-canvas canvas','.band-headings>div','.graph-minimap','.graph-toolbar']){
   const result=await b.evaluate<{before:number;out:number;min:number;clamp:number;inside:number;prevented:boolean;scale:number}>(`()=>{
     const cy=document.querySelector('.dag-canvas')._cyreg.cy,target=document.querySelector('${selector}');if(!target)throw new Error('missing '+${JSON.stringify(selector)});
     const r=target.getBoundingClientRect(),before=cy.zoom(),events=[];
     for(const deltaY of [10000,10000,-25]){const ev=new WheelEvent('wheel',{ctrlKey:true,deltaY,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true});target.dispatchEvent(ev);events.push({zoom:cy.zoom(),prevented:ev.defaultPrevented});}
     return {before,out:events[0].zoom,min:cy.minZoom(),clamp:events[1].zoom,inside:events[2].zoom,prevented:events.every(e=>e.prevented),scale:visualViewport.scale};
   }`);
   assert.ok(result.before>result.out,selector+' zooms out');assert.equal(result.out,result.min);assert.equal(result.clamp,result.min);assert.ok(result.inside>result.min,selector+' zooms in after clamp');assert.equal(result.prevented,true);assert.equal(result.scale,1);
   await b.call('browser_press_key',{key:'a'});await new Promise(r=>setTimeout(r,350));
 }
 assert.equal(await b.evaluate(`()=>getComputedStyle(document.querySelector('.graph-view')).touchAction`),'none');
 for(const selector of ['.dag-canvas','.band-headings>div']){
   await b.call('browser_run_code_unsafe',{code:`async(page)=>{
     await page.evaluate(()=>{window.__pinchPrevented=[];document.querySelector('.graph-view').addEventListener('wheel',e=>{if(e.ctrlKey)window.__pinchPrevented.push(e.defaultPrevented);},{capture:true});});
     const box=await page.locator('${selector}').first().boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.keyboard.down('Control');await page.mouse.wheel(0,10000);await page.waitForTimeout(50);await page.mouse.wheel(0,-25);await page.keyboard.up('Control');await page.waitForTimeout(100);
   }`});
   assert.equal(await b.evaluate(`()=>visualViewport.scale===1&&window.__pinchPrevented.length>=2&&window.__pinchPrevented.every(Boolean)`),true,'native ctrl+wheel is consumed over '+selector);
   await b.call('browser_press_key',{key:'a'});await new Promise(r=>setTimeout(r,350));
 }
 const plain=await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,zoom=cy.zoom(),ev=new WheelEvent('wheel',{deltaY:80,bubbles:true,cancelable:true});document.querySelector('.graph-toolbar').dispatchEvent(ev);return !ev.defaultPrevented&&cy.zoom()===zoom;}`);assert.equal(plain,true,'plain wheel over overlays keeps its behavior');
 const touch=await b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy,target=document.querySelector('.band-headings>div'),r=target.getBoundingClientRect(),before=cy.zoom();const points=d=>[new Touch({identifier:1,target,clientX:r.left+20-d,clientY:r.top+10}),new Touch({identifier:2,target,clientX:r.left+20+d,clientY:r.top+10})];const start=new TouchEvent('touchstart',{touches:points(10),bubbles:true,cancelable:true}),move=new TouchEvent('touchmove',{touches:points(15),bubbles:true,cancelable:true});target.dispatchEvent(start);target.dispatchEvent(move);target.dispatchEvent(new TouchEvent('touchend',{touches:[],bubbles:true,cancelable:true}));return cy.zoom()>before&&start.defaultPrevented&&move.defaultPrevented&&visualViewport.scale===1;}`);assert.equal(touch,true,'touch pinch on an overlay zooms the graph');
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'Active focus',exact:true}).click();}`});assert.deepEqual(await view(),active,'reduced motion applies focus instantly');assert.equal(await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.animated()`),false);
 await b.evaluate(`()=>{location.hash='#/arcs/another-arc/graph';return true;}`);await until(async()=>await b.evaluate(`()=>document.body.innerText.includes('This console shows the current arc only')`),5000,'other arc route message');
 assert.equal(await b.evaluate(`()=>document.querySelector('main a').getAttribute('href')`),'#/arcs/'+fixture.arc+'/graph');
 await b.call('browser_navigate',{url:server.url});await until(async()=>await b.evaluate(`()=>!!document.querySelector('.dag-canvas canvas')`),5000,'root opens current arc');assert.equal(await b.evaluate(`()=>document.querySelector('.arc-id').textContent.includes('${fixture.arc}')`),true);
});

test('untouched Active follows live active-set changes, manual viewport stays put, and idle Active frames first uncleared band',{timeout:120_000},async t=>{
 const {generateScaleArc,ownScaleArc}=await import('../helpers/scale-arc.ts');
 const fixture=await generateScaleArc(tmpDir('activeframe-updates'),{preset:'design'}),release=await ownScaleArc(fixture),b=new ConsoleBrowser(tmpDir('activeframe-updates-browser'));
 const server=await serveConsole({repo:absPath(fixture.repo),common:gitCommonDir(absPath(fixture.repo)),hostDir:absPath(fixture.hostDir),host:'127.0.0.1',port:0});
 t.after(async()=>{await b.close();await server.close();release();});await b.initialize();await b.call('browser_resize',{width:1440,height:900});
 await b.call('browser_run_code_unsafe',{code:`async(page)=>{
   await page.addInitScript(()=>{window.__mode=0;window.EventSource=class extends EventTarget{constructor(){super();window.__stream=this;}close(){}};});
   await page.route('**/graph*',async route=>{const response=await route.fetch(),body=await response.json(),mode=await page.evaluate(()=>window.__mode);body.revision+=mode;body.data.viewVersion=String(mode).padStart(64,'0');for(const u of body.data.units){if(mode&&u.signal==='active'){u.signal='pending';u.state='ready';}if(mode===1&&u.id==='u30'||mode===2&&u.id==='u10'){u.signal='active';u.state='running';}}body.data.focus.activeIds=body.data.units.filter(u=>u.signal==='active').map(u=>u.id);const metadata=await (await route.fetch({url:route.request().url().replace(/graph.*$/,'metadata')})).json();metadata.revision=body.revision;metadata.viewVersions.graph=body.data.viewVersion;await page.evaluate(value=>window.__notice=value,metadata);await route.fulfill({response,json:body});});
 }`});
 await b.call('browser_navigate',{url:server.url});await until(async()=>await b.evaluate(`()=>!!document.querySelector('.dag-canvas canvas')`),5000,'live test graph');await assertActiveFrame(b);
 const view=()=>b.evaluate(`()=>{const cy=document.querySelector('.dag-canvas')._cyreg.cy;return {zoom:cy.zoom(),pan:cy.pan()};}`),initial=await view();
 await b.evaluate(`()=>{window.__mode=1;window.__notice.revision++;window.__notice.viewVersions.graph=String(window.__mode).padStart(64,'0');window.__stream.dispatchEvent(new MessageEvent('revision',{data:JSON.stringify(window.__notice)}));return true;}`);
 await until(async()=>await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.nodes('[state="active"][gate=0]').length===1`),5000,'active set changes');await assertActiveFrame(b);assert.notDeepEqual(await view(),initial,'untouched viewport follows new active bounds');
 await b.evaluate(`()=>{document.querySelector('.dag-canvas')._cyreg.cy.panBy({x:71,y:-19});return true;}`);const panned=await view();
 await b.evaluate(`()=>{window.__mode=2;window.__notice.revision++;window.__notice.viewVersions.graph=String(window.__mode).padStart(64,'0');window.__stream.dispatchEvent(new MessageEvent('revision',{data:JSON.stringify(window.__notice)}));return true;}`);await until(async()=>await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.getElementById('u10').data('state')==='active'`),5000,'panned live update');await new Promise(r=>setTimeout(r,350));assert.deepEqual(await view(),panned);
 await b.evaluate(`()=>{window.__mode=3;window.__notice.revision++;window.__notice.viewVersions.graph=String(window.__mode).padStart(64,'0');window.__stream.dispatchEvent(new MessageEvent('revision',{data:JSON.stringify(window.__notice)}));return true;}`);await until(async()=>await b.evaluate(`()=>document.querySelector('.dag-canvas')._cyreg.cy.nodes('[state="active"][gate=0]').length===0`),5000,'idle live update');
 await b.call('browser_press_key',{key:'a'});await new Promise(r=>setTimeout(r,350));assert.equal(await b.evaluate(`()=>document.querySelector('.graph-caption').textContent`),'No active units; showing MS-3');
 const fallback=await view();await b.evaluate(`()=>{document.querySelectorAll('.station')[2].click();return true;}`);await new Promise(r=>setTimeout(r,350));assert.deepEqual(await view(),fallback,'idle Active uses exactly the first uncleared station band and gate');
});
