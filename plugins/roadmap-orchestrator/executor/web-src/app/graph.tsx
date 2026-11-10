import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type NodeSingular } from 'cytoscape';
import { Minus, Plus, Search } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { activeFocus, compactIdentifier, compactSystem, GLYPH_RESERVE, graphCurves, graphLayout, LABEL_PX, MIN_ID_PX, MIN_LABEL_PX, NODE_HEIGHT, NODE_WIDTH, TINY_GLYPH_RESERVE, TINY_ZOOM, TITLE_MIN_ZOOM } from './graph-layout.ts';
import { Clock, elapsed, glyph, pluralise, route, SignalMark } from './shared.tsx';
import type { Signal } from './types.ts';
import { signalWords, stageStatusWords, stateWords, stageWords } from '../../src/console/vocabulary.ts';
/** The legend and filters name what a unit mark means; footers name the unit's own state. */
const unitSignalWords={...signalWords,pending:'Waiting or ready',finished:'Waiting, work finished'} as const;
import type { GraphData } from './graph-data.ts';
import { useSelectedDetail } from './view-state.ts';
/** Width of `text` per 1px of font size. Measured at a large size: browsers round glyph advances at tiny sizes, so 1px metrics can be 0 or badly off. */
function emWidth(text:string){const context=document.createElement('canvas').getContext('2d')!;context.font='600 100px "Barlow Semi Condensed"';return context.measureText(text).width/100;}
function nodeTitle(title:string,fontPx=LABEL_PX){
  const context=document.createElement('canvas').getContext('2d')!;context.font=`600 ${fontPx}px "Barlow Semi Condensed"`;
  const limit=NODE_WIDTH-24,lines=[''];for(const word of title.split(/\s+/)){const last=lines.length-1,next=lines[last]?`${lines[last]} ${word}`:word;if(context.measureText(next).width>limit&&lines[last]){if(lines.length===3){while(context.measureText(lines[last]+'…').width>limit)lines[last]=lines[last]!.slice(0,-1);lines[last]+='…';break;}lines.push(word);}else lines[last]=next;}return lines.join('\n');
}
const states: Signal[] = ['passed','active','held','failed','pending','withdrawn'];
type FocusMode = 'active' | 'all' | null;
const ALL_MARGIN = 32;
export function Graph({ e, open }: { e: GraphData; open: (id: string) => void }) {
  const now=useContext(Clock), m=e;
  const region=useRef<HTMLDivElement>(null), moved=useRef(false), applying=useRef(false), activeSignature=useRef('');
  const canvas=useRef<HTMLDivElement>(null), cy=useRef<Core|null>(null), search=useRef<HTMLInputElement>(null), opener=useRef(open), saved=useRef<{arc:string;zoom:number;pan:{x:number;y:number}}|null>(null);
  opener.current=open;
  const [resultIndex,setResultIndex]=useState(0);
  const [selected,setSelected]=useState<string|null>(null), [query,setQuery]=useState(''), [searching,setSearching]=useState(false), [filters,setFilters]=useState<Signal[]>([]), [station,setStation]=useState<string|null>(null);
  const [fontsReady,setFontsReady]=useState(false);
  useEffect(()=>{let disposed=false;void Promise.all([document.fonts.load('500 11px "Barlow Semi Condensed"'),document.fonts.load('600 16px "Barlow Semi Condensed"')]).then(()=>{if(!disposed)setFontsReady(true);});return()=>{disposed=true;};},[]);
  const [focus,setFocus]=useState<FocusMode>('active'), [keyOpen,setKeyOpen]=useState(false), [mobileSearch,setMobileSearch]=useState(false);
  const [health,setHealth]=useState<{id:string;x:number;y:number}|null>(null),[highlight,setHighlight]=useState<string[]>([]),[edgeHover,setEdgeHover]=useState<{source:string;target:string}|null>(null);
  useEffect(()=>{const change=(ev:Event)=>setEdgeHover((ev as CustomEvent).detail);window.addEventListener('roadmap-edge',change);return()=>window.removeEventListener('roadmap-edge',change);},[]);
  const touchCard=useRef<string|null>(null), hoverTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [hover,setHover]=useState<{id:string;x:number;y:number}|null>(null), [view,setView]=useState({zoom:1,x:0,y:0}), [tier,setTier]=useState<'full'|'minimal'|'status'>('full');
  const cardId=hover?.id??health?.id??null;
  const card=useSelectedDetail(e.arc,cardId?.startsWith('milestone:')?`milestones/${encodeURIComponent(cardId.slice(10))}`:cardId?`units/${encodeURIComponent(cardId)}?section=summary`:null);
  const structure=JSON.stringify([e.arc,m.graph.units.map(u=>u.id),m.graph.edges,e.milestones]);
  const positioned=useMemo(()=>graphLayout(e),[structure]);
  const baseline={...positioned,bands:positioned.bands.map(b=>{const gate=e.milestones?.find(g=>`milestone:${g.id}`===b.id),state=e.milestones.find(g=>`milestone:${g.id}`===b.id);return gate?{...b,passed:gate.units.filter(id=>m.graph.units.find(u=>u.id===id)?.status==='passed').length,state:state?.passed?'passed':state?.state==='walking'?'active':state?.state==='blocked'?'held':'pending'}:b;})};
  const layout=baseline;
  const routed=useMemo(()=>{const start=performance.now(),curves=graphCurves(e,positioned.positions);return {curves,elapsed:performance.now()-start};},[structure]);
  const curves=routed.curves;
  useEffect(()=>{const close=()=>{setHealth(null);setHover(null);touchCard.current=null;document.querySelectorAll<HTMLDetailsElement>('.wait-bus-label[open],.filter-popover[open]').forEach(d=>d.open=false);};window.addEventListener('hashchange',close);window.addEventListener('roadmap-dismiss-popovers',close);return()=>{window.removeEventListener('hashchange',close);window.removeEventListener('roadmap-dismiss-popovers',close);};},[]);
  const active=activeFocus(e), phone=(canvas.current?.clientWidth??innerWidth)<=640;
  const results=query.trim()?m.units.filter(u=>`${u.title} ${u.id}`.toLowerCase().includes(query.toLowerCase())).slice(0,12):[];
  const waits=useMemo(()=>{
    const map=new Map<string,string[]>();for(const [a,b] of m.graph.edges)if(a.startsWith('milestone:'))map.set(b,[...map.get(b)??[],a]);return map;
  },[structure]);
  const unmet=new Map<string,string[]>([...waits].map(([id,gates])=>[id,gates.filter(g=>!e.milestones.find(v=>`milestone:${v.id}`===g)?.passed)] as [string,string[]]).filter(([,gates])=>gates.length>0));
  const gateLabel=(id:string)=>{const b=baseline.bands.find(b=>b.id===id);return b?`${id.slice(10)}\n${b.passed}/${b.total}  ${signalWords[b.state as Signal]}`:id;};
  const fallback=baseline.bands.find(b=>b.id.startsWith('milestone:')&&b.state!=='passed')??baseline.bands[0];
  function unobscured(){
    const graph=cy.current!, bounds=canvas.current!.getBoundingClientRect();
    const toolbar=region.current!.querySelector('.graph-toolbar')!.getBoundingClientRect();
    const bottoms=[...region.current!.querySelectorAll('.graph-legend,.key-toggle,.graph-scale,.graph-minimap,.filter-popover')].map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height&&r.top>toolbar.bottom);
    return {left:24,right:graph.width()-24,top:Math.max(0,toolbar.bottom-bounds.top),bottom:Math.min(graph.height(),...bottoms.map(r=>r.top-bounds.top))};
  }
  const reframe=useRef(()=>{});
  reframe.current=()=>{if(focus==='active')frame(activeIds(),false);else if(focus==='all')frameAll(false);else if(station){const band=baseline.bands.find(b=>b.id===station);if(band)frame([...band.ids,station],false);}};
  function frameBox(nodes:cytoscape.NodeCollection){
    // Border thickness changes with LOD; frame the fixed geometry so repeated
    // focus actions yield exactly the same viewport at every starting zoom.
    const x1=Math.min(...nodes.map(n=>n.position().x-n.width()/2)),x2=Math.max(...nodes.map(n=>n.position().x+n.width()/2));
    const y1=Math.min(...nodes.map(n=>n.position().y-n.height()/2)),y2=Math.max(...nodes.map(n=>n.position().y+n.height()/2));
    return {x1,x2,y1,y2,w:x2-x1,h:y2-y1};
  }
  function fitZoom(nodes:cytoscape.NodeCollection,margin=80){
    const r=unobscured(),box=frameBox(nodes);
    return Math.min(1,Math.max(.001,Math.min((r.right-r.left-margin)/Math.max(1,box.w),(r.bottom-r.top-margin)/Math.max(1,box.h))));
  }
  function viewport(zoom:number,pan:{x:number;y:number},animate=true){
    const graph=cy.current!;graph.stop();applying.current=true;
    const done=()=>{applying.current=false;};
    if(animate&&!matchMedia('(prefers-reduced-motion: reduce)').matches)graph.animate({zoom,pan},{duration:180,complete:done});
    else {graph.viewport({zoom,pan});done();}
  }
  function frame(ids:string[],animate=true){
    const graph=cy.current;if(!graph)return;
    const nodes=graph.nodes('[gate]').filter(n=>ids.includes(n.id()));if(!nodes.length)return;
    graph.resize();const r=unobscured(),box=frameBox(nodes);
    const zoom=Math.max(graph.minZoom(),fitZoom(nodes));
    viewport(zoom,{x:(r.left+r.right)/2-(box.x1+box.x2)/2*zoom,y:(r.top+r.bottom)/2-(box.y1+box.y2)/2*zoom},animate);
  }
  /** All frames the whole graph with a tight margin so ids stay legible as long as possible. */
  function frameAll(animate=true){
    const graph=cy.current;if(!graph)return;
    const nodes=graph.nodes('[gate]');if(!nodes.length)return;
    graph.resize();const r=unobscured(),box=frameBox(nodes);
    const zoom=Math.max(graph.minZoom(),fitZoom(nodes,ALL_MARGIN));
    viewport(zoom,{x:(r.left+r.right)/2-(box.x1+box.x2)/2*zoom,y:(r.top+r.bottom)/2-(box.y1+box.y2)/2*zoom},animate);
  }
  function activeIds(){return active.seeds.length?active.seeds:fallback?[...fallback.ids,...(fallback.id==='unbound'?[]:[fallback.id])]:m.graph.units.map(u=>u.id);}
  function focusActive(animate=true){
    setHighlight([]);setHealth(null);setFocus('active');setStation(null);setHover(null);touchCard.current=null;moved.current=false;
    frame(activeIds(),animate);
  }
  function focusAll(){
    setHighlight([]);setHealth(null);setFocus('all');setStation(null);setHover(null);touchCard.current=null;moved.current=false;
    frameAll();
  }
  function focusStation(id:string){
    if(station===id){setStation(null);setHealth(null);return;}
    const band=baseline.bands.find(b=>b.id===id);if(!band)return;
    setHighlight([]);setHealth(null);setFocus(null);setStation(id);setHover(null);touchCard.current=null;moved.current=false;
    frame([...band.ids,...(id==='unbound'?[]:[id])]);
  }
  useEffect(()=>{const focus=(ev:Event)=>focusStation((ev as CustomEvent<string>).detail);window.addEventListener('roadmap-focus-milestone',focus);return()=>window.removeEventListener('roadmap-focus-milestone',focus);});
  function keepVisible(node:NodeSingular){
    const graph=cy.current!,r=unobscured(),box=node.renderedBoundingBox({includeLabels:false,includeOverlays:false});
    const drawer=document.querySelector('.drawer')?.getBoundingClientRect(),bounds=canvas.current!.getBoundingClientRect();
    if(drawer)r.right=Math.min(r.right,drawer.left-bounds.left-24);
    if(r.right<=r.left||r.bottom<=r.top)return;
    const dx=box.x1<r.left?r.left-box.x1:box.x2>r.right?r.right-box.x2:0,dy=box.y1<r.top?r.top-box.y1:box.y2>r.bottom?r.bottom-box.y2:0;
    if(dx||dy){moved.current=true;viewport(graph.zoom(),{x:graph.pan().x+dx,y:graph.pan().y+dy});}
  }
  const healthTimer=useRef<ReturnType<typeof setTimeout>|null>(null),healthMode=useRef<'hover'|'focus'>('hover');
  function keepHealth(){if(healthTimer.current)clearTimeout(healthTimer.current);}
  function leaveHealth(){keepHealth();healthTimer.current=setTimeout(()=>{if(healthMode.current==='hover'&&!document.querySelector('.station-health:focus-within'))setHealth(null);},150);}
  function blurHealth(ev:React.FocusEvent){if(!(ev.relatedTarget instanceof Element)||!ev.relatedTarget.closest('.station-health,.station'))setHealth(null);}
  function hideHover(){if(hoverTimer.current)clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>{if(!touchCard.current)setHover(null);},150);}
  function chooseResult(id:string){focusNode(id);if(!matchMedia('(pointer: coarse)').matches)open(id);}
  function focusNode(id:string){setHighlight([]);const graph=cy.current,node=graph?.getElementById(id);if(!graph||!node?.length)return;node.select();setSearching(false);setMobileSearch(false);keepVisible(node);canvas.current?.focus();}
  useLayoutEffect(()=>{
    if(!canvas.current||!fontsReady)return;
    performance.mark('roadmap-graph-start');
    const styles=getComputedStyle(document.documentElement),color=(token:string)=>styles.getPropertyValue(token).trim();

    const unitData=(u:typeof m.graph.units[number])=>{const state=/withdrawn/.test(u.meta)?'withdrawn':u.status,gate=u.id.startsWith('milestone:');return {id:u.id,label:gate?gateLabel(u.id):nodeTitle(m.units.find(v=>v.id===u.id)?.title||u.label),title:m.units.find(v=>v.id===u.id)?.title||u.label,compact:gate?gateLabel(u.id):compactIdentifier(e,u.id),system:gate?null:compactSystem(e,u.id),state,gate:gate?1:0};};
    // Cytoscape owns nodes, selection and navigation. The SVG below draws
    // every dependency as a cubic with arrowheads that stay visible at All.
    const graph=cytoscape({container:canvas.current,pixelRatio:Math.min(devicePixelRatio,2),minZoom:.001,maxZoom:2.5,textureOnViewport:true,elements:[
      ...m.graph.units.map(u=>({data:unitData(u),position:{...baseline.positions.get(u.id)!}})),
      ...m.graph.edges.map(([source,target],i)=>({data:{id:`edge:${i}`,source,target,kind:source.startsWith('milestone:')?'waits':target.startsWith('milestone:')?'feeds':'dependency'}})),
    ],layout:{name:'preset'},style:[
      {selector:'node',style:{'background-color':color('--surface'),'border-width':2,'border-color':color('--sig-pending'),'shape':'round-rectangle','corner-radius':3,'width':NODE_WIDTH,'height':NODE_HEIGHT,'label':'data(label)','font-family':'Barlow Semi Condensed','font-size':LABEL_PX,'line-height':1.1,'font-weight':600,'text-wrap':'wrap','text-max-width':NODE_WIDTH-24,'text-valign':'center','text-halign':'left-inside','text-justification':'left','text-margin-x':12,'text-margin-y':-10,'color':color('--ink')}},
      ...states.map(state=>({selector:`node[state="${state}"]`,style:{'border-color':color(`--sig-${state==='withdrawn'?'pending':state}`),'background-color':color('--surface'),'background-opacity':1,'shape':'round-rectangle','border-style':state==='withdrawn'?'dashed':'solid'}})),
      {selector:'node[gate=1]',style:{'shape':'cut-rectangle','width':NODE_WIDTH,'height':NODE_HEIGHT,'background-color':color('--surface'),'border-color':color('--line'),'background-opacity':1,'font-size':12,'text-margin-y':-6,'text-max-width':136}},
      {selector:'node[gate=1][state="passed"]',style:{'background-opacity':1}},
      {selector:'node[gate=1][state="active"],node[gate=1][state="held"]',style:{'background-opacity':1}},
      {selector:'node[gate=1][state="pending"]',style:{'background-opacity':1}},
      {selector:'node[aux=1]',style:{'display':'none','width':6,'height':6,'border-width':0,'background-color':color('--line'),'label':'','events':'no'}},
      {selector:'edge',style:{'curve-style':'straight','line-opacity':0,'source-endpoint':'100% 0%','target-endpoint':'-100% 0%','line-color':color('--muted-ink'),'width':1,'opacity':.32,'target-arrow-shape':'none','target-arrow-color':color('--muted-ink'),'arrow-scale':.65,'target-distance-from-node':3,'z-index':0}},
      {selector:'edge[kind="waits"]',style:{'display':'none','line-style':'dashed'}},
      {selector:'edge[kind="feeds"]',style:{'opacity':.14}},
      {selector:'.dim',style:{'opacity':.25}},
      {selector:'node.dim',style:{'opacity':1,'border-opacity':.35,'color':color('--ink'),'text-opacity':1}},
      {selector:'edge.chain,edge.trace',style:{'opacity':1,'line-color':color('--line'),'target-arrow-color':color('--line'),'width':2}},
      {selector:'edge.exact',style:{'display':'element','opacity':1,'line-color':color('--line'),'target-arrow-color':color('--line'),'width':2}},
      {selector:'node[gate=0].dim',style:{'background-opacity':1}},
      {selector:'node:selected, node.match',style:{'border-color':color('--line'),'border-width':4,'background-opacity':1}},
      {selector:'node.overview',style:{'font-weight':500}},
      {selector:'node.extreme',style:{'label':''}},
      {selector:'node[gate=0].overview[state="pending"]',style:{'border-width':4,'background-opacity':1}}
    ] as cytoscape.StylesheetJson,autoungrabify:true,boxSelectionEnabled:false});
    const clampZoom=()=>{graph.minZoom(.6*fitZoom(graph.nodes('[gate]'),ALL_MARGIN));if(graph.zoom()<graph.minZoom())graph.zoom(graph.minZoom());};
    cy.current=graph;clampZoom();
    if(saved.current?.arc===e.arc){
      const previous=saved.current;
      graph.viewport({zoom:previous.zoom,pan:previous.pan});
      if(!moved.current&&focus==='active'&&activeSignature.current!==JSON.stringify(activeIds()))frame(activeIds());
    }else focusActive(false);
    activeSignature.current=JSON.stringify(activeIds());
    graph.on('select','node',ev=>{const node=ev.target as NodeSingular;graph.nodes().not(node).unselect();setSelected(node.id());keepVisible(node);setHealth(null);document.querySelectorAll<HTMLDetailsElement>('.wait-bus-label[open],.filter-popover[open]').forEach(d=>d.open=false);if(touchCard.current!==node.id())setHover(null);if(!fromRoute.current)canvas.current?.focus({preventScroll:true});});
    const showCard=(node:NodeSingular)=>{setHealth(null);document.querySelectorAll<HTMLDetailsElement>('.wait-bus-label[open],.filter-popover[open]').forEach(d=>d.open=false);if(hoverTimer.current)clearTimeout(hoverTimer.current);const p=node.renderedPosition();setHover(previous=>previous?.id===node.id()&&previous.x===p.x&&previous.y===p.y?previous:{id:node.id(),x:p.x,y:p.y});};
    const hideCard=hideHover;
    graph.on('tap',ev=>{if(ev.target===graph){graph.nodes().unselect();setSelected(null);setHover(null);touchCard.current=null;}});
    const isTouch=(ev:cytoscape.EventObject)=>{const original=ev.originalEvent as TouchEvent|PointerEvent|undefined;return original?.type.startsWith('touch')||('pointerType' in (original??{})&&(original as PointerEvent).pointerType==='touch');};
    graph.on('tap','node[gate]',ev=>{
      if(isTouch(ev)){
        // The renderer adds 8 screen pixels of touch slop. At All that can
        // include several rows, so prefer the actual box beneath the finger.
        const point=ev.renderedPosition;
        const hit=graph.nodes('[gate]').filter(n=>{const box=n.renderedBoundingBox({includeLabels:false});return point.x>=box.x1&&point.x<=box.x2&&point.y>=box.y1&&point.y<=box.y2;}).sort((a,b)=>{const p=(a as NodeSingular).renderedPosition(),q=(b as NodeSingular).renderedPosition();return Math.hypot(p.x-point.x,p.y-point.y)-Math.hypot(q.x-point.x,q.y-point.y);});
        const node=(hit[0]??ev.target) as NodeSingular;
        // Native selection follows tap emission; keep it on the resolved unit.
        queueMicrotask(()=>{if(!graph.destroyed())node.select();});
        if(touchCard.current===node.id()){opener.current(node.id());touchCard.current=null;setHover(null);}else{touchCard.current=node.id();showCard(node);}
      }
    });
    graph.on('dbltap','node[gate]',ev=>{if(!isTouch(ev))opener.current(ev.target.id());});
    graph.on('mouseover mousemove','node[gate]',ev=>showCard(ev.target as NodeSingular));
    graph.on('mouseout','node[gate]',hideCard);
    let frameId=0,labelZoom=-1,detailTier='',fadeTimer:ReturnType<typeof setTimeout>|undefined;
    // Titles are rewrapped only when the rendered title size changes, not on every zoom frame.
    const titles=new Map<string,string>();let titlesAt=0;
    const titleLabel=(node:NodeSingular,font:number)=>{if(titlesAt!==font){titles.clear();titlesAt=font;}const key=`${node.id()}:${node.data('title')}`;let text=titles.get(key);if(text===undefined){text=nodeTitle(String(node.data('title')),font);titles.set(key,text);}return text;};
    const viewport=()=>{
      cancelAnimationFrame(frameId);frameId=requestAnimationFrame(()=>{
        const p=graph.pan(),zoom=graph.zoom();setView({zoom,x:p.x,y:p.y});
        if(zoom!==labelZoom){
          labelZoom=zoom;
          graph.edges().style('width',1/zoom);graph.edges('.chain,.trace,.exact').style({'width':2/zoom,'arrow-scale':Math.max(.65,.6/Math.sqrt(zoom))});
          const nodes=graph.nodes('[gate]');
          const full=zoom>=TITLE_MIN_ZOOM,tiny=zoom<TINY_ZOOM,reserve=tiny?TINY_GLYPH_RESERVE:GLYPH_RESERVE,boxWidth=NODE_WIDTH*zoom;
          // Compact ids are left-aligned past the status glyph and never drawn under it.
          const room=boxWidth-reserve-1.5;
          const shortId=(node:NodeSingular)=>node.data('gate')?node.id().slice(10).replace(/^MS-/,'M'):String(node.data('compact'));
          const fullId=(node:NodeSingular)=>node.data('gate')?node.id().slice(10):String(node.data('compact'));
          const widths=nodes.map(node=>emWidth(shortId(node as NodeSingular)));
          const minimalPx=Math.min(13,...widths.map(w=>room/Math.max(.01,w)),(NODE_HEIGHT*zoom-2)/1.1);
          const nextTier=full?'full':minimalPx>=MIN_ID_PX?'minimal':'status',changed=detailTier!==nextTier,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
          if(changed){clearTimeout(fadeTimer);nodes.stop();}
          const titleFont=full?Math.max(LABEL_PX,Math.ceil(MIN_LABEL_PX/zoom*2)/2):LABEL_PX;
          const compactLabel=(node:NodeSingular)=>{
            const id=fullId(node),base=emWidth(id)*minimalPx<=room?id:shortId(node),system=node.data('system') as string|null;
            return system&&emWidth(`${base} ${system}`)*minimalPx<=room?`${base} ${system}`:base;
          };
          const fade=changed&&detailTier!==''&&!reduced;
          detailTier=nextTier;
          setTier(nextTier);
          graph.batch(()=>{
            nodes.forEach(element=>{
              const node=element as NodeSingular;
              node.toggleClass('overview',!full).toggleClass('extreme',nextTier==='status');
              const label=nextTier==='status'?(fade?node.style('label'):changed?'':node.style('label')):full?(node.data('gate')||titleFont===LABEL_PX?node.data('label'):titleLabel(node,titleFont)):compactLabel(node);
              node.style({'label':label,'font-size':full?titleFont:Math.max(1,minimalPx)/zoom,'text-max-width':node.width()-8,'text-wrap':full?'wrap':'none','text-halign':'left-inside','text-justification':'left','text-margin-x':full?12:reserve/zoom,'text-margin-y':full?-10:0,'border-width':Math.min(16,Math.max(2,(full?1:3)/zoom))});
            });
          });
          if(changed){
            const opacity=nextTier==='status'?0:1;
            if(fade){
              if(opacity)nodes.style('text-opacity',0);
              nodes.animate({style:{'text-opacity':opacity}},{duration:120,queue:false});
              // Removing the outgoing label override reveals the empty status-tier label.
              if(!opacity)fadeTimer=setTimeout(()=>{if(!graph.destroyed())nodes.removeStyle('label');},120);
            }else nodes.style('text-opacity',opacity);
          }
        }
      });
    };
    graph.on('pan zoom',()=>{if(!applying.current)moved.current=true;});
    graph.on('pan zoom',viewport);graph.on('data','node[gate]',()=>{labelZoom=-1;viewport();});viewport();
    const theme=()=>{
      const style=getComputedStyle(document.documentElement),token=(n:string)=>style.getPropertyValue(n).trim();
      const sheet=graph.style().selector('node').style({'color':token('--ink'),'background-color':token('--surface')});
      for(const state of states)sheet.selector(`node[state="${state}"]`).style({'border-color':token(`--sig-${state==='withdrawn'?'pending':state}`),'background-color':token('--surface')});
      sheet.selector('node[gate=1],node[aux=1]').style({'background-color':token('--surface'),'border-color':token('--line')}).selector('edge').style({'line-color':token('--muted-ink'),'target-arrow-color':token('--muted-ink')}).selector('edge.chain,edge.trace,edge.exact').style({'line-color':token('--line'),'target-arrow-color':token('--line')}).selector('node.dim').style({'color':token('--ink')}).selector('node:selected,node.match').style({'border-color':token('--line')}).update();
    };
    window.addEventListener('roadmap-theme',theme);
    void document.fonts.ready.then(()=>{if(!graph.destroyed())graph.resize();});
    const root=region.current!;
    const wheel=(ev:WheelEvent)=>{
      if(!ev.ctrlKey){if((ev.target as Element).closest('.dag-canvas')){graph.stop();applying.current=false;moved.current=true;}return;}
      ev.preventDefault();ev.stopPropagation();graph.stop();applying.current=false;moved.current=true;
      const bounds=canvas.current!.getBoundingClientRect();
      graph.zoom({level:Math.max(graph.minZoom(),Math.min(graph.maxZoom(),graph.zoom()*Math.exp(-ev.deltaY*.01))),renderedPosition:{x:ev.clientX-bounds.left,y:ev.clientY-bounds.top}});
    };
    let pinch:{distance:number;zoom:number;x:number;y:number}|null=null;
    const touch=(ev:TouchEvent)=>{
      if(ev.touches.length<2){pinch=null;return;}
      ev.preventDefault();ev.stopPropagation();graph.stop();applying.current=false;moved.current=true;
      const a=ev.touches[0]!,b=ev.touches[1]!,bounds=canvas.current!.getBoundingClientRect();
      const x=(a.clientX+b.clientX)/2-bounds.left,y=(a.clientY+b.clientY)/2-bounds.top,distance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
      if(!pinch)pinch={distance,zoom:graph.zoom(),x:(x-graph.pan().x)/graph.zoom(),y:(y-graph.pan().y)/graph.zoom()};
      const zoom=Math.max(graph.minZoom(),Math.min(graph.maxZoom(),pinch.zoom*distance/Math.max(1,pinch.distance)));
      graph.viewport({zoom,pan:{x:x-pinch.x*zoom,y:y-pinch.y*zoom}});
    };
    const interrupt=()=>{graph.stop();applying.current=false;};
    root.addEventListener('pointerdown',interrupt,true);
    root.addEventListener('wheel',wheel,{passive:false,capture:true});
    for(const name of ['touchstart','touchmove','touchend','touchcancel'])root.addEventListener(name,touch as EventListener,{passive:false,capture:true});
    const resize=new ResizeObserver(()=>{if(!canvas.current?.clientWidth||!canvas.current?.clientHeight)return;graph.resize();clampZoom();if(!moved.current&&!applying.current)reframe.current();});resize.observe(canvas.current);root.querySelectorAll('.graph-toolbar,.graph-legend,.key-toggle,.graph-minimap,.graph-scale').forEach(el=>resize.observe(el));
    const measure=requestAnimationFrame(()=>{performance.mark('roadmap-graph-painted');performance.measure('roadmap-graph-first-render','roadmap-graph-start','roadmap-graph-painted');});
    performance.measure('roadmap-graph-layout',{start:performance.now()-baseline.elapsed-routed.elapsed,duration:baseline.elapsed+routed.elapsed});
    return()=>{saved.current={arc:e.arc,zoom:graph.zoom(),pan:graph.pan()};if(hoverTimer.current)clearTimeout(hoverTimer.current);clearTimeout(fadeTimer);cancelAnimationFrame(frameId);cancelAnimationFrame(measure);resize.disconnect();root.removeEventListener('wheel',wheel,true);root.removeEventListener('pointerdown',interrupt,true);for(const name of ['touchstart','touchmove','touchend','touchcancel'])root.removeEventListener(name,touch as EventListener,true);window.removeEventListener('roadmap-theme',theme);graph.destroy();cy.current=null;};
  },[structure,fontsReady]);
  useEffect(()=>{
    const signature=JSON.stringify(activeIds());
    if(cy.current&&activeSignature.current!==signature){activeSignature.current=signature;if(focus==='active'&&!moved.current)frame(activeIds());}
  },[e.revision,structure,fontsReady]);
  // The drawer route is the selection: opening a unit by link, Back or lineage selects it, shows its lineage and keeps it beside the drawer.
  const fromRoute=useRef(false);
  useEffect(()=>{const keep=()=>requestAnimationFrame(()=>{const where=route(),id=where.tab==='graph'?where.unit:null,node=id?cy.current?.getElementById(id):null;if(!node?.length)return;if(!node.selected()){fromRoute.current=true;node.select();fromRoute.current=false;}keepVisible(node);});keep();window.addEventListener('hashchange',keep);return()=>window.removeEventListener('hashchange',keep);},[fontsReady,structure]);
  useEffect(()=>{const graph=cy.current;if(!graph)return;graph.batch(()=>{for(const u of m.graph.units){const state=/withdrawn/.test(u.meta)?'withdrawn':u.status;graph.getElementById(u.id).data({state,compact:u.id.startsWith('milestone:')?gateLabel(u.id):compactIdentifier(e,u.id),system:u.id.startsWith('milestone:')?null:compactSystem(e,u.id),label:u.id.startsWith('milestone:')?gateLabel(u.id):nodeTitle(m.units.find(v=>v.id===u.id)?.title||u.label),title:m.units.find(v=>v.id===u.id)?.title||u.label});}});},[e.revision,structure,fontsReady]);
  useEffect(()=>{
    const graph=cy.current;if(!graph)return;
    graph.batch(()=>{
      graph.elements().removeClass('dim chain match exact trace');
      if(selected&&!hover&&!edgeHover){
        const ids=new Set([selected]), edgeIds=new Set<string>();
        for(const edge of graph.edges('[kind="dependency"], [kind="feeds"]')) if(edge.source().id()===selected||edge.target().id()===selected){edgeIds.add(edge.id());ids.add(edge.source().id());ids.add(edge.target().id());}
        const chain=graph.elements().filter(el=>ids.has(el.id())||edgeIds.has(el.id()));
        const exact=graph.edges('[kind="waits"]').filter(edge=>edge.source().id()===selected||edge.target().id()===selected);
        const related=chain.union(exact).union(exact.connectedNodes());graph.elements().difference(related).addClass('dim');chain.edges().addClass('chain');exact.addClass('exact');
      }
      if(hover){
        graph.elements().removeClass('dim chain exact');
        const ids=new Set([hover.id]),edges=new Set<string>();
        for(const edge of graph.edges('[kind="dependency"], [kind="feeds"]')) if(edge.source().id()===hover.id||edge.target().id()===hover.id){edges.add(edge.id());ids.add(edge.source().id());ids.add(edge.target().id());}
        const traced=graph.edges().filter(edge=>edges.has(edge.id()));graph.elements().difference(traced.union(traced.connectedNodes())).addClass('dim');traced.addClass('trace');
        graph.edges('[kind=\"waits\"]').filter(edge=>edge.source().id()===hover.id||edge.target().id()===hover.id).addClass('exact');
      }
      if(edgeHover){
        graph.elements().removeClass('chain trace exact dim');
        const edge=graph.edges().filter(edge=>edge.source().id()===edgeHover.source&&edge.target().id()===edgeHover.target);
        graph.elements().difference(edge.union(edge.connectedNodes())).addClass('dim');edge.addClass('trace');
      }
      if(focus==='active'&&!selected&&!hover&&!edgeHover)graph.nodes('[gate=0]').filter(n=>!active.ids.includes(n.id())).addClass('dim');
      if(highlight.length&&!edgeHover&&!hover)graph.nodes('[gate=0]').filter(n=>!highlight.includes(n.id())).addClass('dim');
      graph.edges().style('width',1/graph.zoom());graph.edges('.chain,.trace,.exact').style({'width':2/graph.zoom(),'arrow-scale':Math.max(.65,.6/Math.sqrt(graph.zoom()))});
      if(filters.length)graph.nodes('[gate]').filter(n=>!filters.includes(n.data('state') as Signal)).addClass('dim');
      if(query){const ids=new Set<string>(results.map(u=>u.id));graph.nodes().filter(n=>ids.has(n.id())).addClass('match');}
    });
  },[selected,hover,edgeHover,highlight,focus,filters,query,e.revision,structure,fontsReady]);
  useEffect(()=>{const key=(ev:KeyboardEvent)=>{if(ev.target instanceof HTMLElement&&(ev.target.matches('input,textarea,select')||ev.target.isContentEditable)||document.querySelector('[role="dialog"]')?.contains(ev.target as Node))return;if(ev.key==='/'){ev.preventDefault();setMobileSearch(true);requestAnimationFrame(()=>search.current?.focus());}if(ev.key==='f'){ev.preventDefault();focusAll();}if(ev.key==='Escape'){setStation(null);setHealth(null);}if(ev.key==='a'){ev.preventDefault();focusActive();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);});
  const selectedUnit=m.units.find(u=>u.id===selected),hovered=m.units.find(u=>u.id===hover?.id);
  const exactWaits=selected?.startsWith('milestone:')?m.graph.edges.filter(([a])=>a===selected).map(([,b])=>b):(waits.get(selected??'')??[]);
  // Exact wait membership remains available in the prerequisite disclosures.
  // Its links are quiet until a unit or gate is hovered or selected.
  const waitGroups = new Map<string,{source:string;band:string;targets:string[]}>();
  for(const [source,target] of m.graph.edges)if(source.startsWith('milestone:')){
    const band=layout.bands.find(b=>b.ids.includes(target));if(!band)continue;
    const key=`${source}:${band.id}`,bus=waitGroups.get(key)??{source,band:band.id,targets:[]};bus.targets.push(target);waitGroups.set(key,bus);
  }
  const waitRows=new Map<string,number>(),freeTop=cy.current?unobscured().top:0;
  const waitLabels=[...waitGroups].map(([key,bus])=>{
    const band=layout.bands.find(b=>b.id===bus.band)!,row=waitRows.get(bus.band)??0;waitRows.set(bus.band,row+1);
    const targets=bus.targets.map(id=>({id}));
    const pending=!e.milestones.find(g=>`milestone:${g.id}`===bus.source)?.passed;
    return {key,...bus,targets,pending,labelX:station===band.id?(layout.positions.get(band.id)?.x??band.x)*view.zoom+view.x-55:band.x*view.zoom+view.x+8,labelY:station===band.id?freeTop+4+row*16:band.y*view.zoom+view.y+24+row*16};
  });
  const currentMilestone=baseline.bands.find(b=>b.id.startsWith("milestone:")&&b.state!=="passed")?.id;
  return <div data-detail-tier={tier} ref={region} className={`graph-view ${focus==='all'?'graph-all':''}`}>
    <nav className="line-map" aria-label="Milestone stations">{baseline.bands.map(band=><button key={band.id} className={`station ${band.id==='unbound'?'station-unbound':''} ${band.id===currentMilestone?'station-current':''}`} aria-description={band.id===currentMilestone?'Next milestone to clear':undefined} aria-pressed={station===band.id} onMouseLeave={leaveHealth} onBlur={blurHealth} onMouseEnter={ev=>{healthMode.current='hover';keepHealth();setHover(null);document.querySelectorAll<HTMLDetailsElement>('.wait-bus-label[open],.filter-popover[open]').forEach(d=>d.open=false);const r=ev.currentTarget.getBoundingClientRect();setHealth({id:band.id,x:r.left,y:r.bottom});}} onFocus={ev=>{healthMode.current=ev.currentTarget.matches(':focus-visible')?'focus':'hover';keepHealth();setHover(null);const r=ev.currentTarget.getBoundingClientRect();setHealth({id:band.id,x:r.left,y:r.bottom});}} onKeyDown={ev=>{if(ev.key==='ArrowLeft'||ev.key==='ArrowRight'){ev.preventDefault();const stations=[...ev.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('.station')],index=stations.indexOf(ev.currentTarget),next=stations[(index+(ev.key==='ArrowRight'?1:-1)+stations.length)%stations.length]!;next.focus();focusStation(baseline.bands[stations.indexOf(next)]!.id);}}} onClick={ev=>{healthMode.current=ev.currentTarget.matches(':focus-visible')?'focus':'hover';focusStation(band.id);if(station===band.id)return;const r=ev.currentTarget.getBoundingClientRect();setHealth({id:band.id,x:r.left,y:r.bottom});}} title={`${e.milestones?.find(g=>`milestone:${g.id}`===band.id)?.name||band.label}: ${band.passed}/${band.total} units passed`}><span className="station-track"><span className="track-fill" style={{width:`${band.total?band.passed/band.total*100:0}%`}}/><span className="gate-glyph" aria-label={band.state}>{glyph[band.state as Signal]}</span></span><span className="station-caption"><strong>{band.id==='unbound'?'No milestone':`${band.id.slice(10)}${band.label!==band.id.slice(10)?` ${band.label}`:''}`}</strong><span>{band.passed}/{band.total}</span>{band.id===currentMilestone&&<small>Next to clear</small>}{(()=>{const g=e.milestones?.find(g=>`milestone:${g.id}`===band.id);const held=(g?.units??band.ids).filter(id=>m.graph.units.find(u=>u.id===id)?.status==='held').length;return held>0&&<small className="station-held">{glyph.held} {held} on hold</small>;})()}</span><span className="station-name">{band.label}</span></button>)}</nav>
    {health&&(()=>{
      const band=baseline.bands.find(b=>b.id===health.id)!,gate=e.milestones?.find(g=>`milestone:${g.id}`===health.id),ids=gate?.units??band.ids;
      const groups=(['passed','active','held','pending','failed','withdrawn'] as Signal[]).map(state=>({state,ids:ids.filter(id=>{const u=m.graph.units.find(u=>u.id===id);return u&&(/withdrawn/.test(u.meta)?'withdrawn':u.status)===state;})}));
      return <div className="station-health" role="group" aria-label={`${health.id.replace('milestone:','')} health`} style={{left:Math.min(health.x,innerWidth-280),top:health.y}} onMouseEnter={keepHealth} onMouseLeave={leaveHealth} onBlur={blurHealth} onKeyDown={ev=>{if(ev.key==='Escape'){setStation(null);setHealth(null);ev.stopPropagation();}}}>
        <strong>{health.id.replace('milestone:','')} {gate?.name}</strong><p>{card.data?.id===gate?.id?card.data?.intent?.text:''}</p>
        {groups.map(group=><button key={group.state} aria-label={group.ids.length?`Show ${group.ids.length} ${signalWords[group.state].toLowerCase()} units`:`0 ${signalWords[group.state].toLowerCase()}`} disabled={!group.ids.length} onClick={()=>{cy.current?.nodes().unselect();setSelected(null);setFocus(null);setStation(health.id);setHighlight(group.ids);setHealth(null);setHover(null);frame(group.ids,true);}}><SignalMark state={group.state}/><span>{group.ids.length?`Show ${group.ids.length} ${signalWords[group.state].toLowerCase()} units`:`0 ${signalWords[group.state].toLowerCase()}`}</span></button>)}
      </div>;
    })()}
    <div className="graph-stage">
      <div ref={canvas} onMouseLeave={hideHover} onFocus={()=>{setHealth(null);if(!touchCard.current)setHover(null);}} className="dag-canvas" role="application" tabIndex={0} aria-label={`Unit dependency graph, ${m.units.length} units. a frames all active units; f frames the whole graph. Arrow keys select nearby visible units; Alt+Arrow follows dependencies. Enter opens details. ${selectedUnit?`Selected ${selectedUnit.title}`:''}`} onKeyDown={ev=>{
        const graph=cy.current;if(!graph)return;
        if(ev.key==='Enter'&&selected){ev.preventDefault();open(selected);return;}
        if(!ev.key.startsWith('Arrow'))return;ev.preventDefault();
        const visible=graph.nodes('[gate=0]').filter(n=>{const p=n.renderedPosition();return p.x>0&&p.x<graph.width()&&p.y>60&&p.y<graph.height()-40;});
        const center={x:graph.width()/2,y:graph.height()/2};
        if(!selected){
          const preferred=focus==='active'?visible.filter(n=>active.seeds.includes(n.id())):station!==null?visible.filter(n=>baseline.bands.find(b=>b.id===station)?.ids.includes(n.id())===true):visible;
          const initial=(preferred.length?preferred:visible).sort((a,b)=>{const p=(a as NodeSingular).renderedPosition(),q=(b as NodeSingular).renderedPosition();return Math.hypot(p.x-center.x,p.y-center.y)-Math.hypot(q.x-center.x,q.y-center.y);})[0];initial?.select();return;
        }
        const current=graph.getElementById(selected),p=current.renderedPosition();
        const upstream=ev.key==='ArrowLeft'||ev.key==='ArrowUp';
        const candidates=ev.altKey?(upstream?current.incomers('node[gate=0]'):current.outgoers('node[gate=0]')):visible;
        const horizontal=ev.key==='ArrowLeft'||ev.key==='ArrowRight',sign=upstream?-1:1;
        const ranked=candidates.filter(n=>n.id()!==selected).map(n=>{const q=(n as NodeSingular).renderedPosition(),dx=q.x-p.x,dy=q.y-p.y,along=(horizontal?dx:dy)*sign,across=Math.abs(horizontal?dy:dx);return {n,along,score:Math.hypot(dx,dy)+across*2};}).filter(v=>ev.altKey||v.along>1).sort((a,b)=>a.score-b.score);
        const next=ranked[0]?.n;if(next){if(ev.altKey)focusNode(next.id());else next.select();}
      }}/>
      <svg className="graph-edges" aria-hidden="true">
        <defs><marker id="dependency-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke"/></marker></defs>
        {curves.map((curve,i)=>{
          const waits=curve.source.startsWith('milestone:'),feeds=curve.target.startsWith('milestone:');
          const traced=edgeHover?edgeHover.source===curve.source&&edgeHover.target===curve.target:[curve.source,curve.target].includes(hover?.id??selected??'');
          if(waits&&!traced)return null;
          const dim=!!(hover||selected||edgeHover)&&!traced;
          // Coordinates and marker dimensions are in screen pixels. Arrowheads
          // remain visible at All, without inflating the curves at full zoom.
          const path=curve.path.replace(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g,(_,x,y)=>`${Number(x)*view.zoom+view.x} ${Number(y)*view.zoom+view.y}`);
          return <path key={i} data-source={curve.source} data-target={curve.target} data-kind={waits?'waits':feeds?'feeds':'dependency'} className={`graph-edge ${traced?'edge-traced':''} ${dim?'edge-dim':''}`} d={path} fill="none" markerEnd="url(#dependency-arrow)"/>;
        })}
      </svg>
      <div className="wait-bus-labels">{waitLabels.map(bus=><details key={bus.key} className="wait-bus-label" onMouseEnter={ev=>{setHover(null);setHealth(null);document.querySelectorAll<HTMLDetailsElement>('.wait-bus-label[open]').forEach(d=>{if(d!==ev.currentTarget)d.open=false;});ev.currentTarget.open=true;}} onMouseLeave={ev=>{if(!ev.currentTarget.contains(document.activeElement))ev.currentTarget.open=false;}} onFocus={ev=>{setHover(null);setHealth(null);ev.currentTarget.open=true;}} onBlur={ev=>{if(!ev.currentTarget.contains(ev.relatedTarget))ev.currentTarget.open=false;}} onKeyDown={ev=>{if(ev.key==='Escape'){ev.currentTarget.open=false;ev.currentTarget.querySelector('summary')?.focus();ev.stopPropagation();}}} style={{left:bus.labelX,top:bus.labelY,display:view.zoom*LABEL_PX<MIN_LABEL_PX&&station!==bus.band?'none':undefined}}>
        <summary onClick={ev=>{ev.preventDefault();ev.currentTarget.parentElement!.setAttribute('open','');}} aria-label={`${bus.source.slice(10)}: ${bus.targets.length} ${bus.pending?'waiting':'linked'} units in ${bus.band.replace('milestone:','')}`} title={`${bus.source.slice(10)} ${bus.pending?'Pending':'Passed'}`}>{`${bus.targets.length} units here ${bus.pending?'wait for':'depend on'} ${bus.source.slice(10)}`}</summary>
        <div className="wait-bus-targets" style={{left:Math.min(0,(canvas.current?.clientWidth??innerWidth)-24-bus.labelX-220)}}><strong>{glyph[bus.pending?'pending':'passed']} {bus.source.slice(10)} {bus.pending?'Pending':'Passed'}</strong>{bus.targets.map(p=><button key={p.id} onClick={()=>focusNode(p.id)}>{p.id}</button>)}</div>
      </details>)}</div>
      <div className="node-signals" aria-hidden="true">{m.graph.units.map(u=>{
        const p=layout.positions.get(u.id),node=cy.current?.getElementById(u.id);if(!p||!node?.length)return null;
        const compact=tier!=='full',tiny=compact&&view.zoom<.25,w=node.width()*view.zoom,h=node.height()*view.zoom,x=p.x*view.zoom+view.x-w/2,y=p.y*view.zoom+view.y-h/2;
        if(x+w<0||x>(canvas.current?.clientWidth??innerWidth)||y+h<0||y>(canvas.current?.clientHeight??innerHeight))return null;
        const state=/withdrawn/.test(u.meta)?'withdrawn':u.status,mark=u.finished?'finished':state;
        return <span key={u.id} data-state={mark} className={`node-signal ${tier==='status'?'node-signal-status ':''}${compact?'node-signal-compact':'node-status-row'} ${tiny?'node-signal-tiny':''}`} style={compact?{left:x+(tiny?1:4),top:y+h/2-(tiny?4:6)}:{left:x+1,top:y+h-Math.max(16,22*view.zoom),width:w-2,height:Math.max(16,22*view.zoom),fontSize:Math.max(10,12*view.zoom)}}><SignalMark state={mark}/>{!compact&&<span>{u.id.startsWith('milestone:')?'Gate':u.id} {u.word}</span>}</span>;
      })}</div>
      <div className="band-captions" aria-hidden="true">{layout.bands.map(b=><div key={b.id} className={`band-caption ${station===b.id?'band-focused':''}`} style={{left:b.x*view.zoom+view.x,top:b.y*view.zoom+view.y,width:b.width*view.zoom,height:b.height*view.zoom}}/>)}</div>
      <div className="band-headings">{layout.bands.map(b=>{
        const left=b.x*view.zoom+view.x,right=left+b.width*view.zoom,bottom=(b.y+b.height)*view.zoom+view.y;
        if(right<0||left>(canvas.current?.clientWidth??innerWidth)||bottom<76)return null;
        const minX=Math.max(8,left+8),maxX=Math.min(right-8,(canvas.current?.clientWidth??innerWidth)-8);
        const boxes=cy.current?.nodes('[gate]').map(node=>node.renderedBoundingBox({includeLabels:false}))??[];
        const candidates=[Math.max(72,b.y*view.zoom+view.y-24),72,...boxes.map(box=>box.y2+2)].filter(y=>y>=72&&y+20<=Math.min(bottom,(canvas.current?.clientHeight??innerHeight)-48));
        let heading:{left:number;top:number;width:number}|undefined;
        for(const top of candidates){
          const occupied=boxes.filter(box=>box.y1<top+20&&box.y2>top).sort((a,b)=>a.x1-b.x1);
          let cursor=minX;const gaps:{left:number;width:number}[]=[];
          for(const box of occupied){if(box.x2<cursor||box.x1>maxX)continue;if(box.x1>cursor)gaps.push({left:cursor,width:box.x1-cursor-2});cursor=Math.max(cursor,box.x2+2);}
          gaps.push({left:cursor,width:maxX-cursor});
          const gap=gaps.sort((a,b)=>b.width-a.width)[0];if(gap&&gap.width>=56){heading={...gap,top};break;}
        }
        return heading&&<div key={b.id} title={`${b.id.replace('milestone:','')} ${b.label}`} style={heading}><strong>{b.id==='unbound'?'No milestone':`${b.id.replace('milestone:','')} ${b.label}`}</strong><span>{b.passed}/{b.total}</span></div>;
      })}</div>
      <div className={`graph-toolbar ${mobileSearch?'search-expanded':''}`} role="toolbar" aria-label="Graph controls">
        <div className="graph-search"><Button className="search-toggle" size="icon" variant="ghost" aria-label="Find a unit" onClick={()=>{setMobileSearch(!mobileSearch);requestAnimationFrame(()=>search.current?.focus());}}><Search size={16}/></Button><input ref={search} aria-label="Search units" value={query} onFocus={()=>setSearching(true)} onChange={ev=>{setQuery(ev.target.value);setResultIndex(0);setSearching(true);}} placeholder="Find a unit  /" onKeyDown={ev=>{if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ev.preventDefault();setResultIndex((resultIndex+(ev.key==='ArrowDown'?1:-1)+results.length)%Math.max(1,results.length));}if(ev.key==='Enter'&&results[resultIndex]){ev.preventDefault();chooseResult(results[resultIndex].id);}if(ev.key==='Escape'){setQuery('');setMobileSearch(false);canvas.current?.focus();}}}/>{query&&searching&&<div className="search-results">{results.length?results.map((u,i)=><button key={u.id} aria-selected={i===resultIndex} onFocus={()=>setResultIndex(i)} onClick={()=>chooseResult(u.id)}>{u.title}<small>{u.id}</small></button>):<p>No matching units</p>}</div>}</div>
        <div className="focus-control" role="group" aria-label="Graph focus"><button aria-label="Active focus" aria-pressed={focus==='active'&&!station} title="All active units" onClick={()=>focusActive()}>Active</button><button aria-label="All focus" aria-pressed={focus==='all'&&!station} title="The whole graph" onClick={focusAll}>All</button></div>
        <details className="filter-popover"><summary title="Filter unit states">Filters{filters.length?` (${filters.length})`:''}</summary><div className="status-filters">{states.map(state=><Button key={state} variant="ghost" title={`Filter ${state}`} aria-label={`Filter ${state}`} aria-pressed={filters.includes(state)} onClick={()=>setFilters(filters.includes(state)?filters.filter(v=>v!==state):[...filters,state])}><SignalMark state={state}/>{unitSignalWords[state]}</Button>)}</div></details>
        <div className="zoom-controls"><Button className="zoom-step" size="icon" variant="ghost" aria-label="Zoom out" onClick={()=>cy.current?.zoom({level:cy.current.zoom()/1.35,renderedPosition:{x:canvas.current!.clientWidth/2,y:canvas.current!.clientHeight/2}})}><Minus size={15}/></Button><Button className="zoom-step" size="icon" variant="ghost" aria-label="Zoom in" onClick={()=>cy.current?.zoom({level:cy.current.zoom()*1.35,renderedPosition:{x:canvas.current!.clientWidth/2,y:canvas.current!.clientHeight/2}})}><Plus size={15}/></Button></div>
      </div>

      {selected&&!health&&!(phone&&hovered&&hover?.id===selected)&&<div className="graph-selection"><div><strong>{selected.startsWith('milestone:')?selected.slice(10):<><span className="unit-id">{selected}</span> {selectedUnit?.title}</>}</strong><small>{selectedUnit&&<>{stateWords(selectedUnit.state)} {stageStatusWords(selectedUnit.stage,selectedUnit.stageFinished)}</>}</small><details className="exact-relations" open={exactWaits.length<=6}><summary>{selected.startsWith('milestone:')?'Linked units':'Waits for milestone'} ({exactWaits.length})</summary><div>{exactWaits.map(id=><button key={id} onClick={()=>focusNode(id)}>{id.startsWith('milestone:')?<><SignalMark state={e.milestones.find(g=>`milestone:${g.id}`===id)?.passed?'passed':'pending'}/>{id.slice(10)} {e.milestones.find(g=>`milestone:${g.id}`===id)?.passed?'Passed':'Pending'}</>:id}</button>)}{!exactWaits.length&&<small>None</small>}</div></details></div><Button onClick={()=>open(selected)} aria-label={`Open ${selected} details`}>Details</Button></div>}
      {hover&&hovered&&<div className="graph-hover" role="group" aria-label="Unit title card" onMouseEnter={()=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);}} onMouseLeave={hideHover} onBlur={ev=>{if(!ev.currentTarget.contains(ev.relatedTarget))setHover(null);}} style={{left:Math.max(8,Math.min(hover.x+24,(canvas.current?.clientWidth??400)-260)),top:Math.max(64,hover.y+180<(canvas.current?.clientHeight??500)?hover.y+20:hover.y-180)}}><strong>{hovered.title}</strong><span>{stateWords(hovered.state)} {stageStatusWords(hovered.stage,hovered.stageFinished)}</span>{unmet.has(hovered.id)&&<span>Waits for milestone: {unmet.get(hovered.id)!.map(g=>g.slice(10)).join(', ')}</span>}<span>{card.data?.unit?.id===hovered.id?`${card.data.unit.startedAt&&!card.data.unit.endedAt&&!card.data.unit.arcEndedAt?'Running ':''}${elapsed(card.data.unit.startedAt&&!card.data.unit.endedAt&&!card.data.unit.arcEndedAt?Math.max(0,now-Date.parse(card.data.unit.startedAt)):card.data.unit.elapsedMs)}, ${pluralise(card.data.unit.attempts,'run')}`:card.error||'Reading recorded work…'}</span><Button onClick={()=>{open(hovered.id);setHover(null);touchCard.current=null;}}>Details</Button></div>}
      <button className="key-toggle" aria-expanded={keyOpen} onClick={()=>setKeyOpen(!keyOpen)}>Legend</button><div className={`graph-legend ${keyOpen?'key-open':''}`} aria-label="Graph legend">{states.map(state=><span key={state}><SignalMark state={state}/>{unitSignalWords[state]}</span>)}<span><SignalMark state="finished"/>{unitSignalWords.finished}</span><span className="edge-key">Solid: depends on</span><span className="edge-key dashed">Dashed: waits for milestone</span><span className="graph-keys">a Active, f All</span></div>
      <svg className="graph-minimap" viewBox={`0 0 ${layout.width||100} ${layout.height||100}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Graph overview. Click to pan." onClick={ev=>{const graph=cy.current;if(!graph)return;const bounds=ev.currentTarget.getBoundingClientRect(),scale=Math.min(bounds.width/layout.width,bounds.height/layout.height),x=(ev.clientX-bounds.left-(bounds.width-layout.width*scale)/2)/scale,y=(ev.clientY-bounds.top-(bounds.height-layout.height*scale)/2)/scale;graph.pan({x:graph.width()/2-x*graph.zoom(),y:graph.height()/2-y*graph.zoom()});}}>{layout.bands.map(b=><rect key={b.id} x={b.x} y={b.y} width={b.width} height={b.height} fill="var(--surface)" stroke="var(--rule)" strokeWidth={8}/>)}{m.graph.units.map(n=>{const p=layout.positions.get(n.id);return p&&<rect key={n.id} x={p.x-60} y={p.y-18} width={120} height={36} fill={`var(--sig-${n.status})`}/>;})}<rect x={-view.x/view.zoom} y={-view.y/view.zoom} width={(canvas.current?.clientWidth??0)/view.zoom} height={(canvas.current?.clientHeight??0)/view.zoom} fill="var(--line)" fillOpacity={.08} stroke="var(--line)" strokeWidth={12}/></svg>
      {focus==='active'&&!active.seeds.length&&fallback&&<span className="graph-caption">No active units; showing {fallback.id==='unbound'?'all units':fallback.id.replace('milestone:','')}</span>}
      <span className="graph-scale">{Math.round(view.zoom*100)}% <span>{m.units.length} units</span></span>
    </div>
  </div>;
}
