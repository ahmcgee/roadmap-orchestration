import { useContext, useEffect, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Drawer } from './drawer.tsx';
import { DetailContinuations } from './detail-content.tsx';
import { Views, useSelectedDetail } from './view-state.ts';
import { elapsed, link, money, pluralise, route } from './shared.tsx';
import type { ActivityDetail } from '../../src/console/activity-protocol.ts';
export function EventDetail({arc,id,close}:{arc:string;id:string;close:()=>void}) {
  const cache=useContext(Views);
  const path=`activity/${encodeURIComponent(id)}`,state=useSelectedDetail(arc,cache?.metadata?path:null),[expanded,setExpanded]=useState<ActivityDetail|null>(null);
  useEffect(()=>{const saved=cache?.ui.get(`detail:${path}`) as ActivityDetail|undefined;setExpanded(saved??null);},[path,state.data,cache?.generation]);
  function expand(value:ActivityDetail){setExpanded(value);cache?.ui.delete(`detail:${path}`);cache?.ui.set(`detail:${path}`,value);const keys=[...cache?.ui.keys()??[]].filter(k=>k.startsWith('detail:'));for(const key of keys.slice(0,-8))cache?.ui.delete(key);cache?.trimUi();}
  const data=expanded??state.data as ActivityDetail|null;
  let zone=route().query.get('zone')??Intl.DateTimeFormat().resolvedOptions().timeZone;try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{zone='UTC';}
  const invocationCount=data?.continuations?.find(c=>c.kind==='list'&&c.path.length===1&&c.path[0]==='invocations')?.total??data?.invocations.length??0;
  return <Drawer title={data?data.row.kind.replaceAll('-',' '):'Activity evidence'} close={close}>
    {expanded&&state.data&&expanded.viewVersion!==state.data.viewVersion&&<p>Newer verified evidence available. <Button onClick={()=>{cache?.ui.delete(`detail:${path}`);setExpanded(null);}}>Show updates</Button></p>}
    {state.error&&<div role="alert"><p>{state.error}</p><Button onClick={state.retry}>Retry event detail</Button></div>}
    {!data?<p>Loading selected Activity evidence…</p>:<>
      <p>{data.row.summary.text}{data.row.summary.truncated?'…':''}</p>
      <p><time dateTime={data.row.at}>{new Date(data.row.at).toLocaleString('en-GB',{timeZone:zone})} {zone}</time>. Journal sequence {data.row.seq}.</p>
      <p>{data.row.subject.type==='unit'?<a href={link(arc,route().tab,'units',data.row.subject.id)}>{data.row.subject.id} {data.row.subject.title}</a>:data.row.subject.title}</p>
      <p>Evidence: {data.evidenceAvailability}. Recorded work: {elapsed(data.row.workMs)}. Recorded spend: {data.row.spend===null?'Not applicable':data.row.spend.costUsd===null?'Not recorded':money(data.row.spend.costUsd)}{data.row.spend?.unavailable?' (partial coverage)':''}.</p>
      <p>Work coverage: {data.row.coverage.measured} measured, {pluralise(data.row.coverage.unmeasured,'unmeasured contributing invocation')}.{data.row.spend&&<> Cost coverage: {data.row.spend.recorded} recorded, {data.row.spend.estimated} estimated, {data.row.spend.unavailable} unavailable calls.</>}</p>
      <dl className="detail-facts event-context">{data.context.map((item,i)=><div key={i}><dt>{item.label}</dt><dd>{item.label==='Evidence invocation'?<a href={link(arc,route().tab,'invocations',item.value)}>Open invocation {item.value}</a>:item.value}</dd></div>)}</dl>
      {data.backendHold&&<section><h3>Backend availability</h3><p>{data.backendHold.backend}: unavailable to new calls (recorded park: {data.backendHold.recordedClass}; effective hold: {data.backendHold.effectiveClass}). Running calls can continue.</p><p>Started {data.backendHold.startedAt}. {data.backendHold.closure?`Closure: ${data.backendHold.closure.kind} at ${data.backendHold.closure.at}.`:data.backendHold.terminalAt?`Clipped at Arc end ${data.backendHold.terminalAt}; no resume recorded.`:'No closure recorded.'}</p>{data.backendHold.closure&&<a href={link(arc,route().tab,'events',data.backendHold.closure.detail.id)}>Open closure evidence</a>}</section>}
      <section><h3>Contributing invocations ({invocationCount})</h3>{!invocationCount&&<p>No invocation is recorded for this event.</p>}<ol>{data.invocations.map(i=><li key={i.id}><a href={link(arc,route().tab,'invocations',i.id)}>{i.subject.id} {i.subject.title}: {i.stage}, attempt {i.attempt}</a><p>{[i.actor.role,i.actor.backend,i.actor.model].filter(Boolean).join(' / ')||'Actor not recorded'}. Measured work {elapsed(i.wallMs)}. {i.startedAt} to {i.endedAt??'open'}.</p></li>)}</ol></section>
      <DetailContinuations arc={arc} path={path} detail={data} update={expand}/>
    </>}
  </Drawer>;
}
