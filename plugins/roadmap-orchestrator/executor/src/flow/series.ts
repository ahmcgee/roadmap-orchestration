// The flow series (plan "Stations and the flow series", G3, R2, R3, R14), pure over an arc's events. Per merged unit
// (admitted at its first `dispatch`, merged at its ff outcome; batch-merged units are counted in T and excluded) the lead
// time is cut into disjoint stations summing to `leadMin`: `stage:<s>` service and `wait:<s>` gaps (held time excluded),
// the integration slot's wait and its service components (`suite:<lane>`, `arc-lanes`, `candidate-rest`, `ff`,
// `snapshot`; a T-alone rerun is rework), and `held` (hold and park outcomes, paused→resumed, ARC-scope drains, blocking
// needs-user). Suite-lane service is sampled per run in all four shapes. The accounting is diagnostic only (RC-2).
// PLACEHOLDER (step 0a): step A1 replaces these bodies in place.
import type { Event } from '../core/events.ts';
import type { ArcId } from '../core/ids.ts';
import { notYet } from '../core/notyet.ts';
import type { FlowPoint, FlowSeries, StationRow } from './types.ts';

/** The arc's flow series over `events` (a run dir's log, or a ref's `events.jsonl[0..highWater]`); its host is the latest start's fingerprint. */
export function flowSeries(_arc: ArcId, _events: readonly Event[]): FlowSeries {
  return notYet('flowSeries', 'A1');
}

/** Each station's mean minutes and share of mean lead over `points` (the constraint's window). */
export function stationTable(_points: readonly FlowPoint[]): readonly StationRow[] {
  return notYet('stationTable', 'A1');
}
