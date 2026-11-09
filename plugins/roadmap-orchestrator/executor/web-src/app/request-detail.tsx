import { useContext, useEffect, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Drawer } from './drawer.tsx';
import { DetailContinuations } from './detail-content.tsx';
import { Views, useSelectedDetail } from './view-state.ts';
import { link, route, Time } from './shared.tsx';
import type { RequestView } from '../../src/console/attention-protocol.ts';
export function RequestDetail({arc,id,close}:{arc:string;id:string;close:()=>void}) {
  const cache=useContext(Views),path=`requests/${encodeURIComponent(id)}`,state=useSelectedDetail(arc,cache?.metadata?path:null),[expanded,setExpanded]=useState<RequestView|null>(null);
  useEffect(()=>{setExpanded(cache?.ui.get(`detail:${path}`) as RequestView??null);},[path,state.data,cache?.generation]);
  function expand(value:RequestView){setExpanded(value);cache?.ui.delete(`detail:${path}`);cache?.ui.set(`detail:${path}`,value);const keys=[...cache?.ui.keys()??[]].filter(k=>k.startsWith('detail:'));for(const key of keys.slice(0,-8))cache?.ui.delete(key);cache?.trimUi();}
  const fresh=state.data as RequestView|null,data=fresh?.evidenceAvailability==='pruned'?fresh:expanded??fresh,record=data?.recordPreview,open=fresh?.open??data?.open;
  const rows=cache?[...cache.entries].find(([key])=>key.startsWith('attention?')&&cache.active.has(key))?.[1].value?.data.rows as {id:string}[]|undefined:undefined;
  const at=rows?.findIndex(r=>r.id===id)??-1;
  let zone=route().query.get('zone')??Intl.DateTimeFormat().resolvedOptions().timeZone;try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{zone='UTC';}
  return <Drawer title="Human request" close={close} className="request-drawer">
    {state.error&&<div role="alert"><p>{state.error}</p><Button onClick={state.retry}>Retry request detail</Button></div>}
    {!data?<p>Loading selected human request…</p>:<>
      <p>{data.id}</p><p role="status">{open?'Currently open':fresh?.resolutionEvidence.some(r=>r.kind==='acknowledged')?'Acknowledged':fresh?.resolutionEvidence.some(r=>r.kind==='declined')?'Declined by the executor':'No longer in the open list'}</p>
      {!open&&(fresh??data).resolutionEvidence.map((r,i)=><p key={i}>{r.kind==='no-longer-open'?'No acknowledgement identified. Absence from the open list does not establish how this request was settled.':`${r.kind==='declined'?'Declined':'Acknowledged'}: ${r.source}, ${r.at??'date not recorded'}${r.command?`, command ${r.command}`:''}${r.choice?`, choice ${r.choice}`:''}.`}</p>)}
      {expanded&&fresh&&expanded.viewVersion!==fresh.viewVersion&&<p>Newer verified request detail available. <Button onClick={()=>{cache?.ui.delete(`detail:${path}`);setExpanded(null);}}>Show current detail</Button></p>}
      {data.evidenceAvailability==='pruned'?<p>Retained request evidence has been pruned.</p>:<>
        <h3>{data.fields.summary}</h3>
        {record&&<><p>{record.blocking?'Blocking: Waiting for a human':'Nonblocking: For your information'}. Reason: {record.reason}.</p><p>Raised <time dateTime={record.raisedAt}>{new Date(record.raisedAt).toLocaleString('en-GB',{timeZone:zone})}</time> {zone}; <Time at={record.raisedAt}/>.</p><p>Subject: {record.subject.type==='unit'?`${record.subject.id} ${record.subject.title}`:record.subject.type==='findings'?`${record.subject.count} findings`:record.subject.type==='arc'?'Arc':'Host'}</p></>}
        <section className="owner-notice"><h3>Recommendation</h3><p>{data.fields.recommendation.split(' After reviewing')[0]}</p>{data.fields.recommendation.includes(' After reviewing')&&<p>After reviewing{data.fields.recommendation.split(' After reviewing').slice(1).join(' After reviewing')}</p>}</section>
        <section><h3>Offered options</h3>{data.options.map(o=><p key={o.id}>{o.label}<span style={{marginLeft:4}}>({o.id})</span>{open&&o.command&&<><br/><code>{o.command}</code></>}</p>)}{!data.options.length&&<p>No options recorded.</p>}{open&&<><p>{data.guidance.text}</p>{data.guidance.command&&<p><code>{data.guidance.command}</code></p>}</>}</section>
        <section><h3>Affected units</h3>{!data.affectedUnits.length&&<p>No unit relationship recorded.</p>}<ul>{data.affectedUnits.map(u=><li key={u.id}><a href={link(arc,route().tab,'units',u.id)}>{u.id} {u.title}</a></li>)}</ul>{data.findingRefs.length>0&&<><h3>Related findings</h3><ul>{data.findingRefs.map(f=><li key={f.id}>{f.event?<a href={link(arc,route().tab,'events',f.event)}>{f.id}</a>:f.id}</li>)}</ul></>}</section>
        <section><h3>Evidence</h3>{!data.evidenceRefs.length&&<p>No evidence paths recorded.</p>}{data.evidenceRefs.map((e,i)=><p key={i}>{e.invocation?<a href={link(arc,route().tab,'invocations',e.invocation)}>Evidence: {e.path.split('/').slice(-2).join('/')}</a>:<code>{e.path}</code>}</p>)}</section>
        <DetailContinuations arc={arc} path={path} detail={data} update={expand}/>
      </>}
      {rows&&at>=0&&<nav className="pagination" aria-label="Requests on captured page">{at>0&&<a href={link(arc,route().tab,'requests',rows[at-1]!.id)}>Previous request</a>}{at+1<rows.length&&<a href={link(arc,route().tab,'requests',rows[at+1]!.id)}>Next request</a>}</nav>}
    </>}
  </Drawer>;
}
