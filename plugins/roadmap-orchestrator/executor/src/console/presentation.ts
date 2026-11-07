// Console-only vocabulary and recorded journeys. Canonical status objects are never rewritten.
import type { Envelope } from '../observation/protocol.ts';
import type { WaitingFor } from '../status.ts';
import { record } from '../tui/projection.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { readEvidence } from './evidence.ts';
import { join } from 'node:path';
import { sha256Hex } from '../core/json.ts';
import { ConsoleError } from '../observation/protocol.ts';
import { needsUserPath } from '../needsuser.ts';
import { completedWaiting } from '../status/waiting.ts';
export const stageWords = (stage:string):string => ({'pre-build':'Plan review',build:'Build',lanes:'Checks',gate:'Review',candidate:'Integration check',ff:'Merge',snapshot:'Publish snapshot',retire:'Complete',prepare:'Prepare re-entry',quiesce:'Stop workloads',evidence:'Collect evidence',salvage:'Save changes',teardown:'Release resources',reproduce:'Reproduce finding',verifier:'Review',baseline:'Baseline checks','campaign-audit':'Holistic audit','experience-verdict':'Experience review'}[stage] ?? (stage.startsWith('lane:')?`Check: ${stage.slice(5)}`:stage.replaceAll('-',' ')));
export const stateWords = (state:string):string => ({running:'Running',preparing:'Preparing',ready:'Ready',waiting:'Waiting',held:'On hold',blocked:'Blocked',parked:'Parked',merged:'Merged',cut:'Withdrawn',superseded:'Replaced','awaiting-admission':'Waiting',complete:'Complete',draining:'Draining',stopping:'Stopping','no-owner':'Stopped',refused:'Refused'}[state] ?? state);
export const reasonWords = (reason:string):string => ({'cpu-tokens':'CPU capacity','cpu-pressure':'CPU pressure','memory-pressure':'Memory pressure','publication-slot':'Integration slot','admission-hold:base-red':'Baseline hold','admission-hold:dependency':'Dependency','admission-hold:milestone':'Milestone gate','admission-hold:paused':'Paused','admission-hold:host-pressure':'Host pressure'}[reason] ?? reason.replace(/^admission-hold:/,'').replace(/^named-resource:/,'Resource: ').replaceAll('-',' '));
export function waitWords(w:WaitingFor|null):string[] {
 if(!w)return[];
 const out=[...w.deps.map(d=>`Dependency on ${d}`),...w.milestones.map(m=>`Milestone ${m} has not passed`),...w.edges.map(d=>`Waiting for decision ${d}`)];
 for(const a of w.admission){switch(a.type){case 'dependency':out.push(`Dependency on ${a.unit}`);break;case 'milestone':out.push(`Milestone ${a.milestone} has not passed`);break;case 'base-red':out.push('Baseline hold: baseline checks are failing');break;case 'blocking-item':out.push(`Human decision needed: ${a.id}`);break;case 'host-pressure':out.push('Host CPU pressure');break;case 'known-defect':out.push(`Waiting for fix from ${a.fixUnit}`);break;case 'backend-parked':out.push(`${a.backend} is parked`);break;default:out.push(reasonWords(a.type));}}
 if(w.pressureBlocked)out.push('Host CPU or memory pressure');if(w.envBlocked)out.push('Resource environment is unavailable');
 if(w.resources){if(w.resources.publication)out.push('Queued for the integration slot');if(w.resources.cpu)out.push(`Waiting for ${w.resources.cpu} CPU cores`);for(const r of [...w.resources.named,...w.resources.pools])out.push(`Waiting for resource ${r}`);}
 return [...new Set(out)];
}
const housekeepingStages=new Set(['quiesce','evidence','salvage','teardown']);
const outcomeWords=(outcome:string)=>({empty:'No workloads running',captured:'Evidence captured',committed:'Changes saved','committed-contract-touched':'Changes saved; contract updated',released:'Resources released','cleanup-failed':'Cleanup failed','executor-fault':'Executor fault','commit-failed':'Commit failed',unmerged:'Unmerged changes',approve:'Approved',revise:'Changes requested',green:'Passed',success:'Succeeded',published:'Published','process-fault':'Process fault',red:'Failed'}[outcome]??outcome.replaceAll('-',' '));
type Step={housekeeping:boolean;id:string;stage:string;label:string;attempt:number;sequence:number;round:number;at:string;endedAt:string|null;outcome:string;findingTitles:string[];activities:string[];notes:string[]};
/** Human display text is separate from the complete agent-facing intent. */
export function shortUnitTitle(intent: string, fallback = 'Untitled unit'): string {
 const prose = intent
  .replace(/\b(?:contract|spec):[\w:#./-]+/gi, '')
  .replace(/`[^`]+`/g, '')
  .replace(/(?:https?:\/\/|(?:\.?\.?\/)?[\w@*{}.-]+\/)[^\s,;]+/g, '')
  .replace(/\b[\w*-]+\.(?:[cm]?[jt]sx?|json|md|css|html|ya?ml|toml|sh)\b/g, '')
  .replace(/\b(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:[_-][a-z0-9]+)+)\b/g, '')
  .split(/(?:[.;!?](?:\s|$)|\n|:\s)/, 1)[0]!
  .replace(/\s+/g, ' ').replace(/^[\s,:–—-]+|[\s,:–—-]+$/g, '').trim();
 const value = prose || fallback;
 // Keep both the action and the subject: sibling intents often differ only at the end.
 if (value.length <= 60) return value;
 const words=value.split(' ');let tail='';
 while(words.length){const candidate=words.at(-1)!+(tail?' '+tail:'');if(candidate.length>36)break;tail=candidate;words.pop();}
 const budget=60-tail.length-2;
 const head=words.join(' ').slice(0,budget).replace(/\s+\S*$/, '').trimEnd();
 return `${head}… ${tail}`;
}
export function presentation(e:Envelope){
 const s=e.data.display.status,events=e.data.events;
 const startedAt=events[0]?.at??e.observedAt;
 const ended= [...events].reverse().find(ev=>ev.type==='fact'&&['arc-completed','stop-completed'].includes(ev.fact.kind));
 const meters=new Map<string,number>();for(const ev of events)if(ev.type==='fact'&&ev.fact.kind==='meter')meters.set(ev.fact.inv,(meters.get(ev.fact.inv)??0)+(ev.fact.usage.costUsd??0));
 const reports=new Map<string,Record<string,unknown>>();
 for(const inv of e.data.display.invocations)if(inv.execution==='agent'){
  const settlement=record(record(JSON.parse(inv.body))['settlement']);
  const terminal=record(settlement['outcome']);
  if(terminal['kind']!=='result')continue;
  let bytes:Buffer;try{bytes=readEvidence(e.data.display.run.runDir,join(invocationDir(e.data.display.run.runDir,invocationIdOf(inv.id)),'result.json'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  if(sha256Hex(bytes)!==terminal['resultSha256'])throw new ConsoleError('invalid','retained agent report does not match its recorded digest');
  const result=record(JSON.parse(bytes.toString('utf8'))),outcome=record(result['outcome']);
  if(result['type']==='backend'&&outcome['kind']==='success')reports.set(inv.id,record(outcome['value']));
 }
 const steps=new Map<string,Step>();const counts=new Map<string,number>();const rounds=new Map<string,number>();
 const step=(unit:string,stage:string,sequence:number,at:string)=>{
  const id=`${unit}:${sequence}`;let row=steps.get(id);if(row)return row;
  const key=`${unit}:${stage}`,attempt=(counts.get(key)??0)+1;counts.set(key,attempt);
  let round=rounds.get(unit)??1;if(stage==='build'&&attempt>1)round++;rounds.set(unit,round);
  row={housekeeping:false,id,stage,label:stageWords(stage),attempt,sequence,round,at,endedAt:null,outcome:'In progress',findingTitles:[],activities:[],notes:[]};steps.set(id,row);return row;
 };
 for(const ev of events){
  if(ev.type==='intent'&&ev.parent.type==='stage')step(ev.parent.unit,ev.parent.stage,ev.parent.attempt,ev.at);
  if(ev.type==='fact'&&ev.fact.kind==='stage-outcome'&&'unit'in ev.fact){const f=ev.fact;const row=step(f.unit,f.stage,f.attempt,ev.at);row.endedAt=ev.at;row.outcome=outcomeWords(f.outcome);row.housekeeping=housekeepingStages.has(f.stage)&&f.class==='advance';if(f.class==='park')row.notes.push(`Parked: ${row.outcome}`);if(f.class==='hold')row.notes.push(`On hold: ${row.outcome}`);}
 }
 // Retirement has no stage-outcome fact: its recorded operations are its completion evidence.
 const settlements=new Map(events.filter(ev=>ev.type==='done').map(ev=>[ev.op,ev]));
 for(const row of steps.values())if(row.stage==='retire'){
  const intents=events.filter(ev=>ev.type==='intent'&&ev.parent.type==='stage'&&`${ev.parent.unit}:${ev.parent.attempt}`===row.id);
  const done=intents.map(i=>'op'in i?settlements.get(i.op):undefined);
  if(intents.length&&done.every(Boolean)){row.outcome='Done';row.endedAt=done.reduce((last,ev)=>ev!.seq>last!.seq?ev:last)!.at;}
 }
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
  const existingTitle=typeof spec['title']==='string'&&spec['title'].trim()?spec['title']:acceptance[0];
  const title=existingTitle&&existingTitle.length<=60?existingTitle:shortUnitTitle(intent,String(u.unit));
  const journey=[...steps.values()].filter(st=>st.id.startsWith(`${u.unit}:`));
  const invs=e.data.display.invocations.filter(i=>i.unit===u.unit);const first=journey[0]?.at??invs.at(-1)?.startedAt??null;
  const last=u.state==='merged'||u.state==='cut'||u.state==='superseded'||u.state==='parked'?journey.at(-1)?.endedAt??null:null;
  const queue=s.host.queue.find(q=>q.unit===u.unit);
  const reasons=waitWords(u.waitingFor);if(u.state==='parked')reasons.push(`Parked at ${stageWords(u.stage)}${journey.at(-1)?`: ${journey.at(-1)!.outcome}`:''}`);
  if(queue?.request.publication)reasons.push(`Integration queue position ${s.host.queue.filter(q=>q.request.publication).findIndex(q=>q.unit===u.unit)+1}`);
  return{id:u.unit,title,intent,summary:acceptance[0]??title,acceptance,state:stateWords(u.state),stage:stageWords(u.stage),startedAt:first,endedAt:last,elapsedMs:first?Math.max(0,Date.parse(last??ended?.at??e.checkedAt)-Date.parse(first)):null,rounds:Math.max(0,...journey.map(r=>r.round)),attempts:journey.length,redChecks:invs.filter(i=>i.execution==='command'&&(/fail/.test(i.state)||record(record(JSON.parse(i.body))['settlement'])['outcome']&&JSON.stringify(JSON.parse(i.body).settlement).includes('"verdict":"fail"'))).length,spend:invs.reduce((n,i)=>n+(meters.get(i.id)??0),0),reasons,waitSince:queue?.queuedAt?new Date(queue.queuedAt).toISOString():null,journey,lineage:u.lineage,waiting:waits.filter(w=>w.source==='admission'?w.unit===u.unit:w.parent.type==='stage'&&w.parent.unit===u.unit).map(w=>({at:w.at,stage:stageWords(w.source==='admission'?w.stage:w.parent.type==='stage'?w.parent.stage:'resource'),totalMs:w.waited.totalMs,reasons:Object.entries(w.waited.byReasonMs).filter(([,ms])=>ms!=null&&ms>0).map(([reason,ms])=>({reason:reasonWords(reason),ms}))}))};
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
 return {run:{state:stateWords(ended?.type==='fact'&&ended.fact.kind==='stop-completed'?'no-owner':s.run.state),startedAt,endedAt:ended?.at??null,elapsedMs:Math.max(0,Date.parse(ended?.at??e.checkedAt)-Date.parse(startedAt))},units,activityInfo,feed:feed.reverse(),cpuCapacity:s.host.pools['@cpu']?.size??null,holistic:{enabled:s.holistic,activeFindings:s.findings.active,audit:s.audit,audits:events.filter(ev=>ev.type==='fact'&&ev.fact.kind==='audit-ended').map(ev=>({at:ev.at,...(ev.type==='fact'?ev.fact:{})})),checkpoint:s.decisionsSince},waitReasonCounts:waits.flatMap(w=>Object.entries(w.waited.byReasonMs).filter(([,ms])=>ms!=null&&ms>0)).reduce<Record<string,number>>((out,[reason])=>{const key=reasonWords(reason);out[key]=(out[key]??0)+1;return out;},{}),waitReasons:waits.flatMap(w=>Object.entries(w.waited.byReasonMs)).reduce<Record<string,number>>((out,[reason,ms])=>{const key=reasonWords(reason);out[key]=(out[key]??0)+(ms??0);return out;},{})};
}
