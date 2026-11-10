// Effort: what finished in the selected window (chart and totals), then every unit with its whole-arc figures.
import { useContext, useRef, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { Clock, displayZone, elapsed, formatInstant, link, money, pluralise, route, SignalMark, zoneLabel } from './shared.tsx';
import { Views } from './view-state.ts';
import { usePlainQuery, PlainPageStatus, PlainPaging, activateRow, CustomRange, FacetSelect, FilterBar, ignoredFilters, useLatestWindow, WindowSelect } from './plain-query.tsx';
import { EffortChart, figure, series, waitingHelp, type EffortMetric } from './effort-chart.tsx';
import type { EffortView, EffortTotals, EffortUnit } from '../../src/console/effort-protocol.ts';
import type { EffortSort, Money } from '../../src/console/view-protocol.ts';
import { roleWords, stateChoices, stateWords, stageWords } from '../../src/console/vocabulary.ts';
/** The unit states the Effort filter accepts, in the order a unit moves through them. */
const unitStates=['preparing','ready','waiting','awaiting-admission','blocked','held','parked','running','merged','cut','superseded'];
const fields=['window','from','to','zone','unit','milestone','system','state','blocked','q','sort','direction','metric','group','role','systemSet','subject','cursor','limit'] as const;
/** `absent` names a known absence (a window with no charge); a charge that went unrecorded is always "Not recorded". */
export function Spend({value,absent='Not recorded'}:{value:Money;absent?:string}) {return <>{value.costUsd===null?value.unavailable>0?'Not recorded':absent:money(value.costUsd)}{value.estimated>0&&<small className="cell-line">{value.estimated} estimated</small>}{value.unavailable>0&&<small className="cell-line">{value.unavailable} not recorded</small>}</>;}
/** A short note on how a figure is counted, opened on demand rather than printed beside it. */
export function Hint({label,children}:{label:string;children:ReactNode}) {return <details className="hint"><summary aria-label={label} title={label}>?</summary><div className="hint-body">{children}</div></details>;}
export const countingHelp='Each run counts in full at the time it finished, even if it started earlier. Spend counts when it was charged, and a wait when it ended.';
/** What the figures are based on, one fact per sentence, naming only what is missing. */
export function coverageText(v:EffortTotals) {
  const c=v.coverage,parts:string[]=[];
  if(!c.execution.measured&&!c.execution.unmeasured&&!c.money.recorded&&!c.money.estimated&&!c.money.unavailable&&!c.waiting.measured)return 'Nothing finished in this window.';
  parts.push(`Based on ${pluralise(c.execution.measured,'timed run')} and ${pluralise(c.waiting.measured,'measured wait')}.`);
  if(c.execution.unmeasured)parts.push(`${pluralise(c.execution.unmeasured,'run')} ${c.execution.unmeasured===1?"wasn't":"weren't"} timed.`);
  if(c.money.estimated)parts.push(`${pluralise(c.money.estimated,'cost')} ${c.money.estimated===1?'is an estimate':'are estimates'}.`);
  if(c.money.unavailable)parts.push(`${pluralise(c.money.unavailable,'cost')} ${c.money.unavailable===1?"wasn't":"weren't"} recorded.`);
  if(c.waiting.unmeasuredReservations)parts.push(`Across the whole arc, ${pluralise(c.waiting.unmeasuredReservations,'wait')} ${c.waiting.unmeasuredReservations===1?'has':'have'} no recorded length.`);
  return parts.join(' ');
}
/** The window's figures as labelled values. */
export function EffortFigures({v}:{v:EffortTotals}) {
  return <dl className="effort-figures">{(['work','waiting','spend'] as EffortMetric[]).flatMap(metric=>series[metric].map(s=><div key={s.key}><dt>{s.label}</dt><dd>{metric==='spend'?<Spend value={v.spend} absent="None in this window"/>:figure(metric,s,v)}</dd></div>))}</dl>;
}
const work=(u:EffortTotals)=>u.agentMs===null&&u.commandMs===null?null:(u.agentMs??0)+(u.commandMs??0);
/** A row with no finished runs at all has nothing to measure: that is known absence, not missing data. */
const noRuns=(u:EffortTotals)=>!u.coverage.execution.measured&&!u.coverage.execution.unmeasured;
function workCell(u:EffortTotals) {
  const total=work(u),c=u.coverage.execution;
  if(total===null)return <>Not recorded<small className="cell-line">{pluralise(c.unmeasured,'run')} not timed</small></>;
  return <>{elapsed(total)}{c.unmeasured>0&&<small className="cell-line">{c.unmeasured} not timed</small>}</>;
}
const groupWords:Record<EffortUnit['subject']['type'],string>={unit:'unit',job:'job',arc:'arc-wide total',role:'role','system-set':'system group',unattributed:'other group'};
function countLine(counts:EffortView['rowCounts']) {
  const parts=(Object.keys(groupWords) as (keyof typeof groupWords)[]).filter(k=>counts[k]).map(k=>pluralise(counts[k],groupWords[k]));
  return parts.length?parts.length===1?parts[0]!:`${parts.slice(0,-1).join(', ')} and ${parts.at(-1)}`:'No rows';
}
function rowLabel(u:EffortUnit,group:EffortView['filters']['group']) {
  const t=u.subject.type;
  if(t==='unit')return {id:u.subject.id,title:u.subject.title};
  if(t==='arc')return {id:'Arc-wide',title:'Work not tied to a unit or job'};
  if(t==='job')return {id:'Job',title:group==='unit'?u.subject.id:u.subject.title.replace(/^Job /,'')};
  return {id:t==='role'?'Role':t==='system-set'?'Systems':'Other',title:t==='role'?roleWords(u.subject.title):u.subject.title};
}
export function Effort({arc}:{arc:string}) {
  const current=route(),zone=current.query.get('zone')??displayZone(),explicit=current.query.has('window')||current.query.has('from')||current.query.has('to'),latest=useLatestWindow();
  const state=usePlainQuery<EffortView>(arc,'effort',fields,explicit?{zone}:latest?{...latest,zone}:null);
  const store=useContext(Views),previous=useRef<{generation:number;data:EffortView}|null>(null);
  if(state.data)previous.current={generation:store?.generation??0,data:state.data};
  const h=state.data??(previous.current?.generation===(store?.generation??0)?previous.current.data:null);
  const clock=useContext(Clock),table=useRef<HTMLTableElement>(null),end=h?.bounds.terminalAt?Date.parse(h.bounds.terminalAt):clock;
  let safeZone=zone;try{new Intl.DateTimeFormat('en',{timeZone:safeZone});}catch{safeZone='UTC';}
  const short=(at:string)=>formatInstant(at,safeZone,true);
  const reload=()=>state.navigate({cursor:null},true);
  const openWindow=(from:string,to:string)=>state.navigate({window:null,from,to},true);
  function shift(delta:number){if(!h?.scope.from||!h.scope.to)return;const a=Date.parse(h.scope.from),b=Date.parse(h.scope.to),span=b-a;openWindow(new Date(a+delta*span).toISOString(),new Date(b+delta*span).toISOString());}
  const sort=(key:EffortSort)=>state.navigate({sort:key,direction:state.params.get('sort')===key&&state.params.get('direction')!=='asc'?'asc':'desc'});
  const header=(key:EffortSort,label:string,help?:string)=><TableHead className="number" aria-sort={h?.filters.sort===key?(h.filters.direction==='desc'?'descending':'ascending'):'none'} title={help}><button aria-label={`Sort by ${label.toLowerCase()}`} onClick={()=>sort(key)}>{label}</button></TableHead>;
  function move(ev:React.KeyboardEvent<HTMLTableElement>){if(!['ArrowDown','ArrowUp','Home','End'].includes(ev.key)||(ev.target as HTMLElement).closest('button,input,select'))return;const links=[...table.current?.querySelectorAll<HTMLAnchorElement>('tbody .effort-unit-link')??[]],n=links.indexOf(document.activeElement as HTMLAnchorElement);if(n<0)return;ev.preventDefault();links[ev.key==='Home'?0:ev.key==='End'?links.length-1:Math.max(0,Math.min(links.length-1,n+(ev.key==='ArrowDown'?1:-1)))]?.focus();}
  const metric=h?.filters.metric??'work',units=h?.filters.group==='unit';
  const windowColumns=metric==='spend'?1:3;
  return <section className="panel effort"><header className="panel-head"><div><h2>Effort</h2><p className="muted">Work finished and time spent waiting.</p></div></header>
    <FilterBar label="Effort" ignored={ignoredFilters(current.query,state.facets,{unit:"unit",milestone:"milestone",system:"system"})} resetKey={state.path} search={state.params.get('q')??''} searchHelp="Find a unit by id or title." dirty={fields.some(k=>current.query.has(k))} activeFilters={['unit','milestone','system','state','from','to'].filter(k=>current.query.get(k)).length} apply={values=>{const next:Record<string,string|null>={};for(const key of ['unit','milestone','system','state','q','limit','from','to'])next[key]=String(values.get(key)??'')||null;if(next['from']||next['to'])next['window']=null;state.navigate(next);}} reset={()=>state.navigate(Object.fromEntries(fields.map(k=>[k,null])),true)}
      window={<WindowSelect label="Effort time window" query={current.query} navigate={state.navigate} latest={latest}/>}
      extra={<>
        <select aria-label="Effort window metrics" className="filter-window" value={state.params.get('metric')??'work'} onChange={ev=>state.navigate({metric:ev.target.value})}><option value="work">Show work</option><option value="waiting">Show waiting</option><option value="spend">Show spend</option></select>
        <select aria-label="Effort group" className="filter-window" value={state.params.get('group')??'unit'} onChange={ev=>state.navigate({group:ev.target.value,sort:'plan',direction:null})}><option value="unit">Group by unit</option><option value="role">Group by role</option><option value="system-set">Group by systems</option></select>
      </>}>
      <CustomRange from={state.params.get('from')} to={state.params.get('to')}/>
      <div className="filter-row"><Button type="button" onClick={()=>state.navigate({window:'arc',from:null,to:null},true)}>Whole arc</Button><Button type="button" disabled={!h?.scope.from||!h.scope.to} onClick={()=>shift(-1)}>Previous window</Button><Button type="button" disabled={!h?.scope.from||!h.scope.to} onClick={()=>shift(1)}>Next window</Button><Button type="button" onClick={()=>state.navigate({window:state.params.get('window')==='7d'?'7d':'24h',from:null,to:null},true)}>{h?.bounds.terminalAt?'Arc end':'Now'}</Button></div>
      <div className="filter-grid">{(['unit','milestone','system'] as const).map(key=><FacetSelect key={key} name={key} label={key[0]!.toUpperCase()+key.slice(1)} all={`All ${key==='system'?'systems':`${key}s`}`} values={state.facets?.[key]??null} value={current.query.get(key)??''}/>)}
      <label>Unit state<select name="state" defaultValue={state.params.get('state')??''}><option value="">Any state</option>{stateChoices(unitStates).map(c=><option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
      <label>Rows per page<select name="limit" defaultValue={state.params.get('limit')??'50'}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label></div>
    </FilterBar>
    <PlainPageStatus {...state} data={h} reload={reload} version="effort" noun="unit" count={h?`${countLine(h.rowCounts)}${h.filters.sort==='plan'&&h.rowCounts.job>0&&h.rowCounts.unit>0?'. Jobs are listed after the units':''}`:undefined}/>
    {h&&<>
      <section className="effort-window" aria-labelledby="effort-window-title">
        <div className="effort-window-head"><h3 id="effort-window-title">Finished {h.scope.from?<>between {short(h.scope.from)} and {short(h.scope.to??h.bounds.to)}</>:<>up to {short(h.scope.to??h.bounds.to)}</>} <span className="muted">{zoneLabel(safeZone)}</span></h3><Hint label="How these are counted"><p>{countingHelp}</p><p>{waitingHelp}</p></Hint></div>
        <EffortFigures v={h.totals}/>
        <p className="muted effort-coverage">{coverageText(h.totals)}</p>
        <EffortChart h={h} metric={metric} open={openWindow} time={short}/>
        {h.buckets.length>0&&<details className="effort-buckets"><summary>Chart as a table ({pluralise(h.buckets.length,'time slice')} with something finished)</summary><Table aria-label="Effort completion buckets"><thead><TableRow><TableHead>Finished between</TableHead>{(['work','waiting'] as EffortMetric[]).flatMap(m=>series[m].map(s=><TableHead key={s.key} className="number">{s.label}</TableHead>))}<TableHead className="number">Spend</TableHead><TableHead className="col-coverage">Based on</TableHead></TableRow></thead><tbody>{h.buckets.map(b=><TableRow key={b.from}><td><Button variant="ghost" onClick={()=>openWindow(b.from,b.to)}>{short(b.from)} to {short(b.to)}</Button></td>{(['work','waiting'] as EffortMetric[]).flatMap(m=>series[m].map(s=><td className="number" key={s.key}>{figure(m,s,b)}</td>))}<td className="number"><Spend value={b.spend}/></td><td className="col-coverage">{coverageText(b)}</td></TableRow>)}</tbody></Table></details>}
      </section>
      <header className="effort-table-head"><div><h2>{units?'All units':h.filters.group==='role'?'By role':'By systems'}</h2>
        <p className="muted">{units?'Every unit, in plan order unless you sort or filter.':h.filters.group==='role'?'Each finished run, charge and wait counts once, under the role that did it.':'Units with exactly the same systems share a row, so nothing counts twice.'} {metric==='spend'?'Spend in window':metric==='waiting'?'Waiting':'Work'} covers the selected window. The other columns cover the whole arc.</p></div>
        <div className="effort-table-actions"><Button aria-pressed={h.filters.blocked==='1'} onClick={()=>state.navigate({blocked:h.filters.blocked==='1'?null:'1'})}>Blocked units only</Button><Button onClick={reload} title="Re-read the figures and re-sort the table">Update order</Button></div>
      </header>
      {(h.filters.role.length>0||h.filters.systemSet.length>0||h.filters.subject.length>0)&&<p>Showing only {[...h.filters.role.map(r=>r==='unattributed'?'work with no recorded role':`work by the ${roleWords(r)} role`),...(h.filters.systemSet.length?[`units with systems ${[...new Set(h.rows.flatMap(r=>r.systems))].join(', ')||'none recorded'}`]:[]),...(h.filters.subject.length?[pluralise(h.filters.subject.length,'selected row')]:[])].join(' and ')}. <Button variant="ghost" onClick={()=>state.navigate({role:null,systemSet:null,subject:null})}>Show all</Button></p>}
      {!h.rows.length&&<p>No unit matches these filters. Reset view to show all units.</p>}
      <Table ref={table} aria-label="All units" className="effort-table" onKeyDown={move}><thead>
        <TableRow className="effort-group-head"><TableHead colSpan={units?3:1}>{units?'Now':''}</TableHead><TableHead colSpan={units?4:1}>Whole arc</TableHead><TableHead colSpan={windowColumns}>Selected window</TableHead></TableRow>
        <TableRow><TableHead>{units?'Unit':'Group'}</TableHead>{units&&<><TableHead className="col-state">State</TableHead><TableHead>Blocked by</TableHead></>}
          {units&&<>{header('elapsed','Total time','From the first step to the last, or to now while the unit is still going')}{header('redChecks','Failed checks','Commands and checks that failed, over the whole arc')}{header('rounds','Build rounds','A new round starts each time the unit is built again')}</>}
          <TableHead className="number">Spend</TableHead>
          {metric==='work'?<>{header('work','Work')}<TableHead className="number">Agent work</TableHead><TableHead className="number">Commands and checks</TableHead></>:metric==='spend'?header('spend','Spend in window'):<>{header('held','On hold')}{header('queued','Waiting its turn')}<TableHead className="number" title={waitingHelp}>Mixed reasons</TableHead></>}
        </TableRow></thead>
        <tbody>{h.rows.map(u=>{const href=u.subject.type==='unit'&&u.state!==null?link(arc,'effort','units',u.subject.id):u.detailKey?link(arc,'effort','scopes',u.detailKey):null,label=rowLabel(u,h.filters.group);return <TableRow key={u.id} onClick={ev=>activateRow(ev,href)}>
          <td className="unit-identity">{href?<a className="effort-unit-link" href={href} title={`${label.id}: ${label.title}`}><strong>{label.id}</strong><span>{label.title}{u.titleTruncated?'… Open full title':''}</span></a>:<><strong>{label.id}</strong><span>{label.title}</span></>}{!units&&<span className="cell-line">{pluralise(u.contributorCount,'item')} finished in this window</span>}</td>
          {units&&<><td className="col-state">{u.state?<>{u.signal&&<SignalMark state={u.signal}/>} {stateWords(u.state)}{u.stage&&<span className="cell-line">{u.stageFinished&&u.state!=='running'?`Finished: ${stageWords(u.stage)}`:stageWords(u.stage)}</span>}</>:'Not applicable'}</td>
          <td className="unit-blockers">{u.blockers.count?<><ul>{u.blockers.reasons.map((r,n)=><li key={n}>{r.text}{r.truncated&&href&&<a href={href}> Open full reason</a>}</li>)}</ul>{u.blockers.count>u.blockers.reasons.length&&href&&<a href={href}>More reasons ({u.blockers.count-u.blockers.reasons.length})</a>}<span className="cell-line">{u.blockers.waitSince?`Waiting ${elapsed(Math.max(0,end-Date.parse(u.blockers.waitSince)))}`:'Waiting since: not recorded'}</span></>:u.state?'Not blocked':'Not applicable'}</td></>}
          {units&&<><td className="number" title={u.lifetime.elapsedMs===null?'Not recorded':`${u.lifetime.elapsedMs} ms`}>{u.state===null?'Not applicable':elapsed(u.lifetime.elapsedMs)}</td><td className="number">{u.lifetime.redChecks??'Not applicable'}</td><td className="number">{u.lifetime.rounds??'Not applicable'}</td></>}<td className="number"><Spend value={u.lifetime.spend}/></td>
          {metric==='work'?noRuns(u)?<td className="number" colSpan={3}>None in this window</td>:<><td className="number" title={pluralise(u.coverage.execution.measured,'timed run')}>{workCell(u)}</td>{series.work.map(s=><td className="number" key={s.key}>{figure('work',s,u)}</td>)}</>:metric==='spend'?<td className="number"><Spend value={u.spend}/></td>:series.waiting.map(s=><td className="number" key={s.key} title={pluralise(u.coverage.waiting.measured,'measured wait')}>{figure('waiting',s,u)}</td>)}
        </TableRow>;})}</tbody></Table>
      <PlainPaging page={h.page} navigate={state.navigate}/>
      <p className="muted">Not tied to any unit, in this window: agent work {figure('work',series.work[0]!,h.attribution.arcJob).toLowerCase()}, commands and checks {figure('work',series.work[1]!,h.attribution.arcJob).toLowerCase()}, spend {figure('spend',series.spend[0]!,h.attribution.arcJob).toLowerCase()}.</p>
    </>}
  </section>;
}
