import { useEffect, useState } from 'react';
import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.tsx';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../components/ui/command.tsx';
import { Clock, elapsed, get, link, money, route, tabs, Time } from './shared.tsx';
import { useObservation } from './observation.ts';
import { Graph } from './graph.tsx';
import { UnitDetail } from './drawer.tsx';
import { InvocationDetail } from './invocation.tsx';
import { Activity, Attention, Effort, Resources, Timeline } from './other-tabs.tsx';
import type { Signal } from './types.ts';
type Theme = 'system'|'light'|'dark';
export function App() {
  const [where,setWhere]=useState(route),[arcs,setArcs]=useState<{arc:string}[]>([]),[selected,setSelected]=useState<string|null>(null),[listError,setListError]=useState(''),[now,setNow]=useState(Date.now()),[switcher,setSwitcher]=useState(false);
  const [theme,setTheme]=useState<Theme>(()=>{try{const value=localStorage.getItem('roadmap.theme');return value==='light'||value==='dark'?value:'system';}catch{return 'system';}});
  useEffect(()=>{const change=()=>setWhere(route());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  useEffect(()=>{const c=new AbortController();const poll=()=>get('/arcs',c.signal).then(r=>{setArcs(r.arcs);setSelected(where.arc||r.selected);setListError('');}).catch((err:Error)=>{if(!c.signal.aborted)setListError(err.message);});void poll();const timer=setInterval(poll,2000);return()=>{c.abort();clearInterval(timer);};},[where.arc]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),500);return()=>clearInterval(timer);},[]);
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme: dark)'),apply=()=>{document.documentElement.dataset['theme']=theme==='system'?(media.matches?'dark':'light'):theme;window.dispatchEvent(new Event('roadmap-theme'));};apply();media.addEventListener('change',apply);try{localStorage.setItem('roadmap.theme',theme);}catch{}return()=>media.removeEventListener('change',apply);},[theme]);
  const {e,error,checkedAt,connected,reload}=useObservation(selected);
  const stale=!checkedAt||now-Date.parse(checkedAt)>5000||Boolean(error||listError),p=e?.data.console.presentation;
  const clock=stale?Date.parse(checkedAt||e?.observedAt||new Date(now).toISOString()):now;
  const arc=selected,tab=where.tab,open=(id:string)=>{if(arc)location.hash=link(arc,tab,'units',id).slice(1);},close=()=>{if(arc)location.hash=link(arc,tab).slice(1);};
  const counts:Partial<Record<Signal,number>>={};for(const u of e?.data.console.graph.units??[]){if(u.id.startsWith('milestone:'))continue;const state:Signal=/withdrawn/.test(u.meta)?'withdrawn':u.status;counts[state]=(counts[state]??0)+1;}
  const total=e?.data.console.presentation.units.length??0,day=p?Math.max(1,Math.floor(((p.run.endedAt?Date.parse(p.run.endedAt):clock)-Date.parse(p.run.startedAt))/86400_000)+1):1;
  const live=stale?'Stale':connected?'Connected':'Reconnecting';
  const hostUrl=new URL(location.origin);if(hostUrl.hostname==='127.0.0.1'||hostUrl.hostname==='[::1]')hostUrl.hostname='localhost';
  return <Clock.Provider value={clock}><div className="shell" data-stale={stale}>
    <a className="skip" href="#content" onClick={ev=>{ev.preventDefault();document.getElementById('content')?.focus();}}>Skip to content</a>
    <header className="arc-bar">
      <Popover open={switcher} onOpenChange={setSwitcher}><PopoverTrigger asChild><Button className="arc-switcher" variant="ghost" aria-label="Switch arc"><span className="arc-logo" aria-hidden="true">╎</span><span>{arc||'Roadmap'}</span><ChevronDown size={14}/></Button></PopoverTrigger><PopoverContent><Command><CommandInput aria-label="Find an arc" placeholder="Find an arc…"/><CommandList><CommandEmpty>No retained arcs</CommandEmpty>{arcs.map(a=><CommandItem key={a.arc} value={a.arc} onSelect={()=>{location.hash=link(a.arc).slice(1);setSwitcher(false);}}><span>{a.arc}</span>{arc===a.arc&&<Check size={14}/>}</CommandItem>)}</CommandList></Command><a className="follow-arc" href="#/" onClick={()=>setSwitcher(false)}>{where.arc?'Follow current arc':'Following current arc'}</a><Button variant="ghost" onClick={()=>setTheme(theme==='system'?'light':theme==='light'?'dark':'system')}>Theme: {theme}</Button><div className="arc-details">{p&&<><Time at={p.run.startedAt} prefix="Started "/><span>Elapsed {elapsed(p.run.endedAt?p.run.elapsedMs:clock-Date.parse(p.run.startedAt))}</span>{p.run.endedAt&&<Time at={p.run.endedAt} prefix="Ended "/>}</>}<a href={hostUrl.origin}>{hostUrl.origin}</a></div></PopoverContent></Popover>
      <span className="arc-state">{p?.run.state||'Connecting'}</span><span className="arc-day">day {Math.floor(day)}</span>
      <div className="progress-group"><div className="progress-strip" aria-label={`${counts.passed??0} of ${total} units merged`}>{(['passed','active','held','failed','pending','withdrawn'] as Signal[]).map(state=>counts[state]?<span key={state} className={`progress-${state}`} style={{width:`${counts[state]!/Math.max(1,total)*100}%`}} title={`${counts[state]} ${state}`}/>:null)}</div><span className="progress-count">{counts.passed??0}/{total}<span> merged</span></span></div>
      <span className="recorded-spend" title="Recorded spend">{money(e?.data.summary.spend.costUsd??0)}</span>
      <span className={`connection connection-${live.toLowerCase()}`} role="status" title={checkedAt?`Last verified ${new Date(checkedAt).toLocaleString()}`:'Waiting for verified observation'}><span aria-hidden="true"/>{live}</span>
      <Button variant="ghost" size="icon" aria-label={`Theme: ${theme}. Switch theme`} title={`Theme: ${theme}`} onClick={()=>setTheme(theme==='system'?'light':theme==='light'?'dark':'system')}>{theme==='system'?<Monitor size={16}/>:theme==='light'?<Sun size={16}/>:<Moon size={16}/>}</Button>
    </header>
    <nav className="tabs" aria-label="Roadmap views">{tabs.map(key=><a key={key} href={arc?link(arc,key):'#/'} aria-current={key===tab?'page':undefined}>{key[0]!.toUpperCase()+key.slice(1)}{key==='attention'&&!!e?.data.console.attention.length&&<span className="tab-badge">{e.data.console.attention.length}</span>}</a>)}</nav>
    {(reload||error||listError||where.invalid)&&<div className="notice" role="alert">{where.invalid?'Unknown console route. Choose an arc.':reload?'Reload required: executor version changed':error||listError}{reload&&<Button onClick={()=>location.reload()}>Reload console</Button>}</div>}
    {p?.run.endedAt&&<div className="outcome">{p.run.state}. {counts.passed??0} units merged; {counts.withdrawn??0} withdrawn. Recorded spend {money(e!.data.summary.spend.costUsd)}. Elapsed {elapsed(p.run.elapsedMs)}.</div>}
    <main id="content" tabIndex={-1} className={tab==='graph'?'graph-main':'tab-content'}>{e?tab==='graph'?<Graph key={arc} e={e} open={open}/>:tab==='timeline'?<Timeline e={e}/>:tab==='activity'?<Activity e={e}/>:tab==='effort'?<Effort e={e}/>:tab==='resources'?<Resources e={e}/>:<Attention e={e}/>:<div className="empty"><h1>{arc?'Arc observation':'Roadmap'}</h1><p>{arc?error||'Waiting for a verified observation…':'No retained arcs in this repository.'}</p></div>}</main>
    {stale&&checkedAt&&<div className="stale-notice"><Time at={checkedAt} prefix="Last updated "/>. Live counters paused.</div>}
    {e&&where.unit&&<UnitDetail e={e} id={where.unit} close={close} stale={stale}/>}{e&&where.inv&&<InvocationDetail key={where.inv} e={e} id={where.inv} close={close} stale={stale}/>}
  </div></Clock.Provider>;
}
