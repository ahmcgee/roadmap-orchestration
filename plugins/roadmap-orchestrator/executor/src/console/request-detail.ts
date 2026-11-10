// Selected record paths derive only from validated request IDs in this Arc.
import { canonicalJson } from '../core/json.ts';
import { activityKey } from './backend-holds.ts';
import { needsUserId, invocationDirName, invocationIdOf } from '../core/ids.ts';
import { needsUserRecord, needsUserAck, type NeedsUserRecord } from '../core/records.ts';
import { needsUserPath, needsUserAckPath } from '../needsuser.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { activityRequest } from './activity-index.ts';
import { readEvidence } from './evidence.ts';
import { identityIndex } from './indexes.ts';
import { versioned } from './views.ts';
import { allowParams, invalid } from './query-params.ts';
import { boundDetail, contentDetail } from './detail-content.ts';
import type { RequestView, RequestResolution } from './attention-protocol.ts';

function selected(e: Envelope, id: string): NeedsUserRecord | null {
  let key: ReturnType<typeof needsUserId>;
  try {key=needsUserId(id);} catch {return invalid('invalid request ID');}
  const raise=e.data.events.find(ev=>ev.type==='intent'&&ev.kind==='needsuser.raise'&&ev.expect.id===key);
  if(raise?.type==='intent'&&raise.kind==='needsuser.raise')return activityRequest(e,{id,sha256:raise.post.sha256});
  // nu IDs must have a recorded raise; only the canonical file-only namespaces can stand alone.
  if(!id.startsWith('sup-')&&!id.startsWith('host-'))throw new ConsoleError('not-found','Request is not recorded in this Arc');
  let bytes:Buffer;
  try {bytes=readEvidence(e.data.display.run.runDir,needsUserPath(e.data.display.run.runDir,key));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){if(resolution(e,id,false).some(row=>row.source!=='open-list'))return null;throw new ConsoleError('not-found','Request is not retained in this Arc');}throw error;}
  const r=needsUserRecord(JSON.parse(bytes.toString('utf8')),'selected request');
  if(r.id!==id||r.arc!==e.arc)throw new ConsoleError('corruption','Request identity does not match this Arc');
  return r;
}
// These conditions mirror commands/apply.ts's ack admission; no new subject action is invented.
const cliToken=(value:string)=>/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
export function requestGuidance(r:NeedsUserRecord) {
  const command=r.options.length===0&&(r.subject.type==='arc'||r.reason==='pack-review')&&cliToken(r.id)?`roadmap ack ${r.id}`:null;
  return {command,text:r.options.length?'Run one of these commands to respond.':command?'After reviewing and resolving or explicitly accepting this item, respond in your terminal.':'Respond using the CLI. Follow the recorded recommendation and act on the request’s subject.'};
}
function resolution(e:Envelope,id:string,open:boolean):RequestResolution[] {
  const fact=e.data.events.findLast(ev=>ev.type==='fact'&&ev.fact.kind==='needs-user-acked'&&ev.fact.id===id);
  const rows:RequestResolution[]=[];
  if(fact?.type==='fact'&&fact.fact.kind==='needs-user-acked')rows.push({kind:fact.fact.command===null?'declined':'acknowledged',source:'journal',at:fact.at,command:fact.fact.command,choice:fact.fact.choice});
  try {
    const ack=needsUserAck(JSON.parse(readEvidence(e.data.display.run.runDir,needsUserAckPath(e.data.display.run.runDir,needsUserId(id))).toString('utf8')),'selected request acknowledgement');
    if(ack.id!==id)throw new ConsoleError('corruption','Acknowledgement identity does not match its request');
    if(rows.length&&(rows[0]!.command!==ack.command||rows[0]!.choice!==ack.choice))throw new ConsoleError('corruption','Acknowledgement file and journal disagree');
    rows.push({kind:'acknowledged',source:'ack-file',at:ack.at,command:ack.command,choice:ack.choice});
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!open&&!rows.length)rows.push({kind:'no-longer-open',source:'open-list',at:null,command:null,choice:null});
  return rows;
}
function rawDetail(e:Envelope,id:string):RequestView {
  const r=selected(e,id),captured=e.data.requests.find(r=>r.id===id),open=!!captured,identities=identityIndex(e);
  if(r&&captured&&canonicalJson(r)!==canonicalJson(captured))throw new ConsoleError('conflict','Request changed during verification; retry this detail');
  const resolutionEvidence=resolution(e,id,open);
  if(r&&!id.startsWith('nu-')&&!open&&!resolutionEvidence.some(row=>row.source!=='open-list'))throw new ConsoleError('conflict','File-only request is outside the verified open list; retry this detail');
  if(open&&resolutionEvidence.length)throw new ConsoleError('conflict','Request acknowledgement changed during verification; retry this detail');
  const subject:RequestView['recordPreview']=!r?null:{raisedAt:r.raisedAt,blocking:r.blocking,reason:r.reason,
    subject:r.subject.type==='unit'?{type:'unit',id:r.subject.unit,title:identities.get(r.subject.unit)?.title??r.subject.unit}:r.subject.type==='findings'?{type:'findings',count:r.subject.findings.length}:{type:r.subject.type}};
  const affected=new Set<string>(r?.subject.type==='unit'&&identities.has(r.subject.unit)?[r.subject.unit]:[]);
  // Admission references name actual affected units, rather than guessed descendant impact.
  for(const u of e.data.display.status.units)if(u.waitingFor?.admission.some(a=>a.type==='blocking-item'&&a.id===id))affected.add(u.unit);
  const routes=new Set(e.data.display.invocations.map(i=>invocationDirName(invocationIdOf(i.id))));
  return versioned({id,open,evidenceAvailability:r?'available' as const:'pruned' as const,recordPreview:subject,resolutionEvidence,
    fields:{summary:r?.summary??'',recommendation:r?.recommendation??''},
    options:r?.options.map(o=>({id:o.id,label:o.label,command:open&&cliToken(r.id)&&cliToken(o.id)?`roadmap ack ${r.id} --choice ${o.id}`:null}))??[],
    evidenceRefs:r?.evidence.map(path=>{const route=/\/inv\/([1-9][0-9]*-[1-9][0-9]*)(?:\/|$)/.exec(path)?.[1];return {path,invocation:route&&routes.has(route)?route:null};})??[],
    affectedUnits:[...affected].map(id=>({id,title:identities.get(id)?.title??id})),findingRefs:r?.subject.type==='findings'?r.subject.findings.map(id=>{const source=e.data.events.find(ev=>ev.type==='fact'&&ev.fact.kind==='finding-opened'&&ev.fact.id===id);return {id,event:source?activityKey(e.epoch,source.seq,'finding-opened'):null};}):[],
    guidance:r&&open?requestGuidance(r):{command:null,text:r?'This request is no longer open.':'Request evidence has been pruned; no response command is inferred.'}}, {basis:'current',from:null,to:null});
}
export function requestDetail(e:Envelope,id:string,params:Record<string,string>) {
  allowParams(params,['section','cursor']);
  if(params['section']!==undefined&&params['section']!=='content'||params['cursor']!==undefined&&params['section']!=='content'||params['section']==='content'&&!params['cursor'])invalid('Request field expansion requires section=content and its cursor');
  const data=rawDetail(e,id),entity=`request:${id}`;
  if(params['section']==='content'){
    if(data.evidenceAvailability==='pruned')throw new ConsoleError('reset','Request evidence was pruned; reopen this request');
    return contentDetail(e,entity,params['cursor']!,16*1024);
  }
  return boundDetail(e,entity,data,32*1024,current=>rawDetail(current,id));
}
