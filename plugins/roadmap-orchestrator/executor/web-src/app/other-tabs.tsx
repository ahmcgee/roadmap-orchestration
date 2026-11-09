import { useContext, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { Clock, elapsed, link, route, SignalMark, Time } from './shared.tsx';
import { useRouteState } from './view-state.ts';
import type { Envelope } from './types.ts';
import { AllUnits } from './effort.tsx';
export { Activity } from './activity.tsx';
export { Resources } from './resources.tsx';
function Panel({title,children,subtitle}:{title:string;children:ReactNode;subtitle?:string}) { return <section className="panel"><header><h2>{title}</h2>{subtitle&&<p className="muted">{subtitle}</p>}</header>{children}</section>; }
export function Effort({e}:{e:Envelope}) {
  const m=e.data.console;
  return <><AllUnits e={e}/><Panel title="Recorded effort" subtitle="Completed work and recorded waiting; not wall-time coverage">
    <Table aria-label="Recorded effort"><thead><TableRow>{['Unit / scope','Agent','Commands/checks','Held','Queued'].map((t,i)=><TableHead key={t} className={i?'number':undefined}>{t}</TableHead>)}</TableRow></thead><tbody>{m.time.rows.map(row=>{const unit=m.presentation.units.find(u=>u.id===row.id);return <TableRow key={row.id}><td>{unit?<a href={link(e.arc,route().tab,'units',row.id)}>{unit.id} {unit.title}</a>:row.id==='arc'?'Arc work':row.id}</td>{(['agent','deterministic','held','queued'] as const).map(k=><td key={k} className="number">{elapsed(row[k])}</td>)}</TableRow>;})}</tbody></Table>
    <p>Agent {elapsed(m.time.total.agent)}; commands/checks {elapsed(m.time.total.deterministic)}; held {elapsed(m.time.total.held)}; queued {elapsed(m.time.total.queued)}.</p>
    {m.time.unallocated>0&&<p>{elapsed(m.time.unallocated)} waiting has mixed or unallocated categories, counted once.</p>}
  </Panel></>;
}
export { Timeline } from './timeline.tsx';
export { Attention } from './attention.tsx';
