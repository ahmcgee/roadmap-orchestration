// Shared query mechanics and the one compact filter bar. Rich tab presentations remain in later passes.
import { useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { displayZone, formatInstant, loadError, pluralise, route, zoneLabel } from './shared.tsx';
import type { ShellView } from '../../src/console/view-protocol.ts';
import { Views, useView } from './view-state.ts';
import type { View, Page } from '../../src/console/view-protocol.ts';
/** The window a quiet arc must not open empty: 24 hours ending at the last recorded event. Null until the shell has loaded. */
export function useLatestWindow():{from:string;to:string}|{window:string}|null {
  const store=useContext(Views);const shell=store?.entries.get('shell')?.value?.data as ShellView|undefined;
  if(!shell)return null;
  const last=shell.availableRange.to;if(!last)return {window:'24h'};
  const lastAt=Date.parse(last),from=Math.max(shell.availableRange.from?Date.parse(shell.availableRange.from):-Infinity,lastAt-86400_000);
  return {from:new Date(from).toISOString(),to:new Date(lastAt+1).toISOString()};
}
export function usePlainQuery<T>(arc:string, endpoint:string, fields:readonly string[], defaults:Record<string,string>|null={}) {
  const current=route(),store=useContext(Views),params=new URLSearchParams();
  for(const key of fields)for(const value of current.query.getAll(key))params.append(key,value);
  if(defaults)for(const [key,value] of Object.entries(defaults))if(!params.has(key))params.set(key,value);
  const path=defaults?`${endpoint}?${params}`:'',state=useView(defaults?path:null);
  useEffect(()=>{store?.ui.set(`query:${current.tab}`,current.query.toString());},[store,current.tab,current.query.toString()]);
  function navigate(changes:Record<string,string|null>,fresh=false) {
    const next=new URLSearchParams(current.query);
    for(const [key,value] of Object.entries(changes))if(value===null)next.delete(key);else next.set(key,value);
    if(!('cursor' in changes)&&Object.keys(changes).some(key=>!['track','holds','holdCursor','intervalCursor','reasons','reasonCursor'].includes(key)))next.delete('cursor');
    const hash=`#/arcs/${encodeURIComponent(arc)}/${current.tab}${next.size?`?${next}`:''}`;
    if(fresh&&defaults){const query=new URLSearchParams();for(const key of fields)for(const value of next.getAll(key))query.append(key,value);for(const [key,value] of Object.entries(defaults))if(!query.has(key))query.set(key,value);void store?.load(`${endpoint}?${query}`,true);}
    location.hash=hash;
  }
  return {...state,data:state.data as T|null,path,params,navigate};
}
export function PlainPageStatus({data,error,loading,reload,version,noun}:{data:(View&Page<unknown>)|null;error:string;loading:boolean;retry:()=>void;reload:()=>void;version:'timeline'|'holistic'|'attention'|'effort'|'resources';noun:string}) {
  const zone=route().query.get('zone')??displayZone();
  const store=useContext(Views),changed=!!data&&!!store?.metadata&&data.viewVersion!==store.metadata.viewVersions[version];
  return <>
    {error&&<div role="alert"><p>{loadError(error)}</p><Button onClick={reload}>Retry</Button></div>}
    {loading&&<p role="status">{data?'Updating…':'Loading…'}</p>}
    {data&&<div className="page-status"><p className="muted">{pluralise(data.page.matching,noun)}. Updated {formatInstant(data.page.asOf.observedAt,zone,true)} {zoneLabel(zone)}.</p><div className="activity-updates" aria-live="polite">{changed&&<p>Updates available. <Button onClick={reload}>Show updates</Button></p>}</div></div>}
  </>;
}
export function PlainPaging({page,navigate}:{page:Page<unknown>['page'];navigate:(changes:Record<string,string|null>)=>void}) {
  return <div className="pagination"><Button disabled={!page.previous} onClick={()=>navigate({cursor:page.previous})}>Previous page</Button><Button disabled={!page.next} onClick={()=>navigate({cursor:page.next})}>Next page</Button><span>Showing {page.returned} of {page.matching}</span></div>;
}
/** The shared row path: Up/Down, Home/End between each row's primary link; Enter follows it. */
export function moveRowFocus(ev:React.KeyboardEvent<HTMLElement>) {
  if((ev.target as HTMLElement).closest('input,select,button')||!['ArrowDown','ArrowUp','Home','End'].includes(ev.key))return;
  const links=[...ev.currentTarget.querySelectorAll<HTMLTableRowElement>('tbody tr[data-clickable]')].flatMap(r=>r.querySelector<HTMLAnchorElement>('a[href]')??[]),n=links.indexOf(document.activeElement as HTMLAnchorElement);
  if(n<0)return;ev.preventDefault();links[ev.key==='Home'?0:ev.key==='End'?links.length-1:Math.max(0,Math.min(links.length-1,n+(ev.key==='ArrowDown'?1:-1)))]?.focus();
}
export function activateRow(ev:React.MouseEvent<HTMLTableRowElement>,href:string|null) {
  if(!href||ev.defaultPrevented||ev.button!==0||ev.metaKey||ev.ctrlKey||ev.altKey||ev.shiftKey||(ev.target as HTMLElement).closest('a,button,input,select,summary'))return;
  // Focus the row's primary link first, so closing the drawer returns focus here even after a cell click.
  ev.currentTarget.querySelector<HTMLAnchorElement>('a[href]')?.focus({preventScroll:true});
  location.hash=href.slice(1);
}

/** The window control every time-scoped view shares: Latest (the default), Now presets, Whole arc. */
export function WindowSelect({label,query,navigate,latest}:{label:string;query:URLSearchParams;navigate:(changes:Record<string,string|null>,fresh?:boolean)=>void;latest:{from:string;to:string}|{window:string}|null}) {
  const value=query.get('window')??(query.has('from')||query.has('to')?'range':'latest');
  const until=latest&&'to' in latest?formatInstant(new Date(Date.parse(latest.to)-1).toISOString(),route().query.get('zone')??displayZone(),true):null;
  return <select aria-label={label} className="filter-window" value={value} onChange={ev=>{const window=ev.target.value;navigate({window:window==='latest'||window==='range'?null:window,from:null,to:null,...(['track','intervalCursor','holdCursor'].some(k=>query.has(k))?{track:null,intervalCursor:null,holdCursor:null}:{})},true);}}>
    <option value="latest">{until?`Last 24 hours of activity, to ${until}`:'Latest'}</option>
    <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="arc">Whole arc</option>{value==='range'&&<option value="range">Custom time range</option>}
  </select>;
}
/** Search, window and a Filters popover. Selects apply as they change; text applies on Enter or blur. */
export function FilterBar({label,resetKey,apply,reset,dirty,search,searchHelp,window,extra,activeFilters,children}:{label:string;resetKey:string;apply:(values:FormData)=>void;reset:()=>void;dirty:boolean;search:string|null;searchHelp:string;window?:ReactNode;extra?:ReactNode;activeFilters:number;children?:ReactNode}) {
  const form=useRef<HTMLFormElement>(null),open=useRef(false),focused=useRef<string|null>(null);
  useLayoutEffect(()=>{if(focused.current)form.current?.querySelector<HTMLInputElement>(`[name="${focused.current}"]`)?.focus();},[resetKey]);
  function commit(){if(form.current)apply(new FormData(form.current));}
  return <div className="filter-bar"><form key={resetKey} ref={form} className="filter-bar-form" aria-label={label} onSubmit={ev=>{ev.preventDefault();commit();}}
    onFocus={ev=>{const el=ev.target as unknown as HTMLInputElement;if(el.name)focused.current=el.name;}}
    onChange={ev=>{if((ev.target as HTMLElement).matches('select[name],input[type=checkbox][name]'))commit();}}
    onBlur={ev=>{const el=ev.target as unknown as HTMLInputElement;if(el.matches('input[name]:not([type=checkbox])')&&el.value!==el.defaultValue)commit();}}>
    {search!==null&&<input className="filter-search" type="search" name="q" maxLength={200} aria-label={`Search ${label}`} title={searchHelp} placeholder="Search" defaultValue={search}/>}
    {window}{extra}
    {children&&<details className="filter-popover-menu" open={open.current} onToggle={ev=>{open.current=ev.currentTarget.open;}}>
      <summary>Filters{activeFilters?` (${activeFilters})`:''}</summary>
      <div className="filter-menu-body">{children}</div>
    </details>}
    {dirty&&<Button type="button" variant="ghost" onClick={reset}>Reset view</Button>}
  </form></div>;
}
