import { useContext, useRef } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { Drawer } from './drawer.tsx';
import { Views, useSelectedDetail } from './view-state.ts';
import { elapsed, link, route } from './shared.tsx';
import { activateRow } from './plain-query.tsx';
import { Spend, Coverage } from './effort.tsx';
import type { EffortScopeView } from '../../src/console/effort-protocol.ts';
export function EffortScopeDetail({arc,id,close}:{arc:string;id:string;close:()=>void}) {
  const table=useRef<HTMLTableElement>(null),store=useContext(Views),current=route(),params=new URLSearchParams(current.query);
  for(const key of ['cursor','detailSection','detailCursor'])params.delete(key);
  params.set('section',current.query.get('detailSection')??'subjects');params.set('limit','25');
  if(current.query.has('detailCursor'))params.set('cursor',current.query.get('detailCursor')!);
  const path=`resources/details/${encodeURIComponent(id)}?${params}`,state=useSelectedDetail(arc,store?.metadata?path:null),data=state.data as EffortScopeView|null;
  let zone=current.query.get('zone')??Intl.DateTimeFormat().resolvedOptions().timeZone;try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{zone='UTC';}
  const time=(at:string)=>new Date(at).toLocaleString('en-GB',{timeZone:zone});
  const navigate=(section:string,cursor:string|null=null,fresh=false)=>{if(fresh){const read=new URLSearchParams(params);read.set('section',section);read.delete('cursor');void store?.load(`resources/details/${encodeURIComponent(id)}?${read}`,true);}const q=new URLSearchParams(current.query);q.set('detailSection',section);if(cursor)q.set('detailCursor',cursor);else q.delete('detailCursor');location.hash=`${link(arc,current.tab,'scopes',id).split('?')[0]}?${q}`;};
  function filterLink(){if(!data)return '#';const q=new URLSearchParams(current.query);for(const k of ['cursor','detailSection','detailCursor','role','systemSet','subject'])q.delete(k);q.set('group','unit');for(const [k,v] of Object.entries(data.filter))if(v!==null)q.set(k,v);return `${link(arc,'effort').split('?')[0]}?${q}`;}
  return <Drawer title="Effort scope" close={close} className="effort-scope-drawer">
    {state.error&&<div role="alert"><p>{state.error}</p><Button onClick={()=>navigate(current.query.get('detailSection')??'subjects',null,true)}>Reload scope detail</Button></div>}
    {!data?<p>Loading selected scope…</p>:<>
      {data.viewVersion!==store?.metadata?.viewVersions.effort&&<p>Newer scope evidence available. <Button onClick={()=>navigate(data.section,null,true)}>Show current scope</Button></p>}
      <h3>{data.label}</h3><p>Captured at {time(data.page.asOf.observedAt)} ({zone}). {data.scope.from?time(data.scope.from):'Unbounded start'} to {data.scope.to?time(data.scope.to):'Unbounded end'}.</p>
      <p>Agent {elapsed(data.totals.agentMs)}; Commands/checks {elapsed(data.totals.commandMs)}; Held {elapsed(data.totals.heldMs)}; Queued {elapsed(data.totals.queuedMs)}; Unallocated {elapsed(data.totals.unallocatedMs)}. Recorded spend <Spend value={data.totals.spend}/>.</p><p><Coverage v={data.totals}/></p>
      {(data.filter.role!==null||data.filter.systemSet!==null||data.filter.subject!==null)&&<p><a href={filterLink()}>Filter All units to this group</a></p>}
      <nav className="activity-subviews" aria-label="Effort scope evidence">{(['subjects','measurements'] as const).map(section=><Button key={section} aria-pressed={data.section===section} onClick={()=>navigate(section)}>{section==='subjects'?'Units and job scopes':'Exact contributions'} ({data.counts[section]})</Button>)}</nav>
      <p>Work uses invocation completion; money uses the enclosing charge timestamp; waiting uses the completed measurement timestamp. Delegated/session annotations are not additional charges. Waiting reasons may overlap and are not added to each other.</p>
      <Table ref={table} aria-label="Effort scope contributions" onKeyDown={ev=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(ev.key))return;const links=[...table.current?.querySelectorAll<HTMLAnchorElement>('.scope-primary-link')??[]],n=links.indexOf(document.activeElement as HTMLAnchorElement);if(n<0)return;ev.preventDefault();links[ev.key==='Home'?0:ev.key==='End'?links.length-1:Math.max(0,Math.min(links.length-1,n+(ev.key==='ArrowDown'?1:-1)))]?.focus();}}><thead><TableRow><TableHead>Recorded subject / evidence</TableHead><TableHead>Measurements</TableHead></TableRow></thead><tbody>{data.rows.map(r=><TableRow key={r.id} onClick={ev=>activateRow(ev,'invocation' in r&&r.invocation?link(arc,current.tab,'invocations',r.invocation):r.unitRef?link(arc,current.tab,'units',r.unitRef):null)}><td style={{minWidth:180,width:'40%'}}>{r.unitRef?<a className={'invocation' in r&&r.invocation?undefined:'scope-primary-link'} href={link(arc,current.tab,'units',r.unitRef)}>{r.subject.id} {r.subject.title}</a>:<span>{r.subject.type==='arc'?'Arc':r.subject.type==='job'?`Job ${r.subject.id}`:`Unit ${r.subject.id} (outside applied plan)`}</span>}{'kind' in r&&<><span className="cell-line">{r.kind} at <time dateTime={r.at} title={r.at}>{time(r.at)} ({zone})</time></span><span className="cell-line">{r.stage??'No stage recorded'}; role {r.role??'not recorded'}</span>{r.invocation&&<a className="scope-primary-link" href={link(arc,current.tab,'invocations',r.invocation)}>Invocation {r.invocation}</a>}</>}</td><td><p>Agent {elapsed(r.agentMs)}; Commands/checks {elapsed(r.commandMs)}; Held {elapsed(r.heldMs)}; Queued {elapsed(r.queuedMs)}; Unallocated {elapsed(r.unallocatedMs)}; spend <Spend value={r.spend}/>.</p>{'waiting' in r&&r.waiting&&<><p>{r.waiting.source}; total {r.waiting.totalMs} ms</p><ul>{r.waiting.reasons.map(reason=><li key={reason.reason}>{reason.reason}: {reason.ms} ms</li>)}</ul></>}{'contributionCount' in r&&<p>{r.contributionCount} completed contributions</p>}<Coverage v={r}/></td></TableRow>)}</tbody></Table>
      {!data.rows.length&&<p>No completed contributions in this window.</p>}
      <nav className="pagination" aria-label="Scope evidence pages"><Button disabled={!data.page.previous} onClick={()=>navigate(data.section,data.page.previous)}>Previous evidence</Button><span>{data.page.returned} of {data.page.matching}</span><Button disabled={!data.page.next} onClick={()=>navigate(data.section,data.page.next)}>Next evidence</Button></nav>
    </>}
  </Drawer>;
}
