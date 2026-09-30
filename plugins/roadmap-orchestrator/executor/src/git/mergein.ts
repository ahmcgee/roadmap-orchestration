// `mergein.prepare`: bring the integration tip T into a unit's branch, in the unit's worktree, when its
// candidate conflicted (stage table: conflict → merge-in + resume "resolve and commit").
//
// prepare records the branch's old commit, T and the `merge-tree --write-tree old T` result. A clean merge
// records full commit inputs (parents [old, T]) and the expected id; act re-makes that commit (the same id,
// inputs recorded), CASes the branch and moves the worktree's index and files to it (`read-tree -m -u`).
// A conflicting merge records the conflict set; act runs the real `git merge --no-commit --no-ff T`, which
// leaves conflict markers in the files and MERGE_HEAD = T for the implementer. After the implementer
// resolves and commits, HEAD has parents [old, T]: the `completed` state (`mergeinCompleted`).
//
// Every state is classified by HEAD and MERGE_HEAD (`classifyMergein`), which verify and the reconciler
// share. The diff base after a merge-in is `diffBase(T, branch)` (transient.ts), which is then T.
import { crashPoint } from '../core/crash.ts';
import { type CommitInputs, type IntentOf, type OpOutcome, parentUnit } from '../core/events.ts';
import { type Sha, sha } from '../core/ids.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import { type AbsPath, type RefName, type RepoPath, gitDate, repoPath } from '../core/values.ts';
import {
  type Identity, commitTree, git, gitPath, gitRun, refTarget, revParse, statusPorcelainV2Z, symbolicHead, updateRefCas,
  writeTreeFromIndex,
} from './git.ts';

export class MergeinStateError extends Error {
  readonly worktree: AbsPath;
  constructor(worktree: AbsPath, detail: string) {
    super(`merge-in ${worktree}: ${detail}`);
    this.name = 'MergeinStateError';
    this.worktree = worktree;
  }
}

// ---------------------------------------------------------------------------------------------------
// merge-tree

export type MergeTreeResult =
  | Readonly<{ type: 'clean'; tree: Sha }>
  | Readonly<{ type: 'conflicted'; conflicts: readonly RepoPath[] }>;

/** `merge-tree --write-tree -z --name-only ours theirs`: exit 0 is a clean tree, exit 1 lists conflicted paths. */
export function mergeTree(repo: AbsPath, ours: Sha, theirs: Sha): MergeTreeResult {
  const r = gitRun(repo, ['merge-tree', '--write-tree', '-z', '--name-only', ours, theirs], { okCodes: [0, 1] });
  // Output: <tree>\0, then (on conflict) one conflicted path per \0, an empty field, informational messages.
  const fields = r.stdout.split('\0');
  const tree = sha(fields[0]);
  if (r.code === 0) return { type: 'clean', tree };
  const end = fields.indexOf('', 1);
  if (end === -1) throw new Error(`merge-tree ${ours} ${theirs}: unparsable conflict output`);
  const conflicts = [...new Set(fields.slice(1, end))].map((p) => repoPath(p)).sort();
  if (conflicts.length === 0) throw new Error(`merge-tree ${ours} ${theirs}: exit 1 without a conflicted path`);
  return { type: 'conflicted', conflicts };
}

// ---------------------------------------------------------------------------------------------------
// State

/** MERGE_HEAD of a worktree, or null when no merge is in progress. */
export function mergeHead(worktree: AbsPath): Sha | null {
  const r = gitRun(worktree, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], { okCodes: [0, 1] });
  return r.code === 0 ? sha(r.stdout.trim()) : null;
}

/** A commit's parents, in order. */
export function parentsOf(repo: AbsPath, commit: Sha): readonly Sha[] {
  const [, ...parents] = git(repo, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ');
  return parents.map((p) => sha(p));
}

const unmergedPaths = (worktree: AbsPath): readonly RepoPath[] =>
  statusPorcelainV2Z(worktree, false).filter((s) => s.type === 'unmerged').map((s) => s.path).sort();

export type MergeinState =
  /** HEAD = old, no MERGE_HEAD, the index at old: nothing happened yet. */
  | Readonly<{ kind: 'untouched' }>
  /** HEAD = the recorded clean merge; `indexAt`: whether the index and files were moved to it yet. */
  | Readonly<{ kind: 'clean-merged'; next: Sha; indexAt: 'old' | 'new' }>
  /** HEAD = old, MERGE_HEAD = T, the recorded conflicts unmerged in the index. */
  | Readonly<{ kind: 'conflicted' }>
  /** No MERGE_HEAD; HEAD has parents [old, T] (the implementer's resolution, or the recorded clean merge's twin). */
  | Readonly<{ kind: 'completed'; head: Sha }>
  | Readonly<{ kind: 'foreign'; detail: string }>;

/** Classifies a merge-in's worktree by HEAD and MERGE_HEAD. HEAD must still be on the recorded branch. */
export function classifyMergein(intent: IntentOf<'mergein.prepare'>): MergeinState {
  const { worktree, branch, old, integrationTip, merge } = intent.expect;
  const foreign = (detail: string): MergeinState => ({ kind: 'foreign', detail });
  const attached = symbolicHead(worktree);
  if (attached !== branch) return foreign(`HEAD on ${attached ?? 'detached'}, expected ${branch}`);
  const head = revParse(worktree, 'HEAD');
  const merging = mergeHead(worktree);
  const indexTree = writeTreeFromIndexOrNull(worktree);
  const clean = intent.post.type === 'clean-merged' ? intent.post.new : null;

  if (head === old && merging === null) {
    return indexTree === revParse(worktree, `${old}^{tree}`) ? { kind: 'untouched' } : foreign('HEAD = old but the index differs from it');
  }
  if (head === old && merging !== null) {
    if (merging !== integrationTip) return foreign(`MERGE_HEAD ${merging}, expected ${integrationTip}`);
    if (merge.type !== 'conflicted') return foreign('a merge in progress, but the recorded merge was clean');
    const unmerged = unmergedPaths(worktree);
    if (unmerged.join('\0') !== merge.conflicts.join('\0')) return foreign(`unmerged ${unmerged.join(', ')}, recorded ${merge.conflicts.join(', ')}`);
    return { kind: 'conflicted' };
  }
  if (merging !== null) return foreign(`HEAD ${head} with MERGE_HEAD ${merging}`);
  if (clean !== null && head === clean && merge.type === 'clean') {
    if (indexTree === merge.commit.tree) return { kind: 'clean-merged', next: clean, indexAt: 'new' };
    if (indexTree === revParse(worktree, `${old}^{tree}`)) return { kind: 'clean-merged', next: clean, indexAt: 'old' };
    return foreign(`HEAD = the merge but the index tree is ${indexTree ?? 'unmerged'}`);
  }
  const parents = parentsOf(worktree, head);
  if (parents.length === 2 && parents[0] === old && parents[1] === integrationTip) return { kind: 'completed', head };
  return foreign(`HEAD ${head} (parents ${parents.join(', ')}) is neither old ${old} nor a merge of [old, T]`);
}

/** The index's tree, or null while it holds unmerged entries (write-tree refuses those). */
function writeTreeFromIndexOrNull(worktree: AbsPath): Sha | null {
  if (unmergedPaths(worktree).length > 0) return null;
  return writeTreeFromIndex(worktree, gitPath(worktree, 'index'));
}

/**
 * The `completed` outcome once the implementer has resolved and committed: HEAD on the branch with
 * parents [old, T], no merge in progress. Anything else is a MergeinStateError naming the state.
 */
export function mergeinCompleted(intent: IntentOf<'mergein.prepare'>): Extract<OpOutcome['mergein.prepare'], { kind: 'completed' }> {
  const state = classifyMergein(intent);
  if (state.kind !== 'completed') throw new MergeinStateError(intent.expect.worktree, `not completed: ${state.kind}${state.kind === 'foreign' ? ` (${state.detail})` : ''}`);
  return { kind: 'completed', head: state.head };
}

// ---------------------------------------------------------------------------------------------------
// The op

export type MergeinRequest = Readonly<{
  worktree: AbsPath;
  branch: RefName;
  /** The integration branch whose current tip is merged in. */
  integration: RefName;
  identity: Identity;
  message: string;
}>;

function prepare(repo: AbsPath, request: MergeinRequest): IntentBody<'mergein.prepare'> {
  const { worktree, branch, integration, identity, message } = request;
  const attached = symbolicHead(worktree);
  if (attached !== branch) throw new MergeinStateError(worktree, `HEAD on ${attached ?? 'detached'}, expected ${branch}`);
  if (mergeHead(worktree) !== null) throw new MergeinStateError(worktree, 'a merge is already in progress');
  const dirty = statusPorcelainV2Z(worktree, false);
  if (dirty.length > 0) throw new MergeinStateError(worktree, `status not clean: ${dirty.map((s) => s.path).join(', ')}`);
  const old = revParse(worktree, branch);
  const tip = refTarget(repo, integration);
  if (tip === null) throw new MergeinStateError(worktree, `integration ${integration} does not exist`);
  const result = mergeTree(repo, old, tip);
  const base = { worktree, branch, old, integrationTip: tip };
  if (result.type === 'conflicted') {
    return { expect: { ...base, merge: { type: 'conflicted', conflicts: result.conflicts } }, post: { type: 'conflicted' } };
  }
  const commit: CommitInputs<readonly [Sha, Sha]> = {
    tree: result.tree, parents: [old, tip], author: identity.author, committer: identity.committer, message, gpgsign: false,
  };
  return { expect: { ...base, merge: { type: 'clean', commit } }, post: { type: 'clean-merged', new: commitTree(repo, commit) } };
}

/** Moves the worktree's index and files from old to the clean merge (a two-tree `read-tree -m -u`); the index must be at old. */
export function finishCleanMerge(worktree: AbsPath, old: Sha, next: Sha): void {
  git(worktree, ['read-tree', '-m', '-u', old, next]);
}

/**
 * `git merge` refuses to start without a committer identity even under `--no-commit`, although it writes
 * no commit. No object carries this one, so a fixed placeholder serves (and keeps config out of it).
 */
const MERGE_SIGNATURE = { name: 'Roadmap Executor', email: 'executor@roadmap.invalid', date: gitDate('1767225600 +0000') };
const MERGE_IDENTITY: Identity = { author: MERGE_SIGNATURE, committer: MERGE_SIGNATURE };

function act(intent: IntentOf<'mergein.prepare'>): void {
  const { worktree, branch, old, integrationTip, merge } = intent.expect;
  crashPoint('mergein.act-start', parentUnit(intent.parent));
  const state = classifyMergein(intent);
  if (state.kind !== 'untouched') throw new MergeinStateError(worktree, `act on a worktree that is ${state.kind}${state.kind === 'foreign' ? ` (${state.detail})` : ''}`);
  if (merge.type === 'clean') {
    if (intent.post.type !== 'clean-merged') throw new MergeinStateError(worktree, 'a clean merge recorded without its new id');
    const next = intent.post.new;
    const made = commitTree(worktree, merge.commit);
    if (made !== next) throw new MergeinStateError(worktree, `commit ${made}, recorded ${next}`);
    crashPoint('mergein.after-commit-tree', parentUnit(intent.parent));
    updateRefCas(worktree, branch, next, old);
    crashPoint('mergein.after-cas', parentUnit(intent.parent));
    finishCleanMerge(worktree, old, next);
  } else {
    // Exit 1 is the expected conflict; the recorded conflict set is checked by verify.
    gitRun(worktree, ['merge', '--no-commit', '--no-ff', integrationTip], { okCodes: [0, 1], identity: MERGE_IDENTITY });
    crashPoint('mergein.after-merge', parentUnit(intent.parent));
  }
  crashPoint('mergein.act-end', parentUnit(intent.parent));
}

function verify(intent: IntentOf<'mergein.prepare'>): OpOutcome['mergein.prepare'] {
  const state = classifyMergein(intent);
  if (intent.post.type === 'clean-merged' && state.kind === 'clean-merged' && state.indexAt === 'new') {
    const dirty = statusPorcelainV2Z(intent.expect.worktree, false);
    if (dirty.length > 0) throw new MergeinStateError(intent.expect.worktree, `status not clean after the merge: ${dirty.map((s) => s.path).join(', ')}`);
    return { kind: 'clean-merged' };
  }
  if (intent.post.type === 'conflicted' && state.kind === 'conflicted') return { kind: 'conflicted' };
  throw new MergeinStateError(intent.expect.worktree, `postcondition ${intent.post.type} not met: ${state.kind}${state.kind === 'foreign' ? ` (${state.detail})` : ''}`);
}

export function mergeinSteps(repo: AbsPath): GitSteps<'mergein.prepare', MergeinRequest> {
  return {
    kind: 'mergein.prepare',
    prepare: async (request) => prepare(repo, request),
    act: async (intent) => act(intent),
    verify: async (intent) => verify(intent),
  };
}
