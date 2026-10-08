// Which witness ids a unit must make pass (M4a rev 3, D1, R33), its smoke targets (Q16), and which of them a lane run
// leaves missing (`missingWitnesses`, the one comparator of the lanes stage and `witness-check`). Pure: the journal view is
// a stub holding exactly what `requiredWitnesses` reads (published merges, latched obligations).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DoneRecord, IntentRecord } from '../src/core/events.ts';
import { type ObligationId, type Sha, envId, invocationIdOf, laneId, laneRev, opId, sha, unitId } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import { type SpecM1, specM1 } from '../src/core/records.ts';
import { missingWitnesses, requiredWitnesses, smokeTargets } from '../src/holistic/required.ts';
import { type Obligations, type WitnessRecord, parseObligations } from '../src/holistic/types.ts';

const ARC = 'arc-1';
const C1 = sha('1'.repeat(40));
const C2 = sha('2'.repeat(40));
const AT = sha('a'.repeat(40));

/** A view holding unit publications (`unit` → its published merge) and latched obligations; nothing else is read. */
function view(published: Readonly<Record<string, Sha>>, latched: readonly string[] = []): JournalView {
  const ffs: IntentRecord[] = Object.entries(published).map(([unit, merge], i) => ({
    type: 'intent', op: opId(ARC as never, i + 1), kind: 'integration.ff', key: `ff:${unit}` as never, parent: { type: 'stage', unit: unitId(unit), stage: 'ff', attempt: 1 },
    ordinal: 1, deadlineAt: null, expect: { ref: 'refs/heads/main' as never, old: AT, new: merge, fingerprint: {} as never }, post: null,
  }) as IntentRecord);
  const stub = {
    opsOf: (kind: string) => (kind === 'integration.ff' ? ffs : []),
    doneOf: (): DoneRecord => ({ type: 'done', op: opId(ARC as never, 1), kind: 'integration.ff', outcome: { kind: 'published' }, recoveredBy: null }),
    holistic: () => ({ latched: latched.map((o) => ({ obligation: o, unit: unitId('u0'), treeSha: AT, seq: 1 })) }),
  };
  return stub as unknown as JournalView;
}

const LANE = { id: 'journey', argv: ['node', 'j.js'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], reporter: 'jsonl' };
const obligation = (id: string, tests: readonly string[], over: object = {}) => ({
  id, rev: 1, statement: `s ${id}`, docRef: { path: 'docs/a.md', anchor: '#a', quotedText: 'q' }, serves: ['V-1'], witness: { lane: 'journey', testIds: tests },
  proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: '0123456789abcdef', witness: { lane: 'journey', testIds: tests } }, deliveredBy: [], activation: 'must-hold',
  contracts: [], state: { type: 'active' }, ...over,
});
const OBLIGATIONS: Obligations = parseObligations({
  schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [LANE], mapping: { paths: [] },
  obligations: [
    obligation('I-1', ['t-delivered'], { activation: 'future', deliveredBy: ['u1'] }),
    obligation('I-2', ['t-shared'], { activation: 'future', deliveredBy: ['u1', 'u2'] }),
    obligation('I-3', ['t-repaired']),
    obligation('I-4', ['t-kept', 't-shared']),
    obligation('I-5', ['t-future-declared'], { activation: 'future', deliveredBy: ['u9'] }),
    obligation('I-6', ['t-latched'], { activation: 'future', deliveredBy: ['u0'] }),
    obligation('I-7', ['t-waived'], { activation: 'future', deliveredBy: ['u1'], state: { type: 'waived', ruling: 'C-1' } }),
  ],
});
const spec = (over: object = {}): SpecM1 => specM1({
  schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes: [], acceptance: [{ id: 'A1', clause: 'c', failLoudIfUndelivered: false, state: 'active' }], scope: ['src/**'],
  resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] }, ...over,
}, 'spec');
const tree = (ancestors: readonly Sha[]) => ({ sha: AT, isAncestor: (c: Sha) => ancestors.includes(c) });
const rows = (r: ReturnType<typeof requiredWitnesses>) => r.map((x) => `${x.role} ${x.source.id} ${x.testId}`);

describe('required', () => {
  it('required.completes-delivered: a unit completes what it alone delivers; an exempt obligation binds nothing', () => {
    const r = requiredWitnesses(view({}), OBLIGATIONS, unitId('u1'), spec(), tree([]));
    assert.deepEqual(rows(r), ['target I-1 t-delivered']);
  });

  it('required.multi-deliverer-not-yet-complete: a shared obligation is required once every other deliverer\'s merge is an ancestor of the tree', () => {
    assert.deepEqual(rows(requiredWitnesses(view({ u2: C2 }), OBLIGATIONS, unitId('u1'), spec(), tree([]))), ['target I-1 t-delivered'], 'u2 published, not merged in');
    assert.deepEqual(rows(requiredWitnesses(view({}), OBLIGATIONS, unitId('u1'), spec(), tree([C2]))), ['target I-1 t-delivered'], 'u2 never published');
    assert.deepEqual(rows(requiredWitnesses(view({ u2: C2 }), OBLIGATIONS, unitId('u1'), spec(), tree([C2]))), ['target I-1 t-delivered', 'target I-2 t-shared']);
  });

  it('required.repairs-and-witness-items: repaired obligations and active witness items are targets; struck items are not', () => {
    const s = spec({
      repairs: ['F-3', 'I-3'],
      witnesses: [
        { id: 'W-1', lane: 'journey', testId: 't-item', clause: 'A1', skeleton: 's', state: 'active' },
        { id: 'W-2', lane: 'journey', testId: 't-struck', clause: 'A1', skeleton: 's', state: 'struck' },
      ],
    });
    assert.deepEqual(rows(requiredWitnesses(view({}), OBLIGATIONS, unitId('u1'), s, tree([]))), [
      'target I-1 t-delivered', 'target W-1 t-item', 'target I-3 t-repaired',
    ]);
  });

  it('required.preservation: declared must-holds (by activation or latched) not already targets, in lane and test order', () => {
    const s = spec({ obligations: ['I-1', 'I-4', 'I-5', 'I-6'] });
    const r = requiredWitnesses(view({}, ['I-6']), OBLIGATIONS, unitId('u1'), s, tree([]));
    assert.deepEqual(rows(r), ['target I-1 t-delivered', 'preservation I-4 t-kept', 'preservation I-6 t-latched', 'preservation I-4 t-shared']);
    assert.deepEqual(smokeTargets(r).map((x) => x.testId), ['t-delivered'], 'smoke-targets: preservation must-holds are never smoked');
  });

  it('required.unknown-obligation-fails-loud: a spec naming an obligation the file lacks is a bug', () => {
    assert.throws(() => requiredWitnesses(view({}), OBLIGATIONS, unitId('u1'), spec({ obligations: ['I-99'] }), tree([])), /I-99/);
    assert.throws(() => requiredWitnesses(view({}), OBLIGATIONS, unitId('u1'), spec({ repairs: ['I-99'] }), tree([])), /I-99/);
  });
});

describe('smoke-targets', () => {
  it('smoke-targets.targets-only: a target from each source; an empty requirement has none', () => {
    const s = spec({ repairs: ['I-3'], witnesses: [{ id: 'W-1', lane: 'journey', testId: 't-item', clause: 'A1', skeleton: 's', state: 'active' }], obligations: ['I-4'] });
    const r = requiredWitnesses(view({}), OBLIGATIONS, unitId('u1'), s, tree([]));
    assert.deepEqual(smokeTargets(r).map((x) => x.source.id), ['I-1', 'W-1', 'I-3']);
    assert.deepEqual(smokeTargets([]), []);
  });
});

const record = (tests: readonly [string, number, WitnessRecord['records'][number]['outcome']][], malformed = false): WitnessRecord => ({
  v: 1, lane: laneId('journey'), laneRev: laneRev('0123456789abcdef'), envId: envId('fedcba9876543210'), treeSha: AT, inv: invocationIdOf('arc-1/3#1'),
  runner: 'jsonl', purpose: 'witness', malformed, records: malformed ? [] : tests.map(([testId, selected, outcome]) => ({ testId, selected, outcome })),
});
const ref = (testId: string, lane = 'journey') => ({ lane: laneId(lane), testId });

describe('missing', () => {
  it('missing.pass-is-witnessed: every required id passing leaves nothing missing', () => {
    assert.deepEqual(missingWitnesses([record([['a', 1, 'pass'], ['b', 2, 'pass']])], [ref('a'), ref('b')]), { missing: [], failed: [], malformed: [] });
  });

  it('missing.failed-and-zero-selected: a failing id is failed; absent, zero-selected or skipped ids are missing', () => {
    const r = record([['a', 1, 'fail'], ['b', 0, 'zero-selected'], ['c', 1, 'skip'], ['e', 1, 'pass']]);
    assert.deepEqual(missingWitnesses([r], [ref('e'), ref('d'), ref('c'), ref('b'), ref('a')]), {
      missing: [ref('b'), ref('c'), ref('d')], failed: [ref('a')], malformed: [],
    });
  });

  it('missing.malformed-is-missing: a malformed record witnesses nothing; a lane with no record is missing too', () => {
    assert.deepEqual(missingWitnesses([record([], true)], [ref('a'), ref('x', 'other')]), { missing: [ref('a'), ref('x', 'other')], failed: [], malformed: ['journey'] });
  });

  it('missing.one-record-per-lane: two records of one lane are a bug; a required id listed twice counts once', () => {
    assert.throws(() => missingWitnesses([record([]), record([])], [ref('a')]), /two records of lane journey/);
    assert.deepEqual(missingWitnesses([record([])], [ref('a'), ref('a')]).missing, [ref('a')]);
  });
});

void (null as unknown as ObligationId);
