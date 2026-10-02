// Integrated tests of integration.ff (src/git/ff.ts, src/recover/ff.ts): real git, candidates made by
// candidate.merge, crash cells in a child process. The plan's merge.stale-tip-fresh-candidate,
// git.foreign-mover, ff.second-parent-provenance, ff.fingerprint-callback-gates-redo, and the ff.* cells
// of the candidate.merge / integration.ff / snapshot.publish matrix row.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { unitFfFingerprint } from './oracle.ts';
import { type Sha, opKey, sha } from '../src/core/ids.ts';
import type { ApprovalFingerprint } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { planCandidate } from '../src/git/candidate.ts';
import { type FfPlan, planFf } from '../src/git/ff.ts';
import { parentsOf } from '../src/git/mergein.ts';
import { openArc, runOp } from './fixtures/git-common.ts';
import {
  CANDIDATE_REF, INTEGRATION, type Scene, candidateRequest, crashChild8b, fingerprintFor, recover8b, revOf, scene, sharedBase,
} from './fixtures/git8b-common.ts';
import { git } from './helpers/repo.ts';
import { CANDIDATE_FF_SNAPSHOT, crashCells } from './matrix.ts';
import { candidateMergeOp, integrationFfOp } from '../src/recover/ops.ts';

let base: string;
before(() => {
  base = sharedBase();
});

const always = (): boolean => true;

/** A candidate.merge of `unitCommit` onto the current tip, done in the scene's journal. */
async function candidate(s: Scene, unitCommit: Sha = s.unit): Promise<IntentOf<'candidate.merge'>> {
  const decision = planCandidate(s.repo, candidateRequest(absPath(join(s.root, 'candidate')), unitCommit));
  if (decision.kind !== 'merge') throw new Error(`expected a mergeable candidate, got ${decision.kind}`);
  const journal = openArc(s.runDir);
  const intent = await runOp(journal, candidateMergeOp(s.repo), 'candidate:unit-a', decision.plan);
  journal.close();
  return intent;
}

function ffPlan(s: Scene, cand: IntentOf<'candidate.merge'>): FfPlan {
  const decision = planFf(s.repo, { integration: INTEGRATION, candidate: cand, fingerprint: fingerprintFor(cand.expect.unitCommit) });
  if (decision.kind !== 'ff') throw new Error(`expected an ff plan, got ${JSON.stringify(decision)}`);
  return decision;
}

/** An unrelated commit on top of `at`: someone else's publication. */
const advance = (s: Scene, at: Sha): Sha => sha(git(s.repo, 'commit-tree', `${at}^{tree}`, '-p', at, '-m', 'another unit'));

/** How many first-parent commits of `tip..main` publish `unit` (a merge whose second parent it is). */
function publications(s: Scene, tip: Sha, unit: Sha): number {
  return git(s.repo, 'rev-list', '--first-parent', '--parents', `${tip}..main`).split('\n').filter((l) => l.split(' ')[2] === unit).length;
}

/** The oracle: integration at the tested candidate, new^1 = T, new^2 = the approved unit commit, published once. */
function assertPublished(s: Scene, intent: IntentOf<'integration.ff'>): void {
  const next = intent.expect.new;
  assert.equal(revOf(s.repo, 'main'), next, 'integration at the tested candidate');
  assert.deepEqual(parentsOf(s.repo, next), [intent.expect.old, unitFfFingerprint(intent.expect).unitCommit]);
  assert.equal(revOf(s.repo, 'main^1'), intent.expect.old, 'new^1 = T');
  assert.equal(revOf(s.repo, 'main^2'), s.unit, 'new^2 = the approved unit commit');
  assert.equal(publications(s, intent.expect.old, s.unit), 1, 'one publication of the unit');
}

describe('integration.ff', () => {
  it('ff.second-parent-provenance: after ff, new^2 is the approved unit commit and new^1 is T', async () => {
    const s = scene(base, 'clean');
    const cand = await candidate(s);
    const journal = openArc(s.runDir);
    const intent = await runOp(journal, integrationFfOp(s.repo, always), 'ff:main', ffPlan(s, cand));
    assert.deepEqual(journal.view.doneOf(intent.op)?.outcome, { kind: 'published' });
    journal.close();
    assert.deepEqual(intent.expect, { ref: INTEGRATION, old: s.tip, new: cand.post.new, fingerprint: fingerprintFor(s.unit) });
    assertPublished(s, intent);
  });

  it('merge.stale-tip-fresh-candidate: T advances between candidate and ff; the CAS fails, ff is unpublished, a fresh candidate at the new T publishes', async () => {
    const s = scene(base, 'clean');
    const first = await candidate(s);
    const op = integrationFfOp(s.repo, always);
    const journal = openArc(s.runDir);
    const body = await op.prepare(ffPlan(s, first));
    const { op: id } = journal.begin({ kind: 'integration.ff', key: opKey('ff:main'), parent: { type: 'arc' }, deadlineAt: null, body: () => body });
    const intent = journal.view.latestIntent(id) as IntentOf<'integration.ff'>;
    const moved = advance(s, s.tip);
    git(s.repo, 'update-ref', 'refs/heads/main', moved);
    await op.act(intent);
    const outcome = await op.verify(intent);
    assert.deepEqual(outcome, { kind: 'unpublished', tip: moved });
    journal.done(id, 'integration.ff', outcome, null);
    journal.close();
    assert.equal(revOf(s.repo, 'main'), moved, 'the CAS did not move integration');

    // Planning against the stale candidate now says unpublished without an intent.
    assert.deepEqual(planFf(s.repo, { integration: INTEGRATION, candidate: first, fingerprint: fingerprintFor(s.unit) }), { kind: 'unpublished', tip: moved });

    const fresh = await candidate(s);
    assert.equal(fresh.expect.integrationTip, moved);
    assert.equal(fresh.expect.old, first.post.new);
    const j2 = openArc(s.runDir);
    const published = await runOp(j2, integrationFfOp(s.repo, always), 'ff:main', ffPlan(s, fresh));
    j2.close();
    assert.equal(revOf(s.repo, 'main'), fresh.post.new);
    assert.deepEqual(parentsOf(s.repo, fresh.post.new), [moved, s.unit]);
    assert.equal(publications(s, s.tip, s.unit), 1, 'the unit is published once');
    assert.equal(published.expect.old, moved);
  });

  it('git.foreign-mover: a rewound integration or a moved candidate ref is a typed foreign-mover; after the intent it is recovery-required', async () => {
    // Integration rewound before planning.
    const a = scene(base, 'clean');
    const candA = await candidate(a);
    git(a.repo, 'update-ref', 'refs/heads/main', a.m0);
    assert.deepEqual(planFf(a.repo, { integration: INTEGRATION, candidate: candA, fingerprint: fingerprintFor(a.unit) }), {
      kind: 'foreign-mover', ref: INTEGRATION, expected: a.tip, observed: a.m0,
    });

    // The candidate ref moved by someone else.
    const b = scene(base, 'clean');
    const candB = await candidate(b);
    git(b.repo, 'update-ref', CANDIDATE_REF, b.unit);
    assert.deepEqual(planFf(b.repo, { integration: INTEGRATION, candidate: candB, fingerprint: fingerprintFor(b.unit) }), {
      kind: 'foreign-mover', ref: CANDIDATE_REF, expected: candB.post.new, observed: b.unit,
    });

    // Integration rewound after the intent, before the act: the act does not publish; verify says recovery-required.
    const c = scene(base, 'clean');
    const candC = await candidate(c);
    const op = integrationFfOp(c.repo, always);
    const body = await op.prepare(ffPlan(c, candC));
    const journal = openArc(c.runDir);
    const { op: id } = journal.begin({ kind: 'integration.ff', key: opKey('ff:main'), parent: { type: 'arc' }, deadlineAt: null, body: () => body });
    const intent = journal.view.latestIntent(id) as IntentOf<'integration.ff'>;
    git(c.repo, 'update-ref', 'refs/heads/main', c.m0);
    await op.act(intent);
    assert.deepEqual(await op.verify(intent), { kind: 'recovery-required', observed: c.m0 });
    assert.equal(revOf(c.repo, 'main'), c.m0, 'never published over a rewind');

    // The same state met by recovery: recovery-required, never a redo.
    const recovery = await recover8b(journal, op);
    assert.equal(recovery.kind, 'recovery-required');
    journal.close();
    assert.equal(revOf(c.repo, 'main'), c.m0);
  });

  it('ff.fingerprint-callback-gates-redo: a CAS that never happened is redone only when the fingerprint re-check holds', async () => {
    for (const valid of [false, true]) {
      const s = scene(base, 'clean');
      const cand = await candidate(s);
      const scenario = { op: 'ff', runDir: s.runDir, repo: s.repo, candidate: cand.op } as const;
      assert.equal(await crashChild8b(scenario, 'ff.act-start', 1), true);
      const seen: ApprovalFingerprint[] = [];
      const journal = openArc(s.runDir);
      const recovery = await recover8b(journal, integrationFfOp(s.repo, (fp) => {
        seen.push(fp);
        return valid;
      }));
      assert.deepEqual(seen, [fingerprintFor(s.unit)], 'the callback gets the recorded fingerprint');
      assert.equal(recovery.kind, 'closed');
      if (recovery.kind !== 'closed') return;
      const done = journal.view.doneOf(recovery.intent.op);
      journal.close();
      if (valid) {
        assert.equal(recovery.recoveredBy, 'redone');
        assert.deepEqual(done?.outcome, { kind: 'published' });
        assertPublished(s, recovery.intent as IntentOf<'integration.ff'>);
      } else {
        assert.equal(recovery.recoveredBy, 'reconciled');
        assert.deepEqual(done?.outcome, { kind: 'unpublished', tip: s.tip });
        assert.equal(revOf(s.repo, 'main'), s.tip, 'nothing published on a stale approval');
      }
    }
  });

  it('recovery after the tip advanced past T without the candidate is unpublished (fresh candidate)', async () => {
    const s = scene(base, 'clean');
    const cand = await candidate(s);
    const scenario = { op: 'ff', runDir: s.runDir, repo: s.repo, candidate: cand.op } as const;
    assert.equal(await crashChild8b(scenario, 'ff.act-start', 1), true);
    const moved = advance(s, s.tip);
    git(s.repo, 'update-ref', 'refs/heads/main', moved);
    const journal = openArc(s.runDir);
    const recovery = await recover8b(journal, integrationFfOp(s.repo, always));
    assert.equal(recovery.kind, 'closed');
    assert.deepEqual(journal.view.doneOf(recovery.intent.op)?.outcome, { kind: 'unpublished', tip: moved });
    journal.close();
  });

  it('recovery after later publications on top of the candidate is done published', async () => {
    const s = scene(base, 'clean');
    const cand = await candidate(s);
    const scenario = { op: 'ff', runDir: s.runDir, repo: s.repo, candidate: cand.op } as const;
    assert.equal(await crashChild8b(scenario, 'ff.act-end', 1), true);
    git(s.repo, 'update-ref', 'refs/heads/main', advance(s, cand.post.new));
    const journal = openArc(s.runDir);
    const recovery = await recover8b(journal, integrationFfOp(s.repo, always));
    assert.equal(recovery.kind, 'closed');
    if (recovery.kind !== 'closed') return;
    assert.equal(recovery.recoveredBy, 'reconciled');
    assert.deepEqual(journal.view.doneOf(recovery.intent.op)?.outcome, { kind: 'published' });
    journal.close();
    assert.equal(publications(s, s.tip, s.unit), 1);
  });
});

describe(`matrix row ${CANDIDATE_FF_SNAPSHOT}: integration.ff`, () => {
  const EXPECTED: Readonly<Record<string, 'redone' | 'reconciled'>> = {
    'ff.act-start': 'redone',
    'ff.act-end': 'reconciled',
  };
  const cells = crashCells(CANDIDATE_FF_SNAPSHOT).filter((c) => c.label.startsWith('ff.'));

  it('covers exactly the row\'s ff labels', () => {
    assert.deepEqual(cells.map((c) => c.label).sort(), Object.keys(EXPECTED).sort());
  });

  for (const cell of cells) {
    it(`${cell.boundary} ${cell.label}: ${cell.recovery}`, async () => {
      const s = scene(base, 'clean');
      const cand = await candidate(s);
      const scenario = { op: 'ff', runDir: s.runDir, repo: s.repo, candidate: cand.op } as const;
      assert.equal(await crashChild8b(scenario, cell.label, 1), true, 'the scenario reaches the label');

      const journal = openArc(s.runDir);
      const recovery = await recover8b(journal, integrationFfOp(s.repo, always));
      assert.equal(recovery.kind, 'closed', recovery.kind !== 'closed' ? recovery.detail : '');
      if (recovery.kind !== 'closed') return;
      assert.equal(recovery.recoveredBy, EXPECTED[cell.label]);
      assert.deepEqual(journal.view.doneOf(recovery.intent.op)?.outcome, { kind: 'published' });
      assert.equal(journal.view.openIntents().length, 0);
      journal.close();
      assertPublished(s, recovery.intent as IntentOf<'integration.ff'>);
    });

    it(`${cell.label}: the scenario reaches it exactly once`, async () => {
      const s = scene(base, 'clean');
      const cand = await candidate(s);
      const scenario = { op: 'ff', runDir: s.runDir, repo: s.repo, candidate: cand.op } as const;
      assert.equal(await crashChild8b(scenario, cell.label, 2), false);
      assert.equal(revOf(s.repo, 'main'), cand.post.new);
    });
  }
});
