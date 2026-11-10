import { useContext, useRef } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { Drawer } from './drawer.tsx';
import { Views, useSelectedDetail } from './view-state.ts';
import { displayZone, elapsed, formatInstant, link, loadError, pluralise, route, zoneLabel } from './shared.tsx';
import { activateRow, useLatestWindow } from './plain-query.tsx';
import { Spend, EffortFigures, Hint, countingHelp, coverageText } from './effort.tsx';
import { series, waitingHelp } from './effort-chart.tsx';
import { reasonWords, roleWords, stageWords } from '../../src/console/vocabulary.ts';
import type { EffortScopeView } from '../../src/console/effort-protocol.ts';
export function EffortScopeDetail({arc,id,close}:{arc:string;id:string;close:()=>void}) {
  const table=useRef<HTMLTableElement>(null),store=useContext(Views),current=route(),params=new URLSearchParams(current.query),latest=useLatestWindow();
  for(const key of ['cursor','detailSection','detailCursor'])params.delete(key);
  // The drawer reads the page's own window: the page's default is the 24 hours ending at the last recorded event, not the server's.
  const explicit=params.has('window')||params.has('from')||params.has('to');
  if(!explicit&&latest)for(const [key,value] of Object.entries(latest))params.set(key,value);
  if(!params.has('zone'))params.set('zone',displayZone());
  params.set('section',current.query.get('detailSection')??'subjects');params.set('limit','25');
  if(current.query.has('detailCursor'))params.set('cursor',current.query.get('detailCursor')!);
  const path=`resources/details/${encodeURIComponent(id)}?${params}`,state=useSelectedDetail(arc,store?.metadata&&(explicit||latest)?path:null),data=state.data as EffortScopeView|null;
  const zone=current.query.get('zone')??displayZone();
  const time=(at:string)=>formatInstant(at,zone);
  const navigate=(section:string,cursor:string|null=null,fresh=false)=>{if(fresh){const read=new URLSearchParams(params);read.set('section',section);read.delete('cursor');void store?.load(`resources/details/${encodeURIComponent(id)}?${read}`,true);}const q=new URLSearchParams(current.query);q.set('detailSection',section);if(cursor)q.set('detailCursor',cursor);else q.delete('detailCursor');location.hash=`${link(arc,current.tab,'scopes',id).split('?')[0]}?${q}`;};
  function filterLink(){if(!data)return '#';const q=new URLSearchParams(current.query);for(const k of ['cursor','detailSection','detailCursor','role','systemSet','subject'])q.delete(k);q.set('group','unit');for(const [k,v] of Object.entries(data.filter))if(v!==null)q.set(k,v);return `${link(arc,'effort').split('?')[0]}?${q}`;}
  const kind=(r:{kind:'work'|'money'|'waiting'})=>r.kind==='work'?'Run finished':r.kind==='money'?'Charge':'Wait ended';
  return <Drawer title="Effort group" close={close} className="effort-scope-drawer">
    {state.error&&<div role="alert"><p>{loadError(state.error)}</p><Button onClick={()=>navigate(current.query.get('detailSection')??'subjects',null,true)}>Retry</Button></div>}
    {!data?<p role="status">Loading…</p>:<>
      {data.viewVersion!==store?.metadata?.viewVersions.effort&&<p>Updates available. <Button onClick={()=>navigate(data.section,null,true)}>Show updates</Button></p>}
      <h3>{data.group==='role'&&data.filter.role!==null&&data.filter.role!=='unattributed'?roleWords(data.filter.role):data.label}</h3><p className="muted">Finished {data.scope.from?`between ${time(data.scope.from)} and ${data.scope.to?time(data.scope.to):'now'}`:`up to ${data.scope.to?time(data.scope.to):'now'}`} ({zoneLabel(zone)}). Updated {time(data.page.asOf.observedAt)}.</p>
      <EffortFigures v={data.totals}/><p className="muted">{coverageText(data.totals)}</p>
      {(data.filter.role!==null||data.filter.systemSet!==null||data.filter.subject!==null)&&<p><a href={filterLink()}>Filter All units to this group</a></p>}
      <nav className="activity-subviews" aria-label="Effort group detail">{(['subjects','measurements'] as const).map(section=><Button key={section} aria-pressed={data.section===section} onClick={()=>navigate(section)}>{section==='subjects'?'Units and jobs':'Each run, charge and wait'} ({data.counts[section]})</Button>)}</nav>
      <Hint label="How these are counted"><p>{countingHelp}</p><p>A charge for work an agent handed to a helper is not counted again.</p><p>{waitingHelp}</p></Hint>
      <Table ref={table} aria-label="Effort scope contributions" onKeyDown={ev=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(ev.key))return;const links=[...table.current?.querySelectorAll<HTMLAnchorElement>('.scope-primary-link')??[]],n=links.indexOf(document.activeElement as HTMLAnchorElement);if(n<0)return;ev.preventDefault();links[ev.key==='Home'?0:ev.key==='End'?links.length-1:Math.max(0,Math.min(links.length-1,n+(ev.key==='ArrowDown'?1:-1)))]?.focus();}}><thead><TableRow><TableHead>{data.section==='subjects'?'Unit or job':'What finished'}</TableHead><TableHead>Figures</TableHead></TableRow></thead><tbody>{data.rows.map(r=><TableRow key={r.id} onClick={ev=>activateRow(ev,'invocation' in r&&r.invocation?link(arc,current.tab,'invocations',r.invocation):r.unitRef?link(arc,current.tab,'units',r.unitRef):null)}><td style={{minWidth:180,width:'40%'}}>{r.unitRef?<a className={'invocation' in r&&r.invocation?undefined:'scope-primary-link'} href={link(arc,current.tab,'units',r.unitRef)}>{r.subject.id} {r.subject.title}</a>:<span>{r.subject.type==='arc'?'Arc-wide':r.subject.type==='job'?`Job ${r.subject.id}`:`Unit ${r.subject.id} (not in the current plan)`}</span>}{'kind' in r&&<><span className="cell-line">{kind(r)} <time dateTime={r.at} title={r.at}>{time(r.at)}</time></span><span className="cell-line">{r.stage?stageWords(r.stage):'No stage recorded'}, {r.role?`${roleWords(r.role)} role`:'role not recorded'}</span>{r.invocation&&<a className="scope-primary-link" href={link(arc,current.tab,'invocations',r.invocation)}>Open run {r.invocation}</a>}</>}</td><td>{'kind' in r&&r.kind==='money'?<p>Spend <Spend value={r.spend}/></p>:'kind' in r&&r.kind==='work'?<p>{r.agentMs!==null?`Agent work ${elapsed(r.agentMs)}`:r.commandMs!==null?`Commands and checks ${elapsed(r.commandMs)}`:'Not timed'}</p>:'waiting' in r&&r.waiting?<><p>Waited {elapsed(r.waiting.totalMs)} ({series.waiting.find(s=>(s.value(r)??0)>0)?.label.toLowerCase()??'no length'})</p><ul>{r.waiting.reasons.map(reason=><li key={reason.reason}>{reasonWords(reason.reason)}: {elapsed(reason.ms)}</li>)}</ul></>:<><EffortFigures v={r}/>{'contributionCount' in r&&<p className="muted">{pluralise(r.contributionCount,'item')} finished in this window</p>}</>}</td></TableRow>)}</tbody></Table>
      {!data.rows.length&&<p>Nothing finished in this window.</p>}
      <nav className="pagination" aria-label="Effort group pages"><Button disabled={!data.page.previous} onClick={()=>navigate(data.section,data.page.previous)}>Previous page</Button><span>Showing {data.page.returned} of {data.page.matching}</span><Button disabled={!data.page.next} onClick={()=>navigate(data.section,data.page.next)}>Next page</Button></nav>
    </>}
  </Drawer>;
}
