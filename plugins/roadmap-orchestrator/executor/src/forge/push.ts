// Pushing an arc's integration branch to `origin` (M4a, OR-Q19): a CLI act of `roadmap pr`, outside the executor (R22).
// Unlike src/git/git.ts (the executor's sealed git), this runs with the user's environment, since a push needs their
// credential helper or SSH agent.
//
// Rules: never a push to `main` (the owner merges the stack, OR-L5); the remote branch may only fast-forward to the
// arc's head (a remote tip that is not an ancestor of it is someone else's work and is refused, never overwritten); the
// push carries an explicit lease on the tip it read (`--force-with-lease=refs/heads/<b>:<sha|empty>`), so a branch
// that moves between the read and the push is refused by the remote rather than clobbered. Re-running when the remote
// already holds the head pushes nothing.
import { spawnSync } from 'node:child_process';
import { type Sha, sha } from '../core/ids.ts';
import type { AbsPath, BranchName } from '../core/values.ts';

export const MAIN_BRANCH = 'main';
export const REMOTE = 'origin';
/** A push or a remote read may cross the network; bounded all the same. */
export const PUSH_TIMEOUT_MS = 300_000;

export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushError';
  }
}

type Run = Readonly<{ status: number; stdout: string; stderr: string }>;

function userGit(repo: AbsPath, args: readonly string[]): Run {
  const r = spawnSync('git', ['-C', repo, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, encoding: 'utf8', timeout: PUSH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) throw new PushError(`git ${args.join(' ')}: ${r.error.message}`);
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function must(repo: AbsPath, args: readonly string[]): string {
  const r = userGit(repo, args);
  if (r.status !== 0) throw new PushError(`git ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The tip `origin` holds for `branch`, or null when it has none. */
export function remoteTip(repo: AbsPath, branch: BranchName): Sha | null {
  const ref = `refs/heads/${branch}`;
  const hit = must(repo, ['ls-remote', REMOTE, ref]).split('\n').map((l) => l.split('\t')).find(([, name]) => name === ref);
  return hit === undefined ? null : sha(hit[0] ?? '', `ls-remote ${REMOTE} ${ref}`);
}

const refuseMain = (branch: BranchName): void => {
  if (branch === MAIN_BRANCH) throw new PushError(`refusing to push ${MAIN_BRANCH}: the owner merges the stack; roadmap never pushes ${MAIN_BRANCH}`);
};

/** One push of `head` to `origin`'s `branch`, leased on `expected` (null: the branch must not exist there). */
export function pushWithLease(repo: AbsPath, branch: BranchName, head: Sha, expected: Sha | null): void {
  refuseMain(branch);
  must(repo, ['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${expected ?? ''}`, REMOTE, `${head}:refs/heads/${branch}`]);
}

/**
 * Whether `head` is in the history of `commit`, a commit `origin` holds (fetched by id first): how `roadmap pr` tells
 * a merge-commit merge of a stacked PR (the arc's head reachable from the merge) from a squash or rebase merge (not).
 */
export function inHistoryOnOrigin(repo: AbsPath, head: Sha, commit: Sha): boolean {
  must(repo, ['fetch', '--quiet', '--no-tags', REMOTE, commit]);
  return isAncestor(repo, head, commit);
}

function isAncestor(repo: AbsPath, a: Sha, b: Sha): boolean {
  const r = userGit(repo, ['merge-base', '--is-ancestor', a, b]);
  if (r.status !== 0 && r.status !== 1) throw new PushError(`git merge-base --is-ancestor ${a} ${b} exited ${r.status}: ${r.stderr.trim()}`);
  return r.status === 0;
}

export type PushOutcome = Readonly<{ kind: 'pushed'; previous: Sha | null }> | Readonly<{ kind: 'up-to-date' }>;

/** Brings `origin`'s `branch` to `head` by a leased fast-forward (or creation); refuses `main` and a diverged remote. */
export function pushBranch(repo: AbsPath, branch: BranchName, head: Sha): PushOutcome {
  refuseMain(branch);
  const tip = remoteTip(repo, branch);
  if (tip === head) return { kind: 'up-to-date' };
  if (tip !== null) {
    const known = userGit(repo, ['cat-file', '-e', `${tip}^{commit}`]).status === 0;
    const ancestor = known && isAncestor(repo, tip, head);
    if (!ancestor) throw new PushError(`${REMOTE}'s ${branch} is at ${tip}, which is not in the history of ${head}: refusing to overwrite it`);
  }
  pushWithLease(repo, branch, head, tip);
  return { kind: 'pushed', previous: tip };
}
