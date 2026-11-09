// Shared plain-table query mechanics. Rich tab presentations remain in later passes.
import { useContext, useEffect } from 'react';
import { Button } from '../components/ui/button.tsx';
import { route } from './shared.tsx';
import { Views, useView } from './view-state.ts';
import type { View, Page } from '../../src/console/view-protocol.ts';
export function usePlainQuery<T>(arc:string, endpoint:string, fields:readonly string[], defaults:Record<string,string>={}) {
  const current=route(),store=useContext(Views),params=new URLSearchParams();
  for(const key of fields)for(const value of current.query.getAll(key))params.append(key,value);
  for(const [key,value] of Object.entries(defaults))if(!params.has(key))params.set(key,value);
  const path=`${endpoint}?${params}`,state=useView(path);
  useEffect(()=>{store?.ui.set(`query:${current.tab}`,current.query.toString());},[store,current.tab,current.query.toString()]);
  function navigate(changes:Record<string,string|null>,fresh=false) {
    const next=new URLSearchParams(current.query);
    for(const [key,value] of Object.entries(changes))if(value===null)next.delete(key);else next.set(key,value);
    if(!('cursor' in changes)&&Object.keys(changes).some(key=>!['track','holds','holdCursor','intervalCursor'].includes(key)))next.delete('cursor');
    const hash=`#/arcs/${encodeURIComponent(arc)}/${current.tab}${next.size?`?${next}`:''}`;
    if(fresh){const query=new URLSearchParams();for(const key of fields)for(const value of next.getAll(key))query.append(key,value);for(const [key,value] of Object.entries(defaults))if(!query.has(key))query.set(key,value);void store?.load(`${endpoint}?${query}`,true);}
    location.hash=hash;
  }
  return {...state,data:state.data as T|null,path,params,navigate};
}
export function PlainPageStatus({data,error,loading,retry,reload,version}:{data:(View&Page<unknown>)|null;error:string;loading:boolean;retry:()=>void;reload:()=>void;version:'timeline'|'holistic'}) {
  let zone=route().query.get('zone')??Intl.DateTimeFormat().resolvedOptions().timeZone;try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{zone='UTC';}
  const store=useContext(Views),changed=!!data&&!!store?.metadata&&data.viewVersion!==store.metadata.viewVersions[version];
  return <>
    {error&&<div role="alert"><p>{error}</p><Button onClick={retry}>Retry view</Button><Button onClick={reload}>Reload view</Button></div>}
    {loading&&<p role="status">{data?'Updating view…':'Loading verified view…'}</p>}
    {data&&<><p className="muted">{data.page.matching} matching rows. Captured {new Date(data.page.asOf.observedAt).toLocaleString('en-GB',{timeZone:zone})} ({zone}); journal through {data.page.asOf.highWater}.</p><div className="activity-updates" aria-live="polite">{changed&&<p>Updates available. <Button onClick={reload}>Show updates</Button></p>}</div></>}
  </>;
}
export function PlainPaging({page,navigate}:{page:Page<unknown>['page'];navigate:(changes:Record<string,string|null>)=>void}) {
  return <div className="pagination"><Button disabled={!page.previous} onClick={()=>navigate({cursor:page.previous})}>Previous page</Button><Button disabled={!page.next} onClick={()=>navigate({cursor:page.next})}>Next page</Button><span>{page.returned} of {page.matching} at this anchor</span></div>;
}
export function activateRow(ev:React.MouseEvent<HTMLTableRowElement>,href:string|null) {
  if(!href||ev.defaultPrevented||ev.button!==0||ev.metaKey||ev.ctrlKey||ev.altKey||ev.shiftKey||(ev.target as HTMLElement).closest('a,button,input,select,summary'))return;
  location.hash=href.slice(1);
}
