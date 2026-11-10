import type { UnitRunState } from '../status.ts';
export type GraphStatus = 'passed' | 'active' | 'held' | 'pending' | 'failed';
/** A unit's one display signal: withdrawn units are struck through, not merely pending. */
export const unitSignal = (state: UnitRunState): GraphStatus | 'withdrawn' => state === 'cut' || state === 'superseded' ? 'withdrawn' : graphStatus(state);
export function graphStatus(state: UnitRunState): GraphStatus {
  switch (state) {
    case 'merged': return 'passed';
    case 'running': case 'preparing': return 'active';
    case 'held': case 'blocked': case 'parked': case 'awaiting-admission': return 'held';
    case 'waiting': case 'ready': case 'cut': case 'superseded': return 'pending';
  }
}
