// Independent resource queries over one authoritative capture. No model/report/transcript reads.
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { ADMISSION_HOLDS } from '../core/waiting.ts';
import { completedWaiting } from '../status/waiting.ts';
import { backendHolds } from './backend-holds.ts';
import { boundDetail, contentDetail } from './detail-content.ts';
import { CollectionPages, responseBound } from './collection-pages.ts';
import { allowParams, choice, invalid, known, list, pageLimit, resolveTime, timeParams, intersects } from './query-params.ts';
import { bookingSummaries, projectionIndex, waitingMeasurements, resourceNow } from './tab-projections.ts';
import { cpuStageGroups, resourceQueue } from './resources.ts';
import { waitWords, reasonWords, stageWords } from './vocabulary.ts';
import { preview, versioned } from './views.ts';
import type { ResourceFilters, ResourceSubject, ResourceBooking, ResourceCpu, ResourceCpuCall, ResourceWait, ResourceReason, ResourceNow, ResourceNowRow, ResourceView, ResourceDetail, ResourceCoverage, ResourceReasonsView } from './resource-protocol.ts';
const detailKey=(kind:string,arc:string,id:string)=>`${kind}-${sha256Hex(canonicalJson([arc,id]))}`;
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
export const waitingLabel=reasonWords;
export class ConsoleResources {
  readonly pages:CollectionPages;
  constructor(pages=new CollectionPages()){this.pages=pages;}
  filters(params:Record<string,string>):ResourceFilters {
    allowParams(params,['section','window','from','to','zone','resource','unit','stage','state','reason','utilization','q','sort','direction','cursor','limit']);
    const section=choice(params,'section',['schedule','cpu','waiting','now'],'schedule');
    const allowed=section==='schedule'?['resource','unit','state']:section==='cpu'?['unit','stage','utilization']:section==='waiting'?['unit','stage','reason']:['resource','unit'];
    for(const key of ['resource','unit','stage','state','reason','utilization'])if(params[key]!==undefined&&!allowed.includes(key))invalid(`${key} does not apply to ${section}`);
    if(section==='now'&&['window','from','to'].some(k=>params[k]!==undefined))invalid('Now has current scope, not a historical window');
    if(section==='now'&&params['direction']!==undefined&&params['direction']!=='asc')invalid('Scheduler order is served-first');
    const q=params['q']??'';if(q.length>200)invalid('Resources search is limited to 200 characters');
    const sort=choice<ResourceFilters['sort']>(params,'sort',section==='schedule'?['resource','start','duration']:section==='cpu'?['unit','utilization','coreTime']:section==='waiting'?['reason','duration','count']:['scheduler'],section==='schedule'?'resource':section==='cpu'?'unit':section==='waiting'?'reason':'scheduler');
    return {section,...timeParams(params),resource:list(params,'resource'),unit:list(params,'unit'),stage:list(params,'stage'),state:list(params,'state'),reason:list(params,'reason'),utilization:choice(params,'utilization',['all','under10','over100','unmeasured'],'all'),q:q.toLowerCase(),sort,direction:choice(params,'direction',['asc','desc'],'asc')};
  }
  read(e:Envelope,params:Record<string,string>,sourceVersion?:string):ResourceView {
    const filters=this.filters(params),limit=pageLimit(params);
    const data=this.pages.page<ResourceView['rows'][number],Omit<ResourceView,'rows'|'page'>>(e,'resources',filters,limit,params['cursor'],()=>{
      const b=this.build(e,filters,sourceVersion);return {rows:b.rows.map(r=>'source' in r?{...r,reasons:r.reasons.slice(0,8)}:r),context:b.context};
    });
    return responseBound(e,data,limit===100?256*1024:128*1024);
  }
  build(e:Envelope,f:ResourceFilters,sourceVersion?:string,withCalls=false) {
    const index=projectionIndex(e),identities=index.identities,{scope,bounds}=resolveTime(e,f);
    const subject=(type:'unit'|'job'|'arc',id:string):ResourceSubject=>({type,id,titleTruncated:type==='unit'&&(identities.get(id)?.title.length??id.length)>96,title:type==='unit'?(identities.get(id)?.title??id).slice(0,96):type==='arc'?'Arc':id,unitRef:type==='unit'&&identities.has(id)?id:null});
    const allBookings:ResourceBooking[]=bookingSummaries(e.data.events).map(b=>({...b,subject:subject(b.holder.unitId?'unit':b.holder.type==='job'||b.holder.type==='docs'?'job':'arc',b.holder.unitId??(b.holder.type==='job'||b.holder.type==='docs'?b.holder.id:e.arc)),resourceKey:detailKey('resource',e.arc,b.resource),detailKey:detailKey('booking',e.arc,`${e.epoch}:${b.id}`)}));
    const allWork=f.section==='cpu'||withCalls?[...e.data.display.status.host.work,...e.data.display.status.units.flatMap(u=>u.work)]:[];
    const invs=new Map(index.invocations.rows.map(r=>[r.invocation.id,r]));
    const allCalls:ResourceCpuCall[]=allWork.map(w=>{const r=invs.get(w.inv),p=w.parent,s=subject(p.type==='stage'?'unit':p.type==='job'?'job':'arc',p.type==='stage'?p.unit:p.type==='job'?p.job:e.arc);return {id:String(w.inv),invocation:r?invocationDirName(invocationIdOf(w.inv)):null,subject:s,stage:p.type==='stage'?p.stage:r?.invocation.role??p.type,attempt:r?.step?.attempt??r?.invocation.attempt??null,startedAt:r?.invocation.startedAt??null,endedAt:r?.invocation.endedAt??null,reservedCpu:w.reservedCpu,basis:w.cpuBasis?{kind:w.cpuBasis.kind,value:w.cpuBasis.value}:null,measured:w.measured};});
    const callsById=new Map(allCalls.map(c=>[c.id,c]));
    const within=(at:string)=> (scope.from===null||Date.parse(at)>=Date.parse(scope.from))&&(scope.to===null||Date.parse(at)<Date.parse(scope.to));
    // Completed CPU evidence is attributed at invocation completion. Unmeasured calls use their
    // actual start; undated retained samples are eligible only in the whole-Arc window.
    const chosenWork=allWork.filter(w=>{const c=callsById.get(w.inv)!;const at=c.endedAt??c.startedAt;return at?within(at):f.window==='arc';});
    const cpu:ResourceCpu[]=cpuStageGroups(chosenWork).map(g=>{const p=g.parent,calls=g.invocations.map(id=>callsById.get(id)!);const id=sha256Hex(g.id),first=calls[0]!;return {id,parent:{type:first.subject.type,id:first.subject.id,stage:p.type==='stage'?p.stage:null,attempt:first.attempt},subject:first.subject,stage:first.stage,attempt:first.attempt,measuredRunMs:g.runMs,measuredWallMs:g.wallMs,reservedCoreMs:g.reservedCoreMs,averageCores:g.averageCores,weightedReservedCores:g.reservedCores,reservationPercent:g.reservationPercent,measuredCalls:g.measuredCalls,excludedCalls:g.excludedCalls,unmeasuredCalls:g.unmeasuredCalls,zeroWallCalls:g.zeroWallCalls,unreservedCalls:g.unreservedCalls,unreservedAverageCores:g.unreservedAverageCores,detailKey:detailKey('cpu',e.arc,`${e.epoch}:${id}`),callCount:calls.length,calls:calls.slice(0,3)};});
    const waiting=f.section==='waiting'?waitingMeasurements(e,index):{rows:[],unmeasuredReservations:0},waits:ResourceWait[]=waiting.rows.map(w=>({...w,subject:subject(w.subject.type,w.subject.id),reasonCount:w.reasons.length,unitRef:w.subject.type==='unit'&&identities.has(w.subject.id)?w.subject.id:null,detailKey:detailKey('measurement',e.arc,`${e.epoch}:${w.id}`)}));
    const rawNow=resourceNow(e),queue=resourceQueue(e.data.display.status.host);
    const resources:Extract<ResourceNowRow,{kind:'resource'}>[]=rawNow.resources.map(r=>{const b=allBookings.findLast(b=>(b.instance??b.resource)===r.resource&&b.state==='holding');return {id:`resource:${r.resource}`,kind:'resource',...r,holderTitle:r.holder?identities.get(r.holder)?.title.slice(0,96)??null:null,unitRef:r.holder&&identities.has(r.holder)?r.holder:null,startedAt:b?.startedAt??null,detailKey:detailKey('resource',e.arc,r.resource)};});
    const queues:Extract<ResourceNowRow,{kind:'queue'}>[]=queue.map((q,n)=>({id:`queue:${n}`,kind:'queue',position:n+1,subject:q.unit?subject('unit',q.unit):'holder' in q&&(q.holder.type==='job'||q.holder.type==='docs')?subject('job',q.label):{...subject('arc',e.arc),title:`Batch ${q.label}`} ,queuedAt:q.queuedAt===undefined?null:new Date(q.queuedAt).toISOString(),publication:q.request.publication,named:[...q.request.named],pools:[...q.request.pools],cpu:q.request.cpu}));
    const blockers:Extract<ResourceNowRow,{kind:'blocker'}>[]=e.data.display.status.units.flatMap(u=>{const reasons=waitWords(u.waitingFor);return reasons.length?[{id:`blocker:${u.unit}`,kind:'blocker' as const,subject:subject('unit',u.unit),reasons:reasons.slice(0,8).map(text=>preview(text,{type:'unit',id:u.unit})),reasonCount:reasons.length}]:[];});
    const pools:Extract<ResourceNowRow,{kind:'pool'}>[]=rawNow.pools.map(p=>({id:`pool:${p.id}`,kind:'pool',resource:p.id,detailKey:detailKey('resource',e.arc,p.id),size:p.size,used:p.used,dirty:p.dirty}));
    const integration=resources.filter(r=>r.resource==='integration-slot'&&r.holder!==null),publication=queues.filter(q=>q.publication).map((q,n)=>({...q,position:n+1}));
    const pressure=blockers.filter(b=>e.data.display.status.units.find(u=>u.unit===b.subject.id)?.waitingFor?.pressureBlocked);
    const now:ResourceNow={queueAvailable:rawNow.queueAvailable,cpuReservation:rawNow.cpuReservation,integration:{rows:integration.slice(0,5),matching:integration.length},queues:{rows:publication.slice(0,5),matching:publication.length},blockers:{rows:pressure.slice(0,5),matching:pressure.length},counts:{resources:resources.length,queues:queues.length,pools:pools.length,blockers:blockers.length},unknownQueueStarts:queues.filter(q=>q.queuedAt===null).length};
    known(f.unit,[...identities.keys()],'unit');
    const resourceIds=[...new Set([...(e.data.plan?.resources??[]).map(r=>String(r.name)),...queues.flatMap(q=>[...q.named,...q.pools,...(q.publication?['integration-slot']:[]),...(q.cpu>0?['@cpu']:[])]),...allBookings.flatMap(b=>[b.resource,...(b.instance?[b.instance]:[])]),...resources.map(r=>r.resource),...pools.map(p=>p.resource)])];known(f.resource,resourceIds,'resource');
    known(f.state,['holding','done'],'booking state');known(f.stage,[...new Set(['pre-build','build','lanes','gate','candidate','ff','snapshot',...allCalls.map(c=>c.stage),...waits.flatMap(w=>w.stage?[w.stage]:[])])],'stage');
    known(f.reason,[...new Set(['cpu-pressure','memory-pressure','cpu-tokens','publication-slot','queue-precedence',...ADMISSION_HOLDS.map(r=>`admission-hold:${r}`),...waits.flatMap(w=>w.reasons.map(r=>r.reason))])],'waiting reason');
    const matches=(s:ResourceSubject|ResourceWait['subject'])=>(!f.unit.length||s.type==='unit'&&f.unit.includes(s.id));
    const search=(...values:string[])=>!f.q||values.join(' ').toLowerCase().includes(f.q);
    const title=(s:ResourceSubject|ResourceWait['subject'])=>identities.get(s.id)?.title??s.title;
    const bookings=allBookings.filter(b=>matches(b.subject)&&(!f.resource.length||f.resource.includes(b.resource)||b.instance!==null&&f.resource.includes(b.instance))&&(!f.state.length||f.state.includes(b.state))&&search(b.resource,b.instance??'',b.holder.id,title(b.subject))&&intersects(b.startedAt,b.endedAt,scope.from,scope.to,bounds.terminalAt??e.checkedAt));
    const groups=cpu.filter(c=>matches(c.subject)&&(!f.stage.length||f.stage.includes(c.stage))&&search(c.subject.id,title(c.subject),c.stage)&& (f.utilization==='all'||f.utilization==='under10'&&c.reservationPercent!==null&&c.reservationPercent<10||f.utilization==='over100'&&c.reservationPercent!==null&&c.reservationPercent>100||f.utilization==='unmeasured'&&c.excludedCalls>0));
    const measurements=waits.filter(w=>matches(w.subject)&&within(w.at)&&(!f.stage.length||w.stage!==null&&f.stage.includes(w.stage))&&(!f.reason.length||w.reasons.some(r=>f.reason.includes(r.reason)))&&search(w.subject.id,title(w.subject),w.stage??'',...w.reasons.flatMap(r=>[r.reason,waitingLabel(r.reason)])));
    const reasons=new Map<string,ResourceReason>();for(const w of measurements)for(const r of w.reasons){if(f.reason.length&&!f.reason.includes(r.reason))continue;const v=reasons.get(r.reason)??{id:r.reason,reason:r.reason,label:waitingLabel(r.reason),totalMs:0,count:0,detailKey:detailKey('waiting',e.arc,r.reason)};v.totalMs+=r.ms;v.count++;reasons.set(r.reason,v);}
    const reasonRows=[...reasons.values()].sort((a,b)=>f.sort==='duration'?(f.direction==='desc'?b.totalMs-a.totalMs:a.totalMs-b.totalMs)||cmp(a.reason,b.reason):f.sort==='count'?(f.direction==='desc'?b.count-a.count:a.count-b.count)||cmp(a.reason,b.reason):(f.direction==='desc'?-1:1)*cmp(a.label,b.label));
    const numeric=<T extends {id:string}>(rows:T[],value:(r:T)=>number|null,tie:(a:T,b:T)=>number=(a,b)=>cmp(a.id,b.id))=>rows.sort((a,b)=>{const av=value(a),bv=value(b);return av===null||bv===null?av===null?(bv===null?tie(a,b):1):-1:(f.direction==='desc'?bv-av:av-bv)||tie(a,b);});
    const bookingDuration=(b:ResourceBooking)=>{const n=Date.parse(b.endedAt??bounds.terminalAt??e.checkedAt)-Date.parse(b.startedAt);return n<0?null:n;};
    if(f.sort==='start')numeric(bookings,b=>Date.parse(b.startedAt));else if(f.sort==='duration'&&f.section==='schedule')numeric(bookings,bookingDuration);else bookings.sort((a,b)=>(f.direction==='desc'?-1:1)*(cmp(a.resource,b.resource)||cmp(a.instance??'',b.instance??''))||cmp(a.startedAt,b.startedAt)||cmp(a.id,b.id));
    const unitOrder=(a:ResourceCpu,b:ResourceCpu)=>(identities.get(a.subject.id)?.order??Number.MAX_SAFE_INTEGER)-(identities.get(b.subject.id)?.order??Number.MAX_SAFE_INTEGER)||Math.min(...a.calls.map(c=>c.invocation?Number(c.invocation.split('-')[0]):Number.MAX_SAFE_INTEGER))-Math.min(...b.calls.map(c=>c.invocation?Number(c.invocation.split('-')[0]):Number.MAX_SAFE_INTEGER))||cmp(a.id,b.id);
    if(f.sort==='utilization')numeric(groups,c=>c.reservationPercent,unitOrder);else if(f.sort==='coreTime')numeric(groups,c=>c.measuredCalls?c.measuredRunMs:null,unitOrder);else groups.sort((a,b)=>(f.direction==='desc'?-1:1)*unitOrder(a,b));
    const reasonRank=new Map(reasonRows.map((r,n)=>[r.reason,n]));measurements.sort((a,b)=>Math.min(...a.reasons.map(r=>reasonRank.get(r.reason)??Infinity))-Math.min(...b.reasons.map(r=>reasonRank.get(r.reason)??Infinity))||cmp(a.at,b.at)||cmp(a.id,b.id));
    const nowRows:ResourceNowRow[]=[...resources,...queues,...pools,...blockers].filter(r=>r.kind==='resource'?(!f.resource.length||f.resource.includes(r.resource))&&(!f.unit.length||r.unitRef!==null&&f.unit.includes(r.unitRef))&&search(r.resource,r.holder??''):r.kind==='pool'?!f.unit.length&&(!f.resource.length||f.resource.includes(r.resource))&&search(r.resource):matches(r.subject)&&(!f.resource.length||r.kind==='queue'&&[...r.named,...r.pools,...(r.publication?['integration-slot']:[]),...(r.cpu>0?['@cpu']:[])].some(v=>f.resource.includes(v))||r.kind==='blocker'&&(()=>{const q=e.data.display.status.units.find(u=>u.unit===r.subject.id)?.waitingFor?.resources;return !!q&&[...q.named,...q.pools,...(q.publication?['integration-slot']:[]),...(q.cpu>0?['@cpu']:[])].some(v=>f.resource.includes(v));})())&&search(r.subject.id,title(r.subject)));
    const selectedGroups=f.section==='cpu'?groups:[];
    const coverage:ResourceCoverage={matchedCalls:0,excludedCalls:0,unmeasuredCalls:0,zeroWallCalls:0,unreservedCalls:0,measuredStages:0,under10Stages:0,over100Stages:0,waitingMeasurements:f.section==='waiting'?measurements.length:0,unmeasuredReservations:f.section==='waiting'&&f.window==='arc'&&!f.unit.length&&!f.stage.length&&!f.reason.length&&!f.q?completedWaiting(e.data.events).unmeasuredReservations:null};
    for(const c of selectedGroups){coverage.matchedCalls+=c.measuredCalls;coverage.excludedCalls+=c.excludedCalls;coverage.unmeasuredCalls+=c.unmeasuredCalls;coverage.zeroWallCalls+=c.zeroWallCalls;coverage.unreservedCalls+=c.unreservedCalls;if(c.parent.type==='unit'&&c.reservationPercent!==null){coverage.measuredStages++;if(c.reservationPercent<10)coverage.under10Stages++;if(c.reservationPercent>100)coverage.over100Stages++;}}
    const counts={schedule:f.section==='schedule'?bookings.length:null,cpu:f.section==='cpu'?groups.length:null,waiting:f.section==='waiting'?measurements.length:null,now:f.section==='now'?nowRows.length:null};
    const buckets=new Map<number,number>(),lo=scope.from?Date.parse(scope.from):Date.parse(bounds.from??bounds.to),hi=Date.parse(scope.to??bounds.to),width=Math.max(1,Math.ceil((hi-lo)/64));for(const b of bookings){const n=Math.floor((Math.max(lo,Date.parse(b.startedAt))-lo)/width);buckets.set(n,(buckets.get(n)??0)+1);}
    const holds=f.section==='schedule'?backendHolds(e.data.events,e.epoch).filter(h=>intersects(h.startedAt,h.endedAt??h.terminalAt,scope.from,scope.to,bounds.terminalAt??e.checkedAt)):null;
    const overview={backendHolds:holds?{rows:holds.slice(0,25),matching:holds.length}:null,resourceCount:resourceIds.filter(r=>r!=='@cpu').length,buckets:f.section==='schedule'?[...buckets].sort(([a],[b])=>a-b).map(([n,count])=>({from:new Date(lo+n*width).toISOString(),to:new Date(Math.min(hi,lo+(n+1)*width)).toISOString(),count})):[],reasons:f.section==='waiting'?reasonRows.slice(0,25):[],reasonCount:f.section==='waiting'?reasonRows.length:0,totalWaitingMs:f.section==='waiting'&&measurements.length?measurements.reduce((n,w)=>n+w.totalMs,0):null,unallocatedMs:f.section==='waiting'&&measurements.length?measurements.reduce((n,w)=>n+w.unallocatedMs,0):null};
    const rows:ResourceView['rows']=f.section==='schedule'?bookings:f.section==='cpu'?groups:f.section==='waiting'?measurements:nowRows;
    const context={...versioned({section:f.section,filters:f,bounds,now,counts,coverage,overview},f.section==='now'?{basis:'current' as const,from:null,to:null}:scope),viewVersion:sourceVersion??sha256Hex(canonicalJson([e.data.capture.source,'resources']))};
    return {rows,context,allBookings,allCalls,groups,measurements,reasonRows,subject,resources};
  }
  content(e:Envelope,id:string,params:Record<string,string>) {
    allowParams(params,['section','cursor']);if(params['section']!=='content'||!params['cursor'])invalid('Resource field expansion needs its cursor');
    return contentDetail(e,`resource:${id}`,params['cursor']!,16*1024);
  }
  reasons(e:Envelope,params:Record<string,string>,sourceVersion?:string):ResourceReasonsView {
    if(params['section']!==undefined&&params['section']!=='waiting')invalid('Reason pages require section=waiting');
    const filters=this.filters({...params,section:'waiting'}),limit=pageLimit(params);
    const data=this.pages.page(e,'resource-reasons',filters,limit,params['cursor'],()=>{const b=this.build(e,filters,sourceVersion);return {rows:b.reasonRows,context:{...versioned({filters,bounds:b.context.bounds},b.context.scope),viewVersion:b.context.viewVersion}};});
    return responseBound(e,data,limit===100?256*1024:128*1024);
  }
  detail(e:Envelope,id:string,params:Record<string,string>,sourceVersion?:string):ResourceDetail {
    if(!/^(booking|resource|cpu|waiting|measurement)-[a-f0-9]{64}$/.test(id))invalid('invalid resource detail key');
    const {evidence:rawEvidence,...query}=params,kind=id.split('-')[0]!,evidence=choice({evidence:rawEvidence??(kind==='cpu'?'calls':kind==='waiting'||kind==='measurement'?'measurements':'ownership')},'evidence',kind==='cpu'?['calls']:kind==='waiting'||kind==='measurement'?['measurements']:['ownership','calls'],'ownership'),f=this.filters({...query,section:params['section']??(kind==='cpu'?'cpu':kind==='waiting'||kind==='measurement'?'waiting':'schedule')}),limit=pageLimit({...params,limit:params['limit']??'25'});
    const data=this.pages.page<ResourceDetail['rows'][number],Omit<ResourceDetail,'rows'|'page'>>(e,`resource-detail:${id}`,{...f,evidence},limit,params['cursor'],()=>{
      const b=this.build(e,f,sourceVersion,kind==='booking'||kind==='resource');let booking:ResourceBooking|null=null,cpu:ResourceDetail['cpu']=null,reason:ResourceReason|null=null,subject:ResourceSubject|null=null,label='',rows:ResourceDetail['rows']=[];
      if(kind==='booking'){booking=b.allBookings.find(r=>r.detailKey===id)??null;if(booking){subject=booking.subject;label=`${booking.resource}${booking.instance?` / ${booking.instance}`:''}`;rows=[booking];}}
      if(kind==='resource'){const names=[...new Set([...b.allBookings.flatMap(r=>[r.resource,...(r.instance?[r.instance]:[])]),...b.resources.map(r=>r.resource),...Object.keys(e.data.display.status.host.pools)])];const resource=names.find(r=>detailKey('resource',e.arc,r)===id);if(resource){label=resource;rows=b.allBookings.filter(r=>r.resource===resource||r.instance===resource).sort((a,b)=>cmp(a.startedAt,b.startedAt)||cmp(a.id,b.id));}}
      if(kind==='cpu'){const g=b.groups.find(r=>r.detailKey===id);if(g){const {calls:_calls,...summary}=g;cpu=summary;subject=g.subject;label=`${g.subject.id}: ${stageWords(g.stage)}, attempt ${g.attempt??'not recorded'}`;const parentId=new Set(cpuStageGroups([...e.data.display.status.host.work,...e.data.display.status.units.flatMap(u=>u.work)]).find(r=>sha256Hex(r.id)===g.id)?.invocations??[]);rows=b.allCalls.filter(c=>parentId.has(c.id as never));
        // Retain only the selected window's actual work subset, including unmeasured calls.
        const {scope}=resolveTime(e,f);rows=rows.filter(c=>{if(!('reservedCpu' in c))return false;const at=c.endedAt??c.startedAt;return at?(scope.from===null||Date.parse(at)>=Date.parse(scope.from))&&(scope.to===null||Date.parse(at)<Date.parse(scope.to)):f.window==='arc';});}}
      if(kind==='waiting'){reason=b.reasonRows.find(r=>r.detailKey===id)??null;if(reason){label=reason.label;rows=b.measurements.filter(w=>w.reasons.some(r=>r.reason===reason!.reason));}}
      if(kind==='measurement'){const w=b.measurements.find(r=>r.detailKey===id);if(w){label=`${w.subject.id}: completed ${w.source} waiting`;subject=w.subject;rows=[w];}}
      const bookings=rows.filter((r):r is ResourceBooking=>'holder' in r);
      let ownershipCalls:ResourceCpuCall[]=[];
      if((kind==='booking'||kind==='resource')&&bookings.length){
        const index=projectionIndex(e),intents=new Map(e.data.events.flatMap(ev=>ev.type==='intent'?[[String(ev.op),ev] as const]:[]));
        const existing=new Map(b.allCalls.map(c=>[c.id,c]));
        const selected=new Map<string,ResourceCpuCall>();
        for(const booking of bookings){
          const done=e.data.events.find(ev=>ev.seq===booking.startSeq),intent=done?.type==='done'?intents.get(done.op):undefined;
          if(intent?.kind!=='resource.transition')continue;const holder=intent.expect.holder;
          for(const r of index.invocations.rows){const p=r.parent,spawn=intents.get(invocationIdOf(r.invocation.id).split('#')[0]!);if(!p||!spawn||spawn.seq<booking.startSeq||booking.endSeq!==null&&spawn.seq>=booking.endSeq)continue;
            const matches=(holder.type==='stage'||holder.type==='retry')&&p.type==='stage'&&holder.unit===p.unit&&holder.stage===p.stage&&holder.attempt===p.attempt
              ||holder.type==='publication'&&p.type==='stage'&&holder.unit===p.unit&&['candidate','ff','snapshot'].includes(p.stage)
              ||holder.type==='job'&&p.type==='job'&&holder.job===p.job||holder.type==='docs'&&p.type==='job'&&holder.pub===p.job
              ||holder.type==='sweep'&&p.type==='command'&&holder.command===p.command;
            if(!matches)continue;const i=r.invocation;
            selected.set(i.id,existing.get(i.id)??{id:i.id,invocation:invocationDirName(invocationIdOf(i.id)),subject:b.subject(p.type==='stage'?'unit':p.type==='job'?'job':'arc',p.type==='stage'?p.unit:p.type==='job'?p.job:e.arc),stage:p.type==='stage'?p.stage:i.role,attempt:r.step?.attempt??i.attempt,startedAt:i.startedAt,endedAt:i.endedAt,reservedCpu:i.work?.reservedCpu??null,basis:i.work?.cpuBasis?{kind:i.work.cpuBasis.kind,value:i.work.cpuBasis.value}:null,measured:i.work?.measured??null});
          }
        }
        ownershipCalls=[...selected.values()].sort((a,b)=>cmp(a.startedAt??'',b.startedAt??'')||cmp(a.id,b.id));
      }
      const counts={bookings:bookings.length,calls:kind==='booking'||kind==='resource'?ownershipCalls.length:rows.filter(r=>'reservedCpu' in r).length,measurements:rows.filter(r=>'source' in r).length};
      if(evidence==='calls'&&(kind==='booking'||kind==='resource'))rows=ownershipCalls;
      if(!label)throw new ConsoleError('not-found','Resource evidence is not recorded in this Arc and selection');
      return {rows,context:{...versioned({key:id,kind:kind==='measurement'?'waiting' as const:kind as ResourceDetail['kind'],label,evidence,subject,booking,cpu,reason,counts,bounds:b.context.bounds,filters:f},kind==='resource'||kind==='booking'?resolveTime(e,timeParams({window:'arc'})).scope:b.context.scope),viewVersion:b.context.viewVersion}};
    });
    const bounded=boundDetail(e,`resource:${id}`,data,32*1024);bounded.viewVersion=data.viewVersion;return bounded;
  }
}
