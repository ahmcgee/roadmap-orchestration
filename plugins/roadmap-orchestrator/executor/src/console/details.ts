import { createHmac, randomBytes } from 'node:crypto';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { record } from '../tui/projection.ts';
import { presentation } from './presentation.ts';
import { projectionIndex, timelineIntervals } from './tab-projections.ts';
import { graphStatus } from './signals.ts';
import { stageWords, stateWords } from './vocabulary.ts';
import { arcBounds, versioned } from './views.ts';
import type { DetailPage, InvocationSummary, UnitSummary, RelatedUnit, UnitView, MilestoneView, InvocationView } from './detail-protocol.ts';
const cursorSecret=randomBytes(32);
const signature=(value:string)=>createHmac('sha256',cursorSecret).update(value).digest('hex');
const token=(value:unknown)=>{const raw=Buffer.from(JSON.stringify(value)).toString('base64url');return `${raw}.${signature(raw)}`;};
const limitOf=(params:Record<string,string>)=>Number(params['limit']??'25');
const scope = {basis:'current' as const,from:null,to:null};
function offset(e:Envelope,params:Record<string,string>, section:string) {
  const cursor=params['cursor'];if(!cursor)return 0;
  if(cursor.length>1024)throw new ConsoleError('invalid','invalid detail cursor');
  let parsed:{version:string;section:string;offset:number;arc:string;epoch:string;entity:string;limit:number};
  try {const [raw,sig]=cursor.split('.');if(!raw||sig!==signature(raw)||cursor.split('.').length!==2)throw Error();parsed=JSON.parse(Buffer.from(raw,'base64url').toString());}catch{throw new ConsoleError('invalid','invalid detail cursor');}
  if(parsed.limit!==(section==='intent'?4096:limitOf(params))||parsed.entity!==params['_entity']||parsed.arc!==e.arc||parsed.epoch!==e.epoch||parsed.section!==section||!Number.isSafeInteger(parsed.offset)||parsed.offset<0)throw new ConsoleError('invalid','foreign detail cursor');
  if(parsed.version!==e.data.capture.source)throw new ConsoleError('reset','Detail changed; reopen this detail');
  return parsed.offset;
}
function page<T>(e:Envelope,rows:T[],params:Record<string,string>,section:string):DetailPage<T> {
  const start=params['section']===section?offset(e,params,section):0;
  const end=Math.min(start+limitOf(params),rows.length);
  return {rows:rows.slice(start,end),total:rows.length,next:end<rows.length?token({version:e.data.capture.source,arc:e.arc,epoch:e.epoch,entity:params['_entity'],section,offset:end,limit:limitOf(params)}):null};
}
function text(e:Envelope,value:string,params:Record<string,string>) {
  const start=params['section']==='intent'?offset(e,params,'intent'):0,end=Math.min(start+4096,value.length);
  return {text:value.slice(start,end),next:end<value.length?token({version:e.data.capture.source,arc:e.arc,epoch:e.epoch,entity:params['_entity'],section:'intent',offset:end,limit:4096}):null};
}
export function invocationSummaries(e:Envelope):InvocationSummary[] {
  const index=projectionIndex(e),intervals=timelineIntervals(e,index);
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
export function invocationView(e:Envelope,id:string,params:Record<string,string>={}):InvocationView {
  params={...params,_entity:`invocation:${id}`};
  const invocation=invocationSummaries(e).find(i=>i.routeId===id);
  if(!invocation)throw new ConsoleError('not-found','invocation is not recorded in this arc');
  const recorded=e.data.display.invocations.find(i=>invocationDirName(invocationIdOf(i.id))===id)!,identities=projectionIndex(e).identities;
  const related=(recorded.relatedUnits??[]).map(id=>{const u=e.data.display.status.units.find(u=>u.unit===id);if(!u)throw new ConsoleError('corruption','recorded related unit is absent from the applied plan');return {id:String(id),title:identities.get(id)!.title,state:stateWords(u.state),signal:u.state==='cut'||u.state==='superseded'?'withdrawn' as const:graphStatus(u.state),source:invocation.routeId,target:String(id),unmet:false};});
  return versioned({invocation,actor:{role:recorded.role,backend:recorded.backend??null,model:recorded.model??null,requestedModel:recorded.requestedModel??null},measured:recorded.work?.measured??null,reservedCpu:recorded.work?.reservedCpu??null,related:page(e,related,params,'related')},scope);
}
export function unitView(e:Envelope,id:string,params:Record<string,string>):UnitView|{unit:UnitSummary;uiSchema:number;viewVersion:string;scope:import('./view-protocol.ts').Scope} {
  params={...params,_entity:`unit:${id}`};
  const runtime=e.data.display.status.units.find(u=>u.unit===id);
  if(!runtime)throw new ConsoleError('not-found','unit is not in the applied plan');
  const stages=projectionIndex(e).stages.byUnit.get(id)??[],start=params['section']==='journey'?offset(e,params,'journey'):0;
  const reportSteps=new Set(params['section']&&params['section']!=='journey'?[]:stages.slice(start,start+limitOf(params)).map(s=>s.id));
  const p=presentation(e,id,reportSteps),u=p.units[0]!;
  const signal=runtime.state==='cut'||runtime.state==='superseded'?'withdrawn':graphStatus(runtime.state);
  const unit:UnitSummary={id:u.id,title:u.title,state:u.state,stage:u.stage,signal,startedAt:u.startedAt,endedAt:u.endedAt,arcEndedAt:arcBounds(e).to,elapsedMs:u.elapsedMs,attempts:u.attempts,rounds:u.rounds,spend:projectionIndex(e).charges.bySubject.get(`unit:${id}`)??{costUsd:null,recorded:0,estimated:0,unavailable:0},reasons:u.reasons,waitSince:u.waitSince,lineage:u.lineage?{reenters:u.lineage.reenters}:null};
  if(params['section']==='summary')return versioned({unit},scope);
  const s=e.data.display.status,identities=projectionIndex(e).identities;
  const related=(source:string,target:string):RelatedUnit=>{
    const other=source===id?target:source,r=s.units.find(u=>u.unit===other)!;
    return {id:other,title:identities.get(other)!.title,state:stateWords(r.state),signal:r.state==='cut'||r.state==='superseded'?'withdrawn':graphStatus(r.state),source,target,unmet:runtime.waitingFor?.deps.includes(other as never)??false};
  };
  const edges=s.edges.filter(x=>x.type==='after');
  const gates=(e.data.plan?.milestones??[]).map(g=>({id:String(g.id),name:g.name??null,passed:s.milestones.find(m=>m.id===g.id)!.passed}));
  const feeds=gates.filter(g=>e.data.plan!.milestones!.find(m=>m.id===g.id)!.units.includes(id as never));
  const waits=gates.filter(g=>s.edges.some(x=>x.type==='milestone'&&x.unit===id&&x.milestone===g.id));
  return versioned({unit,feeds,waits,
    depends:page(e,edges.filter(x=>x.unit===id).map(x=>related(x.effective,x.unit)),params,'depends'),
    usedBy:page(e,edges.filter(x=>x.effective===id).map(x=>related(x.effective,x.unit)),params,'usedBy'),
    journey:page(e,u.journey,params,'journey'),invocations:page(e,invocationSummaries(e).filter(i=>i.subject.type==='unit'&&i.unit===id),params,'invocations'),
    acceptance:page(e,u.acceptance,params,'acceptance'),waiting:page(e,u.waiting.map(w=>({...w,reasons:w.reasons.map(r=>({...r,ms:r.ms!}))})),params,'waiting'),checks:page(e,runtime.certification?.lanes.map(l=>({id:String(l.id),outcome:l.verdict||l.state}))??[],params,'checks'),
    requests:page(e,e.data.requests.filter(r=>r.subject.type==='unit'&&r.subject.unit===id).map(r=>({id:String(r.id),summary:r.summary,recommendation:r.recommendation})),params,'requests'),intent:text(e,u.intent||u.summary,params)},scope);
}
export function milestoneView(e:Envelope,id:string,params:Record<string,string>):MilestoneView {
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
  if(params['limit']!==undefined&&(!['25','50','100'].includes(params['limit'])||['summary','intent'].includes(params['section']??'')))throw new ConsoleError('invalid','detail limit is 25, 50 or 100 for collection pages');
  if(params['section']!==undefined&&!sections.includes(params['section']))throw new ConsoleError('invalid','unknown detail section');
  if(params['cursor']!==undefined&&!params['section'])throw new ConsoleError('invalid','detail cursor requires a section');
}
