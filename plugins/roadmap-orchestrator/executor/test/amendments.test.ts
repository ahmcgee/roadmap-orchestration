// M4a step C3: a corpus arc's checkpoint amendments and settlement (src/holistic/amendments.ts through checkpoint.ts and
// bundle.ts), over real arcs: real git, real processes, the fake claude answering the lens and checkpoint calls by job.
// Named tests: checkpoint.corpus-inputs, amendment.from-checkpoint, amendment.from-divergence,
// amendment.canonical-rule-order, checkpoint.finding-deferred-banked, tail.p3-released-arc, bundle.split-rule-anchored,
// and the crash cells of the matrix row CORPUS_AMENDMENT.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it, test } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { status } from '../src/status.ts';
import type { JsonValue } from '../src/core/json.ts';
import { debtKey } from '../src/debt/ledger.ts';
import { runCheckpoint } from '../src/holistic/checkpoint.ts';
import { requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { recover } from '../src/recover/recover.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { withForge } from './helpers/corpusarc.ts';
import { VALID_OP, checkpointAnswer, jobRepairStep, checkpointStep, lensStep } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { type CorpusSpec, SAMPLE_DOCS } from './helpers/corpus.ts';
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

  it('checkpoint.corpus-inputs: the inputs name the pin in force; the checkpoint and the lens read the materialised pin', () => {
    const { r, a } = x;
    const [inputs] = factsOfKind(r, 'checkpoint-inputs');
    assert.ok(inputs !== undefined);
    assert.equal(inputs.corpusSha256, a.pinSha256, 'the pin in force');
    assert.equal(inputs.issues, undefined, 'no issue capture');
    const call = callOf(a, 'ckpt-1');
    assert.ok(readable(addDirs(call), join(r.ctx.runDir, 'corpus', a.pinSha256.slice(0, 8))), 'the checkpoint reads the materialised pin');
    const lens = callOf(a, 'audit-1');
    assert.ok(readable(addDirs(lens), join(r.ctx.runDir, 'corpus', a.pinSha256.slice(0, 8))), 'so does the lens');
  });

  it('amendment.from-checkpoint: the checkpoint\'s own proposals are amendments keyed (job, index)', () => {
    const [m1, m2] = factsOfKind(x.r, 'corpus-amendment');
    assert.deepEqual([m1!.id, m1!.source, m1!.rules, m1!.proposal], ['M-1', { type: 'checkpoint', job: 'ckpt-1', index: 0 }, ['T-1'], 'Say double-booking is refused at the desk too.']);
    assert.deepEqual([m2!.id, m2!.source, m2!.rules, m2!.proposal], ['M-2', { type: 'checkpoint', job: 'ckpt-1', index: 1 }, ['T-2'], 'Name the tide window in every booking.']);
  });

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

  it('settling again writes nothing more', async () => {
    const before = factsOfKind(x.r, 'corpus-amendment').length;
    assert.deepEqual(await withForge(x.a.forge, () => runCheckpoint(x.ctx)), { kind: 'none' });
    assert.equal(factsOfKind(x.r, 'corpus-amendment').length, before);
  });
});

// Paid M4a run 7: the checkpoint proposed an amendment of ["T-42","T-120"] (numeric order); the fact's reader compared
// rule ids as strings, so writing it threw and the executor crash-looped. Rule ids order numerically, and the model's
// order never reaches a fact: both proposals are recorded in canonical order.
test('amendment.canonical-rule-order: amendments citing T-42 and T-120, in either order, are recorded ascending by number', T, async () => {
  const corpus = { docs: [...SAMPLE_DOCS, { path: '0030_Tides.md', title: 'Tides', sections: [{ heading: 'Windows', rules: [{ n: 42, text: 'A tide window is two hours.' }, { n: 120, text: 'A late vessel waits for the next window.' }] }] }] };
  const x = await arcWith([checkpointStep('ckpt-1', checkpointAnswer({
    decision: 'no-op',
    corpusAmendments: [
      { rules: ['T-42', 'T-120'], proposal: 'Say how a late vessel is windowed.', why: 'run 7 shape' },
      { rules: ['T-120', 'T-42', 'T-3'], proposal: 'Tie cancellation to tide windows.', why: 'model order' },
    ],
  }))], { corpus });
  try {
    assert.deepEqual(x.a.pin.rules.map((r) => r.id), ['T-1', 'T-2', 'T-3', 'T-42', 'T-120'], 'the pin lists rules by number');
    const out = await withForge(x.a.forge, () => runCheckpoint(x.ctx));
    assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
    assert.deepEqual(factsOfKind(x.r, 'corpus-amendment').map((m) => [m.id, m.rules]), [['M-1', ['T-42', 'T-120']], ['M-2', ['T-3', 'T-42', 'T-120']]]);
  } finally {
    x.r.journal.close();
  }
  const reopened = contextFor(x.a.d);
  try {
    assert.deepEqual(reopened.journal.view.holistic().amendments.map((m) => m.rules), [['T-42', 'T-120'], ['T-3', 'T-42', 'T-120']], 'the log reopens');
  } finally {
    reopened.journal.close();
  }
});

test('checkpoint.finding-deferred-banked: a deferred P2 without an obligation is banked as finding-deferred debt once; one with an obligation never is', T, async () => {
  const x = await arcWith([checkpointStep('ckpt-1', checkpointAnswer({
    decision: 'no-op',
    findingDispositions: [{ finding: 'F-1', disposition: 'deferred', reason: 'not this arc' }, { finding: 'F-2', disposition: 'deferred', reason: 'not this arc' }],
  }))], { findings: [{ severity: 'P2', claim: 'The berth list reads slowly.', cause: 'slow list' }, { severity: 'P2', obligation: 'I-1', claim: 'I-1 is thin.', cause: 'thin I-1' }] });
  const { a, r, ctx } = x;
  try {
    const out = await withForge(a.forge, () => runCheckpoint(ctx));
    assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
    assert.deepEqual(r.journal.view.holistic().findings.map((f) => [f.id, f.state, f.obligation]), [['F-1', 'ruled', null], ['F-2', 'ruled', 'I-1']]);
    assert.deepEqual(r.journal.view.holistic().debt.map(({ seq: _s, ...d }) => d), [{
      kind: 'debt-banked', id: 'B-1', bankReason: 'finding-deferred', what: 'The berth list reads slowly.',
      key: debtKey({ unit: null, bankReason: 'finding-deferred', what: 'The berth list reads slowly.' }), source: { type: 'finding', finding: 'F-1' },
    }]);
    assert.deepEqual(await withForge(a.forge, () => runCheckpoint(ctx)), { kind: 'none' });
    assert.equal(r.journal.view.holistic().debt.length, 1, 'banked once');
  } finally {
    r.journal.close();
  }
});

test('tail.p3-released-arc (dev.13): a P3 the checkpoint defers or leaves is released by code, never banked; a deferred P2 banks; status counts them', T, async () => {
  const x = await arcWith([checkpointStep('ckpt-1', checkpointAnswer({
    decision: 'no-op',
    findingDispositions: [{ finding: 'F-1', disposition: 'deferred', reason: 'slows every later list view' }, { finding: 'F-2', disposition: 'deferred', reason: 'not this arc' }],
  }))], {
    findings: [
      { severity: 'P2', claim: 'The berth list reads slowly.', cause: 'slow list' },
      { severity: 'P3', claim: 'The berth test could also check an empty harbour.', cause: 'berth test: no empty case' },
      { severity: 'P3', claim: 'The tide helper name is vague.', cause: 'tide helper: vague name' },
    ],
  });
  const { a, r, ctx } = x;
  try {
    const out = await withForge(a.forge, () => runCheckpoint(ctx));
    assert.ok(out.kind === 'decided' && out.decision.kind === 'no-op', JSON.stringify(out));
    const ruled = () => r.journal.view.holistic().findings.map((f) => [f.id, f.severity, f.last?.state === 'ruled' ? [f.last.disposition, f.last.by] : null]);
    assert.deepEqual(ruled(), [
      ['F-1', 'P2', ['deferred', { type: 'checkpoint', job: 'ckpt-1' }]],
      ['F-2', 'P3', ['released', { type: 'release', job: 'ckpt-1', reason: 'p3' }]],
      ['F-3', 'P3', ['released', { type: 'release', job: 'ckpt-1', reason: 'p3' }]],
    ]);
    assert.deepEqual(r.journal.view.holistic().debt.map((d) => d.source), [{ type: 'finding', finding: 'F-1' }], 'only the P2 banks');
    const s = status(absPath(a.d.runDir), arcId(a.d.arc), absPath(a.d.hostDir));
    assert.deepEqual([s.findings.released, s.findings.refusedAdmits], [{ checkpoint: 0, p3: 2, regress: 0, settled: 0, closeOut: 0 }, { regress: 0, settled: 0 }]);
    assert.deepEqual(await withForge(a.forge, () => runCheckpoint(ctx)), { kind: 'none' });
    assert.deepEqual(ruled(), [
      ['F-1', 'P2', ['deferred', { type: 'checkpoint', job: 'ckpt-1' }]],
      ['F-2', 'P3', ['released', { type: 'release', job: 'ckpt-1', reason: 'p3' }]],
      ['F-3', 'P3', ['released', { type: 'release', job: 'ckpt-1', reason: 'p3' }]],
    ], 'settled once');
  } finally {
    r.journal.close();
  }
});

const splitOp = (rule: string): JsonValue => ({
  op: 'obligation-split', obligation: 'I-1', cites: ['V-1'], evidence: ['audit-1 found I-1 too coarse'],
  children: [{
    id: 'I-2', statement: 'A berth is never double-booked.', docRef: null, rule, witness: { lane: 'journey', testIds: ['t1'], files: [] }, activation: 'must-hold', deliveredBy: [],
  }],
});

test('bundle.split-rule-anchored: a split child anchored at a rule takes its hash from the pin in force and is counted through its parent\'s census entry; an unpinned rule is invalid', T, async () => {
  const x = await arcWith([
    checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [splitOp('T-99')] })),
    jobRepairStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [splitOp('T-99')] }), ['T-99']),
    checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [splitOp('T-1')] })),
  ]);
  const { a, r, ctx } = x;
  try {
    const first = await withForge(a.forge, () => runCheckpoint(ctx));
    assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'invalid', JSON.stringify(first));
    assert.match(first.decision.detail, /child I-2 is anchored at T-99, which is no active rule of the pin in force/);
    const second = await withForge(a.forge, () => runCheckpoint(ctx));
    assert.ok(second.kind === 'decided' && second.decision.kind === 'applied', JSON.stringify(second));
    const obligations = revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view)).obligations!.value;
    const t1 = a.pin.rules.find((x) => x.id === 'T-1')!;
    const byId = new Map(obligations.obligations.map((o) => [o.id as string, o]));
    assert.deepEqual(byId.get('I-2')?.rule, { id: 'T-1', textSha256: t1.textSha256 });
    assert.equal(byId.get('I-1')?.state.type, 'split');
    assert.deepEqual(obligations.census?.find((e) => e.rule === 'T-1')?.state, { type: 'obligation', id: 'I-1' }, 'the census is Phase 0\'s: unchanged');
  } finally {
    r.journal.close();
  }
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
