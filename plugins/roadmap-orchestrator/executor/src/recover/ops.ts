// The git and evidence ops, each assembled from its module's steps (prepare, act, verify) and its kind's
// reconciler. This is the one place an op meets its reconciler: the git modules export steps and pure
// helpers, the reconcilers use those helpers and git.ts plumbing, and neither imports the other back.
// The pipeline runs these ops; the recovery engine (recover.ts) rebuilds them from an open intent.
import type { IntentOf, OpOutcome } from '../core/events.ts';
import type { GitOp, IntentBody, Reconciler } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { type CandidatePlan, candidateMergeSteps } from '../git/candidate.ts';
import { type DocsPlan, docsCommitSteps } from '../git/docs.ts';
import { type SnapshotRequest, evidenceSnapshotSteps } from '../git/evidence.ts';
import { type FfPlan, integrationFfSteps } from '../git/ff.ts';
import { type MergeinRequest, mergeinSteps } from '../git/mergein.ts';
import { type SalvagePlan, type SalvageRules, salvageCommitSteps } from '../git/salvage.ts';
import { type SnapshotPublishRequest, snapshotPublishSteps } from '../git/snapshot.ts';
import { type WorktreeCreateRequest, type WorktreeRemoveRequest, worktreeCreateSteps, worktreeRemoveSteps } from '../git/worktree.ts';
import { reconcileCandidate } from './candidate.ts';
import { reconcileDocsCommit } from './docs.ts';
import { reconcileEvidenceSnapshot } from './evidence.ts';
import { type UnitRedo, reconcileIntegrationFf } from './ff.ts';
import { reconcileMergein } from './mergein.ts';
import { reconcileSalvageCommit } from './salvage.ts';
import { reconcileSnapshot } from './snapshot.ts';
import { reconcileWorktreeCreate, reconcileWorktreeRemove } from './worktree.ts';

export function worktreeCreateOp(repo: AbsPath): GitOp<'worktree.create', WorktreeCreateRequest> {
  return { ...worktreeCreateSteps(repo), reconcile: reconcileWorktreeCreate(repo) };
}

export function worktreeRemoveOp(repo: AbsPath): GitOp<'worktree.remove', WorktreeRemoveRequest> {
  return { ...worktreeRemoveSteps(repo), reconcile: reconcileWorktreeRemove(repo) };
}

/** `evidence.snapshot` is not a git kind (`GitOp` is limited to those): the same shape, its own record. */
export type EvidenceSnapshotOp = Readonly<{
  kind: 'evidence.snapshot';
  prepare(request: SnapshotRequest): Promise<IntentBody<'evidence.snapshot'>>;
  act(intent: IntentOf<'evidence.snapshot'>): Promise<void>;
  verify(intent: IntentOf<'evidence.snapshot'>): Promise<OpOutcome['evidence.snapshot']>;
  reconcile: Reconciler<'evidence.snapshot'>;
}>;

export const evidenceSnapshotOp: EvidenceSnapshotOp = { ...evidenceSnapshotSteps, reconcile: reconcileEvidenceSnapshot };

/** `rules` are the salvage rules the stage binds (pinned scope, excluded globs, rejected root); recovery rebuilds them. */
export function salvageCommitOp(rules: SalvageRules): GitOp<'salvage.commit', SalvagePlan> {
  return { ...salvageCommitSteps(rules), reconcile: reconcileSalvageCommit(rules) };
}

export function mergeinOp(repo: AbsPath): GitOp<'mergein.prepare', MergeinRequest> {
  return { ...mergeinSteps(repo), reconcile: reconcileMergein };
}

export function candidateMergeOp(repo: AbsPath): GitOp<'candidate.merge', CandidatePlan> {
  return { ...candidateMergeSteps(repo), reconcile: reconcileCandidate(repo) };
}

/** M3 (A4): a docs publication's commit of its rendered files and contract ops on the tip. */
export function docsCommitOp(repo: AbsPath): GitOp<'docs.commit', DocsPlan> {
  return { ...docsCommitSteps(repo), reconcile: reconcileDocsCommit(repo) };
}

/**
 * `unitRedo` is the caller's re-check of a unit `ff`: the recorded approval fingerprint at T (gate.ts) and the unit's
 * eligibility (G10, integrate.ts `findingBlocking`); recovery redoes a unit CAS that never happened only when it says
 * yes. A docs publication's `ff` never asks it.
 */
export function integrationFfOp(repo: AbsPath, unitRedo: UnitRedo): GitOp<'integration.ff', FfPlan> {
  return { ...integrationFfSteps(repo), reconcile: reconcileIntegrationFf(repo, unitRedo) };
}

export function snapshotPublishOp(repo: AbsPath): GitOp<'snapshot.publish', SnapshotPublishRequest> {
  return { ...snapshotPublishSteps(repo), reconcile: reconcileSnapshot(repo) };
}
