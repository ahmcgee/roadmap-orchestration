import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { Clock, elapsed, get, link, money, route, tabs, Time } from './shared.tsx';
import { useObservation } from './observation.ts';
import { Graph } from './graph.tsx';
import { UnitDetail } from './unit-detail.tsx';
import { Views, useView } from './view-state.ts';
import { graphData } from './graph-data.ts';
import { CONSOLE_UI_SCHEMA, type ShellView } from '../../src/console/view-protocol.ts';
import { stateWords } from '../../src/console/vocabulary.ts';
import { InvocationDetail } from './invocation.tsx';
import { Activity, Attention, Effort, Resources, Timeline } from './other-tabs.tsx';
import type { Envelope, Signal } from './types.ts';
type Theme = 'system'|'light'|'dark';
export function App() {
  const [where,setWhere]=useState(route),[selected,setSelected]=useState<string|null>(null),[listError,setListError]=useState(''),[now,setNow]=useState(Date.now());
  const [theme,setTheme]=useState<Theme>(()=>{try{const value=localStorage.getItem('roadmap.theme');return value==='light'||value==='dark'?value:'system';}catch{return 'system';}});
  useEffect(()=>{const change=()=>setWhere(route());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  useEffect(()=>{const c=new AbortController();const poll=()=>get('/arcs',c.signal).then(r=>{if(r.uiSchema!==CONSOLE_UI_SCHEMA)throw new Error('Reload required: UI schema changed');setSelected(r.selected);setListError('');}).catch((err:Error)=>{if(!c.signal.aborted)setListError(err.message);});void poll();return()=>{c.abort();};},[]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),500);return()=>clearInterval(timer);},[]);
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme: dark)'),apply=()=>{document.documentElement.dataset['theme']=theme==='system'?(media.matches?'dark':'light'):theme;window.dispatchEvent(new Event('roadmap-theme'));};apply();media.addEventListener('change',apply);try{localStorage.setItem('roadmap.theme',theme);}catch{}return()=>media.removeEventListener('change',apply);},[theme]);
  const store=useObservation(selected,setSelected);
  useEffect(()=>{if(store?.connected)return;const c=new AbortController(),timer=setInterval(()=>{void get('/arcs',c.signal).then(r=>{if(r.uiSchema!==CONSOLE_UI_SCHEMA)throw new Error('Reload required: UI schema changed');setSelected(r.selected);setListError('');}).catch(err=>{if(!c.signal.aborted)setListError(err.message);});},15_000);return()=>{clearInterval(timer);c.abort();};},[store?.connected]);
  return <Views.Provider value={store}><Console key={selected} where={where} selected={selected} listError={listError} now={now} theme={theme} setTheme={setTheme} store={store}/></Views.Provider>;
}
function Console({where,selected,listError,now,theme,setTheme,store}:{where:ReturnType<typeof route>;selected:string|null;listError:string;now:number;theme:Theme;setTheme:(t:Theme)=>void;store:ReturnType<typeof useObservation>}) {
  const shell=useView('shell'),graph=useView(where.tab==='graph'?'graph':null),legacy=useView(where.tab==='graph'?null:'snapshot');
  const e=legacy.envelope as Envelope|null, p=shell.data as ShellView|null;
  const error=store?.error||shell.error||graph.error||legacy.error||'',checkedAt=store?.checkedAt??null,connected=store?.connected??false,reload=store?.reload??false;
  const graphEnvelope=store?.entries.get('graph')?.value;
  const graphInput=useMemo(()=>graphEnvelope?graphData(graphEnvelope):null,[graphEnvelope]);
  const scrolls=useRef(new Map<string,number>()),lastTab=useRef(where.tab);
  useLayoutEffect(()=>{const node=document.getElementById('content');if(!node)return;const old=lastTab.current;lastTab.current=where.tab;node.scrollTop=scrolls.current.get(where.tab)??0;const remember=()=>scrolls.current.set(where.tab,node.scrollTop);node.addEventListener('scroll',remember);return()=>{node.removeEventListener('scroll',remember);scrolls.current.set(where.tab,node.scrollTop);};},[where.tab,Boolean(e),Boolean(graphInput)]);
  const stale=!checkedAt||now-Date.parse(checkedAt)>5000||Boolean(error||listError);
  const clock=stale?Date.parse(checkedAt||e?.observedAt||new Date(now).toISOString()):now;
  const arc=selected,tab=where.tab,open=(id:string)=>{if(arc)location.hash=link(arc,tab,'units',id).slice(1);},close=()=>{if(arc)location.hash=link(arc,tab).slice(1);};
  const counts:Partial<Record<Signal,number>>={};
  const signal=(state:string):Signal=>state==='cut'||state==='superseded'?'withdrawn':state==='merged'?'passed':['running','preparing'].includes(state)?'active':['blocked','held','parked','awaiting-admission'].includes(state)?'held':state==='refused'?'failed':'pending';
  for(const [state,n] of Object.entries(p?.progress.countsByState??{})){const key=signal(state);counts[key]=(counts[key]??0)+n;}
  const total=p?.progress.total,day=p?.lifecycle.startedAt?Math.max(1,Math.floor(((p.lifecycle.endedAt?Date.parse(p.lifecycle.endedAt):clock)-Date.parse(p.lifecycle.startedAt))/86400_000)+1):null;
  const live=stale?'Stale':connected?'Connected':'Reconnecting';
  if(where.arc&&selected&&where.arc!==selected)return <main className="empty"><p>This console shows the current arc only</p><a href={link(selected,'graph')}>Open {selected}</a></main>;
  return <Clock.Provider value={clock}><div className="shell" data-stale={stale}>
    <a className="skip" href="#content" onClick={ev=>{ev.preventDefault();document.getElementById('content')?.focus();}}>Skip to content</a>
    <header className="arc-bar">
      <span className="arc-id"><span className="arc-logo" aria-hidden="true">╎</span><span>{arc||'Roadmap'}</span></span>
      <span className="arc-state">{p?stateWords(p.lifecycle.state):'Connecting'}</span><span className="arc-day">day {day===null?'—':Math.floor(day)}</span>
      <div className="progress-group"><div className="progress-strip" aria-label={p?`${counts.passed??0} of ${total} units merged`:'Unit progress unrecorded'}>{(['passed','active','held','failed','pending','withdrawn'] as Signal[]).map(state=>counts[state]?<span key={state} className={`progress-${state}`} style={{width:`${counts[state]!/Math.max(1,total??1)*100}%`}} title={`${counts[state]} ${state}`}/>:null)}</div><span className="progress-count">{p?counts.passed??0:'—'}/{total??'—'}<span> merged</span></span></div>
      <span className="recorded-spend" title="Recorded spend">{p?money(p.spend.costUsd):'Unrecorded'}</span>
      <span className={`connection connection-${live.toLowerCase()}`} role="status" title={checkedAt?`Last verified ${new Date(checkedAt).toLocaleString()}`:'Waiting for verified observation'}><span aria-hidden="true"/>{live}</span>
      <Button variant="ghost" size="icon" aria-label={`Theme: ${theme}. Switch theme`} title={`Theme: ${theme}`} onClick={()=>setTheme(theme==='system'?'light':theme==='light'?'dark':'system')}>{theme==='system'?<Monitor size={16}/>:theme==='light'?<Sun size={16}/>:<Moon size={16}/>}</Button>
    </header>
    <nav className="tabs" aria-label="Roadmap views">{tabs.map(key=><a key={key} href={arc?link(arc,key):'#/'} aria-current={key===tab?'page':undefined}>{key[0]!.toUpperCase()+key.slice(1)}{key==='attention'&&!!p?.attention.total&&<span className="tab-badge">{p.attention.total}</span>}</a>)}</nav>
    {(reload||error||listError||where.invalid)&&<div className="notice" role="alert">{where.invalid?'Unknown console route. Open the current arc.':reload?'Reload required: executor version changed':error||listError}{reload?<Button onClick={()=>location.reload()}>Reload console</Button>:error&&<Button onClick={()=>{shell.retry();if(tab==='graph')graph.retry();else legacy.retry();}}>Retry</Button>}</div>}
    {p?.lifecycle.endedAt&&<div className="outcome">{stateWords(p.lifecycle.state)}. {counts.passed??0} units merged; {counts.withdrawn??0} withdrawn. Recorded spend {money(p.spend.costUsd)}. Elapsed {elapsed(p.lifecycle.startedAt?Date.parse(p.lifecycle.endedAt!)-Date.parse(p.lifecycle.startedAt):null)}.</div>}
    <main id="content" tabIndex={-1} className={tab==='graph'?'graph-main':'tab-content'}>
      {graphInput&&<div hidden={tab!=='graph'} style={{height:'100%'}}><Graph key={arc} e={graphInput} open={open}/></div>}
      {tab!=='graph'&&e&&(tab==='timeline'?<Timeline e={e}/>:tab==='activity'?<Activity e={e}/>:tab==='effort'?<Effort e={e}/>:tab==='resources'?<Resources e={e}/>:<Attention e={e}/>)}
      {(tab==='graph'?!graphInput:!e)&&<div className="empty"><h1>{arc?'Arc observation':'Roadmap'}</h1><p>{arc?error||'Waiting for a verified observation…':'No current arc in this repository.'}</p></div>}
    </main>
    {stale&&checkedAt&&<div className="stale-notice"><Time at={checkedAt} prefix="Last updated "/>. Live counters paused.</div>}
    {arc&&where.unit&&<UnitDetail arc={arc} id={where.unit} close={close} stale={stale}/>}{arc&&where.inv&&<InvocationDetail key={where.inv} arc={arc} id={where.inv} close={close} stale={stale}/>}
  </div></Clock.Provider>;
}
