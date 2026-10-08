// Run 10 (E, F): the close-out settlement (src/holistic/closeout.ts) over a real corpus arc (real git, real processes, the
// fake claude answering lens and checkpoint calls by job, the fake gh as the forge). audit-1's vision lens opens F-1 (P2, no
// obligation) and F-2 (P3 over I-1); ckpt-1 and ckpt-2 each answer an invalid bundle, so ckpt-2 raises a non-blocking
// bundle request. Named tests: closeout.declines-request-and-banks, closeout.declined-ack-refused, and the crash row
// CLOSE_OUT_SETTLEMENT (each label of test/matrix.ts, crashed in a child, settled once by the next).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { NeedsUserId } from '../src/core/ids.ts';
import { runCheckpoint } from '../src/holistic/checkpoint.ts';
import { settleCloseOut } from '../src/holistic/closeout.ts';
import { quiescentGenerations } from '../src/holistic/convergence.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { withForge } from './helpers/corpusarc.ts';
import { checkpointStep, lensStep, twoOpBundleSecondInvalid } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { checkpointContext, completedAudit, factsOfKind } from './fixtures/checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc, forgeEnv } from './fixtures/corpus-holistic.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, contextFor } from './fixtures/unit-common.ts';
import { CLOSE_OUT_SETTLEMENT, crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

/** The story up to ckpt-2's bundle request; the arc closed. Returns the arc and the request's id. */
async function requested(): Promise<Readonly<{ a: CorpusHolisticArc; id: NeedsUserId }>> {
  const a = await corpusHolisticArc([
    lensStep('audit-1', 'vision', [
      { severity: 'P2', claim: 'the berth list never says which berths are free', cause: 'no free filter', evidence: [{ path: 'src/mul.js', line: 1 }] },
      { severity: 'P3', obligation: 'I-1', claim: 'I-1 is witnessed on one berth only', cause: 'one fixture', evidence: [{ path: 'src/mul.js', line: 1 }] },
    ]),
    checkpointStep('ckpt-1', twoOpBundleSecondInvalid()), checkpointStep('ckpt-2', twoOpBundleSecondInvalid()),
  ]);
  const r = contextFor(a.d);
  try {
    const { ctx } = checkpointContext(r);
    await completedAudit(r, ctx);
    const kinds: string[] = [];
    for (const _ of [1, 2]) {
      const out = await withForge(a.forge, () => runCheckpoint(ctx));
      kinds.push(out.kind === 'decided' ? out.decision.kind : out.kind);
    }
    assert.deepEqual(kinds, ['rejected', 'requested']);
    const decided = factsOfKind(r, 'bundle-decided').at(-1)!.outcome;
    assert.equal(decided.kind, 'requested');
    return { a, id: (decided as Extract<typeof decided, { kind: 'requested' }>).needsUser as NeedsUserId };
  } finally {
    r.journal.close();
  }
}

/** What the settlement wrote: the request's amendment and decline, the deferred debt, the findings' last moves. */
function settled(r: ArcRun) {
  const fold = r.journal.view.holistic();
  return {
    amendments: factsOfKind(r, 'corpus-amendment').map((f) => f.source),
    declined: factsOfKind(r, 'needs-user-declined').map((f) => [f.id, f.choice]),
    debt: factsOfKind(r, 'debt-banked').map((f) => [f.bankReason, f.source]),
    findings: fold.findings.map((f) => [f.id, f.state, f.last?.state === 'ruled' ? f.last.by : null]),
  };
}

const expected = (id: NeedsUserId) => ({
  amendments: [{ type: 'request', job: 'ckpt-2', needsUser: id }],
  declined: [[id, 'decline']],
  debt: [['finding-deferred', { type: 'finding', finding: 'F-1' }]],
  findings: [['F-1', 'ruled', { type: 'code', reason: 'close-out' }], ['F-2', 'open', null]],
});

describe('the close-out settlement (run 10, E and F)', () => {
  test('closeout.declines-request-and-banks: the unanswered invalid request (acknowledge or decline offered) is declined with an amendment; the P2 with no obligation is banked and deferred, the P3 over I-1 stays; a second settlement writes nothing', T, async () => {
    const { a, id } = await requested();
    const r = contextFor(a.d);
    try {
      const { ctx } = checkpointContext(r);
      assert.deepEqual(readNeedsUser(r.ctx.runDir, id)?.options.map((o) => o.id), ['acknowledge', 'decline'], 'explicit options on an invalid request');
      const g = factsOfKind(r, 'checkpoint-inputs').at(-1)!.generation;
      const vision = r.journal.view.planApplied()!.visionSha256!;
      assert.equal(quiescentGenerations(r.journal.view, vision).has(g), false, 'the unanswered request holds its generation open');
      assert.equal(settleCloseOut(ctx), true);
      assert.deepEqual(settled(r), expected(id));
      const [amendment] = factsOfKind(r, 'corpus-amendment');
      assert.equal(amendment!.proposal, readNeedsUser(r.ctx.runDir, id)!.summary, 'the request\'s proposal goes to the next Phase 0');
      assert.match(amendment!.why, /nobody answered nu-\d+ by the close-out/);
      assert.equal(quiescentGenerations(r.journal.view, vision).has(g), true, 'declined: its generation is quiescent');
      assert.deepEqual(r.journal.view.ackOf(id), { command: null, choice: 'decline' });
      assert.equal(settleCloseOut(ctx), false, 'idempotent');
      assert.deepEqual(settled(r), expected(id));
    } finally {
      r.journal.close();
    }
  });

  test('closeout.declined-ack-refused: an ack of an item the executor declined is rejected, and nothing is written', T, async () => {
    const { a, id } = await requested();
    const r = contextFor(a.d);
    try {
      const { ctx, w } = checkpointContext(r);
      settleCloseOut(ctx);
      const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'ack', needsUser: id, choice: 'acknowledge' }));
      assert.ok(out.kind === 'rejected' && /declined by the executor at the close-out/.test(out.reason), JSON.stringify(out));
      assert.equal(factsOfKind(r, 'needs-user-acked').length, 0);
    } finally {
      r.journal.close();
    }
  });
});

describe(`matrix row ${CLOSE_OUT_SETTLEMENT}`, () => {
  test('closeout.crash: the settlement crashed at each of the row\'s labels settles once from the log in the next run', { concurrency: true, timeout: 20 * 60_000 }, async (t) => {
    const labels = [...new Set(crashCells(CLOSE_OUT_SETTLEMENT).map((c) => c.label))].sort();
    assert.deepEqual(labels, ['closeout.after-deferred-debt', 'closeout.after-request-amendment']);
    await Promise.all(labels.map((label) => t.test(`${CLOSE_OUT_SETTLEMENT} B4 ${label}#1`, { timeout: 600_000 }, async () => {
      const { a, id } = await requested();
      const trigger = writeTrigger(tmpDir('closeout-crash'), { label, occurrence: 1 });
      const env = forgeEnv(a, { ROADMAP_TEST_CRASH: trigger });
      const first = await runFixture('corpus-job-child.ts', [JSON.stringify(a.d), 'closeout'], { env, timeoutMs: 150_000 });
      assert.equal(first.signal, 'SIGKILL', `killed at ${label}: code ${first.code}, stdout ${first.stdout}, stderr ${first.stderr}`);
      assertFired(trigger);
      const second = await runFixture('corpus-job-child.ts', [JSON.stringify(a.d), 'closeout'], { env, timeoutMs: 150_000 });
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(JSON.parse(second.stdout), { settled: true }, 'the rest settled');
      const r = contextFor(a.d);
      try {
        assert.deepEqual(settled(r), expected(id), 'each write once');
      } finally {
        r.journal.close();
      }
    })));
  });
});
