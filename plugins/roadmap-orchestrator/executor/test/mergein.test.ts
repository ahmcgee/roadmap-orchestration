// Integrated tests of mergein.prepare (src/git/mergein.ts, src/recover/mergein.ts): real git, the unit's
// real worktree, crash cells in a child process killed at crashPoints. The plan's merge.conflict-mergein
// and the mergein.prepare matrix row.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import type { Sha } from '../src/core/ids.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import { candidatePostcondition, planCandidate } from '../src/git/candidate.ts';
import { classifyMergein, mergeHead, mergeinCompleted, parentsOf } from '../src/git/mergein.ts';
import { diffBase, unitDiffPaths } from '../src/git/transient.ts';
import { IDENTITY, openArc, runOp } from './fixtures/git-common.ts';
import {
  INTEGRATION, MERGEIN_MESSAGE, type Scene, UNIT_BRANCH, candidateRequest, crashChild8b, recover8b, revOf, scene, sharedBase,
} from './fixtures/git8b-common.ts';
import { git, writeFiles } from './helpers/repo.ts';
import { MERGEIN, crashCells } from './matrix.ts';
import { candidateMergeOp, mergeinOp } from '../src/recover/ops.ts';

type Kind = 'clean' | 'conflict';
type Checkout = Scene & Readonly<{ wt: AbsPath }>;

let base: string;
before(() => {
  base = sharedBase();
});

/** The scene with the unit's worktree on unit-a. */
function checkout(kind: Kind): Checkout {
  const s = scene(base, kind);
  const wt = absPath(join(s.root, 'wt'));
  git(s.repo, 'worktree', 'add', '--quiet', wt, 'unit-a');
  return { ...s, wt };
}

const request = (c: Checkout) => ({ worktree: c.wt, branch: UNIT_BRANCH, integration: INTEGRATION, identity: IDENTITY, message: MERGEIN_MESSAGE });

async function mergein(c: Checkout): Promise<IntentOf<'mergein.prepare'>> {
  const journal = openArc(c.runDir);
  const intent = await runOp(journal, mergeinOp(c.repo), 'mergein:unit-a', request(c));
  journal.close();
  return intent;
}

/** The oracle per scenario: clean → HEAD = the recorded merge (the control SHA), index and files at it; conflict → markers + MERGE_HEAD = T. */
function assertMergedIn(c: Checkout, intent: IntentOf<'mergein.prepare'>, kind: Kind, control: Sha | null): void {
  assert.equal(intent.expect.old, c.unit);
  assert.equal(intent.expect.integrationTip, c.tip);
  if (kind === 'clean') {
    assert.equal(intent.post.type, 'clean-merged');
    if (intent.post.type !== 'clean-merged') return;
    assert.equal(intent.post.new, control, 'the same merge-in SHA');
    assert.equal(revOf(c.wt, 'HEAD'), control);
    assert.deepEqual(parentsOf(c.repo, intent.post.new), [c.unit, c.tip]);
    assert.equal(git(c.wt, 'status', '--porcelain=v2', '--untracked-files=all'), '', 'index and files at the merge');
    assert.equal(readFileSync(join(c.wt, 'docs/readme.md'), 'utf8'), '# readme, integrated\n');
    assert.equal(mergeHead(c.wt), null);
    assert.equal(git(c.repo, 'rev-list', '--count', `${c.unit}..unit-a`), '2', 'the merge and T\'s one commit: no duplicate');
  } else {
    assert.equal(intent.post.type, 'conflicted');
    assert.deepEqual(intent.expect.merge, { type: 'conflicted', conflicts: ['src/a.ts'] });
    assert.equal(revOf(c.wt, 'HEAD'), c.unit, 'HEAD = old');
    assert.equal(mergeHead(c.wt), c.tip, 'MERGE_HEAD = T');
    assert.match(readFileSync(join(c.wt, 'src/a.ts'), 'utf8'), /^<<<<<<< [^\n]*\nexport const a = 100;\n=======\nexport const a = -1;\n>>>>>>> /);
    assert.deepEqual(classifyMergein(intent), { kind: 'conflicted' });
  }
}

describe('mergein.prepare', () => {
  it('merge.conflict-mergein: candidate conflicts; merge-in leaves MERGE_HEAD; resolve + commit is completed; a fresh candidate merges clean', async () => {
    const c = checkout('conflict');
    const conflict = planCandidate(c.repo, candidateRequest(absPath(join(c.root, 'candidate')), c.unit));
    assert.deepEqual(conflict, { kind: 'conflict', tip: c.tip, conflicts: ['src/a.ts'] });
    assert.equal(git(c.repo, 'for-each-ref', 'refs/roadmap-run'), '', 'a conflict writes no candidate');

    const intent = await mergein(c);
    assertMergedIn(c, intent, 'conflict', null);
    assert.throws(() => mergeinCompleted(intent), /not completed: conflicted/);

    // What the resumed implementer does: resolve and commit.
    writeFiles(c.wt, { 'src/a.ts': 'export const a = 99;\n' });
    git(c.wt, 'add', 'src/a.ts');
    git(c.wt, 'commit', '--quiet', '--no-edit');
    const completed = mergeinCompleted(intent);
    const head = revOf(c.wt, 'HEAD');
    assert.deepEqual(completed, { kind: 'completed', head });
    assert.deepEqual(parentsOf(c.repo, head), [c.unit, c.tip], 'parents [old, T]');

    // The diff base is recomputed after the merge-in: it is T now, and the unit diff is the resolution.
    assert.equal(diffBase(c.repo, c.tip, head), c.tip);
    assert.deepEqual(unitDiffPaths(c.repo, c.tip, head), ['src/a.ts']);

    const fresh = planCandidate(c.repo, candidateRequest(absPath(join(c.root, 'candidate')), head));
    assert.equal(fresh.kind, 'merge');
    if (fresh.kind !== 'merge') return;
    const journal = openArc(c.runDir);
    const cand = await runOp(journal, candidateMergeOp(c.repo), 'candidate:unit-a', fresh.plan);
    journal.close();
    assert.equal(candidatePostcondition(c.repo, cand), null);
    assert.deepEqual(parentsOf(c.repo, cand.post.new), [c.tip, head]);
  });

  it('a clean merge-in commits [old, T] with recorded inputs and moves the worktree to it', async () => {
    const a = checkout('clean');
    const b = checkout('clean');
    const ia = await mergein(a);
    const ib = await mergein(b);
    if (ia.post.type !== 'clean-merged') throw new Error('expected a clean merge-in');
    assertMergedIn(a, ia, 'clean', ia.post.new);
    assertMergedIn(b, ib, 'clean', ia.post.new);
  });

  it('refuses a dirty worktree before any intent', async () => {
    const c = checkout('clean');
    writeFiles(c.wt, { 'src/a.ts': 'uncommitted\n' });
    const journal = openArc(c.runDir);
    await assert.rejects(runOp(journal, mergeinOp(c.repo), 'mergein:unit-a', request(c)), /status not clean/);
    assert.equal(journal.view.highWater(), 0);
    journal.close();
  });
});

describe(`matrix row ${MERGEIN}`, () => {
  const EXPECTED: Readonly<Record<string, Readonly<Partial<Record<Kind, 'redone' | 'reconciled'>>>>> = {
    'mergein.act-start': { clean: 'redone', conflict: 'redone' },
    'mergein.after-commit-tree': { clean: 'redone' },
    'mergein.after-cas': { clean: 'reconciled' },
    'mergein.after-merge': { conflict: 'reconciled' },
    'mergein.act-end': { clean: 'reconciled', conflict: 'reconciled' },
  };
  let control: Sha;
  before(async () => {
    const intent = await mergein(checkout('clean'));
    if (intent.post.type !== 'clean-merged') throw new Error('expected a clean merge-in');
    control = intent.post.new;
  });

  it('covers exactly the row\'s crash labels', () => {
    assert.deepEqual(crashCells(MERGEIN).map((c) => c.label).sort(), Object.keys(EXPECTED).sort());
  });

  it('parks when HEAD moved to something that is neither old, the merge, nor a merge of [old, T]', async () => {
    const c = checkout('conflict');
    const scenario = { op: 'mergein', runDir: c.runDir, repo: c.repo, worktree: c.wt } as const;
    assert.equal(await crashChild8b(scenario, 'mergein.act-start', 1), true);
    writeFiles(c.wt, { 'src/b.ts': 'someone else\n' });
    git(c.wt, 'commit', '--quiet', '-am', 'foreign commit');
    const journal = openArc(c.runDir);
    const recovery = await recover8b(journal, mergeinOp(c.repo));
    assert.equal(recovery.kind, 'parked');
    assert.equal(journal.view.openIntents().length, 1, 'a parked intent stays open');
    journal.close();
  });

  it('an open conflicted merge-in the implementer already resolved and committed recovers as completed', async () => {
    const c = checkout('conflict');
    const scenario = { op: 'mergein', runDir: c.runDir, repo: c.repo, worktree: c.wt } as const;
    assert.equal(await crashChild8b(scenario, 'mergein.act-end', 1), true);
    writeFiles(c.wt, { 'src/a.ts': 'export const a = 99;\n' });
    git(c.wt, 'add', 'src/a.ts');
    git(c.wt, 'commit', '--quiet', '--no-edit');
    const journal = openArc(c.runDir);
    const recovery = await recover8b(journal, mergeinOp(c.repo));
    assert.equal(recovery.kind, 'closed');
    const done = journal.view.doneOf(recovery.intent.op);
    assert.deepEqual(done?.outcome, { kind: 'completed', head: revOf(c.wt, 'HEAD') });
    journal.close();
  });

  for (const cell of crashCells(MERGEIN)) {
    for (const [kind, expected] of Object.entries(EXPECTED[cell.label] ?? {}) as [Kind, 'redone' | 'reconciled'][]) {
      it(`${cell.boundary} ${cell.label} (${kind}): ${cell.recovery}`, async () => {
        const c = checkout(kind);
        const scenario = { op: 'mergein', runDir: c.runDir, repo: c.repo, worktree: c.wt } as const;
        assert.equal(await crashChild8b(scenario, cell.label, 1), true, 'the scenario reaches the label');

        const journal = openArc(c.runDir);
        const recovery = await recover8b(journal, mergeinOp(c.repo));
        assert.equal(recovery.kind, 'closed', recovery.kind !== 'closed' ? recovery.detail : '');
        if (recovery.kind !== 'closed') return;
        assert.equal(recovery.recoveredBy, expected);
        assert.deepEqual(journal.view.doneOf(recovery.intent.op)?.outcome, { kind: kind === 'clean' ? 'clean-merged' : 'conflicted' });
        assert.equal(journal.view.openIntents().length, 0);
        journal.close();
        assertMergedIn(c, recovery.intent as IntentOf<'mergein.prepare'>, kind, control);
      });

      it(`${cell.label} (${kind}): the scenario reaches it exactly once`, async () => {
        const c = checkout(kind);
        const scenario = { op: 'mergein', runDir: c.runDir, repo: c.repo, worktree: c.wt } as const;
        assert.equal(await crashChild8b(scenario, cell.label, 2), false);
        if (kind === 'clean') assert.equal(revOf(c.wt, 'HEAD'), control);
        else assert.equal(mergeHead(c.wt), c.tip);
      });
    }
  }
});
