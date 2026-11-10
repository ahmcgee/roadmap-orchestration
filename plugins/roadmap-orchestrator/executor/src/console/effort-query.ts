// Recorded-completions projection; no presentation adapter, report reads or observation retention.
import type { Envelope } from '../observation/protocol.ts';
import { ConsoleError } from '../observation/protocol.ts';
import { sha256Hex } from '../core/json.ts';
import { completedWaiting } from '../status/waiting.ts';
import { CollectionPages, responseBound } from './collection-pages.ts';
import { allowParams, choice, invalid, known, list, pageLimit, resolveTime, timeParams } from './query-params.ts';
import { effortRows, projectionIndex } from './tab-projections.ts';
import { resourceQueue } from './resources.ts';
import { unitSignal } from './signals.ts';
import { journeyMs, stageFinished } from './indexes.ts';
import { waitWords, stageWords } from './vocabulary.ts';
import { milestoneReasons } from './milestones.ts';
import { preview, versioned } from './views.ts';
import type { Subject } from './view-protocol.ts';
import type { EffortFilters, EffortTotals, EffortUnit, EffortView, EffortContribution, EffortScopeView } from './effort-protocol.ts';
import { emptyMoney, emptyEffort as empty, addEffort as add, effortSubjectKey as key, effortGroup, effortDetailKey, EFFORT_DETAIL_KEY, systemSetKey, effortContributions } from './effort-contributions.ts';
export class ConsoleEffort {
  readonly pages:CollectionPages;
  constructor(pages=new CollectionPages()){this.pages=pages;}
  read(e:Envelope,params:Record<string,string>,sourceVersion?:string):EffortView {
    const filters=this.filters(params),limit=pageLimit(params);
    const data=this.pages.page(e,'effort',filters,limit,params['cursor'],()=>{const {rows,context}=this.build(e,filters,sourceVersion);return {rows,context};});
    return responseBound(e,data,limit===100?256*1024:128*1024);
  }
  filters(params:Record<string,string>):EffortFilters {
    allowParams(params,['window','from','to','zone','metric','group','role','systemSet','subject','unit','milestone','system','state','blocked','q','sort','direction','cursor','limit']);
    const q=params['q']??'';if(q.length>200)invalid('Effort search is limited to 200 characters');
    const filters:EffortFilters={...timeParams(params),metric:choice(params,'metric',['work','spend','waiting'],'work'),group:choice(params,'group',['unit','role','system-set'],'unit'),role:list(params,'role'),systemSet:list(params,'systemSet'),subject:list(params,'subject'),unit:list(params,'unit'),milestone:list(params,'milestone'),system:list(params,'system'),state:list(params,'state'),blocked:choice(params,'blocked',['all','1','0'],'all'),q:q.toLowerCase(),sort:choice(params,'sort',['plan','work','spend','elapsed','redChecks','rounds','held','queued'],'plan'),direction:choice(params,'direction',['asc','desc'],'desc')};
    if(filters.group!=='unit'&&['elapsed','redChecks','rounds'].includes(filters.sort))invalid('lifetime unit ranking requires group=unit');
    return filters;
  }
  build(e:Envelope,filters:EffortFilters,sourceVersion?:string) {
      const index=projectionIndex(e),{scope,bounds}=resolveTime(e,filters),base=effortRows(e,index),states=e.data.display.status.units;
      // The recorded values the text filters accept; served so the browser offers only these.
      const facets={unit:[...index.identities.keys()],milestone:(e.data.plan?.milestones??[]).map(m=>String(m.id)),system:[...new Set([...index.identities.values()].flatMap(u=>u.systems))].sort()};
      known(filters.unit,facets.unit,'unit');known(filters.milestone,facets.milestone,'milestone');known(filters.system,facets.system,'system');
      known(filters.state,['preparing','ready','running','waiting','blocked','held','parked','awaiting-admission','merged','cut','superseded'],'current unit state');
      const queues=resourceQueue(e.data.display.status.host),rows=new Map<string,EffortUnit>(),why=milestoneReasons(e);
      for(const b of base){
        const u=b.subject.type==='unit'?states.find(u=>u.unit===b.subject.id):undefined;
        // Use the complete source reasons, then bound each preview explicitly with a unit detail target.
        const all=u?unitReasons(u,index,queues,why):[];
        const elapsedMs=journeyMs(b.lifetime.startedAt,b.lifetime.endedAt,bounds.terminalAt??e.checkedAt);
        rows.set(key(b.subject),{...empty(),id:key(b.subject),subject:b.subject,detailKey:b.subject.type==='unit'&&u?null:effortDetailKey(key(b.subject)),contributorCount:0,titleTruncated:(index.identities.get(b.subject.id)?.title.length??b.subject.title.length)>b.subject.title.length,signal:u?unitSignal(u.state):null,state:b.state,stage:b.stage,stageFinished:u&&b.stage!==null?stageFinished(index.stages.byUnit.get(u.unit),b.stage):false,systems:b.systems,
          blockers:{reasons:all.slice(0,8).map(text=>preview(text,{type:'unit',id:b.subject.id})),count:all.length,waitSince:u?queues.find(q=>q.unit===u.unit)?.queuedAt===undefined?null:new Date(queues.find(q=>q.unit===u.unit)!.queuedAt!).toISOString():null},
          lifetime:{startedAt:b.lifetime.startedAt,endedAt:b.lifetime.endedAt,elapsedMs,rounds:u?b.lifetime.rounds:null,redChecks:u?b.lifetime.redChecks:null,spend:b.spend}});
      }
      const ensure=(s:Subject)=>{let r=rows.get(key(s));if(!r){r={...empty(),id:key(s),subject:s,detailKey:s.type==='unit'&&index.identities.has(s.id)?null:effortDetailKey(key(s)),contributorCount:0,titleTruncated:false,signal:null,state:null,stage:null,stageFinished:false,systems:[],blockers:{reasons:[],count:0,waitSince:null},lifetime:{startedAt:null,endedAt:null,elapsedMs:null,rounds:null,redChecks:null,spend:emptyMoney()}};rows.set(r.id,r);}return r;};
      known(filters.subject,[...rows.keys()],'subject');
      const selected=(s:Subject)=>{
        const u=s.type==='unit'?index.identities.get(s.id):undefined,r=rows.get(key(s));
        return (!filters.subject.length||filters.subject.includes(key(s)))&&(!filters.unit.length||!!u&&filters.unit.includes(s.id))&&(!filters.system.length||!!u&&u.systems.some(v=>filters.system.includes(v)))
          &&(!filters.milestone.length||!!u&&(e.data.plan?.milestones??[]).some(m=>filters.milestone.includes(m.id)&&m.units.includes(s.id as never)))
          &&(!filters.state.length||!!r?.state&&filters.state.includes(r.state))&& (filters.blocked==='all'||!!r&&Boolean(r.blockers.count)===(filters.blocked==='1'))
          &&(!filters.q||`${s.id} ${u?.title??s.title}`.toLowerCase().includes(filters.q));
      };
      const contributions=effortContributions(e,index);
      known(filters.role,[...new Set(contributions.flatMap(c=>c.role===null?['unattributed']:[c.role]))],'role');
      known(filters.systemSet,[...new Set([...index.identities.values()].map(u=>systemSetKey(u.systems)))],'system-set');
      const totals=empty(),unitTotals=empty(),arcJobTotals=empty(),buckets=new Map<number,EffortTotals>();
      const earliest=Math.min(Date.parse(bounds.from??bounds.to),...contributions.map(c=>Date.parse(c.at)));
      const lo=scope.from===null?earliest:Date.parse(scope.from),hi=Date.parse(scope.to??bounds.to),width=Math.max(1,Math.ceil((hi-lo)/64));
      const within=(at:string)=> (scope.from===null||Date.parse(at)>=Date.parse(scope.from))&&(scope.to===null||Date.parse(at)<Date.parse(scope.to));
      const selectedContribution=(c:EffortContribution)=>selected(c.subject)&&(!filters.role.length||filters.role.includes(c.role??'unattributed'))&&(!filters.systemSet.length||c.subject.type==='unit'&&!!index.identities.get(c.subject.id)&&filters.systemSet.includes(systemSetKey(index.identities.get(c.subject.id)!.systems)));
      const chosen:EffortContribution[]=[],groups=new Map<string,EffortUnit>();
      const aggregate=(s:Subject,role:string|null)=>{
        const g=effortGroup(filters.group,s,role,index);let r=groups.get(g.id);
        if(!r){r={...empty(),id:g.id,subject:{type:g.type,id:g.id,title:g.label},detailKey:effortDetailKey(g.id),contributorCount:0,titleTruncated:false,signal:null,state:null,stage:null,stageFinished:false,systems:filters.group==='system-set'&&s.type==='unit'?[...index.identities.get(s.id)?.systems??[]].sort():[],blockers:{reasons:[],count:0,waitSince:null},lifetime:{startedAt:null,endedAt:null,elapsedMs:null,rounds:null,redChecks:null,spend:emptyMoney()}};groups.set(g.id,r);}return r;
      };
      // Keep each plan unit/system-set available even without a completed measurement.
      for(const r of rows.values())if(r.subject.type==='unit'&&selected(r.subject as Subject)&&(!filters.systemSet.length||filters.systemSet.includes(systemSetKey(r.systems)))&&(!filters.role.length||contributions.some(c=>key(c.subject)===r.id&&selectedContribution(c)))){
        if(filters.group==='system-set')aggregate(r.subject as Subject,null);
      }
      for(const c of contributions){
        const r=ensure(c.subject);if(!selectedContribution(c))continue;
        const target=filters.group==='unit'?r:aggregate(c.subject,c.role);
        if(filters.group!=='unit'){
          if(c.spend.costUsd!==null)target.lifetime.spend.costUsd=(target.lifetime.spend.costUsd??0)+c.spend.costUsd;
          for(const k of ['recorded','estimated','unavailable'] as const)target.lifetime.spend[k]+=c.spend[k];
        }
        if(!within(c.at))continue;
        chosen.push(c);target.contributorCount++;add(target,c);add(totals,c);add(c.subject.type==='unit'?unitTotals:arcJobTotals,c);
        const n=Math.floor((Date.parse(c.at)-lo)/width),bucket=buckets.get(n)??empty();add(bucket,c);buckets.set(n,bucket);
      }
      // Unmeasured reservations have no completion timestamp or exact per-window attribution.
      // Expose only the whole-Arc/unfiltered count, never turn missing coverage into a scoped zero.
      if(filters.window==='arc'&&!filters.unit.length&&!filters.system.length&&!filters.milestone.length&&!filters.state.length&&filters.blocked==='all'&&!filters.q&&!filters.role.length&&!filters.systemSet.length&&!filters.subject.length)totals.coverage.waiting.unmeasuredReservations=completedWaiting(e.data.events).unmeasuredReservations;
      const result=filters.group==='unit'?[...rows.values()].filter(r=>selected(r.subject as Subject)&&(!filters.systemSet.length||r.subject.type==='unit'&&filters.systemSet.includes(systemSetKey(r.systems)))&&(!filters.role.length||contributions.some(c=>selectedContribution(c)&&key(c.subject)===r.id))):[...groups.values()];
      const order=(a:EffortUnit,b:EffortUnit)=>filters.group==='system-set'&&(a.subject.type==='system-set')!==(b.subject.type==='system-set')?a.subject.type==='system-set'?-1:1:a.subject.type==='unit'&&b.subject.type==='unit'?(index.identities.get(a.subject.id)?.order??Number.MAX_SAFE_INTEGER)-(index.identities.get(b.subject.id)?.order??Number.MAX_SAFE_INTEGER)||a.id.localeCompare(b.id):a.subject.type==='unit'?-1:b.subject.type==='unit'?1:a.id.localeCompare(b.id);
      const value=(r:EffortUnit):number|null=>filters.sort==='work'?r.agentMs===null&&r.commandMs===null?null:(r.agentMs??0)+(r.commandMs??0):filters.sort==='spend'?r.spend.costUsd:filters.sort==='elapsed'?r.lifetime.elapsedMs:filters.sort==='redChecks'?r.lifetime.redChecks:filters.sort==='rounds'?r.lifetime.rounds:filters.sort==='held'?r.heldMs:r.queuedMs;
      result.sort((a,b)=>{if(filters.sort==='plan')return order(a,b);const av=value(a),bv=value(b);return av===null||bv===null?av===null?(bv===null?order(a,b):1):-1:(filters.direction==='desc'?bv-av:av-bv)||order(a,b);});
      const rowCounts={unit:0,arc:0,job:0,role:0,'system-set':0,unattributed:0};for(const r of result)rowCounts[r.subject.type]++;
      return {rows:result,contributions:chosen,context:{...versioned({filters,bounds,facets,totals,buckets:[],histogram:{from:new Date(lo).toISOString(),to:new Date(hi).toISOString(),widthMs:width},rowCounts,membership:'applied-plan-at-anchor' as const,attribution:{unit:unitTotals,arcJob:arcJobTotals}},scope),viewVersion:sourceVersion??sha256Hex(JSON.stringify([e.data.capture.source,'effort'])),
        buckets:[...buckets].sort(([a],[b])=>a-b).map(([n,v])=>({...v,from:new Date(lo+n*width).toISOString(),to:new Date(Math.min(hi,lo+(n+1)*width)).toISOString()}))}};
  }
  detail(e:Envelope,id:string,params:Record<string,string>,sourceVersion?:string):EffortScopeView {
    if(!EFFORT_DETAIL_KEY.test(id))invalid('invalid effort scope key');
    const {section:rawSection,...query}=params,section=choice({section:rawSection??'subjects'},'section',['subjects','measurements'],'subjects');
    const filters=this.filters(query),limit=pageLimit({...query,limit:query['limit']??'25'});
    const data=this.pages.page<EffortScopeView['rows'][number],Omit<EffortScopeView,'rows'|'page'>>(e,`effort-scope:${id}:${section}`,filters,limit,query['cursor'],()=>{
      const built=this.build(e,filters,sourceVersion),selected=built.rows.find(r=>r.detailKey===id);
      if(!selected)throw new ConsoleError('not-found','Effort scope is not recorded in this selection');
      const index=projectionIndex(e),contributions=built.contributions.filter(c=>effortDetailKey(effortGroup(filters.group,c.subject,c.role,index).id)===id);
      const subjects=new Map<string,ReturnType<typeof empty>&{id:string;subject:Subject;unitRef:string|null;contributionCount:number}>();
      for(const c of contributions){const k=key(c.subject),r=subjects.get(k)??{...empty(),id:k,subject:c.subject,unitRef:c.unitRef,contributionCount:0};add(r,c);r.contributionCount++;subjects.set(k,r);}
      const filter={role:filters.group==='role'?selected.subject.type==='unattributed'?'unattributed':selected.id.slice('role:'.length):null,systemSet:filters.group==='system-set'&&selected.subject.type==='system-set'?selected.id.slice('system-set:'.length):null,subject:filters.group==='unit'||filters.group==='system-set'&&['job','arc'].includes(selected.subject.type)?selected.id:filters.group==='system-set'&&selected.subject.type==='unattributed'?[...subjects.keys()].join(',')||null:null};
      return {rows:section==='subjects'?[...subjects.values()].sort((a,b)=>a.id.localeCompare(b.id)):contributions.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)),context:{...versioned({key:id,group:filters.group,label:selected.subject.title,section,filters,totals:{agentMs:selected.agentMs,commandMs:selected.commandMs,heldMs:selected.heldMs,queuedMs:selected.queuedMs,unallocatedMs:selected.unallocatedMs,spend:selected.spend,coverage:selected.coverage},counts:{subjects:subjects.size,measurements:contributions.length},filter},built.context.scope),viewVersion:built.context.viewVersion}};
    });
    return responseBound(e,data,32*1024);
  }

}
function unitReasons(u:Envelope['data']['display']['status']['units'][number],index:ReturnType<typeof projectionIndex>,queues:ReturnType<typeof resourceQueue>,why:ReadonlyMap<string,string>){
  const reasons=waitWords(u.waitingFor,why),steps=index.stages.byUnit.get(u.unit)??[];
  if(u.state==='parked')reasons.push(`Parked at ${stageWords(u.stage)}${steps.at(-1)?`: ${steps.at(-1)!.outcome}`:''}`);
  const position=queues.filter(q=>q.request.publication).findIndex(q=>q.unit===u.unit);if(position>=0)reasons.push(`Integration queue position ${position+1}`);
  return reasons;
}
