// The canonical candidate-red diagnosis: persisted before the outcome, then reused by fixes and parks.
import { join } from 'node:path';
import type { CandidateRedCause, CandidateRedDetail } from '../core/events.ts';
import type { PlanUnit } from '../input/plan.ts';
import type { FixRound } from '../prompts/inputs.ts';
import { absPath } from '../core/values.ts';
import { type StageContext, type StageParent, evidenceRoot } from './dispatch.ts';
import { batchMemberFix, candidateBrakeFix, candidateSeriesRoot, latestCandidate, memberBatchCandidate } from './integrate.ts';
import { type JourneyCheckout, type LaneRecord, seriesDirty, seriesLedger, witnessRecordPath } from './lanes.ts';
import { mutantFix } from './reproduce.ts';
import { failingEvidenceDirs, failingLaneDirectives } from './rounds.ts';
import { loadUnitSpec } from './stages.ts';

/** Why candidate attempt `at` (an outcome `red`) was red, as its fix round reads it: the fix, and the suite's ledger. */
export function candidateRed(ctx: StageContext, unit: PlanUnit, at: StageParent, checkout: JourneyCheckout | null = null): Readonly<{ fix: FixRound; suite: readonly LaneRecord[]; detail: CandidateRedDetail }> {
  const view = ctx.journal.view;
  const saved = view.unit(unit.id).decided;
  const detail = saved?.stage === 'candidate' && saved.attempt === at.attempt && saved.detail?.kind === 'candidate-red' ? saved.detail : null;
  const result = (fix: FixRound & Readonly<{causes?: readonly CandidateRedCause[]}>, suite: readonly LaneRecord[], path: Exclude<CandidateRedDetail['path'], 'legacy'>): Readonly<{fix: FixRound; suite: readonly LaneRecord[]; detail: CandidateRedDetail}> => {
    const witnesses = view.holistic().witnessed.filter((w) => fix.failingEvidenceDirs.some((dir) => witnessRecordPath(ctx.runDir, w).startsWith(`${dir}/`)));
    const changed = checkout !== null && (checkout.dirty.length > 0 || checkout.movedTo !== null);
    const evidence = [...new Set([...fix.failingEvidenceDirs, ...witnesses.map((w) => witnessRecordPath(ctx.runDir, w)), ...(changed && checkout.dirty.length > 0 ? [checkout.evidence] : [])])];
    fix = {...fix, directives: [...fix.directives,
      ...suite.map((l) => `Lane ${l.lane} ${l.reused === null ? 'RUN' : 'REUSED'}: ${l.inv}; evidence ${l.evidenceDir}.`),
      ...(path === 'mutant survivor' ? witnesses.map((w) => `Lane ${w.lane} RUN: ${w.inv}; record ${witnessRecordPath(ctx.runDir, w)}.`) : []),
      ...(changed ? [`Checkout integrity: dirty paths: ${checkout.dirty.join(', ') || 'none'}; ${checkout.movedTo === null ? 'HEAD unchanged' : `HEAD moved to ${checkout.movedTo}`}.`] : []),
    ]};
    return { fix, suite, detail: { kind: 'candidate-red', path, causes: [...new Set([path, ...(fix.causes ?? []), ...(changed ? ['dirty/moved checkout' as const] : [])])], summary: `${path}: ${fix.directives.join(' ')}`, evidence, directives: fix.directives, baseComparison: fix.baseComparison ?? null } };
  };
  if (detail !== null && detail.path !== 'legacy') {
    const root = candidateSeriesRoot(ctx.runDir, at);
    const suite = detail.path === 'repair batch' ? [] : [
      ...seriesLedger(ctx, at, loadUnitSpec(ctx, unit).spec.lanes, 'spec', latestCandidate(ctx, unit.id).post.new, absPath(join(root, '_spec'))),
      ...seriesLedger(ctx, at, ctx.plan().suite.lanes, 'suite', latestCandidate(ctx, unit.id).post.new, root),
    ];
    return {fix: {failingEvidenceDirs: detail.evidence, directives: detail.directives, baseComparison: detail.baseComparison}, suite, detail};
  }
  // M3 (B7): a member of a repair batch red on its own selection: the batch candidate's evidence.
  const batch = memberBatchCandidate(view, at);
  if (batch !== null) return result(batchMemberFix(ctx, unit, batch), [], 'repair batch');
  // Red on the candidate, green on the tip alone: the suite's failing lanes are the evidence.
  const root = candidateSeriesRoot(ctx.runDir, at);
  const specRoot = absPath(join(root, '_spec'));
  const head = latestCandidate(ctx, unit.id).post.new;
  const suite = [...seriesLedger(ctx, at, loadUnitSpec(ctx, unit).spec.lanes, 'spec', head, specRoot), ...seriesLedger(ctx, at, ctx.plan().suite.lanes, 'suite', head, root)];
  // M3 (B3): a vacuity repair's candidate that did not kill its mutant (the suite and the brake green).
  const survived = mutantFix(ctx, at);
  if (survived !== null) return result(survived, suite, 'mutant survivor');
  const failing = suite.filter((l) => l.verdict !== 'pass');
  // M3: a green suite with red held claims (the brake): the obligations and journey lanes left red.
  if (failing.length === 0 && [...seriesDirty(view, root), ...seriesDirty(view, specRoot)].length === 0) return result(candidateBrakeFix(ctx, unit, at), suite, 'held-claims brake');
  // This red suite was compared with a green tip-alone series before the candidate outcome was recorded.
  const base = latestCandidate(ctx, unit.id).expect.integrationTip;
  const evidence = absPath(join(evidenceRoot(ctx.runDir, at), 'base'));
  return result({
    failingEvidenceDirs: [...(failing.length > 0 ? failing : suite).flatMap(failingEvidenceDirs), evidence],
    baseComparison: failing.map((lane) => ({lane: lane.lane, base, result: 'pass', evidence})),
    directives: [...failingLaneDirectives(failing), ...([...seriesDirty(view, root), ...seriesDirty(view, specRoot)].length === 0 ? [] : [`Dirty/moved checkout: dirty paths: ${[...seriesDirty(view, root), ...seriesDirty(view, specRoot)].join(', ')}; clean lane outputs before re-entry.`]), `The candidate is red and the integration base ${base} is green. Base comparison evidence: ${evidence}.`],
    causes: [...seriesDirty(view, root), ...seriesDirty(view, specRoot)].length > 0 ? ['dirty/moved checkout'] : [],
  }, suite, 'suite red vs tip green');
}


/** A re-entry must change the recorded cause as well as consider resetting its inherited chargeable count. */
export function candidateReentryChange(detail: CandidateRedDetail): string {
  const change: Readonly<Record<CandidateRedCause, string>> = {
    'suite red vs tip green': 'repair the named failing suite/spec checks against the green integration tip',
    'held-claims brake': 'make the named obligations hold on the candidate without weakening their current witnesses',
    'declared repair not held': 'make every named declared repair hold, including its split children',
    'unexplained lane failures': 'fix the unexplained journey failures in the named lane outputs',
    'dirty/moved checkout': 'clean lane outputs and keep checkout HEAD unchanged',
    'background failures': 'fix the regression in the named background tests',
    'mutant survivor': 'strengthen the witness so the named surviving mutant fails',
    'repair batch': 'repair the named obligations on the repair-batch candidate',
  };
  return detail.path === 'legacy'
    ? 'The previous release recorded no cause: inspect its original candidate evidence before choosing what to change.'
    : `For this ${detail.path}, the re-entry must ${detail.causes.map((cause) => change[cause]).join('; ')}. Resetting counters alone cannot fix this red.`;
}
