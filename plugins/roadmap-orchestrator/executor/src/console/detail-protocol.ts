// Selected entities only. These DTOs never carry invocation bodies or canonical records.
import type { View, Signal, Money, Subject } from './view-protocol.ts';
import type { StageStep } from './indexes.ts';
export type RelatedUnit = {id:string; title:string; state:string; signal:Signal; source:string; target:string; unmet:boolean};
export type DetailPage<T> = {rows:T[]; next:string|null; total:number};
export type GateRef = {id:string; name:string|null; passed:boolean};
export type UnitSummary = {id:string; title:string; state:string; stage:string; signal:Signal; startedAt:string|null; endedAt:string|null; arcEndedAt:string|null; elapsedMs:number|null; attempts:number; rounds:number; spend:Money; reasons:string[]; waitSince:string|null; lineage:{reenters:string}|null};
export type UnitWaiting = {at:string; stage:string; totalMs:number; reasons:{reason:string;ms:number}[]};
export type InvocationSummary = {id:string; routeId:string; unit:string; stage:string; attempt:number; kind:'agentic'|'deterministic'; execution:string; status:Signal; startedAt:string; elapsedMs?:number; model?:string; label:string; round:number|null; spend:Money; subject:Subject; systems:string[]; endedAt:string|null; outcome:string};
export type UnitView = View & {unit:UnitSummary; feeds:GateRef[]; waits:GateRef[]; depends:DetailPage<RelatedUnit>; usedBy:DetailPage<RelatedUnit>; journey:DetailPage<StageStep>; invocations:DetailPage<InvocationSummary>; acceptance:DetailPage<string>; waiting:DetailPage<UnitWaiting>; checks:DetailPage<{id:string;outcome:string}>; requests:DetailPage<{id:string;summary:string;recommendation:string}>; intent:{text:string;next:string|null}};
export type MilestoneView = View & {id:string;name:string|null;state:string;passed:boolean;total:number;merged:number;members:DetailPage<RelatedUnit>;intent:{text:string;next:string|null}};
export type InvocationView = View & {invocation:InvocationSummary;actor:{role:string;backend:string|null;model:string|null;requestedModel:string|null};measured:{wallMs:number;runMs:number;waitMs:number}|null;reservedCpu:number|null;related:DetailPage<RelatedUnit>};
