// M4a step C3: a corpus arc's checkpoint amendments and settlement (src/holistic/amendments.ts through checkpoint.ts and
// bundle.ts), over real arcs: real git, real processes, the fake claude answering the lens and checkpoint calls by job.
// Named tests: checkpoint.corpus-inputs, amendment.from-checkpoint, amendment.from-divergence,
// amendment.canonical-rule-order, checkpoint.finding-deferred-banked, tail.p3-released-arc, bundle.split-rule-anchored,
// and the crash cells of the matrix row CORPUS_AMENDMENT.
import assert from 'node:assert/strict';
import { after, before, describe, it, test } from 'node:test';
import type { JsonValue } from '../src/core/json.ts';
import { runCheckpoint } from '../src/holistic/checkpoint.ts';
import { recover } from '../src/recover/recover.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { withForge } from './helpers/corpusarc.ts';
import { VALID_OP, checkpointAnswer, checkpointStep, lensStep } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { type CorpusSpec } from './helpers/corpus.ts';
import { type CallRecord, readCalls } from './helpers/scenario.ts';
import { CORPUS_AMENDMENT, crashCells } from './matrix.ts';
import { checkpointContext, completedAudit, factsOfKind } from './fixtures/checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc, forgeEnv } from './fixtures/corpus-holistic.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, contextFor } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const callOf = (a: CorpusHolisticArc, job: string): CallRecord => {
  const c = readCalls(a.d.scenarioPath).find((x) => x.unit === job);
  assert.ok(c !== undefined, `${job} was called`);
  return c;
};
const callsOf = (a: CorpusHolisticArc, prefix: string): readonly string[] => readCalls(a.d.scenarioPath).flatMap((c) => (c.unit?.startsWith(prefix) ? [c.unit] : []));
const addDirs = (c: CallRecord): readonly string[] => c.argv.flatMap((x, i) => (x === '--add-dir' ? [c.argv[i + 1]!] : []));
/** Whether `path` is inside a call's read surface: one of its `--add-dir`s or below one (2026-10-16: the repository and the run dir hold most). */
const readable = (dirs: readonly string[], path: string): boolean => dirs.some((d) => path === d || path.startsWith(`${d}/`));
const decisions = (r: ArcRun) => factsOfKind(r, 'bundle-decided').map((f) => [f.job, f.outcome.kind === 'rejected' ? `rejected:${f.outcome.reason}` : f.outcome.kind]);

/** The scripted arc with `steps` after audit-1's vision lens (`findings` its findings), audit-1 completed. */
async function arcWith(steps: readonly ReturnType<typeof checkpointStep>[], opts: Readonly<{ findings?: Parameters<typeof lensStep>[2]; corpus?: Partial<CorpusSpec> }> = {}) {
  const a = await corpusHolisticArc([lensStep('audit-1', 'vision', opts.findings ?? []), ...steps], opts.corpus === undefined ? {} : { corpus: opts.corpus });
  const r = contextFor(a.d);
  const { ctx, w } = checkpointContext(r);
  await completedAudit(r, ctx);
  return { a, r, ctx, w };
}

/** The bundle of scenario A: one valid op, two own amendments (T-1, T-2), an interpretation. */
const SCENARIO_A: JsonValue = checkpointAnswer({
  decision: 'bundle', ops: [VALID_OP],
  corpusAmendments: [
    { rules: ['T-1'], proposal: 'Say double-booking is refused at the desk too.', why: 'audit-1 and V-1' },
    { rules: ['T-2'], proposal: 'Name the tide window in every booking.', why: 'audit-1 and V-1' },
  ],
  interpretations: [{ clauses: ['V-1'], situation: 'The vision does not say which berth a late vessel takes.', reading: 'The nearest free one.' }],
});

describe('a corpus arc\'s checkpoint records its amendments once each', T, () => {
  let x: Awaited<ReturnType<typeof arcWith>>;
  before(async () => {
    x = await arcWith([checkpointStep('ckpt-1', SCENARIO_A)]);
    const out = await withForge(x.a.forge, () => runCheckpoint(x.ctx));
    assert.ok(out.kind === 'decided' && out.decision.kind === 'applied', JSON.stringify(out));
  }, T);
  after(() => x.r.journal.close());

  it('amendment.from-divergence: code derives one per interpretation (and target-departed) divergence, none for a plan departure', () => {
    const dv = factsOfKind(x.r, 'divergence').map((d) => [d.id, d.type]);
    assert.deepEqual(dv, [['D-1', 'plan-departed'], ['D-2', 'interpretation']]);
    const all = factsOfKind(x.r, 'corpus-amendment');
    assert.deepEqual(all.map((m) => [m.id, m.source]), [
      ['M-1', { type: 'checkpoint', job: 'ckpt-1', index: 0 }], ['M-2', { type: 'checkpoint', job: 'ckpt-1', index: 1 }], ['M-3', { type: 'divergence', divergence: 'D-2' }],
    ]);
    assert.match(all[2]!.proposal, /The nearest free one/);
    assert.deepEqual(all[2]!.rules, []);
  });
});

const splitOp = (rule: string): JsonValue => ({
  op: 'obligation-split', obligation: 'I-1', cites: ['V-1'], evidence: ['audit-1 found I-1 too coarse'],
  children: [{
    id: 'I-2', statement: 'A berth is never double-booked.', docRef: null, rule, witness: { lane: 'journey', testIds: ['t1'], files: [] }, activation: 'must-hold', deliveredBy: [],
  }],
});

// ---------------------------------------------------------------------------------------------------
// Crash: the amendments after the decision (CORPUS_AMENDMENT)

describe(`matrix row ${CORPUS_AMENDMENT}`, () => {
  for (const cell of crashCells(CORPUS_AMENDMENT)) for (const occurrence of [1, 2, 3]) {
    test(`settlement crashed at ${cell.boundary} ${cell.label}#${occurrence}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const x = await arcWith([]);
      appendSteps(x.a.d, [checkpointStep('ckpt-1', SCENARIO_A)]);
      x.r.journal.close();
      const trigger = writeTrigger(tmpDir('amendment-crash'), { label: cell.label, occurrence });
      const exit = await runFixture('corpus-job-child.ts', [JSON.stringify(x.a.d), 'checkpoint'], { env: forgeEnv(x.a, { ROADMAP_TEST_CRASH: trigger }), timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}#${occurrence}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(x.a.d);
      const { ctx, w } = checkpointContext(r);
      try {
        assert.equal(factsOfKind(r, 'corpus-amendment').length, occurrence, 'killed after that many of the amendment facts');
        await recover({ stage: ctx, commands: w.commands });
        assert.deepEqual(await withForge(x.a.forge, () => runCheckpoint(ctx)), { kind: 'none' }, 'the decision stands; its aftermath is settled');
        assert.deepEqual(factsOfKind(r, 'corpus-amendment').map((m) => [m.id, m.source.type]), [['M-1', 'checkpoint'], ['M-2', 'checkpoint'], ['M-3', 'divergence']], 'each amendment once');
        assert.deepEqual(callsOf(x.a, 'ckpt-'), ['ckpt-1'], 'the recorded call is consumed, never asked again');
        assert.deepEqual(decisions(r), [], 'applied: no bundle-decided, one revision');
        assert.equal(r.journal.view.planApplied()!.rev, 2);
      } finally {
        r.journal.close();
      }
    });
  }
});
