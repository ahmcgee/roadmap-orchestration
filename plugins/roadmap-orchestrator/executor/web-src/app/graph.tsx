import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type NodeSingular } from 'cytoscape';
import { Focus, Minus, Plus, Search } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { graphLayout } from './graph-layout.ts';
import { Clock, elapsed, glyph, SignalMark } from './shared.tsx';
import type { Envelope, Signal } from './types.ts';
const states: Signal[] = ['passed','active','held','failed','pending','withdrawn'];
export function Graph({ e, open }: { e: Envelope; open: (id: string) => void }) {
  const now=useContext(Clock);
  const canvas = useRef<HTMLDivElement>(null), cy = useRef<Core | null>(null), search = useRef<HTMLInputElement>(null), opener = useRef(open);
  opener.current = open;
  const [selected,setSelected] = useState<string | null>(null), [query,setQuery] = useState(''), [searching,setSearching]=useState(false), [filters,setFilters] = useState<Signal[]>([]), [station,setStation] = useState<string | null>(null);
  const [hover,setHover] = useState<{ id: string; x: number; y: number } | null>(null), [view,setView] = useState({ zoom:1, x:0, y:0 });
  // Only structural changes lay out again. Drawer routes and heartbeat clocks leave the viewport untouched.
  const structure = JSON.stringify([e.arc, e.data.console.graph.units.map(u => u.id),e.data.console.graph.edges,e.data.plan?.milestones]);
  const layout = useMemo(() => graphLayout(e), [structure]);
  const m = e.data.console, results = query.trim() ? m.presentation.units.filter(u => `${u.title} ${u.id}`.toLowerCase().includes(query.toLowerCase())).slice(0,12) : [];
  function focusNode(id: string) { const graph = cy.current, node = graph?.getElementById(id); if (!graph || !node?.length) return; node.select(); setSearching(false); graph.animate({ center: { eles: node }, zoom: Math.max(graph.zoom(), .95) }, { duration: 280 }); canvas.current?.focus(); }
  function focusStation(id: string) { const graph = cy.current, band = layout.bands.find(b => b.id === id); if (!graph || !band) return; setStation(id); const ids = new Set([...band.ids, band.id]); graph.animate({ fit: { eles: graph.nodes().filter(n => ids.has(n.id())), padding: 90 } }, { duration: 350 }); }
  useLayoutEffect(() => {
    if (!canvas.current) return;
    performance.mark('roadmap-graph-start');
    const style = getComputedStyle(document.documentElement), color = (token: string) => style.getPropertyValue(token).trim();
    const graph = cytoscape({ container: canvas.current, pixelRatio: Math.min(devicePixelRatio, 2), minZoom:.025, maxZoom:2.5, hideEdgesOnViewport:true, textureOnViewport:true, elements: [
      ...m.graph.units.map(u => { const unit = m.presentation.units.find(v => v.id === u.id), state = /withdrawn/.test(u.meta) ? 'withdrawn' : u.status; return { data: { id:u.id, label: u.id.startsWith('milestone:') ? `${glyph[state]}\n${u.id.slice(10)}` : `${glyph[state]} ${unit?.title || u.label}`, state, gate:u.id.startsWith('milestone:') ? 1 : 0 }, position:layout.positions.get(u.id)! }; }),
      ...m.graph.edges.map(([source,target],i) => ({ data: { id:`edge:${i}`,source,target, kind: source.startsWith('milestone:') ? 'waits' : target.startsWith('milestone:') ? 'feeds' : 'dependency' } }))
    ], layout: { name:'preset' }, style: [
      { selector:'node', style: { 'background-color': color('--surface'), 'border-width':2, 'border-color':color('--sig-pending'), 'shape':'round-rectangle','corner-radius':3,'width':176,'height':56, 'label':'data(label)', 'font-family':'Barlow Semi Condensed', 'font-size':14,'line-height':1.05,'font-weight':500,'text-wrap':'wrap','text-max-width':158,'text-valign':'center','text-halign':'center','color':color('--ink') } },
      ...states.map(state => ({ selector:`node[state="${state}"]`, style: { 'border-color':color(`--sig-${state === 'withdrawn' ? 'pending' : state}`), 'background-color': color(`--sig-${state === 'withdrawn' ? 'pending' : state}`), 'background-opacity':state==='pending'?0:state==='withdrawn'?.04:state==='held'?.16:state==='failed'?.12:.45, 'shape':state === 'held' ? 'hexagon' : state === 'failed' ? 'diamond' : state === 'passed' ? 'round-rectangle' : state === 'active' ? 'rectangle' : 'round-rectangle', 'border-style':state === 'withdrawn' ? 'dashed' : 'solid' } })),
      { selector:'node[gate=1]', style:{ 'shape':'diamond', 'width':48,'height':48,'background-color':color('--line'),'border-color':color('--line'),'background-opacity':.18,'font-size':12 } },
      { selector:'node[gate=1][state="passed"]',style:{'background-opacity':.7} },
      { selector:'node[gate=1][state="pending"]',style:{'background-opacity':0} },
      { selector:'edge',style:{ 'curve-style':'taxi','taxi-direction':'rightward','taxi-turn':24, 'line-color':color('--muted-ink'),'width':1,'opacity':.10, 'target-arrow-shape':'triangle','target-arrow-color':color('--muted-ink'),'arrow-scale':.65 } },
      { selector:'edge[kind="waits"]',style:{'line-style':'dashed','line-color':color('--muted-ink'),'target-arrow-color':color('--muted-ink'),'opacity':.18} },
      { selector:'edge[kind="feeds"]',style:{'line-color':color('--muted-ink'),'target-arrow-color':color('--muted-ink'),'opacity':.18} },
      { selector:'.dim',style:{ 'opacity':.12 } },
      { selector:'.chain',style:{'opacity':1,'line-color':color('--line'),'target-arrow-color':color('--line'),'width':2} },
      { selector:'node:selected, node.match',style:{ 'border-color':color('--line'),'border-width':4,'background-opacity':.35 } },
      { selector:'node.overview',style:{'label':''} },
      { selector:'node.overview[state="pending"]',style:{'border-width':5,'background-opacity':.08} },
      { selector:'node.overview[state="held"]',style:{'background-opacity':.28} }
    ] as cytoscape.StylesheetJson, autoungrabify:true, boxSelectionEnabled:false });
    cy.current = graph;
    graph.fit(undefined, 80);
    if(graph.zoom()>1){graph.zoom(1);graph.center();}
    if(canvas.current.clientWidth<=640&&m.presentation.units.length<=4){graph.fit(undefined,12);if(graph.zoom()>1){graph.zoom(1);graph.center();}}
    else if(canvas.current.clientWidth<=640){const current=m.graph.units.find(n=>n.status==='active')??m.graph.units.find(n=>n.status==='held')??m.graph.units[0];if(current){graph.zoom(.62);graph.center(graph.getElementById(current.id));}}
    graph.on('select','node', ev => { const node = ev.target as NodeSingular; graph.nodes().not(node).unselect(); setSelected(node.id()); canvas.current?.focus({preventScroll:true}); });
    graph.on('tap', ev => { if (ev.target === graph) { graph.nodes().unselect();setSelected(null); } });
    graph.on('dbltap','node', ev => opener.current(ev.target.id()));
    graph.on('mouseover','node',ev => { const p=ev.target.renderedPosition();setHover({id:ev.target.id(),x:p.x,y:p.y}); });
    graph.on('mouseout','node',()=>setHover(null));
    let frame=0;
    const viewport=()=>{ cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{ const p=graph.pan();setView({zoom:graph.zoom(),x:p.x,y:p.y}); const hide=graph.zoom()<.85; if (graph.nodes().first().hasClass('overview')!==hide) graph.nodes().toggleClass('overview',hide); }); };
    graph.on('pan zoom',viewport);viewport();
    const theme=()=>{
      const styles=getComputedStyle(document.documentElement),token=(name:string)=>styles.getPropertyValue(name).trim();
      const sheet=graph.style().selector('node').style({'color':token('--ink'),'background-color':token('--surface')});
      for(const state of states)sheet.selector(`node[state="${state}"]`).style({'border-color':token(`--sig-${state==='withdrawn'?'pending':state}`),'background-color':token(`--sig-${state==='withdrawn'?'pending':state}`)});
      sheet.selector('node[gate=1]').style({'border-color':token('--line'),'background-color':token('--line')})
        .selector('edge').style({'line-color':token('--muted-ink'),'target-arrow-color':token('--muted-ink')})
        .selector('edge[kind="waits"], edge[kind="feeds"]').style({'line-color':token('--muted-ink'),'target-arrow-color':token('--muted-ink')})
        .selector('edge.chain').style({'line-color':token('--line'),'target-arrow-color':token('--line')})
        .selector('node:selected, node.match').style({'border-color':token('--line')}).update();
    };
    window.addEventListener('roadmap-theme',theme);
    void document.fonts.ready.then(()=>{if(!graph.destroyed())graph.resize();});
    const resize = new ResizeObserver(() => graph.resize()); resize.observe(canvas.current);
    const measure=requestAnimationFrame(()=>{ performance.mark('roadmap-graph-painted');performance.measure('roadmap-graph-first-render','roadmap-graph-start','roadmap-graph-painted'); });
    performance.measure('roadmap-graph-layout',{ start:performance.now()-layout.elapsed, duration:layout.elapsed });
    return () => { cancelAnimationFrame(frame);cancelAnimationFrame(measure);resize.disconnect();window.removeEventListener('roadmap-theme',theme);graph.destroy();cy.current=null; };
  }, [structure]);
  useEffect(() => { const graph=cy.current;if(!graph)return; graph.batch(()=>{for(const u of m.graph.units) {const state=/withdrawn/.test(u.meta)?'withdrawn':u.status;graph.getElementById(u.id).data({state,label:u.id.startsWith('milestone:')?`${glyph[state]}\n${u.id.slice(10)}`:`${glyph[state]} ${m.presentation.units.find(v=>v.id===u.id)?.title||u.label}`});} }); }, [e.revision,structure]);
  useEffect(() => {
    const graph=cy.current;if(!graph)return;
    graph.batch(()=>{
      graph.elements().removeClass('dim chain match');
      const node=selected?graph.getElementById(selected):null;
      const chain=node?.length?node.union(node.predecessors()).union(node.successors()):null;
      if(chain) { graph.elements().difference(chain).addClass('dim');chain.edges().addClass('chain'); }
      if(filters.length)graph.nodes().filter(n=>!filters.includes(n.data('state') as Signal)).addClass('dim');
      if(query) { const ids=new Set<string>(results.map(u=>u.id));graph.nodes().filter(n=>ids.has(n.id())).addClass('match'); }
    });
  },[selected,filters,query,e.revision,structure]);
  useEffect(()=>{ const key=(ev:KeyboardEvent)=>{if(ev.target instanceof HTMLElement && (ev.target.matches('input,textarea,select')||ev.target.isContentEditable)||document.querySelector('[role="dialog"]')?.contains(ev.target as Node))return;if(ev.key==='/'){ev.preventDefault();search.current?.focus();}if(ev.key==='f'){ev.preventDefault();cy.current?.animate({fit:{eles:cy.current.elements(),padding:80}},{duration:250});}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  const selectedUnit=m.presentation.units.find(u=>u.id===selected), hovered=m.presentation.units.find(u=>u.id===hover?.id);
  const captionEnds:number[]=[];
  const captionRows=layout.bands.map(b=>{const left=b.x*view.zoom+view.x,right=left+b.width*view.zoom;if(right<=0||left>=(canvas.current?.clientWidth??innerWidth))return -1;const x=Math.max(8,left+8),label=b.id==='unbound'?'No milestone':b.id.slice(10);let row=captionEnds.findIndex(end=>x>end+8);if(row<0)row=captionEnds.length;captionEnds[row]=x+Math.max(36,label.length*6);return row;});
  return <div className="graph-view">
    <nav className="line-map" aria-label="Milestone stations">{layout.bands.map((band,i)=><button key={band.id} className={`station ${band.id==='unbound'?'station-unbound':''}`} aria-pressed={station===band.id} onClick={()=>focusStation(band.id)} title={`${band.label}: ${band.passed}/${band.total} units passed`}><span className="station-track"><span className="track-fill" style={{width:`${band.total?band.passed/band.total*100:0}%`}}/><span className="gate-glyph" aria-label={band.state}>{glyph[band.state as Signal]}</span></span><span className="station-caption"><strong>{band.id==='unbound'?'No milestone':band.id.slice(10)}</strong><span>{band.passed}/{band.total}</span></span><span className="station-name">{band.label}</span></button>)}</nav>
    <div className="graph-stage">
      <div ref={canvas} className="dag-canvas" role="application" tabIndex={0} aria-label={`Unit dependency graph, ${m.presentation.units.length} units. Arrow keys select, Enter opens details. ${selectedUnit?`Selected ${selectedUnit.title}`:''}`} onKeyDown={ev=>{const nodes=cy.current?.nodes();if(!nodes?.length)return;if(ev.key==='Enter'&&selected){ev.preventDefault();open(selected);}if(ev.key.startsWith('Arrow')){ev.preventDefault();const index=nodes.toArray().findIndex(n=>n.id()===selected),next=(index+(ev.key==='ArrowLeft'||ev.key==='ArrowUp'?-1:1)+nodes.length)%nodes.length;focusNode(nodes[next]!.id());}}}/>
      <div className="band-captions" aria-hidden="true">{layout.bands.map((b,i)=><div key={b.id} className={`band-caption ${station===b.id?'band-focused':''}`} style={{ left:b.x*view.zoom+view.x,width:Math.max(1,b.width*view.zoom),height:'100%' }}>{captionRows[i]!>=0&&<span style={{left:Math.max(8,8-(b.x*view.zoom+view.x)),marginTop:captionRows[i]!*18}}>{b.id==='unbound'?'No milestone':b.id.slice(10)}</span>}</div>)}</div>
      <div className="graph-toolbar" role="toolbar" aria-label="Graph controls">
        <div className="graph-search"><Search size={14}/><input ref={search} aria-label="Search units" value={query} onFocus={()=>setSearching(true)} onChange={ev=>{setQuery(ev.target.value);setSearching(true);}} placeholder="Find a unit  /" onKeyDown={ev=>{if(ev.key==='Enter'&&results[0])focusNode(results[0].id);if(ev.key==='Escape')setQuery('');}}/>{query&&searching&&<div className="search-results">{results.length?results.map(u=><button key={u.id} onClick={()=>focusNode(u.id)} onDoubleClick={()=>open(u.id)}>{u.title}<small>{u.id}</small></button>):<p>No matching units</p>}</div>}</div>
        <div className="status-filters">{states.map(state=><Button key={state} size="icon" variant="ghost" title={`Filter ${state}`} aria-label={`Filter ${state}`} aria-pressed={filters.includes(state)} onClick={()=>setFilters(filters.includes(state)?filters.filter(v=>v!==state):[...filters,state])}><SignalMark state={state}/></Button>)}</div>
        <div className="zoom-controls"><Button size="icon" variant="ghost" aria-label="Fit graph" title="Fit graph (f)" onClick={()=>cy.current?.animate({fit:{eles:cy.current.elements(),padding:80}},{duration:250})}><Focus size={16}/></Button><Button size="icon" variant="ghost" aria-label="Zoom out" onClick={()=>cy.current?.zoom({level:cy.current.zoom()/1.35,renderedPosition:{x:canvas.current!.clientWidth/2,y:canvas.current!.clientHeight/2}})}><Minus size={15}/></Button><Button size="icon" variant="ghost" aria-label="Zoom in" onClick={()=>cy.current?.zoom({level:cy.current.zoom()*1.35,renderedPosition:{x:canvas.current!.clientWidth/2,y:canvas.current!.clientHeight/2}})}><Plus size={15}/></Button></div>
      </div>
      {selected&&<div className="graph-selection"><div><strong>{selectedUnit?.title||selected}</strong><small>{selectedUnit?.state} {selectedUnit?.stage}</small></div><Button onClick={()=>open(selected)} aria-label={`Open ${selected} details`}>Details</Button></div>}
      {hover&&hovered&&<div className="graph-hover" style={{left:Math.max(8,Math.min(hover.x+24,(canvas.current?.clientWidth??400)-260)),top:Math.max(84,Math.min(hover.y+24,(canvas.current?.clientHeight??500)-150))}}><strong>{hovered.title}</strong><span>{hovered.state} {hovered.stage}</span><span>{elapsed(hovered.startedAt&&!hovered.endedAt&&!m.presentation.run.endedAt?Math.max(0,now-Date.parse(hovered.startedAt)):hovered.elapsedMs)} {hovered.attempts} attempts</span></div>}
      <div className="graph-legend" aria-label="Graph legend">{states.map(state=><span key={state}><SignalMark state={state}/>{state}</span>)}<span className="edge-key">Solid: feeds</span><span className="edge-key dashed">Dashed: waits on gate</span></div>
      <svg className="graph-minimap" viewBox={`0 0 ${layout.bands.at(-1)?layout.bands.at(-1)!.x+layout.bands.at(-1)!.width:100} ${layout.height||100}`} preserveAspectRatio="none" role="img" aria-label="Graph overview. Click to pan." onClick={ev=>{const graph=cy.current;if(!graph)return;const bounds=ev.currentTarget.getBoundingClientRect(),width=layout.bands.at(-1)!.x+layout.bands.at(-1)!.width,x=(ev.clientX-bounds.left)/bounds.width*width,y=(ev.clientY-bounds.top)/bounds.height*layout.height;graph.animate({pan:{x:canvas.current!.clientWidth/2-x*graph.zoom(),y:canvas.current!.clientHeight/2-y*graph.zoom()}},{duration:200});}}>{layout.bands.map(b=><rect key={b.id} x={b.x} width={b.width} height={layout.height} fill="var(--surface)" stroke="var(--rule)" strokeWidth={8}/>)}{m.graph.units.map(n=>{const p=layout.positions.get(n.id);return p&&<rect key={n.id} x={p.x-60} y={p.y-18} width={120} height={36} fill={`var(--sig-${n.status})`}/>;})}<rect x={-view.x/view.zoom} y={-view.y/view.zoom} width={(canvas.current?.clientWidth??0)/view.zoom} height={(canvas.current?.clientHeight??0)/view.zoom} fill="var(--line)" fillOpacity={.08} stroke="var(--line)" strokeWidth={12}/></svg>
      <span className="graph-scale">{Math.round(view.zoom*100)}% <span>{m.presentation.units.length} units</span></span>
    </div>
  </div>;
}
