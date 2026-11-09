import { useContext, useEffect, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Drawer } from './drawer.tsx';
import { DetailContinuations } from './detail-content.tsx';
import { Views, useSelectedDetail } from './view-state.ts';
import { displayZone, elapsed, formatInstant, link, money, pluralise, route, zoneLabel } from './shared.tsx';
import { activityKindWords, plainWords, stageWords } from '../../src/console/vocabulary.ts';
import type { ActivityDetail } from '../../src/console/activity-protocol.ts';
export function EventDetail({arc,id,close}:{arc:string;id:string;close:()=>void}) {
  const cache=useContext(Views);
  const path=`activity/${encodeURIComponent(id)}`,state=useSelectedDetail(arc,cache?.metadata?path:null),[expanded,setExpanded]=useState<ActivityDetail|null>(null);
  useEffect(()=>{const saved=cache?.ui.get(`detail:${path}`) as ActivityDetail|undefined;setExpanded(saved??null);},[path,state.data,cache?.generation]);
  function expand(value:ActivityDetail){setExpanded(value);cache?.ui.delete(`detail:${path}`);cache?.ui.set(`detail:${path}`,value);const keys=[...cache?.ui.keys()??[]].filter(k=>k.startsWith('detail:'));for(const key of keys.slice(0,-8))cache?.ui.delete(key);cache?.trimUi();}
  const data=expanded??state.data as ActivityDetail|null;
  const zone=route().query.get('zone')??displayZone();
  const invocationCount=data?.continuations?.find(c=>c.kind==='list'&&c.path.length===1&&c.path[0]==='invocations')?.total??data?.invocations.length??0;
  return <Drawer title={data?activityKindWords(data.row.kind):'Activity evidence'} close={close}>
    {expanded&&state.data&&expanded.viewVersion!==state.data.viewVersion&&<p>Newer verified evidence available. <Button onClick={()=>{cache?.ui.delete(`detail:${path}`);setExpanded(null);}}>Show updates</Button></p>}
    {state.error&&<div role="alert"><p>{state.error}</p><Button onClick={state.retry}>Retry</Button></div>}
    {!data?<p>Loading selected Activity evidence…</p>:<>
      <p>{data.row.stage&&<>{stageWords(data.row.stage)}{data.row.attempt!==null?`, attempt ${data.row.attempt}`:''}: </>}{(data.row.result??data.row.summary).text}{(data.row.result??data.row.summary).truncated?'…':''}</p>
      <p><time dateTime={data.row.at}>{formatInstant(data.row.at,zone)} {zoneLabel(zone)}</time>. Event {data.row.seq}.</p>
      <p>{data.row.subject.type==='unit'?<a href={link(arc,route().tab,'units',data.row.subject.id)}>{data.row.subject.id} {data.row.subject.title}</a>:data.row.subject.title}</p>
      {data.row.coverage.measured+data.row.coverage.unmeasured===0&&!data.row.spend?<p>No agent or command ran for this event.</p>:<>
      <p>Recorded work: {elapsed(data.row.workMs)}.{data.row.spend&&<> Recorded spend: {data.row.spend.costUsd===null?'Not recorded':money(data.row.spend.costUsd)}{data.row.spend.unavailable?' (partial)':''}.</>}</p>
      <p>{pluralise(data.row.coverage.measured,'run')} timed{data.row.coverage.unmeasured>0?`, ${data.row.coverage.unmeasured} not timed`:''}.{data.row.spend&&<> Cost known for {pluralise(data.row.spend.recorded,'run')}{data.row.spend.estimated>0?`, estimated for ${data.row.spend.estimated}`:''}{data.row.spend.unavailable>0?`, missing for ${data.row.spend.unavailable}`:''}.</>}</p></>}
      <dl className="detail-facts event-context">{data.context.map((item,i)=><div key={i}><dt>{({'Evidence invocation':'Evidence run','Recorded evidence path':'Evidence path','Recorded coverage':'Checked','Currently in open list':'Still open'} as Record<string,string>)[item.label]??item.label}</dt><dd>{item.label==='Request'?<a href={link(arc,route().tab,'requests',item.value)}>Open request {item.value}</a>:item.label==='Evidence invocation'?<a href={link(arc,route().tab,'invocations',item.value)}>Open run {item.value}</a>:item.label==='Raised at'?formatInstant(item.value,zone):item.value}</dd></div>)}</dl>
      {data.backendHold&&<section><h3>Backend availability</h3><p>{data.backendHold.backend}: new calls blocked ({plainWords(data.backendHold.effectiveClass).toLowerCase()}). Running calls could continue.</p><p>Started {formatInstant(data.backendHold.startedAt,zone)}.</p><p>{data.backendHold.closure?`Ended ${formatInstant(data.backendHold.closure.at,zone)}, ${data.backendHold.closure.kind==='probe'?'after a successful probe':data.backendHold.closure.kind==='resumed'?'on resume':'replaced by a newer hold'}.`:data.backendHold.terminalAt?`The arc ended at ${formatInstant(data.backendHold.terminalAt,zone)} with no resume recorded.`:'No end recorded.'}</p>{data.backendHold.closure&&<a href={link(arc,route().tab,'events',data.backendHold.closure.detail.id)}>Open the event that ended it</a>}</section>}
      <section><h3>Agent and command runs ({invocationCount})</h3>{!invocationCount&&<p>No run is recorded for this event.</p>}<ol>{data.invocations.map(i=><li key={i.id}><a href={link(arc,route().tab,'invocations',i.id)}>{i.subject.id} {i.subject.title}: {stageWords(i.stage)}, attempt {i.attempt}</a><p>{[i.actor.role,i.actor.backend,i.actor.model].filter(Boolean).join(', ')||'Agent not recorded'}. Work {elapsed(i.wallMs)}. {formatInstant(i.startedAt,zone)} to {i.endedAt?formatInstant(i.endedAt,zone):'still running'}.</p></li>)}</ol></section>
      <DetailContinuations arc={arc} path={path} detail={data} update={expand}/>
    </>}
  </Drawer>;
}
