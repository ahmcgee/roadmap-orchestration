import { useContext, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { Clock, elapsed, link, pluralise, route, stageName } from './shared.tsx';
import { useRouteState } from './view-state.ts';
import type { Envelope } from './types.ts';

const cores = (n:number|null) => n === null ? 'unrecorded' : Number(n.toFixed(2)).toString();
export function Resources({e}:{e:Envelope}) {
  const m=e.data.console,p=m.presentation,now=useContext(Clock),[all,setAll]=useRouteState('resources.whole',false);
  const end=m.resources.endAt?m.resources.now:Math.max(m.resources.now,(now-m.resources.origin)/1000);
  const slots=m.resources.bookings.filter(b=>b.resource==='integration-slot'&&b.state==='holding');
  const queue=m.resources.queue.filter(q=>q.request.publication);
  const measured=m.cpuGroups.filter(g=>g.parent.type==='stage'&&g.reservationPercent!==null);
  const under=measured.filter(g=>g.reservationPercent!<10).length;
  const identity=(id:string)=><a href={link(e.arc,route().tab,'units',id)}>{id} {p.units.find(u=>u.id===id)?.title}</a>;
  return <>
    <section className="panel"><header><h2>Integration slot</h2><p>Current holder and scheduler order</p></header>
      {slots.length?<Table aria-label="Integration slot holder"><thead><TableRow><TableHead>Holder</TableHead><TableHead>State</TableHead><TableHead className="number">Held</TableHead></TableRow></thead><tbody>{slots.map(b=><TableRow key={b.id}><td>{b.unitId?identity(b.unitId):b.label}</td><td>holds the integration slot</td><td className="number">{elapsed(Math.round((end-b.from)*1000))}</td></TableRow>)}</tbody></Table>:<p>No current integration holder recorded.</p>}
      <Table aria-label="Integration slot queue"><thead><TableRow><TableHead>Queue position</TableHead><TableHead>Waiter</TableHead><TableHead className="number">Waiting</TableHead></TableRow></thead><tbody>{queue.map((q,i)=><TableRow key={q.label}><td>{i+1}</td><td>{q.unit?identity(q.unit):q.label}</td><td className="number">{q.queuedAt===undefined?'Wait start not recorded':elapsed(Math.max(0,Math.round(m.resources.origin+end*1000-q.queuedAt)))}</td></TableRow>)}</tbody></Table>
      {!queue.length&&<p>No integration waiters recorded.</p>}
    </section>
    <section className="panel"><header><h2>Time & resources</h2><p>Partial recorded effort. Recorded work and waiting, not wall-clock time.</p></header>
      <h3>Waiting by reason</h3><p>Reason durations can overlap; do not add them together.</p>
      {Object.keys(p.waitReasons).length?<Table aria-label="Waiting by reason"><thead><TableRow><TableHead>Reason</TableHead><TableHead className="number">Recorded duration</TableHead><TableHead className="number">Count</TableHead></TableRow></thead><tbody>{Object.entries(p.waitReasons).map(([reason,ms])=><TableRow key={reason}><td>{reason}</td><td className="number"><span title={`${ms} ms`}>{elapsed(ms)}</span></td><td className="number">{p.waitReasonCounts[reason]}</td></TableRow>)}</tbody></Table>:<p>No completed waiting measurements.</p>}
      {m.time.unallocated>0&&<p>{elapsed(m.time.unallocated)} waiting has mixed or unallocated categories; counted once.</p>}
      {m.time.unmeasuredReservations>0&&<p>{pluralise(m.time.unmeasuredReservations,'unmeasured reservation')}: duration not recorded</p>}
      {m.resources.unknownQueueStarts>0&&<p>{pluralise(m.resources.unknownQueueStarts,'queue entry','queue entries')} with an unrecorded start.</p>}
      <h3>Resource booking details</h3><Button aria-pressed={all} onClick={()=>setAll(!all)}>{all?'Recent window':'Whole arc'}</Button><p>{m.resources.endAt?`Finished arc, ${elapsed(end*1000)}`:all?'Whole arc':'Last 24 hours'}</p>
      <Table aria-label="Resource bookings"><thead><TableRow>{['Resource / instance','Holder','State','Start after Arc start','Duration'].map(t=><TableHead key={t} className={['Start after Arc start','Duration'].includes(t)?'number':undefined}>{t}</TableHead>)}</TableRow></thead><tbody>{m.resources.bookings.filter(b=>all||b.state!=='done'||(b.to??end)>=end-86400).map(b=><TableRow key={b.id}>
        <td>{b.resource}{b.instance&&<span className="cell-line">{b.instance}</span>}</td><td>{b.unitId?identity(b.unitId):b.label}</td><td>{b.state}</td><td className="number">{elapsed(Math.round(b.from*1000))}</td><td className="number">{elapsed(b.durationMs??Math.round(((b.to??end)-b.from)*1000))}</td>
      </TableRow>)}</tbody></Table>{!m.resources.resources.length&&<p>No named resource bookings.</p>}
    </section>
    <section className="panel"><header><h2>CPU evidence</h2><p>Reserved CPU: {m.tokenOccupancy} of {p.cpuCapacity??'unrecorded'} cores</p><p>Reservation tokens, not measured live usage.</p></header>
      <h3>Current pressure blockers</h3>{p.units.filter(u=>u.reasons.some(r=>/pressure/i.test(r))).map(u=><p key={u.id}>{identity(u.id)}: {u.reasons.filter(r=>/pressure/i.test(r)).join('; ')}</p>)}
      <p>{under} of {pluralise(measured.length,'measured stage')} used under 10% of the cores they reserved.</p>
      <p>Measured cores and reservation percentages use the same matched calls, weighted by execution wall time. Overlapping calls are separate measurements.</p>
      <Table aria-label="CPU evidence"><thead><TableRow>{['Unit / scope','Stage attempt','Measured cores','Weighted reserved cores','Used reservation','Coverage / invocations'].map((t,i)=><TableHead key={t} className={i>=2&&i<=4?'number':undefined}>{t}</TableHead>)}</TableRow></thead><tbody>{m.cpuGroups.map(g=>{
        const unit=g.parent.type==='stage'?g.parent.unit:null;
        const activity=p.activityInfo.find(a=>g.invocations.some(id=>id===a.id));
        const label=g.parent.type==='stage'?stageName(g.parent.stage):activity?.label??'Arc work';
        return <TableRow key={g.id}><td>{unit?identity(unit):g.parent.type==='job'?`Job ${g.parent.job}`:`Arc (${g.parent.type})`}</td><td>{label}<span className="cell-line">Attempt {activity?.attempt??'unrecorded'}</span></td><td className="number">{cores(g.averageCores)}{g.unreservedAverageCores!==null&&<small className="cell-line">{cores(g.unreservedAverageCores)} without a positive reservation</small>}</td><td className="number">{cores(g.reservedCores)}</td><td className="number">{g.reservationPercent===null?'unrecorded':`${Number(g.reservationPercent.toFixed(2))}%`}</td><td>{pluralise(g.measuredCalls,'matched call')}, {g.excludedCalls} excluded<span className="cell-line">{g.unmeasuredCalls} unmeasured; {g.zeroWallCalls} zero-wall samples; {g.unreservedCalls} measured without positive reservation</span><span className="cell-line">Recorded reservations: {[...new Set(g.contributions.map(c=>c.reservedCpu===null?'unrecorded':`${c.reservedCpu} cores`))].join('; ')}</span><span className="cell-line">Basis: {[...new Set(g.contributions.map(c=>c.basis?`${c.basis.kind} ${c.basis.value}`:'unrecorded'))].join('; ')}</span><details open><summary>Contributing invocations</summary>{g.invocations.map(id=>{const a=p.activityInfo.find(a=>a.id===id);return a?<a className="cell-line" key={id} href={link(e.arc,route().tab,'invocations',a.routeId)}>{a.label}, attempt {a.attempt}<span className="cell-line">Reserved cores: {g.contributions.find(c=>c.inv===id)!.reservedCpu??'unrecorded'}; measured run: {elapsed(g.contributions.find(c=>c.inv===id)!.measured?.runMs)}; measured wall: {elapsed(g.contributions.find(c=>c.inv===id)!.measured?.wallMs)}</span></a>:null;})}</details></td></TableRow>;
      })}</tbody></Table>{!m.cpuGroups.length&&<p>No measured CPU reservations.</p>}
    </section>
  </>;
}
