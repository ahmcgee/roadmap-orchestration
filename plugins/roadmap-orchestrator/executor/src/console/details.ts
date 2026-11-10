import { detailAvailability } from './detail-metadata.ts';
import { completedWaiting } from '../status/waiting.ts';
import { boundDetail, contentDetail } from './detail-content.ts';
import { sha256Hex } from '../core/json.ts';
import { createHmac, randomBytes } from 'node:crypto';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { record } from '../tui/projection.ts';
import { selectedUnitJourney } from './unit-journey.ts';
import { stageFinished } from './indexes.ts';
import { projectionIndex, timelineIntervals } from './tab-projections.ts';
import { graphStatus } from './signals.ts';
import { stageWords, stateWords } from './vocabulary.ts';
import { arcBounds, versioned } from './views.ts';
import type { DetailPage, InvocationSummary, UnitSummary, RelatedUnit, UnitView, MilestoneView, InvocationView } from './detail-protocol.ts';
// Immutable selected collections only, never canonical observations. LRU generations
// survive unrelated appends; replacement epochs and eviction require an explicit reopen.
const generations=new Map<string,{sourceHash:string;revision:number;rows:unknown[];hashes:string[]|null;ids:string[];bytes:number;touched:number;asOf:{epoch:string;highWater:number;observedAt:string}}>();
let generationBytes=0;
const MAX_GENERATION_BYTES=16*1024*1024;
function rowHash(row:unknown,section:string){return sha256Hex(JSON.stringify(section==='journey'?(row as {id:string}).id:row));}
function remember(e:Envelope,rows:unknown[],section:string) {
  let bytes=Buffer.byteLength(JSON.stringify(rows));
  // Oversized text is already held by verified sources. Retain its fingerprint
  // and ordering rather than another multi-megabyte copy; changed selected
  // evidence then produces an explicit reset, while unrelated appends survive.
  const hashes=bytes>MAX_GENERATION_BYTES?rows.map(r=>rowHash(r,section)):null;
  if(hashes)bytes=hashes.length*128;
  if(bytes>MAX_GENERATION_BYTES)throw new ConsoleError('unavailable','Selected collection index exceeds retained paging capacity');
  const key=randomBytes(12).toString('hex');generations.set(key,{sourceHash:sha256Hex(e.data.capture.source),revision:e.revision,rows:hashes?[]:structuredClone(rows),hashes,ids:section==='journey'?rows.map(r=>(r as {id:string}).id):[],bytes,touched:Date.now(),asOf:{epoch:e.epoch,highWater:e.highWater,observedAt:e.observedAt}});generationBytes+=bytes;
  while(generations.size>64||generationBytes>MAX_GENERATION_BYTES){const k=generations.keys().next().value!;generationBytes-=generations.get(k)!.bytes;generations.delete(k);}
  return key;
}
const cursorSecret=randomBytes(32);
const signature=(value:string)=>createHmac('sha256',cursorSecret).update(value).digest('hex');
const token=(value:unknown)=>{const raw=Buffer.from(JSON.stringify(value)).toString('base64url');return `${raw}.${signature(raw)}`;};
const limitOf=(params:Record<string,string>)=>Number(params['limit']??'25');
const scope = {basis:'current' as const,from:null,to:null};
function cursorOf(e:Envelope,params:Record<string,string>, section:string) {
  const cursor=params['cursor'];if(!cursor)return null;
  if(cursor.length>1024)throw new ConsoleError('invalid','invalid detail cursor');
  let parsed:{version:string;section:string;offset:number;arc:string;epoch:string;entity:string;limit:number;instance:string;repoId:string};
  try {const [raw,sig]=cursor.split('.');if(!raw||sig!==signature(raw)||cursor.split('.').length!==2)throw Error();parsed=JSON.parse(Buffer.from(raw,'base64url').toString());}catch{throw new ConsoleError('invalid','invalid detail cursor');}
  if(parsed.limit!==(section==='intent'?4096:limitOf(params))||parsed.entity!==params['_entity']||parsed.instance!==e.instance||parsed.repoId!==e.repoId||parsed.arc!==e.arc||parsed.epoch!==e.epoch||parsed.section!==section||!Number.isSafeInteger(parsed.offset)||parsed.offset<0)throw new ConsoleError('invalid','foreign detail cursor');
  if(!generations.has(parsed.version)||Date.now()-generations.get(parsed.version)!.touched>15*60*1000)throw new ConsoleError('reset','Detail page expired; reopen this detail');
  const retained=generations.get(parsed.version)!;
  if(retained.sourceHash!==sha256Hex(e.data.capture.source)&&e.revision<=retained.revision&&e.highWater<=retained.asOf.highWater)throw new ConsoleError('reset','Observation capture changed without a newer verified prefix; reopen this detail');
  retained.touched=Date.now();generations.delete(parsed.version);generations.set(parsed.version,retained);
  return parsed;
}
function offset(e:Envelope,params:Record<string,string>,section:string){return cursorOf(e,params,section)?.offset??0;}
function page<T>(e:Envelope,rows:T[],params:Record<string,string>,section:string):DetailPage<T> {
  const c=params['section']===section?cursorOf(e,params,section):null;
  const retained=c?generations.get(c.version)!:null;
  const current=retained?.hashes?new Map(rows.map(row=>[rowHash(row,section),row])):null;
  const frozen=retained?.hashes?retained.hashes.map(hash=>{if(!current!.has(hash))throw new ConsoleError('reset','Selected oversized field changed; reopen this detail');return current!.get(hash)!;}):retained?retained.rows as T[]:rows;
  const start=c?.offset??0,end=Math.min(start+limitOf(params),frozen.length);
  // Re-read selected reports for precisely these stage identities. Never reuse cached
  // report bytes to bypass digest/containment verification, even on a retained page.
  const selected=frozen.slice(start,end).map(row=>section==='journey'?(rows.find(r=>(r as any).id===(row as any).id)??row):row);
  const generation=end<frozen.length?(c?.version??remember(e,frozen,section)):null;
  return {rows:selected,total:frozen.length,asOf:c?generations.get(c.version)!.asOf:{epoch:e.epoch,highWater:e.highWater,observedAt:e.observedAt},next:generation?token({version:generation,arc:e.arc,epoch:e.epoch,instance:e.instance,repoId:e.repoId,entity:params['_entity'],section,offset:end,limit:limitOf(params)}):null};
}
function text(e:Envelope,value:string,params:Record<string,string>) {
  const c=params['section']==='intent'?cursorOf(e,params,'intent'):null;
  const retained=c?generations.get(c.version)!:null;
  if(retained?.hashes&&rowHash(value,'intent')!==retained.hashes[0])throw new ConsoleError('reset','Selected oversized intent changed; reopen this detail');
  const frozen=retained&&!retained.hashes?retained.rows[0] as string:value;
  const start=c?.offset??0,end=Math.min(start+4096,frozen.length);
  const generation=end<frozen.length?(c?.version??remember(e,[frozen],'intent')):null;
  return {text:frozen.slice(start,end),next:generation?token({version:generation,arc:e.arc,epoch:e.epoch,instance:e.instance,repoId:e.repoId,entity:params['_entity'],section:'intent',offset:end,limit:4096}):null};
}
/** `index` lets one selected-detail read share a single projection index. */
export function invocationSummaries(e:Envelope,index=projectionIndex(e)):InvocationSummary[] {
  const intervals=timelineIntervals(e,index);
  return intervals.map((a,n)=>{
    const i=index.invocations.rows[n]!.invocation;
    const status=!i.endedAt&&a.outcome==='running'?'active':/^(success|pass|probe passed)$/.test(a.outcome)?'passed':/fail|fault|lost|malformed|refusal|stall|timeout/.test(a.outcome)?'failed':/held|abort|unowned|blocked/.test(a.outcome)?'held':'pending';
    const execution=i.execution??(i.work?i.work.kind==='build'?'agent':'command':undefined);
    const elapsedMs=i.endedAt?i.work?.measured?.wallMs??Math.max(0,Date.parse(i.endedAt)-Date.parse(i.startedAt)):undefined;
    return {id:i.id,routeId:a.id,unit:a.subject.id,subject:a.subject,systems:index.identities.get(i.unit)?.systems??[],stage:a.stage,attempt:a.attempt,round:a.round,
      label:stageWords(i.role.startsWith('lane:')?i.role:a.stage),kind:execution==='agent'?'agentic':'deterministic',execution:execution??'unavailable',status,
      startedAt:i.startedAt,endedAt:i.endedAt,...(elapsedMs===undefined?{}:{elapsedMs}),...(i.model?{model:i.model}:{}),spend:a.spend,outcome:a.outcome};
  });
}
function rawInvocationView(e:Envelope,id:string,params:Record<string,string>={}):InvocationView {
  const index=projectionIndex(e);
  params={...params,_entity:`invocation:${id}`};
  const invocation=invocationSummaries(e,index).find(i=>i.routeId===id);
  if(!invocation)throw new ConsoleError('not-found','invocation is not recorded in this arc');
  const recorded=e.data.display.invocations.find(i=>invocationDirName(invocationIdOf(i.id))===id)!,identities=index.identities;
  const related=(recorded.relatedUnits??[]).map(id=>{const u=e.data.display.status.units.find(u=>u.unit===id);if(!u)throw new ConsoleError('corruption','recorded related unit is absent from the applied plan');return {id:String(id),title:identities.get(id)!.title,state:stateWords(u.state),signal:u.state==='cut'||u.state==='superseded'?'withdrawn' as const:graphStatus(u.state),source:invocation.routeId,target:String(id),unmet:false};});
  const parent=index.invocations.rows.find(r=>r.invocation.id===recorded.id)?.parent,basis=recorded.work?.cpuBasis;
  return versioned({invocation,parent:{type:parent?.type==='stage'?'unit':parent?.type==='job'?'job':'arc',id:parent?.type==='stage'?String(parent.unit):parent?.type==='job'?String(parent.job):String(e.arc),stage:parent?.type==='stage'?parent.stage:null,sequence:parent?.type==='stage'?parent.attempt:null},cpuBasis:basis?{kind:basis.kind,value:basis.value,samples:'samples' in basis?basis.samples:null}:null,actor:{role:recorded.role,backend:recorded.backend??null,model:recorded.model??null,requestedModel:recorded.requestedModel??null},measured:recorded.work?.measured??null,reservedCpu:recorded.work?.reservedCpu??null,detailAvailability:detailAvailability(e,recorded),coverage:{money:{recorded:invocation.spend.recorded,estimated:invocation.spend.estimated,unavailable:invocation.spend.unavailable},execution:{measured:recorded.work?.measured?1:0,unmeasured:recorded.work?.measured?0:1}},related:page(e,related,params,'related')},scope);
}
function rawUnitView(e:Envelope,id:string,params:Record<string,string>):UnitView|{unit:UnitSummary;uiSchema:number;viewVersion:string;scope:import('./view-protocol.ts').Scope} {
  const index=projectionIndex(e);
  params={...params,_entity:`unit:${id}`};
  const runtime=e.data.display.status.units.find(u=>u.unit===id);
  if(!runtime)throw new ConsoleError('not-found','unit is not in the applied plan');
  const stages=index.stages.byUnit.get(id)??[],start=params['section']==='journey'?offset(e,params,'journey'):0;
  const anchored=params['section']==='journey'?cursorOf(e,params,'journey'):null;
  const reportSteps=new Set(params['section']&&params['section']!=='journey'?[]:anchored?generations.get(anchored.version)!.ids.slice(start,start+limitOf(params)):stages.slice(start,start+limitOf(params)).map(s=>s.id));
  const u=selectedUnitJourney(e,id,reportSteps);
  const signal=runtime.state==='cut'||runtime.state==='superseded'?'withdrawn':graphStatus(runtime.state);
  const unit:UnitSummary={id:u.id,title:u.title,state:u.state,stage:u.stage,stageFinished:stageFinished(stages,runtime.stage),signal,startedAt:u.startedAt,endedAt:u.endedAt,arcEndedAt:arcBounds(e).to,elapsedMs:u.elapsedMs,attempts:u.attempts,rounds:u.rounds,spend:index.charges.bySubject.get(`unit:${id}`)??{costUsd:null,recorded:0,estimated:0,unavailable:0},reasons:u.reasons,waitSince:u.waitSince,lineage:u.lineage?{reenters:u.lineage.reenters,root:u.lineage.root,prepared:u.lineage.prepared}:null};
  if(params['section']==='summary')return versioned({unit},scope);
  const s=e.data.display.status,identities=index.identities;
  const related=(source:string,target:string):RelatedUnit=>{
    const other=source===id?target:source,r=s.units.find(u=>u.unit===other)!;
    return {id:other,title:identities.get(other)!.title,state:stateWords(r.state),signal:r.state==='cut'||r.state==='superseded'?'withdrawn':graphStatus(r.state),source,target,unmet:runtime.waitingFor?.deps.includes(other as never)??false};
  };
  const edges=s.edges.filter(x=>x.type==='after');
  const gates=(e.data.plan?.milestones??[]).map(g=>({id:String(g.id),name:g.name??null,passed:s.milestones.find(m=>m.id===g.id)!.passed}));
  const feeds=gates.filter(g=>e.data.plan!.milestones!.find(m=>m.id===g.id)!.units.includes(id as never));
  const waits=gates.filter(g=>s.edges.some(x=>x.type==='milestone'&&x.unit===id&&x.milestone===g.id));
  const w=runtime.waitingFor;
  const work=e.data.display.invocations.filter(i=>i.unit===id),waitingEvidence=completedWaiting(e.data.events.filter(ev=>ev.type==='done'||ev.type==='intent'&&ev.parent.type==='stage'&&ev.parent.unit===id||ev.type==='fact'&&ev.fact.kind==='stage-admitted'&&ev.fact.unit===id));
  const currentBlockers=w?{dependencies:[...w.deps],milestones:[...w.milestones],contingentEdges:[...w.edges],resources:w.resources?{named:[...w.resources.named],pools:[...w.resources.pools],cpu:w.resources.cpu,publication:w.resources.publication}:null,environmentBlocked:w.envBlocked,pressureBlocked:w.pressureBlocked??null,tokenWaitMs:w.tokenWaitMs??null,admission:w.admission.map(a=>({kind:a.type,references:Object.entries(a).filter(([k,v])=>['unit','milestone','edge','command','id','finding','obligation','fixUnit','inv','backend','deflake','lane'].includes(k)&&typeof v==='string').map(([field,v])=>({field,id:String(v)})),scope:'scope' in a?a.scope:null,parkClass:'class' in a?a.class:null,reason:'reason' in a?a.reason:null,decision:'decision' in a?a.decision:null,probe:'target' in a?{kind:a.target.type,id:a.target.type==='backend'?a.target.backend:a.target.type==='resource'?String(a.target.instance):a.target.type==='environment'?String(a.target.environment):null}:null})),drainCommands:[...w.drainFor]}:null;
  const coverage={money:{recorded:unit.spend.recorded,estimated:unit.spend.estimated,unavailable:unit.spend.unavailable+work.filter(i=>i.execution==='agent'&&!index.charges.byInvocation.has(i.id)).length},execution:{measured:work.filter(i=>i.work?.measured).length,unmeasured:work.filter(i=>!i.work?.measured).length},waiting:{measured:waitingEvidence.measurements.filter(w=>w.source==='admission'?w.unit===id:w.parent.type==='stage'&&w.parent.unit===id).length,unmeasured:waitingEvidence.unmeasuredReservations}};
  return versioned({unit,systems:identities.get(id)!.systems,currentBlockers,supersededBy:runtime.supersededBy,coverage,feeds,waits,
    depends:page(e,edges.filter(x=>x.unit===id).map(x=>related(x.effective,x.unit)),params,'depends'),
    usedBy:page(e,edges.filter(x=>x.effective===id).map(x=>related(x.effective,x.unit)),params,'usedBy'),
    journey:page(e,u.journey,params,'journey'),invocations:page(e,invocationSummaries(e,index).filter(i=>i.subject.type==='unit'&&i.unit===id),params,'invocations'),
    acceptance:page(e,u.acceptance,params,'acceptance'),waiting:page(e,u.waiting.map(w=>({...w,reasons:w.reasons.map(r=>({...r,ms:r.ms!}))})),params,'waiting'),checks:page(e,runtime.certification?.lanes.map(l=>({id:String(l.id),outcome:l.verdict||l.state}))??[],params,'checks'),
    requests:page(e,e.data.requests.filter(r=>r.subject.type==='unit'&&r.subject.unit===id).map(r=>({id:String(r.id),summary:r.summary,recommendation:r.recommendation})),params,'requests'),intent:text(e,u.intent||u.summary,params)},scope);
}
function rawMilestoneView(e:Envelope,id:string,params:Record<string,string>):MilestoneView {
  params={...params,_entity:`milestone:${id}`};
  const g=e.data.plan?.milestones?.find(g=>g.id===id),state=e.data.display.status.milestones.find(g=>g.id===id);
  if(!g||!state)throw new ConsoleError('not-found','milestone is not in the applied plan');
  const identities=projectionIndex(e).identities;
  const members=g.units.map(id=>{const u=e.data.display.status.units.find(u=>u.unit===id)!;return {id:String(id),title:identities.get(id)!.title,state:stateWords(u.state),signal:u.state==='cut'||u.state==='superseded'?'withdrawn' as const:graphStatus(u.state),source:String(id),target:`milestone:${g.id}`,unmet:false};});
  const order=['held','failed','active','pending','withdrawn','passed'];
  members.sort((a,b)=>order.indexOf(a.signal)-order.indexOf(b.signal)||a.id.localeCompare(b.id,undefined,{numeric:true}));
  return versioned({id:String(g.id),name:g.name??null,state:state.state,passed:state.passed,total:members.length,merged:members.filter(u=>u.signal==='passed').length,members:page(e,members,params,'members'),intent:text(e,g.text,params)},scope);
}
export function detailParams(params:Record<string,string>,sections:string[]) {
  for(const key of Object.keys(params))if(!['epoch','revision','minHighWater','section','cursor','limit'].includes(key))throw new ConsoleError('invalid','unknown detail query parameter');
  if(params['limit']!==undefined&&(!['25','50','100'].includes(params['limit'])||['summary','intent','content'].includes(params['section']??'')))throw new ConsoleError('invalid','detail limit is 25, 50 or 100 for collection pages');
  if(params['section']!==undefined&&!sections.includes(params['section']))throw new ConsoleError('invalid','unknown detail section');
  if(params['cursor']!==undefined&&!params['section'])throw new ConsoleError('invalid','detail cursor requires a section');
}

export function unitView(e:Envelope,id:string,params:Record<string,string>={}):ReturnType<typeof rawUnitView>{
 if(params['section']==='content')return contentDetail(e,`unit:${id}`,params['cursor']??'',64*1024) as any;
 return boundDetail(e,`unit:${id}`,rawUnitView(e,id,params),64*1024,latest=>rawUnitView(latest,id,params));
}
export function milestoneView(e:Envelope,id:string,params:Record<string,string>={}):MilestoneView{
 if(params['section']==='content')return contentDetail(e,`milestone:${id}`,params['cursor']??'',64*1024) as any;
 return boundDetail(e,`milestone:${id}`,rawMilestoneView(e,id,params),64*1024,latest=>rawMilestoneView(latest,id,params));
}
export function invocationView(e:Envelope,id:string,params:Record<string,string>={}):InvocationView{
 if(params['section']==='content')return contentDetail(e,`invocation:${id}`,params['cursor']??'',16*1024) as any;
 return boundDetail(e,`invocation:${id}`,rawInvocationView(e,id,params),16*1024,latest=>rawInvocationView(latest,id,params));
}
