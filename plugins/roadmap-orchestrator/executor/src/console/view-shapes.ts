// Pure runtime validators shared by server and browser.
import { CONSOLE_UI_SCHEMA } from './view-protocol.ts';
import { ACTIVITY_KINDS } from './activity-protocol.ts';
type Check = (v: unknown) => boolean;
const str: Check = v => typeof v === 'string';
const bool: Check = v => typeof v === 'boolean';
const nat: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const num: Check = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const date: Check = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullable = (check: Check): Check => v => v === null || check(v);
const array = (check: Check): Check => v => Array.isArray(v) && v.every(check);
function object(fields: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const record = v as Record<string, unknown>;
    return Object.keys(record).every(k => Object.hasOwn(fields, k) || Object.hasOwn(optional, k))
      && Object.entries(fields).every(([k, check]) => Object.hasOwn(record, k) && check(record[k]))
      && Object.entries(optional).every(([k, check]) => !Object.hasOwn(record, k) || check(record[k]));
  };
}
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const dictionary = (check: Check): Check => v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(check);
const scope = object({basis: oneOf('current', 'recorded-arc'), from: nullable(date), to: nullable(date)});
const base = {uiSchema: oneOf(CONSOLE_UI_SCHEMA), viewVersion: (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), scope};
const detail = object({type: oneOf('unit', 'invocation', 'request', 'event', 'resource'), id: str});
const preview = object({text: str, truncated: bool, detail});
export const shellShape = object({...base,
  identity: object({arc: str, direction: nullable(object({text: str, truncated: bool}))}), lifecycle: object({state: str, startedAt: nullable(date), endedAt: nullable(date)}),
  progress: object({total: nat, countsByState: dictionary(nat), merged: nat, withdrawn: nat}),
  spend: object({costUsd: num, estimatedCalls: nat, unavailableCalls: nat}),
  attention: object({total: nat, blocking: nat, informational: nat}), availableRange: object({from: nullable(date), to: nullable(date)}),
});
const edge: Check = v => [
  object({kind: oneOf('after'), source: str, target: str, on: str, met: bool}),
  object({kind: oneOf('milestone'), source: str, target: str, passed: bool}),
  object({kind: oneOf('feeds'), source: str, target: str}),
  object({kind: oneOf('contingent'), target: str, edge: str, condition: preview, resolved: bool}),
].some(check => check(v));
export const graphShape = object({...base,
  units: array(object({id: str, title: str, titleTruncated: bool, signal: oneOf('passed', 'active', 'held', 'pending', 'failed', 'withdrawn'), state: str, stage: str, stageFinished: bool, systems: array(str), lineageRef: nullable(str)})),
  milestones: array(object({id: str, state: str, passed: bool, memberIds: array(str), merged: nat, withdrawn: nat, signal: oneOf('passed', 'active', 'held', 'pending', 'failed', 'withdrawn'), reason: nullable(str), costUsd: num}, {name: str})),
  noMilestone: object({ids: array(str), merged: nat, withdrawn: nat}),
  edges: array(edge), focus: object({activeIds: array(str), firstUncleared: nullable(str)}),
});
const signal=oneOf('passed','active','held','pending','failed','withdrawn');
const money=object({costUsd:nullable(num),recorded:nat,estimated:nat,unavailable:nat});
const subject=object({type:oneOf('unit','arc','job'),id:str,title:str});
const invocation=object({id:str,routeId:str,unit:str,stage:str,attempt:nat,kind:oneOf('agentic','deterministic'),execution:str,status:signal,startedAt:date,label:str,round:nullable(nat),spend:money,subject,systems:array(str),endedAt:nullable(date),outcome:str},{elapsedMs:num,model:str});
const continuation=object({path:array(v=>(typeof v==='string'&&!['__proto__','constructor','prototype'].includes(v))||nat(v)),kind:oneOf('text','list'),total:nat,offset:nat,next:str});
const expansions={continuations:array(continuation)};
export const contentShape=object({...base,content:object({path:array(v=>str(v)||nat(v)),kind:oneOf('text','list'),value:v=>typeof v==='string'||Array.isArray(v),offset:nat,total:nat,next:oneOf(null)}),continuations:array(continuation)});
const unit=object({id:str,title:str,state:str,stage:str,stageFinished:bool,signal,startedAt:nullable(date),endedAt:nullable(date),arcEndedAt:nullable(date),elapsedMs:nullable(num),attempts:nat,rounds:nat,spend:money,reasons:array(str),waitSince:nullable(date),lineage:nullable(object({reenters:str,root:str,prepared:bool}))});
const related=object({id:str,title:str,state:str,signal,source:str,target:str,unmet:bool},{replacedBy:object({id:str,state:str,signal})});
const page=(row:Check)=>object({rows:array(row),asOf:object({epoch:str,highWater:nat,observedAt:date}),next:nullable(str),total:nat});
const text=object({text:str,next:nullable(str)});
const gate=object({id:str,name:nullable(str),passed:bool});
const step=object({housekeeping:bool,id:str,stage:str,label:str,attempt:nat,sequence:nat,round:nat,at:date,endedAt:nullable(date),outcome:str,findingTitles:array(str),activities:array(str),notes:array(str)});
export const unitSummaryShape=object({...base,unit},expansions);
const coverageMoney=object({recorded:nat,estimated:nat,unavailable:nat}),coverageTime=object({measured:nat,unmeasured:nat});
const availability=oneOf('available','pruned','not-recorded','not-applicable','unavailable');
export const invocationShape=object({...base,invocation,actor:object({role:str,backend:nullable(str),model:nullable(str),requestedModel:nullable(str)}),measured:nullable(object({wallMs:num,runMs:num,waitMs:num})),reservedCpu:nullable(num),cpuBasis:nullable(object({kind:oneOf('explicit','default','calibrated'),value:num,samples:nullable(nat)})),parent:object({type:oneOf('unit','arc','job'),id:str,stage:nullable(str),sequence:nullable(nat)}),coverage:object({money:coverageMoney,execution:coverageTime}),detailAvailability:object({result:availability,prompt:availability,history:availability,logs:object({stdout:availability,stderr:availability,runner:availability})}),related:page(related)},expansions);
export const unitShape=object({...base,unit,systems:array(str),supersededBy:nullable(str),coverage:object({money:coverageMoney,execution:coverageTime,waiting:coverageTime}),currentBlockers:nullable(object({dependencies:array(str),milestones:array(str),contingentEdges:array(str),resources:nullable(object({named:array(str),pools:array(str),cpu:num,publication:bool})),environmentBlocked:bool,pressureBlocked:nullable(bool),tokenWaitMs:nullable(num),admission:array(object({kind:str,references:array(object({field:str,id:str})),scope:nullable(str),parkClass:nullable(str),reason:nullable(str),decision:nullable(str),probe:nullable(object({kind:str,id:nullable(str)}))})),drainCommands:array(str)})),feeds:array(gate),waits:array(gate),depends:page(related),usedBy:page(related),journey:page(step),invocations:page(invocation),acceptance:page(str),waiting:page(object({at:date,stage:str,totalMs:num,reasons:array(object({reason:str,ms:num}))})),checks:page(object({id:str,outcome:str})),requests:page(object({id:str,summary:str,recommendation:str})),intent:text},expansions);
export const milestoneShape=object({...base,id:str,name:nullable(str),state:str,passed:bool,total:nat,merged:nat,withdrawn:nat,reason:nullable(str),costUsd:num,members:page(related),intent:text},expansions);
export const metadataShape=object({protocol:str,instance:str,repoId:str,arc:str,epoch:str,highWater:nat,revision:nat,observedAt:date,checkedAt:date,uiSchema:oneOf(CONSOLE_UI_SCHEMA),selected:nullable(str),viewVersions:object(Object.fromEntries(['shell','graph','timeline','activity','holistic','effort','resources','attention'].map(k=>[k,base.viewVersion])))},{kind:str});

const actor=object({role:nullable(str),backend:nullable(str),model:nullable(str)});
const activitySubject:Check=v=>subject(v)||object({type:oneOf('host','findings','request'),id:nullable(str),title:str})(v);
const activityRow=object({id:str,seq:nat,at:date,kind:oneOf(...ACTIVITY_KINDS),subject:activitySubject,stage:nullable(str),attempt:nullable(nat),round:nullable(nat),
  actor:nullable(actor),actorCount:nat,outcome:nullable(str),result:nullable(preview),summary:preview,workMs:nullable(num),spend:nullable(money),coverage:coverageTime,detail,housekeeping:bool});
const activityFilters=object({from:nullable(date),to:nullable(date),afterSeq:nullable(nat),beforeSeq:nullable(nat),unit:array(str),milestone:array(str),stage:array(str),
  kind:array(oneOf(...ACTIVITY_KINDS)),role:array(str),backend:array(str),model:array(str),outcome:array(str),q:str,housekeeping:bool,order:oneOf('asc','desc'),zone:str});
const facets=(keys:readonly string[]):Check=>object(Object.fromEntries(keys.map(k=>[k,array(str)])));
export const activityShape=object({...base,filters:activityFilters,facets:facets(['unit','milestone','stage','role','backend','model','outcome']),membership:oneOf('applied-plan-at-anchor'),days:array(object({date:str,count:nat})),rows:array(activityRow),
  page:object({anchor:str,next:nullable(str),previous:nullable(str),limit:oneOf(25,50,100),matching:nat,returned:nat,asOf:object({epoch:str,highWater:nat,observedAt:date})})});
export const activityChangesShape=object({...base,newMatching:nat,latestHighWater:nat,latestViewVersion:base.viewVersion});
const backendHold=object({id:str,backend:str,recordedClass:oneOf('usage-limit','capacity','outage'),effectiveClass:oneOf('usage-limit','capacity','outage'),invocation:nullable(str),startSeq:nat,startedAt:date,
  endedAt:nullable(date),closure:nullable(object({kind:oneOf('resumed','probe','park-updated'),seq:nat,at:date,detail})),terminalAt:nullable(date),detail});
export const activityDetailShape=object({...base,row:activityRow,evidenceAvailability:oneOf('available','pruned','not-applicable'),context:array(object({label:str,value:str})),
  invocations:array(object({id:str,subject,stage:str,attempt:nat,actor,startedAt:date,endedAt:nullable(date),wallMs:nullable(num),spend:money})),backendHold:nullable(backendHold)},expansions);

const collectionPage=(limit:Check)=>object({anchor:str,next:nullable(str),previous:nullable(str),limit,matching:nat,returned:nat,asOf:object({epoch:str,highWater:nat,observedAt:date})});
const temporalFilters=object({window:oneOf('arc','24h','7d',null),from:nullable(date),to:nullable(date),zone:str,unit:array(str),milestone:array(str),state:array(str),stage:array(str),execution:array(oneOf('agent','command','unknown')),q:str,sort:oneOf('plan','open','longest-open'),subject:nullable(str)});
const temporalBase={...base,filters:temporalFilters,bounds:object({from:nullable(date),to:date,terminalAt:nullable(date)})};
const mark:Check=v=>object({type:oneOf('interval'),id:str,startedAt:date,endedAt:nullable(date),stage:str,outcome:str,invocation:str})(v)||object({type:oneOf('cluster'),from:date,to:date,count:nat,countsByOutcome:dictionary(nat),subject:str})(v);
const track=object({id:str,subject,state:nullable(str),signal:nullable(oneOf('passed','active','held','pending','failed','withdrawn')),intervalCount:nat,openCount:nat,firstAt:date,lastAt:nullable(date),marks:v=>Array.isArray(v)&&v.length<=32&&v.every(mark),detail:nullable(detail)});
const arcOverview=object({range:object({from:date,to:date,widthMs:nat}),buckets:v=>Array.isArray(v)&&v.length<=512&&v.every(object({from:date,to:date,count:nat})),backendHolds:object({rows:v=>Array.isArray(v)&&v.length<=64&&v.every(backendHold),matching:nat})});
export const timelineShape=object({...temporalBase,rows:array(track),page:collectionPage(oneOf(25,50,100)),facets:facets(['unit','milestone','stage']),overview:arcOverview});
const interval=object({id:str,invocation:str,subject,stage:str,attempt:nat,round:nullable(nat),actor:object({role:str,backend:nullable(str),model:nullable(str)}),outcome:str,startedAt:date,endedAt:nullable(date),wallMs:nullable(num),spend:money});
export const intervalsShape=object({...temporalBase,rows:array(interval),page:collectionPage(oneOf(25,50,100,200))});
export const holdsShape=object({...temporalBase,rows:array(backendHold),page:collectionPage(oneOf(25,50,100))});
const evidencePreview=object({text:str,truncated:bool,detail:nullable(detail)},{field:object({key:str,name:oneOf('claim','oneLine')})});
export const holisticFieldShape=object({...base,key:str,name:oneOf('claim','oneLine'),text:str,offset:nat,next:nullable(nat),total:nat});
const findingSource:Check=v=>object({type:oneOf('audit'),job:str})(v)||object({type:oneOf('stage'),unit:str,stage:str})(v)||object({type:oneOf('other')})(v);
const holisticRow:Check=v=>object({type:oneOf('audit'),id:str,at:date,job:str,outcome:str,verdict:nullable(str),coverageCount:nat,findingCount:nat,detail,coverage:array(object({lens:str,from:str,to:str})),coverageTruncated:bool})(v)
  ||object({type:oneOf('finding'),id:str,claim:evidencePreview,state:str,detail:nullable(detail),foundBy:nullable(findingSource),foundAt:nullable(date)})(v)
  ||object({type:oneOf('decision'),id:str,recordId:str,seq:nat,at:nullable(date),kind:str,oneLine:evidencePreview,ruledBy:v=>object({type:oneOf('architect'),command:nullable(str)})(v)||object({type:oneOf('judgment'),role:oneOf('verifier')})(v)||object({type:oneOf('executor')})(v),detail:nullable(detail)})(v);
export const holisticShape=object({...base,section:oneOf('audits','findings','decisions'),enabled:bool,currentAudit:nullable(object({running:bool,job:nullable(str)})),latestOutcome:nullable(object({at:date,job:str,outcome:str,verdict:nullable(str)})),counts:object({audits:nat,findings:nat,raised:nat,decisions:nat}),rows:array(holisticRow),page:collectionPage(oneOf(25,50,100))});

const requestSubject:Check=v=>object({type:oneOf('unit'),id:str,title:str})(v)||object({type:oneOf('arc','host')})(v)||object({type:oneOf('findings'),count:nat})(v);
export const attentionShape=object({...base,filters:object({blocking:oneOf('all','1','0'),subjectType:array(oneOf('unit','arc','host','findings')),reason:array(str),q:str,sort:oneOf('oldest','newest')}),counts:object({total:nat,blocking:nat,informational:nat}),rows:array(object({id:str,raisedAt:date,blocking:bool,subject:requestSubject,reason:str,summary:preview,recommendationPreview:preview,evidenceCount:nat})),reasons:array(str),page:collectionPage(oneOf(25,50,100))});
export const requestShape=object({...base,id:str,open:bool,evidenceAvailability:oneOf('available','pruned'),recordPreview:nullable(object({raisedAt:date,blocking:bool,subject:requestSubject,reason:str})),resolutionEvidence:array(object({kind:oneOf('acknowledged','declined','no-longer-open'),source:oneOf('journal','ack-file','open-list'),at:nullable(date),command:nullable(str),choice:nullable(str)})),fields:object({summary:str,recommendation:str}),options:array(object({id:str,label:str,command:nullable(str)})),evidenceRefs:array(object({path:str,invocation:nullable(str)})),affectedUnits:array(object({id:str,title:str})),findingRefs:array(object({id:str,event:nullable(str)})),guidance:object({command:nullable(str),text:str})},expansions);

const effortCoverage=object({execution:coverageTime,money:coverageMoney,waiting:object({measured:nat,unmeasuredReservations:nullable(nat)})});
const effortTotals={agentMs:nullable(num),commandMs:nullable(num),heldMs:nullable(num),queuedMs:nullable(num),unallocatedMs:nullable(num),spend:money,coverage:effortCoverage};
const effortFilters=object({window:oneOf('24h','7d','arc',null),from:nullable(date),to:nullable(date),zone:str,metric:oneOf('work','spend','waiting'),group:oneOf('unit','role','system-set'),role:array(str),systemSet:array(str),subject:array(str),unit:array(str),milestone:array(str),system:array(str),state:array(str),blocked:oneOf('all','1','0'),q:str,sort:oneOf('plan','work','spend','elapsed','redChecks','rounds','held','queued'),direction:oneOf('asc','desc')});
const effortSubject=object({type:oneOf('unit','arc','job','role','system-set','unattributed'),id:str,title:str});
export const effortShape=object({...base,filters:effortFilters,bounds:object({from:nullable(date),to:date,terminalAt:nullable(date)}),facets:facets(['unit','milestone','system']),membership:oneOf('applied-plan-at-anchor'),histogram:object({from:date,to:date,widthMs:nat}),rowCounts:object({unit:nat,arc:nat,job:nat,role:nat,'system-set':nat,unattributed:nat}),totals:object(effortTotals),attribution:object({unit:object(effortTotals),arcJob:object(effortTotals)}),buckets:v=>Array.isArray(v)&&v.length<=64&&v.every(object({...effortTotals,from:date,to:date})),rows:array(object({...effortTotals,id:str,subject:effortSubject,detailKey:nullable(str),contributorCount:nat,titleTruncated:bool,signal:nullable(signal),state:nullable(str),stage:nullable(str),stageFinished:bool,systems:array(str),blockers:object({reasons:array(preview),count:nat,waitSince:nullable(date)}),lifetime:object({startedAt:nullable(date),endedAt:nullable(date),elapsedMs:nullable(num),rounds:nullable(nat),redChecks:nullable(nat),spend:money})})),page:collectionPage(oneOf(25,50,100))});
const effortContribution=object({...effortTotals,id:str,kind:oneOf('work','money','waiting'),subject,unitRef:nullable(str),role:nullable(str),at:date,stage:nullable(str),invocation:nullable(str),waiting:nullable(object({source:oneOf('admission','reservation'),totalMs:num,reasons:array(object({reason:str,ms:num}))}))});
export const effortScopeShape=object({...base,key:str,group:oneOf('unit','role','system-set'),label:str,section:oneOf('subjects','measurements'),filters:effortFilters,totals:object(effortTotals),counts:object({subjects:nat,measurements:nat}),filter:object({role:nullable(str),systemSet:nullable(str),subject:nullable(str)}),rows:array(v=>effortContribution(v)||object({...effortTotals,id:str,subject,unitRef:nullable(str),contributionCount:nat})(v)),page:collectionPage(oneOf(25,50,100))});

// Resource DTOs carry recorded measurements and bounded selected evidence only.
const resourceSubject=object({type:oneOf('unit','job','arc'),id:str,title:str,titleTruncated:bool,unitRef:nullable(str)});
const resourceBooking=object({id:str,resource:str,instance:nullable(str),holder:object({type:str,id:str},{unitId:str}),startedAt:date,endedAt:nullable(date),state:oneOf('holding','done'),startSeq:nat,endSeq:nullable(nat),subject:resourceSubject,resourceKey:str,detailKey:str});
const resourceCall=object({id:str,invocation:nullable(str),subject:resourceSubject,stage:str,attempt:nullable(nat),startedAt:nullable(date),endedAt:nullable(date),reservedCpu:nullable(num),basis:nullable(object({kind:str,value:num})),measured:nullable(object({wallMs:num,runMs:num,waitMs:num}))});
const resourceCpuFields={id:str,parent:object({type:oneOf('unit','arc','job'),id:str,stage:nullable(str),attempt:nullable(nat)}),measuredRunMs:num,measuredWallMs:num,reservedCoreMs:num,averageCores:nullable(num),weightedReservedCores:nullable(num),reservationPercent:nullable(num),measuredCalls:nat,excludedCalls:nat,unmeasuredCalls:nat,zeroWallCalls:nat,unreservedCalls:nat,unreservedAverageCores:nullable(num),detailKey:str,subject:resourceSubject,stage:str,attempt:nullable(nat),callCount:nat};
const resourceCpu=object({...resourceCpuFields,calls:v=>Array.isArray(v)&&v.length<=3&&v.every(resourceCall)});
const resourceWait=object({id:str,subject:resourceSubject,stage:nullable(str),source:oneOf('admission','reservation'),at:date,totalMs:num,heldMs:num,queuedMs:num,unallocatedMs:num,reasons:array(object({reason:str,ms:num})),reasonCount:nat,unitRef:nullable(str),detailKey:str});
const bookingMark:Check=v=>object({type:oneOf('booking'),id:str,detailKey:str,holder:str,unitRef:nullable(str),startedAt:date,endedAt:nullable(date),state:oneOf('holding','done')})(v)||object({type:oneOf('cluster'),from:date,to:date,count:nat})(v);
const resourceLane=object({id:str,resource:str,instance:nullable(str),resourceKey:str,count:nat,open:nat,marks:v=>Array.isArray(v)&&v.length<=16&&v.every(bookingMark)});
const resourceReason=object({id:str,reason:str,label:str,totalMs:num,count:nat,detailKey:str});
const nowResource=object({id:str,kind:oneOf('resource'),resource:str,state:str,holder:nullable(str),holderTitle:nullable(str),unitRef:nullable(str),pending:bool,startedAt:nullable(date),detailKey:str});
const nowQueue=object({id:str,kind:oneOf('queue'),position:nat,subject:resourceSubject,queuedAt:nullable(date),publication:bool,named:array(str),pools:array(str),cpu:num});
const nowBlocker=object({id:str,kind:oneOf('blocker'),subject:resourceSubject,reasons:array(preview),reasonCount:nat});
const nowPool=object({id:str,kind:oneOf('pool'),resource:str,detailKey:str,size:num,used:num,dirty:num});
const resourceNowRow:Check=v=>nowResource(v)||nowQueue(v)||nowBlocker(v)||nowPool(v);
const nowPreview=(row:Check)=>object({rows:v=>Array.isArray(v)&&v.length<=5&&v.every(row),matching:nat});
const resourceNow=object({queueAvailable:nullable(bool),cpuReservation:nullable(object({used:num,capacity:num})),integration:nowPreview(nowResource),queues:nowPreview(nowQueue),blockers:nowPreview(nowBlocker),counts:object({resources:nat,queues:nat,pools:nat,blockers:nat}),unknownQueueStarts:nat});
const resourceFilters=object({section:oneOf('schedule','cpu','waiting','now'),window:oneOf('arc','24h','7d',null),from:nullable(date),to:nullable(date),zone:str,resource:array(str),unit:array(str),stage:array(str),state:array(str),reason:array(str),utilization:oneOf('all','under10','over100','unmeasured'),q:str,sort:oneOf('resource','start','duration','unit','utilization','coreTime','reason','count','scheduler'),direction:oneOf('asc','desc')});
const resourceBounds=object({from:nullable(date),to:date,terminalAt:nullable(date)});
const resourcesBase=object({...base,section:oneOf('schedule','cpu','waiting','now'),filters:resourceFilters,facets:facets(['resource','unit','stage','reason']),bounds:resourceBounds,now:resourceNow,counts:object({schedule:nullable(nat),cpu:nullable(nat),waiting:nullable(nat),now:nullable(nat)}),coverage:object({matchedCalls:nat,excludedCalls:nat,unmeasuredCalls:nat,zeroWallCalls:nat,unreservedCalls:nat,measuredStages:nat,under10Stages:nat,over100Stages:nat,waitingMeasurements:nat,unmeasuredReservations:nullable(nat)}),overview:object({backendHolds:nullable(object({rows:array(backendHold),matching:nat})),resourceCount:nat,arc:nullable(arcOverview),lanes:nullable(object({rows:v=>Array.isArray(v)&&v.length<=24&&v.every(resourceLane),matching:nat})),reasons:array(resourceReason),reasonCount:nat,totalWaitingMs:nullable(num),unallocatedMs:nullable(num)}),rows:array(v=>resourceBooking(v)||resourceCpu(v)||resourceWait(v)||resourceNowRow(v)),page:collectionPage(oneOf(25,50,100))});
const resourceDetailBase=object({...base,key:str,kind:oneOf('booking','resource','cpu','waiting'),label:str,evidence:oneOf('ownership','calls','measurements'),subject:nullable(resourceSubject),booking:nullable(resourceBooking),cpu:nullable(object(resourceCpuFields)),reason:nullable(resourceReason),counts:object({bookings:nat,calls:nat,measurements:nat}),bounds:resourceBounds,filters:resourceFilters,rows:array(v=>resourceBooking(v)||resourceCall(v)||resourceWait(v)),page:collectionPage(oneOf(25,50,100))},expansions);

export const resourceReasonsShape=object({...base,filters:resourceFilters,bounds:resourceBounds,rows:array(resourceReason),page:collectionPage(oneOf(25,50,100))});

export const resourcesShape:Check=v=>resourcesBase(v)&&((v as any).rows as unknown[]).every((r:unknown)=>((v as any).section==='schedule'?resourceBooking:(v as any).section==='cpu'?resourceCpu:(v as any).section==='waiting'?resourceWait:resourceNowRow)(r));
export const resourceDetailShape:Check=v=>resourceDetailBase(v)&&((v as any).rows as unknown[]).every((r:unknown)=>((v as any).evidence==='ownership'?resourceBooking:(v as any).evidence==='calls'?resourceCall:resourceWait)(r));
