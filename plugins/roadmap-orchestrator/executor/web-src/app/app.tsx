import { saveVisit } from './activity-query.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { Clock, displayZone, elapsed, formatInstant, get, link, loadError, money, route, tabs, Time } from './shared.tsx';
import { useObservation } from './observation.ts';
import { Graph } from './graph.tsx';
import { UnitDetail } from './unit-detail.tsx';
import { Views, useView } from './view-state.ts';
import { graphData } from './graph-data.ts';
import { CONSOLE_UI_SCHEMA, type ShellView } from '../../src/console/view-protocol.ts';
import { stateWords } from '../../src/console/vocabulary.ts';
import { ResourceDetailDrawer } from './resource-detail.tsx';
import { EffortScopeDetail } from './effort-scope.tsx';
import { RequestDetail } from './request-detail.tsx';
import { EventDetail } from './event-detail.tsx';
import { InvocationDetail } from './invocation.tsx';
import { Activity, Attention, Effort, Resources, Timeline } from './other-tabs.tsx';
import type { Signal } from './types.ts';
type Theme = 'system'|'light'|'dark';
/** The Arc's identity: its recorded goal leads when the plan records one; the id stays visible as the secondary line. */
function ArcIdentity({arc,shell,zone}:{arc:string|null;shell:ShellView|null;zone:string}) {
  const direction=shell?.identity.direction??null,ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{const close=(ev:Event)=>{if(ref.current?.open&&!(ev instanceof MouseEvent&&ref.current.contains(ev.target as Node)))ref.current.open=false;};const key=(ev:KeyboardEvent)=>{if(ev.key==='Escape'&&ref.current?.open){ref.current.open=false;ref.current.querySelector('summary')?.focus();}};document.addEventListener('mousedown',close);window.addEventListener('keydown',key);return()=>{document.removeEventListener('mousedown',close);window.removeEventListener('keydown',key);};},[]);
  if(!arc)return <span className="arc-identity"><span className="arc-name">Roadmap</span></span>;
  const details=<div className="arc-identity-body"><h2>Goal</h2><p>{direction?<>{direction.text}{direction.truncated&&'…'}</>:'No goal is recorded in the plan.'}</p><dl><div><dt>Arc</dt><dd>{arc}</dd></div>{shell?.lifecycle.startedAt&&<div><dt>Started</dt><dd>{formatInstant(shell.lifecycle.startedAt,zone)}</dd></div>}</dl></div>;
  return <details ref={ref} className="arc-identity"><summary title="About this arc">{direction?<><span className="arc-name">{direction.text}</span><span className="arc-id">Arc {arc}</span></>:<span className="arc-id arc-id-only">Arc {arc}</span>}</summary>{details}</details>;
}
export function App() {
  const [where,setWhere]=useState(route),[selected,setSelected]=useState<string|null>(null),[listed,setListed]=useState(false),[listAttempt,setListAttempt]=useState(0),[listError,setListError]=useState(''),[now,setNow]=useState(Date.now());
  const [theme,setTheme]=useState<Theme>(()=>{try{const value=localStorage.getItem('roadmap.theme');return value==='light'||value==='dark'?value:'system';}catch{return 'system';}});
  useEffect(()=>{const change=()=>setWhere(route());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  useEffect(()=>{const c=new AbortController();const poll=()=>get('/arcs',c.signal).then(r=>{if(r.uiSchema!==CONSOLE_UI_SCHEMA)throw new Error('Reload required: UI schema changed');setSelected(r.selected);setListed(true);setListError('');}).catch((err:Error)=>{if(!c.signal.aborted)setListError(err.message);});void poll();return()=>{c.abort();};},[listAttempt]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),500);return()=>clearInterval(timer);},[]);
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme: dark)'),apply=()=>{document.documentElement.dataset['theme']=theme==='system'?(media.matches?'dark':'light'):theme;window.dispatchEvent(new Event('roadmap-theme'));};apply();media.addEventListener('change',apply);try{localStorage.setItem('roadmap.theme',theme);}catch{}return()=>media.removeEventListener('change',apply);},[theme]);
  const [zone,setZone]=useState(displayZone);
  const store=useObservation(selected,setSelected);
  useEffect(()=>{if(!selected)return;const leave=()=>{if(store?.metadata)saveVisit({arc:selected,epoch:store.metadata.epoch,highWater:store.metadata.highWater});};window.addEventListener('pagehide',leave);return()=>window.removeEventListener('pagehide',leave);},[selected,store]);
  useEffect(()=>{if(store?.connected)return;const c=new AbortController(),timer=setInterval(()=>{void get('/arcs',c.signal).then(r=>{if(r.uiSchema!==CONSOLE_UI_SCHEMA)throw new Error('Reload required: UI schema changed');setSelected(r.selected);setListed(true);setListError('');}).catch(err=>{if(!c.signal.aborted)setListError(err.message);});},15_000);return()=>{clearInterval(timer);c.abort();};},[store?.connected]);
  return <Views.Provider value={store}><Console key={selected} zone={zone} setZone={next=>{try{localStorage.setItem('roadmap.zone',next);}catch{/* storage can be disabled */}setZone(next);}} where={where} selected={selected} listed={listed} retryList={()=>{setListError('');setListAttempt(n=>n+1);}} listError={listError} now={now} theme={theme} setTheme={setTheme} store={store}/></Views.Provider>;
}
function Console({zone,setZone,where,selected,listed,retryList,listError,now,theme,setTheme,store}:{where:ReturnType<typeof route>;selected:string|null;listed:boolean;retryList:()=>void;listError:string;now:number;theme:Theme;setTheme:(t:Theme)=>void;store:ReturnType<typeof useObservation>;zone:string;setZone:(z:string)=>void}) {
  const shell=useView('shell'),graph=useView(where.tab==='graph'?'graph':null);
  const p=shell.data as ShellView|null;
  const error=store?.error||shell.error||graph.error||'',checkedAt=store?.checkedAt??null,connected=store?.connected??false,reload=store?.reload??false;
  const graphEnvelope=store?.entries.get('graph')?.value;
  const graphInput=useMemo(()=>graphEnvelope?graphData(graphEnvelope):null,[graphEnvelope]);
  const scrolls=useRef(new Map<string,number>());
  useLayoutEffect(()=>{const node=document.getElementById('content');if(!node)return;node.scrollTop=scrolls.current.get(where.tab)??0;const remember=()=>scrolls.current.set(where.tab,node.scrollTop);node.addEventListener('scroll',remember);return()=>{node.removeEventListener('scroll',remember);};},[where.tab,Boolean(graphInput)]);
  const stale=!checkedAt||now-Date.parse(checkedAt)>5000||Boolean(error||listError);
  const clock=stale?Date.parse(checkedAt||new Date(now).toISOString()):now;
  const arc=selected,tab=where.tab,open=(id:string)=>{if(arc)location.hash=link(arc,tab,'units',id).slice(1);},close=()=>{if(arc)location.replace(link(arc,tab));};
  const counts:Partial<Record<Signal,number>>={};
  const signal=(state:string):Signal=>state==='cut'||state==='superseded'?'withdrawn':state==='merged'?'passed':['running','preparing'].includes(state)?'active':['blocked','held','parked','awaiting-admission'].includes(state)?'held':state==='refused'?'failed':'pending';
  for(const [state,n] of Object.entries(p?.progress.countsByState??{})){const key=signal(state);counts[key]=(counts[key]??0)+n;}
  const total=p?.progress.total,day=p?.lifecycle.startedAt?Math.max(1,Math.floor(((p.lifecycle.endedAt?Date.parse(p.lifecycle.endedAt):clock)-Date.parse(p.lifecycle.startedAt))/86400_000)+1):null;
  // One connection state at a time, and no verified contact yet is never presented as stale data.
  const unreachable=!arc&&Boolean(listError);
  const live=!checkedAt?unreachable||error?'Offline':'Connecting':stale?'Stale':connected?'Connected':'Reconnecting';
  if(where.arc&&selected&&where.arc!==selected)return <main className="empty"><p>This console shows the current arc only</p><a href={link(selected,'graph')}>Open {selected}</a></main>;
  return <Clock.Provider value={clock}><div className="shell" data-stale={stale}>
    <a className="skip" href="#content" onClick={ev=>{ev.preventDefault();document.getElementById('content')?.focus();}}>Skip to content</a>
    <header className="arc-bar">
      <ArcIdentity arc={arc} shell={p} zone={zone}/>
      {p&&<><span className="arc-state">{stateWords(p.lifecycle.state)}</span>{day!==null&&<span className="arc-day">day {Math.floor(day)}</span>}</>}
      <div className="progress-group"><div className="progress-strip" aria-label={p?`${counts.passed??0} of ${total} units merged`:'Unit progress not recorded'}>{(['passed','active','held','failed','pending','withdrawn'] as Signal[]).map(state=>counts[state]?<span key={state} className={`progress-${state}`} style={{width:`${counts[state]!/Math.max(1,total??1)*100}%`}} title={`${counts[state]} ${state}`}/>:null)}</div><span className="progress-count">{p&&<>{counts.passed??0}/{total}<span> merged</span></>}</span></div>
      {p&&<span className="recorded-spend" title="Recorded spend">{money(p.spend.costUsd)}</span>}
      <span className={`connection connection-${live.toLowerCase()}`} role="status" title={checkedAt?`Last verified ${formatInstant(checkedAt,zone)}`:live==='Offline'?"Can't reach the console server":'Waiting for the console server'}><span aria-hidden="true"/>{live}</span>
      <select className="zone-select" aria-label="Timezone" title="Timezone for every time shown" value={zone} onChange={ev=>setZone(ev.target.value)}>{[...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone,'UTC',zone,...Intl.supportedValuesOf('timeZone')])].map(z=><option key={z}>{z}</option>)}</select>
      <Button variant="ghost" size="icon" aria-label={`Theme: ${theme}. Switch theme`} title={`Theme: ${theme}`} onClick={()=>setTheme(theme==='system'?'light':theme==='light'?'dark':'system')}>{theme==='system'?<Monitor size={16}/>:theme==='light'?<Sun size={16}/>:<Moon size={16}/>}</Button>
    </header>
    <nav className="tabs" aria-label="Roadmap views">{tabs.map(key=><a key={key} href={arc?link(arc,key)+(tab!==key&&store?.ui.get(`query:${key}`)?`?${store.ui.get(`query:${key}`)}`:''):'#/'} aria-current={key===tab?'page':undefined}>{key[0]!.toUpperCase()+key.slice(1)}{key==='attention'&&!!p?.attention.total&&<span className="tab-badge">{p.attention.total}</span>}</a>)}</nav>
    {(reload||error||listError||where.invalid)&&<div className="notice" role="alert">{where.invalid?'Unknown console route. Open the current arc.':reload?'Reload required: executor version changed':loadError(error||listError)}{reload?<Button onClick={()=>location.reload()}>Reload console</Button>:error&&<Button onClick={()=>{shell.retry();if(tab==='graph')graph.retry();}}>Retry</Button>}</div>}
    {p?.lifecycle.endedAt&&<div className="outcome">{stateWords(p.lifecycle.state)}. {counts.passed??0} units merged; {counts.withdrawn??0} withdrawn. Recorded spend {money(p.spend.costUsd)}. Elapsed {elapsed(p.lifecycle.startedAt?Date.parse(p.lifecycle.endedAt!)-Date.parse(p.lifecycle.startedAt):null)}.</div>}
    <main id="content" tabIndex={-1} className={tab==='graph'?'graph-main':'tab-content'}>
      {graphInput&&<div hidden={tab!=='graph'} style={{height:'100%'}}><Graph key={arc} e={graphInput} open={open}/></div>}
      {arc&&tab==='activity'&&<Activity arc={arc}/>}
      {arc&&tab==='timeline'&&<Timeline arc={arc}/>}
      {arc&&tab==='attention'&&<Attention arc={arc}/>}
      {arc&&tab==='effort'&&<Effort arc={arc}/>}
      {arc&&tab==='resources'&&<Resources arc={arc}/>}
      {(tab==='graph'?!graphInput:!arc)&&(unreachable?<div className="empty" role="alert"><h1>Can't reach the console server.</h1><Button onClick={retryList}>Retry</Button></div>:<div className="empty"><h1>{arc?'Arc observation':'Roadmap'}</h1><p>{arc?error?loadError(error):'Connecting…':listed?'No current arc in this repository.':'Connecting…'}</p></div>)}
    </main>
    {stale&&checkedAt&&<div className="stale-notice"><Time at={checkedAt} prefix="Last updated "/>. Live counters paused.</div>}
    {arc&&where.resource&&<ResourceDetailDrawer key={where.resource} arc={arc} id={where.resource} close={close}/>}
    {arc&&where.scope&&<EffortScopeDetail key={where.scope} arc={arc} id={where.scope} close={close}/>}
    {arc&&where.request&&<RequestDetail key={where.request} arc={arc} id={where.request} close={close}/>}
    {arc&&where.event&&<EventDetail key={where.event} arc={arc} id={where.event} close={close}/>}
    {arc&&where.unit&&<UnitDetail arc={arc} id={where.unit} close={close} stale={stale}/>}{arc&&where.inv&&<InvocationDetail key={where.inv} arc={arc} id={where.inv} close={close} stale={stale}/>}
  </div></Clock.Provider>;
}
