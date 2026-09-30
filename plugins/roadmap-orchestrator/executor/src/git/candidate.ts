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
//
// A repair batch (M3 B2; R7, G5, H4; `planBatchCandidate`) is one candidate of every member, chained: `commit` merges
// the first member onto T, and each `batch.chain` entry merges the next member onto the previous merge (`--no-ff`),
// every merge with the same identity, dates and message, on `refs/roadmap-run/<arc>/candidate/<batch job>` (the frozen candidate ref shape). Each
// member's diff passes the transient check against T and each merge is clean; the last merge's tree passes the prefix
// guard. The chain records each merge's commit id and parents; act re-makes each from `merge-tree` of its parents and
// requires the recorded id, so a redo makes the same chain.
import { crashPoint } from '../core/crash.ts';
import { type CommitInputs, type IntentOf, type OpOutcome, parentUnit } from '../core/events.ts';
import type { ArcId, JobId, Sha, UnitId } from '../core/ids.ts';
import type { ApprovalFingerprint } from '../core/records.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import { type AbsPath, type RefName, type RepoPath, refName } from '../core/values.ts';
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
/** A repair batch's candidate ref, keyed by its durable job (`batch-<n>`). */
export const batchCandidateRef = (arc: ArcId, job: JobId): RefName => refName(`refs/roadmap-run/${arc}/candidate/${job}`);

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

/** A batch's plan beyond its first member (the request's unit): its job, every member, and each chain merge's tree. */
export type BatchPlan = Readonly<{
  job: JobId;
  members: readonly Readonly<{ unit: UnitId; unitCommit: Sha; fingerprint: ApprovalFingerprint }>[];
  /** The clean tree of each merge after the first (one per member after the first). */
  trees: readonly Sha[];
}>;

export type CandidatePlan = Readonly<{ request: CandidateRequest; tip: Sha; tree: Sha; batch?: BatchPlan }>;

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

/** A batch member of a candidate request: its approved commit, its approval, and its transient rules. */
export type BatchMemberRequest = Readonly<{ unit: UnitId; unitCommit: Sha; fingerprint: ApprovalFingerprint; rules: TransientRules }>;

export type BatchRequest = Omit<CandidateRequest, 'unit' | 'unitCommit' | 'rules'> & Readonly<{ job: JobId; members: readonly BatchMemberRequest[] }>;

/** What batch validation decided: the chain, or the first member (in order) whose diff or merge refuses it. */
export type BatchDecision =
  | Readonly<{ kind: 'merge'; plan: CandidatePlan }>
  | Readonly<{ kind: 'transient-violation'; unit: UnitId; tip: Sha; violations: readonly TransientViolation[] }>
  | Readonly<{ kind: 'conflict'; unit: UnitId; tip: Sha; conflicts: readonly RepoPath[] }>
  | Readonly<{ kind: 'prefix-collision'; tip: Sha; collisions: readonly PrefixCollision[] }>;

/**
 * Validates a batch before any intent: each member's transient check against T, then the merges in member order (each
 * member onto the previous merge's tree, clean), then the prefix guard over the last tree. The merges after the first
 * are made here (their commits are content: a redo makes the same ids).
 */
export function planBatchCandidate(repo: AbsPath, request: BatchRequest): BatchDecision {
  const ref = batchCandidateRef(request.arc, request.job);
  if (request.members.length < 2) throw new CandidateStateError(ref, `a batch of ${request.members.length} member: a batch has at least two`);
  const tip = refTarget(repo, request.integration);
  if (tip === null) throw new CandidateStateError(ref, `integration ${request.integration} does not exist`);
  for (const m of request.members) {
    if (catFileType(repo, m.unitCommit) !== 'commit') throw new CandidateStateError(ref, `unit commit ${m.unitCommit} of ${m.unit} is not a commit`);
    const violations = transientCheck(repo, m.rules, tip, m.unitCommit);
    if (violations.length > 0) return { kind: 'transient-violation', unit: m.unit, tip, violations };
  }
  const [first, ...rest] = request.members;
  const firstMerge = mergeTree(repo, tip, first!.unitCommit);
  if (firstMerge.type === 'conflicted') return { kind: 'conflict', unit: first!.unit, tip, conflicts: firstMerge.conflicts };
  const base = { arc: request.arc, unit: first!.unit, integration: request.integration, unitCommit: first!.unitCommit, worktree: request.worktree, rules: first!.rules, identity: request.identity, message: request.message };
  let prev = commitTree(repo, mergeCommit(base, firstMerge.tree, [tip, first!.unitCommit]));
  let last = firstMerge.tree;
  const trees: Sha[] = [];
  for (const m of rest) {
    const merged = mergeTree(repo, prev, m.unitCommit);
    if (merged.type === 'conflicted') return { kind: 'conflict', unit: m.unit, tip, conflicts: merged.conflicts };
    trees.push(merged.tree);
    last = merged.tree;
    prev = commitTree(repo, mergeCommit(base, merged.tree, [prev, m.unitCommit]));
  }
  const collisions = prefixCollisions(repo, tip, last);
  if (collisions.length > 0) return { kind: 'prefix-collision', tip, collisions };
  return {
    kind: 'merge',
    plan: { request: base, tip, tree: firstMerge.tree, batch: { job: request.job, members: request.members.map(({ unit, unitCommit, fingerprint }) => ({ unit, unitCommit, fingerprint })), trees } },
  };
}

/** A candidate merge's commit inputs: the request's identity and message, `tree`, `parents`. */
const mergeCommit = (request: CandidateRequest, tree: Sha, parents: readonly [Sha, Sha]): CommitInputs<readonly [Sha, Sha]> => ({
  tree, parents, author: request.identity.author, committer: request.identity.committer, message: request.message, gpgsign: false,
});

function prepare(repo: AbsPath, plan: CandidatePlan): IntentBody<'candidate.merge'> {
  const { request, tip, tree, batch } = plan;
  const ref = batch === undefined ? candidateRef(request.arc, request.unit) : batchCandidateRef(request.arc, batch.job);
  const commit = mergeCommit(request, tree, [tip, request.unitCommit]);
  let last = commitTree(repo, commit);
  const chain: { commit: Sha; parents: readonly [Sha, Sha] }[] = [];
  for (const [i, m] of (batch?.members.slice(1) ?? []).entries()) {
    const parents = [last, m.unitCommit] as const;
    last = commitTree(repo, mergeCommit(request, batch!.trees[i]!, parents));
    chain.push({ commit: last, parents });
  }
  return {
    expect: {
      ref, old: refTarget(repo, ref), integrationTip: tip, unitCommit: request.unitCommit, worktree: request.worktree, commit,
      ...(batch === undefined ? {} : { batch: { job: batch.job, members: batch.members, chain } }),
    },
    post: { new: last },
  };
}

/** Re-makes a batch's chain merges from `merge-tree` of each one's parents, requiring each recorded id. */
function remakeChain(repo: AbsPath, intent: IntentOf<'candidate.merge'>): void {
  const { ref, commit, batch } = intent.expect;
  for (const c of batch?.chain ?? []) {
    const merged = mergeTree(repo, c.parents[0], c.parents[1]);
    if (merged.type === 'conflicted') throw new CandidateStateError(ref, `chain merge ${c.commit} conflicts on redo: ${merged.conflicts.join(', ')}`);
    const made = commitTree(repo, { ...commit, tree: merged.tree, parents: c.parents });
    if (made !== c.commit) throw new CandidateStateError(ref, `chain merge ${made}, recorded ${c.commit}`);
  }
}

function act(repo: AbsPath, intent: IntentOf<'candidate.merge'>): void {
  const { ref, old, commit } = intent.expect;
  const next = intent.post.new;
  crashPoint('candidate.act-start', parentUnit(intent.parent));
  const at = refTarget(repo, ref);
  if (at !== old) throw new CandidateStateError(ref, `at ${at ?? 'nothing'}, recorded old ${old ?? 'absent'}`);
  const made = commitTree(repo, commit);
  remakeChain(repo, intent);
  const last = intent.expect.batch?.chain.at(-1)?.commit ?? made;
  if (last !== next) throw new CandidateStateError(ref, `commit ${last}, recorded ${next}`);
  crashPoint('candidate.after-commit-tree', parentUnit(intent.parent));
  updateRefCas(repo, ref, next, old ?? 'absent');
  crashPoint('candidate.act-end', parentUnit(intent.parent));
}

/**
 * null when the postcondition holds: ref = new, new's parents [T, unitCommit]; a batch's: the first merge's parents
 * [T, first member], each chain merge's its recorded parents, new the last chain merge.
 */
export function candidatePostcondition(repo: AbsPath, intent: IntentOf<'candidate.merge'>): string | null {
  const { ref, integrationTip, unitCommit, batch } = intent.expect;
  const next = intent.post.new;
  const at = refTarget(repo, ref);
  if (at !== next) return `${ref} at ${at ?? 'nothing'}, expected ${next}`;
  const merges: readonly Readonly<{ commit: Sha; parents: readonly Sha[] }>[] = batch === undefined
    ? [{ commit: next, parents: [integrationTip, unitCommit] }]
    : [{ commit: batch.chain[0]!.parents[0], parents: [integrationTip, unitCommit] }, ...batch.chain];
  if (merges.at(-1)!.commit !== next) return `${next} is not the last merge of the chain (${merges.at(-1)!.commit})`;
  for (const m of merges) {
    const parents = parentsOf(repo, m.commit);
    if (parents.join(' ') !== m.parents.join(' ')) return `${m.commit} has parents ${parents.join(', ')}, expected [${m.parents.join(', ')}]`;
  }
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

export function candidateMergeSteps(repo: AbsPath): GitSteps<'candidate.merge', CandidatePlan> {
  return {
    kind: 'candidate.merge',
    prepare: async (plan) => prepare(repo, plan),
    act: async (intent) => act(repo, intent),
    verify: async (intent) => verify(repo, intent),
  };
}
