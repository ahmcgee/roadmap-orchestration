// Resources: who holds shared resources now (the Now strip), then the Schedule of recorded bookings on a time axis,
// CPU evidence (measured against reserved cores) and Waiting by reason. Every value is a recorded field.
import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { Clock, displayZone, elapsed, formatInstant, link, pluralise, route, zoneLabel } from './shared.tsx';
import { Views, useView } from './view-state.ts';
import { usePlainQuery, PlainPageStatus, PlainPaging, activateRow, moveRowFocus, CustomRange, FacetSelect, FilterBar, ignoredFilters, useLatestWindow, WindowSelect } from './plain-query.tsx';
import { ContinuesCap, continuesWords, lanes, Overview, tickGrid, ticks } from './time-axis.tsx';
import { Hint } from './effort.tsx';
import type { ResourceView, ResourceSubject, ResourceBooking, ResourceCpu, ResourceCpuCall, ResourceWait, ResourceNow, ResourceNowRow, ResourceReasonsView, ResourceLane, BookingMark } from '../../src/console/resource-protocol.ts';
import type { ShellView } from '../../src/console/view-protocol.ts';
import { closureWords, holdClassWords as classWords, plainWords, reasonWords, stageWords, stateWords } from '../../src/console/vocabulary.ts';
export const resourceFields=['section','window','from','to','zone','resource','unit','stage','state','reason','utilization','q','sort','direction','cursor','limit'] as const;
export const cores=(n:number|null)=>n===null?'Not recorded':Number(n.toFixed(2)).toString();
/** A current resource state, as words. */
export const resourceStateWords=(state:string)=>({reserved:'Reserved',running:'In use',cleaning:'Cleaning','cleanup-failed':'Cleanup failed',free:'Free'}[state]??plainWords(state));
/** CPU reservation tokens read as slots of the CPU pool. */
/** When in the arc: "Day 8, 7d 0h after the arc started". The date is the cell; this is its secondary line. */
export const arcDay=(at:string,start:string)=>{const ms=Math.max(0,Date.parse(at)-Date.parse(start));return `Day ${Math.floor(ms/86400_000)+1}, ${elapsed(ms)} after the arc started`;};
export const resourceName=(r:string)=>r==='integration-slot'?'Integration slot':r==='@cpu'?'CPU':r.startsWith('@cpu#')?`CPU slot ${r.slice(5)}`:r;
/** How a call's CPU reservation was chosen. */
export const basisWords=(b:NonNullable<ResourceCpuCall['basis']>)=>b.kind==='explicit'?'Reservation set in the plan':b.kind==='calibrated'?'Reservation calibrated from earlier runs':b.kind==='default'?'Default reservation':plainWords(b.kind);
/** What CPU figures rest on, one fact per sentence. "Measured calls" are those measured against a reservation. */
export function cpuCoverage(c:{matchedCalls?:number;measuredCalls?:number;unmeasuredCalls:number;zeroWallCalls:number;unreservedCalls:number},always=true) {
  const measured=c.matchedCalls??c.measuredCalls??0,missing=c.unmeasuredCalls+c.zeroWallCalls,parts:string[]=[];
  if(measured||always)parts.push(`Based on ${pluralise(measured,'measured call')}.`);
  if(missing)parts.push(`${pluralise(missing,'call')} couldn't be measured.`);
  if(c.unreservedCalls)parts.push(`${pluralise(c.unreservedCalls,'call')} ${c.unreservedCalls===1?'was':'were'} measured but had no CPU reservation.`);
  return parts.join(' ');
}
const cpuHelp=<><p>Measured cores are run time divided by wall time, over calls that had a CPU reservation.</p><p>Reserved cores are averaged over the same calls, weighted by how long each ran. Used reservation compares the two.</p><p>Calls that overlap in time count separately.</p></>;
const sections={schedule:'Schedule',cpu:'CPU evidence',waiting:'Waiting',now:'Everything current'} as const;
export function Resources({arc}:{arc:string}) {
  const store=useContext(Views),current=route(),section=current.query.get('section')??'schedule',zone=current.query.get('zone')??displayZone(),explicit=section==='now'||current.query.has('window')||current.query.has('from')||current.query.has('to'),latest=useLatestWindow();
  const state=usePlainQuery<ResourceView>(arc,'resources',resourceFields,explicit?{section,zone}:latest?{section,...latest,zone}:null),data=state.data,table=useRef<HTMLTableElement>(null),clock=useContext(Clock);
  const nowPath='resources?section=now&limit=25',changed=!!data&&!!store?.metadata&&data.viewVersion!==store.metadata.viewVersions.resources;
  const freshNow=useView(changed?nowPath:null),nowData=freshNow.data as ResourceView|null;
  useEffect(()=>{if(changed&&store?.metadata&&nowData?.viewVersion!==store.metadata.viewVersions.resources)void store.load(nowPath,true);},[changed,store?.metadata?.viewVersions.resources,nowData?.viewVersion]);
  const reasonParams=new URLSearchParams(state.params);reasonParams.delete('cursor');if(current.query.has('reasonCursor'))reasonParams.set('cursor',current.query.get('reasonCursor')!);
  const browseReasons=current.query.get('reasons')==='1',reasonState=useView(browseReasons&&section==='waiting'?`resources/reasons?${reasonParams}`:null),reasonData=reasonState.data as ResourceReasonsView|null;
  const lifecycle=(store?.entries.get('shell')?.value?.data as ShellView|undefined)?.lifecycle,terminalAt=lifecycle?.endedAt??data?.bounds.terminalAt;
  // A stop also ends the record, but the arc has not finished: it can be resumed.
  const ending=lifecycle?.state==='complete'?'finished':'stopped';
  const now=nowData&&changed?nowData.now:data?.now,nowEnd=terminalAt?Date.parse(terminalAt):clock;
  let timeZone=zone;try{new Intl.DateTimeFormat('en',{timeZone});}catch{timeZone='UTC';}
  const short=(at:string)=>formatInstant(at,timeZone,true);
  const time=(at:string|null)=>at?<ResourceTime at={at}/>:<span>Not recorded</span>;
  const subject=(s:ResourceSubject)=><ResourceIdentity arc={arc} subject={s}/>;
  function select(next:string){const params=new URLSearchParams(store?.ui.get(`resources-query:${next}`) as string|undefined);params.set('section',next);location.hash=`${link(arc,'resources').split('?')[0]}?${params}`;}
  useEffect(()=>{store?.ui.set(`resources-query:${section}`,state.params.toString());},[section,state.params.toString()]);
  const reload=()=>state.navigate({cursor:null},true);
  const openWindow=(from:number,to:number)=>state.navigate({window:null,from:new Date(from).toISOString(),to:new Date(to).toISOString()},true);
  function shift(delta:number){if(!data?.scope.from||!data.scope.to)return;const a=Date.parse(data.scope.from),b=Date.parse(data.scope.to),span=b-a;openWindow(a+delta*span,b+delta*span);}
  function detail(key:string){const params=new URLSearchParams(current.query);if(data&&data.section!=='now'){params.set('detailFrom',data.scope.from??'');params.set('detailTo',data.scope.to??'');}return `${link(arc,'resources','resources',key).split('?')[0]}?${params}`;}
  const rows=data?.rows??[],bookingRows=rows.filter((r):r is ResourceBooking=>'holder' in r&&!('kind' in r)),cpuRows=rows.filter((r):r is ResourceCpu=>'measuredRunMs' in r),waitRows=rows.filter((r):r is ResourceWait=>'source' in r),nowRows=rows.filter((r):r is ResourceNowRow=>'kind' in r);
  const duration=(b:ResourceBooking)=>{const ms=Date.parse(b.endedAt??terminalAt??new Date(clock).toISOString())-Date.parse(b.startedAt);return ms<0?'Timestamp order unavailable':elapsed(ms);};
  const timeline=new URLSearchParams();if(data?.scope.from)timeline.set('from',data.scope.from);if(data?.scope.to)timeline.set('to',data.scope.to);
  const windowTitle=data&&section!=='now'&&<h3 className="timeline-window-title">{data.scope.from?<>{short(data.scope.from)} to {short(data.scope.to??data.bounds.to)}</>:<>Up to {short(data.scope.to??data.bounds.to)}</>} <span className="muted">{zoneLabel(timeZone)}</span></h3>;
  return <section className="panel resources-panel"><header className="panel-head"><div><h2>Resources</h2><p className="muted">Who holds shared resources now, and who held them before.</p></div></header>
    {now&&<NowStrip arc={arc} now={now} nowEnd={nowEnd} terminalAt={terminalAt??null} ending={ending} startedAt={data?.bounds.from??null} detail={detail} subject={subject} showAll={()=>select('now')} freshError={freshNow.error} retry={freshNow.retry}/>}
    <nav className="activity-subviews" aria-label="Resource sections">{(['schedule','cpu','waiting','now'] as const).map(s=><Button key={s} aria-pressed={section===s} onClick={()=>select(s)}>{sections[s]}</Button>)}</nav>
    <FilterBar label="Resources" ignored={ignoredFilters(current.query,state.facets,{resource:'resource',unit:'unit',stage:'stage',reason:'reason'})} resetKey={state.params.toString()} search={state.params.get('q')??''} searchHelp={section==='schedule'?'Find a resource, unit or holder.':'Find a unit, stage or reason.'} dirty={resourceFields.some(k=>k!=='section'&&current.query.has(k))} activeFilters={['resource','unit','stage','state','reason'].filter(k=>state.params.get(k)).length+(state.params.get('utilization')&&state.params.get('utilization')!=='all'?1:0)} apply={values=>{const next:Record<string,string|null>={};for(const key of ['resource','unit','stage','state','reason','utilization','q','sort','direction','limit','from','to'])if(values.has(key))next[key]=String(values.get(key))||null;if(next['from']||next['to'])next['window']=null;state.navigate(next,true);}} reset={()=>state.navigate(Object.fromEntries(resourceFields.filter(k=>k!=='section').map(k=>[k,null])),true)}
      window={section!=='now'?<WindowSelect label="Resources time window" query={current.query} navigate={state.navigate} latest={latest}/>:undefined}
      extra={section!=='now'&&<>
        <span className="filter-steps"><Button type="button" disabled={!data?.scope.from||!data.scope.to} onClick={()=>shift(-1)} title="The same length of time, just before this window">Earlier</Button><Button type="button" disabled={!data?.scope.from||!data.scope.to} onClick={()=>shift(1)} title="The same length of time, just after this window">Later</Button><Button type="button" onClick={()=>state.navigate({window:state.params.get('window')==='7d'?'7d':'24h',from:null,to:null},true)} title={data?.bounds.terminalAt?'The last 24 hours before the Arc ended':'The last 24 hours, up to now'}>{data?.bounds.terminalAt?'Arc end':'Now'}</Button></span>
        <a className="filter-link" href={`#/arcs/${encodeURIComponent(arc)}/timeline${timeline.size?`?${timeline}`:''}`}>Open this window in Timeline</a></>}>
      {section!=='now'&&<CustomRange from={state.params.get('from')} to={state.params.get('to')}/>}
      <div className="filter-grid">{(section==='schedule'||section==='now')&&<FacetSelect name="resource" label="Resource" all="All resources" values={state.facets?.['resource']??null} value={current.query.get('resource')??''} words={resourceName}/>}
      <FacetSelect name="unit" label="Unit" all="All units" values={state.facets?.['unit']??null} value={current.query.get('unit')??''}/>
      {(section==='cpu'||section==='waiting')&&<FacetSelect name="stage" label="Stage" all="All stages" values={state.facets?.['stage']??null} value={current.query.get('stage')??''} words={stageWords}/>}
      {section==='schedule'&&<label>Booking<select name="state" defaultValue={state.params.get('state')??''}><option value="">Held or released</option><option value="holding">Still held</option><option value="done">Released</option></select></label>}
      {section==='waiting'&&<FacetSelect name="reason" label="Reason" all="All reasons" values={state.facets?.['reason']??null} value={current.query.get('reason')??''} words={reasonWords}/>}
      {section==='cpu'&&<label>Reservation use<select name="utilization" defaultValue={state.params.get('utilization')??'all'}><option value="all">Any</option><option value="under10">Used under 10%</option><option value="over100">Used more than reserved</option><option value="unmeasured">Some calls not measured</option></select></label>}
      {section!=='now'&&<label>Sort<select name="sort" defaultValue={state.params.get('sort')??(section==='schedule'?'resource':section==='cpu'?'unit':'reason')}>{(section==='schedule'?['resource','start','duration']:section==='cpu'?['unit','utilization','coreTime']:['reason','duration','count']).map(s=><option key={s} value={s}>{({resource:'Resource',start:'Start time',duration:'How long',unit:'Unit',utilization:'Reservation used',coreTime:'Measured run time',reason:'Reason',count:'Number of waits'} as Record<string,string>)[s]}</option>)}</select></label>}
      {section!=='now'&&<label>Order<select name="direction" defaultValue={state.params.get('direction')??'asc'}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>}<label>Rows per page<select name="limit" defaultValue={state.params.get('limit')??'50'}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label></div>
    </FilterBar>
    <PlainPageStatus {...state} version="resources" reload={reload} noun={section==='waiting'?'measured wait':section==='cpu'?'stage attempt':section==='now'?'current item':'booking'}/>
    {data&&<>
      {section==='schedule'&&<>
        {data.overview.arc&&<Overview overview={data.overview.arc} noun="booking" zone={timeZone} lo={Date.parse(data.scope.from??data.bounds.from??data.overview.arc.range.from)} hi={Date.parse(data.scope.to??data.bounds.to)} open={openWindow} short={short}/>}
        {windowTitle}
        <Schedule arc={arc} data={data} zone={timeZone} clock={terminalAt?Date.parse(terminalAt):clock} short={short} detail={detail} openWindow={openWindow}/>
        <h3>Resource booking details</h3>
        <Table ref={table} aria-label="Resource bookings" className="resource-table" onKeyDown={resourceRowKeys}><thead><TableRow>{['Resource','Holder','Booking','Started','Duration'].map(t=><TableHead key={t} className={t==='Duration'?'number':undefined}>{t}</TableHead>)}</TableRow></thead><tbody>{bookingRows.map(b=><TableRow key={b.id} onClick={ev=>activateRow(ev,detail(b.detailKey))}><td><a className="resource-primary-link" href={detail(b.detailKey)} title={`Started ${short(b.startedAt)}${b.endedAt?`, released ${short(b.endedAt)}`:''}`}>{resourceName(b.resource)}{b.instance&&<span className="cell-line">{resourceName(b.instance)}</span>}</a></td><td>{subject(b.subject)}{b.subject.type==='arc'&&<span className="cell-line">{plainWords(b.holder.type)} {b.holder.id}</span>}</td><td>{stateWords(b.state)}</td><td><time dateTime={b.startedAt}>{short(b.startedAt)}</time>{data.bounds.from&&<span className="cell-line">{arcDay(b.startedAt,data.bounds.from)}</span>}</td><td className="number" title={b.endedAt?`${Date.parse(b.endedAt)-Date.parse(b.startedAt)} ms`:undefined}>{duration(b)}</td></TableRow>)}</tbody></Table>
        {!bookingRows.length&&<p>{data.overview.resourceCount===0?'No shared resources are recorded in this arc.':'None in this window.'} <Button onClick={()=>state.navigate({window:'arc',from:null,to:null},true)}>Show the whole arc</Button></p>}</>}
      {section==='cpu'&&<>{windowTitle}
        <p>{data.coverage.under10Stages} of {pluralise(data.coverage.measuredStages,'measured stage')} used under 10% of the cores they reserved. {data.coverage.over100Stages} used more than they reserved.</p>
        <p className="muted">{cpuCoverage(data.coverage)} <Hint label="How CPU use is measured">{cpuHelp}</Hint></p>
        <Table ref={table} aria-label="CPU evidence" className="resource-table" onKeyDown={resourceRowKeys}><thead><TableRow>{['Unit or job','Stage','Measured cores','Reserved cores','Used reservation','Runs'].map((t,i)=><TableHead key={t} className={i>=2&&i<=4?'number':undefined}>{t}</TableHead>)}</TableRow></thead><tbody>{cpuRows.map(g=><TableRow key={g.id} onClick={ev=>activateRow(ev,detail(g.detailKey))}>
          <td className="unit-identity">{subject(g.subject)}<a className="resource-primary-link cell-line" href={detail(g.detailKey)}>CPU details</a></td>
          <td>{stageWords(g.stage)}<span className="cell-line">Attempt {g.attempt??'not recorded'}</span></td>
          <td className="number">{cores(g.averageCores)}{g.unreservedAverageCores!==null&&<small className="cell-line">{cores(g.unreservedAverageCores)} without a reservation</small>}</td>
          <td className="number">{cores(g.weightedReservedCores)}</td>
          <td className="number"><UseBullet percent={g.reservationPercent}/>{g.reservationPercent===null?'Not recorded':`${cores(g.reservationPercent)}%`}</td>
          <td>{cpuCoverage(g,false)}<details open><summary>Runs ({g.callCount})</summary>{g.calls.map(c=><p key={c.id}>{c.invocation?<a href={link(arc,'resources','invocations',c.invocation)}>{stageWords(c.stage)}, attempt {c.attempt??'not recorded'}</a>:'Run details not recorded'}<span className="cell-line" title={c.measured?`${c.measured.runMs} ms of CPU time over ${c.measured.wallMs} ms`:undefined}>{callWords(c)}</span>{c.basis&&<span className="cell-line">{basisWords(c.basis)}</span>}</p>)}{g.callCount>g.calls.length&&<a href={detail(g.detailKey)}>All {g.callCount} runs</a>}</details></td></TableRow>)}</tbody></Table>
        {!cpuRows.length&&<p>None in this window. <Button onClick={()=>state.navigate({window:'arc',from:null,to:null},true)}>Show the whole arc</Button></p>}</>}
      {section==='waiting'&&<>{windowTitle}
        <h3>Waiting by reason</h3>
        <dl className="effort-figures"><div><dt>Total waiting</dt><dd>{data.overview.totalWaitingMs===null?'None in this window':elapsed(data.overview.totalWaitingMs)}</dd></div>{data.overview.unallocatedMs!==null&&data.overview.unallocatedMs>0&&<div><dt>Mixed reasons</dt><dd>{elapsed(data.overview.unallocatedMs)}</dd></div>}</dl>
        <p className="muted">A wait can have several reasons, so reason times overlap and don't add up to the total.{data.coverage.unmeasuredReservations===null?' Waits with no recorded length are counted only for the whole arc.':data.coverage.unmeasuredReservations>0?` ${pluralise(data.coverage.unmeasuredReservations,'wait')} ${data.coverage.unmeasuredReservations===1?'has':'have'} no recorded length.`:''}</p>
        <Table aria-label="Waiting by reason"><thead><TableRow><TableHead>Reason</TableHead><TableHead className="number">Time waited</TableHead><TableHead className="number">Waits</TableHead></TableRow></thead><tbody>{(browseReasons&&reasonData?reasonData.rows:data.overview.reasons).map(r=><TableRow key={r.id} onClick={ev=>activateRow(ev,detail(r.detailKey))}><td><a href={detail(r.detailKey)}>{r.label}</a></td><td className="number"><span title={`${r.totalMs} ms`}>{elapsed(r.totalMs)}</span></td><td className="number">{r.count}</td></TableRow>)}</tbody></Table>
        {data.overview.reasonCount>data.overview.reasons.length&&<p>{pluralise(data.overview.reasonCount,'reason')}. <Button onClick={()=>state.navigate({reasons:browseReasons?null:'1',reasonCursor:null})}>{browseReasons?'Show the top reasons':'Show every reason'}</Button></p>}{browseReasons&&reasonData&&<PlainPaging page={reasonData.page} navigate={changes=>state.navigate({reasonCursor:changes['cursor']??null})}/>}
        {reasonState.error&&<p role="alert">{reasonState.error} <Button onClick={()=>{const q=new URLSearchParams(reasonParams);q.delete('cursor');void store?.load(`resources/reasons?${q}`,true);state.navigate({reasonCursor:null});}}>Retry</Button></p>}
        <h3>Each measured wait</h3><Table ref={table} aria-label="Completed waiting measurements" className="resource-table" onKeyDown={resourceRowKeys}><thead><TableRow><TableHead>Unit or job</TableHead><TableHead>Ended</TableHead><TableHead>Waiting to</TableHead><TableHead className="number">Waited</TableHead></TableRow></thead><tbody>{waitRows.map(w=><TableRow key={w.id} onClick={ev=>activateRow(ev,detail(w.detailKey))}><td><a className="resource-primary-link" href={detail(w.detailKey)}>{w.subject.id} {w.subject.title===w.subject.id?'':w.subject.title}{w.subject.titleTruncated?'…':''}</a></td><td>{time(w.at)}</td><td>{waitKind(w)}<span className="cell-line">{w.reasons.map(r=>r.reason).map(reasonWords).join(', ')||'Reason not recorded'}{w.reasonCount>w.reasons.length?`, and ${w.reasonCount-w.reasons.length} more`:''}</span></td><td className="number">{elapsed(w.totalMs)}</td></TableRow>)}</tbody></Table>{!waitRows.length&&<p>None in this window.</p>}</>}
      {section==='now'&&<><h3>Everything current</h3><p className="muted">Waiting jobs are served before waiting units. Pool sizes are as they are now, not as they were earlier.</p><Table aria-label="Current resource evidence" onKeyDown={moveRowFocus}><thead><TableRow><TableHead>What</TableHead><TableHead>Now</TableHead></TableRow></thead><tbody>{nowRows.map(r=><TableRow key={r.id} onClick={ev=>activateRow(ev,'detailKey' in r?detail(r.detailKey):r.subject.unitRef?link(arc,'resources','units',r.subject.unitRef):null)}><td>{r.kind==='resource'||r.kind==='pool'?<a href={detail(r.detailKey)}>{resourceName(r.resource)}</a>:subject(r.subject)}<span className="cell-line">{{resource:'Resource',pool:'Pool',queue:'In the queue',blocker:'Waiting unit'}[r.kind]}</span></td><td>{r.kind==='resource'?<>{resourceStateWords(r.state)}{r.holder?` by ${r.holder}`:''}{r.pending&&<span className="cell-line">A change is in progress</span>}</>:r.kind==='pool'?<>{r.used} of {r.size} in use{r.dirty?<span className="cell-line">{r.dirty} need cleaning</span>:null}</>:r.kind==='queue'?<>Position {r.position}. Wants {wants(r)}.<span className="cell-line">{r.queuedAt?`Waiting ${elapsed(Math.max(0,nowEnd-Date.parse(r.queuedAt)))}`:'Waiting since: not recorded'}</span></>:<>{r.reasons.map(v=>v.text+(v.truncated?'…':'')).join('. ')}{(r.reasonCount>r.reasons.length||r.reasons.some(v=>v.truncated))&&<a className="cell-line" href={link(arc,'resources','units',r.subject.id)}>All {r.reasonCount} reasons</a>}</>}</td></TableRow>)}</tbody></Table></>}
      <PlainPaging page={data.page} navigate={state.navigate}/>
    </>}
  </section>;
}
export const waitKind=(w:ResourceWait)=>w.source==='admission'?`Start ${w.stage?stageWords(w.stage):'a stage'}`:`Reserve a resource${w.stage?` for ${stageWords(w.stage)}`:''}`;
const wants=(q:Extract<ResourceNowRow,{kind:'queue'}>)=>[...(q.publication?['the integration slot']:[]),...(q.cpu>0?[`${q.cpu} CPU ${q.cpu===1?'core':'cores'}`]:[]),...q.named,...q.pools].join(', ')||'nothing recorded';
const callWords=(c:ResourceCpuCall)=>`Reserved ${c.reservedCpu===null?'cores not recorded':pluralise(c.reservedCpu,'core')}. ${c.measured?`Used ${elapsed(c.measured.runMs)} of CPU time over ${elapsed(c.measured.wallMs)}.`:'Not measured.'}`;
/** Measured use against the reservation: the track is the reservation, the bar what was used. Over 100% fills and is marked. */
function UseBullet({percent}:{percent:number|null}) {if(percent===null)return null;return <span className={`cpu-bullet${percent>100?' cpu-bullet-over':''}`} aria-hidden="true"><span style={{width:`${Math.min(100,Math.max(1,percent))}%`}}/></span>;}
/** Now: the integration slot holder and its queue, reserved CPU, and units held back by host load. */
function NowStrip({arc,now,nowEnd,terminalAt,ending,startedAt,detail,subject,showAll,freshError,retry}:{arc:string;now:ResourceNow;nowEnd:number;terminalAt:string|null;ending:'finished'|'stopped';startedAt:string|null;detail:(key:string)=>string;subject:(s:ResourceSubject)=>ReactNode;showAll:()=>void;freshError:string;retry:()=>void}) {
  const cpu=now.cpuReservation,others=now.counts.queues-now.queues.matching;
  return <section aria-label="Resources Now" className="resource-now">
    <h3>{terminalAt?`When the arc ${ending}`:'Now'}</h3>
    {terminalAt&&<p className="muted">{ending==='finished'?'Finished':'Stopped'} arc, after {startedAt?elapsed(Date.parse(terminalAt)-Date.parse(startedAt)):'a length that was not recorded'}.{ending==='stopped'&&' Nothing runs until it is resumed.'}</p>}
    <div className="resource-now-grid">
      <div><h4>Integration slot</h4>
        {now.integration.matching>0?<Table aria-label="Integration slot holder"><thead><TableRow><TableHead>Holder</TableHead><TableHead>State</TableHead><TableHead className="number">Held for</TableHead></TableRow></thead><tbody>{now.integration.rows.map(r=><TableRow key={r.id} onClick={ev=>activateRow(ev,detail(r.detailKey))}><td>{r.unitRef?subject({type:'unit',id:r.unitRef,title:r.holderTitle??r.unitRef,titleTruncated:(r.holderTitle?.length??0)>=96,unitRef:r.unitRef}):r.holder}<a className="cell-line" href={detail(r.detailKey)}>Who held it before</a></td><td>{r.holder?'Holds the integration slot':resourceStateWords(r.state)}{r.pending&&<span className="cell-line">A change is in progress</span>}</td><td className="number">{r.startedAt?elapsed(Math.max(0,nowEnd-Date.parse(r.startedAt))):'Not recorded'}</td></TableRow>)}</tbody></Table>
          :<p>No one holds the integration slot.</p>}
        <h4>Waiting for it</h4>
        {now.queues.matching>0?<Table aria-label="Integration slot queue"><thead><TableRow><TableHead>Next</TableHead><TableHead>Waiting</TableHead><TableHead className="number">For</TableHead></TableRow></thead><tbody>{now.queues.rows.map(q=><TableRow key={q.id} onClick={ev=>activateRow(ev,q.subject.unitRef?link(arc,'resources','units',q.subject.unitRef):null)}><td>{q.position}</td><td>{subject(q.subject)}</td><td className="number">{q.queuedAt===null?'Not recorded':elapsed(Math.max(0,nowEnd-Date.parse(q.queuedAt)))}</td></TableRow>)}</tbody></Table>
          :now.queueAvailable===true?<p>No one is waiting.</p>:<p>Queue unknown <Hint label="Why the queue is unknown"><p>The queue is read from the running executor. {now.queueAvailable===false?"The executor isn't running, so its queue can't be read.":"The executor hasn't reported a queue, so an empty queue can't be confirmed."}</p></Hint></p>}
        {now.queues.matching>now.queues.rows.length&&<p className="muted">{pluralise(now.queues.matching-now.queues.rows.length,'more unit')} waiting. <Button variant="ghost" onClick={showAll}>Show all</Button></p>}
        {others>0&&<p className="muted">{pluralise(others,'other queue entry','other queue entries')} wait for CPU or other resources.</p>}
      </div>
      <div><h4>Reserved CPU</h4>
        {cpu?<><p className="resource-figure">{cpu.used} of {cpu.capacity} cores</p><span className="cpu-meter" aria-hidden="true"><span style={{width:`${cpu.capacity?Math.min(100,cpu.used/cpu.capacity*100):0}%`}}/></span><p className="muted">Reserved, not measured use.</p></>:<p>Not recorded</p>}
        <h4>Blocked by host load</h4>
        {now.blockers.rows.map(b=><p key={b.id}>{subject(b.subject)}: {b.reasons.map(r=>r.text+(r.truncated?'…':'')).join('. ')}{(b.reasonCount>b.reasons.length||b.reasons.some(r=>r.truncated))&&<a className="cell-line" href={link(arc,'resources','units',b.subject.id)}>All {b.reasonCount} reasons</a>}</p>)}
        {!now.blockers.matching&&<p>No units are blocked by host load.</p>}
        {now.blockers.matching>now.blockers.rows.length&&<p className="muted">{pluralise(now.blockers.matching-now.blockers.rows.length,'more unit')}. <Button variant="ghost" onClick={showAll}>Show all</Button></p>}
        {now.unknownQueueStarts>0&&<p className="muted">{pluralise(now.unknownQueueStarts,'queue entry','queue entries')} {now.unknownQueueStarts===1?'has':'have'} no recorded start.</p>}
      </div>
      <div><h4>Blocked for any reason</h4>
        <p className="resource-figure">{pluralise(now.counts.blockers,'unit')}</p>
        <p className="muted">Waiting on dependencies, milestones, resources or decisions.</p>
        {now.counts.blockers>0&&<Button variant="ghost" className="resource-now-all" onClick={showAll}>Show them in Everything current</Button>}
      </div>
    </div>
    {freshError&&<p role="alert">Couldn't update Now. {freshError} <Button onClick={retry}>Retry</Button></p>}
  </section>;
}
/** Recorded bookings on the window's time axis: one lane per resource, or per pool instance, with backend holds pinned above. */
function Schedule({arc,data,zone,clock,short,detail,openWindow}:{arc:string;data:ResourceView;zone:string;clock:number;short:(at:string)=>string;detail:(key:string)=>string;openWindow:(from:number,to:number)=>void}) {
  const lo=Date.parse(data.scope.from??data.bounds.from??data.bounds.to),hi=Date.parse(data.scope.to??data.bounds.to);
  const x=(t:number)=>Math.max(0,Math.min(100,(t-lo)/(hi-lo)*100)),span=(from:string,to:string|null):[number,number]=>[x(Date.parse(from)),x(to?Date.parse(to):clock)];
  const axis=ticks(lo,hi,zone,9),grid=tickGrid(axis,x),holds=data.overview.backendHolds?.rows??[],laneRows=data.overview.lanes?.rows??[];
  const length=(from:string,to:string|null)=>{const ms=(to?Date.parse(to):clock)-Date.parse(from);return ms<0?'Timestamp order unavailable':elapsed(ms);};
  function mark(m:BookingMark,lane:ResourceLane,row:number,a:number,b:number){
    const style={left:`${a}%`,width:`${Math.max(b-a,m.type==='cluster'?2.4:.4)}%`,top:`${row*22+4}px`},name=resourceName(lane.instance??lane.resource);
    if(m.type==='cluster'){const from=Date.parse(m.from),to=Math.max(Date.parse(m.to),from+60000),label=`${m.count} bookings of ${name} started between ${short(m.from)} and ${short(m.to)}. Zoom in.`;
      return <button key={`c${m.from}`} type="button" className="timeline-mark timeline-cluster" style={style} aria-label={label} title={label} onClick={()=>openWindow(from-60000,to+60000)}><span>{m.count}</span><span className="timeline-label"> bookings</span></button>;}
    const label=`${m.holder} ${m.endedAt?'held':'holds'} ${name} from ${short(m.startedAt)}${m.endedAt?` to ${short(m.endedAt)}`:', still held'}. ${length(m.startedAt,m.endedAt)}.`;
    return <a key={m.id} className={`timeline-mark timeline-bar ${m.endedAt?'bar-pending':'bar-active bar-open'}`} style={style} href={detail(m.detailKey)} aria-label={label} title={label}><span className="timeline-label">{m.holder}</span></a>;
  }
  if(!laneRows.length&&!holds.length)return null;
  return <><Table aria-label="Resource schedule" className="timeline-chart" style={grid} onKeyDown={moveRowFocus}>
    <thead><TableRow><TableHead className="timeline-identity">Resource</TableHead><TableHead className="timeline-axis" aria-label={`Time from ${short(new Date(lo).toISOString())} to ${short(new Date(hi).toISOString())}`}>{axis.map(a=><span key={a.t} className={a.end?'axis-end':undefined} style={a.end?{right:0}:{left:`${x(a.t)}%`}}>{a.label}</span>)}</TableHead></TableRow></thead>
    <tbody>
      {[...new Set(holds.map(h=>h.backend))].map(backend=><TableRow key={`hold:${backend}`}><td className="timeline-identity"><strong>{backend}</strong><span className="cell-line">Unavailable to new calls</span></td>
        <td className="timeline-lane" style={{height:'38px'}}>{holds.filter(h=>h.backend===backend).map(h=>{const [a,b]=span(h.startedAt,h.endedAt??h.terminalAt),label=`${backend} unavailable to new calls: ${classWords(h.effectiveClass)}. From ${short(h.startedAt)}${h.endedAt??h.terminalAt?` to ${short((h.endedAt??h.terminalAt)!)}`:', still unavailable'}. ${closureWords(h)}.`;
          return <a key={h.id} className={`timeline-mark timeline-hold${h.endedAt||h.terminalAt?'':' bar-open'}`} style={{left:`${a}%`,width:`${Math.max(b-a,.4)}%`,top:'6px'}} href={link(arc,'resources','events',h.detail.id)} aria-label={label} title={label}><span className="timeline-label">{classWords(h.effectiveClass)}</span></a>;})}</td></TableRow>)}
      {laneRows.map(lane=>{const {placed,count}=lanes(lane.marks,m=>m.type==='cluster'?span(m.from,m.to):span(m.startedAt,m.endedAt),m=>m.type==='cluster'?2.4:0);
        // A booking still held reads in the row; one that outlasts the window says so at the window's edge.
        const held=lane.marks.flatMap(m=>m.type!=='cluster'&&m.endedAt===null?[m]:[]).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))[0];
        const past=placed.flatMap(p=>p.item.type!=='cluster'&&(p.item.endedAt?Date.parse(p.item.endedAt):clock)>hi?[{m:p.item,row:p.lane}]:[]);
        return <TableRow key={lane.id} onClick={ev=>activateRow(ev,detail(lane.resourceKey))}><td className="timeline-identity"><a href={detail(lane.resourceKey)} title={`Everyone who held ${resourceName(lane.instance??lane.resource)}`}><strong>{resourceName(lane.instance??lane.resource)}</strong>{lane.instance&&<span>in {resourceName(lane.resource)}</span>}</a><span className="cell-line">{pluralise(lane.count,'booking')} in this window{lane.open?`, ${lane.open} still held`:''}</span>
          {held&&<span className="cell-line timeline-running-since">Held by {held.holder} since {short(held.startedAt)}{clock>hi?'. Continues past this window':''}</span>}</td>
          <td className="timeline-lane" style={{height:`${count*22+8}px`}}>{placed.map(p=>mark(p.item,lane,p.lane,p.a,p.b))}{past.map(({m,row})=><ContinuesCap key={`past-${m.id}`} href={detail(m.detailKey)} top={row*22+4} label={`${m.holder}, ${resourceName(lane.instance??lane.resource)}: ${continuesWords(m.startedAt,m.endedAt,clock,short)}`}/>)}</td></TableRow>;})}
    </tbody></Table>
    {(data.overview.lanes?.matching??0)>laneRows.length&&<p className="muted">The first {laneRows.length} of {data.overview.lanes!.matching} resources are drawn. Filter by resource to see another.</p>}
    {holds.length>0&&<p className="muted">New calls were blocked while a backend was unavailable. Running calls could continue.</p>}
    <p className="muted">A gap means no booking was recorded. The resource may not have been free.</p></>;
}
export function ResourceIdentity({arc,subject:s}:{arc:string;subject:ResourceSubject}) {return s.unitRef?<a href={link(arc,route().tab,'units',s.unitRef)} title={`${s.id}: ${s.title}`}>{s.id} {s.title===s.id?'':s.title}{s.titleTruncated?'…':''}</a>:<span>{s.type==='job'?'Job ':s.type==='arc'?'Arc ':''}{s.id}{s.title!==s.id&&s.title!=='Arc'?` ${s.title}`:''}</span>;}
export function ResourceTime({at}:{at:string}){const zone=route().query.get('zone')??displayZone();return <time dateTime={at} title={at}>{formatInstant(at,zone)} {zoneLabel(zone)}</time>;}
export function resourceRowKeys(ev:React.KeyboardEvent<HTMLTableElement>){if(!['ArrowDown','ArrowUp','Home','End'].includes(ev.key))return;const links=[...ev.currentTarget.querySelectorAll<HTMLAnchorElement>('.resource-primary-link')],n=links.indexOf(document.activeElement as HTMLAnchorElement);if(n<0)return;ev.preventDefault();links[ev.key==='Home'?0:ev.key==='End'?links.length-1:Math.max(0,Math.min(links.length-1,n+(ev.key==='ArrowDown'?1:-1)))]?.focus();}
