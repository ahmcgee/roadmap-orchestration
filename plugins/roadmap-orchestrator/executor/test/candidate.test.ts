// Integrated tests of candidate.merge (src/git/candidate.ts, src/recover/candidate.ts): real git, the
// detached candidate worktree through 8a's worktree.create op, and the candidate.* cells of the
// candidate.merge / integration.ff / snapshot.publish matrix row.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import type { Sha } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { type CandidatePlan, candidatePostcondition, candidateWorktreeRequest, planCandidate } from '../src/git/candidate.ts';
import { parentsOf } from '../src/git/mergein.ts';
import { inspectWorktree } from '../src/git/worktree.ts';
import { openArc, runOp } from './fixtures/git-common.ts';
import { CANDIDATE_REF, type Scene, candidateRequest, crashChild8b, recover8b, revOf, scene, sharedBase } from './fixtures/git8b-common.ts';
import { git } from './helpers/repo.ts';
import { CANDIDATE_FF_SNAPSHOT, crashCells } from './matrix.ts';
import { candidateMergeOp, worktreeCreateOp } from '../src/recover/ops.ts';

let base: string;
before(() => {
  base = sharedBase();
});

const candidateWorktree = (s: Scene) => absPath(join(s.root, 'candidate'));

function plan(s: Scene, unitCommit: Sha = s.unit): CandidatePlan {
  const decision = planCandidate(s.repo, candidateRequest(candidateWorktree(s), unitCommit));
  if (decision.kind !== 'merge') throw new Error(`expected a mergeable candidate, got ${decision.kind}`);
  return decision.plan;
}

async function candidate(s: Scene): Promise<IntentOf<'candidate.merge'>> {
  const journal = openArc(s.runDir);
  const intent = await runOp(journal, candidateMergeOp(s.repo), 'candidate:unit-a', plan(s));
  journal.close();
  return intent;
}

/** The oracle: the candidate ref at the control SHA, one merge commit [T, unit], nothing duplicated. */
function assertCandidate(s: Scene, intent: IntentOf<'candidate.merge'>, control: Sha): void {
  assert.equal(intent.post.new, control, 'the same candidate SHA');
  assert.equal(candidatePostcondition(s.repo, intent), null);
  assert.equal(revOf(s.repo, CANDIDATE_REF), control);
  assert.deepEqual(parentsOf(s.repo, control), [s.tip, s.unit]);
  assert.equal(git(s.repo, 'rev-list', '--count', control, `^${s.tip}`, `^${s.unit}`), '1', 'exactly one candidate commit');
  assert.equal(revOf(s.repo, 'main'), s.tip, 'integration untouched');
}

describe('candidate.merge', () => {
  it('merges the unit onto T with recorded inputs, then the detached candidate worktree is created at it', async () => {
    const a = scene(base, 'clean');
    const b = scene(base, 'clean');
    const ia = await candidate(a);
    const ib = await candidate(b);
    assert.equal(ia.expect.old, null, 'no candidate ref before');
    assert.equal(ia.post.new, ib.post.new, 'identical inputs give the same SHA');
    assertCandidate(a, ia, ia.post.new);

    const journal = openArc(a.runDir);
    const wt = await runOp(journal, worktreeCreateOp(a.repo), 'worktree:candidate', candidateWorktreeRequest(ia));
    journal.close();
    assert.deepEqual(inspectWorktree(a.repo, wt.expect), { kind: 'ready', head: ia.post.new });
    assert.throws(() => git(candidateWorktree(a), 'symbolic-ref', '-q', 'HEAD'), /exited 1/, 'HEAD detached');
  });

  it('a fresh candidate records the previous one as old and moves the ref by CAS', async () => {
    const s = scene(base, 'clean');
    const first = await candidate(s);
    const next = await candidate(s);
    assert.equal(next.expect.old, first.post.new);
    assert.equal(next.post.new, first.post.new, 'the same inputs again: the same commit');
    const tip = revOf(s.repo, 'main');
    git(s.repo, 'update-ref', 'refs/heads/main', git(s.repo, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'advance'));
    const third = await candidate(s);
    assert.equal(third.expect.old, first.post.new);
    assert.notEqual(third.post.new, first.post.new);
    assert.equal(revOf(s.repo, CANDIDATE_REF), third.post.new);
  });

  it('aborts recovery when someone else moved the candidate ref', async () => {
    const s = scene(base, 'clean');
    const scenario = { op: 'candidate', runDir: s.runDir, repo: s.repo, unitCommit: s.unit, worktree: candidateWorktree(s) } as const;
    assert.equal(await crashChild8b(scenario, 'candidate.act-start', 1), true);
    git(s.repo, 'update-ref', CANDIDATE_REF, s.unit);
    const journal = openArc(s.runDir);
    const recovery = await recover8b(journal, candidateMergeOp(s.repo));
    assert.equal(recovery.kind, 'aborted');
    assert.equal(journal.view.openIntents().length, 0, 'the abort closes the intent');
    journal.close();
    assert.equal(revOf(s.repo, CANDIDATE_REF), s.unit, 'the foreign value is left for the user');
  });
});

describe(`matrix row ${CANDIDATE_FF_SNAPSHOT}: candidate.merge`, () => {
  const EXPECTED: Readonly<Record<string, 'redone' | 'reconciled'>> = {
    'candidate.act-start': 'redone',
    'candidate.after-commit-tree': 'redone',
    'candidate.act-end': 'reconciled',
  };
  const cells = crashCells(CANDIDATE_FF_SNAPSHOT).filter((c) => c.label.startsWith('candidate.'));
  let control: Sha;
  before(async () => {
    control = (await candidate(scene(base, 'clean'))).post.new;
  });

  it('covers exactly the row\'s candidate labels, and the row names no op beyond the three', () => {
    assert.deepEqual(cells.map((c) => c.label).sort(), Object.keys(EXPECTED).sort());
    for (const c of crashCells(CANDIDATE_FF_SNAPSHOT)) assert.match(c.label, /^(candidate|ff|snapshot)\./);
  });

  for (const cell of cells) {
    it(`${cell.boundary} ${cell.label}: ${cell.recovery}`, async () => {
      const s = scene(base, 'clean');
      const scenario = { op: 'candidate', runDir: s.runDir, repo: s.repo, unitCommit: s.unit, worktree: candidateWorktree(s) } as const;
      assert.equal(await crashChild8b(scenario, cell.label, 1), true, 'the scenario reaches the label');

      const journal = openArc(s.runDir);
      const recovery = await recover8b(journal, candidateMergeOp(s.repo));
      assert.equal(recovery.kind, 'closed', recovery.kind !== 'closed' ? recovery.detail : '');
      if (recovery.kind !== 'closed') return;
      assert.equal(recovery.recoveredBy, EXPECTED[cell.label]);
      assert.deepEqual(journal.view.doneOf(recovery.intent.op)?.outcome, { kind: 'merged' });
      assert.equal(journal.view.openIntents().length, 0);
      journal.close();
      assertCandidate(s, recovery.intent as IntentOf<'candidate.merge'>, control);
    });

    it(`${cell.label}: the scenario reaches it exactly once`, async () => {
      const s = scene(base, 'clean');
      const scenario = { op: 'candidate', runDir: s.runDir, repo: s.repo, unitCommit: s.unit, worktree: candidateWorktree(s) } as const;
      assert.equal(await crashChild8b(scenario, cell.label, 2), false);
      assert.equal(revOf(s.repo, CANDIDATE_REF), control);
    });
  }
});
