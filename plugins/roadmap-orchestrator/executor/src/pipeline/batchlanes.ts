// Batch points (dev.17, DESIGN-1.0.md §2.7 "Plan, specs and certification lanes"): where the plan's `batch` suite lanes run, never in the merge
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
//
// The batch witness (dev.82, E3): an arc lane of cadence `batch` (`batchArcLanes`) is a deferred lane (holistic/types.ts
// `deferredLane`): no unit's required witnesses, candidate brake or docs publication runs it, so a unit delivering its
// obligation merges without it. It runs as a job `witness-<n>` on the integration head (`batchWitnessDue`):
//
//   merges    once `holistic.batchEvery` publications (default 5) landed since the head a batch witness last ran it at
//             (none: since the arc start), the lanes so due;
//   closing   on request (`batchWitnessDue(ctx, 'closing')`, the endgame's closing step), every batch arc lane with an
//             obligation unobserved on the head's tree;
//   close-out its publication runs every arc lane fresh (src/pipeline/publish.ts), these included.
//
// `runBatchWitness` grades each active, non-exempt obligation the lanes witness on the head, as an external attestation is
// graded (src/commands/witness.ts): a future one held once every deliverer's merge is in latches (`latchingUnit`); a
// must-hold (or latched) one not held, or a future one fully delivered and not held, is red. A red one is bisected over the
// published heads between the newest one known good (not yet owed, or observed held) and the head, each probe the lane
// alone in the job's own detached checkout (log2 runs; a probe's observation is reused by a resumed job). The first red
// head's publication is the culprit: when one of its units is in the lineage of a retired deliverer of the obligation,
// that deliverer reopens (`batch-reopened`, with the range as its brief); otherwise code opens a witness P1 naming the
// culprit. No chargeable counter moves. A job cut short resumes as the same job (`batch-witness-started` without its
// `batch-witness-ended`).
import { join } from 'node:path';
import { type FindingId, type JobId, type LaneId, type Sha, type UnitId, sha256 } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { LaneDef } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { latchingUnit } from '../commands/witness.ts';
import { isAncestor } from '../git/ff.ts';
import { revParse } from '../git/git.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import { integrationHeadNow } from '../holistic/cadence.ts';
import { publishedHeads } from '../holistic/coverage.ts';
import { type FindingDraft, openFinding, witnessFindingDraft } from '../holistic/findings.ts';
import { published } from '../holistic/required.ts';
import { type ArcLaneDef, type ObligationDef, type Obligations, isExempt, isMustHold } from '../holistic/types.ts';
import { keepInput } from '../input/inforce.ts';
import { deliverers, lineageBack } from '../input/lineage.ts';
import { type Milestone, batchEveryOf } from '../input/plan.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import type { StageContext } from './dispatch.ts';
import { type JourneyEnd, arcJourneyLane, jobSeriesCheckout, laneNow, observedViews, passedOnInput, removeJobCheckouts, runJourneySeries, suiteJourneyLane } from './lanes.ts';
import { holisticInForce } from './stages.ts';

/** Plain batch suites plus this milestone's explicit additions, in declared order. */
export const batchLanesOf = (ctx: Pick<StageContext, 'plan'>, milestone: Milestone | null = null): readonly LaneDef[] => {
  const selected = new Set((ctx.plan().milestones ?? []).flatMap((m) => m.lanes ?? []));
  const additional = new Set(milestone?.lanes ?? []);
  return ctx.plan().suite.lanes.filter((l) => l.cadence === 'batch' && (!selected.has(l.id) || additional.has(l.id)));
};

/** The findings job `job` opened for its batch lanes' reds (a resumed job's earlier ones), in id order. */
export function batchFindingsOf(ctx: Pick<StageContext, 'journal'>, job: JobId): readonly FindingId[] {
  return ctx.journal.view.holistic().findings.filter((f) => f.lane !== undefined && f.source.type === 'job' && f.source.job === job).map((f) => f.id);
}

/**
 * The batch lanes job `job` runs at `at` (see the header): those whose newest run on their input there is not a clean pass,
 * less those the job already found red.
 */
export function batchLanesDue(ctx: StageContext, job: JobId, at: Sha, milestone: Milestone | null = null): readonly LaneDef[] {
  const redHere = new Set(ctx.journal.view.holistic().findings.flatMap((f) => (f.lane !== undefined && f.source.type === 'job' && f.source.job === job ? [f.lane] : [])));
  return batchLanesOf(ctx, milestone).filter((l) => !redHere.has(l.id) && !passedOnInput(ctx, l, laneNow(ctx, l, at)));
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
  const lanes = batchLanesDue(ctx, job, at, milestone);
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

// ---------------------------------------------------------------------------------------------------
// The batch witness (dev.82, E3; see the header)

/** The arc lanes the batch witness runs: cadence `batch`, run on this host (an external-class lane is the root's to attest). */
export const batchArcLanes = (obligations: Obligations): readonly ArcLaneDef[] => obligations.lanes.filter((l) => l.cadence === 'batch' && l.witnessClass !== 'external');

/** A batch witness job: the integration head it witnesses and its lanes, ascending. */
export type BatchWitness = Readonly<{ job: JobId; head: Sha; lanes: readonly LaneId[] }>;

/** What asks for a batch witness: the merge count, or the endgame's closing step. */
export type BatchWitnessTrigger = 'merges' | 'closing';

type WitnessContext = StageContext & Readonly<{ acquireFirst: AcquireFirst }>;

/** The batch witness started and not ended, or null. */
function openWitness(ctx: Pick<StageContext, 'journal'>): BatchWitness | null {
  const facts = ctx.journal.view.ciFacts();
  const started = facts.findLast((f) => f.kind === 'batch-witness-started');
  if (started?.kind !== 'batch-witness-started' || facts.some((f) => f.kind === 'batch-witness-ended' && f.job === started.job)) return null;
  return { job: started.job, head: started.head, lanes: started.lanes };
}

/** Publications since the head a batch witness last ran `lane` at (none: every publication of the arc). */
function mergesSince(ctx: Pick<StageContext, 'journal'>, lane: LaneId): number {
  const heads = publishedHeads(ctx.journal.view);
  const last = ctx.journal.view.ciFacts().findLast((f) => f.kind === 'batch-witness-started' && f.lanes.includes(lane));
  if (last?.kind !== 'batch-witness-started') return heads.length;
  return heads.length - 1 - heads.findLastIndex((h) => h.head === last.head);
}

/**
 * The batch witness due now (see the header), or null: the open one (resumed); else a new job over the integration head
 * for the lanes `trigger` calls for, if any. Null outside a holistic arc with batch arc lanes. The endgame's closing step
 * calls it with `closing` and runs what it names with `runBatchWitness`.
 */
export function batchWitnessDue(ctx: StageContext, trigger: BatchWitnessTrigger): BatchWitness | null {
  if (!ctx.journal.view.holistic().on) return null;
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) return null;
  const open = openWitness(ctx);
  if (open !== null) return open;
  const lanes = trigger === 'merges'
    ? batchArcLanes(obligations).filter((l) => mergesSince(ctx, l.id) >= batchEveryOf(ctx.plan()))
    : batchArcLanes(obligations).filter((l) => observedViews(ctx, obligations, obligations.obligations.filter((o) => o.witness?.lane === l.id), integrationHeadNow(ctx)).some((v) => v.observation === null));
  if (lanes.length === 0) return null;
  return { job: ctx.journal.view.nextJobId('witness'), head: integrationHeadNow(ctx), lanes: lanes.map((l) => l.id).sort() };
}

export type BatchWitnessOutcome = Readonly<{ kind: 'ended' }> | Readonly<{ kind: 'no-verdict'; job: JobId; end: JourneyEnd }>;

/** `o`'s verdict on `commit` from the observation store (null: never observed there). */
const verdictAt = (ctx: WitnessContext, obligations: Obligations, o: ObligationDef, commit: Sha) => observedViews(ctx, obligations, [o], commit)[0]!.observation?.verdict ?? null;

/** Whether `o` is owed on `commit`: must-hold from the start, else once every deliverer's merge is in it. */
function owedAt(ctx: WitnessContext, merges: ReadonlyMap<UnitId, Sha>, o: ObligationDef, commit: Sha): boolean {
  if (o.activation === 'must-hold') return true;
  return deliverers(ctx.journal.view, o).every((u) => {
    const merge = merges.get(u);
    return merge !== undefined && isAncestor(ctx.repo, merge, commit);
  });
}

/**
 * Runs (or resumes) the batch witness `due` (`batchWitnessDue`): its lanes on its head, the latches and the bisected
 * attribution of each red obligation (see the header), then `batch-witness-ended`. A lane without a verdict leaves the job
 * open: it resumes.
 */
export async function runBatchWitness(ctx: WitnessContext, due: BatchWitness): Promise<BatchWitnessOutcome> {
  const view = ctx.journal.view;
  if (openWitness(ctx)?.job !== due.job) ctx.journal.fact({ kind: 'batch-witness-started', job: due.job, head: due.head, lanes: due.lanes });
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) throw new Error(`${due.job}: a batch witness outside an arc with obligations`);
  await removeJobCheckouts(ctx, due.job);
  // A lane revised away since the job started is not run; one the job already ran on its head is not run again.
  const tree = revParse(ctx.repo, `${due.head}^{tree}`);
  const ran = new Set(view.holistic().witnessed.flatMap((w) => (w.for.type === 'job' && w.for.job === due.job && w.treeSha === tree ? [w.lane] : [])));
  const lanes = batchArcLanes(obligations).filter((l) => due.lanes.includes(l.id));
  const fresh = lanes.filter((l) => !ran.has(l.id));
  if (fresh.length > 0) {
    const series = await runJourneySeries(ctx, { type: 'job', job: due.job, acquireFirst: ctx.acquireFirst }, fresh.map(arcJourneyLane), {
      path: jobSeriesCheckout(ctx, due.job, 'batch'), checkout: { type: 'detached', at: due.head },
    }, { reuse: false, stop: () => false });
    if (series.end.kind !== 'ran') return { kind: 'no-verdict', job: due.job, end: series.end };
  }
  const merges = published(view);
  for (const o of obligations.obligations) {
    if (o.state.type !== 'active' || isExempt(o) || o.witness === null || !lanes.some((l) => l.id === o.witness!.lane)) continue;
    const verdict = verdictAt(ctx, obligations, o, due.head);
    if (verdict === null) throw new Error(`${due.job}: obligation ${o.id}'s lane ${o.witness.lane} has no observation on ${due.head}`);
    const latched = new Set(view.holistic().latched.map((l) => l.obligation));
    if (!isMustHold(o, latched)) {
      const unit = latchingUnit(ctx, o, due.head);
      if (unit === null) continue; // Not yet delivered: measured.
      if (verdict === 'held') {
        ctx.journal.fact({ kind: 'obligation-latched', obligation: o.id, unit, treeSha: tree });
        continue;
      }
    } else if (verdict === 'held') continue;
    const found = await bisect(ctx, due, obligations, o, merges);
    if (found.kind === 'no-verdict') return found;
    attribute(ctx, due, o, found.culprit, merges);
  }
  ctx.journal.fact({ kind: 'batch-witness-ended', job: due.job });
  return { kind: 'ended' };
}

type Culprit = Readonly<{ head: Sha; range: readonly Sha[] }>;
type Bisected = Readonly<{ kind: 'found'; culprit: Culprit | null }> | Readonly<{ kind: 'no-verdict'; job: JobId; end: JourneyEnd }>;

/**
 * The first published head up to `due.head` on which `o` is owed and not held, with the heads after the last good one up to
 * `due.head` (the range); null when `due.head` is no published head (the arc's base is red: no publication to blame).
 */
async function bisect(ctx: WitnessContext, due: BatchWitness, obligations: Obligations, o: ObligationDef, merges: ReadonlyMap<UnitId, Sha>): Promise<Bisected> {
  const heads = publishedHeads(ctx.journal.view);
  const end = heads.findLastIndex((h) => h.head === due.head);
  if (end === -1) return { kind: 'found', culprit: null };
  // The commits in order: the arc's base (good: the baseline held it), then each published head up to the job's.
  const commits = [heads[0]!.old, ...heads.slice(0, end + 1).map((h) => h.head)];
  const lane = obligations.lanes.find((l) => l.id === o.witness!.lane)!;
  const known = (i: number): 'good' | 'bad' | null => {
    if (!owedAt(ctx, merges, o, commits[i]!)) return 'good';
    const v = verdictAt(ctx, obligations, o, commits[i]!);
    return v === null ? null : v === 'held' ? 'good' : 'bad';
  };
  let hi = commits.length - 1;
  let lo = 0;
  for (let i = hi - 1; i > 0; i -= 1) {
    const k = known(i);
    if (k === 'bad') hi = i;
    if (k === 'good') { lo = i; break; }
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    let k = known(mid);
    if (k === null) {
      const probe = await runJourneySeries(ctx, { type: 'job', job: due.job, acquireFirst: ctx.acquireFirst }, [arcJourneyLane(lane)], {
        path: jobSeriesCheckout(ctx, due.job, 'probe'), checkout: { type: 'detached', at: commits[mid]! },
      }, { reuse: true, stop: () => false });
      if (probe.end.kind !== 'ran') return { kind: 'no-verdict', job: due.job, end: probe.end };
      k = known(mid);
      if (k === null) throw new Error(`${due.job}: the probe of ${lane.id} at ${commits[mid]} left no observation`);
    }
    if (k === 'good') lo = mid;
    else hi = mid;
  }
  return { kind: 'found', culprit: { head: commits[hi]!, range: commits.slice(lo + 1) } };
}

/**
 * Attributes red `o` (see the header): the retired deliverer whose lineage published the culprit reopens with the range as
 * its brief; one already reopened (not retired) is left to its rebuild; otherwise code's witness P1 names the culprit (one
 * active P1 per obligation: `openFinding`'s key). Idempotent for a resumed job.
 */
function attribute(ctx: WitnessContext, due: BatchWitness, o: ObligationDef, culprit: Culprit | null, merges: ReadonlyMap<UnitId, Sha>): void {
  const view = ctx.journal.view;
  if (view.ciFacts().some((f) => f.kind === 'batch-reopened' && f.job === due.job && f.obligation === o.id)) return;
  const publishers = culprit === null ? [] : [...merges].flatMap(([u, m]) => (m === culprit.head ? [u] : [])).sort();
  const deliverer = deliverers(view, o).find((d) => view.unit(d).status !== 'cut' && lineageBack(view, d).some((u) => publishers.includes(u)));
  if (deliverer !== undefined && view.unit(deliverer).status !== 'retired') return;
  if (deliverer !== undefined && culprit !== null) {
    const rows = culprit.range.map((h) => `- ${h}${h === culprit.head ? ' (first red)' : ''}`);
    const brief = Buffer.from(`Batch witness ${due.job}: ${o.id} (lane ${o.witness!.lane}: ${o.witness!.testIds.join(', ')}) is not held at ${due.head}. `
      + `Bisected over the publications since its last good head, the first red is ${culprit.head}, published by ${publishers.join(', ')}. `
      + `Reproduce and repair the delivered claim.\nThe range:\n${rows.join('\n')}\n`);
    keepInput(ctx.runDir, brief, 'brief.md');
    ctx.journal.fact({ kind: 'batch-reopened', job: due.job, unit: deliverer, obligation: o.id, culprit: culprit.head, brief: sha256(sha256Hex(brief)) });
    return;
  }
  const at = culprit === null ? `on the arc's base ${due.head}` : `first red at ${culprit.head}${publishers.length === 0 ? '' : `, published by ${publishers.join(', ')}`}`;
  openFinding(ctx.journal, witnessFindingDraft({
    obligation: o.id, serves: o.serves, job: due.job, gateHadPassed: true,
    claim: `${o.id} is not held on ${due.head}: its batch witness ${o.witness!.lane} (${o.witness!.testIds.join(', ')}) fails there, ${at}.`,
    evidence: [{ path: jobEvidenceRoot(ctx.runDir, due.job), blob: null }, { path: absPath(join(ctx.runDir, 'events.jsonl')), blob: null }],
  }));
}
