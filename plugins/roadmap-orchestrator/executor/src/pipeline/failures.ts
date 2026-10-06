// A unit's lane failures (M4a rev 3, F3, dx2 5): what `status.units[].failures` and a lanes park's needs-user summary
// list, so a re-entry that resets its counters can cite the executor's own classification of host-caused failures.
//
// Read back from each finished spec series of the unit's `lanes` attempts (`seriesLedger`, the record the live series
// built): one line per lane record that is red or flaky, ascending by attempt then series order. `class`: `flaky` (red,
// then green on its diagnostic rerun), `repeat` (it repeated the unit's earlier red, F2: no rerun), else `red`.
// `hostSuspected`: the first run's host signatures and whether its host samples showed a busy host (the lane record's).
// A lanes attempt still open is not read (its records are not final), nor one that ran a lane the spec in force no
// longer declares. Suite lanes (the candidate's) are not listed.
import type { LaneId, Sha, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { PlanUnit } from '../input/plan.ts';
import type { StageContext, StageParent } from './dispatch.ts';
import { type HostSuspected, seriesLedger, specSeriesRoot } from './lanes.ts';
import { loadUnitSpec } from './stages.ts';

export const FAILURE_CLASSES = ['red', 'flaky', 'repeat'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
export type LaneFailure = Readonly<{ stage: 'lanes'; attempt: number; lane: LaneId; class: FailureClass; hostSuspected: HostSuspected | null }>;

/** The lanes attempts of `unit` that ran a spec lane, each with the commit it ran at and the lanes it ran, ascending by attempt. */
function lanesSeries(view: JournalView, unit: UnitId): readonly Readonly<{ parent: StageParent; at: Sha; lanes: ReadonlySet<LaneId> }>[] {
  const out = new Map<number, Readonly<{ parent: StageParent; at: Sha; lanes: Set<LaneId> }>>();
  for (const i of view.opsOf('proc.spawn')) {
    const s = i.expect.subject;
    if (s.purpose !== 'lane' || s.set !== 'spec' || s.unit !== unit || i.parent.type !== 'stage' || i.parent.stage !== 'lanes') continue;
    const entry = out.get(i.parent.attempt) ?? { parent: i.parent, at: s.at, lanes: new Set<LaneId>() };
    entry.lanes.add(s.lane);
    out.set(i.parent.attempt, entry);
  }
  return [...out.values()].sort((a, b) => a.parent.attempt - b.parent.attempt);
}

export function laneFailures(ctx: StageContext, unit: PlanUnit): readonly LaneFailure[] {
  const view = ctx.journal.view;
  const open = view.unit(unit.id).open;
  const series = lanesSeries(view, unit.id).filter((s) => !(open?.stage === 'lanes' && open.attempt === s.parent.attempt));
  if (series.length === 0) return [];
  const { spec } = loadUnitSpec(ctx, unit);
  const declared = new Set(spec.lanes.map((l) => l.id));
  // An attempt that ran a lane the spec in force no longer declares (an applied spec edit dropped it) has no definition
  // to read its records with: it is not listed.
  return series.filter((s) => [...s.lanes].every((l) => declared.has(l))).flatMap(({ parent, at }) =>
    seriesLedger(ctx, parent, spec.lanes, at, specSeriesRoot(ctx.runDir, parent)).flatMap((r): LaneFailure[] => {
      const red = r.verdict === 'fail' || r.verdict === 'stall';
      if (!red && !r.flaky) return [];
      const cls: FailureClass = r.flaky ? 'flaky' : r.repeat !== null ? 'repeat' : 'red';
      return [{ stage: 'lanes', attempt: parent.attempt, lane: r.lane, class: cls, hostSuspected: r.hostSuspected }];
    }));
}

/** The failures as one sentence for a park's summary; empty when none. */
export function failuresText(failures: readonly LaneFailure[]): string {
  if (failures.length === 0) return '';
  const one = (f: LaneFailure): string => `lanes#${f.attempt} ${f.lane} ${f.class}${f.hostSuspected === null ? ''
    : ` host-suspected (${f.hostSuspected.signatures.join(', ')}${f.hostSuspected.busy ? '; host busy' : ''})`}`;
  return `Lane failures: ${failures.map(one).join('; ')}.`;
}
