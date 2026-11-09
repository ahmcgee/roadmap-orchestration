import { useContext, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { ApiError, get, link, pluralise, route } from './shared.tsx';
import { Views, useView } from './view-state.ts';
import { activityChangesShape } from '../../src/console/view-shapes.ts';
import { ACTIVITY_KINDS, type ActivityView } from '../../src/console/activity-protocol.ts';
import { activityFields, activityParams, dayRange, shiftDay } from './activity-query.ts';
import { Holistic } from './holistic.tsx';
export function Activity({arc}:{arc:string}) {
  const current=route(),view=current.query.get('view')==='holistic'?'holistic':'events';
  const store=useContext(Views),params=activityParams(current.query),cursor=current.query.get('cursor');
  const query=params.toString(),path=`activity?${query}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;
  const state=useView(view==='events'?path:null),data=state.data as ActivityView|null;
  const [changes,setChanges]=useState(0),[noticeError,setNoticeError]=useState(''),[retry,setRetry]=useState(0),[localError,setLocalError]=useState('');
  useEffect(()=>{store?.ui.set('query:activity',current.query.toString());},[store,current.query.toString()]);
  const metadataVersion=store?.metadata?.viewVersions.activity,request=useRef(0);
  const requestVersion=store?.metadata?.viewVersions.attention,generation=store?.generation??0;
  const [requestAnchor,setRequestAnchor]=useState<{generation:number;version:string}|null>(null);
  useEffect(()=>{
    if(requestVersion&&(!requestAnchor||requestAnchor.generation!==generation))setRequestAnchor({generation,version:requestVersion});
  },[requestVersion,generation,requestAnchor]);
  const requestsChanged=Boolean(requestVersion&&requestAnchor?.generation===generation&&requestAnchor.version!==requestVersion);
  useEffect(()=>{
    setChanges(0);setNoticeError('');
    if(view!=='events'||!data||!store||!metadataVersion)return;
    // The initial SSE notice only verifies this prefix; it is not a new event.
    if(store.metadata!.highWater<=data.page.asOf.highWater)return;
    const c=new AbortController(),ticket=++request.current;
    void get(`/arcs/${encodeURIComponent(arc)}/activity/changes?${query}&anchor=${encodeURIComponent(data.page.anchor)}&epoch=${encodeURIComponent(store.metadata!.epoch)}&minHighWater=${store.metadata!.highWater}`,c.signal).then(raw=>{
      if(c.signal.aborted||ticket!==request.current)return;
      if(!activityChangesShape(raw.data))throw Object.assign(new ApiError('Malformed Activity changes; reload required'),{code:'protocol'});
      if(!store.admit(raw,false,true))throw Error('Activity changed during this read; retry');
      setChanges(raw.data.newMatching);
    }).catch(err=>{if(!c.signal.aborted){setNoticeError(err.message);if(err instanceof ApiError&&err.code==='protocol'){store.reload=true;store.emit();}}});
    return()=>c.abort();
  },[arc,view,path,data?.page.anchor,metadataVersion,store?.generation,retry]);
  function navigate(next:URLSearchParams, fresh=false){
    if(fresh){next.delete('cursor');const p=activityParams(next).toString();store?.abort(`activity?${p}`);if(store)void store.load(`activity?${p}`,true);}
    const target=`#/arcs/${encodeURIComponent(arc)}/activity${next.size?`?${next}`:''}`;
    if(location.hash===target){state.retry();setChanges(0);setNoticeError('');}else location.hash=target;
  }
  function latest(){const next=new URLSearchParams(current.query);next.set('order','desc');navigate(next,true);}
  function change(key:string,value:string){
    if(key==='view'){
      if(value==='holistic'){store?.ui.set('query:activity.events',current.query.toString());const next=new URLSearchParams(current.query);next.set('view','holistic');next.delete('cursor');next.delete('section');navigate(next);}
      else{const next=new URLSearchParams(store?.ui.get('query:activity.events') as string|undefined);next.delete('view');navigate(next);}
      return;
    }
    const next=new URLSearchParams(current.query);if(value)next.set(key,value);else next.delete(key);navigate(next,key!=='view');}
  function day(value:string){try{const range=dayRange(value,params.get('zone')!);const next=new URLSearchParams(current.query);next.delete('window');next.set('from',range.from);next.set('to',range.to);navigate(next,true);setLocalError('');}catch(err){setLocalError((err as Error).message);}}
  let selectedDay='';try{if(params.get('from'))selectedDay=new Intl.DateTimeFormat('en-CA',{timeZone:params.get('zone')!,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(params.get('from')!));}catch{/* The API presents invalid URL filters as a local, recoverable error. */}
  function filters(form:HTMLFormElement){const values=new FormData(form),next=new URLSearchParams(current.query);for(const key of activityFields){if(!values.has(key)&&key!=='housekeeping')continue;const value=String(values.get(key)??'');if(value)next.set(key,value);else next.delete(key);}navigate(next,true);}
  return <section className="panel"><header><h2>Activity</h2><p className="muted">What happened, in recorded journal order</p></header>
    <div className="local-tabs" aria-label="Activity sections"><Button aria-pressed={view==='events'} onClick={()=>change('view','')}>Events</Button><Button aria-pressed={view==='holistic'} onClick={()=>change('view','holistic')}>Holistic review</Button></div>
    <div className="activity-current-requests" aria-live="polite">{requestsChanged&&<p role="status">Current human requests may have changed. <a href={link(arc,'attention')}>View Attention</a> <Button onClick={()=>setRequestAnchor({generation,version:requestVersion!})}>Dismiss request notice</Button></p>}</div>
    {view==='holistic'?<Holistic arc={arc}/>:<>
      <form key={query} className="activity-filters" aria-label="Activity filters" onSubmit={ev=>{ev.preventDefault();filters(ev.currentTarget);}}>
        <label>Time window<select aria-label="Activity time window" value={params.get('window')??'range'} onChange={ev=>{const next=new URLSearchParams(current.query);next.delete('from');next.delete('to');next.set('window',ev.target.value);navigate(next,true);}}><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="arc">Whole arc</option>{!params.has('window')&&<option value="range">Selected range</option>}</select></label>
        <label>Day<input aria-label="Activity day" type="date" value={selectedDay} onChange={ev=>{if(ev.target.value)day(ev.target.value);}}/></label>
        <Button type="button" disabled={!selectedDay} onClick={()=>day(shiftDay(selectedDay,-1))}>Previous day</Button><Button type="button" disabled={!selectedDay} onClick={()=>day(shiftDay(selectedDay,1))}>Next day</Button>
        <label>Timezone<input name="zone" defaultValue={params.get('zone')!}/></label>
        <label>Search Activity summaries<input name="q" maxLength={200} defaultValue={params.get('q')??''}/></label>
        {(['unit','milestone','stage','role','backend','model','outcome'] as const).map(key=><label key={key}>{key[0]!.toUpperCase()+key.slice(1)}<input name={key} defaultValue={params.get(key)??''} placeholder="All"/></label>)}
        <label>Kind<select name="kind" defaultValue={params.get('kind')??''}><option value="">All summary kinds</option>{ACTIVITY_KINDS.map(k=><option key={k} value={k}>{k.replaceAll('-',' ')}</option>)}</select></label>
        <label>Order<select name="order" defaultValue={params.get('order')??'desc'}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
        <label>Rows per page<select name="limit" defaultValue={params.get('limit')??'50'}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label>
        <label><input type="checkbox" name="housekeeping" value="1" checked={params.get('housekeeping')==='1'} onChange={ev=>change('housekeeping',ev.target.checked?'1':'')}/> Show housekeeping steps</label>
        <Button type="submit">Apply filters</Button><Button type="button" onClick={()=>navigate(new URLSearchParams(),true)}>Reset view</Button>
      </form>
      <p className="muted">Search covers journal summaries, unit identity and recorded actors. Full review report text is available in event details.</p>
      <details className="activity-range"><summary>Exact time range (RFC3339)</summary><form className="activity-filters" onSubmit={ev=>{ev.preventDefault();const values=new FormData(ev.currentTarget),next=new URLSearchParams(current.query);next.delete('window');for(const key of ['from','to']){const value=String(values.get(key)??'');if(value)next.set(key,value);else next.delete(key);}navigate(next,true);}}><label>From (inclusive)<input name="from" defaultValue={params.get('from')??''} placeholder="RFC3339 instant"/></label><label>To (exclusive)<input name="to" defaultValue={params.get('to')??''} placeholder="RFC3339 instant"/></label><Button type="submit">Apply time range</Button></form></details>
      {localError&&<p role="alert">{localError}</p>}
      {(state.error||noticeError)&&<div role="alert"><p>{state.error||noticeError}</p><Button onClick={()=>state.error?state.retry():setRetry(retry+1)}>Retry Activity</Button><Button onClick={()=>navigate(new URLSearchParams(current.query),true)}>Reload Activity view</Button></div>}
      {state.loading&&<p role="status">{data?'Updating Activity…':'Loading Activity…'}</p>}
      {data&&<>
        <p className="activity-anchor">{data.page.matching} matching events. Page captured {new Date(data.page.asOf.observedAt).toLocaleString('en-GB',{timeZone:data.filters.zone})} ({data.filters.zone}); journal through {data.page.asOf.highWater}. Membership: applied plan at this anchor.</p>
        <div className="activity-updates" aria-live="polite">{changes>0&&<p role="status">{pluralise(changes,'new matching event')} <Button onClick={latest}>Show latest</Button></p>}</div>
        {data.days.length>0&&<label className="activity-day-jump">Jump to recorded day<select aria-label="Jump to recorded day" value="" onChange={ev=>{if(ev.target.value)day(ev.target.value);}}><option value="">Choose a day ({data.filters.zone})</option>{data.days.map(d=><option key={d.date} value={d.date}>{d.date} ({d.count})</option>)}</select></label>}
        {!data.rows.length&&<p>{data.page.asOf.highWater===0?'No recorded activity.':'No activity matches this window and these filters.'} <Button onClick={()=>{const next=new URLSearchParams(current.query);next.delete('from');next.delete('to');next.set('window','arc');navigate(next,true);}}>Whole arc</Button></p>}
        <ol className="activity-feed">{data.rows.map(row=><li key={row.id}><a href={link(arc,'activity','events',row.id)}><time dateTime={row.at}>{new Date(row.at).toLocaleString('en-GB',{timeZone:data.filters.zone})} {data.filters.zone}</time><span>{row.subject.type==='unit'&&<span className="muted">{row.subject.id} {row.subject.title}<br/></span>}{row.summary.text}{row.summary.truncated?'… Open full evidence':''}</span></a></li>)}</ol>
        <div className="pagination"><Button disabled={!data.page.previous} onClick={()=>{const next=new URLSearchParams(current.query);next.set('cursor',data.page.previous!);navigate(next);}}>{data.filters.order==='desc'?'Newer activity':'Earlier activity'}</Button><Button disabled={!data.page.next} onClick={()=>{const next=new URLSearchParams(current.query);next.set('cursor',data.page.next!);navigate(next);}}>{data.filters.order==='desc'?'Earlier activity':'Newer activity'}</Button><Button onClick={latest}>Latest</Button><span>{data.page.returned} of {data.page.matching} at this anchor</span></div>
      </>}
    </>}
  </section>;
}
