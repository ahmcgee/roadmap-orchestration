// Recorded-completions projection; no presentation adapter, report reads or observation retention.
import type { Envelope } from '../observation/protocol.ts';
import { sha256Hex } from '../core/json.ts';
import { completedWaiting } from '../status/waiting.ts';
import { CollectionPages, responseBound } from './collection-pages.ts';
import { allowParams, choice, invalid, known, list, pageLimit, resolveTime, timeParams } from './query-params.ts';
import { effortRows, projectionIndex, waitingMeasurements } from './tab-projections.ts';
import { resourceQueue } from './resources.ts';
import { graphStatus } from './signals.ts';
import { waitWords, stageWords } from './vocabulary.ts';
import { preview, versioned } from './views.ts';
import type { Money, Subject } from './view-protocol.ts';
import type { EffortFilters, EffortTotals, EffortUnit, EffortView } from './effort-protocol.ts';
const emptyMoney = (): Money => ({costUsd:null,recorded:0,estimated:0,unavailable:0});
const empty = (): EffortTotals => ({agentMs:null,commandMs:null,heldMs:null,queuedMs:null,unallocatedMs:null,spend:emptyMoney(),coverage:{execution:{measured:0,unmeasured:0},money:{recorded:0,estimated:0,unavailable:0},waiting:{measured:0,unmeasuredReservations:null}}});
const metrics = ['agentMs','commandMs','heldMs','queuedMs','unallocatedMs'] as const;
function add(a:EffortTotals,b:EffortTotals) {
  for(const k of metrics)if(b[k]!==null)a[k]=(a[k]??0)+b[k];
  if(b.spend.costUsd!==null)a.spend.costUsd=(a.spend.costUsd??0)+b.spend.costUsd;
  for(const k of ['recorded','estimated','unavailable'] as const){a.spend[k]+=b.spend[k];a.coverage.money[k]+=b.coverage.money[k];}
  for(const k of ['measured','unmeasured'] as const)a.coverage.execution[k]+=b.coverage.execution[k];
  a.coverage.waiting.measured+=b.coverage.waiting.measured;
}
function amount(m:Money):EffortTotals {const v=empty();v.spend=m;v.coverage.money={recorded:m.recorded,estimated:m.estimated,unavailable:m.unavailable};return v;}
const key=(s:Subject)=>`${s.type}:${s.id}`;
export class ConsoleEffort {
  readonly pages:CollectionPages;
  constructor(pages=new CollectionPages()){this.pages=pages;}
  read(e:Envelope,params:Record<string,string>,sourceVersion?:string):EffortView {
    allowParams(params,['window','from','to','zone','metric','group','unit','milestone','system','state','blocked','q','sort','direction','cursor','limit']);
    const q=params['q']??'';if(q.length>200)invalid('Effort search is limited to 200 characters');
    const filters:EffortFilters={...timeParams(params),metric:choice(params,'metric',['work','spend','waiting'],'work'),group:choice(params,'group',['unit'],'unit'),unit:list(params,'unit'),milestone:list(params,'milestone'),system:list(params,'system'),state:list(params,'state'),blocked:choice(params,'blocked',['all','1','0'],'all'),q:q.toLowerCase(),sort:choice(params,'sort',['plan','work','spend','elapsed','redChecks','rounds','held','queued'],'plan'),direction:choice(params,'direction',['asc','desc'],'desc')};
    const limit=pageLimit(params);
    const data=this.pages.page(e,'effort',filters,limit,params['cursor'],()=>{
      const index=projectionIndex(e),{scope,bounds}=resolveTime(e,filters),base=effortRows(e,index),states=e.data.display.status.units;
      known(filters.unit,[...index.identities.keys()],'unit');known(filters.milestone,(e.data.plan?.milestones??[]).map(m=>m.id),'milestone');
      known(filters.system,[...new Set([...index.identities.values()].flatMap(u=>u.systems))],'system');
      known(filters.state,['preparing','ready','running','waiting','blocked','held','parked','awaiting-admission','merged','cut','superseded'],'current unit state');
      const queues=resourceQueue(e.data.display.status.host),rows=new Map<string,EffortUnit>();
      for(const b of base){
        const u=b.subject.type==='unit'?states.find(u=>u.unit===b.subject.id):undefined;
        // Use the complete source reasons, then bound each preview explicitly with a unit detail target.
        const all=u?unitReasons(u,index,queues):[];
        const elapsedMs=b.lifetime.startedAt===null?null:Math.max(0,Date.parse(b.lifetime.endedAt??bounds.terminalAt??e.checkedAt)-Date.parse(b.lifetime.startedAt));
        rows.set(key(b.subject),{...empty(),id:key(b.subject),subject:b.subject,titleTruncated:(index.identities.get(b.subject.id)?.title.length??b.subject.title.length)>b.subject.title.length,signal:u?u.state==='cut'||u.state==='superseded'?'withdrawn':graphStatus(u.state):null,state:b.state,stage:b.stage,systems:b.systems,
          blockers:{reasons:all.slice(0,8).map(text=>preview(text,{type:'unit',id:b.subject.id})),count:all.length,waitSince:u?queues.find(q=>q.unit===u.unit)?.queuedAt===undefined?null:new Date(queues.find(q=>q.unit===u.unit)!.queuedAt!).toISOString():null},
          lifetime:{startedAt:b.lifetime.startedAt,endedAt:b.lifetime.endedAt,elapsedMs,rounds:u?b.lifetime.rounds:null,redChecks:u?b.lifetime.redChecks:null,spend:b.spend}});
      }
      const ensure=(s:Subject)=>{let r=rows.get(key(s));if(!r){r={...empty(),id:key(s),subject:s,titleTruncated:false,signal:null,state:null,stage:null,systems:[],blockers:{reasons:[],count:0,waitSince:null},lifetime:{startedAt:null,endedAt:null,elapsedMs:null,rounds:null,redChecks:null,spend:emptyMoney()}};rows.set(r.id,r);}return r;};
      const selected=(s:Subject)=>{
        const u=s.type==='unit'?index.identities.get(s.id):undefined,r=rows.get(key(s));
        return (!filters.unit.length||!!u&&filters.unit.includes(s.id))&&(!filters.system.length||!!u&&u.systems.some(v=>filters.system.includes(v)))
          &&(!filters.milestone.length||!!u&&(e.data.plan?.milestones??[]).some(m=>filters.milestone.includes(m.id)&&m.units.includes(s.id as never)))
          &&(!filters.state.length||!!r?.state&&filters.state.includes(r.state))&& (filters.blocked==='all'||!!r&&Boolean(r.blockers.count)===(filters.blocked==='1'))
          &&(!filters.q||`${s.id} ${u?.title??s.title}`.toLowerCase().includes(filters.q));
      };
      const totals=empty(),unitTotals=empty(),arcJobTotals=empty(),buckets=new Map<number,EffortTotals>();
      const earliest=Math.min(Date.parse(bounds.from??bounds.to),...e.data.events.map(ev=>Date.parse(ev.at)),...index.invocations.rows.flatMap(({invocation:i})=>i.endedAt?[Date.parse(i.endedAt)]:[]));
      const lo=scope.from===null?earliest:Date.parse(scope.from),hi=Date.parse(scope.to??bounds.to),width=Math.max(1,Math.ceil((hi-lo)/64));
      const within=(at:string)=> (scope.from===null||Date.parse(at)>=Date.parse(scope.from))&&(scope.to===null||Date.parse(at)<Date.parse(scope.to));
      const contribution=(s:Subject,at:string,v:EffortTotals)=>{
        const r=ensure(s);if(!selected(s)||!within(at))return;
        add(r,v);add(totals,v);add(s.type==='unit'?unitTotals:arcJobTotals,v);
        const n=Math.floor((Date.parse(at)-lo)/width),bucket=buckets.get(n)??empty();add(bucket,v);buckets.set(n,bucket);
      };
      for(const {invocation:i,parent} of index.invocations.rows){
        if(!i.endedAt)continue;
        const s=index.subject(parent,i.unit),v=empty();
        if(i.work?.measured&&i.execution!==undefined){v[i.execution==='agent'?'agentMs':'commandMs']=i.work.measured.wallMs;v.coverage.execution.measured=1;}else v.coverage.execution.unmeasured=1;
        // A completed agent with no usage fact has unknown cost, attributed at completion only for coverage.
        if(i.execution==='agent'&&!index.charges.byInvocation.has(i.id)){v.spend.unavailable=1;v.coverage.money.unavailable=1;}
        contribution(s,i.endedAt,v);
      }
      // D4: charge each enclosing usage fact once, at its own recorded timestamp.
      for(const ev of e.data.events){if(ev.type!=='fact'||ev.fact.kind!=='meter'&&ev.fact.kind!=='usage-unavailable')continue;
        const f=ev.fact,u=f.kind==='meter'?f.usage:f.streamed;
        const s:Subject=f.subject.type==='seat'?{type:'unit',id:f.subject.unit,title:index.identities.get(f.subject.unit)?.title.slice(0,96)??f.subject.unit}:f.subject.type==='job'?{type:'job',id:f.subject.job,title:f.subject.job}:{type:'arc',id:e.arc,title:'Arc'};
        contribution(s,ev.at,amount({costUsd:u?.costUsd??null,recorded:u?.costUsd!=null?1:0,estimated:u?.costEstimated?1:0,unavailable:f.kind==='usage-unavailable'||f.incomplete!==undefined||u?.costUsd==null?1:0}));
      }
      for(const m of waitingMeasurements(e,index).rows){const v=empty();v.heldMs=m.heldMs;v.queuedMs=m.queuedMs;v.unallocatedMs=m.unallocatedMs;v.coverage.waiting.measured=1;contribution(m.subject,m.at,v);}
      // Unmeasured reservations have no completion timestamp or exact per-window attribution.
      // Expose only the whole-Arc/unfiltered count, never turn missing coverage into a scoped zero.
      if(filters.window==='arc'&&!filters.unit.length&&!filters.system.length&&!filters.milestone.length&&!filters.state.length&&filters.blocked==='all'&&!filters.q)totals.coverage.waiting.unmeasuredReservations=completedWaiting(e.data.events).unmeasuredReservations;
      const result=[...rows.values()].filter(r=>selected(r.subject));
      const order=(a:EffortUnit,b:EffortUnit)=>a.subject.type==='unit'&&b.subject.type==='unit'?(index.identities.get(a.subject.id)?.order??Number.MAX_SAFE_INTEGER)-(index.identities.get(b.subject.id)?.order??Number.MAX_SAFE_INTEGER)||a.id.localeCompare(b.id):a.subject.type==='unit'?-1:b.subject.type==='unit'?1:a.id.localeCompare(b.id);
      const value=(r:EffortUnit):number|null=>filters.sort==='work'?r.agentMs===null&&r.commandMs===null?null:(r.agentMs??0)+(r.commandMs??0):filters.sort==='spend'?r.spend.costUsd:filters.sort==='elapsed'?r.lifetime.elapsedMs:filters.sort==='redChecks'?r.lifetime.redChecks:filters.sort==='rounds'?r.lifetime.rounds:filters.sort==='held'?r.heldMs:r.queuedMs;
      result.sort((a,b)=>{if(filters.sort==='plan')return order(a,b);const av=value(a),bv=value(b);return av===null||bv===null?av===null?(bv===null?order(a,b):1):-1:(filters.direction==='desc'?bv-av:av-bv)||order(a,b);});
      return {rows:result,context:{...versioned({filters,bounds,totals,buckets:[],membership:'applied-plan-at-anchor' as const,attribution:{unit:unitTotals,arcJob:arcJobTotals}},scope),viewVersion:sourceVersion??sha256Hex(JSON.stringify([e.data.capture.source,'effort'])),
        buckets:[...buckets].sort(([a],[b])=>a-b).map(([n,v])=>({...v,from:new Date(lo+n*width).toISOString(),to:new Date(Math.min(hi,lo+(n+1)*width)).toISOString()}))}};
    });
    return responseBound(e,data,limit===100?256*1024:128*1024);
  }
}
function unitReasons(u:Envelope['data']['display']['status']['units'][number],index:ReturnType<typeof projectionIndex>,queues:ReturnType<typeof resourceQueue>){
  const reasons=waitWords(u.waitingFor),steps=index.stages.byUnit.get(u.unit)??[];
  if(u.state==='parked')reasons.push(`Parked at ${stageWords(u.stage)}${steps.at(-1)?`: ${steps.at(-1)!.outcome}`:''}`);
  const position=queues.filter(q=>q.request.publication).findIndex(q=>q.unit===u.unit);if(position>=0)reasons.push(`Integration queue position ${position+1}`);
  return reasons;
}
