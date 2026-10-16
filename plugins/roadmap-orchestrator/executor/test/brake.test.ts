// M3 step B2: journey lanes in a unit's candidate and the held-claims brake (src/pipeline/integrate.ts, lanes.ts), over
// real arcs (real git, real processes, fake backends, fake witness lanes scripted per tree). Named tests:
// brake.must-hold-red, brake.base-red, brake.future-measured (future activation, the latch), brake.absent-future-witness, brake.split-repair, brake.known-regression-
// test-level (G11), brake.unmapped-paths, fingerprint.obligation-revs, fingerprint.judged-rev-change-regates, fingerprint.sibling-latch-*, witness records and lane reuse, and the crash
// cells of the matrix row LATCH (test/matrix.ts), recovered by the recovery engine.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact, IntentOf } from '../src/core/events.ts';
import { findingId, sha, sha256, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { verifySnapshot } from '../src/git/snapshot.ts';
import { selected } from '../src/pipeline/gate.ts';
import { candidateBrakeFix } from '../src/pipeline/integrate.ts';
import { witnessRecordPath } from '../src/pipeline/lanes.ts';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { scriptTree } from './helpers/witness.ts';
import { LATCH, crashCells } from './matrix.ts';
import { type HolisticArc, candidateTree, holisticArc, obligationsJson, tipTree } from './fixtures/brake-common.ts';
import { closedAs, wire } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import type { Step } from './helpers/scenario.ts';
import { type ArcDescriptor, type ArcRun, U1, applyBody, codexStep, contextFor, gateStep, mulBuild, outcomes, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const journeys = (r: ArcRun): readonly IntentOf<'proc.spawn'>[] => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey');
const journeyLanes = (r: ArcRun): readonly string[] => journeys(r).map((i) => (i.expect.subject.purpose === 'journey' ? `${i.expect.subject.lane}@${i.expect.subject.at.slice(0, 7)}` : ''));
const witnessedFor = (r: ArcRun) => facts(r).flatMap((f) => (f.kind === 'witnessed' ? [f] : []));
const latched = (r: ArcRun) => facts(r).flatMap((f) => (f.kind === 'obligation-latched' ? [[f.obligation, f.unit]] : []));
/** The needs-user items raised so far. */
const raised = (r: ArcRun): readonly string[] => r.journal.view.opsOf('needsuser.raise').map((i) => i.expect.id);
const steps = [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })];
/** Every in-scope path maps to I-1 (the spec must then declare it). */
const MAPPED = [{ pattern: 'src/**', obligations: ['I-1'] }, { pattern: 'test/**', obligations: ['I-1'] }, { pattern: 'contracts/**', obligations: ['I-1'] }] as const;

/** Steps u1 to its approval, then scripts its candidate tree with `outcomes`. */
async function approveThenScript(r: ArcRun, control: string, outcomes: Readonly<Record<string, 'pass' | 'fail'>>, unit = 'u1'): Promise<string> {
  await stepUntil(r, unit, (f) => f.stage === 'gate' && f.outcome === 'approve');
  const tree = candidateTree(r.d, unit);
  scriptTree(control, tree, { outcomes });
  return tree;
}

describe('the held-claims brake', () => {
  test('brake.must-hold-red: a selected must-hold obligation not held on the candidate, held on the tip alone: red (charged), a fix round naming it; witness records named by candidate facts', T, async () => {
    const { d, control } = holisticArc({
      steps, units: [{ id: 'u1', obligations: ['I-1'] }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED, trees: {},
    });
    scriptTree(control, tipTree(d), { outcomes: { t1: 'pass' } });
    const r = contextFor(d);
    try {
      await approveThenScript(r, control, { t1: 'fail' });
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(d).at(-1), 'candidate:red', outcomes(d).join(' '));
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 1, 'a brake red is charged');
      const w = witnessedFor(r);
      // The candidate (red: a diagnostic rerun, the first run counted) and the tip alone: one fact each.
      assert.deepEqual(w.map((f) => [f.lane, f.for, f.purpose]), [
        ['journey', { type: 'candidate', unit: 'u1', attempt: w[0]!.for.type === 'candidate' ? w[0]!.for.attempt : 0 }, 'witness'],
        ['journey', { type: 'candidate', unit: 'u1', attempt: w[0]!.for.type === 'candidate' ? w[0]!.for.attempt : 0 }, 'witness'],
      ]);
      assert.equal(journeys(r).length, 3, 'the candidate\'s red lane was rerun once (diagnostic); the tip alone passed at once');
      for (const f of w) assert.ok(existsSync(witnessRecordPath(r.ctx.runDir, f)), 'the record is kept in its execution\'s dir');
      const decided = r.journal.view.unit(U1).decided!;
      const fix = candidateBrakeFix(r.ctx, r.unit('u1'), { type: 'stage', unit: U1, stage: 'candidate', attempt: decided.attempt });
      assert.match(fix.directives.join('\n'), /Obligation I-1 must hold on the candidate/);
      assert.equal(fix.failingEvidenceDirs.length, 1);
    } finally {
      r.journal.close();
    }
  });

  test('brake.base-red: the same obligation not held on the tip alone either: base-red (uncharged)', T, async () => {
    const { d, control } = holisticArc({
      steps, units: [{ id: 'u1', obligations: ['I-1'] }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED, trees: { '*': { outcomes: { t1: 'fail' } } },
    });
    const r = contextFor(d);
    try {
      await approveThenScript(r, control, { t1: 'fail' });
      const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
      assert.equal(outcomes(d).at(-1), 'candidate:base-red', outcomes(d).join(' '));
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
      assert.ok(parked.kind === 'parked');
      assert.equal(parked.needsUser.reason, 'base-red');
      assert.match(parked.needsUser.summary, /alone, without unit u1: lane journey red; obligation I-1 not held\. The base is broken/, 'the item names what was red on the tip alone');
    } finally {
      r.journal.close();
    }
  });
});

/** A codex build that commits `files` (a unit other than the first adds its own module). */
const build = (unit: string, files: Readonly<Record<string, string>>): Step => ({ ...codexStep([{ type: 'commit', message: `build ${unit}`, files }], { argv: ['exec', '-C'] }), unit });
const keyed = (unit: string, s: Step): Step => ({ ...s, unit });
const moduleFiles = (name: string, op: string): Readonly<Record<string, string>> => ({
  [`src/${name}.js`]: `export function ${name}(a, b) {\n  return a ${op} b;\n}\n`,
  [`test/${name}.test.js`]: `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { ${name} } from '../src/${name}.js';\n\ntest('${name}', () => {\n  assert.equal(typeof ${name}(6, 3), 'number');\n});\n`,
});
const unitSteps = (unit: string, files: Readonly<Record<string, string>>): readonly Step[] =>
  [keyed(unit, planCheckStep({ decision: 'approve' })), build(unit, files), keyed(unit, gateStep({ decision: 'approve' }))];

describe('future obligations', () => {
  test('brake.future-measured: a future obligation its candidate selects but does not complete is measured, never graded; the unit completing it latches it on publication (future activation), and it is must-hold from then on', T, async () => {
    const { d, control } = holisticArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')), ...unitSteps('u3', moduleFiles('sub', '-'))],
      units: [{ id: 'u1', obligations: ['I-1', 'I-2'] }, { id: 'u2', obligations: ['I-1', 'I-2'] }, { id: 'u3', obligations: ['I-1', 'I-2'] }],
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', activation: 'future', deliveredBy: ['u1', 'u2'], testIds: ['t2'] }],
      mapping: MAPPED.map((m) => ({ ...m, obligations: ['I-1', 'I-2'] })), trees: { '*': { outcomes: { t1: 'pass', t2: 'fail' } } },
    });
    const r = contextFor(d);
    try {
      // u1 delivers I-2 with u2: not completing, so its failing witness is measured.
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }, { id: 'I-2', rev: 1 }]);
      assert.deepEqual(latched(r), []);
      // u2 completes it, held on its candidate: latched after its ff, before the snapshot.
      await approveThenScript(r, control, { t1: 'pass', t2: 'pass' }, 'u2');
      assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), admitAll), { kind: 'merged' }, outcomes(d, 'u2').join(' '));
      assert.deepEqual(latched(r), [['I-2', 'u2']]);
      const events = readJournal(r.ctx.runDir, r.journal.view.arc).events;
      const latchSeq = events.find((e) => e.type === 'fact' && e.fact.kind === 'obligation-latched')!.seq;
      const u2Ff = events.find((e) => e.type === 'done' && e.kind === 'integration.ff' && e.seq > (r.journal.view.publications()[0]?.seq ?? 0))!.seq;
      const u2Snap = r.journal.view.opsOf('snapshot.publish').filter((i) => i.parent.type === 'stage' && i.parent.unit === unitId('u2')).at(-1)!;
      assert.ok(u2Ff < latchSeq && latchSeq < Number(u2Snap.op.slice(u2Snap.op.lastIndexOf('/') + 1)), 'ff done, then the latch, then the snapshot');
      // u3 selects I-2, now must-hold, not held on its candidate but held on the tip: red.
      scriptTree(control, tipTree(d), { outcomes: { t1: 'pass', t2: 'pass' } });
      await stepUntil(r, 'u3', (f) => f.stage === 'candidate');
      assert.equal(outcomes(d, 'u3').at(-1), 'candidate:red', outcomes(d, 'u3').join(' '));
    } finally {
      r.journal.close();
    }
  });
});

describe('a sibling\'s future witness absent', () => {
  test('brake.absent-future-witness: a candidate selecting a future obligation another unit delivers, whose witness test file neither the candidate nor the tip has yet, is not base-red: that lane is red on both but measured, never graded; the candidate is green and latches what it completes (paid m4b run 5)', T, async () => {
    // As run 5's booking-texts: its approval selected clash-refusal's future I-11..13 (lane w-clash, test file not yet
    // on the base) beside its own future ones (w-outbox, its file added by the unit). Before the fix w-clash, red with
    // no record on the candidate and on the tip alike, was an unexplained lane the tip reproduced: a blocking base-red.
    const { d, control } = holisticArc({
      steps: unitSteps('u1', moduleFiles('mul', '*')),
      units: [{ id: 'u1', obligations: ['I-1', 'I-2', 'I-3'] }, { id: 'u2' }],
      lanes: ['journey', 'w-other'],
      obligations: [
        { id: 'I-1', testIds: ['t1'] },
        { id: 'I-2', activation: 'future', deliveredBy: ['u1'], testIds: ['t2'] },
        { id: 'I-3', activation: 'future', deliveredBy: ['u2'], testIds: ['t3'], lane: 'w-other' },
      ],
      mapping: MAPPED.map((m) => ({ ...m, obligations: ['I-1', 'I-2', 'I-3'] })),
      trees: { '*': { outcomes: { t1: 'pass' }, absent: ['w-other'] } },
    });
    const r = contextFor(d);
    try {
      await approveThenScript(r, control, { t1: 'pass', t2: 'pass' });
      const tree = candidateTree(d, 'u1');
      scriptTree(control, tree, { outcomes: { t1: 'pass', t2: 'pass' }, absent: ['w-other'] });
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.ok(outcomes(d).includes('candidate:green'), outcomes(d).join(' '));
      assert.deepEqual(raised(r), [], 'no needs-user item');
      assert.deepEqual(latched(r), [['I-2', 'u1']]);
      assert.ok(journeyLanes(r).some((l) => l.startsWith('w-other@')), 'the absent witness lane did run on the candidate');
    } finally {
      r.journal.close();
    }
  });
});

describe('repairs', () => {
  test('brake.split-repair: a repair of a split parent is held when every child\'s witness holds on its candidate, whatever the child\'s effect (must-hold discharged, a future child it completes latching, one delivered by another unit measured): green, and the child it completes latches', T, async () => {
    const { d, control } = holisticArc({
      steps, units: [{ id: 'u1', obligations: ['I-1'], repairs: ['I-1'] }, { id: 'u2' }],
      obligations: [
        { id: 'I-1', testIds: [], state: { type: 'split', children: ['I-2', 'I-3', 'I-4'] } },
        { id: 'I-2', testIds: ['t2'], parent: 'I-1' },
        { id: 'I-3', activation: 'future', deliveredBy: ['u1'], testIds: ['t3'], parent: 'I-1' },
        { id: 'I-4', activation: 'future', deliveredBy: ['u2'], testIds: ['t4'], parent: 'I-1' },
      ],
      mapping: MAPPED, trees: {},
    });
    scriptTree(control, tipTree(d), { outcomes: { t2: 'pass', t3: 'fail', t4: 'pass' } });
    const r = contextFor(d);
    try {
      await approveThenScript(r, control, { t2: 'pass', t3: 'pass', t4: 'pass' });
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.ok(outcomes(d).includes('candidate:green'), outcomes(d).join(' '));
      assert.deepEqual(latched(r), [['I-3', 'u1']]);
    } finally {
      r.journal.close();
    }
  });

  test('brake.split-repair: a child of the repaired split parent not held on the candidate leaves the repair red', T, async () => {
    const { d, control } = holisticArc({
      steps, units: [{ id: 'u1', obligations: ['I-1'], repairs: ['I-1'] }, { id: 'u2' }],
      obligations: [
        { id: 'I-1', testIds: [], state: { type: 'split', children: ['I-2', 'I-4'] } },
        { id: 'I-2', testIds: ['t2'], parent: 'I-1' },
        { id: 'I-4', activation: 'future', deliveredBy: ['u2'], testIds: ['t4'], parent: 'I-1' },
      ],
      mapping: MAPPED, trees: {},
    });
    scriptTree(control, tipTree(d), { outcomes: { t2: 'pass', t4: 'fail' } });
    const r = contextFor(d);
    try {
      await approveThenScript(r, control, { t2: 'pass', t4: 'fail' });
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(d).at(-1), 'candidate:red', outcomes(d).join(' '));
    } finally {
      r.journal.close();
    }
  });
});

describe('known regressions (R4, G11)', () => {
  /** I-1 (selected, t1) and I-2 (unselected, `i2`) share the journey lane; `p1` opens a P1 over each obligation named. */
  async function knownRegression(i2: readonly string[], candidate: Readonly<Record<string, 'pass' | 'fail'>>, tip: Readonly<Record<string, 'pass' | 'fail'>>, p1: readonly string[]): Promise<string> {
    const { d, control } = holisticArc({
      steps: [...steps, gateStep({ decision: 'approve' })], units: [{ id: 'u1', obligations: ['I-1'] }],
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: i2 }], mapping: [...MAPPED, { pattern: 'lib/**', obligations: ['I-2'] }], trees: {},
    });
    scriptTree(control, tipTree(d), { outcomes: tip });
    const r = contextFor(d);
    try {
      for (const [n, o] of p1.entries()) {
        r.journal.fact({
          kind: 'finding-opened', id: findingId(`F-${n + 1}`), key: sha256(String(n + 1).repeat(64)), lens: 'witness', severity: 'P1', obligation: o as never,
          visionClauses: [], claim: `${o} is not held on the audited head`, evidence: [], mutant: null, source: { type: 'job', job: `audit-${n + 1}` as never }, gateHadPassed: true,
        });
      }
      await approveThenScript(r, control, candidate);
      await step(r.ctx, r.unit('u1'));
      return outcomes(d).at(-1)!;
    } finally {
      r.journal.close();
    }
  }

  test('brake.known-regression-test-level: a failing test in an unselected obligation\'s witness, recorded by a P1, that the tip alone fails exactly: green', T, async () => {
    assert.equal(await knownRegression(['t2'], { t1: 'pass', t2: 'fail' }, { t1: 'pass', t2: 'fail' }, ['I-2']), 'candidate:green');
  });

  test('brake.known-regression-test-level: the tip alone passing that test: the candidate regressed it, red', T, async () => {
    assert.equal(await knownRegression(['t2'], { t1: 'pass', t2: 'fail' }, { t1: 'pass', t2: 'pass' }, ['I-2']), 'candidate:red');
  });

  test('brake.known-regression-test-level: the candidate failing more than the tip (t2 and t3 against t2): not exactly that set, base-red', T, async () => {
    assert.equal(await knownRegression(['t2', 't3'], { t1: 'pass', t2: 'fail', t3: 'fail' }, { t1: 'pass', t2: 'fail', t3: 'pass' }, ['I-2']), 'candidate:base-red');
  });

  test('brake.known-regression-test-level: no P1 records the failing test: unexplained, and the tip failing it too is base-red', T, async () => {
    assert.equal(await knownRegression(['t2'], { t1: 'pass', t2: 'fail' }, { t1: 'pass', t2: 'fail' }, []), 'candidate:base-red');
  });

  test('brake.known-regression-test-level: a selected must-hold obligation is never excused, even under a P1 and a tip failing exactly the same', T, async () => {
    assert.equal(await knownRegression(['t2'], { t1: 'fail', t2: 'pass' }, { t1: 'fail', t2: 'pass' }, ['I-1']), 'candidate:base-red');
  });
});

describe('impact mapping', () => {
  test('brake.unmapped-paths: a candidate touching a path no mapping pattern matches selects every must-hold obligation: both lanes run on its candidate, its approval binds both', T, async () => {
    const { d } = holisticArc({
      steps, obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'], lane: 'other' }], lanes: ['journey', 'other'],
      mapping: [{ pattern: 'lib/**', obligations: ['I-1'] }], trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
    });
    const r = contextFor(d);
    try {
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }, { id: 'I-2', rev: 1 }]);
      const cand = r.journal.view.opsOf('candidate.merge').at(-1)!.post.new;
      assert.deepEqual(journeyLanes(r), [`journey@${cand.slice(0, 7)}`, `other@${cand.slice(0, 7)}`]);
      // The snapshot after the publication carries the candidate's witness records, and verifies.
      assert.equal(verifySnapshot(absPath(d.repo), sha(git(d.repo, 'rev-parse', `refs/roadmap/${d.arc}`))).kind, 'verified');
    } finally {
      r.journal.close();
    }
  });

  test('fingerprint.obligation-revs: the approval binds the selected obligations\' revisions; a mapping change that only grows the selection does not re-gate: the candidate\'s lanes witness the joiner (paid m4b run 6)', T, async () => {
    const { d } = holisticArc({
      steps, units: [{ id: 'u1', obligations: ['I-1'] }],
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'], lane: 'other' }], lanes: ['journey', 'other'],
      mapping: [...MAPPED, { pattern: 'lib/**', obligations: ['I-2'] }], trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
    });
    const r = contextFor(d);
    const w = wire(r);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }]);
      // The mapping no longer maps the unit's paths: they are unmapped now, selecting every must-hold obligation.
      const path = join(d.planPath, '..', 'obligations.json');
      const o = JSON.parse(readFileSync(path, 'utf8')) as { mapping: { paths: unknown[] } };
      writeFileSync(path, JSON.stringify({ ...o, mapping: { paths: [{ pattern: 'lib/**', obligations: ['I-2'] }] } }));
      const outcome = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(d)));
      assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.ok(!outcomes(d).includes('ff:fingerprint-invalid'), outcomes(d).join(' '));
      assert.equal(outcomes(d).filter((x) => x === 'gate:approve').length, 1, 'one gate: the approval held');
      assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }], 'the approval binds what the gate judged');
      const cand = r.journal.view.opsOf('candidate.merge').at(-1)!.post.new;
      assert.ok(journeyLanes(r).includes(`other@${cand.slice(0, 7)}`), `the joiner I-2's lane ran on the candidate: ${journeyLanes(r).join(' ')}`);
    } finally {
      r.journal.close();
    }
  });

  test('fingerprint.judged-rev-change-regates: an obligation the gate judged changes revision (future → must-hold, rev 2) before ff: fingerprint-invalid, and the re-gate binds rev 2', T, async () => {
    const { d, control } = holisticArc({
      steps: [...steps, gateStep({ decision: 'approve' })], units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2' }],
      obligations: [{ id: 'I-1', activation: 'future', deliveredBy: ['u1', 'u2'], testIds: ['t1'] }], mapping: MAPPED, trees: { '*': { outcomes: { t1: 'pass' } } },
    });
    const r = contextFor(d);
    const w = wire(r);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }]);
      const path = join(d.planPath, '..', 'obligations.json');
      const next = obligationsJson({ obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED }, control) as Readonly<{ obligations: readonly Readonly<{ proofJudgment: object }>[] }>;
      const i1 = next.obligations[0]!;
      writeFileSync(path, JSON.stringify({ ...next, obligations: [{ ...i1, rev: 2, proofJudgment: { ...i1.proofJudgment, obligationRev: 2 } }] }));
      const outcome = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(d)));
      assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
      await stepUntil(r, 'u1', (f) => f.stage === 'ff');
      assert.equal(outcomes(d).at(-1), 'ff:fingerprint-invalid', outcomes(d).join(' '));
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 2 }], 'the re-gate binds the new revision');
    } finally {
      r.journal.close();
    }
  });
});

describe('the approval across a sibling\'s publication (paid m4b run 6)', () => {
  /**
   * u1 (mul) and u2 (div) touch only unmapped `src/` and `test/` paths, so each selects every must-hold obligation; u2
   * delivers the future I-2. u1 is approved selecting I-1 alone; u2 then publishes and latches I-2, which u1 now selects.
   */
  const siblingArc = (): HolisticArc => holisticArc({
    // u2 adds mul too (byte-identical, so the merges are clean): its lanes test mul before u1 publishes it. u1's own
    // note keeps its candidate tree distinct from u2's, so its lanes witness it rather than reuse u2's observation.
    steps: [
      ...unitSteps('u1', { ...moduleFiles('mul', '*'), 'src/note.js': 'export const note = 1;\n' }),
      ...unitSteps('u2', { ...moduleFiles('mul', '*'), ...moduleFiles('div', '/') }),
    ],
    units: [{ id: 'u1' }, { id: 'u2', obligations: ['I-2'] }],
    obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', activation: 'future', deliveredBy: ['u2'], testIds: ['t2'] }],
    mapping: [{ pattern: 'lib/**', obligations: ['I-1'] }], trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
  });

  async function u1ApprovedThenU2Published(r: ArcRun): Promise<void> {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
    assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }]);
    assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), admitAll), { kind: 'merged' }, outcomes(r.d, 'u2').join(' '));
    assert.deepEqual(latched(r), [['I-2', 'u2']]);
    const head = r.journal.view.unit(U1).approval!.fingerprint.unitCommit;
    assert.deepEqual(selected(r.ctx, r.unit('u1'), sha(git(r.d.repo, 'rev-parse', 'main')), head).map((o) => o.id), ['I-1', 'I-2'], 'u1 now selects I-2');
  }

  test('fingerprint.sibling-latch-holds: an obligation a sibling\'s publication newly selects does not void the approval: one gate, no fingerprint-invalid, published', T, async () => {
    const { d } = siblingArc();
    const r = contextFor(d);
    try {
      await u1ApprovedThenU2Published(r);
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.ok(!outcomes(d).includes('ff:fingerprint-invalid'), outcomes(d).join(' '));
      assert.equal(outcomes(d).filter((x) => x === 'gate:approve').length, 1, 'one gate: the approval held');
      assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }]);
    } finally {
      r.journal.close();
    }
  });

  test('fingerprint.sibling-latch-graded: the joiner is graded on u1\'s candidate: not held there, held on the tip alone, red', T, async () => {
    const { d, control } = siblingArc();
    const r = contextFor(d);
    try {
      await u1ApprovedThenU2Published(r);
      scriptTree(control, candidateTree(d, 'u1'), { outcomes: { t1: 'pass', t2: 'fail' } });
      await stepUntil(r, 'u1', (f) => f.stage === 'candidate');
      assert.equal(outcomes(d).at(-1), 'candidate:red', outcomes(d).join(' '));
      const decided = r.journal.view.unit(U1).decided!;
      const fix = candidateBrakeFix(r.ctx, r.unit('u1'), { type: 'stage', unit: U1, stage: 'candidate', attempt: decided.attempt });
      assert.match(fix.directives.join('\n'), /Obligation I-2 must hold on the candidate/);
    } finally {
      r.journal.close();
    }
  });

  test('fingerprint.sibling-latch-finding-blocked: an active P1 over the joiner blocks u1\'s candidate (G10), though its approval does not name it', T, async () => {
    const { d } = siblingArc();
    const r = contextFor(d);
    try {
      await u1ApprovedThenU2Published(r);
      r.journal.fact({
        kind: 'finding-opened', id: findingId('F-1'), key: sha256('1'.repeat(64)), lens: 'witness', severity: 'P1', obligation: 'I-2' as never,
        visionClauses: [], claim: 'I-2 is not held on the audited head', evidence: [], mutant: null, source: { type: 'job', job: 'audit-1' as never }, gateHadPassed: true,
      });
      await stepUntil(r, 'u1', (f) => f.stage === 'candidate');
      assert.equal(outcomes(d).at(-1), 'candidate:finding-blocked', outcomes(d).join(' '));
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash: the latch (the matrix row LATCH)

describe(`matrix row ${LATCH}`, () => {
  /**
   * How recovery closes the ops each crash leaves open (closedAs), and how the one unit ff stands after the run: cut
   * short after its act, the ff is reconciled published; once done, it was live and nothing is open.
   */
  const AFTER: Readonly<Record<string, Readonly<{ closed: readonly string[]; ff: string }>>> = {
    'ff.act-end': { closed: ['integration.ff:reconciled'], ff: 'integration.ff:reconciled' },
    'latch.after-fact': { closed: [], ff: 'integration.ff:live' },
  };
  for (const cell of crashCells(LATCH)) {
    test(`latch crashed at ${cell.boundary} ${cell.label}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const { d } = holisticArc({
        steps: [...steps, gateStep({ decision: 'approve' })], units: [{ id: 'u1', obligations: ['I-1', 'I-2'] }],
        obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', activation: 'future', deliveredBy: ['u1'], testIds: ['t2'] }],
        mapping: MAPPED.map((m) => ({ ...m, obligations: ['I-1', 'I-2'] })), trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
      });
      const trigger = writeTrigger(tmpDir('latch-crash'), { label: cell.label, occurrence: 1 });
      const exit = await runFixture('brake-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      const open = r.journal.view.openIntents();
      const w = wire(r);
      try {
        await recover({ stage: r.ctx, commands: w.commands });
        const closed = closedAs(r.journal.view, open);
        assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
        const [ff, ...moreFfs] = r.journal.view.opsOf('integration.ff');
        const ffDone = ff === undefined ? null : r.journal.view.doneOf(ff.op);
        const expected = AFTER[cell.label];
        if (expected === undefined) throw new Error(`no expectation for ${cell.label}`);
        assert.deepEqual(closed, expected.closed, 'the ops the crash left open, as recovery closed them');
        assert.ok(ff !== undefined && moreFfs.length === 0 && ffDone?.kind === 'integration.ff' && ffDone.outcome.kind === 'published', 'one ff, published');
        assert.equal(closedAs(r.journal.view, [ff])[0], expected.ff);
        assert.deepEqual(r.journal.view.publications().map((p) => p.unit), ['u1'], 'one publication');
        assert.deepEqual(latched(r), [['I-2', 'u1']], 'one latch');
        const events = readJournal(r.ctx.runDir, r.journal.view.arc).events;
        const latchSeq = events.find((e) => e.type === 'fact' && e.fact.kind === 'obligation-latched')!.seq;
        const snap = r.journal.view.opsOf('snapshot.publish').filter((i) => i.parent.type === 'stage').at(-1)!;
        assert.ok(latchSeq < Number(snap.op.slice(snap.op.lastIndexOf('/') + 1)), 'the latch precedes the snapshot');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});
