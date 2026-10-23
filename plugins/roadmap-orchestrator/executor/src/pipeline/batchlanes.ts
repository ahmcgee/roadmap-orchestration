// Batch points (dev.17, DESIGN-1.0.md §4 "Lane topology"): where the plan's `batch` suite lanes run, never in the merge
// path. A batch point runs on an integration SHA under a job, as a journey series (src/pipeline/lanes.ts `runJourneySeries`):
//
//   milestone   the walk of a milestone round (src/walk/walk.ts), after its capture and before its reservation: the
//               publication retiring the milestone's last unit makes round 1 due, so the batch runs before the walk.
//   audit       a cadence audit of a holistic arc without milestones (src/holistic/audit.ts), after its arc lanes.
//   close-out   always, fresh (src/pipeline/publish.ts `publishCloseOut`); a red lane refuses the close-out.
//
// At a milestone or an audit a lane runs only when its systems changed since its last green (`batchLanesDue`: its newest run
// on its input now, a series' or a journey's, is not a clean pass, `passedOnInput`), and a lane already red under this job
// (a resumed job) does not run again. A red lane opens code's P1 (`batchDraft`): at a milestone a walkthrough P1 of the
// milestone, which holds its `milestone-passed` like any walkthrough P1 (its node already gates its descendants); at an
// audit a witness P1 over no obligation. Either names the lane (`finding-opened.lane`), so a repair of it forces the lane at
// its own lanes stage (src/pipeline/stages.ts `forcedLanes`). The walk and the audit go on: their findings include it.
import type { FindingId, JobId, Sha } from '../core/ids.ts';
import type { LaneDef } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import type { FindingDraft } from '../holistic/findings.ts';
import type { Milestone } from '../input/plan.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import type { StageContext } from './dispatch.ts';
import { type JourneyEnd, jobSeriesCheckout, laneNow, passedOnInput, runJourneySeries, suiteJourneyLane } from './lanes.ts';

/** The plan's batch lanes, in declared order. */
export const batchLanesOf = (ctx: Pick<StageContext, 'plan'>): readonly LaneDef[] => ctx.plan().suite.lanes.filter((l) => l.cadence === 'batch');

/** The findings job `job` opened for its batch lanes' reds (a resumed job's earlier ones), in id order. */
export function batchFindingsOf(ctx: Pick<StageContext, 'journal'>, job: JobId): readonly FindingId[] {
  return ctx.journal.view.holistic().findings.filter((f) => f.lane !== undefined && f.source.type === 'job' && f.source.job === job).map((f) => f.id);
}

/**
 * The batch lanes job `job` runs at `at` (see the header): those whose newest run on their input there is not a clean pass,
 * less those the job already found red.
 */
export function batchLanesDue(ctx: StageContext, job: JobId, at: Sha): readonly LaneDef[] {
  const redHere = new Set(ctx.journal.view.holistic().findings.flatMap((f) => (f.lane !== undefined && f.source.type === 'job' && f.source.job === job ? [f.lane] : [])));
  return batchLanesOf(ctx).filter((l) => !redHere.has(l.id) && !passedOnInput(ctx, l, laneNow(ctx, l, at)));
}

/** Code's P1 for batch lane `lane` red at `at` under `job` (see the header); `milestone` null at an audit. */
export function batchDraft(job: JobId, milestone: Milestone | null, lane: LaneDef, at: Sha, dir: AbsPath): FindingDraft {
  return {
    lens: milestone === null ? 'witness' : 'walkthrough', severity: 'P1', obligation: null, visionClauses: [],
    claim: `Batch lane ${lane.id} is red on the integration SHA ${at}${milestone === null ? ` (audit ${job})` : ` (milestone ${milestone.id}'s batch point, before its walk ${job})`}.`,
    cause: `batch lane ${lane.id} red`, evidence: [{ path: dir, blob: null }], mutant: null, source: { type: 'job', job }, gateHadPassed: true,
    ...(milestone === null ? {} : { milestone: milestone.id }), lane: lane.id,
  };
}

export type BatchOutcome = Readonly<{ kind: 'ran' }> | Readonly<{ kind: 'no-verdict'; end: JourneyEnd }>;

/**
 * Runs the batch lanes due at `at` under `job` (a journey series in its own checkout) and opens a P1 per red lane through
 * `open` (the audit's tally, or the walk's store write), or ends without a verdict (the job resumes).
 */
export async function runBatchPoint(
  ctx: StageContext & Readonly<{ acquireFirst: AcquireFirst }>, job: JobId, at: Sha, milestone: Milestone | null, open: (draft: FindingDraft) => void,
): Promise<BatchOutcome> {
  const lanes = batchLanesDue(ctx, job, at);
  if (lanes.length === 0) return { kind: 'ran' };
  const series = await runJourneySeries(ctx, { type: 'job', job, acquireFirst: ctx.acquireFirst }, lanes.map(suiteJourneyLane), {
    path: jobSeriesCheckout(ctx, job, 'batch'), checkout: { type: 'detached', at },
  }, { reuse: false, stop: () => false });
  if (series.end.kind !== 'ran') return { kind: 'no-verdict', end: series.end };
  for (const r of series.runs) {
    if (r.verdict === 'pass' || r.dir === null) continue;
    const lane = lanes.find((l) => l.id === r.lane);
    if (lane === undefined) throw new Error(`${job}: batch lane ${r.lane} ran, but is not among the lanes due`);
    open(batchDraft(job, milestone, lane, at, r.dir));
  }
  return { kind: 'ran' };
}
