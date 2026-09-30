// M3 step B2: a repair batch's publication (src/pipeline/integrate.ts `publishBatch`, src/git/{candidate,ff}.ts; R7, G5,
// H4), over real arcs (real git, real processes, fake backends and witness lanes). Named tests: batch.job-lanes,
// batch.teardown-fail-restart (H4), batch.stale-member, and the crash cells of the matrix row BATCH_PUBLICATION
// (test/matrix.ts), recovered by the recovery engine.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact, IntentOf } from '../src/core/events.ts';
import { INTEGRATION_SLOT, jobId, sha, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { readResidues } from '../src/host/residues.ts';
import { verifySnapshot } from '../src/git/snapshot.ts';
import { createProber } from '../src/park/probe.ts';
import { finishBatch } from '../src/pipeline/integrate.ts';
import { recover } from '../src/recover/recover.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { readHostSample } from '../src/host/sample.ts';
import { profileName } from '../src/routing/types.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { BATCH_PUBLICATION, crashCells } from './matrix.ts';
import { approveBoth, batchArc, publish } from './fixtures/batch-common.ts';
import { wire } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, contextFor } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const BATCH = jobId('batch', 1);

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const slotState = (r: ArcRun): string => resourceTable(r.journal.view).get(INTEGRATION_SLOT)?.status.state ?? 'free';
const batchFfs = (r: ArcRun): readonly IntentOf<'integration.ff'>[] => r.journal.view.opsOf('integration.ff').filter((i) => i.expect.subject?.type === 'batch');
const parentsOf = (repo: string, commit: string): readonly string[] => git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);

/** What a published batch leaves: one chain on the tip, both members retired by the one ff, the snapshot, the slot free. */
function assertPublished(r: ArcRun, tip: string): void {
  const [cand, ...moreCands] = r.journal.view.opsOf('candidate.merge').filter((i) => i.expect.batch !== undefined && r.journal.view.doneOf(i.op) !== null).slice(-1);
  assert.ok(cand !== undefined && moreCands.length === 0);
  const batch = cand.expect.batch!;
  assert.equal(batch.job, BATCH);
  assert.deepEqual(batch.members.map((m) => m.unit), ['u1', 'u2']);
  const head = git(r.d.repo, 'rev-parse', 'main');
  assert.equal(head, cand.post.new, 'integration is at the last merge of the chain');
  assert.deepEqual(parentsOf(r.d.repo, head), [batch.chain[0]!.parents[0], batch.members[1]!.unitCommit]);
  assert.deepEqual(parentsOf(r.d.repo, batch.chain[0]!.parents[0]), [tip, batch.members[0]!.unitCommit], 'the first merge sits on the tip');
  const ffs = batchFfs(r).filter((i) => r.journal.view.doneOf(i.op)?.kind === 'integration.ff');
  const published = ffs.filter((i) => { const d = r.journal.view.doneOf(i.op); return d?.kind === 'integration.ff' && d.outcome.kind === 'published'; });
  assert.equal(published.length, 1, 'one batch ff published');
  assert.deepEqual(published[0]!.expect.subject, { type: 'batch', job: BATCH });
  for (const u of ['u1', 'u2']) assert.equal(r.journal.view.unit(unitId(u)).status, 'retired', `${u} retired by the batch ff`);
  const pubs = r.journal.view.publications().map((p) => p.unit);
  assert.deepEqual(pubs.slice(-2), ['u1', 'u2']);
  const snap = r.journal.view.opsOf('snapshot.publish').find((i) => i.parent.type === 'job' && i.parent.job === BATCH && r.journal.view.doneOf(i.op) !== null);
  assert.ok(snap !== undefined, 'the snapshot after the batch');
  assert.equal(verifySnapshot(absPath(r.d.repo), sha(git(r.d.repo, 'rev-parse', `refs/roadmap/${r.d.arc}`))).kind, 'verified');
  assert.equal(slotState(r), 'free');
  assert.deepEqual(r.journal.view.openIntents(), []);
}

describe('repair batches (R7, G5, H4)', () => {
  test('batch.job-lanes: two approved units repairing one finding publish as one chained candidate; the suite and journey lanes run under job{batch-1}; the ff retires both', T, async () => {
    const { d } = batchArc();
    const r = contextFor(d);
    try {
      await approveBoth(r);
      const tip = git(d.repo, 'rev-parse', 'main');
      const outcome = await publish(r);
      assert.deepEqual(outcome, { kind: 'published', job: BATCH, head: git(d.repo, 'rev-parse', 'main') });
      assertPublished(r, tip);
      const lanes = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey');
      assert.deepEqual(lanes.map((i) => [i.expect.subject.purpose === 'journey' ? i.expect.subject.lane : '', i.parent]), [
        ['suite', { type: 'job', job: BATCH }], ['journey', { type: 'job', job: BATCH }],
      ]);
      assert.deepEqual(facts(r).flatMap((f) => (f.kind === 'witnessed' ? [f.for] : [])), [{ type: 'job', job: BATCH }]);
      const slotHolders = r.journal.view.opsOf('resource.transition').filter((i) => i.expect.resources.includes(INTEGRATION_SLOT)).map((i) => [i.expect.holder, i.parent]);
      assert.deepEqual(slotHolders[0], [{ type: 'batch', finding: 'F-1', attempt: 1 }, { type: 'job', job: BATCH }], 'the slot is the batch\'s, reserved for its job');
    } finally {
      r.journal.close();
    }
  });

  test('batch.stale-members: members whose approvals no longer hold at the tip (a cited contract moved) stop the batch before its ff: stale, both named, nothing published', T, async () => {
    const { d } = batchArc();
    const r = contextFor(d);
    try {
      await approveBoth(r);
      // The tip moves on with the contract both members' approvals bind.
      git(d.repo, 'checkout', '-q', 'main');
      writeFileSync(join(d.repo, 'contracts', 'api.md'), `${git(d.repo, 'show', 'main:contracts/api.md')}\nRevised.\n`);
      git(d.repo, 'commit', '-q', '-am', 'revise the contract');
      const tip = git(d.repo, 'rev-parse', 'main');
      const outcome = await publish(r);
      assert.deepEqual(outcome, { kind: 'stale', job: BATCH, invalid: ['u1', 'u2'] });
      assert.equal(git(d.repo, 'rev-parse', 'main'), tip);
      assert.deepEqual(batchFfs(r), []);
      assert.equal(slotState(r), 'free');
    } finally {
      r.journal.close();
    }
  });

  test('batch.repair-not-held: a batch whose repaired obligation does not hold on its candidate is red (the repair\'s, never base-red though the tip fails it too), every member attributable; nothing published', T, async () => {
    const { d } = batchArc({ t2: 'fail' });
    const r = contextFor(d);
    try {
      await approveBoth(r);
      const tip = git(d.repo, 'rev-parse', 'main');
      assert.deepEqual(await publish(r), { kind: 'red', job: BATCH, attributable: ['u1', 'u2'] });
      assert.equal(git(d.repo, 'rev-parse', 'main'), tip);
      assert.deepEqual(batchFfs(r), []);
      assert.equal(slotState(r), 'free');
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      r.journal.close();
    }
  });

  test('batch.teardown-fail-restart: a batch lane\'s failed teardown leaves a job-owned residue (no verdict, slot released); after a restart the residue is reclaimed by the job\'s holder and the batch runs again as the same job and publishes', T, async () => {
    const { d, state } = batchArc({ estate: true });
    writeFileSync(join(state, 'estate.teardown-fails-once'), '');
    let r = contextFor(d);
    try {
      await approveBoth(r);
      const tip = git(d.repo, 'rev-parse', 'main');
      const first = await publish(r);
      assert.equal(first.kind, 'no-verdict', JSON.stringify(first));
      assert.ok(first.kind === 'no-verdict' && first.end.kind === 'cleanup-failed');
      assert.equal(slotState(r), 'free', 'the batch released the slot');
      const [key] = readResidues(absPath(d.hostDir)).flatMap((l) => (l.type === 'residue' ? [l.key] : []));
      assert.deepEqual([key?.job, key?.unit], [BATCH, undefined], 'the residue is owned by the batch\'s job');
      r.journal.close();

      // A restart: recovery leaves the instance cleanup-failed; its probe reclaims it under job{batch-1}.
      r = contextFor(d);
      const w = wire(r);
      await recover({ stage: r.ctx, commands: { ...w.commands } });
      const prober = createProber({ ...r.ctx, profile: profileName('default', 'profile'), sample: readHostSample });
      const due = prober.due(r.journal.view, new Date());
      assert.equal(due.length, 1, JSON.stringify(due));
      assert.equal(await prober.run(due[0]!, new AbortController().signal), 'pass');
      const second = await publish(r);
      assert.equal(second.kind, 'published', JSON.stringify(second));
      assertPublished(r, tip);
      const attempts = r.journal.view.opsOf('resource.transition').flatMap((i) => (i.expect.holder.type === 'batch' && i.expect.edge.type === 'reserve' ? [[i.expect.holder.attempt, i.parent]] : []));
      assert.deepEqual(attempts, [[1, { type: 'job', job: BATCH }], [2, { type: 'job', job: BATCH }]], 'one durable job, two attempts');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash: the batch publication (the matrix row BATCH_PUBLICATION)

/** The expected state after recovery per label: `published` (the ff published; finishBatch completes it) or `again`. */
const AFTER: Readonly<Record<string, 'published' | 'again'>> = {
  'resource.after-intent': 'again', 'candidate.act-start': 'again', 'candidate.after-commit-tree': 'again', 'batch.after-candidate': 'again',
  'ff.act-start': 'again', 'ff.act-end': 'published', 'snapshot.act-end': 'published',
};

async function crashChild(label: string, d: ArcDescriptor): Promise<void> {
  const trigger = writeTrigger(tmpDir('batch-crash'), { label, occurrence: 1 });
  const exit = await runFixture('batch-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
  assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
  assertFired(trigger);
}

describe(`matrix row ${BATCH_PUBLICATION}`, () => {
  for (const cell of crashCells(BATCH_PUBLICATION)) {
    test(`batch crashed at ${cell.boundary} ${cell.label}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const { d } = batchArc();
      const setup = contextFor(d);
      const tip = git(d.repo, 'rev-parse', 'main');
      await approveBoth(setup);
      setup.journal.close();
      await crashChild(cell.label, d);
      const r = contextFor(d);
      const w = wire(r);
      try {
        await recover({ stage: r.ctx, commands: w.commands });
        const expected = AFTER[cell.label];
        if (expected === undefined) throw new Error(`no expectation for ${cell.label}`);
        if (expected === 'published') {
          assert.equal(slotState(r) === 'free', false, 'recovery leaves a published batch holding the slot for finishBatch');
          assert.equal((await finishBatch(r.ctx)).kind, 'published');
        } else {
          assert.equal(slotState(r), 'free', 'recovery abandons a batch that did not publish');
          assert.equal((await publish(r)).kind, 'published');
        }
        assertPublished(r, tip);
      } finally {
        r.journal.close();
      }
    });
  }
});
