// Integrated tests of the git wrapper and plumbing helpers (src/git/git.ts) against real repositories.
import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sha } from '../src/core/ids.ts';
import {
  GitError, catFileType, commitTree, git as run, gitPath, lsTree, mergeBase, readTree, refTarget, revParse,
  statusPorcelainV2Z, symbolicHead, updateRefCas, worktreeAdd, worktreeList, worktreePrune, worktreeRemove, writeTreeFromIndex,
} from '../src/git/git.ts';
import { absPath, refName } from '../src/core/values.ts';
import { IDENTITY, baseRepo } from './fixtures/git-common.ts';
import { git, tmpDir, writeFiles } from './helpers/repo.ts';

const repo = () => baseRepo(join(tmpDir('git'), 'r'));

describe('git wrapper', () => {
  it('throws GitError with args, code and stderr', () => {
    const r = repo();
    assert.throws(() => run(r, ['rev-parse', '--verify', 'no-such-ref']), (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.deepEqual(err.args, ['rev-parse', '--verify', 'no-such-ref']);
      assert.equal(err.code, 128);
      assert.match(err.stderr, /Needed a single revision/);
      return true;
    });
  });

  it('refs: revParse, refTarget, updateRefCas against old and absent', () => {
    const r = repo();
    const main = revParse(r, 'main');
    const first = revParse(r, 'main~1');
    const ref = refName('refs/heads/x');
    assert.equal(refTarget(r, ref), null);
    updateRefCas(r, ref, first, 'absent');
    assert.equal(refTarget(r, ref), first);
    assert.throws(() => updateRefCas(r, ref, main, 'absent'), GitError);
    assert.throws(() => updateRefCas(r, ref, main, main), GitError, 'a stale old refuses');
    updateRefCas(r, ref, main, first);
    assert.equal(refTarget(r, ref), main);
    assert.equal(mergeBase(r, main, first), first);
    assert.equal(catFileType(r, main), 'commit');
    assert.equal(catFileType(r, 'f'.repeat(40)), null);
  });

  it('commitTree is deterministic in its recorded inputs and ignores config identity', () => {
    const r = repo();
    const main = revParse(r, 'main');
    const tree = revParse(r, 'main^{tree}');
    const inputs = { tree, parents: [main], author: IDENTITY.author, committer: IDENTITY.committer, message: 'm\n', gpgsign: false } as const;
    const a = commitTree(r, inputs);
    git(r, 'config', 'user.name', 'Someone Else');
    assert.equal(commitTree(r, inputs), a);
    assert.equal(git(r, 'log', '-1', '--format=%an <%ae> %at|%cn %ct', a), 'Roadmap Executor <executor@roadmap.invalid> 1767225600|Roadmap Executor 1767225660');
    assert.equal(git(r, 'cat-file', '-p', a).endsWith('\n\nm'), true);
  });

  it('a temporary index: readTree, writeTreeFromIndex, lsTree, gitPath', () => {
    const r = repo();
    const index = absPath(join(tmpDir('git-index'), 'index'));
    copyFileSync(gitPath(r, 'index'), index);
    readTree(r, revParse(r, 'main~1'), index);
    assert.equal(writeTreeFromIndex(r, index), revParse(r, 'main~1^{tree}'));
    assert.equal(writeTreeFromIndex(r, gitPath(r, 'index')), revParse(r, 'main^{tree}'), 'the real index is untouched');
    assert.deepEqual(lsTree(r, 'main').map((e) => e.path), ['.gitignore', 'docs/readme.md', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('statusPorcelainV2Z: changed, untracked, ignored, unrenamed, paths with spaces', () => {
    const r = repo();
    git(r, 'mv', 'src/b.ts', 'src/moved b.ts');
    writeFiles(r, { 'src/a.ts': 'changed\n', 'new file.txt': 'n\n', 'x.log': 'l\n' });
    const status = statusPorcelainV2Z(r, true);
    assert.deepEqual(status, [
      { type: 'changed', x: '.', y: 'M', path: 'src/a.ts' },
      { type: 'changed', x: 'D', y: '.', path: 'src/b.ts' },
      { type: 'changed', x: 'A', y: '.', path: 'src/moved b.ts' },
      { type: 'untracked', path: 'new file.txt' },
      { type: 'ignored', path: 'x.log' },
    ]);
    assert.equal(statusPorcelainV2Z(r, false).some((s) => s.type === 'ignored'), false);
  });

  it('worktrees: add (new branch, existing branch, detached), list, remove, prune', () => {
    const r = repo();
    const root = tmpDir('git-wt');
    const main = revParse(r, 'main');
    const a = absPath(join(root, 'a'));
    const b = absPath(join(root, 'b'));
    const d = absPath(join(root, 'd'));
    worktreeAdd(r, a, { type: 'new-branch', branch: refName('refs/heads/a'), at: main });
    git(r, 'branch', 'b', 'main~1');
    worktreeAdd(r, b, { type: 'existing-branch', branch: refName('refs/heads/b') });
    worktreeAdd(r, d, { type: 'detached', at: main });
    assert.equal(symbolicHead(a), 'refs/heads/a');
    assert.equal(symbolicHead(d), null);
    const list = worktreeList(r);
    assert.deepEqual(list.slice(1), [
      { path: a, head: main, branch: 'refs/heads/a', prunable: false },
      { path: b, head: sha(revParse(r, 'main~1')), branch: 'refs/heads/b', prunable: false },
      { path: d, head: main, branch: null, prunable: false },
    ]);
    writeFileSync(join(a, 'dirty'), 'x');
    worktreeRemove(r, a);
    worktreePrune(r);
    assert.equal(worktreeList(r).length, 3);
    assert.equal(refTarget(r, refName('refs/heads/a')), main, 'removal keeps the branch');
  });
});
