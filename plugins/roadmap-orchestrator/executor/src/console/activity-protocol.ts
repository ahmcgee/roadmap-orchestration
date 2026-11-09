// UI-only Activity contracts. D1/D3/D4/D8/D9/D10/D11; no journal bodies on the wire.
import type { View, Page, Preview, Subject, Money, DetailRef } from './view-protocol.ts';
import type { Continuation } from './detail-protocol.ts';

export const ACTIVITY_KINDS = ['stage-outcome', 'plan-applied', 'arc-completed', 'stop-completed',
  'request-raised', 'request-acknowledged', 'audit-started', 'audit-ended', 'finding-opened',
  'finding-transition', 'decision', 'backend-park', 'backend-closure', 'invocation-started', 'invocation-ended'] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];
export type Actor = {role: string | null; backend: string | null; model: string | null};
export type ActivitySubject = Subject | {type: 'host' | 'findings' | 'request'; id: string | null; title: string};
export type ActivityRow = {
  id: string; seq: number; at: string; kind: ActivityKind; subject: ActivitySubject;
  stage: string | null; attempt: number | null; round: number | null;
  actor: Actor | null; actorCount: number; outcome: string | null;
  /** Plain-words result of a stage row; other rows show their summary. */
  result: Preview | null; summary: Preview;
  workMs: number | null; spend: Money | null;
  coverage: {measured: number; unmeasured: number};
  detail: DetailRef; housekeeping: boolean;
};
export type ActivityFilters = {
  from: string | null; to: string | null; afterSeq: number | null; beforeSeq: number | null;
  unit: string[]; milestone: string[]; stage: string[]; kind: ActivityKind[];
  role: string[]; backend: string[]; model: string[]; outcome: string[];
  q: string; housekeeping: boolean; order: 'asc' | 'desc'; zone: string;
};
export type ActivityView = View & Page<ActivityRow> & {
  filters: ActivityFilters; membership: 'applied-plan-at-anchor';
  days: {date: string; count: number}[];
};
export type ActivityChanges = View & {newMatching: number; latestHighWater: number; latestViewVersion: string};
export type BackendHold = {
  id: string; backend: string; recordedClass: string; effectiveClass: string;
  invocation: string | null; startSeq: number; startedAt: string;
  endedAt: string | null; closure: {kind: 'resumed' | 'probe' | 'park-updated'; seq: number; at: string; detail: DetailRef} | null;
  terminalAt: string | null; detail: DetailRef;
};
export type ActivityDetail = View & {
  row: ActivityRow; evidenceAvailability: 'available' | 'pruned' | 'not-applicable';
  context: {label: string; value: string}[];
  invocations: {id: string; subject: Subject; stage: string; attempt: number; actor: Actor; startedAt: string; endedAt: string | null; wallMs: number | null; spend: Money}[];
  backendHold: BackendHold | null;
  continuations?: Continuation[];
};
