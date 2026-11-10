// One booking, a resource's holders (newest first), a stage's CPU use, or a waiting reason's measured waits.
import { useContext, useState, useEffect } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { DetailContinuations } from './detail-content.tsx';
import { Drawer } from './drawer.tsx';
import { Views, useSelectedDetail } from './view-state.ts';
import { Clock, displayZone, elapsed, formatInstant, link, route, pluralise, zoneLabel } from './shared.tsx';
import { activateRow } from './plain-query.tsx';
import { resourceFields, cores, cpuCoverage, basisWords, waitKind, ResourceIdentity, ResourceTime, resourceName, resourceRowKeys } from './resources.tsx';
import type { ShellView } from '../../src/console/view-protocol.ts';
import type { ResourceDetail, ResourceBooking, ResourceCpuCall, ResourceWait } from '../../src/console/resource-protocol.ts';
import { plainWords, reasonWords, stageWords } from '../../src/console/vocabulary.ts';
const titles={booking:'Booking',resource:'Resource history',cpu:'CPU use',waiting:'Waiting'} as const;
export function ResourceDetailDrawer({arc,id,close}:{arc:string;id:string;close:()=>void}) {
  const store=useContext(Views),current=route(),params=new URLSearchParams(),clock=useContext(Clock);
  for(const key of resourceFields)if(key!=='cursor'&&key!=='limit')for(const value of current.query.getAll(key))params.append(key,value);
  if(!params.has('section'))params.set('section',id.startsWith('cpu-')?'cpu':id.startsWith('waiting-')||id.startsWith('measurement-')?'waiting':'schedule');
  if(params.get('section')!=='now'&&(current.query.has('detailFrom')||current.query.has('detailTo'))){params.delete('window');for(const [key,field] of [['from','detailFrom'],['to','detailTo']]){const value=current.query.get(field!);if(value)params.set(key!,value);}}
  if(current.query.has('resourceEvidence'))params.set('evidence',current.query.get('resourceEvidence')!);
  params.set('limit','25');if(current.query.has('detailCursor'))params.set('cursor',current.query.get('detailCursor')!);
  const path=`resources/details/${encodeURIComponent(id)}?${params}`,state=useSelectedDetail(arc,store?.metadata?path:null),data=state.data as ResourceDetail|null;
  const [expanded,setExpanded]=useState<ResourceDetail|null>(null);useEffect(()=>{setExpanded(store?.ui.get(`detail:${path}`) as ResourceDetail??null);},[path,state.data,store?.generation]);
  const visible=expanded??data,terminalAt=(store?.entries.get('shell')?.value?.data as ShellView|undefined)?.lifecycle.endedAt??data?.bounds.terminalAt;
  const zone=current.query.get('zone')??displayZone();
  function navigate(cursor:string|null,fresh=false){if(fresh){store?.ui.delete(`detail:${path}`);setExpanded(null);const first=new URLSearchParams(params);first.delete('cursor');void store?.load(`resources/details/${encodeURIComponent(id)}?${first}`,true);}const q=new URLSearchParams(current.query);if(cursor)q.set('detailCursor',cursor);else q.delete('detailCursor');location.hash=`${link(arc,current.tab,'resources',id).split('?')[0]}?${q}`;}
  const evidence=(section:'ownership'|'calls')=>{const q=new URLSearchParams(current.query);q.set('resourceEvidence',section);q.delete('detailCursor');location.hash=`${link(arc,current.tab,'resources',id).split('?')[0]}?${q}`;};
  const unitHref=(r:{subject:{type:string;unitRef:string|null}})=>r.subject.type==='unit'&&r.subject.unitRef?link(arc,current.tab,'units',r.subject.unitRef):null;
  const duration=(b:ResourceBooking)=>{const ms=(b.endedAt?Date.parse(b.endedAt):terminalAt?Date.parse(terminalAt):clock)-Date.parse(b.startedAt);return ms<0?'Timestamp order unavailable':`${b.endedAt?'':'Open for '}${elapsed(ms)}`;};
  const ended=(b:ResourceBooking)=>b.endedAt?<><ResourceTime at={b.endedAt}/></>:terminalAt?'The arc ended with no release recorded.':'Still held';
  const holder=(b:ResourceBooking)=><>{b.subject.type==='unit'?<ResourceIdentity arc={arc} subject={b.subject}/>:<span>{plainWords(b.holder.type)} {b.holder.id}</span>}{b.instance&&<span className="cell-line">{b.instance}</span>}</>;
  const bookingRow=(b:ResourceBooking)=><TableRow key={b.id} onClick={ev=>activateRow(ev,unitHref(b))}><td>{holder(b)}</td><td><ResourceTime at={b.startedAt}/></td><td className="number" title={b.endedAt?`${Date.parse(b.endedAt)-Date.parse(b.startedAt)} ms`:undefined}>{duration(b)}</td><td>{ended(b)}</td></TableRow>;
  const callRow=(c:ResourceCpuCall)=>{const href=c.invocation?link(arc,current.tab,'invocations',c.invocation):unitHref(c);return <TableRow key={c.id} onClick={ev=>activateRow(ev,href)}><td>{c.subject.type==='unit'?<ResourceIdentity arc={arc} subject={c.subject}/>:<span>{c.subject.type==='job'?'Job':'Arc'} {c.subject.id}</span>}{c.invocation?<a className="resource-primary-link cell-line" href={href!}>{stageWords(c.stage)}, attempt {c.attempt??'not recorded'}</a>:<span className="cell-line">Run details not recorded</span>}</td><td className="number">{c.reservedCpu===null?'Not recorded':pluralise(c.reservedCpu,'core')}{c.basis&&<span className="cell-line">{basisWords(c.basis)}</span>}</td><td title={c.measured?`${c.measured.runMs} ms of CPU time over ${c.measured.wallMs} ms; waited ${c.measured.waitMs} ms`:undefined}>{c.measured?<>Used {elapsed(c.measured.runMs)} of CPU time over {elapsed(c.measured.wallMs)}{c.measured.waitMs>0&&<span className="cell-line">Waited {elapsed(c.measured.waitMs)} for CPU</span>}</>:'Not measured'}</td><td>{c.startedAt?<ResourceTime at={c.startedAt}/>:'Not recorded'}<span className="cell-line">{c.endedAt?<>to <ResourceTime at={c.endedAt}/></>:'No end recorded'}</span></td></TableRow>;};
  const waitRow=(w:ResourceWait)=><TableRow key={w.id} onClick={ev=>activateRow(ev,unitHref(w))}><td>{w.subject.type==='unit'?<ResourceIdentity arc={arc} subject={w.subject}/>:<span>{w.subject.type==='job'?'Job':'Arc'} {w.subject.id}</span>}<span className="cell-line">Waiting to {waitKind(w).toLowerCase()}</span></td><td><ResourceTime at={w.at}/></td><td className="number">{elapsed(w.totalMs)}</td><td className="resource-reasons">{w.reasons.map(r=><span key={r.reason} className="cell-line">{reasonWords(r.reason)}: {elapsed(r.ms)}</span>)}</td></TableRow>;
  return <Drawer title={titles[visible?.kind??(id.startsWith('cpu-')?'cpu':id.startsWith('booking-')?'booking':id.startsWith('resource-')?'resource':'waiting')]} close={close} className="resource-detail-drawer">
    {state.error&&<div role="alert"><p>{state.error}</p><Button onClick={()=>navigate(null,true)}>Retry</Button></div>}
    {!visible?(state.error?null:<p>Loading…</p>):<>
      <h3>{visible.kind==='booking'&&visible.booking?`${resourceName(visible.booking.instance??visible.booking.resource)}, ${visible.booking.endedAt?'held':'held now'} by ${visible.booking.subject.type==='unit'?visible.booking.subject.id:visible.booking.holder.id}`:visible.label}</h3>
      <p className="muted">Updated {formatInstant(visible.page.asOf.observedAt,zone,true)} {zoneLabel(zone)}.</p>
      {visible.viewVersion!==store?.metadata?.viewVersions.resources&&<p>Updates available. <Button onClick={()=>navigate(null,true)}>Show updates</Button></p>}
      {visible.subject&&visible.kind!=='booking'&&<p><ResourceIdentity arc={arc} subject={visible.subject}/></p>}
      {visible.booking&&<p><a href={link(arc,current.tab,'resources',visible.booking.resourceKey)}>Everyone who held {resourceName(visible.booking.resource)}</a></p>}
      {visible.kind==='resource'&&<p className="muted">Newest first. A booking runs from reserve to release, including cleaning.</p>}
      {visible.cpu&&<><dl className="effort-figures"><div><dt>Measured cores</dt><dd>{cores(visible.cpu.averageCores)}</dd></div><div><dt>Reserved cores</dt><dd>{cores(visible.cpu.weightedReservedCores)}</dd></div><div><dt>Used reservation</dt><dd>{visible.cpu.reservationPercent===null?'Not recorded':`${cores(visible.cpu.reservationPercent)}%`}</dd></div><div><dt>Run time</dt><dd>{elapsed(visible.cpu.measuredRunMs)}</dd></div><div><dt>Wall time</dt><dd>{elapsed(visible.cpu.measuredWallMs)}</dd></div><div><dt>Reserved core time</dt><dd>{Number((visible.cpu.reservedCoreMs/1000).toFixed(1))} core-seconds</dd></div></dl>
        <p className="muted">{cpuCoverage(visible.cpu)} Calls that overlap in time count separately.</p></>}
      {visible.reason&&<p>{visible.reason.label}: <span title={`${visible.reason.totalMs} ms`}>{elapsed(visible.reason.totalMs)}</span> across {pluralise(visible.reason.count,'wait')}. A wait can have several reasons, so these times overlap with other reasons.</p>}
      {(visible.kind==='booking'||visible.kind==='resource')&&<nav className="activity-subviews" aria-label="Booking evidence">{(['ownership','calls'] as const).map(section=><Button key={section} aria-pressed={visible.evidence===section} onClick={()=>evidence(section)}>{section==='ownership'?(visible.kind==='booking'?'Booking':'Who held it'):'Runs while held'}</Button>)}</nav>}
      {!(visible.kind==='booking'&&visible.evidence==='ownership')&&<p>{visible.evidence==='ownership'?pluralise(visible.counts.bookings,'booking'):visible.evidence==='calls'?pluralise(visible.counts.calls,'run'):pluralise(visible.counts.measurements,'measured wait')}.{visible.evidence==='calls'&&(visible.kind==='booking'||visible.kind==='resource')&&' Shows only calls clearly made during this booking.'}</p>}
      <Table aria-label="Selected resource evidence" onKeyDown={resourceRowKeys}><thead><TableRow>{(visible.evidence==='ownership'?['Holder','Started','Duration','Released']:visible.evidence==='calls'?['Run','Reserved','Measured','When']:['Unit or job','Ended','Waited','Reasons']).map((t,i)=><TableHead key={t} className={(visible.evidence==='ownership'&&i===2)||(visible.evidence==='calls'&&i===1)||(visible.evidence==='measurements'&&i===2)?'number':undefined}>{t}</TableHead>)}</TableRow></thead>
        <tbody>{visible.rows.map(r=>'holder' in r?bookingRow(r):'reservedCpu' in r?callRow(r):waitRow(r))}</tbody></Table>
      {!visible.rows.length&&<p>{visible.evidence==='ownership'?'No bookings are recorded for this resource.':visible.evidence==='calls'?'No runs are recorded during this booking.':'None in this window.'}</p>}
      <DetailContinuations arc={arc} path={`resources/details/${encodeURIComponent(id)}`} detail={visible} reload={()=>navigate(null,true)} update={value=>{setExpanded(value);store?.ui.set(`detail:${path}`,value);store?.trimUi();}}/>
      {(visible.page.previous||visible.page.next)&&<nav className="pagination" aria-label="Resource evidence pages"><Button disabled={!visible.page.previous} onClick={()=>navigate(visible.page.previous)}>Previous evidence</Button><span>Showing {visible.page.returned} of {visible.page.matching}</span><Button disabled={!visible.page.next} onClick={()=>navigate(visible.page.next)}>Next evidence</Button></nav>}
      {visible.subject&&<p><a href={`${link(arc,'timeline').split('?')[0]}?${new URLSearchParams({...(visible.scope.from?{from:visible.scope.from}:{}),...(visible.scope.to?{to:visible.scope.to}:{}),...(visible.subject.unitRef?{unit:visible.subject.unitRef}:{})})}`}>View this window in Timeline</a></p>}
    </>}
  </Drawer>;
}
