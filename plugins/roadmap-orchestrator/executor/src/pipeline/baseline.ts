// The baseline witness (M3 step B2; DESIGN-1.0.md §2.8 "Vision, corpus and obligations", A6): before the first admission under
// `holistic`, a durable job `baseline-<n>` witnesses every obligation on the integration tip by running every arc lane
// there (never borrowing another job's observation: the baseline is its own evidence). Then, over its records:
//   - a `must-hold` obligation (a latched future one included) not held → a blocking `obligation-baseline`;
//   - a `future` obligation already held → refused as a vacuous witness, in the same blocking item.
// Split parents are never witnessed directly; exempt obligations are not graded.
//
// The job's lanes run as a journey series under `job{baseline-n}` (src/pipeline/lanes.ts): reserved first of every
// unit, the red-lane protocol, a `witnessed{for: job{baseline-n}}` fact per lane. A job cut short (a crash, a lane
// without a verdict, a failed cleanup whose job-owned residue the job's holder reclaims) is resumed as the same job:
// its leftover checkout removed, only the lanes it has not witnessed on the tip run again. When the tip moved only
// through executor-rendered docs paths (`docs/rendered.ts`), the job's latest equivalent-tree records still count,
// graded against the current obligations. Added or revised lanes run; any non-docs change makes every lane run again.
// An all-future, unlatched lane's expected red needs no diagnostic rerun; must-hold and mixed lanes keep the protocol.
// Each run is its own series on its own checkout
// (`jobSeriesCheckout`: `baseline-<n>.checkout-<k>`), certified once. It is complete once every arc
// lane's current definition is witnessed for it on an equivalent tip and any problem is raised (`raisedFor` its job):
// `baselineDue` then answers null until a lane definition or non-docs tree change requires fresh evidence.
//
// The scheduler (step B7) runs `runBaseline` while `baselineDue` names a job, before admitting any unit.
import { readFileSync } from 'node:fs';
import type { Parent } from '../core/events.ts';
import { type JobId, type LaneId, type ObligationId, type Sha, jobId, parseJobId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { NeedsUserContent } from '../core/records.ts';
import { type AbsPath, branchRef } from '../core/values.ts';
import { isExecutorDoc } from '../docs/rendered.ts';
import { changedPaths } from '../git/docs.ts';
import { revParse } from '../git/git.ts';
import { verdictOf } from '../holistic/observe.ts';
import { type ArcLaneDef, type Obligations, type WitnessRecord, isExempt, isMustHold, laneRevMatches, witnessRecord } from '../holistic/types.ts';
import type { PlanM1 } from '../input/plan.ts';
import { openNeedsUser, readNeedsUser, raiseNeedsUser, raisedFor } from '../needsuser.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import { type JourneyContext, type JourneyEnd, arcJourneyLane, jobSeriesCheckout, removeJobCheckouts, runJourneySeries, witnessRecordPath } from './lanes.ts';
import { holisticInForce } from './stages.ts';
import { parsedOnce,writeOnce } from '../observation/memo.ts';

export type BaselineContext = JourneyContext & Readonly<{ acquireFirst: AcquireFirst }>;

/** One obligation the baseline refuses: a must-hold one not held, or a future one already held (vacuous). */
export type BaselineProblem = Readonly<{ obligation: ObligationId; kind: 'not-held' | 'vacuous'; verdict: string }>;

export type BaselineOutcome =
  /** Every obligation is as it must be on the tip. */
  | Readonly<{ kind: 'held' }>
  /** The blocking `obligation-baseline` item raised for the problems (or found raised). */
  | Readonly<{ kind: 'raised'; problems: readonly BaselineProblem[] }>
  /** A lane gave no verdict (blocked, occupied, a failed cleanup): the job resumes later. */
  | Readonly<{ kind: 'incomplete'; end: JourneyEnd }>;

type Reader = Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; repo: AbsPath; plan: () => PlanM1 }>;

const jobParent = (job: JobId): Parent => ({ type: 'job', job });

/** The latest baseline job the log names, or null. */
function latestBaseline(view: JournalView): JobId | null {
  const n = parseJobId(view.nextJobId('baseline')).n - 1;
  return n === 0 ? null : jobId('baseline', n);
}

/** The job's latest record per lane on `tree` or an earlier tree differing only in executor docs. */
function recordsOf(ctx: Reader, job: JobId, tree: Sha): ReadonlyMap<LaneId, WitnessRecord> {
  const out = new Map<LaneId, WitnessRecord>();
  const equivalent = new Map<Sha, boolean>([[tree, true]]);
  for (const w of ctx.journal.view.holistic().witnessed.toReversed()) {
    if (w.for.type !== 'job' || w.for.job !== job || out.has(w.lane)) continue;
    let same = equivalent.get(w.treeSha);
    if (same === undefined) {
      same = changedPaths(ctx.repo, w.treeSha, tree).every(isExecutorDoc);
      equivalent.set(w.treeSha, same);
    }
    if (!same) continue;
    const path = witnessRecordPath(ctx.runDir, w);
    // The record a fact names is written once, before the fact, which carries its hash: parsed once (the scheduler asks on
    // every tick, twice through `baselineDue`).
    out.set(w.lane, parsedOnce(`witness-record:${job}:${w.lane}:${w.recordsSha256}`,
      () => writeOnce('witness-record', path, () => witnessRecord(JSON.parse(readFileSync(path, 'utf8')), 'witness'))!));
  }
  return out;
}

/**
 * The arc lanes the baseline runs: every one but an external-class lane, which runs off the host and is attested only by
 * its `external-witness` CI facts (src/holistic/external.ts), so the journey series skips it and the baseline neither
 * waits for nor grades it.
 */
export const localLanes = (obligations: Obligations): readonly ArcLaneDef[] => obligations.lanes.filter((l) => l.witnessClass !== 'external');

/** The problems over the records, in id order. An obligation an external-class lane witnesses is not graded here. */
export function baselineProblems(obligations: Obligations, records: ReadonlyMap<LaneId, WitnessRecord>, latched: ReadonlySet<ObligationId>): readonly BaselineProblem[] {
  const local = new Set(localLanes(obligations).map((l) => l.id));
  const out: BaselineProblem[] = [];
  for (const o of obligations.obligations) {
    if (isExempt(o) || o.state.type === 'split' || o.witness === null || !local.has(o.witness.lane)) continue;
    const record = records.get(o.witness.lane);
    if (record === undefined) throw new Error(`baseline: obligation ${o.id}'s lane ${o.witness.lane} was not witnessed`);
    const verdict = verdictOf(record, o.witness);
    const mustHold = isMustHold(o, latched);
    if (mustHold && verdict !== 'held') out.push({ obligation: o.id, kind: 'not-held', verdict });
    if (!mustHold && verdict === 'held') out.push({ obligation: o.id, kind: 'vacuous', verdict });
  }
  return out;
}

type State = Readonly<{ job: JobId; obligations: Obligations; tip: Sha; tree: Sha; missing: readonly LaneId[] }>;

/** The job's state now: its id and the lanes whose current definitions lack a witness on a docs-equivalent tree. */
function stateOf(ctx: Reader): State | null {
  const view = ctx.journal.view;
  if (!view.holistic().on) return null;
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) return null;
  const tip = revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));
  const tree = revParse(ctx.repo, `${tip}^{tree}`);
  const job = latestBaseline(view) ?? view.nextJobId('baseline');
  const witnessed = recordsOf(ctx, job, tree);
  return { job, obligations, tip, tree, missing: localLanes(obligations).filter((l) => {
    const record = witnessed.get(l.id);
    return record === undefined || !laneRevMatches(record.laneRev, l);
  }).map((l) => l.id) };
}

/**
 * The baseline job the arc owes, or null: outside a holistic arc with obligations, or once its job witnessed every arc
 * lane's current definition on a docs-equivalent tree and raised whatever it found.
 */
export function baselineDue(ctx: Reader): JobId | null {
  const s = stateOf(ctx);
  if (s === null) return null;
  if (s.missing.length > 0) return s.job;
  const latched = new Set(ctx.journal.view.holistic().latched.map((l) => l.obligation));
  const problems = baselineProblems(s.obligations, recordsOf(ctx, s.job, s.tree), latched);
  if (problems.length === 0 && baselineItems(ctx).length > 0) return s.job;
  return problems.length > 0 && raisedFor(ctx.journal.view, jobParent(s.job)) === null ? s.job : null;
}

/** Baseline items alone may settle when a later baseline establishes the required state. */
function baselineItems(ctx: Reader) {
  return openNeedsUser(ctx.journal.view).filter((n) => readNeedsUser(ctx.runDir, n.id)?.reason === 'obligation-baseline').map((n) => n.id).sort();
}

function baselineNeedsUser(ctx: BaselineContext, job: JobId, tip: Sha, problems: readonly BaselineProblem[]): NeedsUserContent {
  const notHeld = problems.filter((p) => p.kind === 'not-held').map((p) => `${p.obligation} (${p.verdict})`);
  const vacuous = problems.filter((p) => p.kind === 'vacuous').map((p) => p.obligation);
  return {
    blocking: true,
    subject: { type: 'arc' },
    reason: 'obligation-baseline',
    summary: `The baseline witness (${job}) on ${ctx.plan().integrationBranch} at ${tip} refuses the obligations:`
      + `${notHeld.length === 0 ? '' : ` must-hold but not held: ${notHeld.join(', ')};`}${vacuous.length === 0 ? '' : ` future but already held (a vacuous witness): ${vacuous.join(', ')};`}`
      + ' no unit is admitted under holistic until this is resolved.',
    recommendation: 'Repair the base so each must-hold obligation holds (or rule a disposition naming it), and give each vacuous future obligation a witness that '
      + 'fails until it is delivered (or make it must-hold) with `roadmap apply`. A later baseline with no problems closes this item. '
      + 'After reviewing the evidence and resolving or explicitly accepting the failure (including a host-contention timeout), explicitly acknowledge this item.',
    options: [],
    evidence: [jobEvidenceRoot(ctx.runDir, job)],
  };
}

/**
 * Runs (or resumes) the baseline job `baselineDue` names: every missing or revised arc lane on the tip, then the
 * verdicts, raising the blocking `obligation-baseline` item for any problem (once per job).
 */
export async function runBaseline(ctx: BaselineContext): Promise<BaselineOutcome> {
  const s = stateOf(ctx);
  if (s === null || baselineDue(ctx) === null) throw new Error('runBaseline: no baseline is due');
  const { job, obligations, tip, tree } = s;
  const latched = new Set(ctx.journal.view.holistic().latched.map((l) => l.obligation));
  await removeJobCheckouts(ctx, job);
  if (s.missing.length > 0) {
    const lanes = obligations.lanes.filter((l) => s.missing.includes(l.id)).map(arcJourneyLane);
    const expectedRed = new Set(lanes.filter((l) => {
      const witnessed = obligations.obligations.filter((o) => o.witness?.lane === l.def.id);
      return witnessed.length > 0 && witnessed.every((o) => !isMustHold(o, latched));
    }).map((l) => l.def.id));
    const series = await runJourneySeries(ctx, { type: 'job', job, acquireFirst: ctx.acquireFirst }, lanes, {
      path: jobSeriesCheckout(ctx, job, 'checkout'), checkout: { type: 'detached', at: tip },
    }, { reuse: false, stop: () => false, expectedRed });
    if (series.end.kind !== 'ran') return { kind: 'incomplete', end: series.end };
  }
  const problems = baselineProblems(obligations, recordsOf(ctx, job, tree), latched);
  if (problems.length === 0) {
    const items = baselineItems(ctx);
    if (items.length > 0) ctx.journal.fact({ kind: 'baseline-held', job, items });
    return { kind: 'held' };
  }
  if (raisedFor(ctx.journal.view, jobParent(job)) === null) raiseNeedsUser(ctx.journal, ctx.runDir, baselineNeedsUser(ctx, job, tip, problems), jobParent(job));
  return { kind: 'raised', problems };
}
