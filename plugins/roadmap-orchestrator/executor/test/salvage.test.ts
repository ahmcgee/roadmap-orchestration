// Integrated tests of salvage.commit (src/git/salvage.ts, src/recover/salvage.ts): real git, real
// worktrees, crash cells in a child process killed at crashPoints. The plan's named salvage.* tests and the
// salvage.commit matrix row.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { type Sha, sha } from '../src/core/ids.ts';
import { SalvageUnmergedError, checkRejected, planSalvage, rejectedDir, salvagePostcondition } from '../src/git/salvage.ts';
import { type AbsPath, absPath, refName } from '../src/core/values.ts';
import { IDENTITY, baseRepo, cloneRepo, crashChild, openArc, recoverOp, rules, runOp } from './fixtures/git-common.ts';
import { git, tmpDir, writeFiles } from './helpers/repo.ts';
import { SALVAGE, crashCells } from './matrix.ts';
import { salvageCommitOp } from '../src/recover/ops.ts';

const BRANCH = refName('refs/heads/unit-a');
const MESSAGE = 'unit-a: salvage\n';

type Checkout = Readonly<{ repo: AbsPath; wt: AbsPath; runDir: string }>;

let base: string;
before(() => {
  base = baseRepo(join(tmpDir('salvage-base'), 'base'));
});

/** A fresh clone of the base repo with the unit worktree on branch unit-a at main. */
function checkout(): Checkout {
  const root = tmpDir('salvage');
  const repo = cloneRepo(base, join(root, 'repo'));
  const wt = absPath(join(root, 'wt'));
  git(repo, 'worktree', 'add', '--quiet', '-b', 'unit-a', wt, 'main');
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  return { repo, wt, runDir };
}

/**
 * What an implementer leaves behind. Approved (scope `src`): src/a.ts staged at one version then edited
 * again, src/new.ts pre-staged, src/b.ts deleted. Rejected: .roadmap/notes.md, docs/readme.md (out of
 * scope, tracked), docs/staged-out.md (out of scope, pre-staged), src/evidence/out.txt (declared
 * evidence). Ignored: build.log.
 */
function dirty(wt: string): void {
  writeFiles(wt, { 'src/a.ts': 'export const a = 5;\n' });
  git(wt, 'add', 'src/a.ts');
  writeFiles(wt, {
    'src/a.ts': 'export const a = 10;\n',
    'src/b.ts': null,
    'src/new.ts': 'export const n = 0;\n',
    'docs/readme.md': '# changed\n',
    'docs/staged-out.md': 'staged out\n',
    '.roadmap/notes.md': 'notes\n',
    'src/evidence/out.txt': 'out\n',
    'build.log': 'log\n',
  });
  git(wt, 'add', 'src/new.ts', 'docs/staged-out.md');
}

const request = (wt: AbsPath) => ({ worktree: wt, branch: BRANCH, identity: IDENTITY, message: MESSAGE });

async function salvage(c: Checkout): Promise<IntentOf<'salvage.commit'>> {
  const journal = openArc(c.runDir);
  const decision = planSalvage(rules(c.runDir), request(c.wt));
  assert.equal(decision.kind, 'commit');
  if (decision.kind !== 'commit') throw new Error('unreachable');
  const intent = await runOp(journal, salvageCommitOp(rules(c.runDir)), 'salvage:unit', decision.plan);
  journal.close();
  return intent;
}

const treeFiles = (repo: string, rev: string): string[] => git(repo, 'ls-tree', '-r', '--name-only', rev).split('\n');

/** The oracle for the scenario in `dirty`: one commit on old, the approved tree, rejected content preserved. */
function assertSalvaged(c: Checkout, intent: IntentOf<'salvage.commit'>, expectedSha: Sha): void {
  const next = intent.post.new;
  assert.equal(next, expectedSha, 'the same salvage SHA');
  assert.equal(salvagePostcondition(intent), null, 'branch = HEAD = new, index tree = new, status clean');
  assert.equal(git(c.repo, 'rev-list', '--count', `${intent.expect.old}..${next}`), '1', 'exactly one commit');
  assert.equal(git(c.repo, 'rev-parse', `${next}^`), intent.expect.old);
  assert.deepEqual(treeFiles(c.repo, next), ['.gitignore', 'docs/readme.md', 'src/a.ts', 'src/c.ts', 'src/new.ts']);
  assert.equal(git(c.repo, 'show', `${next}:src/a.ts`), 'export const a = 10;');
  assert.equal(git(c.repo, 'show', `${next}:docs/readme.md`), '# readme');
  // The worktree is exactly at the salvage commit, ignored files untouched.
  assert.equal(git(c.wt, 'status', '--porcelain=v2', '--untracked-files=all'), '');
  assert.equal(readFileSync(join(c.wt, 'docs/readme.md'), 'utf8'), '# readme\n');
  assert.equal(existsSync(join(c.wt, '.roadmap/notes.md')), false);
  assert.equal(existsSync(join(c.wt, 'docs/staged-out.md')), false);
  assert.equal(existsSync(join(c.wt, 'src/evidence/out.txt')), false);
  assert.equal(readFileSync(join(c.wt, 'build.log'), 'utf8'), 'log\n');
}

/** SHA of the scenario's salvage from a clean, uncrashed run: identical inputs by construction. */
async function controlSha(): Promise<Sha> {
  const c = checkout();
  dirty(c.wt);
  return (await salvage(c)).post.new;
}

describe('salvage', () => {
  it('salvage.pre-staged: staged content is committed with unstaged approved changes; staged rejected content is not', async () => {
    const c = checkout();
    dirty(c.wt);
    const intent = await salvage(c);
    assertSalvaged(c, intent, intent.post.new);
    assert.ok(treeFiles(c.repo, intent.post.new).includes('src/new.ts'), 'pre-staged approved file committed');
    assert.ok(!treeFiles(c.repo, intent.post.new).includes('docs/staged-out.md'), 'pre-staged rejected file not committed');
  });

  it('salvage.rejected-copied-out: rejected content is copied out with a manifest, then restored or removed', async () => {
    const c = checkout();
    dirty(c.wt);
    const intent = await salvage(c);
    const dir = rejectedDir(rules(c.runDir), intent.expect.rejectedManifestSha256);
    const copied = checkRejected(dir, intent.expect.rejectedManifestSha256);
    assert.equal(copied.kind, 'complete');
    if (copied.kind !== 'complete') return;
    assert.deepEqual(copied.manifest.entries.map((e) => [e.path, e.reason, e.tracked]), [
      ['.roadmap/notes.md', 'roadmap-dir', false],
      ['docs/readme.md', 'out-of-scope', true],
      ['docs/staged-out.md', 'out-of-scope', false],
      ['src/evidence/out.txt', 'excluded', false],
    ]);
    assert.equal(readFileSync(join(dir, 'files/.roadmap/notes.md'), 'utf8'), 'notes\n');
    assert.equal(readFileSync(join(dir, 'files/docs/readme.md'), 'utf8'), '# changed\n');
    assert.equal(readFileSync(join(dir, 'files/docs/staged-out.md'), 'utf8'), 'staged out\n');
    assert.equal(readFileSync(join(dir, 'files/src/evidence/out.txt'), 'utf8'), 'out\n');
    assert.equal(existsSync(join(dir, 'files/build.log')), false, 'ignored files are not rejected content');
    assertSalvaged(c, intent, intent.post.new);
  });

  it('salvage.index-reconciled: the tree is clean afterwards and the next salvage starts from the salvage commit', async () => {
    const c = checkout();
    dirty(c.wt);
    const first = await salvage(c);
    assert.equal(git(c.wt, 'diff', '--cached', '--name-only'), '', 'nothing staged');
    assert.equal(git(c.wt, 'diff', '--name-only'), '', 'nothing unstaged');
    writeFiles(c.wt, { 'src/a.ts': 'export const a = 11;\n' });
    const second = await salvage(c);
    assert.equal(second.expect.old, first.post.new);
    assert.deepEqual(second.expect.commit.parents, [first.post.new]);
    assert.equal(salvagePostcondition(second), null);
    assert.equal(git(c.repo, 'diff', '--name-only', first.post.new, second.post.new), 'src/a.ts');
  });

  it('salvage.deterministic-sha: identical inputs give the same SHA', async () => {
    const a = checkout();
    const b = checkout();
    dirty(a.wt);
    dirty(b.wt);
    const ia = await salvage(a);
    const ib = await salvage(b);
    assert.equal(ia.post.new, ib.post.new);
    assert.deepEqual(ia.expect, { ...ib.expect, worktree: ia.expect.worktree });
  });

  it('salvage.unmerged-parks: conflict entries refuse salvage and leave the tree as it was', async () => {
    const c = checkout();
    git(c.repo, 'branch', 'other', 'main');
    writeFiles(c.wt, { 'src/a.ts': 'unit side\n' });
    git(c.wt, 'commit', '--quiet', '-am', 'unit side');
    git(c.wt, 'checkout', '--quiet', 'other');
    writeFiles(c.wt, { 'src/a.ts': 'other side\n' });
    git(c.wt, 'commit', '--quiet', '-am', 'other side');
    git(c.wt, 'checkout', '--quiet', 'unit-a');
    const old = git(c.repo, 'rev-parse', 'unit-a');
    assert.throws(() => git(c.wt, 'merge', 'other'), /exited 1/);
    const conflicted = readFileSync(join(c.wt, 'src/a.ts'), 'utf8');
    assert.throws(() => planSalvage(rules(c.runDir), request(c.wt)), (err: unknown) => {
      assert.ok(err instanceof SalvageUnmergedError, String(err));
      assert.deepEqual(err.paths, ['src/a.ts']);
      return true;
    });
    assert.equal(git(c.repo, 'rev-parse', 'unit-a'), old, 'branch not moved');
    assert.equal(readFileSync(join(c.wt, 'src/a.ts'), 'utf8'), conflicted, 'conflict preserved');
    assert.match(git(c.wt, 'status', '--porcelain=v2'), /^u UU /m);
  });

  it('salvage.no-change: a clean worktree needs no commit and writes no intent', () => {
    const c = checkout();
    writeFiles(c.wt, { 'build.log': 'ignored\n' });
    assert.deepEqual(planSalvage(rules(c.runDir), request(c.wt)), { kind: 'no-change' });
  });
});

describe(`matrix row ${SALVAGE}`, () => {
  const EXPECTED: Readonly<Record<string, 'redone' | 'reconciled'>> = {
    'salvage.act-start': 'redone',
    'salvage.after-copy-out': 'redone',
    'salvage.after-commit-tree': 'redone',
    'salvage.after-cas': 'reconciled',
    'salvage.after-read-tree': 'reconciled',
    'salvage.act-end': 'reconciled',
  };
  let control: Sha;
  before(async () => {
    control = await controlSha();
  });

  it('covers exactly the row\'s crash labels', () => {
    assert.deepEqual(crashCells(SALVAGE).map((c) => c.label).sort(), Object.keys(EXPECTED).sort());
  });

  it('parks when the worktree changed or the branch moved since the intent', async () => {
    for (const disturb of [
      (c: Checkout) => writeFiles(c.wt, { 'src/a.ts': 'edited after the intent\n' }),
      (c: Checkout) => git(c.repo, 'update-ref', 'refs/heads/unit-a', 'main~1'),
    ]) {
      const c = checkout();
      dirty(c.wt);
      const scenario = { op: 'salvage', runDir: c.runDir, worktree: c.wt, branch: BRANCH, message: MESSAGE };
      assert.equal(await crashChild(scenario, 'salvage.act-start', 1), true);
      disturb(c);
      const journal = openArc(c.runDir);
      const recovery = await recoverOp(journal, salvageCommitOp(rules(c.runDir)));
      assert.equal(recovery.kind, 'parked');
      assert.equal(journal.view.openIntents().length, 1, 'a parked intent stays open');
      journal.close();
    }
  });

  for (const cell of crashCells(SALVAGE)) {
    it(`${cell.boundary} ${cell.label}: ${cell.recovery}`, async () => {
      const c = checkout();
      dirty(c.wt);
      const scenario = { op: 'salvage', runDir: c.runDir, worktree: c.wt, branch: BRANCH, message: MESSAGE };
      assert.equal(await crashChild(scenario, cell.label, 1), true, 'the scenario reaches the label');

      const journal = openArc(c.runDir);
      const recovery = await recoverOp(journal, salvageCommitOp(rules(c.runDir)));
      assert.equal(recovery.kind, 'closed', recovery.kind === 'parked' ? recovery.detail : '');
      if (recovery.kind !== 'closed') return;
      assert.equal(recovery.recoveredBy, EXPECTED[cell.label]);
      assert.equal(journal.view.doneOf(recovery.intent.op)?.recoveredBy, EXPECTED[cell.label]);
      assert.equal(journal.view.openIntents().length, 0);
      journal.close();
      assertSalvaged(c, recovery.intent as IntentOf<'salvage.commit'>, control);
    });

    it(`${cell.label}: the scenario reaches it exactly once`, async () => {
      const c = checkout();
      dirty(c.wt);
      const scenario = { op: 'salvage', runDir: c.runDir, worktree: c.wt, branch: BRANCH, message: MESSAGE };
      assert.equal(await crashChild(scenario, cell.label, 2), false);
      assert.equal(sha(git(c.repo, 'rev-parse', 'unit-a')), control);
    });
  }
});
