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
export function Attention({e}:{e:Envelope}) {const rows=[...e.data.console.attention].sort((a,b)=>Number(b.blocking)-Number(a.blocking));return <Panel title="Attention" subtitle={`${rows.length} open human requests`}>{!rows.length&&<p>Nothing needs a human response.</p>}{rows.map(r=><article key={r.id} className="attention-item"><h3>{r.summary}</h3><p>{r.blocking?'Blocking: Waiting for a human':'Nonblocking: For your information'}</p>{r.subject.type==='unit'&&<a href={link(e.arc,route().tab,'units',r.subject.unit)}>Affected unit: {r.subject.unit}</a>}<div className="owner-notice"><p><strong>Recommendation: </strong>{r.recommendation.split(' After reviewing')[0]}</p>{r.recommendation.includes(' After reviewing')&&<p>After reviewing{r.recommendation.split(' After reviewing').slice(1).join(' After reviewing')}</p>}</div>{r.options.map(o=><p key={o.id}>{o.label} <code>roadmap ack {r.id} --choice {o.id}</code></p>)}{!r.options.length&&<p>To respond in your terminal: <code>roadmap ack {r.id}</code></p>}{r.evidence.map((path,i)=><p key={i}>{r.evidenceLinks[i]?<a href={link(e.arc,route().tab,'invocations',r.evidenceLinks[i]!)}>Evidence: {path.split('/').slice(-2).join('/')}</a>:<code>{path}</code>}</p>)}</article>)}</Panel>;}
