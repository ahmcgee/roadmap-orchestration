// The flow series of other arcs, read from their verified snapshot refs (src/chain.ts `readArcRef`) to seed the chart
// (plan "SPC", R11): completed arcs only (`completedHeadOf`). A ref's kept series (its latest `flow-series` fact's
// `inputs/<sha>.flow-series.json`) is read when its `v` is this release's; otherwise, and on a 1.0.0-dev.7 ref, which
// keeps none, the series is recomputed from the ref's events and kept inputs (a recomputed dev.7 series has no host and
// never seeds).
import { type ArcRef, arcsWithRefs, completedHeadOf, readArcRef } from '../chain.ts';
import type { ArcId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import { FLOW_SERIES_INPUT } from '../input/inforce.ts';
import { flowSeries, seriesInputs } from './series.ts';
import { FLOW_SERIES_V, type FlowSeries, parseFlowSeries } from './types.ts';

/** The arc's series as its ref has it: the kept record when its `v` is this release's, else recomputed. */
export function seriesOfRef(ref: ArcRef): FlowSeries {
  const kept = ref.events.findLast((e) => e.type === 'fact' && e.fact.kind === 'flow-series');
  if (kept !== undefined && kept.type === 'fact' && kept.fact.kind === 'flow-series') {
    const raw: unknown = JSON.parse(ref.input(kept.fact.sha256, FLOW_SERIES_INPUT).toString('utf8'));
    if (typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === FLOW_SERIES_V) return parseFlowSeries(raw);
  }
  return flowSeries(ref.arc, ref.events, seriesInputs(ref.input));
}

/** The series of every completed arc but `arc` in `repo`, newest completion first: what seeds `arc`'s chart (`seedLimits`). */
export function previousSeries(repo: AbsPath, arc: ArcId): readonly FlowSeries[] {
  return completedRefs(arcsWithRefs(repo).filter((a) => a !== arc).map((a) => readArcRef(repo, a)!)).map(seriesOfRef);
}

/** The completed refs among `refs`, newest completion (its latest `arc-completed`) first. */
export function completedRefs(refs: readonly ArcRef[]): readonly ArcRef[] {
  const completedAt = (ref: ArcRef): string => ref.events.findLast((e) => e.type === 'fact' && e.fact.kind === 'arc-completed')!.at;
  return refs.filter((r) => completedHeadOf(r) !== null).sort((a, b) => (completedAt(a) > completedAt(b) ? -1 : completedAt(a) < completedAt(b) ? 1 : 0));
}
