// `docs.commit` (M3 step A4; DESIGN-1.0.md §2.9, §9; plan "Docs publication"): in the integration slot, a docs
// publication's one commit on the integration tip T: the executor-rendered `.roadmap/` files and the contract ops'
// edited documents, held on the executor-owned ref `refs/roadmap-run/<arc>/docs/<pub>`. Its lanes run on it and, on
// green, integration fast-forwards to exactly this commit (ff.ts, subject `docs{pub}`), so the tested head is the
// published head, as for a unit candidate.
//
// `planDocs` builds the tree before any intent: T's tree with every file of the request written (a new blob, the
// existing mode kept, 100644 for a new path), through a private index. The intent records every commit input (tree,
// parents [T], identity, dates, message), so a redo makes the same id; act re-makes the commit and CASes the ref from
// its recorded old (or absence). The detached docs checkout is a separate `worktree.create` op the caller runs once
// this op is done (`docsWorktreeRequest`).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { CommitInputs, IntentOf, OpOutcome } from '../core/events.ts';
import { type ArcId, type JobId, type Sha, sha } from '../core/ids.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import { type AbsPath, type RefName, type RepoPath, absPath, refName, repoPath } from '../core/values.ts';
import { type Identity, commitTree, git, readTree, refTarget, updateRefCas, writeTreeFromIndex } from './git.ts';
import { parentsOf } from './mergein.ts';
import type { WorktreeCreateRequest } from './worktree.ts';

export class DocsCommitStateError extends Error {
  constructor(ref: RefName, detail: string) {
    super(`docs.commit ${ref}: ${detail}`);
    this.name = 'DocsCommitStateError';
  }
}

export const docsRef = (arc: ArcId, pub: JobId): RefName => refName(`refs/roadmap-run/${arc}/docs/${pub}`);

/** One file a docs publication writes: a rendered `.roadmap/` document, or a document its contract ops edited. */
export type DocsFile = Readonly<{ path: RepoPath; bytes: Buffer }>;

export type DocsRequest = Readonly<{
  arc: ArcId;
  pub: JobId;
  /** The integration tip the files were built against: the commit's one parent. */
  tip: Sha;
  files: readonly DocsFile[];
  /** Where the caller will create the detached docs checkout. */
  worktree: AbsPath;
  identity: Identity;
  message: string;
}>;

export type DocsPlan = Readonly<{ request: DocsRequest; tree: Sha }>;

/** The mode of `path` in `tree`, or null when absent. */
function modeAt(repo: AbsPath, tree: Sha, path: RepoPath): string | null {
  const out = git(repo, ['ls-tree', '-z', tree, '--', path]);
  if (out === '') return null;
  const mode = out.slice(0, out.indexOf(' '));
  if (mode === '040000' || mode === '160000') throw new Error(`${path} is a ${mode === '040000' ? 'directory' : 'submodule'} at ${tree}: a docs publication writes files`);
  return mode;
}

/** T's tree with every file of the request written: the tree the docs commit records. */
export function planDocs(repo: AbsPath, request: DocsRequest): DocsPlan {
  const paths = request.files.map((f) => f.path);
  if (new Set(paths).size !== paths.length) throw new Error(`docs publication ${request.pub} writes a path twice: ${paths.join(', ')}`);
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-docs-'));
  try {
    const index = absPath(join(dir, 'index'));
    readTree(repo, request.tip, index);
    for (const f of request.files) {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: f.bytes }).trim();
      const mode = modeAt(repo, request.tip, f.path) ?? '100644';
      git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${f.path}`], { indexFile: index });
    }
    return { request, tree: writeTreeFromIndex(repo, index) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function prepare(repo: AbsPath, plan: DocsPlan): IntentBody<'docs.commit'> {
  const { request, tree } = plan;
  const ref = docsRef(request.arc, request.pub);
  const commit: CommitInputs<readonly [Sha]> = {
    tree, parents: [request.tip], author: request.identity.author, committer: request.identity.committer, message: request.message, gpgsign: false,
  };
  return {
    expect: { ref, old: refTarget(repo, ref), pub: request.pub, integrationTip: request.tip, worktree: request.worktree, commit },
    post: { new: commitTree(repo, commit) },
  };
}

function act(repo: AbsPath, intent: IntentOf<'docs.commit'>): void {
  const { ref, old, commit } = intent.expect;
  const next = intent.post.new;
  crashPoint('docs.act-start');
  const at = refTarget(repo, ref);
  if (at !== old) throw new DocsCommitStateError(ref, `at ${at ?? 'nothing'}, recorded old ${old ?? 'absent'}`);
  const made = commitTree(repo, commit);
  if (made !== next) throw new DocsCommitStateError(ref, `commit ${made}, recorded ${next}`);
  crashPoint('docs.after-commit-tree');
  updateRefCas(repo, ref, next, old ?? 'absent');
  crashPoint('docs.act-end');
}

/** null when the postcondition holds: ref = new, new's one parent T. */
export function docsPostcondition(repo: AbsPath, intent: IntentOf<'docs.commit'>): string | null {
  const { ref, integrationTip } = intent.expect;
  const next = intent.post.new;
  const at = refTarget(repo, ref);
  if (at !== next) return `${ref} at ${at ?? 'nothing'}, expected ${next}`;
  const parents = parentsOf(repo, next);
  if (parents.join(' ') !== integrationTip) return `${next} has parents ${parents.join(', ')}, expected [${integrationTip}]`;
  return null;
}

function verify(repo: AbsPath, intent: IntentOf<'docs.commit'>): OpOutcome['docs.commit'] {
  const problem = docsPostcondition(repo, intent);
  if (problem !== null) throw new DocsCommitStateError(intent.expect.ref, problem);
  return { kind: 'committed' };
}

/** The detached docs checkout at the new commit, for the caller's `worktree.create` op. */
export function docsWorktreeRequest(intent: IntentOf<'docs.commit'>): WorktreeCreateRequest {
  return { path: intent.expect.worktree, checkout: { type: 'detached', at: intent.post.new } };
}

/** The tree id of a commit: what a witness record's `treeSha` names (the fake witness lanes key on it too). */
export const treeOf = (repo: AbsPath, commit: Sha): Sha => sha(git(repo, ['rev-parse', '--verify', `${commit}^{tree}`]).trim());

/** The paths `a..b` adds, modifies or deletes, ascending. */
export function changedPaths(repo: AbsPath, a: Sha, b: Sha): readonly RepoPath[] {
  return git(repo, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', a, b]).split('\0').filter((s) => s !== '').map((p) => repoPath(p)).sort();
}

export function docsCommitSteps(repo: AbsPath): GitSteps<'docs.commit', DocsPlan> {
  return {
    kind: 'docs.commit',
    prepare: async (plan) => prepare(repo, plan),
    act: async (intent) => act(repo, intent),
    verify: async (intent) => verify(repo, intent),
  };
}
