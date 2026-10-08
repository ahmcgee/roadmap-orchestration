// M3 step B3: findings and repair over real arcs (real git, real processes, fake backends and witness lanes scripted per
// tree). Named tests: reproduce.reproduced, reproduce.not-reproduced, reproduce.inapplicable, mutant.kill-in-candidate,
// mutant.survivor-red, p1.blocks-selecting, p1.repair-exempt, p1.opened-mid-candidate-blocks-ff (G10), repair.batch
// (R7 with B2's publishBatch), findings.plan-check-vision-conflict (R17), plancheck.reads-captured-spec, and the crash
// cells of the matrix rows FF_ELIGIBILITY and MUTANT_APPLY (test/matrix.ts), recovered by the recovery engine.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact, IntentOf } from '../src/core/events.ts';
import { findingId, jobId, sha, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { mutantSubjectDefault } from '../src/core/upgrade.ts';
import { absPath } from '../src/core/values.ts';
import { verifySnapshot } from '../src/git/snapshot.ts';
import { batchable, findingMetrics, openFinding, ruleFinding } from '../src/holistic/findings.ts';
import { SPEC_INPUT, inputPath } from '../src/input/inforce.ts';
import { publishBatch } from '../src/pipeline/integrate.ts';
import { observations } from '../src/pipeline/lanes.ts';
import { repairUnits, specFacts } from '../src/pipeline/reproduce.ts';
import { planCheck } from '../src/pipeline/stages.ts';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { admitter } from '../src/schedule/ready.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { FF_ELIGIBILITY, MUTANT_APPLY, crashCells } from './matrix.ts';
import type { Step } from './helpers/scenario.ts';
import { scriptTree } from './helpers/witness.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { wire } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep, started } from './fixtures/stage-common.ts';
import {
  MAPPED, MUTANT_PATCH, STALE_PATCH, STRICT_TEST, buildOf, openBefore, tipOf, treeWith, vacuityArc, vacuityDraft as vacuityDraftOf, witnessDraft,
} from './fixtures/repair-common.ts';
import { type ArcRun, U1, applyBody, codexStep, commandContextFor, contextFor, gateStep, mulBuild, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const V1 = unitId('v1');
const F1 = findingId('F-1');

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const mutantRuns = (r: ArcRun): readonly IntentOf<'proc.spawn'>[] => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'mutant');
const mutantWitnessed = (r: ArcRun) => facts(r).flatMap((f) => (f.kind === 'witnessed' && f.purpose === 'mutant' ? [f] : []));
const moves = (r: ArcRun): readonly string[] => facts(r).flatMap((f) => (f.kind === 'finding-transition' ? [`${f.id}:${f.to.state}${'unit' in f.to ? `{${f.to.unit}}` : ''}`] : []));
const finding = (r: ArcRun, id = F1) => r.journal.view.holistic().findings.find((f) => f.id === id)!;
const worktrees = (r: ArcRun): readonly string[] => git(r.d.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ') && l.includes('.mutant-'));

describe('vacuity repairs: reproduce and acceptance', () => {
  test('reproduce.reproduced + mutant.kill-in-candidate: the mutant survives the old witness at the tip (reproduced, on to plan-check); the candidate kills it; the repair publishes and resolves its finding', T, async () => {
    const { d, control } = vacuityArc();
    const tip = tipOf(d);
    const patchedTip = treeWith(d.repo, tip, {}, MUTANT_PATCH);
    const r = contextFor(d);
    try {
      assert.equal(specFacts(r.ctx)(r.unit('v1')).reproduces, true, 'a vacuity repair reproduces first');
      await step(r.ctx, r.unit('v1'));
      assert.deepEqual(outcomes(d, 'v1'), ['reproduce:reproduced']);
      assert.equal(finding(r).state, 'owned', 'the repair owns its finding');
      // The run: the patched tree's real id, purpose mutant, for the finding at the tip; the worktree gone.
      const [w] = mutantWitnessed(r);
      assert.ok(w !== undefined);
      assert.deepEqual([w.treeSha, w.for, w.lane], [patchedTip, { type: 'mutant', finding: 'F-1', of: tip }, 'journey']);
      const [spawn] = mutantRuns(r);
      assert.deepEqual(spawn!.expect.subject, { purpose: 'mutant', of: { type: 'finding', finding: 'F-1' }, lane: 'journey', laneRev: w.laneRev, tree: patchedTip });
      assert.deepEqual(spawn!.parent, { type: 'stage', unit: 'v1', stage: 'reproduce', attempt: 1 });
      const apply = r.journal.view.opsOf('mutant.apply')[0]!;
      assert.deepEqual([apply.expect.at, mutantSubjectDefault(apply.expect), r.journal.view.doneOf(apply.op)?.kind === 'mutant.apply' && r.journal.view.doneOf(apply.op)?.outcome], [tip, { type: 'finding', finding: 'F-1' }, { kind: 'applied', tree: patchedTip }]);
      assert.deepEqual(worktrees(r), [], 'the mutant worktree is removed');
      assert.equal([...observations(r.ctx).values()].some((o) => o.key.treeSha === patchedTip), false, 'a mutant run never certifies (G13)');
      assert.equal(specFacts(r.ctx)(r.unit('v1')).reproduces, true);

      // The candidate: its mutant killed by the strict test (scripted: t1 fails on the patched candidate tree).
      scriptTree(control, treeWith(d.repo, tip, STRICT_TEST, MUTANT_PATCH), { outcomes: { t1: 'fail' } });
      assert.deepEqual(await runUnit(r.ctx, r.unit('v1'), admitAll), { kind: 'merged' }, outcomes(d, 'v1').join(' '));
      assert.deepEqual(outcomes(d, 'v1'), ['reproduce:reproduced', 'plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed',
        'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published']);
      const candidate = r.journal.view.opsOf('candidate.merge').at(-1)!.post.new;
      const kill = mutantWitnessed(r).at(-1)!;
      assert.deepEqual([kill.for, kill.treeSha], [{ type: 'mutant', finding: 'F-1', of: candidate }, treeWith(d.repo, tip, STRICT_TEST, MUTANT_PATCH)]);
      assert.deepEqual(moves(r), ['F-1:owned{v1}', 'F-1:fixed-on-branch{v1}', 'F-1:resolved']);
      const [metric] = findingMetrics(readJournal(r.ctx.runDir, r.journal.view.arc).events, r.journal.view.holistic().findings);
      assert.deepEqual([metric!.lens, metric!.severity, metric!.merged, metric!.disposition, metric!.gateHadPassed], ['vacuity', 'P2', true, null, true]);
      assert.ok(metric!.timeToResolveMs !== null && metric!.timeToResolveMs >= 0);
      assert.deepEqual(worktrees(r), []);
      // The snapshot carries the patch and both mutant records, and verifies.
      assert.equal(verifySnapshot(absPath(d.repo), sha(git(d.repo, 'rev-parse', `refs/roadmap/${d.arc}`))).kind, 'verified');
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      r.journal.close();
    }
  });

  test('reproduce.not-reproduced: the old witness already kills the mutant at the tip: the repair parks (not-reproduced) and code dismisses its finding, once', T, async () => {
    const { d, control } = vacuityArc();
    scriptTree(control, treeWith(d.repo, tipOf(d), {}, MUTANT_PATCH), { outcomes: { t1: 'fail' } });
    const r = contextFor(d);
    try {
      const s = await step(r.ctx, r.unit('v1'));
      assert.equal(s.kind, 'parked');
      assert.equal(s.kind === 'parked' && s.needsUser.reason, 'not-reproduced');
      assert.match(s.kind === 'parked' ? s.needsUser.summary : '', /code dismissed F-1/);
      assert.deepEqual(outcomes(d, 'v1'), ['reproduce:not-reproduced']);
      assert.deepEqual(moves(r), ['F-1:owned{v1}', 'F-1:ruled']);
      assert.deepEqual(finding(r).last, { state: 'ruled', disposition: 'dismissed', by: { type: 'code', reason: 'not-reproduced' } });
      assert.equal(r.journal.view.unit(V1).status, 'park-pending');
      assert.equal(specFacts(r.ctx)(r.unit('v1')).reproduces, false, 'its finding dismissed, it reproduces nothing any more');
      // Re-reading the log writes nothing twice.
      assert.equal((await step(r.ctx, r.unit('v1'))).kind, 'parked');
      assert.deepEqual(moves(r), ['F-1:owned{v1}', 'F-1:ruled']);
      assert.deepEqual(worktrees(r), []);
      // A dismissed finding is not raised again without new evidence.
      assert.deepEqual(openFinding(r.journal, { ...vacuityDraftOf(r.ctx.runDir), source: { type: 'job', job: jobId('audit', 2) } }), { kind: 'suppressed', by: 'F-1' });
    } finally {
      r.journal.close();
    }
  });

  test('reproduce.inapplicable: a mutant whose patch no longer applies at the tip: the repair parks (inapplicable, reason not-reproduced) and the finding stays for the next audit', T, async () => {
    const { d } = vacuityArc({ patch: STALE_PATCH });
    const r = contextFor(d);
    try {
      const s = await step(r.ctx, r.unit('v1'));
      assert.equal(s.kind, 'parked');
      assert.match(s.kind === 'parked' ? s.needsUser.summary : '', /could not be reproduced .*the patch does not apply/);
      assert.deepEqual(outcomes(d, 'v1'), ['reproduce:inapplicable']);
      const apply = r.journal.view.opsOf('mutant.apply')[0]!;
      assert.equal(r.journal.view.doneOf(apply.op)?.kind === 'mutant.apply' && r.journal.view.doneOf(apply.op)?.outcome.kind, 'inapplicable');
      assert.deepEqual(mutantRuns(r), [], 'no lane ran');
      assert.equal(finding(r).state, 'owned', 'still active: the next audit re-evaluates it');
      assert.deepEqual(worktrees(r), []);
    } finally {
      r.journal.close();
    }
  });

  test('mutant.survivor-red: a candidate that does not kill the mutant is red (charged); the fix round names the mutant and its patch; the next candidate kills it', T, async () => {
    const strict2 = { 'test/strict2.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/add.js';\n\ntest('add is not subtraction', () => {\n  assert.equal(add(2, 3), 5);\n});\n" };
    const { d, control } = vacuityArc({
      more: [codexStep([{ type: 'commit', message: 'kill the mutant', files: strict2 }], { argv: ['exec', 'resume'], stdinContains: ['must kill the mutant of F-1', '+  return a - b;'] }), gateStep({ decision: 'approve' })],
    });
    const tip = tipOf(d);
    scriptTree(control, treeWith(d.repo, tip, { ...STRICT_TEST, ...strict2 }, MUTANT_PATCH), { outcomes: { t1: 'fail' } });
    const r = contextFor(d);
    try {
      assert.deepEqual(await runUnit(r.ctx, r.unit('v1'), admitAll), { kind: 'merged' }, outcomes(d, 'v1').join(' '));
      const o = outcomes(d, 'v1');
      assert.deepEqual(o.filter((x) => x.startsWith('candidate:')), ['candidate:red', 'candidate:green']);
      const red = facts(r).find((f) => f.kind === 'stage-outcome' && f.stage === 'candidate' && f.outcome === 'red');
      assert.equal(red?.kind === 'stage-outcome' && red.chargeable, true, 'a survivor is charged');
      const kills = mutantWitnessed(r);
      assert.equal(kills.length, 3, 'reproduce, the red candidate, the green one');
      assert.deepEqual(moves(r), ['F-1:owned{v1}', 'F-1:fixed-on-branch{v1}', 'F-1:owned{v1}', 'F-1:fixed-on-branch{v1}', 'F-1:resolved'],
        'the red candidate voids the approval: owned again until the next gate');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// P1 blocking (G10) and repair

const DIV = {
  'src/div.js': 'export function div(a, b) {\n  return a / b;\n}\n',
  'test/div.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { div } from '../src/div.js';\n\ntest('div', () => {\n  assert.equal(div(6, 3), 2);\n});\n",
};
const DIV_LANE = { id: 'div', argv: ['node', '--test', 'test/div.test.js'] } as const;
const keyed = (unit: string, s: Step): Step => ({ ...s, unit });
const unitSteps = (unit: string, build: Step): readonly Step[] => [
  keyed(unit, planCheckStep({ decision: 'approve' })), keyed(unit, build), keyed(unit, gateStep({ decision: 'approve' })),
];

describe('P1 blocking and repair (G10, R6, R7)', () => {
  test('p1.blocks-selecting + p1.repair-exempt: an open P1 over I-1 holds every candidate selecting I-1 (admission and before green, uncharged) but its declared repair, which publishes with I-1 held and resolves it; then the others publish', T, async () => {
    const { d } = holisticArc({
      steps: [...unitSteps('u1', mulBuild()), ...unitSteps('r1', buildOf(DIV, 'add div'))],
      units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'r1', origin: 'repair', repairs: ['F-1'], obligations: ['I-1'], lanes: [DIV_LANE] }],
      obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED, trees: { '*': { outcomes: { t1: 'pass' } } },
      beforeStart: openBefore(witnessDraft('I-1')),
    });
    const r = contextFor(d);
    try {
      const admit = (unit: string) => admitter((u) => r.ctx.routing(u).table, specFacts(r.ctx))({
        view: r.journal.view, plan: r.ctx.plan(), unit: r.unit(unit), stage: 'candidate', blocking: [], drains: [], tripped: [],
      });
      await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      assert.deepEqual(admit('u1'), { kind: 'wait', constraints: [{ type: 'finding-blocked', finding: 'F-1', obligation: 'I-1' }] }, 'held at admission');
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(d, 'u1').at(-1), 'candidate:finding-blocked', 'and before green');
      assert.equal(r.journal.view.unit(unitId('u1')).counters.chargeableFailures, 0, 'uncharged');
      assert.deepEqual([finding(r).state, finding(r).owner], ['owned', 'r1'], 'the planned repair owns it before it starts');

      await stepUntil(r, 'r1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      assert.equal(finding(r).state, 'fixed-on-branch', 'R5: its owner\'s gate approved');
      assert.deepEqual(admit('r1'), { kind: 'admit' }, 'the declared repair is admitted');
      assert.deepEqual(await runUnit(r.ctx, r.unit('r1'), admitAll), { kind: 'merged' }, outcomes(d, 'r1').join(' '));
      assert.deepEqual(moves(r), ['F-1:owned{r1}', 'F-1:fixed-on-branch{r1}', 'F-1:resolved']);
      const witnessed = facts(r).flatMap((f) => (f.kind === 'witnessed' && f.for.type === 'candidate' && f.for.unit === 'r1' ? [f] : []));
      assert.equal(witnessed.length, 1, 'the repair\'s candidate witnessed I-1 held with integrated evidence');

      assert.deepEqual(admit('u1'), { kind: 'admit' });
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d, 'u1').join(' '));
      assert.deepEqual(r.journal.view.publications().map((p) => p.unit), ['r1', 'u1']);
    } finally {
      r.journal.close();
    }
  });

  test('p1.opened-mid-candidate-blocks-ff: a P1 opened after the candidate went green blocks the unit\'s ff before its intent (cas-stale); the fresh candidate records finding-blocked; once ruled, it publishes', T, async () => {
    const { d } = holisticArc({
      steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
      units: [{ id: 'u1', obligations: ['I-1'] }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED, trees: { '*': { outcomes: { t1: 'pass' } } },
    });
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
      assert.deepEqual(openFinding(r.journal, witnessDraft('I-1')), { kind: 'opened', id: 'F-1' });
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(d, 'u1').at(-1), 'ff:cas-stale', 'the eligibility re-check runs before the ff intent');
      assert.deepEqual(r.journal.view.opsOf('integration.ff'), [], 'no ff was begun');
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(d, 'u1').at(-1), 'candidate:finding-blocked');
      ruleFinding(r.journal, F1, 'dismissed', { type: 'checkpoint', job: jobId('ckpt', 1) });
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.equal(r.journal.view.unit(unitId('u1')).counters.chargeableFailures, 0);
    } finally {
      r.journal.close();
    }
  });

  test('repair.batch: two approved units repairing one P1 are batchable; B2\'s publishBatch publishes them as one chained candidate; the one ff retires both and resolves the finding (git truth)', T, async () => {
    const { d } = holisticArc({
      steps: [...unitSteps('u1', mulBuild()), ...unitSteps('u2', buildOf(DIV, 'add div'))],
      units: [
        { id: 'u1', origin: 'repair', repairs: ['F-1'], obligations: ['I-1'] },
        { id: 'u2', origin: 'repair', repairs: ['F-1'], obligations: ['I-1'], lanes: [DIV_LANE] },
      ],
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'] }],
      mapping: [...MAPPED, { pattern: 'lib/**', obligations: ['I-2'] }], trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
      beforeStart: openBefore(witnessDraft('I-2')),
    });
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      await stepUntil(r, 'u2', (f) => f.stage === 'gate' && f.outcome === 'approve');
      assert.deepEqual([finding(r).state, finding(r).owner], ['fixed-on-branch', 'u1'], 'the first repairer owns it');
      assert.deepEqual(batchable(r.journal.view.holistic().findings, repairUnits(r.ctx)), [{ finding: 'F-1', units: ['u1', 'u2'] }]);
      const tip = tipOf(d);
      const w = wire(r);
      const outcome = await publishBatch({ ...r.ctx, acquireFirst: w.arbiter.acquireFirst }, F1, [r.unit('u1'), r.unit('u2')]);
      const head = tipOf(d);
      assert.deepEqual(outcome, { kind: 'published', job: jobId('batch', 1), head });
      // Git truth: a first-parent chain of two --no-ff merges on the tip, one per member.
      const parents = (c: string): readonly string[] => git(d.repo, 'rev-list', '--parents', '-n', '1', c).split(' ').slice(1);
      const [first, second] = parents(head);
      assert.equal(second, git(d.repo, 'rev-parse', `refs/heads/roadmap/${d.arc}/u2`));
      assert.deepEqual(parents(first!), [tip, git(d.repo, 'rev-parse', `refs/heads/roadmap/${d.arc}/u1`)]);
      for (const u of ['u1', 'u2']) assert.equal(r.journal.view.unit(unitId(u)).status, 'retired');
      assert.deepEqual(moves(r), ['F-1:owned{u1}', 'F-1:fixed-on-branch{u1}', 'F-1:resolved']);
      const snap = r.journal.view.opsOf('snapshot.publish').filter((i) => i.parent.type === 'job').at(-1)!;
      const resolvedSeq = readJournal(r.ctx.runDir, r.journal.view.arc).events.find((e) => e.type === 'fact' && e.fact.kind === 'finding-transition' && e.fact.to.state === 'resolved')!.seq;
      assert.ok(resolvedSeq < Number(snap.op.slice(snap.op.lastIndexOf('/') + 1)), 'resolved before the batch\'s snapshot');
      assert.equal(findingMetrics(readJournal(r.ctx.runDir, r.journal.view.arc).events, r.journal.view.holistic().findings)[0]!.merged, true);
      assert.equal(verifySnapshot(absPath(d.repo), sha(git(d.repo, 'rev-parse', `refs/roadmap/${d.arc}`))).kind, 'verified');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash: the eligibility half of a unit ff's redo (G10; src/pipeline/integrate.ts `unitRedo`, src/recover/ff.ts). The cells
// are the matrix row's (test/matrix.ts FF_ELIGIBILITY): u1 (selecting I-1) run by a child (unit-child.ts) to its ff and
// crashed there; while no executor runs a P1 over I-1 is opened (or not: the control); then the recovery engine, then
// the unit driver in process.

describe(`matrix row ${FF_ELIGIBILITY}`, () => {
  const cells = crashCells(FF_ELIGIBILITY);
  type Case = Readonly<{ label: string; p1: boolean; name: string }>;
  const CASES: readonly Case[] = [
    { label: 'ff.act-start', p1: true, name: 'ff-eligibility.p1-blocks-redo: the CAS never happened and a P1 over I-1 opened while down: the ff is done unpublished at T (reconciled), never redone; the driver records ff:cas-stale, its fresh candidate finding-blocked, and nothing publishes until the P1 is ruled' },
    { label: 'ff.act-start', p1: false, name: 'ff-eligibility.control-redone: the CAS never happened, no P1: the ff is redone (published, redone) and the unit finishes once' },
    { label: 'ff.act-end', p1: true, name: 'ff-eligibility.published-stands: the CAS happened, then a P1 over I-1 opened: done published (reconciled); a P1 cannot undo a publication' },
  ];

  test('ff-eligibility.cells: the row crashes the unit ff\'s act at its start and end, and every case crashes a row label', () => {
    assert.deepEqual(cells.map((c) => `${c.boundary} ${c.label}`), ['B2 ff.act-start', 'B4 ff.act-end']);
    assert.deepEqual([...new Set(CASES.map((c) => c.label))], cells.map((c) => c.label));
  });

  for (const c of CASES) {
    const cell = cells.find((x) => x.label === c.label)!;
    test(`${c.name} (${cell.boundary} ${cell.label})`, T, async () => {
      const { d } = holisticArc({
        steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
        units: [{ id: 'u1', obligations: ['I-1'] }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED, trees: { '*': { outcomes: { t1: 'pass' } } },
      });
      const tip = git(d.repo, 'rev-parse', 'main');
      const trigger = writeTrigger(tmpDir('ff-eligibility-crash'), { label: c.label, occurrence: 1 });
      const exit = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${c.label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      const w = wire(r);
      try {
        const [ff, ...more] = r.journal.view.opsOf('integration.ff');
        assert.ok(ff !== undefined && more.length === 0, 'one unit ff');
        assert.equal(r.journal.view.doneOf(ff.op), null, 'the crash left it open');
        assert.equal(git(d.repo, 'rev-parse', 'main'), c.label === 'ff.act-start' ? tip : ff.expect.new, 'the CAS happened only past act-start');
        if (c.p1) assert.deepEqual(openFinding(r.journal, witnessDraft('I-1')), { kind: 'opened', id: 'F-1' }, 'the P1 is opened while no executor runs');

        await recover({ stage: r.ctx, commands: w.commands });
        const done = r.journal.view.doneOf(ff.op);
        assert.ok(done !== null && done.kind === 'integration.ff');
        assert.deepEqual(r.journal.view.openIntents(), []);

        if (c.label === 'ff.act-start' && c.p1) {
          assert.deepEqual([done.outcome, done.recoveredBy], [{ kind: 'unpublished', tip }, 'reconciled'], 'not redone: done unpublished at T');
          assert.equal(git(d.repo, 'rev-parse', 'main'), tip, 'nothing published');
          await step(r.ctx, r.unit('u1'));
          assert.equal(outcomes(d, 'u1').at(-1), 'ff:cas-stale', 'the ff stage reads its unpublished ff back');
          await step(r.ctx, r.unit('u1'));
          assert.equal(outcomes(d, 'u1').at(-1), 'candidate:finding-blocked', 'the fresh candidate is held by the P1');
          assert.equal(r.journal.view.opsOf('integration.ff').length, 1, 'no second ff was begun');
          assert.equal(git(d.repo, 'rev-parse', 'main'), tip, 'still nothing published');
          assert.deepEqual(r.journal.view.publications(), []);
          assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'uncharged');
          ruleFinding(r.journal, F1, 'dismissed', { type: 'checkpoint', job: jobId('ckpt', 1) });
          assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d, 'u1').join(' '));
        } else {
          assert.deepEqual([done.outcome, done.recoveredBy], [{ kind: 'published' }, c.label === 'ff.act-start' ? 'redone' : 'reconciled']);
          assert.equal(git(d.repo, 'rev-parse', 'main'), ff.expect.new, 'published at the tested candidate');
          assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d, 'u1').join(' '));
          assert.equal(r.journal.view.opsOf('integration.ff').length, 1, 'published by the one ff');
          assert.deepEqual(outcomes(d, 'u1').filter((o) => o.startsWith('ff:')), ['ff:published']);
          if (c.p1) assert.equal(finding(r).state, 'open', 'the P1 stays open: it blocks later candidates, not this publication');
        }
        assert.deepEqual(r.journal.view.publications().map((p) => p.unit), ['u1'], 'u1 published once');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// Plan-check (R17, AX carry-forward)

describe('plan-check and the findings store', () => {
  test('findings.plan-check-vision-conflict: each vision conflict opens a P3 plan-check finding from its attempt, never a redirect by itself; a re-check reporting it again merges; a conflict citing no active clause is malformed', T, async () => {
    const note = 'A1 accepts any input, against V-1\'s trust.';
    const patch = [{ op: 'add', section: 'decisions', item: { id: 'D1', text: 'mul multiplies.' } }];
    const { d } = holisticArc({
      steps: [
        planCheckStep({ decision: 'redirect', patch, visionConflict: [{ clauses: ['V-1'], note }] }),
        planCheckStep({ decision: 'approve', visionConflict: [{ clauses: ['V-1'], note }] }),
      ],
      units: [{ id: 'u1', obligations: ['I-1'] }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED, trees: {},
    });
    const r = contextFor(d);
    try {
      await step(r.ctx, r.unit('u1'));
      await step(r.ctx, r.unit('u1'));
      assert.deepEqual(outcomes(d, 'u1'), ['plan-check:redirect', 'plan-check:approve'], 'the conflict decided nothing');
      const found = r.journal.view.holistic().findings;
      assert.equal(found.length, 1, 'the second report merged into the first');
      assert.deepEqual([found[0]!.lens, found[0]!.severity, found[0]!.visionClauses, found[0]!.claim, found[0]!.obligation, found[0]!.source, found[0]!.state],
        ['plan-check', 'P3', ['V-1'], note, null, { type: 'stage', unit: 'u1', stage: 'plan-check', attempt: 1 }, 'open']);
    } finally {
      r.journal.close();
    }
    const bad = holisticArc({
      steps: [planCheckStep({ decision: 'approve', visionConflict: [{ clauses: ['V-9'], note }] })],
      units: [{ id: 'u1', obligations: ['I-1'] }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED, trees: {},
    });
    const b = contextFor(bad.d);
    try {
      await step(b.ctx, b.unit('u1'));
      assert.deepEqual(outcomes(bad.d, 'u1'), ['plan-check:malformed']);
      assert.deepEqual(b.journal.view.holistic().findings, []);
    } finally {
      b.journal.close();
    }
  });

  test('plancheck.reads-captured-spec: an evidence-only edit landing between the capture and the @cpu grant keeps the captured rev; the redirect is read against it and patches the spec in force at that rev', T, async () => {
    const patch = [{ op: 'add', section: 'decisions', item: { id: 'D1', text: 'mul multiplies.' } }];
    const d = setupArc({ steps: [planCheckStep({ decision: 'redirect', patch })] });
    const r = contextFor(d);
    try {
      let open = (): void => {};
      const granted = new Promise<void>((resolve) => { open = resolve; });
      const ctx = { ...r.ctx, acquire: async (...a: Parameters<typeof r.ctx.acquire>) => { await granted; return r.ctx.acquire(...a); } };
      const checking = planCheck(ctx, r.unit('u1'));
      for (let i = 0; i < 100 && r.journal.view.judgmentInputs(U1, 'plan-check', 1) === null; i++) await sleep(50);
      const captured = r.journal.view.judgmentInputs(U1, 'plan-check', 1);
      assert.ok(captured !== null && captured.specRev === 1);
      assert.equal(r.journal.view.unit(U1).open, null, 'the attempt has not started: it waits for @cpu');

      const specPath = join(d.planPath, '..', 'u1.json');
      const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { lanes: Record<string, unknown>[] };
      writeFileSync(specPath, JSON.stringify({ ...spec, lanes: spec.lanes.map((l) => ({ ...l, evidenceGlobs: ['out/**'] })) }));
      const applied = await applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(d)));
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      const edited = r.journal.view.unit(U1).spec!;
      assert.deepEqual([edited.rev, edited.sha256 === captured.specSha256], [1, false], 'an evidence-only edit: the same rev, new bytes');

      open();
      const done = started(await checking);
      assert.equal(done.specRev, captured.specRev, 'read against the captured rev');
      assert.equal(done.outcome.kind, 'redirect');
      const patched = r.journal.view.opsOf('spec.patch').at(-1)!;
      assert.deepEqual([patched.expect.expectRev, patched.expect.oldSha256], [1, edited.sha256], 'the patch applies to the spec in force at the captured rev');
      const after = JSON.parse(readFileSync(inputPath(r.ctx.runDir, r.journal.view.unit(U1).spec!.sha256, SPEC_INPUT), 'utf8')) as { rev: number; lanes: { evidenceGlobs: string[] }[]; decisions: { id: string }[] };
      assert.deepEqual([after.rev, after.lanes[0]!.evidenceGlobs, after.decisions.map((x) => x.id)], [2, ['out/**'], ['D1']], 'the evidence edit is kept under the redirect');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash: mutant.apply (the matrix row MUTANT_APPLY)

/** How recovery closes the apply a crash at each label cut short: redone from its intent, reconciled from the patched tree, or live. */
const MUTANT_RECOVERED_BY: Readonly<Record<string, string | null>> = {
  'mutant.act-start': 'redone', 'mutant.after-worktree': 'redone', 'mutant.act-end': 'reconciled', 'mutant.after-done': null,
};

describe(`matrix row ${MUTANT_APPLY}`, () => {
  // Occurrence 1 is the reproduce's apply at the tip, occurrence 2 the candidate's kill check on the candidate tree.
  for (const cell of crashCells(MUTANT_APPLY)) for (const occurrence of [1, 2]) {
    const which = occurrence === 1 ? 'the reproduce' : 'the candidate\'s kill check';
    test(`mutant.apply crashed at ${cell.boundary} ${cell.label}#${occurrence} (${which}): ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const { d, control } = vacuityArc();
      scriptTree(control, treeWith(d.repo, tipOf(d), STRICT_TEST, MUTANT_PATCH), { outcomes: { t1: 'fail' } });
      const trigger = writeTrigger(tmpDir('mutant-crash'), { label: cell.label, occurrence });
      const exit = await runFixture('repair-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}#${occurrence}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      const w = wire(r);
      try {
        const crashed = r.journal.view.opsOf('mutant.apply');
        assert.equal(crashed.length, occurrence, `the crash cut ${which}'s apply short`);
        const cut = crashed.at(-1)!;
        assert.equal(cut.parent.type === 'stage' ? cut.parent.stage : null, occurrence === 1 ? 'reproduce' : 'candidate', `the apply cut short is ${which}'s`);
        await recover({ stage: r.ctx, commands: w.commands });
        const applies = r.journal.view.opsOf('mutant.apply');
        assert.ok(applies.length >= 1 && applies.every((i) => r.journal.view.doneOf(i.op)?.kind === 'mutant.apply'), 'recovery closed the apply');
        assert.equal(r.journal.view.doneOf(cut.op)?.recoveredBy, MUTANT_RECOVERED_BY[cell.label], `the apply cut short at ${cell.label} is closed as its reconciler says`);
        assert.deepEqual(await runUnit(r.ctx, r.unit('v1'), admitAll), { kind: 'merged' }, outcomes(d, 'v1').join(' '));
        assert.equal(r.journal.view.opsOf('mutant.apply').length, 3, 'the stage cut short ran again with one new apply: the reproduce\'s and the kill check\'s, plus the one cut short');
        assert.deepEqual(outcomes(d, 'v1').filter((o) => o.startsWith('reproduce:')), ['reproduce:reproduced'], 'one reproduce outcome');
        assert.deepEqual(outcomes(d, 'v1').filter((o) => o.startsWith('candidate:')), ['candidate:green'], 'one candidate outcome: its kill check killed the mutant once');
        assert.deepEqual(moves(r), ['F-1:owned{v1}', 'F-1:fixed-on-branch{v1}', 'F-1:resolved']);
        assert.deepEqual(worktrees(r), [], 'no mutant worktree is left');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});

