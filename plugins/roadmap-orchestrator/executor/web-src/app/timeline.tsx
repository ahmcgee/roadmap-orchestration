// Timeline: when each agent and command ran, on one time axis per window, with backend holds pinned above.
// The chart is a native table (one row per unit, job or Arc-wide track); "Show as table" lists the same rows as exact text.
import { useContext, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { Clock, displayZone, elapsed, formatInstant, link, pluralise, route, SignalMark, zoneLabel } from './shared.tsx';
import { useView } from './view-state.ts';
import { usePlainQuery, PlainPageStatus, PlainPaging, activateRow, moveRowFocus, FilterBar, useLatestWindow, WindowSelect } from './plain-query.tsx';
import type { TimelineView, IntervalsView, HoldsView, TrackSummary } from '../../src/console/temporal-protocol.ts';
import { classWords, closureWords, lanes, Overview, tickGrid, ticks } from './time-axis.tsx';
import type { BackendHold } from '../../src/console/activity-protocol.ts';
import type { Interval, TrackMark, Signal } from '../../src/console/view-protocol.ts';
import { plainWords, roleWords, stageWords, stateWords } from '../../src/console/vocabulary.ts';
const fields=['window','from','to','zone','unit','milestone','state','stage','execution','q','sort','cursor','limit'] as const;
const unitStates=['preparing','ready','waiting','awaiting-admission','blocked','held','parked','running','merged','cut','superseded'];
/** A recorded run result, as words and the status signal it shows. */
const results:Record<string,[string,Signal]>={running:['Running','active'],pass:['Passed','passed'],green:['Passed','passed'],success:['Succeeded','passed'],approve:['Approved','passed'],published:['Published','passed'],'probe passed':['Probe passed','passed'],
  fail:['Failed','failed'],red:['Failed','failed'],'process-fault':['Process fault','failed'],'executor-fault':['Executor fault','failed'],'probe failed':['Probe failed','failed'],revise:['Changes requested','held'],'pre-delivery':['Not delivered yet','pending']};
export const resultWords=(outcome:string):[string,Signal]=>results[outcome]??[plainWords(outcome),'pending'];
export function Timeline({arc}:{arc:string}) {
  const current=route(),zone=current.query.get('zone')??displayZone(),explicit=current.query.has('window')||current.query.has('from')||current.query.has('to'),latest=useLatestWindow();
  const state=usePlainQuery<TimelineView>(arc,'timeline',fields,explicit?{zone}:latest?{...latest,zone}:null),data=state.data;
  const subject=current.query.get('track'),showHolds=current.query.get('holds')==='1',asTable=current.query.get('layout')==='table';
  const args=new URLSearchParams(state.params);args.delete('cursor');args.delete('sort');args.delete('limit');
  if(data){args.delete('window');if(data.scope.from)args.set('from',data.scope.from);if(data.scope.to)args.set('to',data.scope.to);}
  if(subject)args.set('subject',subject);
  if(current.query.has('intervalCursor'))args.set('cursor',current.query.get('intervalCursor')!);
  const exact=useView(subject&&data?`timeline/intervals?${args}`:null),intervals=exact.data as IntervalsView|null;
  const holdArgs=new URLSearchParams();for(const key of ['window','from','to','zone'])for(const value of state.params.getAll(key))holdArgs.append(key,value);
  if(data){holdArgs.delete('window');if(data.scope.from)holdArgs.set('from',data.scope.from);if(data.scope.to)holdArgs.set('to',data.scope.to);}
  if(current.query.has('holdCursor'))holdArgs.set('cursor',current.query.get('holdCursor')!);
  const holds=useView(showHolds&&data?`timeline/holds?${holdArgs}`:null);
  const now=useContext(Clock),reload=()=>state.navigate({cursor:null,intervalCursor:null,holdCursor:null},true);
  const openWindow=(from:number,to:number,track?:string)=>state.navigate({window:null,from:new Date(from).toISOString(),to:new Date(to).toISOString(),track:track??null,intervalCursor:null,holdCursor:null},true);
  function shift(delta:number){if(!data?.scope.from||!data.scope.to)return;const a=Date.parse(data.scope.from),b=Date.parse(data.scope.to),span=b-a;openWindow(a+delta*span,b+delta*span);}
  let timeZone=zone;try{new Intl.DateTimeFormat('en',{timeZone:timeZone});}catch{timeZone='UTC';}
  const short=(at:string)=>formatInstant(at,timeZone,true);
  const time=(at:string|null)=>at?<time dateTime={at}>{short(at)}</time>:'Still running';
  const lo=data?Date.parse(data.scope.from??data.bounds.from??data.overview.range.from):0,hi=data?Date.parse(data.scope.to??data.bounds.to):1;
  // An open run reaches the verified clock, or the Arc's recorded end; never past the window.
  const clock=data?.bounds.terminalAt?Date.parse(data.bounds.terminalAt):now;
  const x=(t:number)=>Math.max(0,Math.min(100,(t-lo)/(hi-lo)*100));
  const span=(from:string,to:string|null):[number,number]=>[x(Date.parse(from)),x(to?Date.parse(to):clock)];
  const length=(startedAt:string,endedAt:string|null)=>{const ms=(endedAt?Date.parse(endedAt):clock)-Date.parse(startedAt);return ms<0?'Timestamp order unavailable':elapsed(ms);};
  const runText=(i:{startedAt:string;endedAt:string|null})=>i.endedAt?`${short(i.startedAt)} to ${short(i.endedAt)}, ${length(i.startedAt,i.endedAt)}`:`Started ${short(i.startedAt)}, still running`;
  const kinds=(t:TrackSummary)=>t.subject.type==='unit'?{id:t.subject.id,title:t.subject.title}:t.subject.type==='job'?{id:'Job',title:t.subject.id}:{id:'Arc-wide',title:'Runs not tied to a unit or job'};
  const toggle=(t:TrackSummary)=><Button variant="ghost" className="timeline-toggle" aria-expanded={subject===t.id} aria-label={`${subject===t.id?'Hide':'Show'} runs for ${kinds(t).id} ${kinds(t).title}`} onClick={()=>state.navigate({track:subject===t.id?null:t.id,intervalCursor:null})}>{subject===t.id?'Hide runs':'Show runs'}</Button>;
  /** Left/Right moves between the marks of one row; Enter follows the focused one. */
  function moveMark(ev:React.KeyboardEvent<HTMLElement>){if(!['ArrowLeft','ArrowRight'].includes(ev.key))return;const marks=[...ev.currentTarget.querySelectorAll<HTMLElement>('.timeline-mark')].sort((a,b)=>parseFloat(a.style.left)-parseFloat(b.style.left)),n=marks.indexOf(document.activeElement as HTMLElement);if(n<0)return;ev.preventDefault();marks[Math.max(0,Math.min(marks.length-1,n+(ev.key==='ArrowRight'?1:-1)))]?.focus();}
  function mark(m:TrackMark,t:TrackSummary,lane:number,a:number,b:number){
    const style={left:`${a}%`,width:`${Math.max(b-a,m.type==='cluster'?2.4:.4)}%`,top:`${lane*22+4}px`};
    if(m.type==='cluster'){const from=Date.parse(m.from),to=Math.max(Date.parse(m.to),from+60000);
      return <button key={`c${m.from}`} type="button" className="timeline-mark timeline-cluster" style={style} aria-label={`${m.count} runs started between ${short(m.from)} and ${short(m.to)}. Zoom in and show them.`} title={`${m.count} runs started between ${short(m.from)} and ${short(m.to)}. Select to zoom in.`} onClick={()=>openWindow(from-60000,to+60000,t.id)}><span>{m.count}</span><span className="timeline-label"> runs</span></button>;}
    const [words,signal]=resultWords(m.outcome),label=`${stageWords(m.stage)}: ${words}. ${runText(m)}`;
    return <a key={m.id} className={`timeline-mark timeline-bar bar-${signal}${m.endedAt?'':' bar-open'}`} style={style} href={link(arc,'timeline','invocations',m.invocation)} aria-label={label} title={label}><span className="timeline-label">{stageWords(m.stage)}</span></a>;
  }
  function trackRow(t:TrackSummary){
    const href=t.detail?link(arc,'timeline','units',t.detail.id):null,id=kinds(t);
    const {placed,count}=lanes(t.marks,m=>m.type==='cluster'?span(m.from,m.to):span(m.startedAt,m.endedAt),m=>m.type==='cluster'?2.4:0);
    return <TableRow key={t.id} className={subject===t.id?'timeline-selected':undefined} onClick={ev=>activateRow(ev,href)}>
      <td className="unit-identity timeline-identity"><div className="timeline-identity-head">{href?<a href={href} title={`${id.id}: ${id.title}`}><strong>{id.id}</strong><span>{id.title}</span></a>:<span><strong>{id.id}</strong><span>{id.title}</span></span>}{toggle(t)}</div>
        <span className="cell-line">{t.state?<>{t.signal&&<SignalMark state={t.signal}/>} {stateWords(t.state)}. </>:''}{pluralise(t.intervalCount,'run')}, {t.openCount} open</span></td>
      <td className="timeline-lane" style={{height:`${count*22+8}px`}} onKeyDown={moveMark}>{placed.map(p=>mark(p.item,t,p.lane,p.a,p.b))}</td>
    </TableRow>;
  }
  function runRows(rows:Interval[]){
    const {placed}=lanes(rows,i=>span(i.startedAt,i.endedAt),()=>0);const lane=new Map(placed.map(p=>[p.item.id,p]));
    return rows.map(i=>{const [words,signal]=resultWords(i.outcome),href=link(arc,'timeline','invocations',i.invocation),p=lane.get(i.id)!,label=`${stageWords(i.stage)}, attempt ${i.attempt}: ${words}. ${runText(i)}`;
      return <TableRow key={i.id} onClick={ev=>activateRow(ev,href)}>
        <td className="timeline-identity"><a href={href} title={label}><strong>{stageWords(i.stage)}</strong><span>attempt {i.attempt}{i.round!==null?`, round ${i.round}`:''}</span></a>
          <span className="cell-line">{actorWords(i)}</span><span className="cell-line"><SignalMark state={signal}/> {words}. {runText(i)}</span></td>
        <td className="timeline-lane"><span className={`timeline-bar bar-${signal}${i.endedAt?'':' bar-open'}`} style={{left:`${p.a}%`,width:`${Math.max(p.b-p.a,.4)}%`,top:'10px'}} title={`${label}${i.wallMs!==null?`. Timed work ${elapsed(i.wallMs)}`:''}`}/></td>
      </TableRow>;});
  }
  const runsTable=(key:string,colSpan:number)=><tr key={key} className="timeline-runs"><td colSpan={colSpan}>
    {exact.error&&<p role="alert">{exact.error} <Button onClick={exact.retry}>Retry</Button></p>}
    {exact.loading&&!intervals&&<p role="status">Loading runs…</p>}
    {intervals&&<><Table aria-label="Exact invocation intervals" className={asTable?'timeline-run-table':'timeline-chart'} onKeyDown={moveRowFocus} style={asTable?undefined:grid}>
      {asTable&&<thead><TableRow>{['Run','Agent or command','Result','Started','Ended','Duration','Timed work'].map((h,n)=><TableHead key={h} {...(n>=5?{className:'number'}:{})}>{h}</TableHead>)}</TableRow></thead>}
      <tbody>{asTable?intervals.rows.map(i=>{const href=link(arc,'timeline','invocations',i.invocation);return <TableRow key={i.id} onClick={ev=>activateRow(ev,href)}>
        <td><a href={href}>{stageWords(i.stage)}</a><span className="cell-line">Attempt {i.attempt}{i.round!==null?`, round ${i.round}`:''}</span></td><td>{actorWords(i)}</td><td>{resultWords(i.outcome)[0]}</td>
        <td>{time(i.startedAt)}</td><td>{time(i.endedAt)}</td><td className="number">{i.endedAt?length(i.startedAt,i.endedAt):'Still running'}</td><td className="number">{elapsed(i.wallMs)}</td></TableRow>;}):runRows(intervals.rows)}</tbody></Table>
      {(intervals.page.next||intervals.page.previous)&&<PlainPaging page={intervals.page} navigate={changes=>state.navigate({intervalCursor:changes['cursor']??null})}/>}</>}
  </td></tr>;
  const axis=data?ticks(lo,hi,timeZone,9):[],grid=tickGrid(axis,x);
  const windowHolds=data?data.overview.backendHolds.rows.filter(h=>{const end=h.endedAt??h.terminalAt;return Date.parse(h.startedAt)<hi&&(end===null||Date.parse(end)>lo);}):[];
  const activity=new URLSearchParams();if(data?.scope.from)activity.set('from',data.scope.from);if(data?.scope.to)activity.set('to',data.scope.to);if(subject?.startsWith('unit:'))activity.set('unit',subject.slice(5));
  return <section className="panel timeline"><header className="panel-head"><div><h2>Timeline</h2><p className="muted">When each agent and command ran, and when a backend was unavailable.</p></div></header>
    <FilterBar label="Timeline" resetKey={state.params.toString()} search={state.params.get('q')??''} searchHelp="Find a unit by id or title." dirty={[...fields,'track','holds','holdCursor','intervalCursor','layout'].some(k=>current.query.has(k))} activeFilters={['unit','milestone','state','stage','execution','from','to'].filter(k=>current.query.get(k)).length}
      apply={values=>{const next:Record<string,string|null>={track:null};for(const key of ['unit','milestone','state','stage','execution','q','limit','from','to'])next[key]=String(values.get(key)??'')||null;if(next['from']||next['to'])next['window']=null;state.navigate(next,true);}}
      reset={()=>state.navigate(Object.fromEntries([...fields,'track','holds','holdCursor','intervalCursor','layout'].map(k=>[k,null])),true)}
      window={<WindowSelect label="Timeline time window" query={current.query} navigate={state.navigate} latest={latest}/>}
      extra={<>
        <span className="filter-steps"><Button type="button" disabled={!data?.scope.from||!data.scope.to} onClick={()=>shift(-1)} title="The same length of time, just before this window">Earlier</Button><Button type="button" disabled={!data?.scope.from||!data.scope.to} onClick={()=>shift(1)} title="The same length of time, just after this window">Later</Button><Button type="button" onClick={()=>state.navigate({window:state.params.get('window')==='7d'?'7d':'24h',from:null,to:null,track:null},true)} title={data?.bounds.terminalAt?'The last 24 hours before the Arc ended':'The last 24 hours, up to now'}>{data?.bounds.terminalAt?'Arc end':'Now'}</Button></span>
        <select aria-label="Timeline order" className="filter-window" value={state.params.get('sort')??'plan'} onChange={ev=>state.navigate({sort:ev.target.value==='plan'?null:ev.target.value})}><option value="plan">Plan order</option><option value="open">Running first</option><option value="longest-open">Running longest first</option></select>
        <Button type="button" aria-pressed={asTable} onClick={()=>state.navigate({layout:asTable?null:'table'})}>{asTable?'Show as chart':'Show as table'}</Button>
        <a className="filter-link" href={`#/arcs/${encodeURIComponent(arc)}/activity${activity.size?`?${activity}`:''}`}>Open this window in Activity</a>
      </>}>
      <details className="activity-range"><summary>Custom time range</summary><label>From<input name="from" defaultValue={state.params.get('from')??''}/></label><label>To<input name="to" defaultValue={state.params.get('to')??''}/></label><Button type="submit">Apply time range</Button></details>
      <div className="filter-grid"><label>Unit<input name="unit" defaultValue={state.params.get('unit')??''}/></label><label>Milestone<input name="milestone" defaultValue={state.params.get('milestone')??''}/></label>
      <label>Unit state<select name="state" defaultValue={state.params.get('state')??''}><option value="">Any state</option>{unitStates.map(v=><option key={v} value={v}>{stateWords(v)}{['held','parked'].includes(v)?` (${v})`:v==='awaiting-admission'?' to start':''}</option>)}</select></label>
      <label>Stage<input name="stage" defaultValue={state.params.get('stage')??''} title="A recorded stage, such as build, lanes or gate"/></label>
      <label>Kind<select name="execution" defaultValue={state.params.get('execution')??''}><option value="">Agents and commands</option><option value="agent">Agents only</option><option value="command">Commands and checks only</option><option value="unknown">Kind not recorded</option></select></label>
      <label>Rows per page<select name="limit" defaultValue={state.params.get('limit')??'50'}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label></div>
    </FilterBar>
    <PlainPageStatus {...state} reload={reload} version="timeline" noun="track" count={data?trackCount(data):undefined}/>
    {data&&<>
      <Overview overview={data.overview} noun="run" zone={timeZone} lo={lo} hi={hi} open={openWindow} short={short}/>
      <h3 className="timeline-window-title">{data.scope.from?<>{short(data.scope.from)} to {short(data.scope.to??data.bounds.to)}</>:<>Up to {short(data.scope.to??data.bounds.to)}</>} <span className="muted">{zoneLabel(timeZone)}</span></h3>
      <section aria-label="Backend availability" className="timeline-holds">
        {windowHolds.length?<>
          {asTable?<Table aria-label="Backend availability"><thead><TableRow>{['Backend','Reason','Started','Ended'].map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></thead><tbody>{windowHolds.map(h=><TableRow key={h.id} onClick={ev=>activateRow(ev,link(arc,'timeline','events',h.detail.id))}><td><a href={link(arc,'timeline','events',h.detail.id)}>{h.backend}</a></td><td>{classWords(h.effectiveClass)}{h.effectiveClass!==h.recordedClass&&<span className="cell-line">Recorded as {classWords(h.recordedClass).toLowerCase()}</span>}</td><td>{time(h.startedAt)}</td><td>{h.endedAt?time(h.endedAt):h.terminalAt?time(h.terminalAt):'Still unavailable'}<span className="cell-line">{closureWords(h)}</span></td></TableRow>)}</tbody></Table>
          :<Table aria-label="Backend availability" className="timeline-chart" style={grid}><tbody>{[...new Set(windowHolds.map(h=>h.backend))].map(backend=><TableRow key={backend}>
            <td className="timeline-identity"><strong>{backend}</strong><span className="cell-line">Unavailable to new calls</span></td>
            <td className="timeline-lane" style={{height:'38px'}} onKeyDown={moveMark}>{windowHolds.filter(h=>h.backend===backend).map(h=>{const [a,b]=span(h.startedAt,h.endedAt??h.terminalAt),label=`${backend} unavailable to new calls: ${classWords(h.effectiveClass)}. From ${short(h.startedAt)}${h.endedAt??h.terminalAt?` to ${short((h.endedAt??h.terminalAt)!)}`:', still unavailable'}. ${closureWords(h)}.`;
              return <a key={h.id} className={`timeline-mark timeline-hold${h.endedAt||h.terminalAt?'':' bar-open'}`} style={{left:`${a}%`,width:`${Math.max(b-a,.4)}%`,top:'6px'}} href={link(arc,'timeline','events',h.detail.id)} aria-label={label} title={label}><span className="timeline-label">{classWords(h.effectiveClass)}</span></a>;})}</td>
          </TableRow>)}</tbody></Table>}
          <p className="muted">New calls were blocked. Running calls could continue.</p>
        </>:<p className="muted">No backend was unavailable in this window.</p>}
        {data.overview.backendHolds.matching>data.overview.backendHolds.rows.length&&<p>{pluralise(data.overview.backendHolds.matching,'backend hold')} in the whole arc; the first {data.overview.backendHolds.rows.length} are shown. <Button onClick={()=>state.navigate({holds:showHolds?null:'1',holdCursor:null})}>{showHolds?'Hide the full list':'List every hold in this window'}</Button></p>}
        {showHolds&&holds.data&&<HoldList arc={arc} rows={(holds.data as HoldsView).rows} time={time}/>}
        {showHolds&&holds.data&&<PlainPaging page={(holds.data as HoldsView).page} navigate={changes=>state.navigate({holdCursor:changes['cursor']??null})}/>}
        {holds.error&&<p role="alert">{holds.error} <Button onClick={holds.retry}>Retry</Button></p>}
      </section>
      <h3>Agent and command runs</h3>
      {!data.rows.length&&<p>No runs in this window match these filters. <Button onClick={()=>state.navigate({window:'arc',from:null,to:null,track:null},true)}>Show the whole arc</Button></p>}
      {data.rows.length>0&&(asTable
        ?<Table aria-label="Invocation timeline" onKeyDown={moveRowFocus}><thead><TableRow>{['Unit or job','State','Runs in window','First start','Last end',''].map((t,i)=><TableHead key={i} {...(i===2?{className:'number'}:{})}>{t}</TableHead>)}</TableRow></thead>
          <tbody>{data.rows.flatMap(t=>{const href=t.detail?link(arc,'timeline','units',t.detail.id):null,id=kinds(t);return [<TableRow key={t.id} onClick={ev=>activateRow(ev,href)}>
            <td className="unit-identity">{href?<a href={href} title={`${id.id}: ${id.title}`}><strong>{id.id}</strong><span>{id.title}</span></a>:<><strong>{id.id}</strong><span>{id.title}</span></>}</td>
            <td>{t.state?stateWords(t.state):'Not applicable'}</td><td className="number">{t.intervalCount}<span className="cell-line">{t.openCount} open</span></td><td>{time(t.firstAt)}</td><td>{t.lastAt?time(t.lastAt):'Still running'}</td><td>{toggle(t)}</td></TableRow>,...(subject===t.id?[runsTable(`${t.id}-runs`,6)]:[])];})}</tbody></Table>
        :<Table aria-label="Invocation timeline" className="timeline-chart" onKeyDown={moveRowFocus} style={grid}>
          <thead><TableRow><TableHead className="timeline-identity">Unit or job</TableHead><TableHead className="timeline-axis" aria-label={`Time from ${short(new Date(lo).toISOString())} to ${short(new Date(hi).toISOString())}`}>{axis.map(a=><span key={a.t} className={a.end?'axis-end':undefined} style={a.end?{right:0}:{left:`${x(a.t)}%`}}>{a.label}</span>)}</TableHead></TableRow></thead>
          <tbody>{data.rows.flatMap(t=>[trackRow(t),...(subject===t.id?[runsTable(`${t.id}-runs`,2)]:[])])}</tbody></Table>)}
      <PlainPaging page={data.page} navigate={state.navigate}/>
      <p className="muted">Bars show when each run started and ended. A gap means nothing ran; it is not a diagnosis.</p>
    </>}
  </section>;
}
/** Who ran it: the role when it differs from the stage, then the recorded backend and model. */
function actorWords(i:Interval){const role=roleWords(i.actor.role);return [role===stageWords(i.stage)?null:role,i.actor.backend,i.actor.model].filter(Boolean).join(', ')||role;}
function trackCount(data:TimelineView){const units=data.rows.filter(r=>r.subject.type==='unit').length;return `${pluralise(data.page.matching,'track')} with runs in this window${data.rows.length<data.page.matching?'':`: ${pluralise(units,'unit')}${data.rows.length>units?` and ${pluralise(data.rows.length-units,'other track')}`:''}`}`;}
function HoldList({arc,rows,time}:{arc:string;rows:BackendHold[];time:(at:string|null)=>ReactNode}) {
  return <Table aria-label="Every backend hold in this window"><thead><TableRow>{['Backend','Reason','Started','Ended'].map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></thead><tbody>{rows.map(h=><TableRow key={h.id} onClick={ev=>activateRow(ev,link(arc,'timeline','events',h.detail.id))}><td><a href={link(arc,'timeline','events',h.detail.id)}>{h.backend}</a></td><td>{classWords(h.effectiveClass)}</td><td>{time(h.startedAt)}</td><td>{h.endedAt?time(h.endedAt):h.terminalAt?time(h.terminalAt):'Still unavailable'}<span className="cell-line">{closureWords(h)}</span></td></TableRow>)}</tbody></Table>;
}
