import { DetailContinuations } from './detail-content.tsx';
import { applyContent, mergeDetailPage } from './detail-merge.ts';
import { useContext, useEffect, useRef, useState } from 'react';
import { Drawer, Intent } from './drawer.tsx';
import { HistoryMarkdown } from './markdown.tsx';
import { Button } from '../components/ui/button.tsx';
import { Clock, elapsed, link, money, pluralise, route, sentence, SignalMark, Time, get } from './shared.tsx';
import { useSelectedDetail, Views } from './view-state.ts';
import type { UnitView, MilestoneView, DetailPage } from '../../src/console/detail-protocol.ts';
import { costWords, holdClassWords, plainWords, stageStatusWords, stageWords, stateWords, signalWords, timedWords, waitCountWords } from '../../src/console/vocabulary.ts';
function More({page,load}:{page:DetailPage<unknown>;load:()=>void}){return page.next?<Button onClick={load}>Show more ({page.rows.length} of {page.total})</Button>:null;}
export function UnitDetail({arc,id,close}:{arc:string;id:string;close:()=>void;stale?:boolean}) {
  const cache=useContext(Views);
  const now=useContext(Clock),[trail,setTrail]=useState<string[]>([]),[housekeeping,setHousekeeping]=useState(false);
  const path=id.startsWith('milestone:')?`milestones/${encodeURIComponent(id.slice(10))}`:`units/${encodeURIComponent(id)}`;
  const request=useRef(0);useEffect(()=>()=>{request.current++;},[path,cache?.generation]);
  const selected=useSelectedDetail(arc,cache?.metadata?path:null),[detail,setDetail]=useState<any>(null),[error,setError]=useState('');
  useEffect(()=>{const saved=cache?.ui.get(`detail:${path}`) as (UnitView & {_anchored?:boolean})|undefined;setDetail(saved?._anchored?saved:selected.data);setError('');},[selected.data,path]);

  // The breadcrumb is the real lineage path: a lineage link pushes, Back to that unit pops, any other route starts over.
  const viaLineage=useRef(false);
  useEffect(()=>{if(viaLineage.current){viaLineage.current=false;return;}setTrail(t=>t.at(-1)===id?t.slice(0,-1):[]);},[id]);
  const trace=(source:string,target:string)=>window.dispatchEvent(new CustomEvent('roadmap-edge',{detail:{source,target}}));
  const clearTrace=()=>{window.dispatchEvent(new CustomEvent('roadmap-edge',{detail:null}));};
  useEffect(()=>clearTrace,[id]);
  useEffect(()=>{if(detail&&cache){const key=`detail:${detail.unit?`units/${encodeURIComponent(detail.unit.id)}`:`milestones/${encodeURIComponent(detail.id)}`}`;cache.ui.delete(key);cache.ui.set(key,detail);const details=[...cache.ui.keys()].filter(k=>k.startsWith('detail:'));for(const key of details.slice(0,-8))cache.ui.delete(key);cache.trimUi();}},[path,detail]);
  async function more(section:string){
    const ticket=request.current;try{const field=detail.continuations?.find((r:any)=>r.path.join('.')===`${section}.${section==='intent'?'text':'rows'}`);if(field){const r=await get(`/arcs/${encodeURIComponent(arc)}/${path}?section=content&cursor=${encodeURIComponent(field.next)}`);if(ticket!==request.current)return;if(cache&&!cache.admit(r,false,true))throw Error('Detail response was overtaken; retry');setDetail((old:any)=>applyContent(old,r.data,field));return;}const next=detail[section].next;if(!next)return;const r=await get(`/arcs/${encodeURIComponent(arc)}/${path}?section=${section}&cursor=${encodeURIComponent(next)}`);if(ticket!==request.current)return;if(cache&&!cache.admit(r,false,true))throw Error('Detail response was overtaken; retry');setDetail((old:any)=>mergeDetailPage(old,r.data,section));}catch(err){setError(err instanceof Error?err.message:String(err));}
  }
  const intent=detail&&<section><Intent text={detail.intent.text} title={detail.unit?.title??detail.name??detail.id}/>{detail.intent.next&&<Button onClick={()=>void more('intent')}>Read more intent</Button>}</section>;
  const reload=()=>{cache?.ui.delete(`detail:${path}`);setError('');setDetail(null);selected.retry();};
  const continuations=<DetailContinuations arc={arc} path={path} detail={detail??{}} update={setDetail}/>;
  const matches=detail&&(id.startsWith('milestone:')?detail.id===id.slice(10):detail.unit?.id===id);
  if(!matches)return <Drawer title={selected.error?'Details unavailable':'Reading details…'} close={close}><p role={selected.error?'alert':'status'}>{selected.error||'Waiting for verified detail…'}</p>{selected.error&&<Button onClick={selected.retry}>Retry</Button>}</Drawer>;
  if(id.startsWith('milestone:')){
    const g=detail as MilestoneView,outstanding=g.members.rows.filter(r=>r.signal!=='passed'&&r.signal!=='withdrawn'),withdrawn=g.members.rows.filter(r=>r.signal==='withdrawn');
    const row=(row:MilestoneView['members']['rows'][number])=><a className="dependency-row" key={row.id} href={link(arc,route().tab,'units',row.id)}><span className="unit-id">{row.id}</span><strong>{row.title}</strong><span><SignalMark state={row.signal}/>{row.state}</span>{row.replacedBy&&<small className="replaced-by">Replaced by {row.replacedBy.id}, <SignalMark state={row.replacedBy.signal}/>{row.replacedBy.state.toLowerCase()}</small>}</a>;
    return <Drawer title={`${g.id}${g.name?` ${g.name}`:''}`} close={close}>
      {(error||selected.error)&&<div><p role="alert">{error||selected.error}</p><Button onClick={reload}>Reload detail</Button></div>}
      <div className="unit-meta"><strong>{g.merged} of {pluralise(g.total,'unit')} merged</strong>{g.withdrawn>0&&<span><SignalMark state="withdrawn"/>{g.withdrawn} withdrawn</span>}<span><SignalMark state={g.passed?'passed':'pending'}/>{g.passed?'Passed':'Not passed yet'}</span><span title="Its units, their re-entries and its walkthroughs">Spend {money(g.costUsd)}</span></div>
      {g.reason&&<p className="milestone-reason">Not passed. {sentence(g.reason)}</p>}
      <Button variant="outline" onClick={()=>{close();window.dispatchEvent(new CustomEvent('roadmap-focus-milestone',{detail:id}));}}>Focus this milestone</Button>
      <section><h3>Outstanding units ({g.total-g.merged-g.withdrawn})</h3><div className="outstanding-units">{outstanding.map(row)}</div>{!outstanding.length&&!g.members.next&&<p className="muted">None</p>}</section>
      {g.withdrawn>0&&<section><h3>Withdrawn units ({g.withdrawn})</h3><div className="outstanding-units">{withdrawn.map(row)}</div></section>}<More page={g.members} load={()=>void more('members')}/>{intent}{continuations}
    </Drawer>;
  }
  const d=detail as UnitView,u=d.unit,signal=u.signal;
  const steps=d.journey.rows.filter(step=>housekeeping||!step.housekeeping);
  const gates=(items:UnitView['feeds'])=>items.map(g=><a key={g.id} href={link(arc,route().tab,'units',`milestone:${g.id}`)}>{g.id}{g.name?` ${g.name}`:''}{d.waits.includes(g)?`: ${g.passed?'passed':'pending'}`:''}</a>);
  return <Drawer title={u.title.length>96?u.title.slice(0,95)+'…':u.title} close={close} headingLink={trail.length>0&&trail.at(-1)!==id&&<a className="dependency-back" href={link(arc,route().tab,'units',trail.at(-1)!)} onClick={()=>{viaLineage.current=true;setTrail(trail.slice(0,-1));clearTrace();}}>‹ Back to {trail.at(-1)}</a>}>
    {(error||selected.error)&&<div><p role="alert">{error||selected.error}</p><Button onClick={reload}>Reload detail</Button></div>}
    {selected.data&&d.viewVersion!==selected.data.viewVersion&&<p className="notice">Newer verified detail available. <Button onClick={()=>setDetail(selected.data)}>Show updates</Button></p>}
    {u.title.length>96&&<section><h3>Recorded title</h3><p>{u.title}</p></section>}
    <div className="unit-meta"><span>{id}</span><span><SignalMark state={signal}/>{stateWords(u.state)}</span><span>{stageStatusWords(u.stage,u.stageFinished)}</span><span>{d.systems.length?`${d.systems.join(', ')} ${d.systems.length===1?'system':'systems'}`:'Systems not recorded'}</span></div>
    <dl className="unit-gates"><div><dt>Feeds</dt><dd>{d.feeds.length?gates(d.feeds):'No milestone'}</dd></div><div><dt>Waits for milestone</dt><dd>{d.waits.length?gates(d.waits):'None'}</dd></div></dl>
    {signal==='active'&&<p>{stageWords(u.stage)} is currently running.</p>}
    {signal!=='active'&&u.reasons.length>0&&<dl className="unit-gates"><div><dt>Current blocker</dt><dd>{u.reasons.join('; ')}</dd></div></dl>}
    <section className="unit-dependencies">{(['depends','usedBy'] as const).map(direction=>{const page=d[direction];return <details key={`${id}:${direction}`}><summary>{direction==='depends'?'Depends on':'Used by'} ({page.total})</summary><div>{page.rows.map(row=><a key={row.id} className="dependency-row" href={link(arc,route().tab,'units',row.id)} onMouseEnter={()=>trace(row.source,row.target)} onMouseLeave={clearTrace} onFocus={()=>trace(row.source,row.target)} onBlur={clearTrace} onClick={()=>{if(row.id!==id){viaLineage.current=true;setTrail([...trail,id]);}clearTrace();}}><span>{row.id}</span><strong>{row.title}</strong><span><SignalMark state={row.signal}/>{stateWords(row.state)}{direction==='depends'&&row.unmet&&<small>Unmet</small>}</span></a>)}<More page={page} load={()=>void more(direction)}/>{!page.total&&<p className="muted">None</p>}</div></details>;})}</section>
    <dl className="unit-facts"><div><dt>Runs</dt><dd>{u.attempts}</dd></div><div><dt>Total time</dt><dd>{elapsed(u.startedAt&&!u.endedAt&&!u.arcEndedAt?now-Date.parse(u.startedAt):u.elapsedMs)}</dd></div><div><dt>Spend</dt><dd>{u.spend.costUsd===null?'Not recorded':money(u.spend.costUsd)}</dd></div><div><dt>Build rounds</dt><dd>{u.rounds}</dd></div></dl>
    {u.reasons.length>0&&<p className="notice">{u.reasons.join('; ')}{u.waitSince&&<small>Waiting {elapsed(now-Date.parse(u.waitSince))}</small>}</p>}
    {u.lineage&&<p>Re-entry from <a href={link(arc,route().tab,'units',u.lineage.reenters)}>{u.lineage.reenters}</a>. Root <a href={link(arc,route().tab,'units',u.lineage.root)}>{u.lineage.root}</a>; {u.lineage.prepared?'prepared':'not yet prepared'}.</p>}{d.supersededBy&&<p>Superseded by <a href={link(arc,route().tab,'units',d.supersededBy)}>{d.supersededBy}</a></p>}
    <details className="detail-coverage"><summary>Measurements</summary><p>{timedWords(d.coverage.execution)}</p><p>{waitCountWords(d.coverage.waiting)}</p><p>{costWords(d.coverage.money)}</p>{d.currentBlockers?.admission.map((a,i)=><p key={i}>{plainWords(a.kind)}{a.references.length>0&&`: ${a.references.map(r=>`${plainWords(r.field).toLowerCase()} ${r.id}`).join(', ')}`}{a.scope&&`. Scope: ${a.scope}`}{a.parkClass&&`. ${holdClassWords(a.parkClass)}`}{a.reason&&`. ${plainWords(a.reason)}`}{a.probe&&`. Check: ${plainWords(a.probe.kind).toLowerCase()}${a.probe.id?` ${a.probe.id}`:''}`}{a.kind==='compare'&&`. Decision: ${a.decision??'not recorded'}`}.</p>)}{d.currentBlockers?.tokenWaitMs!=null&&<p>Waited for CPU so far: {elapsed(d.currentBlockers.tokenWaitMs)}.</p>}{!!d.currentBlockers?.drainCommands.length&&<p>Commands to finish first: {d.currentBlockers.drainCommands.join(', ')}.</p>}</details>
    <p className="muted"><Time at={d.journey.asOf.observedAt} prefix="Updated "/></p>
    <section><h3>Journey</h3><label className="housekeeping-toggle"><input type="checkbox" checked={housekeeping} onChange={ev=>setHousekeeping(ev.target.checked)}/> Show routine steps</label><div className="journey-pipeline">{steps.map(step=>{const state=!step.endedAt?'active':/fail|fault|changes requested/i.test(step.outcome)?'failed':/hold|park/i.test(step.outcome)?'held':'passed';return <a key={step.id} className="journey-block" data-state={state} href={step.activities[0]?link(arc,route().tab,'invocations',step.activities[0]):`#step-${step.id}`} onClick={ev=>{if(!step.activities.length){ev.preventDefault();const details=ev.currentTarget.closest('section')?.querySelector('details');if(details)details.open=true;requestAnimationFrame(()=>document.getElementById(`step-${step.id}`)?.scrollIntoView({block:'nearest'}));}}} title={`${step.label}, attempt ${step.attempt}: ${step.outcome}`}><span>{step.label}</span><span><SignalMark state={state}/>{state==='active'?'Running':step.outcome}</span><small>Attempt {step.attempt}</small></a>;})}</div>{!d.journey.total&&<p className="muted">No stage attempts recorded yet.</p>}<More page={d.journey} load={()=>void more('journey')}/>
    <details className="journey-details"><summary>Stage outcomes and findings</summary>{steps.map(step=><div id={`step-${step.id}`} key={step.id}><small>Round {step.round}</small><strong>{step.label} attempt {step.attempt}</strong><p>{step.outcome}</p>{step.findingTitles.map((t,i)=><p key={i}>{t}</p>)}{step.notes.map((t,i)=><p key={i}>{t}</p>)}{step.activities.length>0&&<ul>{step.activities.map((inv,i)=><li key={i}><a href={link(arc,route().tab,'invocations',inv)}>Run {inv}</a></li>)}</ul>}</div>)}</details></section>
    {d.requests.rows.map(r=><section key={r.id}><h3>{r.summary}</h3><p>{r.recommendation}</p><a href={link(arc,route().tab,'requests',r.id)}>View request and evidence</a></section>)}<More page={d.requests} load={()=>void more('requests')}/>{intent}
    <section><h3>Agent and command runs</h3><div className="invocation-list">{d.invocations.rows.map(a=><a key={a.id} className="invocation-row" href={link(arc,route().tab,'invocations',a.routeId)} aria-label={`${a.label} attempt ${a.attempt}: ${a.kind==='agentic'?'agent history':'check log'}`}><SignalMark state={a.status}/><div><strong>{a.label}</strong><small>{a.kind==='agentic'?'Agent history':'Check log'} {a.model}</small></div><span>Attempt {a.attempt}<small>Time {elapsed(a.elapsedMs??(a.status==='active'?Math.max(0,now-Date.parse(a.startedAt)):null))}</small><small>Spend {a.spend.costUsd===null?'Not recorded':money(a.spend.costUsd)}</small></span></a>)}</div><More page={d.invocations} load={()=>void more('invocations')}/>{!d.invocations.total&&<p>No runs recorded.</p>}</section>
    <section><h3>Acceptance</h3><ul>{d.acceptance.rows.map((text,i)=><li key={i}>{text}</li>)}</ul><More page={d.acceptance} load={()=>void more('acceptance')}/></section>
    {!!d.waiting.total&&<section><h3>Waits</h3>{d.waiting.rows.map((w,i)=><div className="journey-wait" key={i}><strong>{w.stage}</strong><Time at={w.at}/>{w.reasons.map(v=><p key={v.reason}>{v.reason}: {elapsed(v.ms)}</p>)}</div>)}<More page={d.waiting} load={()=>void more('waiting')}/></section>}
    <section><h3>Checks</h3>{d.checks.total?d.checks.rows.map((l,i)=><p key={i}>{l.id}: {l.outcome}</p>):<p className="muted">No check results recorded</p>}<More page={d.checks} load={()=>void more('checks')}/></section>
    {continuations}
  </Drawer>;
}
