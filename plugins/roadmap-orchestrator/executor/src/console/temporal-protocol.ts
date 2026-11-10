import type { View, Page, Subject, Interval, TrackMark, HolisticRow, Preview, DetailRef, Signal } from './view-protocol.ts';
import type { BackendHold } from './activity-protocol.ts';
export type TemporalBounds = {from: string | null; to: string; terminalAt: string | null};
export type TimelineFilters = {window: 'arc' | '24h' | '7d' | null; from: string | null; to: string | null; zone: string;
  unit: string[]; milestone: string[]; state: string[]; stage: string[]; execution: string[]; q: string; sort: 'plan' | 'open' | 'longest-open'; subject: string | null};
export type TrackSummary = {id: string; subject: Subject; state: string | null; signal: Signal | null; intervalCount: number; openCount: number;
  firstAt: string; lastAt: string | null; marks: TrackMark[]; detail: DetailRef | null};
/** The whole Arc, independent of the selected window: recorded starts (runs, or bookings) per slice, and every backend hold (up to 64). */
export type ArcOverview = {range: {from: string; to: string; widthMs: number}; buckets: {from: string; to: string; count: number}[]; backendHolds: {rows: BackendHold[]; matching: number}};
export type TimelineView = View & Page<TrackSummary> & {filters: TimelineFilters; bounds: TemporalBounds; overview: ArcOverview};
export type IntervalsView = View & Page<Interval> & {filters: TimelineFilters; bounds: TemporalBounds};
export type HoldsView = View & Page<BackendHold> & {filters: TimelineFilters; bounds: TemporalBounds};
export type HolisticSection = 'audits' | 'findings' | 'decisions';
export type HolisticAudit = Extract<HolisticRow, {type: 'audit'}> & {coverage: {lens: string; from: string; to: string}[]; coverageTruncated: boolean};
export type EvidencePreview = Omit<Preview,'detail'> & {detail: DetailRef | null; field?: {key:string;name:'claim'|'oneLine'}};
export type HolisticFieldView = View & {key:string;name:'claim'|'oneLine';text:string;offset:number;next:number|null;total:number};
export type HolisticFinding = {type: 'finding'; id: string; claim: EvidencePreview; state: string; detail: DetailRef | null;
  foundBy: {type: 'audit'; job: string} | {type: 'stage'; unit: string; stage: string} | {type: 'other'} | null; foundAt: string | null};
export type HolisticDecision = Omit<Extract<HolisticRow, {type: 'decision'}>, 'detail' | 'oneLine'> & {detail: DetailRef | null; recordId: string; oneLine: EvidencePreview};
export type HolisticView = View & Page<HolisticAudit | HolisticFinding | HolisticDecision> & {
  section: HolisticSection; enabled: boolean; currentAudit: {running: boolean; job: string | null} | null;
  latestOutcome: {at: string; job: string; outcome: string} | null;
  counts: {audits: number; findings: number; decisions: number};
};
