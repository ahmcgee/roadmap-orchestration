// Console-only vocabulary and recorded journeys. Canonical status objects are never rewritten.
import type { Envelope } from '../observation/protocol.ts';
import { record } from '../tui/projection.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { readEvidence } from './evidence.ts';
import { sha256Hex } from '../core/json.ts';
import { ConsoleError } from '../observation/protocol.ts';
import { needsUserPath } from '../needsuser.ts';
import { completedWaiting } from '../status/waiting.ts';
import { resourceQueue } from './resources.ts';
import { meterOf } from '../meter.ts';
import { housekeepingStages } from './indexes.ts';
export { stageWords, stateWords, reasonWords, waitWords, shortUnitTitle } from './vocabulary.ts';
import { stageWords, stateWords, reasonWords, waitWords } from './vocabulary.ts';
import { identityIndex, stageIndex, invocationIndex } from './indexes.ts';
import { enrichReports } from './reports.ts';
export function presentation(e:Envelope){
 const s=e.data.display.status,events=e.data.events;
 const startedAt=events[0]?.at??e.observedAt;
 const ended= [...events].reverse().find(ev=>ev.type==='fact'&&['arc-completed','stop-completed'].includes(ev.fact.kind));
 const usage=meterOf(events);
 const meters=new Map<string,number>(),costCoverage=new Map<string,{recorded:number;estimated:number}>(),meteredInvocations=new Set<string>();
 for(const ev of events){
  if(ev.type!=='fact'||(ev.fact.kind!=='meter'&&ev.fact.kind!=='usage-unavailable'))continue;
  const f=ev.fact;meteredInvocations.add(f.inv);
  if(f.kind!=='meter')continue;
  meters.set(f.inv,(meters.get(f.inv)??0)+(f.usage.costUsd??0));
  if(f.subject.type==='seat'){
   const coverage=costCoverage.get(f.subject.unit)??{recorded:0,estimated:0};
   if(f.usage.costUsd!=null)coverage.recorded++;
   if(f.usage.costEstimated)coverage.estimated++;
   costCoverage.set(f.subject.unit,coverage);
  }
 }
 const reports=enrichReports(e); // Temporary legacy adapter: new view builders never call this sweep.
 const stages=stageIndex(events),{steps,byUnit}=stages;
 const invocations=invocationIndex(e.data.display.invocations,stages);
 const identities=identityIndex(e);
 const activityInfo=e.data.display.invocations.map(i=>{
  const body=record(JSON.parse(i.body)),parent=record(body['parent']);const sequence=typeof parent['attempt']==='number'?parent['attempt']:i.attempt;
  const row=steps.get(`${i.unit}:${sequence}`),report=reports.get(i.id);
  const findings=Array.isArray(report?.['findings'])?report['findings'].map(v=>{const r=record(v);return String(r['title']??r['what']??r['summary']??r['description']??'Finding recorded');}):[];
  if(row){row.activities.push(invocationDirName(invocationIdOf(i.id)));row.findingTitles.push(...findings);if(typeof report?.['decision']==='string')row.outcome=report['decision']==='revise'?'Changes requested':report['decision']==='approve'?'Approved':String(report['decision']);}
  return{id:i.id,routeId:invocationDirName(invocationIdOf(i.id)),stage:typeof parent['stage']==='string'?parent['stage']:i.role,label:i.role.startsWith('lane:')?stageWords(i.role):row?.label??stageWords(i.role),attempt:row?.attempt??1,round:row?.round??1,spend:meters.get(i.id)??0,decision:report?.['decision']??null,findings};
 });
 const waits=completedWaiting(events).measurements.filter(w=>w.waited.totalMs>0&&Object.values(w.waited.byReasonMs).some(ms=>ms!=null&&ms>0));
 const units=s.units.map(u=>{
  const specEntry=e.data.display.estate.find(r=>r.kind==='specification'&&r.id===u.unit);const spec=specEntry?record(JSON.parse(specEntry.body)):{};
  const acceptance=Array.isArray(spec['acceptance'])?spec['acceptance'].map(a=>String(record(a)['clause']??'')).filter(Boolean):[];
  const intent=typeof spec['intent']==='string'?spec['intent']:acceptance.join('\n');
  const title=identities.get(u.unit)!.title;
  const journey=byUnit.get(u.unit)??[];
  const invs=invocations.byUnit.get(u.unit)??[];const first=journey[0]?.at??invs.at(-1)?.startedAt??null;
  const last=u.state==='merged'||u.state==='cut'||u.state==='superseded'||u.state==='parked'?journey.at(-1)?.endedAt??null:null;
  const queue=s.host.queue.find(q=>q.unit===u.unit);
  const reasons=waitWords(u.waitingFor);if(u.state==='parked')reasons.push(`Parked at ${stageWords(u.stage)}${journey.at(-1)?`: ${journey.at(-1)!.outcome}`:''}`);
  if(queue?.request.publication)reasons.push(`Integration queue position ${resourceQueue(s.host).filter(q=>q.request.publication).findIndex(q=>q.unit===u.unit)+1}`);
  const charged=usage.byUnit.filter(t=>t.unit===u.unit);
  const spendCoverage={...(costCoverage.get(u.unit)??{recorded:0,estimated:0}),unavailable:charged.reduce((n,t)=>n+t.unavailable,0)+invs.filter(i=>i.execution==='agent'&&!meteredInvocations.has(i.id)).length};
  return{id:u.unit,title,intent,summary:acceptance[0]??title,acceptance,state:stateWords(u.state),stage:stageWords(u.stage),startedAt:first,endedAt:last,elapsedMs:first?Math.max(0,Date.parse(last??ended?.at??e.checkedAt)-Date.parse(first)):null,rounds:Math.max(0,...journey.map(r=>r.round)),attempts:journey.length,redChecks:invs.filter(i=>i.execution==='command'&&(/fail/.test(i.state)||record(record(JSON.parse(i.body))['settlement'])['outcome']&&JSON.stringify(JSON.parse(i.body).settlement).includes('"verdict":"fail"'))).length,spend:charged.reduce((n,t)=>n+t.costUsd,0),spendCoverage,reasons,waitSince:queue?.queuedAt!==undefined?new Date(queue.queuedAt).toISOString():null,journey,lineage:u.lineage,waiting:waits.filter(w=>w.source==='admission'?w.unit===u.unit:w.parent.type==='stage'&&w.parent.unit===u.unit).map(w=>({at:w.at,stage:stageWords(w.source==='admission'?w.stage:w.parent.type==='stage'?w.parent.stage:'resource'),totalMs:w.waited.totalMs,reasons:Object.entries(w.waited.byReasonMs).filter(([,ms])=>ms!=null&&ms>0).map(([reason,ms])=>({reason:reasonWords(reason),ms}))}))};
 });
 const feed:{id:number;at:string;text:string;unit?:string;invocation?:string;tab?:string;housekeeping?:boolean}[]=[];
 for(const ev of events){
  if(ev.type==='fact'){const f=ev.fact;
   if(f.kind==='stage-outcome'&&'unit'in f){const row=steps.get(`${f.unit}:${f.attempt}`);let text=`${f.unit}: ${stageWords(f.stage)} — ${row?.outcome??f.outcome}`;if(f.stage==='ff'&&f.outcome==='published')text=`${f.unit} merged`;if(f.class==='park')text=`${f.unit} parked at ${stageWords(f.stage)}: ${row?.outcome}`;if(f.stage==='gate'&&f.outcome==='revise')text=`Review sent ${f.unit} back: ${row?.findingTitles[0]??'changes requested'}`;feed.push({id:ev.seq,at:ev.at,text,unit:f.unit,housekeeping:housekeepingStages.has(f.stage)&&f.class==='advance'});}
   else if(f.kind==='plan-applied')feed.push({id:ev.seq,at:ev.at,text:`Plan revision ${f.rev} applied`});
   else if(f.kind==='arc-completed')feed.push({id:ev.seq,at:ev.at,text:'Arc completed'});
   else if(f.kind==='stop-completed')feed.push({id:ev.seq,at:ev.at,text:'Arc stopped'});
   else if(f.kind==='needs-user-acked')feed.push({id:ev.seq,at:ev.at,text:`Human request ${f.id} acknowledged`,tab:'attention'});
   else if(f.kind==='audit-ended')feed.push({id:ev.seq,at:ev.at,text:`Holistic audit ${f.outcome}: ${f.findings.length} ${f.findings.length===1?'finding':'findings'}`,tab:'activity'});
  }
  if(ev.type==='intent'&&ev.kind==='needsuser.raise'){
   const open=e.data.requests.find(r=>r.id===ev.expect.id);let summary=open?.summary;
   if(summary===undefined){try{const bytes=readEvidence(e.data.display.run.runDir,needsUserPath(e.data.display.run.runDir,ev.expect.id));if(sha256Hex(bytes)!==ev.post.sha256)throw new ConsoleError('invalid','retained request does not match its recorded digest');summary=String(record(JSON.parse(bytes.toString('utf8')))['summary']);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
   feed.push({id:ev.seq,at:ev.at,text:`Question raised: ${summary??'request no longer retained'}`,tab:'attention',...(open?.subject.type==='unit'?{unit:open.subject.unit}:{})});
  }
 }
 return {run:{state:stateWords(ended?.type==='fact'&&ended.fact.kind==='stop-completed'?'no-owner':s.run.state),startedAt,endedAt:ended?.at??null,elapsedMs:Math.max(0,Date.parse(ended?.at??e.checkedAt)-Date.parse(startedAt))},units,activityInfo,feed:feed.reverse(),cpuCapacity:s.host.pools['@cpu']?.size??null,holistic:{enabled:s.holistic,activeFindings:s.findings.active,audit:s.audit,audits:events.flatMap(ev=>ev.type==='fact'&&ev.fact.kind==='audit-ended'?[{at:ev.at,...ev.fact}]:[]),checkpoint:s.decisionsSince},waitReasonCounts:waits.flatMap(w=>Object.entries(w.waited.byReasonMs).filter(([,ms])=>ms!=null&&ms>0)).reduce<Record<string,number>>((out,[reason])=>{const key=reasonWords(reason);out[key]=(out[key]??0)+1;return out;},{}),waitReasons:waits.flatMap(w=>Object.entries(w.waited.byReasonMs)).reduce<Record<string,number>>((out,[reason,ms])=>{const key=reasonWords(reason);out[key]=(out[key]??0)+(ms??0);return out;},{})};
}
