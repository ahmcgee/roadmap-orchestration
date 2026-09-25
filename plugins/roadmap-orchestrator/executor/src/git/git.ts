// The executor's one way to run git, and the plumbing every git op builds on.
//
// Every call runs with a fixed, minimal environment: no global or system config (so a developer's hooks,
// signing or templates never leak in), `commit.gpgsign=false` (deterministic commits, R7), hooks disabled
// (a product repo's post-checkout hook must not run inside `worktree add`), and the C locale. A commit
// identity is never read from config: callers that create commits pass the intent's recorded author and
// committer, so the same inputs always give the same object id.
import { spawnSync } from 'node:child_process';
import type { CommitInputs, Signature } from '../core/events.ts';
import { type Sha, sha } from '../core/ids.ts';
import { type AbsPath, type RefName, type RepoPath, absPath, refName, repoPath } from '../core/values.ts';

export class GitError extends Error {
  readonly args: readonly string[];
  readonly code: number | null;
  readonly stderr: string;
  constructor(args: readonly string[], code: number | null, stderr: string) {
    super(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export type Identity = Readonly<{ author: Signature; committer: Signature }>;

export type GitOptions = Readonly<{
  /** Author and committer for commands that create commits. */
  identity?: Identity;
  /** A temporary index (`GIT_INDEX_FILE`) instead of the worktree's own. */
  indexFile?: AbsPath;
  input?: string | Uint8Array;
  /** Exit codes that are answers rather than failures (e.g. `rev-parse --verify -q` → 1). Default `[0]`. */
  okCodes?: readonly number[];
}>;

export type GitResult = Readonly<{ code: number; stdout: string }>;

const FIXED_CONFIG = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function environment(opts: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
  if (opts.indexFile !== undefined) env['GIT_INDEX_FILE'] = opts.indexFile;
  if (opts.identity !== undefined) {
    const { author, committer } = opts.identity;
    Object.assign(env, {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: committer.date,
    });
  }
  return env;
}

/** Runs `git -C <repo> <args>`; throws GitError unless the exit code is in `okCodes`. */
export function gitRun(repo: AbsPath, args: readonly string[], opts: GitOptions = {}): GitResult {
  const full = ['-C', repo, ...FIXED_CONFIG, ...args];
  const r = spawnSync('git', full, { env: environment(opts), input: opts.input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error !== undefined) throw r.error;
  const ok = opts.okCodes ?? [0];
  if (r.status === null || !ok.includes(r.status)) throw new GitError(args, r.status, r.stderr);
  return { code: r.status, stdout: r.stdout };
}

/** Runs git and returns its stdout, untrimmed. */
export function git(repo: AbsPath, args: readonly string[], opts: GitOptions = {}): string {
  return gitRun(repo, args, opts).stdout;
}

const line = (out: string): string => out.replace(/\n$/, '');

// ---------------------------------------------------------------------------------------------------
// Objects and refs

/** The commit (or other object, with `^{...}` in `rev`) a revision names; throws if it names none. */
export function revParse(repo: AbsPath, rev: string): Sha {
  return sha(line(git(repo, ['rev-parse', '--verify', '--end-of-options', rev])));
}

/** The object a ref points at, or null when the ref does not exist. */
export function refTarget(repo: AbsPath, ref: RefName): Sha | null {
  const r = gitRun(repo, ['rev-parse', '--verify', '-q', '--end-of-options', ref], { okCodes: [0, 1] });
  return r.code === 0 ? sha(line(r.stdout)) : null;
}

/** `update-ref <ref> <new> <old>`: moves the ref only if it still points at `old` (`absent`: does not exist). */
export function updateRefCas(repo: AbsPath, ref: RefName, next: Sha, old: Sha | 'absent'): void {
  git(repo, ['update-ref', ref, next, old === 'absent' ? '0'.repeat(40) : old]);
}

/** `write-tree` from the given index file. */
export function writeTreeFromIndex(repo: AbsPath, indexFile: AbsPath): Sha {
  return sha(line(git(repo, ['write-tree'], { indexFile })));
}

/**
 * `commit-tree` from recorded inputs only: tree, parents, author and committer with their dates, and the
 * message given verbatim on stdin. The same inputs always give the same id.
 */
export function commitTree(repo: AbsPath, inputs: CommitInputs<readonly Sha[]>): Sha {
  const args = ['commit-tree', inputs.tree, ...inputs.parents.flatMap((p) => ['-p', p]), '-F', '-'];
  return sha(line(git(repo, args, { identity: { author: inputs.author, committer: inputs.committer }, input: inputs.message })));
}

/** `read-tree <tree>` into the worktree's index (or `indexFile`); the worktree files are not touched. */
export function readTree(repo: AbsPath, tree: Sha, indexFile?: AbsPath): void {
  git(repo, ['read-tree', tree], indexFile === undefined ? {} : { indexFile });
}

/** The branch a worktree's HEAD is attached to, or null when HEAD is detached. */
export function symbolicHead(worktree: AbsPath): RefName | null {
  const r = gitRun(worktree, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] });
  return r.code === 0 ? refName(line(r.stdout)) : null;
}

export function mergeBase(repo: AbsPath, a: Sha, b: Sha): Sha | null {
  const r = gitRun(repo, ['merge-base', a, b], { okCodes: [0, 1] });
  return r.code === 0 ? sha(line(r.stdout)) : null;
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** The type of an object, or null when the repository does not have it. */
export function catFileType(repo: AbsPath, object: string): ObjectType | null {
  const r = gitRun(repo, ['cat-file', '-t', object], { okCodes: [0, 128] });
  if (r.code !== 0) return null;
  const t = line(r.stdout);
  if (t !== 'commit' && t !== 'tree' && t !== 'blob' && t !== 'tag') throw new Error(`cat-file -t ${object}: unknown type ${t}`);
  return t;
}

export type TreeEntry = Readonly<{ mode: string; type: 'blob' | 'tree' | 'commit'; object: Sha; path: RepoPath }>;

/** `ls-tree -r -z <tree>`: every blob (and gitlink) in the tree, recursively. */
export function lsTree(repo: AbsPath, tree: string): readonly TreeEntry[] {
  return git(repo, ['ls-tree', '-r', '-z', tree]).split('\0').filter((s) => s !== '').map((rec) => {
    const m = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s.exec(rec);
    if (m === null) throw new Error(`ls-tree: unparsable entry ${JSON.stringify(rec)}`);
    return { mode: m[1]!, type: m[2] as TreeEntry['type'], object: sha(m[3]), path: repoPath(m[4]) };
  });
}

/** Absolute path of a file in the worktree's git dir (`rev-parse --git-path`), e.g. its `index`. */
export function gitPath(worktree: AbsPath, name: string): AbsPath {
  return absPath(line(git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', name])));
}

export function gitCommonDir(repo: AbsPath): AbsPath {
  return absPath(line(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
}

// ---------------------------------------------------------------------------------------------------
// Status

/**
 * One `status --porcelain=v2 -z` entry. Renames are never reported (`--no-renames`): a rename is a deletion
 * plus an addition, which is what salvage needs to classify each path on its own.
 */
export type StatusEntry =
  /** `1 XY ...`: a tracked path changed in the index (`x`) and/or the worktree (`y`); `.` = unchanged. */
  | Readonly<{ type: 'changed'; x: string; y: string; path: RepoPath }>
  /** `u XY ...`: an unmerged path (a conflict recorded in the index). */
  | Readonly<{ type: 'unmerged'; xy: string; path: RepoPath }>
  | Readonly<{ type: 'untracked'; path: RepoPath }>
  | Readonly<{ type: 'ignored'; path: RepoPath }>;

/** `status --porcelain=v2 -z --no-renames --untracked-files=all [--ignored]`, parsed. */
export function statusPorcelainV2Z(worktree: AbsPath, includeIgnored: boolean): readonly StatusEntry[] {
  const args = ['status', '--porcelain=v2', '-z', '--no-renames', '--untracked-files=all', includeIgnored ? '--ignored' : '--ignored=no'];
  return git(worktree, args).split('\0').filter((s) => s !== '').map(parseStatusRecord);
}

function parseStatusRecord(rec: string): StatusEntry {
  const tag = rec.slice(0, 2);
  // Directory entries (an ignored directory) end in `/`; RepoPath has no trailing slash.
  const path = (p: string): RepoPath => repoPath(p.replace(/\/$/, ''));
  switch (tag) {
    case '1 ': {
      // 1 XY sub mH mI mW hH hI path
      const parts = rec.split(' ');
      const xy = parts[1]!;
      return { type: 'changed', x: xy[0]!, y: xy[1]!, path: path(parts.slice(8).join(' ')) };
    }
    case 'u ': {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = rec.split(' ');
      return { type: 'unmerged', xy: parts[1]!, path: path(parts.slice(10).join(' ')) };
    }
    case '? ':
      return { type: 'untracked', path: path(rec.slice(2)) };
    case '! ':
      return { type: 'ignored', path: path(rec.slice(2)) };
    default:
      throw new Error(`status --porcelain=v2: unexpected record ${JSON.stringify(rec)}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Worktrees

export type WorktreeCheckoutArg =
  | Readonly<{ type: 'new-branch'; branch: RefName; at: Sha }>
  | Readonly<{ type: 'existing-branch'; branch: RefName }>
  | Readonly<{ type: 'detached'; at: Sha }>;

const shortBranch = (ref: RefName): string => {
  if (!ref.startsWith('refs/heads/')) throw new Error(`not a branch ref: ${ref}`);
  return ref.slice('refs/heads/'.length);
};

export function worktreeAdd(repo: AbsPath, path: AbsPath, checkout: WorktreeCheckoutArg): void {
  switch (checkout.type) {
    case 'new-branch':
      git(repo, ['worktree', 'add', '-b', shortBranch(checkout.branch), path, checkout.at]);
      return;
    case 'existing-branch':
      git(repo, ['worktree', 'add', path, shortBranch(checkout.branch)]);
      return;
    case 'detached':
      git(repo, ['worktree', 'add', '--detach', path, checkout.at]);
      return;
  }
}

/** `worktree remove --force`: discards the worktree's files and admin entry. Never touches branches. */
export function worktreeRemove(repo: AbsPath, path: AbsPath): void {
  git(repo, ['worktree', 'remove', '--force', path]);
}

export function worktreePrune(repo: AbsPath): void {
  git(repo, ['worktree', 'prune']);
}

export type WorktreeEntry = Readonly<{
  path: AbsPath;
  /** null for a bare main worktree. */
  head: Sha | null;
  branch: RefName | null;
  /** git's own note that the entry's path is gone (`prunable`). */
  prunable: boolean;
}>;

/** `worktree list --porcelain -z`, the main worktree first. */
export function worktreeList(repo: AbsPath): readonly WorktreeEntry[] {
  const out = git(repo, ['worktree', 'list', '--porcelain', '-z']);
  return out.split('\0\0').filter((s) => s !== '').map((block) => {
    let path: AbsPath | null = null;
    let head: Sha | null = null;
    let branch: RefName | null = null;
    let prunable = false;
    for (const attr of block.split('\0')) {
      const sp = attr.indexOf(' ');
      const [key, value] = sp === -1 ? [attr, ''] : [attr.slice(0, sp), attr.slice(sp + 1)];
      if (key === 'worktree') path = absPath(value);
      else if (key === 'HEAD') head = sha(value);
      else if (key === 'branch') branch = refName(value);
      else if (key === 'prunable') prunable = true;
    }
    if (path === null) throw new Error(`worktree list: entry without a path: ${JSON.stringify(block)}`);
    return { path, head, branch, prunable };
  });
}
