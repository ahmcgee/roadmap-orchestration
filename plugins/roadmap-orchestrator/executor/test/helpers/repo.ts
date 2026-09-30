// Real git repositories and temporary directories for integrated tests.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Temporary directories are removed when this test process exits cleanly. node --test runs each test
// file in its own process and exits it non-zero when any test failed, so a failing file keeps every
// directory it made for inspection and says where they are. The exit hook is registered on first use,
// so child processes that merely import a helper register nothing.
const created: string[] = [];
let cleanupRegistered = false;

export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `roadmap-${prefix}-`));
  created.push(dir);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on('exit', (code) => {
      if (code === 0) for (const d of created) rmSync(d, { recursive: true, force: true });
      else process.stderr.write(`kept test directories:\n${created.join('\n')}\n`);
    });
  }
  return dir;
}

// Isolate from the developer's global and system git config (hooks, signing, templates).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** Run git in `repo`; throws with stderr on a non-zero exit. Returns trimmed stdout. */
export function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${repo} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** File contents by repo-relative path; `null` deletes the file. */
export type FileSet = Readonly<Record<string, string | null>>;

export interface CommitSpec {
  readonly message: string;
  readonly files: FileSet;
}

export interface RepoSpec {
  /** Committed as the first commit, message "initial". */
  readonly files: FileSet;
  /** Further commits, applied in order after the initial one. */
  readonly commits?: readonly CommitSpec[];
}

export function writeFiles(repo: string, files: FileSet): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    if (content === null) {
      rmSync(full);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Stage everything and commit; returns the new commit id. */
export function commitAll(repo: string, message: string): string {
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--message', message);
  return revParse(repo, 'HEAD');
}

export function revParse(repo: string, ref: string): string {
  return git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
}

/** Initialise `dir` as a repo on `main` with a fixed identity and the requested history. Returns `dir`. */
export function makeRepo(dir: string, spec: RepoSpec): string {
  mkdirSync(dir, { recursive: true });
  git(dir, '-c', 'init.defaultBranch=main', 'init', '--quiet');
  git(dir, 'config', 'user.name', 'Roadmap Test');
  git(dir, 'config', 'user.email', 'roadmap-test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'init.defaultBranch', 'main');
  writeFiles(dir, spec.files);
  commitAll(dir, 'initial');
  for (const commit of spec.commits ?? []) {
    writeFiles(dir, commit.files);
    commitAll(dir, commit.message);
  }
  return dir;
}

/**
 * The tree id of `dir`'s working tree as it stands (tracked and untracked, not ignored): what a lane run there
 * would be witnessed on. Built in a scratch index, so neither the index nor the worktree is touched.
 */
export function worktreeTree(dir: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'roadmap-tree-'));
  try {
    const env = { ...gitEnv, GIT_INDEX_FILE: join(scratch, 'index') };
    const run = (...args: string[]): string => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir} exited ${r.status}: ${r.stderr.trim()}`);
      return r.stdout.trim();
    };
    run('add', '--all');
    return run('write-tree');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
