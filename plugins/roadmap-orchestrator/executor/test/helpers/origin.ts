// Bare origins for tests (M4a step 0b): a local bare repo standing in for a remote (the push, the PR heads, the corpus
// sources `other-repo` and `checkout`), and the merge a forge performs when a PR is merged.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type RepoSpec, git, makeRepo, tmpDir } from './repo.ts';

/** An empty bare repo with `main` as its initial branch. Returns its path. */
export function makeBareOrigin(dir: string = tmpDir('origin')): string {
  mkdirSync(dir, { recursive: true });
  git(dir, '-c', 'init.defaultBranch=main', 'init', '--quiet', '--bare');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  return dir;
}

/** Add `origin` to `repo` and push its branch `branch` (default `main`) to it. */
export function attachOrigin(repo: string, origin: string, branch = 'main'): void {
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', `${branch}:${branch}`);
}

/** A work repo made from `spec` with a bare origin holding its `main`: the shape of a corpus repo another repo points at. */
export function makeRepoWithOrigin(spec: RepoSpec): Readonly<{ work: string; origin: string }> {
  const work = makeRepo(tmpDir('work'), spec);
  const origin = makeBareOrigin();
  attachOrigin(work, origin);
  return { work, origin };
}

/** The sha `branch` has in `origin`, or null when it has none. */
export function originRef(origin: string, branch: string): string | null {
  try {
    return git(origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`);
  } catch {
    return null;
  }
}

/** Every branch of `origin` and its sha. */
export function originBranches(origin: string): Readonly<Record<string, string>> {
  const lines = git(origin, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads').split('\n').filter((l) => l !== '');
  return Object.fromEntries(lines.map((l) => l.split(' ') as [string, string]));
}

/**
 * Merge `head` into `base` on `origin` as a forge merges a PR, and return the new `base` sha. `merge`: a merge commit with
 * both parents; `squash`: one single-parent commit holding `head`'s changes, `head`'s commits unreachable from `base`.
 */
export function mergeOnOrigin(origin: string, base: string, head: string, method: 'merge' | 'squash'): string {
  const scratch = join(tmpDir('merge'), 'clone');
  git(origin, 'clone', '--quiet', origin, scratch);
  git(scratch, 'config', 'user.name', 'Forge');
  git(scratch, 'config', 'user.email', 'forge@example.invalid');
  git(scratch, 'config', 'commit.gpgsign', 'false');
  git(scratch, 'checkout', '--quiet', '-B', base, `origin/${base}`);
  if (method === 'merge') git(scratch, 'merge', '--quiet', '--no-ff', '--message', `Merge ${head} into ${base}`, `origin/${head}`);
  else {
    git(scratch, 'merge', '--quiet', '--squash', `origin/${head}`);
    git(scratch, 'commit', '--quiet', '--message', `Squash ${head} into ${base}`);
  }
  git(scratch, 'push', '--quiet', 'origin', `${base}:${base}`);
  return git(scratch, 'rev-parse', 'HEAD');
}
