import type { BackendHold } from './activity-protocol.ts';
import type { Continuation } from './detail-protocol.ts';
// D1/D2/D5/D6/D7/D11. Current scheduling is distinct from recorded historical evidence.
import type { View, Page, Booking, CpuStageGroup, Subject, WaitMeasurement, Preview, BookingSort, CpuSort, WaitingSort } from './view-protocol.ts';
import type { TemporalBounds } from './temporal-protocol.ts';
export type ResourceFilters = {section:'schedule'|'cpu'|'waiting'|'now'; window:'24h'|'7d'|'arc'|null; from:string|null;to:string|null;zone:string;resource:string[];unit:string[];stage:string[];state:string[];reason:string[];utilization:'all'|'under10'|'over100'|'unmeasured';q:string;sort:BookingSort|CpuSort|WaitingSort|'scheduler';direction:'asc'|'desc'};
export type ResourceSubject = Subject & {titleTruncated:boolean;unitRef:string|null};
export type ResourceBooking = Booking & {subject:ResourceSubject;resourceKey:string;detailKey:string};
export type ResourceCpuCall = {id:string;invocation:string|null;subject:ResourceSubject;stage:string;attempt:number|null;startedAt:string|null;endedAt:string|null;reservedCpu:number|null;basis:{kind:string;value:number}|null;measured:{wallMs:number;runMs:number;waitMs:number}|null};
export type ResourceCpu = CpuStageGroup & {subject:ResourceSubject;stage:string;attempt:number|null;callCount:number;calls:ResourceCpuCall[]};
export type ResourceWait = Omit<WaitMeasurement,'subject'> & {subject:ResourceSubject;reasonCount:number;unitRef:string|null;detailKey:string};
export type ResourceReason = {id:string;reason:string;label:string;totalMs:number;count:number;detailKey:string};
export type ResourceNowRow =
  | {id:string;kind:'resource';resource:string;state:string;holder:string|null;holderTitle:string|null;unitRef:string|null;pending:boolean;startedAt:string|null;detailKey:string}
  | {id:string;kind:'queue';position:number;subject:ResourceSubject;queuedAt:string|null;publication:boolean;named:string[];pools:string[];cpu:number}
  | {id:string;kind:'pool';resource:string;detailKey:string;size:number;used:number;dirty:number}
  | {id:string;kind:'blocker';subject:ResourceSubject;reasons:Preview[];reasonCount:number};
export type ResourceNow = {queueAvailable:boolean|null;cpuReservation:{used:number;capacity:number}|null;integration:{rows:Extract<ResourceNowRow,{kind:'resource'}>[];matching:number};queues:{rows:Extract<ResourceNowRow,{kind:'queue'}>[];matching:number};blockers:{rows:Extract<ResourceNowRow,{kind:'blocker'}>[];matching:number};counts:{resources:number;queues:number;pools:number;blockers:number};unknownQueueStarts:number};
export type ResourceCoverage = {matchedCalls:number;excludedCalls:number;unmeasuredCalls:number;zeroWallCalls:number;unreservedCalls:number;measuredStages:number;under10Stages:number;over100Stages:number;waitingMeasurements:number;unmeasuredReservations:number|null};
export type ResourceView = View & Page<ResourceBooking|ResourceCpu|ResourceWait|ResourceNowRow> & {section:ResourceFilters['section'];filters:ResourceFilters;bounds:TemporalBounds;now:ResourceNow;counts:{schedule:number|null;cpu:number|null;waiting:number|null;now:number|null};coverage:ResourceCoverage;overview:{backendHolds:{rows:BackendHold[];matching:number}|null;resourceCount:number;buckets:{from:string;to:string;count:number}[];reasons:ResourceReason[];reasonCount:number;totalWaitingMs:number|null;unallocatedMs:number|null}};
export type ResourceDetail = {continuations?:Continuation[]} & View & Page<ResourceBooking|ResourceCpuCall|ResourceWait> & {key:string;kind:'booking'|'resource'|'cpu'|'waiting';label:string;evidence:'ownership'|'calls'|'measurements';subject:ResourceSubject|null;booking:ResourceBooking|null;cpu:Omit<ResourceCpu,'calls'>|null;reason:ResourceReason|null;counts:{bookings:number;calls:number;measurements:number};bounds:TemporalBounds;filters:ResourceFilters};

export type ResourceReasonsView = View & Page<ResourceReason> & {filters:ResourceFilters;bounds:TemporalBounds};
