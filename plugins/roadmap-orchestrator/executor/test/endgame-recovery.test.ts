// dev.83 (WS-7): an endgame landing interrupted and recovered, over the real endgame arc (test/fixtures/endgame-arc.ts).
// The landing is the repair batch's publication with the endgame head as its candidate (src/pipeline/integrate.ts
// `landEndgame`), so it is crashed where the batch's crash cells cross the ff (test/batch.test.ts: `ff.act-start`, before
// the CAS; `ff.act-end`, after it) and after `endgame-landed` (`snapshot.act-end`, in `finishLanding`). The recovery engine
// (src/recover/resource.ts, src/recover/ff.ts) then abandons a landing whose ff did not publish (nothing moves, the slot is
// released) or leaves a published one holding the slot; the endgame job, still running in the episode, resumes as the same
// job and lands or finishes. Named tests: endgame.land-crash.<label>, and endgame.fault-contained (the endgame and batch
// witness jobs are on src/schedule/fault.ts `JOB_FAULT_TRACKS`; a landing holding the slot is shared state).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { INTEGRATION_SLOT, type Sha, jobId } from '../src/core/ids.ts';
import { endgameJobDue } from '../src/endgame/jobs.ts';
import { openEpisode } from '../src/endgame/phase.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { recover } from '../src/recover/recover.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { faultJob, jobFaultOpen } from '../src/schedule/fault.ts';
import { type EndgameRun, F1, R1, endgame, endgameArc, endgameRun, head, runDue } from './fixtures/endgame-arc.ts';
import { closedAs } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import type { ArcDescriptor } from './fixtures/unit-common.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const slotState = (e: EndgameRun): string => resourceTable(e.r.journal.view).get(INTEGRATION_SLOT)?.status.state ?? 'free';
const endgameFfs = (e: EndgameRun): readonly IntentOf<'integration.ff'>[] => e.r.journal.view.opsOf('integration.ff').filter((i) => i.expect.subject?.type === 'endgame');
const ffOutcome = (e: EndgameRun, i: IntentOf<'integration.ff'>) => {
  const done = e.r.journal.view.doneOf(i.op);
  return done?.kind === 'integration.ff' ? done.outcome : null;
};

/**
 * Per label: what recovery leaves (`abandoned`: nothing moved, the slot free; `published`: the integration head is the
 * endgame head, the slot still the landing's) and how it closed the ops the crash left open.
 */
const CELLS: Readonly<Record<string, Readonly<{ after: 'abandoned' | 'published'; landed: boolean; closed: readonly string[] }>>> = {
  // The CAS never happened: an endgame ff is never redone, so it closes unpublished at T and the landing is abandoned.
  'ff.act-start': { after: 'abandoned', landed: false, closed: ['integration.ff:reconciled'] },
  // The CAS happened: the ff closes published; `endgame-landed` is not written yet.
  'ff.act-end': { after: 'published', landed: false, closed: ['integration.ff:reconciled'] },
  // `endgame-landed` written, its snapshot cut short.
  'snapshot.act-end': { after: 'published', landed: true, closed: ['snapshot.publish:reconciled'] },
};

async function crashChild(label: string, d: ArcDescriptor): Promise<void> {
  const trigger = writeTrigger(tmpDir('endgame-crash'), { label, occurrence: 1 });
  const exit = await runFixture('endgame-land-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
  assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
  assertFired(trigger);
}

describe('an interrupted endgame landing (dev.83)', () => {
  for (const [label, expected] of Object.entries(CELLS)) {
    test(`endgame.land-crash.${label}: recovery ${expected.after === 'abandoned' ? 'abandons the landing (nothing moves) and the resumed job lands' : 'keeps the published head and the resumed job finishes the landing'}; endgame-landed is recorded once`, T, async () => {
      const setup = await endgameArc();
      const base = head(setup.d);
      let fix: Sha;
      try {
        fix = setup.commit({ 'src/carry.js': 'export const carry = (a, b) => a + b;\n' }, 'keep the carry');
        assert.equal((await setup.command(endgame({ type: 'fix', closes: [F1, R1], commit: fix, note: 'add() keeps the carry' }))).state, 'applied');
        assert.equal((await setup.command(endgame({ type: 'land' }))).state, 'applied');
      } finally {
        setup.r.journal.close();
      }
      await crashChild(label, setup.d);

      const e = endgameRun(setup.d);
      try {
        const open = e.r.journal.view.openIntents();
        await recover({ stage: e.r.ctx, commands: e.commands });
        assert.deepEqual(closedAs(e.r.journal.view, open), expected.closed, 'the ops the crash left open, as recovery closed them');
        const episode = () => openEpisode(e.r.journal.view)!;
        assert.equal(episode().landings.length, expected.landed ? 1 : 0, 'endgame-landed only once finishLanding wrote it');
        const [first] = endgameFfs(e);
        switch (expected.after) {
          case 'abandoned':
            assert.deepEqual(ffOutcome(e, first!), { kind: 'unpublished', tip: base }, 'the cut-short CAS closed unpublished at T');
            assert.equal(head(e.d), base, 'nothing moved');
            assert.equal(slotState(e), 'free', 'recovery abandons a landing that did not publish');
            break;
          case 'published':
            assert.deepEqual(ffOutcome(e, first!), { kind: 'published' });
            assert.equal(head(e.d), fix, 'the published head is kept');
            assert.notEqual(slotState(e), 'free', 'recovery leaves a published landing holding the slot for finishLanding');
            break;
        }
        assert.deepEqual(e.r.journal.view.openIntents(), []);

        // The landing's job is still running in the episode: it resumes as the same job.
        const due = endgameJobDue(e.h.audit, e.h.laneEnv);
        assert.deepEqual([due?.job, due?.request], ['endgame-1', { type: 'land' }], 'the interrupted job resumes');
        await runDue(e);

        assert.equal(head(e.d), fix, 'the integration head is the endgame head');
        assert.deepEqual(episode().landings.map((l) => [l.job, l.old, l.head]), [['endgame-1', base, fix]], 'endgame-landed recorded once');
        assert.deepEqual(episode().jobs.map((j) => [j.started.job, j.ended?.outcome]), [['endgame-1', 'landed']]);
        const published = endgameFfs(e).filter((i) => ffOutcome(e, i)?.kind === 'published');
        assert.equal(published.length, 1, 'one endgame ff published');
        assert.equal(e.r.journal.view.holistic().findings.find((f) => f.id === F1)?.state, 'resolved', 'the landing holds the fix');
        const snapshots = e.r.journal.view.opsOf('snapshot.publish').filter((i) => i.parent.type === 'job' && i.parent.job === 'endgame-1' && e.r.journal.view.doneOf(i.op) !== null);
        assert.equal(snapshots.length, 1, 'the snapshot after the landing');
        assert.equal(slotState(e), 'free', 'the slot released');
        assert.deepEqual(e.r.journal.view.openIntents(), []);
        assert.equal(endgameJobDue(e.h.audit, e.h.laneEnv)?.request.type ?? null, 'review', 'nothing of the landing is left: the closing step owes its review');
      } finally {
        e.r.journal.close();
      }
    });
  }
});

describe('endgame job faults (dev.83)', () => {
  test('endgame.fault-contained: a throw in an endgame or batch witness job holding only its own state ends it faulted (a non-blocking executor-fault item the holistic track waits on); one whose landing holds the slot crashes', T, async () => {
    const e = await endgameArc();
    try {
      const items = () => e.r.journal.view.opsOf('needsuser.raise').map((i) => readNeedsUser(e.r.ctx.runDir, i.expect.id)!).filter((x) => x.reason === 'executor-fault');
      assert.equal(await faultJob(e.h.audit, 'holistic:endgame-job', new Error('a review threw')), true, 'an endgame job holding nothing shared is contained');
      assert.equal(await faultJob(e.h.audit, 'holistic:witness', new Error('a batch witness threw')), true, 'so is a batch witness job');
      assert.deepEqual(items().map((x) => [x.blocking, x.subject]), [[false, { type: 'arc' }], [false, { type: 'arc' }]]);
      assert.equal(jobFaultOpen(e.r.journal.view, e.r.ctx.runDir), true, 'the holistic track waits for the item');

      // A landing takes the integration slot: a throw then is shared state's, and crashes the executor.
      const grant = await e.h.audit.acquireFirst({ named: [], pools: [], cpu: 0, publication: true }, { type: 'endgame', job: jobId('endgame', 1) }, new AbortController().signal);
      assert.equal(grant.kind, 'granted');
      assert.equal(await faultJob(e.h.audit, 'holistic:endgame-job', new Error('a landing threw')), false, 'a landing holding the slot is not contained');
      assert.equal(await faultJob(e.h.audit, 'holistic:witness', new Error('a batch witness threw')), true, 'another job\'s landing is not the witness job\'s state');
      assert.equal(items().length, 3, 'no item for the uncontained fault');
    } finally {
      e.r.journal.close();
    }
  });
});
