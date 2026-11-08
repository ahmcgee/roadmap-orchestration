import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type NodeSingular } from 'cytoscape';
import { Focus, Minus, Plus, Search } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { activeFocus, compactIdentifier, graphLayout, LABEL_PX, MIN_LABEL_PX, NODE_HEIGHT, NODE_WIDTH } from './graph-layout.ts';
import { Clock, elapsed, glyph, pluralise, SignalMark } from './shared.tsx';
import type { Envelope, Signal } from './types.ts';
function nodeTitle(title:string){
  const context=document.createElement('canvas').getContext('2d')!;context.font=`600 ${LABEL_PX}px \"Barlow Semi Condensed\"`;
  const lines=[''];for(const word of title.split(/\s+/)){const last=lines.length-1,next=lines[last]?`${lines[last]} ${word}`:word;if(context.measureText(next).width>NODE_WIDTH-24&&lines[last]){if(lines.length===3){while(context.measureText(lines[last]+'…').width>NODE_WIDTH-24)lines[last]=lines[last]!.slice(0,-1);lines[last]+='…';break;}lines.push(word);}else lines[last]=next;}return lines.join('\n');
}
const states: Signal[] = ['passed','active','held','failed','pending','withdrawn'];
type FocusMode = 'active' | 'milestone' | 'all';
export function Graph({ e, open }: { e: Envelope; open: (id: string) => void }) {
  const now=useContext(Clock), m=e.data.console;
  const canvas=useRef<HTMLDivElement>(null), cy=useRef<Core|null>(null), search=useRef<HTMLInputElement>(null), opener=useRef(open), saved=useRef<{arc:string;zoom:number;pan:{x:number;y:number};positions:Map<string,{x:number;y:number}>;sizes:Map<string,{width:number;height:number}>}|null>(null);
  opener.current=open;
  const [resultIndex,setResultIndex]=useState(0);
  const [selected,setSelected]=useState<string|null>(null), [query,setQuery]=useState(''), [searching,setSearching]=useState(false), [filters,setFilters]=useState<Signal[]>([]), [station,setStation]=useState<string|null>(null);
  const [fontsReady,setFontsReady]=useState(false);
  useEffect(()=>{let disposed=false;void Promise.all([document.fonts.load('500 11px "Barlow Semi Condensed"'),document.fonts.load('600 16px "Barlow Semi Condensed"')]).then(()=>{if(!disposed)setFontsReady(true);});return()=>{disposed=true;};},[]);
  const [focus,setFocus]=useState<FocusMode>('active'), [cluster,setCluster]=useState(0), [paged,setPaged]=useState(false), [keyOpen,setKeyOpen]=useState(false), [mobileSearch,setMobileSearch]=useState(false);
  const [health,setHealth]=useState<{id:string;x:number;y:number}|null>(null),[highlight,setHighlight]=useState<string[]>([]),[edgeHover,setEdgeHover]=useState<{source:string;target:string}|null>(null);
  useEffect(()=>{const change=(ev:Event)=>setEdgeHover((ev as CustomEvent).detail);window.addEventListener('roadmap-edge',change);return()=>window.removeEventListener('roadmap-edge',change);},[]);
  const touchCard=useRef<string|null>(null), hoverTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [hover,setHover]=useState<{id:string;x:number;y:number}|null>(null), [view,setView]=useState({zoom:1,x:0,y:0});
  const structure=JSON.stringify([e.arc,m.graph.units.map(u=>u.id),m.graph.edges,e.data.plan?.milestones]);
  const positioned=useMemo(()=>graphLayout(e),[structure]);
  const baseline={...positioned,bands:positioned.bands.map(b=>{const gate=e.data.plan?.milestones?.find(g=>`milestone:${g.id}`===b.id),state=e.data.display.status.milestones.find(g=>`milestone:${g.id}`===b.id);return gate?{...b,passed:gate.units.filter(id=>m.graph.units.find(u=>u.id===id)?.status==='passed').length,state:state?.passed?'passed':state?.state==='walking'?'active':state?.state==='blocked'?'held':'pending'}:b;})};
  const arrangement=useRef<ReturnType<typeof graphLayout>|null>(null);
  const [arranged,setArranged]=useState<typeof baseline|null>(null), layout={...(arranged??baseline),bands:(arranged??baseline).bands.map(b=>{const live=baseline.bands.find(v=>v.id===b.id);return live?{...b,passed:live.passed,state:live.state}:b;})};
  useEffect(()=>{const close=()=>setHealth(null);window.addEventListener('hashchange',close);return()=>window.removeEventListener('hashchange',close);},[]);
  const active=activeFocus(e), phone=(canvas.current?.clientWidth??innerWidth)<=640;
  const results=query.trim()?m.presentation.units.filter(u=>`${u.title} ${u.id}`.toLowerCase().includes(query.toLowerCase())).slice(0,12):[];
  const waits=useMemo(()=>{
    const map=new Map<string,string[]>();for(const [a,b] of m.graph.edges)if(a.startsWith('milestone:'))map.set(b,[...map.get(b)??[],a]);return map;
  },[structure]);
  const unmet=new Map<string,string[]>([...waits].map(([id,gates])=>[id,gates.filter(g=>!e.data.display.status.milestones.find(v=>`milestone:${v.id}`===g)?.passed)] as [string,string[]]).filter(([,gates])=>gates.length>0));
  const gateLabel=(id:string)=>{const b=baseline.bands.find(b=>b.id===id);return b?`${id.slice(10)}\n${b.passed}/${b.total}  ${b.state==='active'?'Walking':b.state==='held'?'Blocked':b.state==='passed'?'Passed':'Pending'}`:id;};
  function place(next:typeof baseline, sizes?:Map<string,{width:number;height:number}>){
    const graph=cy.current;if(!graph)return;
    graph.batch(()=>{
      for(const [id,p] of next.positions){const node=graph.getElementById(id);node.position({...p});const size=sizes?.get(id);node.data({compactWidth:size?.width??(node.data('gate')?160:NODE_WIDTH),compactHeight:size?.height??(node.data('gate')?80:NODE_HEIGHT)});}
      for(const band of next.bands)graph.getElementById(`bus:${band.id}`).position({x:band.x+12,y:band.y+32});
    });arrangement.current=next;setArranged(next);
  }
  function frame(ids:string[], readable:boolean, centers:string[]=ids){
    const graph=cy.current;if(!graph)return;
    const nodes=graph.nodes().filter(n=>ids.includes(n.id()));if(!nodes.length)return;
    graph.resize();
    const w=graph.width(),h=graph.height(),padding=w<=640?28:90;
    const box=nodes.boundingBox(),fit=Math.min((w-padding*2)/Math.max(1,box.w),(h-160)/Math.max(1,box.h));
    const zoom=Math.min(1,Math.max(readable?11/LABEL_PX:graph.minZoom(),fit));
    // Keep live nodes central if a broad direct-neighbour set needs panning.
    const center=fit<zoom?graph.nodes().filter(n=>centers.includes(n.id())).boundingBox():box;
    graph.viewport({zoom,pan:{x:w/2-(center.x1+center.x2)/2*zoom,y:w<=640?120-(center.y1+center.y2)/2*zoom:(h+60)/2-(center.y1+center.y2)/2*zoom}});
  }
  function focusActive(index=0){
    setHighlight([]);setHealth(null);
    setFocus('active');setStation(null);setCluster(index);setHover(null);touchCard.current=null;
    const narrow=(canvas.current?.clientWidth??innerWidth)<=640;
    const points=active.seeds.map(id=>baseline.positions.get(id)!);
    const needsPages=narrow||(Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x))+NODE_WIDTH)*11/LABEL_PX>(cy.current?.width()??innerWidth)-32||(Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))+NODE_HEIGHT)*11/LABEL_PX>(cy.current?.height()??innerHeight)-160;
    setPaged(needsPages);
    const ids=needsPages?(active.clusters[index]??active.ids):active.ids;
    place(baseline);
    cy.current?.style().selector('edge').style({'taxi-direction':'auto'}).update();
    frame(ids,true,needsPages?[active.seeds[index]!]:active.seeds);
  }
  function focusAll(){
    setHighlight([]);setHealth(null);
    setFocus('all');setStation(null);setHover(null);touchCard.current=null;
    const graph=cy.current;if(!graph)return;
    graph.resize();
    frame(m.graph.units.map(u=>u.id),false);
  }
  function focusStation(id:string){
    const band=baseline.bands.find(b=>b.id===id);if(!band)return;
    setHighlight([]);setFocus('milestone');setStation(id);setHover(null);touchCard.current=null;
    frame([...band.ids,...(id==='unbound'?[]:[id])],true,phone&&id!=='unbound'?[id]:[...band.ids,...(id==='unbound'?[]:[id])]);
  }
  function fitFocus(){if(focus==='active')focusActive(cluster);else if(focus==='milestone'&&station)focusStation(station);else focusAll();}
  function hideHover(){if(hoverTimer.current)clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>{if(!touchCard.current)setHover(null);},180);}
  function chooseResult(id:string){focusNode(id);if(!matchMedia('(pointer: coarse)').matches)open(id);}
  function focusNode(id:string){setHighlight([]);const graph=cy.current,node=graph?.getElementById(id);if(!graph||!node?.length)return;node.select();setSearching(false);setMobileSearch(false);frame([id],true);canvas.current?.focus();}
  useLayoutEffect(()=>{
    if(!canvas.current||!fontsReady)return;
    performance.mark('roadmap-graph-start');
    const styles=getComputedStyle(document.documentElement),color=(token:string)=>styles.getPropertyValue(token).trim();
    const fill=(state:string)=>{const current=getComputedStyle(document.documentElement),paint=(t:string)=>current.getPropertyValue(t).trim(),expand=(hex:string)=>hex.length===4?'#'+[...hex.slice(1)].map(c=>c+c).join(''):hex,a=expand(paint('--surface')),b=expand(paint(`--sig-${state==='withdrawn'?'pending':state}`)),mix=state==='pending'?0:state==='withdrawn'?.04:.16;return '#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-mix)+parseInt(b.slice(i,i+2),16)*mix).toString(16).padStart(2,'0')).join('');};
    const unitData=(u:typeof m.graph.units[number])=>{const state=/withdrawn/.test(u.meta)?'withdrawn':u.status,gate=u.id.startsWith('milestone:');return {id:u.id,label:gate?gateLabel(u.id):nodeTitle(m.presentation.units.find(v=>v.id===u.id)?.title||u.label),compact:gate?gateLabel(u.id):compactIdentifier(e,u.id),compactWidth:gate?160:NODE_WIDTH,compactHeight:gate?80:NODE_HEIGHT,state,gate:gate?1:0};};
    const bundles=new Map<string,{source:string;target:string;count:number}>();
    for(const [source,target] of m.graph.edges)if(source.startsWith('milestone:')){const band=baseline.bands.find(b=>b.ids.includes(target));if(band){const key=`${source}:${band.id}`,existing=bundles.get(key);bundles.set(key,{source,target:`bus:${band.id}`,count:(existing?.count??0)+1});}}
    const graph=cytoscape({container:canvas.current,pixelRatio:Math.min(devicePixelRatio,2),minZoom:.005,maxZoom:2.5,textureOnViewport:true,elements:[
      ...m.graph.units.map(u=>({data:unitData(u),position:{...baseline.positions.get(u.id)!}})),
      ...baseline.bands.map(b=>({data:{id:`bus:${b.id}`,aux:1,label:''},position:{x:b.x+12,y:b.y+32},selectable:false})),
      ...m.graph.edges.map(([source,target],i)=>({data:{id:`edge:${i}`,source,target,kind:source.startsWith('milestone:')?'waits':target.startsWith('milestone:')?'feeds':'dependency'}})),
      ...[...bundles].map(([id,data])=>({data:{id:`bundle:${id}`,...data,kind:'bundle'}}))
    ],layout:{name:'preset'},style:[
      {selector:'node',style:{'background-color':color('--surface'),'border-width':2,'border-color':color('--sig-pending'),'shape':'round-rectangle','corner-radius':3,'width':NODE_WIDTH,'height':NODE_HEIGHT,'label':'data(label)','font-family':'Barlow Semi Condensed','font-size':LABEL_PX,'line-height':1.1,'font-weight':600,'text-wrap':'wrap','text-max-width':NODE_WIDTH-24,'text-valign':'center','text-halign':'left-inside','text-justification':'left','text-margin-x':12,'text-margin-y':-10,'color':color('--ink')}},
      ...states.map(state=>({selector:`node[state="${state}"]`,style:{'border-color':color(`--sig-${state==='withdrawn'?'pending':state}`),'background-color':fill(state),'background-opacity':1,'shape':state==='held'?'hexagon':state==='failed'?'diamond':state==='active'?'rectangle':'round-rectangle','border-style':state==='withdrawn'?'dashed':'solid'}})),
      {selector:'node[gate=1]',style:{'shape':'round-rectangle','width':160,'height':80,'background-color':color('--line'),'border-color':color('--line'),'background-opacity':.08,'font-size':12,'text-margin-y':-6,'text-max-width':136}},
      {selector:'node[gate=1][state="passed"]',style:{'background-opacity':.12}},
      {selector:'node[gate=1][state="active"],node[gate=1][state="held"]',style:{'background-opacity':.08}},
      {selector:'node[gate=1][state="pending"]',style:{'background-opacity':0}},
      {selector:'node[aux=1]',style:{'width':6,'height':6,'border-width':0,'background-color':color('--line'),'label':'','events':'no'}},
      {selector:'edge',style:{'curve-style':'taxi','taxi-direction':'auto','taxi-turn':24,'line-color':color('--muted-ink'),'width':1,'opacity':.32,'target-arrow-shape':'triangle','target-arrow-color':color('--muted-ink'),'arrow-scale':.65}},
      {selector:'edge[kind="waits"]',style:{'display':'none','line-style':'dashed'}},
      {selector:'edge[kind="bundle"]',style:{'display':'none','curve-style':'unbundled-bezier','control-point-distances':-100,'control-point-weights':.5,'line-color':color('--line'),'line-style':'dashed','opacity':.24,'target-arrow-shape':'none'}},
      {selector:'edge[kind="feeds"]',style:{'curve-style':'bezier','opacity':.14}},
      {selector:'.dim',style:{'opacity':.25}},
      {selector:'node.dim',style:{'opacity':1,'border-opacity':.35,'color':color('--muted-ink'),'text-opacity':1,'text-background-color':color('--paper'),'text-background-opacity':1,'text-background-padding':1}},
      {selector:'edge.chain,edge.trace',style:{'opacity':1,'line-color':color('--line'),'target-arrow-color':color('--line'),'width':2}},
      {selector:'edge.exact',style:{'display':'element','opacity':1,'line-color':color('--line'),'target-arrow-color':color('--line'),'width':2}},
      {selector:'node[gate=0].dim',style:{'background-opacity':.45}},
      {selector:'node:selected, node.match',style:{'border-color':color('--line'),'border-width':4,'background-opacity':1}},
      {selector:'node.overview',style:{'label':'data(compact)','line-height':14/11,'font-weight':500,'font-size':88,'text-max-width':10000,'text-wrap':'none','text-halign':'left-inside','text-margin-x':0,'text-margin-y':0,'width':'data(compactWidth)','height':'data(compactHeight)','border-width':1}},
      {selector:'node[gate=1].overview',style:{'shape':'round-rectangle','text-wrap':'wrap','text-max-width':1000}},
      {selector:'node.extreme',style:{'label':''}},
      {selector:'node[gate=0].overview[state="pending"]',style:{'border-width':4,'background-opacity':1}}
    ] as cytoscape.StylesheetJson,autoungrabify:true,boxSelectionEnabled:false});
    cy.current=graph;setArranged(null);
    if(saved.current?.arc===e.arc){
      const previous=saved.current;
      graph.batch(()=>{for(const [id,p] of previous.positions){const node=graph.getElementById(id),size=previous.sizes.get(id);node.position({...p});if(size)node.data({compactWidth:size.width,compactHeight:size.height});}});
      if(arrangement.current){const retained={...arrangement.current,positions:new Map([...baseline.positions,...previous.positions])};arrangement.current=retained;setArranged(retained);}
      graph.viewport({zoom:previous.zoom,pan:previous.pan});
    }else focusActive();
    graph.on('select','node',ev=>{const node=ev.target as NodeSingular;graph.nodes().not(node).unselect();setSelected(node.id());if(touchCard.current!==node.id())setHover(null);canvas.current?.focus({preventScroll:true});});
    const showCard=(node:NodeSingular)=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);const p=node.renderedPosition();setHover(previous=>previous?.id===node.id()&&previous.x===p.x&&previous.y===p.y?previous:{id:node.id(),x:p.x,y:p.y});};
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
    let frameId=0,labelZoom=-1;
    const viewport=()=>{
      cancelAnimationFrame(frameId);frameId=requestAnimationFrame(()=>{
        const p=graph.pan(),zoom=graph.zoom();setView({zoom,x:p.x,y:p.y});
        if(zoom!==labelZoom){
          labelZoom=zoom;
          graph.edges().style('width',1/zoom);graph.edges('.chain,.trace,.exact').style({'width':2/zoom,'arrow-scale':Math.max(.65,.6/Math.sqrt(zoom))});
          const context=document.createElement('canvas').getContext('2d')!;
          graph.batch(()=>{
            graph.nodes('[gate]').forEach(node=>{
              const gate=node.data('gate')===1,width=gate?160:NODE_WIDTH,height=gate?80:NODE_HEIGHT;
              const titleSize=LABEL_PX;
              context.font=`600 ${titleSize}px "Barlow Semi Condensed"`;
              const title=String(node.data('label')),lines=title.split('\n');
              const titleFits=titleSize*zoom>=MIN_LABEL_PX && Math.max(...lines.map(line=>context.measureText(line).width))<=width-24 && lines.length*titleSize*1.1<=height-24;
              const compact=gate?node.id().slice(10):String(node.data('compact'));
              context.font='500 10px "Barlow Semi Condensed"';
              const compactFits=context.measureText(compact).width+24<=width*zoom && 14<=height*zoom;
              node.toggleClass('overview',!titleFits&&compactFits).toggleClass('extreme',!titleFits&&!compactFits);
              node.style({'label':titleFits?title:compactFits?compact:'','width':width,'height':height,'font-size':titleFits?titleSize:10/zoom,'text-max-width':width-24,'text-wrap':titleFits?'wrap':'none','text-margin-x':titleFits?12:18/zoom,'text-margin-y':titleFits?-10:0,'border-width':Math.min(16,Math.max(2,1/zoom))});
            });
          });
        }
      });
    };
    graph.on('pan zoom',viewport);graph.on('data','node[gate]',()=>{labelZoom=-1;viewport();});viewport();
    const theme=()=>{
      const style=getComputedStyle(document.documentElement),token=(n:string)=>style.getPropertyValue(n).trim();
      const sheet=graph.style().selector('node').style({'color':token('--ink'),'background-color':token('--surface')});
      for(const state of states)sheet.selector(`node[state="${state}"]`).style({'border-color':token(`--sig-${state==='withdrawn'?'pending':state}`),'background-color':fill(state)});
      sheet.selector('node[gate=1],node[aux=1]').style({'background-color':token('--line'),'border-color':token('--line')}).selector('edge').style({'line-color':token('--muted-ink'),'target-arrow-color':token('--muted-ink')}).selector('edge.chain,edge.trace,edge.exact,edge[kind="bundle"]').style({'line-color':token('--line'),'target-arrow-color':token('--line')}).selector('node.dim').style({'color':token('--muted-ink'),'text-background-color':token('--paper')}).selector('node:selected,node.match').style({'border-color':token('--line')}).update();
    };
    window.addEventListener('roadmap-theme',theme);
    void document.fonts.ready.then(()=>{if(!graph.destroyed())graph.resize();});
    const resize=new ResizeObserver(()=>graph.resize());resize.observe(canvas.current);
    const measure=requestAnimationFrame(()=>{performance.mark('roadmap-graph-painted');performance.measure('roadmap-graph-first-render','roadmap-graph-start','roadmap-graph-painted');});
    performance.measure('roadmap-graph-layout',{start:performance.now()-baseline.elapsed,duration:baseline.elapsed});
    return()=>{saved.current={arc:e.arc,zoom:graph.zoom(),pan:graph.pan(),positions:new Map(graph.nodes().map(n=>[n.id(),{...n.position()}] as const)),sizes:new Map(graph.nodes('[gate]').map(n=>[n.id(),{width:n.data('compactWidth'),height:n.data('compactHeight')}] as const))};if(hoverTimer.current)clearTimeout(hoverTimer.current);cancelAnimationFrame(frameId);cancelAnimationFrame(measure);resize.disconnect();window.removeEventListener('roadmap-theme',theme);graph.destroy();cy.current=null;};
  },[structure,fontsReady]);
  useEffect(()=>{const graph=cy.current;if(!graph)return;graph.batch(()=>{for(const u of m.graph.units){const state=/withdrawn/.test(u.meta)?'withdrawn':u.status;graph.getElementById(u.id).data({state,compact:u.id.startsWith('milestone:')?gateLabel(u.id):compactIdentifier(e,u.id),label:u.id.startsWith('milestone:')?gateLabel(u.id):nodeTitle(m.presentation.units.find(v=>v.id===u.id)?.title||u.label)});}});},[e.revision,structure,fontsReady]);
  useEffect(()=>{
    const graph=cy.current;if(!graph)return;
    graph.batch(()=>{
      graph.elements().removeClass('dim chain match exact trace');
      if(selected&&!hover&&!edgeHover){
        const ids=new Set([selected]), edgeIds=new Set<string>();
        for(const direction of ['up','down']){const queue=[selected],seen=new Set(queue);while(queue.length){const id=queue.shift()!;for(const edge of graph.edges('[kind="dependency"], [kind="feeds"]')){const from=direction==='up'?edge.target().id():edge.source().id(),to=direction==='up'?edge.source().id():edge.target().id();if(from!==id)continue;edgeIds.add(edge.id());ids.add(to);if(!seen.has(to)){seen.add(to);queue.push(to);}}}}
        const chain=graph.elements().filter(el=>ids.has(el.id())||edgeIds.has(el.id()));
        const exact=graph.edges('[kind="waits"]').filter(edge=>edge.source().id()===selected||edge.target().id()===selected);
        const related=chain.union(exact).union(exact.connectedNodes());graph.elements().difference(related).addClass('dim');chain.edges().addClass('chain');exact.addClass('exact');
      }
      if(hover){
        graph.elements().removeClass('dim chain exact');
        const ids=new Set([hover.id]),edges=new Set<string>();
        for(const direction of ['up','down']){const queue=[hover.id],seen=new Set(queue);while(queue.length){const id=queue.shift()!;for(const edge of graph.edges('[kind=\"dependency\"], [kind=\"feeds\"]')){const from=direction==='up'?edge.target().id():edge.source().id(),to=direction==='up'?edge.source().id():edge.target().id();if(from!==id)continue;edges.add(edge.id());ids.add(to);if(!seen.has(to)){seen.add(to);queue.push(to);}}}}
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
  useEffect(()=>{const key=(ev:KeyboardEvent)=>{if(ev.target instanceof HTMLElement&&(ev.target.matches('input,textarea,select')||ev.target.isContentEditable)||document.querySelector('[role="dialog"]')?.contains(ev.target as Node))return;if(ev.key==='/'){ev.preventDefault();setMobileSearch(true);requestAnimationFrame(()=>search.current?.focus());}if(ev.key==='f'){ev.preventDefault();fitFocus();}if(ev.key==='a'){ev.preventDefault();focusActive();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);});
  const selectedUnit=m.presentation.units.find(u=>u.id===selected),hovered=m.presentation.units.find(u=>u.id===hover?.id);
  const exactWaits=selected?.startsWith('milestone:')?m.graph.edges.filter(([a])=>a===selected).map(([,b])=>b):(waits.get(selected??'')??[]);
  // Wait membership stays in the graph as exact edges. Only its background
  // presentation uses one orthogonal bus per source gate and destination band.
  const waitBuses = new Map<string,{source:string;band:string;targets:string[]}>();
  for(const [source,target] of m.graph.edges)if(source.startsWith('milestone:')){
    const band=layout.bands.find(b=>b.ids.includes(target));if(!band)continue;
    const key=`${source}:${band.id}`,bus=waitBuses.get(key)??{source,band:band.id,targets:[]};bus.targets.push(target);waitBuses.set(key,bus);
  }
  const busRows=new Map<string,number>();
  const busGeometry=[...waitBuses].map(([key,bus])=>{
    const band=layout.bands.find(b=>b.id===bus.band)!,row=busRows.get(bus.band)??0;busRows.set(bus.band,row+1);
    const source=layout.positions.get(bus.source)!;
    const targets=bus.targets.map(id=>{const p=layout.positions.get(id)!,node=cy.current?.getElementById(id);return {id,x:p.x*view.zoom+view.x-(node?.width()??NODE_WIDTH)*view.zoom/2,y:p.y*view.zoom+view.y};});
    const x=Math.min(...targets.map(p=>p.x))-12,top=Math.min(...targets.map(p=>p.y)),bottom=Math.max(...targets.map(p=>p.y));
    const pending=!e.data.display.status.milestones.find(g=>`milestone:${g.id}`===bus.source)?.passed;
    return {key,...bus,targets,pending,labelX:band.x*view.zoom+view.x+8,labelY:band.y*view.zoom+view.y+24+row*16,x,top,bottom,sx:source.x*view.zoom+view.x,sy:source.y*view.zoom+view.y};
  });
  const currentMilestone=baseline.bands.find(b=>b.id.startsWith("milestone:")&&b.state!=="passed")?.id;
  return <div className={`graph-view ${focus==='all'?'graph-all':''}`}>
    <nav className="line-map" aria-label="Milestone stations">{baseline.bands.map(band=><button key={band.id} className={`station ${band.id==='unbound'?'station-unbound':''} ${band.id===currentMilestone?'station-current':''}`} aria-description={band.id===currentMilestone?'First uncleared milestone':undefined} aria-pressed={station===band.id} onMouseEnter={ev=>{const r=ev.currentTarget.getBoundingClientRect();setHealth({id:band.id,x:r.left,y:r.bottom});}} onFocus={ev=>{const r=ev.currentTarget.getBoundingClientRect();setHealth({id:band.id,x:r.left,y:r.bottom});}} onClick={ev=>{focusStation(band.id);const r=ev.currentTarget.getBoundingClientRect();setHealth({id:band.id,x:r.left,y:r.bottom});}} title={`${e.data.plan?.milestones?.find(g=>`milestone:${g.id}`===band.id)?.text||band.label}: ${band.passed}/${band.total} units passed`}><span className="station-track"><span className="track-fill" style={{width:`${band.total?band.passed/band.total*100:0}%`}}/><span className="gate-glyph" aria-label={band.state}>{glyph[band.state as Signal]}</span></span><span className="station-caption"><strong>{band.id==='unbound'?'No milestone':`${band.id.slice(10)}${band.label!==band.id.slice(10)?` ${band.label}`:''}`}</strong><span>{band.passed}/{band.total}</span>{band.id===currentMilestone&&<small>First uncleared</small>}{(()=>{const g=e.data.plan?.milestones?.find(g=>`milestone:${g.id}`===band.id);const held=(g?.units??band.ids).filter(id=>m.graph.units.find(u=>u.id===id)?.status==='held').length;return held>0&&<small className="station-held">{glyph.held} {held} held</small>;})()}</span><span className="station-name">{band.label}</span></button>)}</nav>
    {health&&(()=>{
      const band=baseline.bands.find(b=>b.id===health.id)!,gate=e.data.plan?.milestones?.find(g=>`milestone:${g.id}`===health.id),ids=gate?.units??band.ids;
      const groups=(['passed','active','held','pending','failed','withdrawn'] as Signal[]).map(state=>({state,ids:ids.filter(id=>{const u=m.graph.units.find(u=>u.id===id);return u&&(/withdrawn/.test(u.meta)?'withdrawn':u.status)===state;})}));
      return <div className="station-health" role="group" aria-label={`${health.id.replace('milestone:','')} health`} style={{left:Math.min(health.x,innerWidth-280),top:health.y}} onMouseLeave={()=>setHealth(null)} onKeyDown={ev=>{if(ev.key==='Escape'){setHealth(null);ev.stopPropagation();}}}>
        <strong>{health.id.replace('milestone:','')} {gate?.name}</strong><p>{gate?.text}</p>{(()=>{const ties=baseline.bands.filter(b=>b.id!==band.id&&b.total>0&&b.passed*band.total===band.passed*b.total);return ties.length>0&&<p>Same completion: {ties.map(b=>b.id.replace('milestone:','')).join(', ')}</p>;})()}
        {groups.map(group=><button key={group.state} aria-label={group.ids.length?`Show ${group.ids.length} ${group.state} units`:`0 ${group.state}`} disabled={!group.ids.length} onClick={()=>{cy.current?.nodes().unselect();setSelected(null);setFocus('milestone');setStation(health.id);setHighlight(group.ids);setHealth(null);setHover(null);frame(group.ids,true);}}><SignalMark state={group.state}/><span>{group.ids.length?`Show ${group.ids.length} ${group.state} units`:`0 ${group.state}`}</span></button>)}
      </div>;
    })()}
    <div className="graph-stage">
      <div ref={canvas} onMouseLeave={hideHover} className="dag-canvas" role="application" tabIndex={0} aria-label={`Unit dependency graph, ${m.presentation.units.length} units. Arrow keys select nearby visible units; Alt+Arrow follows dependencies. Enter opens details. ${selectedUnit?`Selected ${selectedUnit.title}`:''}`} onKeyDown={ev=>{
        const graph=cy.current;if(!graph)return;
        if(ev.key==='Enter'&&selected){ev.preventDefault();open(selected);return;}
        if(!ev.key.startsWith('Arrow'))return;ev.preventDefault();
        const visible=graph.nodes('[gate=0]').filter(n=>{const p=n.renderedPosition();return p.x>0&&p.x<graph.width()&&p.y>60&&p.y<graph.height()-40;});
        const center={x:graph.width()/2,y:graph.height()/2};
        if(!selected){
          const preferred=focus==='active'?visible.filter(n=>active.seeds.includes(n.id())):focus==='milestone'?visible.filter(n=>baseline.bands.find(b=>b.id===station)?.ids.includes(n.id())===true):visible;
          const initial=(preferred.length?preferred:visible).sort((a,b)=>{const p=(a as NodeSingular).renderedPosition(),q=(b as NodeSingular).renderedPosition();return Math.hypot(p.x-center.x,p.y-center.y)-Math.hypot(q.x-center.x,q.y-center.y);})[0];initial?.select();return;
        }
        const current=graph.getElementById(selected),p=current.renderedPosition();
        const upstream=ev.key==='ArrowLeft'||ev.key==='ArrowUp';
        const candidates=ev.altKey?(upstream?current.incomers('node[gate=0]'):current.outgoers('node[gate=0]')):visible;
        const horizontal=ev.key==='ArrowLeft'||ev.key==='ArrowRight',sign=upstream?-1:1;
        const ranked=candidates.filter(n=>n.id()!==selected).map(n=>{const q=(n as NodeSingular).renderedPosition(),dx=q.x-p.x,dy=q.y-p.y,along=(horizontal?dx:dy)*sign,across=Math.abs(horizontal?dy:dx);return {n,along,score:Math.hypot(dx,dy)+across*2};}).filter(v=>ev.altKey||v.along>1).sort((a,b)=>a.score-b.score);
        const next=ranked[0]?.n;if(next){if(ev.altKey)focusNode(next.id());else next.select();}
      }}/>
      <svg className="wait-buses" aria-hidden="true">{busGeometry.map(bus=><g key={bus.key} className="wait-bus">
        <path className="wait-bus-line" d={`M ${bus.sx} ${bus.sy} H ${bus.x} V ${bus.top} M ${bus.x} ${bus.top} V ${bus.bottom}`}/>
        {bus.targets.map(p=><path key={p.id} className="wait-target-tick" d={`M ${bus.x} ${p.y} h 6`}/>)}
      </g>)}</svg>
      <div className="wait-bus-labels">{busGeometry.map(bus=><details key={bus.key} className="wait-bus-label" onMouseEnter={ev=>{setHover(null);ev.currentTarget.open=true;}} onMouseLeave={ev=>{if(!ev.currentTarget.contains(document.activeElement))ev.currentTarget.open=false;}} onFocus={ev=>{setHover(null);ev.currentTarget.open=true;}} onBlur={ev=>{if(!ev.currentTarget.contains(ev.relatedTarget))ev.currentTarget.open=false;}} onKeyDown={ev=>{if(ev.key==='Escape'){ev.currentTarget.open=false;ev.currentTarget.querySelector('summary')?.focus();ev.stopPropagation();}}} style={{left:bus.labelX,top:bus.labelY,display:view.zoom*LABEL_PX<MIN_LABEL_PX?'none':undefined}}>
        <summary onClick={ev=>{ev.preventDefault();ev.currentTarget.parentElement!.setAttribute('open','');}} aria-label={`${bus.source.slice(10)}: ${bus.targets.length} ${bus.pending?'waiting':'linked'} units in ${bus.band.replace('milestone:','')}`} title={`${bus.source.slice(10)} ${bus.pending?'Pending':'Passed'}`}>{bus.source.slice(10)}: {bus.targets.length} {bus.pending?'waiting':'linked'}</summary>
        <div className="wait-bus-targets"><strong>{glyph[bus.pending?'pending':'passed']} {bus.source.slice(10)} {bus.pending?'Pending':'Passed'}</strong>{bus.targets.map(p=><button key={p.id} onClick={()=>focusNode(p.id)}>{p.id}</button>)}</div>
      </details>)}</div>
      <div className="node-signals" aria-hidden="true">{m.graph.units.map(u=>{const p=layout.positions.get(u.id),node=cy.current?.getElementById(u.id);if(!p||!node?.length)return null;const compact=view.zoom*LABEL_PX<MIN_LABEL_PX,w=node.width()*view.zoom,h=node.height()*view.zoom,x=p.x*view.zoom+view.x-w/2+4,y=p.y*view.zoom+view.y+(compact?-7:h/2-15);if(w<18||h<14)return null;if(x< -160||x>(canvas.current?.clientWidth??innerWidth)||y<0||y>(canvas.current?.clientHeight??innerHeight))return null;const state=/withdrawn/.test(u.meta)?'withdrawn':u.status;return <span key={u.id} className={`node-signal ${compact?'node-signal-compact':''}`} style={{left:x,top:y}}><SignalMark state={state}/>{!compact&&u.id.startsWith('milestone:')===false&&<span className="node-identity">{u.id}  {e.data.plan?.units.find(v=>v.id===u.id)?.systems.join(' ')}</span>}</span>;})}</div>
      <div className="band-captions" aria-hidden="true">{layout.bands.map(b=><div key={b.id} className={`band-caption ${station===b.id?'band-focused':''}`} style={{left:b.x*view.zoom+view.x,top:b.y*view.zoom+view.y,width:b.width*view.zoom,height:b.height*view.zoom}}><span style={{left:8,display:view.zoom*LABEL_PX<MIN_LABEL_PX?'none':undefined}}>{b.id==='unbound'?'No milestone':b.id.slice(10)} {`${b.passed}/${b.total}`}</span></div>)}</div>
      {view.zoom*LABEL_PX>=MIN_LABEL_PX&&<div className="wait-badges">{[...unmet].map(([id,gates])=>{const p=layout.positions.get(id);if(!p)return null;const x=(p.x-NODE_WIDTH/2)*view.zoom+view.x,y=(p.y+NODE_HEIGHT/2)*view.zoom+view.y;if(x< -150||x>(canvas.current?.clientWidth??innerWidth)||y<0||y>(canvas.current?.clientHeight??innerHeight))return null;return <button key={id} title={`Waits on ${gates.map(g=>g.slice(10)).join(', ')}`} style={{left:x,top:y}} onClick={()=>cy.current?.getElementById(id).select()}>{gates.length===1?`Waits on ${gates[0]!.slice(10)}`:`${gates.length} unmet gates`}</button>;})}</div>}
      <div className={`graph-toolbar ${mobileSearch?'search-expanded':''}`} role="toolbar" aria-label="Graph controls">
        <div className="graph-search"><Button className="search-toggle" size="icon" variant="ghost" aria-label="Find a unit" onClick={()=>{setMobileSearch(!mobileSearch);requestAnimationFrame(()=>search.current?.focus());}}><Search size={16}/></Button><input ref={search} aria-label="Search units" value={query} onFocus={()=>setSearching(true)} onChange={ev=>{setQuery(ev.target.value);setResultIndex(0);setSearching(true);}} placeholder="Find a unit  /" onKeyDown={ev=>{if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ev.preventDefault();setResultIndex((resultIndex+(ev.key==='ArrowDown'?1:-1)+results.length)%Math.max(1,results.length));}if(ev.key==='Enter'&&results[resultIndex]){ev.preventDefault();chooseResult(results[resultIndex].id);}if(ev.key==='Escape'){setQuery('');setMobileSearch(false);canvas.current?.focus();}}}/>{query&&searching&&<div className="search-results">{results.length?results.map((u,i)=><button key={u.id} aria-selected={i===resultIndex} onFocus={()=>setResultIndex(i)} onClick={()=>chooseResult(u.id)}>{u.title}<small>{u.id}</small></button>):<p>No matching units</p>}</div>}</div>
        <div className="focus-control" role="group" aria-label="Graph focus"><button aria-label="Active focus" aria-pressed={focus==='active'} title={active.recent?'No active units; showing most recently changed units (a)':'Active units and direct neighbours (a)'} onClick={()=>focusActive()}>Active{focus==='active'&&active.recent&&<small> (recent)</small>}</button><button aria-label="Milestone focus" aria-pressed={focus==='milestone'} disabled={!station} onClick={()=>station&&focusStation(station)}>{station?station.replace('milestone:',''):'Milestone'}</button><button aria-label="All focus" aria-pressed={focus==='all'} onClick={focusAll}>All</button></div>
        <details className="filter-popover"><summary title="Filter unit states">Filters{filters.length?` (${filters.length})`:''}</summary><div className="status-filters">{states.map(state=><Button key={state} variant="ghost" title={`Filter ${state}`} aria-label={`Filter ${state}`} aria-pressed={filters.includes(state)} onClick={()=>setFilters(filters.includes(state)?filters.filter(v=>v!==state):[...filters,state])}><SignalMark state={state}/>{state}</Button>)}</div></details>
        <div className="zoom-controls"><Button size="icon" variant="ghost" aria-label="Fit graph" title="Fit current focus (f)" onClick={fitFocus}><Focus size={16}/></Button><Button className="zoom-step" size="icon" variant="ghost" aria-label="Zoom out" onClick={()=>cy.current?.zoom({level:cy.current.zoom()/1.35,renderedPosition:{x:canvas.current!.clientWidth/2,y:canvas.current!.clientHeight/2}})}><Minus size={15}/></Button><Button className="zoom-step" size="icon" variant="ghost" aria-label="Zoom in" onClick={()=>cy.current?.zoom({level:cy.current.zoom()*1.35,renderedPosition:{x:canvas.current!.clientWidth/2,y:canvas.current!.clientHeight/2}})}><Plus size={15}/></Button></div>
      </div>
      {focus==='active'&&(phone||paged)&&active.seeds.length>1&&<div className="active-pager" aria-label="Active clusters"><button aria-label="Previous active cluster" onClick={()=>focusActive((cluster-1+active.seeds.length)%active.seeds.length)}>‹</button><span>{active.recent?'Recent':'Active'} {cluster+1}/{active.seeds.length}</span><button aria-label="Next active cluster" onClick={()=>focusActive((cluster+1)%active.seeds.length)}>›</button></div>}
      {selected&&!(phone&&hovered&&hover?.id===selected)&&<div className="graph-selection"><div><strong>{selectedUnit?.title||selected}</strong><small>{selectedUnit?.state} {selectedUnit?.stage}</small><details className="exact-relations" open={exactWaits.length<=6}><summary>{selected.startsWith('milestone:')?'Linked units':'Gate prerequisites'} ({exactWaits.length})</summary><div>{exactWaits.map(id=><button key={id} onClick={()=>focusNode(id)}>{id.startsWith('milestone:')?<><SignalMark state={e.data.display.status.milestones.find(g=>`milestone:${g.id}`===id)?.passed?'passed':'pending'}/>{id.slice(10)} {e.data.display.status.milestones.find(g=>`milestone:${g.id}`===id)?.passed?'Passed':'Pending'}</>:id}</button>)}{!exactWaits.length&&<small>None</small>}</div></details></div><Button onClick={()=>open(selected)} aria-label={`Open ${selected} details`}>Details</Button></div>}
      {hover&&hovered&&<div className="graph-hover" role="group" aria-label="Unit title card" onMouseEnter={()=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);}} onMouseLeave={()=>{if(!touchCard.current)setHover(null);}} style={{left:Math.max(8,Math.min(hover.x+24,(canvas.current?.clientWidth??400)-260)),top:Math.max(64,hover.y+180<(canvas.current?.clientHeight??500)?hover.y+20:hover.y-180)}}><strong>{hovered.title}</strong><span>{hovered.state} {hovered.stage}</span>{unmet.has(hovered.id)&&<span>Waits on {unmet.get(hovered.id)!.map(g=>g.slice(10)).join(', ')}</span>}<span>{elapsed(hovered.startedAt&&!hovered.endedAt&&!m.presentation.run.endedAt?Math.max(0,now-Date.parse(hovered.startedAt)):hovered.elapsedMs)} {pluralise(hovered.attempts,'attempt')}</span><Button onClick={()=>{open(hovered.id);setHover(null);touchCard.current=null;}}>Details</Button></div>}
      <button className="key-toggle" aria-expanded={keyOpen} onClick={()=>setKeyOpen(!keyOpen)}>Legend</button><div className={`graph-legend ${keyOpen?'key-open':''}`} aria-label="Graph legend">{states.map(state=><span key={state}><SignalMark state={state}/>{state}</span>)}<span className="edge-key">Solid: unit dependency / feeds gate</span><span className="edge-key dashed">Dashed: milestone waits</span></div>
      <svg className="graph-minimap" viewBox={`0 0 ${layout.width||100} ${layout.height||100}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Graph overview. Click to pan." onClick={ev=>{const graph=cy.current;if(!graph)return;const bounds=ev.currentTarget.getBoundingClientRect(),scale=Math.min(bounds.width/layout.width,bounds.height/layout.height),x=(ev.clientX-bounds.left-(bounds.width-layout.width*scale)/2)/scale,y=(ev.clientY-bounds.top-(bounds.height-layout.height*scale)/2)/scale;graph.pan({x:graph.width()/2-x*graph.zoom(),y:graph.height()/2-y*graph.zoom()});}}>{layout.bands.map(b=><rect key={b.id} x={b.x} y={b.y} width={b.width} height={b.height} fill="var(--surface)" stroke="var(--rule)" strokeWidth={8}/>)}{m.graph.units.map(n=>{const p=layout.positions.get(n.id);return p&&<rect key={n.id} x={p.x-60} y={p.y-18} width={120} height={36} fill={`var(--sig-${n.status})`}/>;})}<rect x={-view.x/view.zoom} y={-view.y/view.zoom} width={(canvas.current?.clientWidth??0)/view.zoom} height={(canvas.current?.clientHeight??0)/view.zoom} fill="var(--line)" fillOpacity={.08} stroke="var(--line)" strokeWidth={12}/></svg>
      <span className="graph-scale">{Math.round(view.zoom*100)}% <span>{m.presentation.units.length} units</span></span>
    </div>
  </div>;
}
