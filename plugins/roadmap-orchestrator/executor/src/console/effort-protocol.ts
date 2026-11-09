// D1–D5/D11. Completed measurements are separate from lifetime/current unit facts.
import type { View, Page, Subject, Money, Preview, Signal, EffortSort } from './view-protocol.ts';
import type { TemporalBounds } from './temporal-protocol.ts';
export type EffortCoverage = {
  execution: {measured: number; unmeasured: number};
  money: {recorded: number; estimated: number; unavailable: number};
  waiting: {measured: number; unmeasuredReservations: number | null};
};
export type EffortTotals = {agentMs: number | null; commandMs: number | null; heldMs: number | null; queuedMs: number | null; unallocatedMs: number | null; spend: Money; coverage: EffortCoverage};
export type EffortFilters = {window: '24h' | '7d' | 'arc' | null; from: string | null; to: string | null; zone: string;
  metric: 'work' | 'spend' | 'waiting'; group: 'unit'; unit: string[]; milestone: string[]; system: string[]; state: string[]; blocked: 'all' | '1' | '0'; q: string; sort: EffortSort; direction: 'asc' | 'desc'};
export type EffortUnit = EffortTotals & {id: string; subject: Subject; titleTruncated: boolean; signal: Signal | null; state: string | null; stage: string | null; systems: string[];
  blockers: {reasons: Preview[]; count: number; waitSince: string | null};
  lifetime: {startedAt: string | null; endedAt: string | null; elapsedMs: number | null; rounds: number | null; redChecks: number | null; spend: Money}};
export type EffortView = View & Page<EffortUnit> & {filters: EffortFilters; bounds: TemporalBounds; totals: EffortTotals;
  buckets: (EffortTotals & {from: string; to: string})[]; membership: 'applied-plan-at-anchor';
  attribution: {unit: EffortTotals; arcJob: EffortTotals};
};
