import { useContext, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { ApiError, displayZone, elapsed, formatDay, formatInstant, get, link, loadError, money, pluralise, route, Time, zoneLabel } from './shared.tsx';
import { activateRow, CustomRange, FacetSelect, FilterBar, ignoredFilters, knownOnly, moveRowFocus, useFacets, unknownFilter } from './plain-query.tsx';
import { Views, useView } from './view-state.ts';
import { activityChangesShape } from '../../src/console/view-shapes.ts';
import { ACTIVITY_KINDS, type ActivityRow, type ActivityView } from '../../src/console/activity-protocol.ts';
import { activityFields, activityParams, dayRange, previousVisit, shiftDay } from './activity-query.ts';
import { activityKindWords, agentParts, backendWords, outcomeWords, roleWords, stageWords } from '../../src/console/vocabulary.ts';
import { Holistic } from './holistic.tsx';
/** The Activity filters that choose among recorded values: field, label, the "all" option, and the words each value reads as. */
const activityFacetFields=[['unit','Unit','All units',(v:string)=>v],['milestone','Milestone','All milestones',(v:string)=>v],['stage','Stage','All stages',stageWords],['role','Agent role','All roles',roleWords],['backend','Backend','All backends',backendWords],['model','Model','All models',(v:string)=>v],['outcome','Result','All results',outcomeWords]] as const;
const NOT_RECORDED='Not recorded',NOT_APPLICABLE=<span className="muted">Not applicable</span>;
function actorCell(row:ActivityRow) {
  if(row.actorCount>1)return `${row.actorCount} agents`;
  if(!row.actor)return NOT_RECORDED;
  // The shared agent name (role, then model), one part per line.
  const [first,second]=agentParts(row.actor);
  return first?<>{first}{second&&<span className="cell-line">{second}</span>}</>:NOT_RECORDED;
}
const workCell=(row:ActivityRow)=>row.workMs!==null?elapsed(row.workMs):row.coverage.measured+row.coverage.unmeasured>0?NOT_RECORDED:NOT_APPLICABLE;
function spendCell(row:ActivityRow) {
  if(!row.spend)return NOT_APPLICABLE;
  if(row.spend.costUsd===null)return NOT_RECORDED;
  return <>{money(row.spend.costUsd)}{(row.spend.unavailable>0||row.spend.estimated>0)&&<span className="cell-line">{row.spend.unavailable>0?'Partial':'Estimated'}</span>}</>;
}
export function Activity({arc}:{arc:string}) {
  const current=route(),view=current.query.get('view')==='holistic'?'holistic':'events';
  const store=useContext(Views),cached=useFacets('activity',undefined),params=knownOnly(activityParams(current.query,displayZone()),cached),cursor=current.query.get('cursor');
  const query=params.toString(),path=`activity?${query}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;
  const state=useView(view==='events'?path:null),data=state.data as ActivityView|null,facets=useFacets('activity',data?.facets);
  const [changes,setChanges]=useState(0),[expired,setExpired]=useState(false),[noticeError,setNoticeError]=useState(''),[retry,setRetry]=useState(0),[localError,setLocalError]=useState('');
  useEffect(()=>{store?.ui.set('query:activity',current.query.toString());},[store,current.query.toString()]);
  const metadataVersion=store?.metadata?.viewVersions.activity,request=useRef(0);
  const requestVersion=store?.metadata?.viewVersions.attention,generation=store?.generation??0;
  const [requestAnchor,setRequestAnchor]=useState<{generation:number;version:string}|null>(null);
  useEffect(()=>{
    if(requestVersion&&(!requestAnchor||requestAnchor.generation!==generation))setRequestAnchor({generation,version:requestVersion});
  },[requestVersion,generation,requestAnchor]);
  const requestsChanged=Boolean(requestVersion&&requestAnchor?.generation===generation&&requestAnchor.version!==requestVersion);
  useEffect(()=>{
    setChanges(0);setExpired(false);setNoticeError('');
    if(view!=='events'||!data||!store||!metadataVersion)return;
    // The initial SSE notice only verifies this prefix; it is not a new event.
    if(store.metadata!.highWater<=data.page.asOf.highWater)return;
    const c=new AbortController(),ticket=++request.current;
    void get(`/arcs/${encodeURIComponent(arc)}/activity/changes?${query}&anchor=${encodeURIComponent(data.page.anchor)}&epoch=${encodeURIComponent(store.metadata!.epoch)}`,c.signal).then(raw=>{
      if(c.signal.aborted||ticket!==request.current)return;
      if(!activityChangesShape(raw.data))throw Object.assign(new ApiError('Malformed Activity changes; reload required'),{code:'protocol'});
      store.admit(raw,false,true);
      setChanges(raw.data.newMatching);
      // An anchor the console no longer keeps (its index made way for a newer capture's) cannot count what is new; the newer
      // events are there all the same, so the page offers them rather than an error.
    }).catch(err=>{if(!c.signal.aborted){if(err instanceof ApiError&&err.code==='reset'){setExpired(true);return;}setNoticeError(err.message);if(err instanceof ApiError&&err.code==='protocol'){store.reload=true;store.emit();}}});
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
  function day(value:string){try{const range=dayRange(value,params.get('zone')!);const next=new URLSearchParams(current.query);next.delete('window');next.delete('afterSeq');next.set('from',range.from);next.set('to',range.to);navigate(next,true);setLocalError('');}catch(err){setLocalError((err as Error).message);}}
  let selectedDay='';try{if(params.get('from'))selectedDay=new Intl.DateTimeFormat('en-CA',{timeZone:params.get('zone')!,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(params.get('from')!));}catch{/* The API presents invalid URL filters as a local, recoverable error. */}
  const exactDay=selectedDay&&(()=>{try{const r=dayRange(selectedDay,params.get('zone')!);return r.from===params.get('from')&&r.to===params.get('to');}catch{return false;}})();
  const visit=previousVisit(arc,store?.metadata?.epoch);
  const windowValue=params.has('afterSeq')?'visit':exactDay?`day:${selectedDay}`:params.get('window')??'range';
  const dayOptions:{date:string;count:number|null}[]=[...(data?.days??[])].reverse();
  if(exactDay&&!dayOptions.some(d=>d.date===selectedDay))dayOptions.unshift({date:selectedDay,count:null});
  function chooseWindow(value:string){
    if(value.startsWith('day:')){day(value.slice(4));return;}
    const next=new URLSearchParams(current.query);next.delete('from');next.delete('to');next.delete('afterSeq');
    if(value==='visit'&&visit!==null){next.delete('window');next.set('afterSeq',String(visit));}else next.set('window',value);
    navigate(next,true);
  }
  function apply(values:FormData){const next=new URLSearchParams(current.query);for(const key of activityFields){if(!values.has(key)&&key!=='housekeeping')continue;const value=String(values.get(key)??'');if(value)next.set(key,value);else next.delete(key);}if(next.get('from')||next.get('to'))next.delete('window');navigate(next,true);}
  return <section className="panel"><header className="panel-head"><div><h2>Activity</h2><p className="muted">{view==='holistic'?'Audits, findings and root decisions':`What happened, ${params.get('order')==='asc'?'oldest':'newest'} first`}</p></div>
    <div className="local-tabs" aria-label="Activity sections"><Button aria-pressed={view==='events'} onClick={()=>change('view','')}>Events</Button><Button aria-pressed={view==='holistic'} onClick={()=>change('view','holistic')}>Holistic review</Button></div>
    <div className="activity-current-requests" aria-live="polite">{requestsChanged&&<p role="status">Decisions waiting for you may have changed. <a href={link(arc,'attention')}>View Attention</a> <Button onClick={()=>setRequestAnchor({generation,version:requestVersion!})}>Dismiss request notice</Button></p>}</div></header>
    {view==='holistic'?<Holistic arc={arc}/>:<>
      <FilterBar label="Activity" ignored={ignoredFilters(current.query,facets,{unit:'unit',milestone:'milestone',stage:'stage',role:'agent role',backend:'backend',model:'model',outcome:'result'})} resetKey={query} search={params.get('q')??''} searchHelp="Searches summaries, units and agents. Open an event for the full report." dirty={current.query.size>0} activeFilters={['unit','milestone','stage','role','backend','model','outcome','kind'].filter(k=>params.get(k)).length+(params.get('housekeeping')==='1'?1:0)+(params.get('order')==='asc'?1:0)}
        apply={apply} reset={()=>navigate(new URLSearchParams(),true)}
        window={<select aria-label="Activity time window" className="filter-window" value={windowValue} onChange={ev=>chooseWindow(ev.target.value)}>
          <option value="arc">Latest events</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
          {visit!==null&&<option value="visit">Since your last visit (this browser)</option>}
          {windowValue==='range'&&<option value="range">Custom time range</option>}
          <optgroup label="By day">{dayOptions.map(d=><option key={d.date} value={`day:${d.date}`}>{formatDay(d.date)}{d.count===null?'':` (${pluralise(d.count,'event')})`}</option>)}</optgroup>
        </select>}
        extra={selectedDay?<><Button type="button" onClick={()=>day(shiftDay(selectedDay,-1))}>Previous day</Button><Button type="button" onClick={()=>day(shiftDay(selectedDay,1))}>Next day</Button></>:undefined}>
        <CustomRange from={params.get('from')} to={params.get('to')}/>
        <div className="filter-grid">{activityFacetFields.map(([key,label,all,words])=><FacetSelect key={key} name={key} label={label} all={all} values={facets?.[key]??null} value={current.query.get(key)??''} words={words}/>)}
        <label>Type<select name="kind" defaultValue={params.get('kind')??''}><option value="">All types</option>{ACTIVITY_KINDS.map(k=><option key={k} value={k}>{activityKindWords(k)}</option>)}</select></label>
        <label>Order<select name="order" defaultValue={params.get('order')??'desc'}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
        <label>Rows per page<select name="limit" defaultValue={params.get('limit')??'50'}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label>
        <label className="filter-check"><input type="checkbox" name="housekeeping" value="1" defaultChecked={params.get('housekeeping')==='1'}/> Show routine steps</label></div>
      </FilterBar>
      {localError&&<p role="alert">{localError}</p>}
      {state.error&&unknownFilter(state.error)?<div role="alert"><p>This link filters by a value that isn't recorded in this arc.</p><Button onClick={()=>{const next=new URLSearchParams(current.query);for(const [key] of activityFacetFields)next.delete(key);navigate(next,true);}}>Clear those filters</Button></div>
      :(state.error&&(!data||state.failures>=3)||noticeError)&&<div role="alert"><p>{state.error&&data?"Couldn't refresh this view. Trying again.":loadError(state.error||noticeError)}</p><Button onClick={()=>state.error?navigate(new URLSearchParams(current.query),true):setRetry(retry+1)}>Retry</Button></div>}
      {state.loading&&<p role="status">{data?'Updating Activity…':'Loading Activity…'}</p>}
      {data&&<>
        <div className="page-status"><p className="activity-anchor muted">{windowValue==='visit'?`Since your last visit in this browser: ${pluralise(data.page.matching,'event')}`:pluralise(data.page.matching,'event')}. Updated {formatInstant(data.page.asOf.observedAt,data.filters.zone,true)} {zoneLabel(data.filters.zone)}.</p>
        <div className="activity-updates" aria-live="polite">{(changes>0||expired)&&<p role="status">{changes>0?pluralise(changes,'new matching event'):'Updates available.'} <Button onClick={latest}>Show latest</Button></p>}</div></div>
        {!data.rows.length&&<p>{data.page.asOf.highWater===0?'No activity recorded yet.':'No activity matches this window and these filters.'} <Button onClick={()=>{const next=new URLSearchParams(current.query);next.delete('from');next.delete('to');next.delete('afterSeq');next.set('window','arc');navigate(next,true);}}>Whole arc</Button></p>}
        <Table className="activity-feed" aria-label="Activity events" onKeyDown={moveRowFocus}><thead><TableRow><TableHead className="col-time">Time ({zoneLabel(data.filters.zone)})</TableHead><TableHead className="col-unit">Unit</TableHead><TableHead className="col-stage">Stage</TableHead><TableHead className="col-agent">Agent</TableHead><TableHead className="col-result">Result</TableHead><TableHead className="number">Work</TableHead><TableHead className="number">Spend</TableHead></TableRow></thead>
        <tbody>{data.rows.map(row=>{const href=link(arc,'activity','events',row.id);return <TableRow key={row.id} onClick={ev=>activateRow(ev,href)}>
          <td className="col-time"><a href={href}><time dateTime={row.at}>{formatInstant(row.at,data.filters.zone)}</time></a><span className="cell-line"><Time at={row.at}/></span></td>
          <td className="col-unit">{row.subject.type==='unit'?<><span className="unit-id">{row.subject.id}</span><span className="cell-line">{row.subject.title}</span></>:row.subject.title}</td>
          <td className="col-stage">{row.stage?stageWords(row.stage):activityKindWords(row.kind)}{row.attempt!==null&&row.stage&&<span className="cell-line">Attempt {row.attempt}</span>}</td>
          <td className="col-agent">{actorCell(row)}</td>
          <td className="col-result">{(row.result??row.summary).text}{(row.result??row.summary).truncated?'… Open for the full text':''}</td>
          <td className="number">{workCell(row)}</td><td className="number">{spendCell(row)}</td>
        </TableRow>;})}</tbody></Table>
        <div className="pagination"><Button disabled={!data.page.previous} onClick={()=>{const next=new URLSearchParams(current.query);next.set('cursor',data.page.previous!);navigate(next);}}>{data.filters.order==='desc'?'Newer activity':'Earlier activity'}</Button><Button disabled={!data.page.next} onClick={()=>{const next=new URLSearchParams(current.query);next.set('cursor',data.page.next!);navigate(next);}}>{data.filters.order==='desc'?'Earlier activity':'Newer activity'}</Button><Button onClick={latest}>Latest</Button><span>Showing {data.page.returned} of {data.page.matching}</span></div>
      </>}
    </>}
  </section>;
}
