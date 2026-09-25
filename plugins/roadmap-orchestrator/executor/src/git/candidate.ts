// `candidate.merge` (DESIGN §3 "Merge", candidate-first): in the integration slot, a `--no-ff` merge of the
// approved unit commit onto the current integration tip T, held on the executor-owned ref
// `refs/roadmap-run/<arc>/candidate/<unit>`. The suite runs on it and, on green, integration fast-forwards
// to exactly this commit (ff.ts), so the tested head is the published head.
//
// `planCandidate` validates before any intent: the transient check over the unit diff, then
// `merge-tree --write-tree T unitCommit` (a conflict is a typed outcome, no commit: the pipeline runs
// mergein.prepare), then the prefix-collision guard over the merged tree. A valid candidate records every
// commit input (tree, parents [T, unitCommit], identity, dates, message), so a redo makes the same id.
// act re-makes the commit and CASes the candidate ref from its recorded old (or absence).
//
// The candidate worktree is a separate `worktree.create` op, detached at the new commit
// (`candidateWorktreeRequest`), run by the caller once this op is done; its own reconciler covers it.
import { crashPoint } from '../core/crash.ts';
import type { CommitInputs, IntentOf, OpOutcome } from '../core/events.ts';
import type { ArcId, Sha, UnitId } from '../core/ids.ts';
import type { GitOp, IntentBody } from '../core/interfaces.ts';
import { type AbsPath, type RefName, type RepoPath, refName } from '../core/values.ts';
import { reconcileCandidate } from '../recover/candidate.ts';
import { type Identity, catFileType, commitTree, refTarget, updateRefCas } from './git.ts';
import { mergeTree, parentsOf } from './mergein.ts';
import { type PrefixCollision, type TransientRules, type TransientViolation, prefixCollisions, transientCheck } from './transient.ts';
import type { WorktreeCreateRequest } from './worktree.ts';

export class CandidateStateError extends Error {
  readonly ref: RefName;
  constructor(ref: RefName, detail: string) {
    super(`candidate ${ref}: ${detail}`);
    this.name = 'CandidateStateError';
    this.ref = ref;
  }
}

export const candidateRef = (arc: ArcId, unit: UnitId): RefName => refName(`refs/roadmap-run/${arc}/candidate/${unit}`);

export type CandidateRequest = Readonly<{
  arc: ArcId;
  unit: UnitId;
  /** The integration branch; its current tip is T. */
  integration: RefName;
  /** The approved (gated) unit commit. */
  unitCommit: Sha;
  /** Where the caller will create the detached candidate worktree. */
  worktree: AbsPath;
  rules: TransientRules;
  identity: Identity;
  message: string;
}>;

export type CandidatePlan = Readonly<{ request: CandidateRequest; tip: Sha; tree: Sha }>;

/** What validation decided. Only `merge` leads to an intent. */
export type CandidateDecision =
  | Readonly<{ kind: 'merge'; plan: CandidatePlan }>
  /** Stage table: transient-check violation → scope-growth fix round (chargeable). */
  | Readonly<{ kind: 'transient-violation'; tip: Sha; violations: readonly TransientViolation[] }>
  /** Stage table: conflict → mergein.prepare + resume "resolve and commit" (uncharged). */
  | Readonly<{ kind: 'conflict'; tip: Sha; conflicts: readonly RepoPath[] }>
  /** Prefix-collision guard: refused like a transient violation. */
  | Readonly<{ kind: 'prefix-collision'; tip: Sha; collisions: readonly PrefixCollision[] }>;

export function planCandidate(repo: AbsPath, request: CandidateRequest): CandidateDecision {
  const tip = refTarget(repo, request.integration);
  if (tip === null) throw new CandidateStateError(candidateRef(request.arc, request.unit), `integration ${request.integration} does not exist`);
  if (catFileType(repo, request.unitCommit) !== 'commit') throw new CandidateStateError(candidateRef(request.arc, request.unit), `unit commit ${request.unitCommit} is not a commit`);
  const violations = transientCheck(repo, request.rules, tip, request.unitCommit);
  if (violations.length > 0) return { kind: 'transient-violation', tip, violations };
  const merged = mergeTree(repo, tip, request.unitCommit);
  if (merged.type === 'conflicted') return { kind: 'conflict', tip, conflicts: merged.conflicts };
  const collisions = prefixCollisions(repo, tip, merged.tree);
  if (collisions.length > 0) return { kind: 'prefix-collision', tip, collisions };
  return { kind: 'merge', plan: { request, tip, tree: merged.tree } };
}

function prepare(repo: AbsPath, plan: CandidatePlan): IntentBody<'candidate.merge'> {
  const { request, tip, tree } = plan;
  const ref = candidateRef(request.arc, request.unit);
  const commit: CommitInputs<readonly [Sha, Sha]> = {
    tree, parents: [tip, request.unitCommit], author: request.identity.author, committer: request.identity.committer,
    message: request.message, gpgsign: false,
  };
  return {
    expect: { ref, old: refTarget(repo, ref), integrationTip: tip, unitCommit: request.unitCommit, worktree: request.worktree, commit },
    post: { new: commitTree(repo, commit) },
  };
}

function act(repo: AbsPath, intent: IntentOf<'candidate.merge'>): void {
  const { ref, old, commit } = intent.expect;
  const next = intent.post.new;
  crashPoint('candidate.act-start');
  const at = refTarget(repo, ref);
  if (at !== old) throw new CandidateStateError(ref, `at ${at ?? 'nothing'}, recorded old ${old ?? 'absent'}`);
  const made = commitTree(repo, commit);
  if (made !== next) throw new CandidateStateError(ref, `commit ${made}, recorded ${next}`);
  crashPoint('candidate.after-commit-tree');
  updateRefCas(repo, ref, next, old ?? 'absent');
  crashPoint('candidate.act-end');
}

/** null when the postcondition holds: ref = new, new's parents [T, unitCommit]. */
export function candidatePostcondition(repo: AbsPath, intent: IntentOf<'candidate.merge'>): string | null {
  const { ref, integrationTip, unitCommit } = intent.expect;
  const next = intent.post.new;
  const at = refTarget(repo, ref);
  if (at !== next) return `${ref} at ${at ?? 'nothing'}, expected ${next}`;
  const parents = parentsOf(repo, next);
  if (parents.join(' ') !== `${integrationTip} ${unitCommit}`) return `${next} has parents ${parents.join(', ')}, expected [${integrationTip}, ${unitCommit}]`;
  return null;
}

function verify(repo: AbsPath, intent: IntentOf<'candidate.merge'>): OpOutcome['candidate.merge'] {
  const problem = candidatePostcondition(repo, intent);
  if (problem !== null) throw new CandidateStateError(intent.expect.ref, problem);
  return { kind: 'merged' };
}

/** The detached candidate worktree at the new commit, for 8a's `worktree.create` op. */
export function candidateWorktreeRequest(intent: IntentOf<'candidate.merge'>): WorktreeCreateRequest {
  return { path: intent.expect.worktree, checkout: { type: 'detached', at: intent.post.new } };
}

export function candidateMergeOp(repo: AbsPath): GitOp<'candidate.merge', CandidatePlan> {
  return {
    kind: 'candidate.merge',
    prepare: async (plan) => prepare(repo, plan),
    act: async (intent) => act(repo, intent),
    verify: async (intent) => verify(repo, intent),
    reconcile: reconcileCandidate(repo),
  };
}
