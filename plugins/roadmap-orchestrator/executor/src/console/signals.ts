import type { UnitRunState } from '../status.ts';
export type GraphStatus = 'passed' | 'active' | 'held' | 'pending' | 'failed';
export function graphStatus(state: UnitRunState): GraphStatus {
  switch (state) {
    case 'merged': return 'passed';
    case 'running': case 'preparing': return 'active';
    case 'held': case 'blocked': case 'parked': case 'awaiting-admission': return 'held';
    case 'waiting': case 'ready': case 'cut': case 'superseded': return 'pending';
  }
}
