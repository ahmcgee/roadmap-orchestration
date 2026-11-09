// D3/D4/D5: one contribution per completed measurement or enclosing charge.
// Roles come from recorded invocations or charge subjects; waits have no recorded role.
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { Envelope } from '../observation/protocol.ts';
import { projectionIndex, waitingMeasurements } from './tab-projections.ts';
import type { EffortContribution, EffortGroup, EffortTotals } from './effort-protocol.ts';
import type { Money, Subject } from './view-protocol.ts';
export const emptyMoney = (): Money => ({costUsd:null,recorded:0,estimated:0,unavailable:0});
export const emptyEffort = (): EffortTotals => ({agentMs:null,commandMs:null,heldMs:null,queuedMs:null,unallocatedMs:null,spend:emptyMoney(),coverage:{execution:{measured:0,unmeasured:0},money:{recorded:0,estimated:0,unavailable:0},waiting:{measured:0,unmeasuredReservations:null}}});
export function addEffort(a:EffortTotals,b:EffortTotals) {
  for(const k of ['agentMs','commandMs','heldMs','queuedMs','unallocatedMs'] as const)if(b[k]!==null)a[k]=(a[k]??0)+b[k];
  if(b.spend.costUsd!==null)a.spend.costUsd=(a.spend.costUsd??0)+b.spend.costUsd;
  for(const k of ['recorded','estimated','unavailable'] as const){a.spend[k]+=b.spend[k];a.coverage.money[k]+=b.coverage.money[k];}
  for(const k of ['measured','unmeasured'] as const)a.coverage.execution[k]+=b.coverage.execution[k];
  a.coverage.waiting.measured+=b.coverage.waiting.measured;
}
export const effortSubjectKey=(s:Subject)=>`${s.type}:${s.id}`;
export const systemSetKey=(systems:readonly string[])=>sha256Hex(JSON.stringify([...systems].sort()));
export function effortGroup(group:EffortGroup,subject:Subject,role:string|null,index:ReturnType<typeof projectionIndex>) {
  if(group==='unit')return {id:effortSubjectKey(subject),label:subject.type==='arc'?'Arc work':subject.type==='job'?`Job ${subject.id}`:subject.title,type:subject.type};
  if(group==='role')return role===null?{id:'unattributed',label:'Role not recorded',type:'unattributed' as const}:{id:`role:${role}`,label:role,type:'role' as const};
  const identity=subject.type==='unit'?index.identities.get(subject.id):undefined;
  if(identity){const systems=[...identity.systems].sort();return {id:`system-set:${systemSetKey(systems)}`,label:systems.length?systems.join(', '):'No recorded systems',type:'system-set' as const};}
  return subject.type==='unit'?{id:'unattributed',label:'Unit outside applied plan',type:'unattributed' as const}:{id:effortSubjectKey(subject),label:subject.type==='arc'?'Arc work':`Job ${subject.id}`,type:subject.type};
}
export const effortDetailKey=(arc:string,group:EffortGroup,id:string)=>`effort-${sha256Hex(JSON.stringify([arc,group,id]))}`;
export function effortContributions(e:Envelope,index=projectionIndex(e)):EffortContribution[] {
  const rows:Omit<EffortContribution,'unitRef'>[]=[],invs=new Map(index.invocations.rows.map(r=>[r.invocation.id,r]));
  for(const {invocation:i,parent} of index.invocations.rows){
    if(!i.endedAt)continue;
    const v=emptyEffort();
    if(i.work?.measured&&i.execution!==undefined){v[i.execution==='agent'?'agentMs':'commandMs']=i.work.measured.wallMs;v.coverage.execution.measured=1;}else v.coverage.execution.unmeasured=1;
    if(i.execution==='agent'&&!index.charges.byInvocation.has(i.id)){v.spend.unavailable=1;v.coverage.money.unavailable=1;}
    rows.push({...v,id:`work:${i.id}`,kind:'work',subject:index.subject(parent,i.unit),role:i.role,at:i.endedAt,stage:parent?.type==='stage'?parent.stage:null,invocation:invocationDirName(invocationIdOf(i.id)),waiting:null});
  }
  for(const ev of e.data.events){
    if(ev.type!=='fact'||ev.fact.kind!=='meter'&&ev.fact.kind!=='usage-unavailable')continue;
    const f=ev.fact,u=f.kind==='meter'?f.usage:f.streamed,ref=invs.get(f.inv),i=ref?.invocation;
    const subject:Subject=f.subject.type==='seat'?{type:'unit',id:f.subject.unit,title:index.identities.get(f.subject.unit)?.title.slice(0,96)??f.subject.unit}:f.subject.type==='job'?{type:'job',id:f.subject.job,title:f.subject.job}:{type:'arc',id:e.arc,title:'Arc'};
    const v=emptyEffort();v.spend={costUsd:u?.costUsd??null,recorded:u?.costUsd!=null?1:0,estimated:u?.costEstimated?1:0,unavailable:f.kind==='usage-unavailable'||f.incomplete!==undefined||u?.costUsd==null?1:0};v.coverage.money={recorded:v.spend.recorded,estimated:v.spend.estimated,unavailable:v.spend.unavailable};
    rows.push({...v,id:`money:${ev.seq}`,kind:'money',subject,role:f.subject.type==='smoke'?i?.role??null:f.subject.role,at:ev.at,stage:ref?.parent?.type==='stage'?ref.parent.stage:null,invocation:i?invocationDirName(invocationIdOf(i.id)):null,waiting:null});
  }
  for(const m of waitingMeasurements(e,index).rows){const v=emptyEffort();v.heldMs=m.heldMs;v.queuedMs=m.queuedMs;v.unallocatedMs=m.unallocatedMs;v.coverage.waiting.measured=1;
    rows.push({...v,id:m.id,kind:'waiting',subject:m.subject,role:null,at:m.at,stage:m.stage,invocation:null,waiting:{source:m.source,totalMs:m.totalMs,reasons:m.reasons}});
  }
  return rows.map(c=>({...c,unitRef:c.subject.type==='unit'&&index.identities.has(c.subject.id)?c.subject.id:null}));
}
