// `worktree.create` and `worktree.remove`. A unit's worktree is created on its own branch at a recorded
// start; a verification tree is created detached. Removal requires a verified evidence manifest (the
// request type cannot be built without one) and never deletes a branch: branches and salvage survive
// every cleanup path.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, OpOutcome, WorktreeCheckout } from '../core/events.ts';
import type { Sha } from '../core/ids.ts';
import type { GitOp, IntentBody } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { reconcileWorktreeCreate, reconcileWorktreeRemove } from '../recover/worktree.ts';
import type { CapturedEvidence } from './evidence.ts';
import {
  catFileType, gitCommonDir, refTarget, revParse, statusPorcelainV2Z, symbolicHead, worktreeAdd, worktreeList,
  worktreePrune, worktreeRemove,
} from './git.ts';

export class WorktreeStateError extends Error {
  readonly path: AbsPath;
  constructor(path: AbsPath, detail: string) {
    super(`worktree ${path}: ${detail}`);
    this.name = 'WorktreeStateError';
    this.path = path;
  }
}

export type WorktreeInspection = Readonly<{ kind: 'ready'; head: Sha }> | Readonly<{ kind: 'not-ready'; problem: string }>;

/**
 * Re-reads a created worktree from git and the filesystem: the path is a directory whose `.git` file
 * links to an admin dir under the common dir's `worktrees/` that links back, git lists it, HEAD is the
 * recorded start on the recorded branch (or detached), and its status is clean.
 */
export function inspectWorktree(repo: AbsPath, expect: IntentOf<'worktree.create'>['expect']): WorktreeInspection {
  const { path, checkout } = expect;
  const notReady = (problem: string): WorktreeInspection => ({ kind: 'not-ready', problem });
  if (!existsSync(path) || !lstatSync(path).isDirectory()) return notReady('path missing');
  const dotGit = join(path, '.git');
  if (!existsSync(dotGit) || !lstatSync(dotGit).isFile()) return notReady('no .git file');
  const link = /^gitdir: (.+)\n?$/.exec(readFileSync(dotGit, 'utf8'));
  if (link === null) return notReady('.git is not a gitdir link');
  const admin = link[1]!;
  if (dirname(admin) !== join(gitCommonDir(repo), 'worktrees')) return notReady(`.git links to ${admin}, outside this repo's worktrees/`);
  const back = join(admin, 'gitdir');
  if (!existsSync(back) || readFileSync(back, 'utf8').trim() !== dotGit) return notReady(`admin dir ${admin} does not link back`);
  if (!worktreeList(repo).some((e) => e.path === path)) return notReady('not listed by git worktree list');
  const head = revParse(path, 'HEAD');
  if (head !== checkout.at) return notReady(`HEAD ${head}, expected ${checkout.at}`);
  const attached = symbolicHead(path);
  if (checkout.type === 'branch' && attached !== checkout.branch) return notReady(`HEAD on ${attached ?? 'detached'}, expected ${checkout.branch}`);
  if (checkout.type === 'detached' && attached !== null) return notReady(`HEAD on ${attached}, expected detached`);
  if (statusPorcelainV2Z(path, false).length > 0) return notReady('status not clean');
  return { kind: 'ready', head };
}

export type WorktreeCreateRequest = Readonly<{ path: AbsPath; checkout: WorktreeCheckout }>;

/** `request.checkout.at` must name a commit; a new branch must not exist yet, an existing one must be at `at`. */
function prepareCreate(repo: AbsPath, request: WorktreeCreateRequest): IntentBody<'worktree.create'> {
  const { path, checkout } = request;
  if (existsSync(path)) throw new WorktreeStateError(path, 'already exists');
  if (catFileType(repo, checkout.at) !== 'commit') throw new WorktreeStateError(path, `start ${checkout.at} is not a commit`);
  if (checkout.type === 'branch') {
    const current = refTarget(repo, checkout.branch);
    if (checkout.createBranch && current !== null) throw new WorktreeStateError(path, `branch ${checkout.branch} already exists`);
    if (!checkout.createBranch && current !== checkout.at) throw new WorktreeStateError(path, `branch ${checkout.branch} is at ${current}, expected ${checkout.at}`);
  }
  return { expect: { path, checkout }, post: null };
}

function actCreate(repo: AbsPath, intent: IntentOf<'worktree.create'>): void {
  const { path, checkout } = intent.expect;
  crashPoint('worktree.create.act-start');
  if (checkout.type === 'detached') {
    worktreeAdd(repo, path, { type: 'detached', at: checkout.at });
  } else {
    // A redo after a partial add may find the branch this intent created: it is still at the recorded
    // start (the reconciler parks otherwise), so check it out rather than create it again.
    const current = refTarget(repo, checkout.branch);
    if (current === null) {
      if (!checkout.createBranch) throw new WorktreeStateError(path, `branch ${checkout.branch} vanished`);
      worktreeAdd(repo, path, { type: 'new-branch', branch: checkout.branch, at: checkout.at });
    } else {
      if (current !== checkout.at) throw new WorktreeStateError(path, `branch ${checkout.branch} moved to ${current}`);
      worktreeAdd(repo, path, { type: 'existing-branch', branch: checkout.branch });
    }
  }
  crashPoint('worktree.add.inside');
}

function verifyCreate(repo: AbsPath, intent: IntentOf<'worktree.create'>): OpOutcome['worktree.create'] {
  const inspection = inspectWorktree(repo, intent.expect);
  if (inspection.kind !== 'ready') throw new WorktreeStateError(intent.expect.path, inspection.problem);
  return { kind: 'created', head: inspection.head };
}

export function worktreeCreateOp(repo: AbsPath): GitOp<'worktree.create', WorktreeCreateRequest> {
  return {
    kind: 'worktree.create',
    prepare: async (request) => prepareCreate(repo, request),
    act: async (intent) => actCreate(repo, intent),
    verify: async (intent) => verifyCreate(repo, intent),
    reconcile: reconcileWorktreeCreate(repo),
  };
}

// ---------------------------------------------------------------------------------------------------
// Removal

/** A removal names its worktree and the done evidence snapshot that preserved what it produced. */
export type WorktreeRemoveRequest = Readonly<{ path: AbsPath; evidence: CapturedEvidence }>;

/** True when git lists no worktree at `path` and nothing exists there. */
export function worktreeGone(repo: AbsPath, path: AbsPath): boolean {
  return !existsSync(path) && !worktreeList(repo).some((e) => e.path === path);
}

function prepareRemove(repo: AbsPath, request: WorktreeRemoveRequest): IntentBody<'worktree.remove'> {
  const entries = worktreeList(repo);
  if (entries[0]?.path === request.path) throw new WorktreeStateError(request.path, 'is the main worktree');
  if (!entries.some((e) => e.path === request.path)) throw new WorktreeStateError(request.path, 'is not a worktree of this repo');
  return { expect: { path: request.path, evidence: request.evidence.op }, post: null };
}

function actRemove(repo: AbsPath, intent: IntentOf<'worktree.remove'>): void {
  const { path } = intent.expect;
  crashPoint('worktree.remove.act-start');
  if (worktreeList(repo).some((e) => e.path === path)) worktreeRemove(repo, path);
  crashPoint('worktree.remove.inside');
  worktreePrune(repo);
}

function verifyRemove(repo: AbsPath, intent: IntentOf<'worktree.remove'>): OpOutcome['worktree.remove'] {
  if (!worktreeGone(repo, intent.expect.path)) throw new WorktreeStateError(intent.expect.path, 'still present after removal');
  return { kind: 'removed' };
}

export function worktreeRemoveOp(repo: AbsPath): GitOp<'worktree.remove', WorktreeRemoveRequest> {
  return {
    kind: 'worktree.remove',
    prepare: async (request) => prepareRemove(repo, request),
    act: async (intent) => actRemove(repo, intent),
    verify: async (intent) => verifyRemove(repo, intent),
    reconcile: reconcileWorktreeRemove(repo),
  };
}
