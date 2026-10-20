// dev.13, the convergence tail (src/holistic/tail.ts; owner ruling 2026-10-20): the pure rules. What a checkpoint's
// dispositions become and which findings code releases (tail.rulings), the brake conversions of a bundle's admits
// (tail.brake-conversions), what finding-origin units introduced (tail.regress-attribution, tail.regress-range), the
// settled point (tail.settled-point), the brakes' exemptions (tail.exempt), a released key never reopening
// (tail.released-suppressed), the ruling reader (tail.release-reader) and which gate notes are debt (tail.gate-debt).
// The bundle and settlement over real arcs are in test/checkpoint.test.ts (tail.*-arc).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type FindingId, type MilestoneId, type UnitId, findingId, jobId, obligationId, sha, sha256, unitId, visionClauseId } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import { openJournal } from '../src/core/log.ts';
import type { FindingState } from '../src/core/state.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath } from '../src/core/values.ts';
import { type FindingDraft, openFinding, ruleFinding } from '../src/holistic/findings.ts';
import {
  type Brake, type TailUnit, type TailWorld, brakeConversions, brakeOf, findingOriginRoots, introducedByFindingOrigin, settledPoint, tailRulings,
} from '../src/holistic/tail.ts';
import { findingTo } from '../src/holistic/types.ts';
import type { PlanM1 } from '../src/input/plan.ts';
import { gateDebtNotes } from '../src/pipeline/gate.ts';
import type { BundleOp } from '../src/prompts/schemas.ts';
import { ARC } from './fixtures/log-records.ts';
import { tmpDir } from './helpers/repo.ts';

const CKPT = jobId('ckpt', 3);
const AUDIT = jobId('audit', 2);
const F = (n: number): FindingId => findingId(`F-${n}`);

const finding = (n: number, over: Partial<FindingState> = {}): FindingState => ({
  id: F(n), key: sha256(n.toString(16).padStart(64, '0')), lens: 'vacuity', severity: 'P2', obligation: null, visionClauses: [], claim: `claim ${n}`,
  evidence: [{ path: 'test/a.test.ts', blob: null }], mutant: null, source: { type: 'job', job: AUDIT }, gateHadPassed: false,
  state: 'open', owner: null, openedSeq: n, last: null, ...over,
});

describe('tail.rulings: what a decision\'s dispositions become, and what code releases', () => {
  const brakes = new Map<FindingId, Brake>([[F(3), 'regress'], [F(4), 'settled'], [F(7), 'regress'], [F(9), 'settled']]);
  const findings = [
    finding(1, { severity: 'P3' }), finding(2, { severity: 'P3' }), finding(3), finding(4), finding(5), finding(6, { severity: 'P3' }),
    finding(7), finding(8, { severity: 'P3', state: 'owned', owner: unitId('r1') }), finding(9), finding(10, { severity: 'P1', obligation: obligationId('I-1') }),
    finding(11, { severity: 'P3' }), finding(13), finding(14), finding(12, { severity: 'P3', state: 'ruled', last: { state: 'ruled', disposition: 'dismissed', by: { type: 'checkpoint', job: jobId('ckpt', 1) } } }),
  ];
  const out = tailRulings({
    job: CKPT, findings, captured: findings.map((f) => f.id),
    dispositions: [
      { finding: F(1), disposition: 'deferred' }, // a P3 deferred: released
      { finding: F(2), disposition: 'accepted' }, // a P3 accepted, nothing fixes it: released
      { finding: F(3), disposition: 'deferred' }, // a P2 below a brake, deferred: deferred (it banks)
      { finding: F(4), disposition: 'accepted' }, // a P2 below a brake, accepted, nothing fixes it: released (settled)
      { finding: F(5), disposition: 'deferred' }, // a P2 under no brake: as given
      { finding: F(6), disposition: 'dismissed' }, // dismissed stays dismissed
      { finding: F(11), disposition: 'accepted' }, // a P3 accepted that an admit repairs: unwritten (the repairs route)
      { finding: F(13), disposition: 'accepted' }, // a P2 accepted that an admit repairs (m5 run 6, F-18): unwritten
      { finding: F(14), disposition: 'deferred' }, // a P2 deferred that an admit repairs: unwritten
      { finding: F(12), disposition: 'released' }, // no longer active: nothing
    ],
    repaired: new Set([F(11), F(13), F(14)]),
    brakeOfId: (id) => brakes.get(id) ?? null,
  });
  const by = (n: number) => out.filter((r) => r.finding === F(n)).map((r) => [r.disposition, r.by.type === 'release' ? r.by.reason : r.by.type]);

  it('a P3 the decision does not fix is released whatever its disposition; one an admit repairs keeps it', () => {
    assert.deepEqual(by(1), [['released', 'p3']]);
    assert.deepEqual(by(2), [['released', 'p3']]);
    assert.deepEqual(by(11), [], 'its repair owns it');
  });
  it('tail.repaired-unruled: a finding the decision repairs is never ruled, whatever its disposition: its unit owns it and resolves it on publication', () => {
    assert.deepEqual(by(13), []);
    assert.deepEqual(by(14), []);
  });
  it('a P2 below a brake: deferred banks (the checkpoint\'s call), accepted while nothing fixes it is released, undisposed is released', () => {
    assert.deepEqual(by(3), [['deferred', 'checkpoint']]);
    assert.deepEqual(by(4), [['released', 'settled']]);
    assert.deepEqual(by(7), [['released', 'regress']]);
    assert.deepEqual(by(9), [['released', 'settled']]);
  });
  it('a P2 under no brake, a dismissal, a P1, an owned P3 and a finding no longer active are left as they are', () => {
    assert.deepEqual(by(5), [['deferred', 'checkpoint']]);
    assert.deepEqual(by(6), [['dismissed', 'checkpoint']]);
    assert.deepEqual(by(8), [], 'owned: its unit fixes it');
    assert.deepEqual(by(10), [], 'a P1 left to its repair');
    assert.deepEqual(by(12), []);
  });
  it('the dispositions come first, in order, then the releases of the shown findings, in order', () => {
    assert.deepEqual(out.map((r) => r.finding), [F(1), F(2), F(3), F(4), F(5), F(6), F(7), F(9)]);
  });
});

const admit = (index: number, unit: string, repairs: readonly string[]) => ({
  index, op: { op: 'admit', unit: { id: unitId(unit) } } as Extract<BundleOp, { op: 'admit' }>, repairs,
});

describe('tail.brake-conversions', () => {
  const brakes = new Map<FindingId, Brake>([[F(1), 'settled'], [F(2), 'settled'], [F(3), 'regress']]);
  const of = (id: FindingId) => brakes.get(id) ?? null;
  it('an admit whose every repair is below a brake converts: settled when each is below the settled brake, else regress', () => {
    const out = brakeConversions([admit(0, 'r1', ['F-1', 'F-2']), admit(2, 'r2', ['F-1', 'F-3']), admit(3, 'r3', ['F-9']), admit(4, 'r4', [])], of);
    assert.deepEqual(out.conversions, [
      { index: 0, unit: 'r1', reason: 'settled-brake', opportunity: null }, { index: 2, unit: 'r2', reason: 'regress-brake', opportunity: null },
    ]);
    assert.deepEqual(out.reasons, []);
  });
  it('an admit naming one beside other repairs is a reason, never a silent drop', () => {
    const out = brakeConversions([admit(1, 'r5', ['F-3', 'F-9']), admit(2, 'r6', ['F-1', 'I-1'])], of);
    assert.deepEqual(out.conversions, []);
    assert.equal(out.reasons.length, 2);
    assert.match(out.reasons[0]!, /^op 2 \(admit r5\): its repairs name F-3 \(below the regress brake\) beside other repairs/);
    assert.match(out.reasons[1]!, /^op 3 \(admit r6\): its repairs name F-1 \(below the settled brake\)/);
  });
});

const world = (over: Partial<TailWorld> = {}): TailWorld => ({
  settled: false, findingOrigin: new Set([unitId('r1')]), rootOf: (u) => (u === 'r1e1' ? unitId('r1') : u),
  history: {
    audits: new Map([[AUDIT, [{ lens: 'vacuity', from: 1, to: 4 }, { lens: 'drift', from: 0, to: 4 }]]]),
    merges: [
      { unit: unitId('u1'), position: 1, paths: ['src/a.ts', 'test/a.test.ts'] },
      { unit: unitId('u2'), position: 2, paths: ['src/b.ts'] },
      { unit: unitId('r1'), position: 3, paths: ['test/a.test.ts'] },
      { unit: unitId('r1e1'), position: 4, paths: ['test/c.test.ts'] },
    ],
  },
  floors: new Set([visionClauseId('V-9')]),
  ...over,
});

describe('tail.regress', () => {
  it('tail.regress-attribution: a lens finding whose attribution (its lens\'s range, its evidence paths) is wholly finding-origin is below the regress brake', () => {
    assert.equal(introducedByFindingOrigin(world(), finding(1)), true, 'test/a.test.ts in (1, 4]: r1 only (u1 merged before the range)');
    assert.equal(introducedByFindingOrigin(world(), finding(1, { evidence: [{ path: 'test/c.test.ts', blob: null }] })), true, 'a re-entry of r1 is finding-origin');
    assert.equal(introducedByFindingOrigin(world(), finding(1, { lens: 'drift' })), false, 'drift covers (0, 4]: u1 and r1 touched it');
    assert.equal(introducedByFindingOrigin(world(), finding(1, { evidence: [{ path: 'src/b.ts', blob: null }] })), false, 'u2, a planned unit');
  });
  it('tail.regress-range: with no attribution, the lens\'s covered range holding only finding-origin merges decides', () => {
    const none = finding(1, { evidence: [{ path: '/abs/evidence.log', blob: null }] });
    assert.equal(introducedByFindingOrigin(world(), none), false, '(1, 4] holds u2\'s merge');
    const later = world({ history: { ...world().history, audits: new Map([[AUDIT, [{ lens: 'vacuity', from: 2, to: 4 }]]]), merges: world().history.merges.filter((m) => m.unit !== 'u2') } });
    assert.equal(introducedByFindingOrigin(later, none), true, 'only r1 and its re-entry merged in (2, 4]');
    const empty = world({ history: { audits: new Map([[AUDIT, [{ lens: 'vacuity', from: 4, to: 4 }]]]), merges: world().history.merges } });
    assert.equal(introducedByFindingOrigin(empty, none), false, 'an empty range introduces nothing');
    assert.equal(introducedByFindingOrigin(world(), finding(1, { lens: 'walkthrough' })), false, 'only an audit lens\'s finding');
  });
  it('tail.exempt: no brake for a P1, a finding that an obligation is broken or a walkthrough finding; the settled brake spares a non-negotiable clause', () => {
    assert.equal(brakeOf(world(), finding(1)), 'regress');
    assert.equal(brakeOf(world(), finding(1, { severity: 'P1' })), null);
    assert.equal(brakeOf(world(), finding(1, { obligation: obligationId('I-1'), lens: 'invariants' })), null, 'an obligation broken');
    assert.equal(brakeOf(world(), finding(1, { obligation: obligationId('I-1') })), 'regress', 'a vacuous witness of an obligation');
    const planned = finding(2, { evidence: [{ path: 'src/b.ts', blob: null }] });
    assert.equal(brakeOf(world(), planned), null);
    assert.equal(brakeOf(world({ settled: true }), planned), 'settled');
    assert.equal(brakeOf(world({ settled: true }), { ...planned, visionClauses: [visionClauseId('V-9')] }), null, 'a floor');
    // m5 run 6: walk-2 passed MS-2, settling the arc; its five P2 deviations are the milestone's verdict, never braked.
    const walked = { ...planned, lens: 'walkthrough' as const, source: { type: 'job' as const, job: jobId('walk', 2) } };
    assert.equal(brakeOf(world({ settled: true }), walked), null, 'a walkthrough finding at the settled point');
    assert.equal(brakeOf(world({ settled: true, findingOrigin: new Set([unitId('u1'), unitId('u2'), unitId('r1')]) }), walked), null, 'nor over finding-origin code');
  });
});

describe('tail.settled-point', () => {
  const units: readonly TailUnit[] = [
    { id: unitId('u1'), origin: undefined, cut: false, repairs: [] },
    { id: unitId('u2'), origin: 'planned', cut: true, repairs: [] },
    { id: unitId('c1'), origin: 'checkpoint', cut: false, repairs: ['F-4'] },
    { id: unitId('r1'), origin: 'repair', cut: false, repairs: ['I-1'] },
    { id: unitId('p1'), origin: 'polish', cut: false, repairs: [] },
  ];
  const rootOf = (u: UnitId): UnitId => u;
  const view = (status: Readonly<Record<string, string>>, passed: readonly string[]): JournalView => ({
    unit: (u: UnitId) => ({ status: status[u] ?? 'active', supersededBy: null }),
    walkFacts: () => passed.map((m) => ({ seq: 1, fact: { kind: 'milestone-passed', milestone: m } })),
  }) as unknown as JournalView;
  const plan = (milestones: readonly string[]): PlanM1 => ({ milestones: milestones.map((id) => ({ id: id as MilestoneId })) }) as unknown as PlanM1;

  it('finding-origin: origin repair, or a spec repairing a finding', () => {
    assert.deepEqual([...findingOriginRoots(units, rootOf)].sort(), ['c1', 'r1']);
  });
  it('every milestone passed and every unit not finding-origin merged or cut; a plan without milestones needs the second alone', () => {
    const origin = findingOriginRoots(units, rootOf);
    const merged = { u1: 'retired', p1: 'retired' };
    assert.equal(settledPoint(view(merged, ['MS-1']), plan(['MS-1']), units, origin, rootOf), true);
    assert.equal(settledPoint(view(merged, []), plan(['MS-1']), units, origin, rootOf), false, 'a milestone not passed');
    assert.equal(settledPoint(view({ u1: 'retired' }, ['MS-1']), plan(['MS-1']), units, origin, rootOf), false, 'the polish unit is in flight');
    assert.equal(settledPoint(view(merged, []), plan([]), units, origin, rootOf), true, 'no milestones');
  });
});

describe('tail.released', () => {
  const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
    lens: 'vacuity', severity: 'P3', obligation: null, visionClauses: [], claim: 'the test asserts nothing', cause: 'list: no assertion',
    evidence: [{ path: 'test/a.test.ts', blob: sha('b'.repeat(40)) }], mutant: null, source: { type: 'job', job: AUDIT }, gateHadPassed: false, ...over,
  });
  it('tail.released-suppressed: a released key never opens again, whatever its evidence', () => {
    const j = openJournal(absPath(tmpDir('tail-released')), ARC);
    try {
      assert.deepEqual(openFinding(j, draft()), { kind: 'opened', id: 'F-1' });
      ruleFinding(j, F(1), 'released', { type: 'release', job: CKPT, reason: 'p3' });
      assert.deepEqual(openFinding(j, draft()), { kind: 'suppressed', by: 'F-1' });
      assert.deepEqual(openFinding(j, draft({ evidence: [{ path: 'test/a.test.ts', blob: sha('c'.repeat(40)) }] })), { kind: 'suppressed', by: 'F-1' }, 'a changed blob does not lift a release');
      assert.deepEqual(openFinding(j, draft({ cause: 'list: another gap' })), { kind: 'opened', id: 'F-2' });
      ruleFinding(j, F(2), 'released', { type: 'checkpoint', job: CKPT });
      assert.throws(() => ruleFinding(j, F(2), 'released', { type: 'checkpoint', job: CKPT }), /finding F-2 is ruled/, 'terminal');
    } finally {
      j.close();
    }
  });
  it('tail.p1-never-released: a checkpoint never releases a P1', () => {
    const j = openJournal(absPath(tmpDir('tail-p1')), ARC);
    try {
      openFinding(j, draft({ severity: 'P1', obligation: obligationId('I-1') }));
      assert.throws(() => ruleFinding(j, F(1), 'released', { type: 'checkpoint', job: CKPT }), /P1s never bank \(only a disposition ruling releases one\)/);
    } finally {
      j.close();
    }
  });
  it('tail.release-reader: code\'s release names its job and reason, and only ever releases', () => {
    const to = { state: 'ruled', disposition: 'released', by: { type: 'release', job: 'ckpt-3', reason: 'settled' } };
    assert.deepEqual(findingTo(to, 'to'), to);
    assert.throws(() => findingTo({ ...to, disposition: 'deferred' }, 'to'), SchemaError);
    assert.throws(() => findingTo({ ...to, by: { ...to.by, reason: 'tired' } }, 'to'), SchemaError);
  });
});

describe('tail.gate-debt', () => {
  const f = (severity: 'blocking' | 'note' | 'pre-existing', text: string, debt: Readonly<{ drag: string }> | null | 'unrecorded') => ({ severity, path: null, text, contractRef: null, experiments: [], debt });
  it('a note banks only with a drag; a pre-existing defect always; a dev.12 note as dev.12 banked it; never a blocking finding or a blank text', () => {
    assert.deepEqual(gateDebtNotes([
      f('note', 'parse re-reads the file per call.', { drag: 'Every reader of big inputs  pays it.' }),
      f('note', 'The earlier finding is resolved.', null),
      f('note', 'A test could also check the empty case.', { drag: '  ' }),
      f('pre-existing', 'add() drops a trailing zero.', null),
      f('note', 'Rename mul.', 'unrecorded'),
      f('blocking', 'mul is wrong.', { drag: 'x' }),
      f('note', '  ', { drag: 'x' }),
    ]), [
      { index: 0, what: 'parse re-reads the file per call. Drag: Every reader of big inputs pays it.' },
      { index: 3, what: 'add() drops a trailing zero.' },
      { index: 4, what: 'Rename mul.' },
    ]);
  });
});
