import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitAll, git, makeRepo, revParse, tmpDir, writeFiles } from './helpers/repo.ts';

test('repo.make-with-commits', () => {
  const repo = makeRepo(join(tmpDir('repo'), 'r'), {
    files: { 'README.md': 'hi\n', 'src/a.txt': 'a\n' },
    commits: [
      { message: 'add b', files: { 'src/b.txt': 'b\n' } },
      { message: 'drop a', files: { 'src/a.txt': null } },
    ],
  });
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '3');
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(repo, 'log', '--format=%s', '-n', '3'), 'drop a\nadd b\ninitial');
  assert.equal(git(repo, 'log', '-1', '--format=%an <%ae>'), 'Roadmap Test <roadmap-test@example.invalid>');
  assert.equal(existsSync(join(repo, 'src/a.txt')), false);
  assert.equal(readFileSync(join(repo, 'src/b.txt'), 'utf8'), 'b\n');
  assert.equal(git(repo, 'status', '--porcelain'), '');

  const head = revParse(repo, 'HEAD');
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(revParse(repo, 'main'), head);
  assert.equal(revParse(repo, 'HEAD~1'), git(repo, 'rev-parse', 'HEAD^'));

  writeFiles(repo, { 'c.txt': 'c\n' });
  const next = commitAll(repo, 'add c');
  assert.equal(revParse(repo, 'HEAD~1'), head);
  assert.equal(revParse(repo, 'HEAD'), next);
});

test('repo.git-throws-with-stderr', () => {
  const repo = makeRepo(join(tmpDir('repo'), 'r'), { files: { f: 'x' } });
  assert.throws(() => revParse(repo, 'no-such-ref'), /git rev-parse .* exited 128: fatal/);
});
