// Shared query mechanics and the one compact filter bar. Rich tab presentations remain in later passes.
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { displayZone, formatInstant, loadError, pluralise, route, zonedInstant, zonedLocal, zoneLabel } from './shared.tsx';
import type { ViewStore } from './view-store.ts';
import type { ShellView } from '../../src/console/view-protocol.ts';
import { Views, useView } from './view-state.ts';
import type { View, Page } from '../../src/console/view-protocol.ts';
type LatestWindow={from:string;to:string}|{window:string};
/** 24 hours ending at the last recorded event, so a quiet arc never opens empty. Null until the shell has loaded. */
function latestWindow(store:ViewStore):LatestWindow|null {
  const shell=store.entries.get('shell')?.value?.data as ShellView|undefined;
  if(!shell)return null;
  const last=shell.availableRange.to;if(!last)return {window:'24h'};
  const lastAt=Date.parse(last),from=Math.max(shell.availableRange.from?Date.parse(shell.availableRange.from):-Infinity,lastAt-86400_000);
  return {from:new Date(from).toISOString(),to:new Date(lastAt+1).toISOString()};
}
/** The default window of a time-scoped tab, pinned for this visit (`window:<tab>` in the store's UI state), so the view holds
 * still as events arrive and offers "Show updates" instead; a fresh load (Show updates, Retry) takes the latest again. */
export function useLatestWindow():LatestWindow|null {
  const store=useContext(Views),key=`window:${route().tab}`;
  useEffect(()=>()=>{store?.ui.delete(key);},[store,key]);
  if(!store)return null;
  const pinned=store.ui.get(key) as LatestWindow|undefined;if(pinned)return pinned;
  const latest=latestWindow(store);if(latest)store.ui.set(key,latest);
  return latest;
}

export function usePlainQuery<T>(arc:string, endpoint:string, fields:readonly string[], defaults:Record<string,string>|null={}) {
  const current=route(),store=useContext(Views),cached=store?.ui.get(`facets:${current.tab}`) as Record<string,readonly string[]>|undefined;
  let params=new URLSearchParams();
  for(const key of fields)for(const value of current.query.getAll(key))params.append(key,value);
  if(defaults)for(const [key,value] of Object.entries(defaults))if(!params.has(key))params.set(key,value);
  params=knownOnly(params,cached??null);
  const path=defaults?`${endpoint}?${params}`:'',state=useView(defaults?path:null);
  // While a new query loads, the tab keeps showing what it last showed (with "Updating…"), never an empty body.
  const last=useRef<{tab:string;generation:number;data:unknown}|null>(null),generation=store?.generation??0;
  if(state.data)last.current={tab:current.tab,generation,data:state.data};
  const data=state.data??(last.current?.tab===current.tab&&last.current.generation===generation?last.current.data:null);
  const facets=useFacets(current.tab,(data as {facets?:Record<string,readonly string[]>}|null)?.facets);
  useEffect(()=>{store?.ui.set(`query:${current.tab}`,current.query.toString());},[store,current.tab,current.query.toString()]);
  function navigate(changes:Record<string,string|null>,fresh=false) {
    const next=new URLSearchParams(current.query);
    for(const [key,value] of Object.entries(changes))if(value===null)next.delete(key);else next.set(key,value);
    if(!('cursor' in changes)&&Object.keys(changes).some(key=>!['track','holds','holdCursor','intervalCursor','reasons','reasonCursor'].includes(key)))next.delete('cursor');
    const hash=`#/arcs/${encodeURIComponent(arc)}/${current.tab}${next.size?`?${next}`:''}`;
    if(fresh&&defaults){
      // A fresh load of the pinned default window takes the latest window again.
      let base=defaults;const key=`window:${current.tab}`,pinned=store?.ui.get(key) as Record<string,string>|undefined;
      if(store&&pinned&&Object.entries(pinned).every(([k,v])=>defaults[k]===v)){store.ui.delete(key);const latest=latestWindow(store);if(latest){store.ui.set(key,latest);base=Object.fromEntries(Object.entries(defaults).filter(([k])=>!(k in pinned)));Object.assign(base,latest);}}
      const query=new URLSearchParams();for(const key of fields)for(const value of next.getAll(key))query.append(key,value);for(const [key,value] of Object.entries(base))if(!query.has(key))query.set(key,value);void store?.load(`${endpoint}?${query}`,true);}
    location.hash=hash;
  }
  return {...state,data:data as T|null,path,params,navigate,facets};
}
/** `count` names what the rows are when they are not all one noun. */
export function PlainPageStatus({data,error,failures=0,loading,reload,version,noun,count}:{data:(View&Page<unknown>)|null;error:string;failures?:number;loading:boolean;retry:()=>void;reload:()=>void;version:'timeline'|'holistic'|'attention'|'effort'|'resources';noun:string;count?:string|undefined}) {
  const zone=route().query.get('zone')??displayZone();
  const store=useContext(Views),changed=!!data&&!!store?.metadata&&data.viewVersion!==store.metadata.viewVersions[version];
  return <>
    {error&&(!data||failures>=3)&&(unknownFilter(error)?<p role="alert">This link filters by a value that isn't recorded in this arc. Choose another value, or reset the view.</p>:<div role="alert"><p>{data?"Couldn't refresh this view. Trying again.":loadError(error)}</p><Button onClick={reload}>Retry</Button></div>)}
    {loading&&<p role="status">{data?'Updating…':'Loading…'}</p>}
    {data&&<div className="page-status"><p className="muted">{count??pluralise(data.page.matching,noun)}. Updated {formatInstant(data.page.asOf.observedAt,zone,true)} {zoneLabel(zone)}.</p><div className="activity-updates" aria-live="polite">{changed&&<p>Updates available. <Button onClick={reload}>Show updates</Button></p>}</div></div>}
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
/** A custom time range as date and time inputs in the console's timezone. Applying fills the form's `from` and `to`. */
export function CustomRange({from,to}:{from:string|null;to:string|null}) {
  const zone=route().query.get('zone')??displayZone(),[error,setError]=useState(''),start=useRef<HTMLInputElement>(null),end=useRef<HTMLInputElement>(null);
  function applyRange(ev:React.MouseEvent<HTMLButtonElement>){
    const form=ev.currentTarget.form!,a=zonedInstant(start.current!.value,zone),b=zonedInstant(end.current!.value,zone);
    if(!a||!b){setError('Choose a start and an end.');return;}if(a>=b){setError('The start must be before the end.');return;}
    setError('');form.querySelector<HTMLInputElement>('input[name="from"]')!.value=a;form.querySelector<HTMLInputElement>('input[name="to"]')!.value=b;form.requestSubmit();
  }
  return <details className="activity-range"><summary>Custom time range</summary>
    <input type="hidden" name="from" defaultValue={from??''}/><input type="hidden" name="to" defaultValue={to??''}/>
    <label>From<input ref={start} type="datetime-local" defaultValue={from?zonedLocal(from,zone):''}/></label><label>To<input ref={end} type="datetime-local" defaultValue={to?zonedLocal(to,zone):''}/></label>
    <p className="muted">Times are in {zoneLabel(zone)}.</p>{error&&<p role="alert">{error}</p>}
    <Button type="button" onClick={applyRange}>Apply time range</Button></details>;
}
/** A filter as a choice of the values this arc recorded: the table's words show, the recorded value is sent.
 * A value from a link that isn't recorded is named under the field and left out of the read. */
export function FacetSelect({name,label,all,values,value,words=(v:string)=>v}:{name:string;label:string;all:string;values:readonly string[]|null;value:string;words?:(v:string)=>string}) {
  const unknown=!!values&&value!==''&&value.split(',').some(v=>!values.includes(v));
  return <label>{label}<select name={name} defaultValue={unknown?'':value}><option value="">{all}</option>
    {!values&&value&&<option value={value}>{value.split(',').map(words).join(', ')}</option>}
    {(values??[]).map(v=><option key={v} value={v}>{words(v)}</option>)}
  </select>{unknown&&<small className="filter-unknown" role="status">“{value}” isn't recorded in this arc, so it isn't applied.</small>}</label>;
}
/** The recorded values a view can be filtered by, kept from its latest read so a stale link never fails the read. */
export function useFacets(tab:string,facets:Record<string,readonly string[]>|undefined) {
  const store=useContext(Views);
  useEffect(()=>{if(facets)store?.ui.set(`facets:${tab}`,facets);},[store,tab,facets]);
  return (facets??store?.ui.get(`facets:${tab}`) as Record<string,readonly string[]>|undefined)??null;
}
/** A read refused because a link names a filter value the arc never recorded: retrying can't help. */
export const unknownFilter=(error:string)=>/^unknown (Activity )?[\w -]+ filter$/.test(error);
/** Drop filter values the arc never recorded, so a stale link reads the rest instead of failing. */
export function knownOnly(params:URLSearchParams,facets:Record<string,readonly string[]>|null) {
  if(!facets)return params;
  const next=new URLSearchParams(params);
  for(const [key,values] of Object.entries(facets)){const v=next.get(key);if(v&&v.split(',').some(x=>!values.includes(x)))next.delete(key);}
  return next;
}
/** Link values that name nothing this arc recorded, as sentences shown under the filter bar (they are left out of the read). */
export function ignoredFilters(query:URLSearchParams,facets:Record<string,readonly string[]>|null,labels:Record<string,string>):string[] {
  if(!facets)return [];
  return Object.entries(labels).flatMap(([key,label])=>{const v=query.get(key),values=facets[key];return v&&values&&v.split(',').some(x=>!values.includes(x))?[`This link's ${label} “${v}” isn't recorded in this arc, so it isn't applied.`]:[];});
}
/** Search, window and a Filters popover. Every field applies as it changes; search applies 300 ms after typing stops. */
export function FilterBar({label,resetKey,apply,reset,dirty,search,searchHelp,window,extra,activeFilters,ignored=[],children}:{label:string;resetKey:string;apply:(values:FormData)=>void;reset:()=>void;dirty:boolean;search:string|null;searchHelp:string;window?:ReactNode;extra?:ReactNode;activeFilters:number;ignored?:string[];children?:ReactNode}) {
  const form=useRef<HTMLFormElement>(null),open=useRef(false),focused=useRef<string|null>(null),typing=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(typing.current)clearTimeout(typing.current);},[]);
  useLayoutEffect(()=>{if(focused.current)form.current?.querySelector<HTMLInputElement>(`[name="${focused.current}"]`)?.focus();},[resetKey]);
  function commit(){if(form.current)apply(new FormData(form.current));}
  return <div className="filter-bar"><form key={resetKey} ref={form} className="filter-bar-form" aria-label={label} onSubmit={ev=>{ev.preventDefault();commit();}}
    onFocus={ev=>{const el=ev.target as unknown as HTMLInputElement;if(el.name)focused.current=el.name;}}
    onChange={ev=>{if((ev.target as HTMLElement).matches('select[name],input[type=checkbox][name]'))commit();}}
    onInput={ev=>{const el=ev.target as HTMLInputElement;if(el.name!=='q')return;if(typing.current)clearTimeout(typing.current);typing.current=setTimeout(()=>{typing.current=null;if(el.value!==el.defaultValue)commit();},300);}}
    onBlur={ev=>{const el=ev.target as unknown as HTMLInputElement;if(el.matches('input[name]:not([type=checkbox]):not([type=hidden])')&&el.value!==el.defaultValue)commit();}}>
    {search!==null&&<input className="filter-search" type="search" name="q" maxLength={200} aria-label={`Search ${label}`} title={searchHelp} placeholder="Search" defaultValue={search}/>}
    {window}{extra}
    {children&&<details className="filter-popover-menu" open={open.current} onToggle={ev=>{open.current=ev.currentTarget.open;}}>
      <summary>Filters{activeFilters?` (${activeFilters})`:''}</summary>
      <div className="filter-menu-body">{children}</div>
    </details>}
    {dirty&&<Button type="button" variant="ghost" onClick={reset}>Reset view</Button>}
  </form>{ignored.map(text=><p key={text} className="filter-unknown" role="status">{text}</p>)}</div>;
}
