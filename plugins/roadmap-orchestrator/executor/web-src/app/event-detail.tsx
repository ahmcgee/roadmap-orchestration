import { useContext, useEffect, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Drawer } from './drawer.tsx';
import { DetailContinuations } from './detail-content.tsx';
import { Views, useSelectedDetail } from './view-state.ts';
import { displayZone, elapsed, formatInstant, link, money, pluralise, route, zoneLabel } from './shared.tsx';
import type { ActivityDetail } from '../../src/console/activity-protocol.ts';
export function EventDetail({arc,id,close}:{arc:string;id:string;close:()=>void}) {
  const cache=useContext(Views);
  const path=`activity/${encodeURIComponent(id)}`,state=useSelectedDetail(arc,cache?.metadata?path:null),[expanded,setExpanded]=useState<ActivityDetail|null>(null);
  useEffect(()=>{const saved=cache?.ui.get(`detail:${path}`) as ActivityDetail|undefined;setExpanded(saved??null);},[path,state.data,cache?.generation]);
  function expand(value:ActivityDetail){setExpanded(value);cache?.ui.delete(`detail:${path}`);cache?.ui.set(`detail:${path}`,value);const keys=[...cache?.ui.keys()??[]].filter(k=>k.startsWith('detail:'));for(const key of keys.slice(0,-8))cache?.ui.delete(key);cache?.trimUi();}
  const data=expanded??state.data as ActivityDetail|null;
  const zone=route().query.get('zone')??displayZone();
  const invocationCount=data?.continuations?.find(c=>c.kind==='list'&&c.path.length===1&&c.path[0]==='invocations')?.total??data?.invocations.length??0;
  return <Drawer title={data?({'stage-outcome':'Stage result','plan-applied':'Plan updated'} as Record<string,string>)[data.row.kind]??data.row.kind.replaceAll('-',' ').replace(/^./,c=>c.toUpperCase()):'Activity evidence'} close={close}>
    {expanded&&state.data&&expanded.viewVersion!==state.data.viewVersion&&<p>Newer verified evidence available. <Button onClick={()=>{cache?.ui.delete(`detail:${path}`);setExpanded(null);}}>Show updates</Button></p>}
    {state.error&&<div role="alert"><p>{state.error}</p><Button onClick={state.retry}>Retry</Button></div>}
    {!data?<p>Loading selected Activity evidence…</p>:<>
      <p>{data.row.summary.text}{data.row.summary.truncated?'…':''}</p>
      <p><time dateTime={data.row.at}>{formatInstant(data.row.at,zone)} {zoneLabel(zone)}</time>. Event {data.row.seq}.</p>
      <p>{data.row.subject.type==='unit'?<a href={link(arc,route().tab,'units',data.row.subject.id)}>{data.row.subject.id} {data.row.subject.title}</a>:data.row.subject.title}</p>
      {data.row.coverage.measured+data.row.coverage.unmeasured===0&&!data.row.spend?<p>No agent or command ran for this event.</p>:<>
      <p>Recorded work: {elapsed(data.row.workMs)}.{data.row.spend&&<> Recorded spend: {data.row.spend.costUsd===null?'Not recorded':money(data.row.spend.costUsd)}{data.row.spend.unavailable?' (partial)':''}.</>}</p>
      <p>{data.row.coverage.measured} measured, {pluralise(data.row.coverage.unmeasured,'unmeasured call')}.{data.row.spend&&<> Cost: {data.row.spend.recorded} recorded, {data.row.spend.estimated} estimated, {data.row.spend.unavailable} unavailable calls.</>}</p></>}
      <dl className="detail-facts event-context">{data.context.map((item,i)=><div key={i}><dt>{item.label}</dt><dd>{item.label==='Request'?<a href={link(arc,route().tab,'requests',item.value)}>Open request {item.value}</a>:item.label==='Evidence invocation'?<a href={link(arc,route().tab,'invocations',item.value)}>Open invocation {item.value}</a>:item.value}</dd></div>)}</dl>
      {data.backendHold&&<section><h3>Backend availability</h3><p>{data.backendHold.backend}: unavailable to new calls (recorded park: {data.backendHold.recordedClass}; effective hold: {data.backendHold.effectiveClass}). Running calls can continue.</p><p>Started {data.backendHold.startedAt}. {data.backendHold.closure?`Closure: ${data.backendHold.closure.kind} at ${data.backendHold.closure.at}.`:data.backendHold.terminalAt?`Clipped at Arc end ${data.backendHold.terminalAt}; no resume recorded.`:'No closure recorded.'}</p>{data.backendHold.closure&&<a href={link(arc,route().tab,'events',data.backendHold.closure.detail.id)}>Open closure evidence</a>}</section>}
      <section><h3>Contributing invocations ({invocationCount})</h3>{!invocationCount&&<p>No invocation is recorded for this event.</p>}<ol>{data.invocations.map(i=><li key={i.id}><a href={link(arc,route().tab,'invocations',i.id)}>{i.subject.id} {i.subject.title}: {i.stage}, attempt {i.attempt}</a><p>{[i.actor.role,i.actor.backend,i.actor.model].filter(Boolean).join(' / ')||'Actor not recorded'}. Measured work {elapsed(i.wallMs)}. {i.startedAt} to {i.endedAt??'open'}.</p></li>)}</ol></section>
      <DetailContinuations arc={arc} path={path} detail={data} update={expand}/>
    </>}
  </Drawer>;
}
