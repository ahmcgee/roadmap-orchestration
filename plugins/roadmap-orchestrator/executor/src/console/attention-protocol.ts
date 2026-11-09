// D1/D2/D9. Request views are independent of the legacy console model.
import type { Page, RequestSummary, View } from './view-protocol.ts';
import type { Continuation } from './detail-protocol.ts';
export type AttentionFilters = {blocking: 'all' | '1' | '0'; subjectType: string[]; reason: string[]; q: string; sort: 'oldest' | 'newest'};
export type AttentionView = View & Page<RequestSummary> & {filters: AttentionFilters; counts: {total: number; blocking: number; informational: number}};
export type RequestResolution = {kind: 'acknowledged' | 'declined' | 'no-longer-open'; source: 'journal' | 'ack-file' | 'open-list'; at: string | null; command: string | null; choice: string | null};
export type RequestView = View & {
  id: string; open: boolean; evidenceAvailability: 'available' | 'pruned';
  recordPreview: {raisedAt: string; blocking: boolean; subject: RequestSummary['subject']; reason: string} | null;
  resolutionEvidence: RequestResolution[];
  fields: {summary: string; recommendation: string};
  options: {id: string; label: string; command: string | null}[];
  evidenceRefs: {path: string; invocation: string | null}[];
  affectedUnits: {id: string; title: string}[]; findingRefs: {id:string;event:string|null}[];
  guidance: {command: string | null; text: string};
  continuations?: Continuation[];
};
