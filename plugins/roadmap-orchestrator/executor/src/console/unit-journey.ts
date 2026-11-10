// D1/D2/D3/D5: selected unit journey and specification only. Reports are
// enriched solely for stage identities displayed on the selected detail page.
import type { Envelope } from '../observation/protocol.ts';
import { ConsoleError } from '../observation/protocol.ts';
import { record } from '../tui/projection.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { completedWaiting } from '../status/waiting.ts';
import { resourceQueue } from './resources.ts';
import { stageWords, stateWords, reasonWords, waitWords } from './vocabulary.ts';
import { identityIndex, journeyMs, stageIndex, invocationIndex } from './indexes.ts';
import { enrichReports } from './reports.ts';
import { milestoneReasons } from './milestones.ts';
export function selectedUnitJourney(e:Envelope, selectedUnit: string, reportStepIds: ReadonlySet<string>){
 const s=e.data.display.status,events=e.data.events;
 const ended= [...events].reverse().find(ev=>ev.type==='fact'&&['arc-completed','stop-completed'].includes(ev.fact.kind));
 const selectedInvocations=e.data.display.invocations.filter(i=>i.unit===selectedUnit);
 const reports=enrichReports(e,selectedInvocations.filter(i=>{const parent=record(record(JSON.parse(i.body))['parent']);return reportStepIds.has(`${i.unit}:${parent['attempt']}`);}));
 const stages=stageIndex(events),{steps,byUnit}=stages;
 const invocations=invocationIndex(e.data.display.invocations,stages);
 const identities=identityIndex(e);
 for(const i of selectedInvocations){
  const body=record(JSON.parse(i.body)),parent=record(body['parent']);const sequence=typeof parent['attempt']==='number'?parent['attempt']:i.attempt;
  const row=steps.get(`${i.unit}:${sequence}`),report=reports.get(i.id);
  const findings=Array.isArray(report?.['findings'])?report['findings'].map(v=>{const r=record(v);return String(r['title']??r['what']??r['summary']??r['description']??'Finding recorded');}):[];
  if(row){row.activities.push(invocationDirName(invocationIdOf(i.id)));row.findingTitles.push(...findings);if(typeof report?.['decision']==='string')row.outcome=report['decision']==='revise'?'Changes requested':report['decision']==='approve'?'Approved':String(report['decision']);}
 }
 const waits=completedWaiting(events).measurements.filter(w=>w.waited.totalMs>0&&Object.values(w.waited.byReasonMs).some(ms=>ms!=null&&ms>0));
 const u=s.units.find(u=>u.unit===selectedUnit);
 if(!u)throw new ConsoleError('not-found','unit is not in the applied plan');
  const specEntry=e.data.display.estate.find(r=>r.kind==='specification'&&r.id===u.unit);const spec=specEntry?record(JSON.parse(specEntry.body)):{};
  const acceptance=Array.isArray(spec['acceptance'])?spec['acceptance'].map(a=>String(record(a)['clause']??'')).filter(Boolean):[];
  const intent=typeof spec['intent']==='string'?spec['intent']:acceptance.join('\n');
  const title=identities.get(u.unit)!.title;
  const journey=byUnit.get(u.unit)??[];
  const invs=invocations.byUnit.get(u.unit)??[];const first=journey[0]?.at??invs.at(-1)?.startedAt??null;
  const last=u.state==='merged'||u.state==='cut'||u.state==='superseded'||u.state==='parked'?journey.at(-1)?.endedAt??null:null;
  const queue=s.host.queue.find(q=>q.unit===u.unit);
  const reasons=waitWords(u.waitingFor,milestoneReasons(e));if(u.state==='parked')reasons.push(`Parked at ${stageWords(u.stage)}${journey.at(-1)?`: ${journey.at(-1)!.outcome}`:''}`);
  if(queue?.request.publication)reasons.push(`Integration queue position ${resourceQueue(s.host).filter(q=>q.request.publication).findIndex(q=>q.unit===u.unit)+1}`);
  return{id:u.unit,title,intent,summary:acceptance[0]??title,acceptance,state:stateWords(u.state),stage:stageWords(u.stage),startedAt:first,endedAt:last,elapsedMs:journeyMs(first,last,ended?.at??e.checkedAt),rounds:Math.max(0,...journey.map(r=>r.round)),attempts:journey.length,reasons,waitSince:queue?.queuedAt!==undefined?new Date(queue.queuedAt).toISOString():null,journey,lineage:u.lineage,waiting:waits.filter(w=>w.source==='admission'?w.unit===u.unit:w.parent.type==='stage'&&w.parent.unit===u.unit).map(w=>({at:w.at,stage:stageWords(w.source==='admission'?w.stage:w.parent.type==='stage'?w.parent.stage:'resource'),totalMs:w.waited.totalMs,reasons:Object.entries(w.waited.byReasonMs).filter(([,ms])=>ms!=null&&ms>0).map(([reason,ms])=>({reason:reasonWords(reason),ms}))}))};
}
