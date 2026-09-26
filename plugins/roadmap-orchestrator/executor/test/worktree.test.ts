// Integrated tests of worktree.create / worktree.remove (src/git/worktree.ts, src/recover/worktree.ts):
// real git, crash cells in a child process killed at crashPoints, hand-made partial states for what a
// crashPoint cannot reach (the inside of `git worktree add`).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { WorktreeCheckout } from '../src/core/events.ts';
import { type OpId, opKey, sha } from '../src/core/ids.ts';
import { capturedEvidence } from '../src/git/evidence.ts';
import { worktreeList } from '../src/git/git.ts';
import { type WorktreeRemoveRequest, inspectWorktree, worktreeGone } from '../src/git/worktree.ts';
import { type AbsPath, absPath, refName, repoPattern } from '../src/core/values.ts';
import { baseRepo, cloneRepo, crashChild, openArc, recoverOp, runOp } from './fixtures/git-common.ts';
import { git, tmpDir, writeFiles } from './helpers/repo.ts';
import { WORKTREE_EVIDENCE, crashCells } from './matrix.ts';
import { evidenceSnapshotOp, worktreeCreateOp, worktreeRemoveOp } from '../src/recover/ops.ts';

const BRANCH = refName('refs/heads/unit-a');

type Setup = Readonly<{ repo: AbsPath; path: AbsPath; runDir: string; main: string }>;

let base: string;
before(() => {
  base = baseRepo(join(tmpDir('wt-base'), 'base'));
});

function setup(): Setup {
  const root = tmpDir('wt');
  const repo = cloneRepo(base, join(root, 'repo'));
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  return { repo, path: absPath(join(root, 'wt')), runDir, main: git(repo, 'rev-parse', 'main') };
}

const branchCheckout = (s: Setup): WorktreeCheckout => ({ type: 'branch', branch: BRANCH, at: sha(s.main), createBranch: true });

/** Writes the create intent durably without acting, as a crash at B2 would leave it. */
async function openCreateIntent(s: Setup, checkout: WorktreeCheckout): Promise<void> {
  const op = worktreeCreateOp(s.repo);
  const body = await op.prepare({ path: s.path, checkout });
  const journal = openArc(s.runDir);
  journal.begin({ kind: 'worktree.create', key: opKey('worktree:unit'), parent: { type: 'arc' }, deadlineAt: null, body: () => body });
  journal.close();
}

async function recoverCreate(s: Setup) {
  const journal = openArc(s.runDir);
  const recovery = await recoverOp(journal, worktreeCreateOp(s.repo));
  const open = journal.view.openIntents().length;
  journal.close();
  return { recovery, open };
}

/** A created unit worktree plus a done evidence snapshot of three files, ready for removal. */
async function createdWithEvidence(s: Setup): Promise<OpId> {
  const journal = openArc(s.runDir);
  await runOp(journal, worktreeCreateOp(s.repo), 'worktree:unit', { path: s.path, checkout: branchCheckout(s) });
  const source = join(s.runDir, 'inv-evidence');
  writeFiles(source, { stdout: 'out\n', stderr: 'err\n', 'decisions.json': '{}\n' });
  const snapshot = await runOp(journal, evidenceSnapshotOp, 'evidence:unit', {
    source: absPath(source), globs: [repoPattern('**')], dest: absPath(join(s.runDir, 'evidence', 'snap')),
  });
  journal.close();
  return snapshot.op;
}

describe('worktree', () => {
  it('worktree.create: a unit branch worktree and a detached verification tree', async () => {
    const s = setup();
    const journal = openArc(s.runDir);
    const unit = await runOp(journal, worktreeCreateOp(s.repo), 'worktree:unit', { path: s.path, checkout: branchCheckout(s) });
    assert.deepEqual(journal.view.doneOf(unit.op)?.outcome, { kind: 'created', head: s.main });
    assert.equal(git(s.path, 'symbolic-ref', 'HEAD'), BRANCH);
    const verification = absPath(`${s.path}-verify`);
    const detached = await runOp(journal, worktreeCreateOp(s.repo), 'worktree:verify', { path: verification, checkout: { type: 'detached', at: sha(s.main) } });
    assert.deepEqual(journal.view.doneOf(detached.op)?.outcome, { kind: 'created', head: s.main });
    assert.throws(() => git(verification, 'symbolic-ref', '-q', 'HEAD'));
    journal.close();
  });

  it('worktree.partial-add: provably-own partial states are cleared and recreated', async () => {
    const partials: Readonly<Record<string, (s: Setup) => void>> = {
      'admin dir entry present, path missing': (s) => {
        git(s.repo, 'worktree', 'add', '--quiet', '-b', 'unit-a', s.path, 'main');
        rmSync(s.path, { recursive: true });
      },
      'path present, branch not created': (s) => git(s.repo, 'worktree', 'add', '--quiet', '--detach', s.path, 'main'),
      'empty directory at the path': (s) => mkdirSync(s.path),
      'checkout cut short (tracked files unwritten)': (s) => {
        git(s.repo, 'worktree', 'add', '--quiet', '-b', 'unit-a', s.path, 'main');
        rmSync(join(s.path, 'src'), { recursive: true });
      },
    };
    for (const [name, make] of Object.entries(partials)) {
      const s = setup();
      await openCreateIntent(s, branchCheckout(s));
      make(s);
      const { recovery, open } = await recoverCreate(s);
      assert.equal(recovery.kind, 'closed', `${name}: ${recovery.kind === 'parked' ? recovery.detail : ''}`);
      assert.equal(recovery.kind === 'closed' && recovery.recoveredBy, 'redone', name);
      assert.equal(open, 0, name);
      assert.deepEqual(inspectWorktree(s.repo, { path: s.path, checkout: branchCheckout(s) }), { kind: 'ready', head: s.main }, name);
    }
  });

  it('worktree.partial-add: a moved branch or foreign content parks, preserving it', async () => {
    const parks: Readonly<Record<string, (s: Setup) => void>> = {
      'branch moved': (s) => git(s.repo, 'worktree', 'add', '--quiet', '-b', 'unit-a', s.path, 'main~1'),
      'branch created elsewhere, no worktree': (s) => git(s.repo, 'branch', 'unit-a', 'main~1'),
      'foreign content at the path': (s) => writeFiles(s.path, { 'mine.txt': 'not yours\n' }),
      'listed worktree holds changes': (s) => {
        git(s.repo, 'worktree', 'add', '--quiet', '-b', 'unit-a', s.path, 'main');
        writeFiles(s.path, { 'src/a.ts': 'edited\n' });
      },
    };
    for (const [name, make] of Object.entries(parks)) {
      const s = setup();
      await openCreateIntent(s, branchCheckout(s));
      make(s);
      const { recovery, open } = await recoverCreate(s);
      assert.equal(recovery.kind, 'parked', name);
      assert.equal(open, 1, `${name}: the parked intent stays open`);
    }
    // Nothing a park looked at was deleted.
    const s = setup();
    await openCreateIntent(s, branchCheckout(s));
    writeFiles(s.path, { 'mine.txt': 'not yours\n' });
    await recoverCreate(s);
    assert.equal(existsSync(join(s.path, 'mine.txt')), true);
  });

  it('worktree.remove-requires-manifest: no removal without a complete, verified evidence manifest', async () => {
    const s = setup();
    const evidence = await createdWithEvidence(s);
    const journal = openArc(s.runDir);
    // @ts-expect-error a removal request cannot be built without captured evidence
    const bare: WorktreeRemoveRequest = { path: s.path, evidence: { op: evidence } };
    assert.ok(bare);
    // A removal intent whose evidence then stops verifying parks, and the worktree survives.
    const captured = capturedEvidence(journal.view, evidence);
    const body = await worktreeRemoveOp(s.repo).prepare({ path: s.path, evidence: captured });
    journal.begin({ kind: 'worktree.remove', key: opKey('worktree:unit'), parent: { type: 'arc' }, deadlineAt: null, body: () => body });
    writeFileSync(join(s.runDir, 'evidence', 'snap', 'files', 'stdout'), 'tampered\n');
    assert.throws(() => capturedEvidence(journal.view, evidence), /evidence not captured/);
    const recovery = await recoverOp(journal, worktreeRemoveOp(s.repo));
    assert.equal(recovery.kind, 'parked');
    assert.match(recovery.kind === 'parked' ? recovery.detail : '', /requires a complete evidence manifest/);
    assert.equal(existsSync(s.path), true);
    journal.close();
  });

  it('worktree.remove: removes the worktree and keeps the branch', async () => {
    const s = setup();
    const evidence = await createdWithEvidence(s);
    const journal = openArc(s.runDir);
    await runOp(journal, worktreeRemoveOp(s.repo), 'worktree:unit', { path: s.path, evidence: capturedEvidence(journal.view, evidence) });
    journal.close();
    assert.equal(worktreeGone(s.repo, s.path), true);
    assert.equal(git(s.repo, 'rev-parse', 'unit-a'), s.main, 'branches are never deleted');
  });
});

describe(`matrix row ${WORKTREE_EVIDENCE}: worktree cells`, () => {
  const EXPECTED: Readonly<Record<string, 'redone' | 'reconciled'>> = {
    'worktree.create.act-start': 'redone',
    'worktree.add.inside': 'reconciled',
    'worktree.remove.act-start': 'redone',
    'worktree.remove.inside': 'reconciled',
  };
  const cells = crashCells(WORKTREE_EVIDENCE).filter((c) => c.label.startsWith('worktree.'));

  it('covers exactly the row\'s worktree labels', () => {
    assert.deepEqual(cells.map((c) => c.label).sort(), Object.keys(EXPECTED).sort());
  });

  for (const cell of cells) {
    const removal = cell.label.startsWith('worktree.remove.');
    const scenario = async (s: Setup) => removal
      ? { op: 'remove', runDir: s.runDir, repo: s.repo, path: s.path, evidence: await createdWithEvidence(s) }
      : { op: 'create', runDir: s.runDir, repo: s.repo, path: s.path, checkout: branchCheckout(s) };
    const assertOutcome = (s: Setup): void => {
      if (removal) assert.equal(worktreeGone(s.repo, s.path), true);
      else assert.deepEqual(inspectWorktree(s.repo, { path: s.path, checkout: branchCheckout(s) }), { kind: 'ready', head: s.main });
      assert.equal(git(s.repo, 'rev-parse', 'unit-a'), s.main, 'the branch is at its start and never deleted');
      assert.equal(worktreeList(s.repo).filter((e) => e.path === s.path).length, removal ? 0 : 1);
    };

    it(`${cell.boundary} ${cell.label}: ${cell.recovery}`, async () => {
      const s = setup();
      assert.equal(await crashChild(await scenario(s), cell.label, 1), true, 'the scenario reaches the label');
      const journal = openArc(s.runDir);
      const recovery = removal ? await recoverOp(journal, worktreeRemoveOp(s.repo)) : await recoverOp(journal, worktreeCreateOp(s.repo));
      assert.equal(recovery.kind, 'closed', recovery.kind === 'parked' ? recovery.detail : '');
      assert.equal(recovery.kind === 'closed' && recovery.recoveredBy, EXPECTED[cell.label]);
      assert.equal(journal.view.doneOf(recovery.intent.op)?.recoveredBy, EXPECTED[cell.label]);
      assert.equal(journal.view.openIntents().length, 0);
      journal.close();
      assertOutcome(s);
    });

    it(`${cell.label}: the scenario reaches it exactly once`, async () => {
      const s = setup();
      assert.equal(await crashChild(await scenario(s), cell.label, 2), false);
      assertOutcome(s);
    });
  }
});
