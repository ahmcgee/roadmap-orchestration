// The transition table over an obligations file (src/holistic/table.ts `obligationEffects`), exhaustively:
// every witnessed obligation's case (activation, latch, completion, verdict, selection), every exempt state, split
// parents over every pair of child situations (H14) and a nested split; plus `completes`, `latches` and the brake.
// The case table itself is `table.total` in test/m3-schemas.test.ts. `gradeTree` (src/pipeline/integrate.ts): a red
// lane witnessing only measured obligations is never unexplained.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ObligationId, type UnitId, laneId, obligationId, unitId } from '../src/core/ids.ts';
import { type ObligationEffect, brakesOn, completes, latches, obligationEffects } from '../src/holistic/table.ts';
import { type ObligationDef, OBSERVATION_VERDICTS, type ObservationVerdict, parseObligations, witnessRecord } from '../src/holistic/types.ts';
import { type Claims, gradeTree } from '../src/pipeline/integrate.ts';
import type { JourneyRun } from '../src/pipeline/lanes.ts';

const LANE_REV = '0123456789abcdef';
type Raw = Record<string, unknown>;

function raw(id: string, over: Raw = {}): Raw {
  return {
    id, rev: 1, statement: `statement of ${id}`, docRef: { path: 'docs/target.md', anchor: '#a', quotedText: 'q' }, serves: ['V-1'],
    witness: { lane: 'journey', testIds: [id] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: LANE_REV, witness: { lane: 'journey', testIds: [id] } },
    deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' }, ...over,
  };
}
const splitRaw = (id: string, children: readonly string[], over: Raw = {}): Raw =>
  raw(id, { witness: null, proofJudgment: null, state: { type: 'split', children: [...children].sort() }, ...over });

function file(obligations: readonly Raw[]): readonly ObligationDef[] {
  return parseObligations({
    schema: 'roadmap/obligations-m3', cutLine: 'cut', mapping: { paths: [] }, obligations,
    lanes: [{ id: 'journey', argv: ['node', '--test'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], evidenceExcludes: [], reporter: 'node-test' }],
  }).obligations;
}

const ids = (...xs: string[]): ReadonlySet<ObligationId> => new Set(xs.map((x) => obligationId(x)));
const verdicts = [...OBSERVATION_VERDICTS, null] as const;

/** A leaf child's situation: the raw fields, the inputs it needs, and its effect by the table's rows. */
type Leaf = Readonly<{ name: string; over: Raw; latched: boolean; completing: boolean; verdict: ObservationVerdict | null; effect: ObligationEffect }>;
function* leaves(): Generator<Leaf> {
  for (const state of ['waived', 'deferred', 'retired'] as const) {
    yield { name: state, over: { state: { type: state, ruling: 'C-1' } }, latched: false, completing: false, verdict: 'held', effect: 'exempt' };
  }
  for (const verdict of verdicts) {
    const held = verdict === 'held';
    yield { name: `must-hold ${verdict}`, over: {}, latched: false, completing: false, verdict, effect: held ? 'discharged' : 'red' };
    for (const latched of [false, true]) for (const completing of [false, true]) {
      const effect: ObligationEffect = latched ? (held ? 'discharged' : 'red') : !completing ? 'measured' : held ? 'latch' : 'red';
      yield { name: `future latched=${latched} completing=${completing} ${verdict}`, over: { activation: 'future', deliveredBy: ['u1'] }, latched, completing, verdict, effect };
    }
  }
}

function effectsOf(defs: readonly ObligationDef[], leafs: ReadonlyMap<string, Leaf>, selected: ReadonlySet<ObligationId>): ReadonlyMap<ObligationId, ObligationEffect> {
  const pick = (p: (l: Leaf) => boolean): ReadonlySet<ObligationId> => new Set([...leafs].filter(([, l]) => p(l)).map(([id]) => obligationId(id)));
  return obligationEffects({
    obligations: defs, selected, latched: pick((l) => l.latched), completing: pick((l) => l.completing),
    verdict: (o, witness) => {
      assert.deepEqual(witness, o.witness);
      const l = leafs.get(o.id);
      if (l === undefined) throw new Error(`no leaf ${o.id}`);
      return l.verdict;
    },
  });
}

describe('table.effects: the table over an obligations file', () => {
  it('every witnessed or exempt obligation, selected or not, takes its row', () => {
    for (const leaf of leaves()) for (const sel of [true, false]) {
      const defs = file([raw('I-1', leaf.over)]);
      const effects = effectsOf(defs, new Map([['I-1', leaf]]), sel ? ids('I-1') : ids());
      assert.equal(effects.get(obligationId('I-1')), leaf.effect, `${leaf.name} selected=${sel}`);
    }
  });

  it('a split parent over every pair of child situations and selections (H14)', () => {
    const all = [...leaves()];
    let n = 0;
    for (const a of all) for (const b of all) for (const sa of [true, false]) for (const sb of [true, false]) {
      const defs = file([splitRaw('I-1', ['I-2', 'I-3']), raw('I-2', { ...a.over, parent: 'I-1' }), raw('I-3', { ...b.over, parent: 'I-1' })]);
      const selected = new Set([...(sa ? ['I-2'] : []), ...(sb ? ['I-3'] : [])].map((x) => obligationId(x)));
      const effects = effectsOf(defs, new Map([['I-2', a], ['I-3', b]]), selected);
      const kids = [{ effect: a.effect, selected: sa }, { effect: b.effect, selected: sb }];
      const expected: ObligationEffect = kids.some((k) => k.selected && k.effect === 'red') ? 'red'
        : kids.filter((k) => k.effect !== 'exempt').every((k) => k.effect === 'discharged') ? 'discharged' : 'measured';
      const label = `${a.name}${sa ? ' (selected)' : ''} / ${b.name}${sb ? ' (selected)' : ''}`;
      assert.equal(effects.get(obligationId('I-2')), a.effect, label);
      assert.equal(effects.get(obligationId('I-3')), b.effect, label);
      assert.equal(effects.get(obligationId('I-1')), expected, label);
      n += 1;
    }
    assert.equal(n, all.length * all.length * 4);
  });

  it('a split parent is never witnessed directly: its verdict is never asked', () => {
    const red: Leaf = { name: 'red', over: {}, latched: false, completing: false, verdict: 'not-held', effect: 'red' };
    const defs = file([splitRaw('I-1', ['I-2']), raw('I-2', { parent: 'I-1' })]);
    const effects = effectsOf(defs, new Map([['I-2', red]]), ids('I-1', 'I-2'));
    assert.equal(effects.get(obligationId('I-1')), 'red');
  });

  it('a nested split takes its effect through its split child', () => {
    const held: Leaf = { name: 'held', over: {}, latched: false, completing: false, verdict: 'held', effect: 'discharged' };
    const red: Leaf = { name: 'red', over: {}, latched: false, completing: false, verdict: 'unwitnessed', effect: 'red' };
    const defs = file([
      splitRaw('I-1', ['I-2', 'I-3']), splitRaw('I-2', ['I-4', 'I-5'], { parent: 'I-1' }), raw('I-3', { parent: 'I-1' }),
      raw('I-4', { parent: 'I-2' }), raw('I-5', { parent: 'I-2' }),
    ]);
    const allHeld = effectsOf(defs, new Map([['I-3', held], ['I-4', held], ['I-5', held]]), ids('I-1', 'I-2', 'I-3', 'I-4', 'I-5'));
    assert.deepEqual([...allHeld].sort(), [['I-1', 'discharged'], ['I-2', 'discharged'], ['I-3', 'discharged'], ['I-4', 'discharged'], ['I-5', 'discharged']]);
    const deepRed = effectsOf(defs, new Map([['I-3', held], ['I-4', held], ['I-5', red]]), ids('I-1', 'I-2', 'I-3', 'I-4', 'I-5'));
    assert.equal(deepRed.get(obligationId('I-2')), 'red');
    assert.equal(deepRed.get(obligationId('I-1')), 'red');
    const unselected = effectsOf(defs, new Map([['I-3', held], ['I-4', held], ['I-5', red]]), ids('I-3'));
    assert.equal(unselected.get(obligationId('I-2')), 'measured');
    assert.equal(unselected.get(obligationId('I-1')), 'measured');
  });

  it('completes: every delivering unit published, at least one by this candidate', () => {
    const [o] = file([raw('I-1', { activation: 'future', deliveredBy: ['parse', 'report'] })]);
    assert.ok(o !== undefined);
    const u = (...xs: string[]): UnitId[] => xs.map((x) => unitId(x));
    assert.equal(completes(o, new Set(u('parse')), u('report')), true);
    assert.equal(completes(o, new Set(), u('parse', 'report')), true);
    assert.equal(completes(o, new Set(), u('report')), false);
    assert.equal(completes(o, new Set(u('parse', 'report')), u('tidy')), false, 'already delivered: this candidate completes nothing');
    assert.equal(completes(o, new Set(u('parse')), u('tidy')), false);
  });

  it('latches and the brake', () => {
    const effects = new Map<ObligationId, ObligationEffect>([
      [obligationId('I-3'), 'latch'], [obligationId('I-1'), 'latch'], [obligationId('I-2'), 'red'], [obligationId('I-4'), 'discharged'],
    ]);
    assert.deepEqual(latches(effects), ['I-1', 'I-3']);
    assert.equal(brakesOn(effects, ids('I-1', 'I-4')), false);
    assert.equal(brakesOn(effects, ids('I-2')), true, 'a selected red brakes');
    assert.throws(() => brakesOn(effects, ids('I-9')), /I-9/);
  });
});

describe('gradeTree: measured lanes', () => {
  const lane = (id: string): Raw => ({ id, argv: ['node', '--test', `test/${id}.test.js`], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], evidenceExcludes: [], reporter: 'node-test' });
  const witnessed = (id: string, lid: string): Raw => ({ witness: { lane: lid, testIds: [id] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: LANE_REV, witness: { lane: lid, testIds: [id] } } });
  // I-1 must-hold on `journey`; I-2 future on `clash`, delivered by a sibling unit not yet published (paid M4b run 5).
  const obligations = parseObligations({
    schema: 'roadmap/obligations-m3', cutLine: 'cut', mapping: { paths: [] }, lanes: [lane('journey'), lane('clash')],
    obligations: [raw('I-1', witnessed('I-1', 'journey')), raw('I-2', { ...witnessed('I-2', 'clash'), activation: 'future', deliveredBy: ['clash-refusal'] })],
  });
  const record = (lid: string, malformed: boolean, testId: string): ReturnType<typeof witnessRecord> => witnessRecord({
    v: 1, lane: lid, laneRev: LANE_REV, envId: '0123456789abcdef', treeSha: 'a'.repeat(40), inv: 'arc/1#1', runner: 'node-test', purpose: 'witness', malformed,
    records: malformed ? [] : [{ testId, selected: 1, outcome: 'pass' }],
  }, 'record');
  const run = (lid: string, malformed: boolean, testId: string): JourneyRun => ({
    lane: laneId(lid), inv: null, verdict: malformed ? 'fail' : 'pass', flaky: false, dir: null, record: record(lid, malformed, testId),
  });
  // The clash lane's witness file does not exist yet: `Could not find`, a malformed record, a red lane.
  const runs = [run('journey', false, 'I-1'), run('clash', true, 'I-2')];
  const claims = (latched: ReadonlySet<ObligationId>, completing: ReadonlySet<ObligationId> = new Set()): Claims => ({
    obligations, selected: ids('I-1', 'I-2'), completing, repairs: new Set(), latched, lanes: obligations.lanes,
  });

  it('a red lane witnessing only a future obligation not latched is measured: neither red nor unexplained', () => {
    const g = gradeTree(claims(new Set()), runs, new Set(), new Set(), new Set());
    assert.equal(g.effects.get(obligationId('I-2')), 'measured');
    assert.deepEqual([g.red, g.unexplained], [[], []]);
  });

  it('once latched, the same lane is must-hold: red for the brake and unexplained', () => {
    const g = gradeTree(claims(ids('I-2')), runs, new Set(), new Set(), new Set());
    assert.deepEqual([g.red, g.unexplained], [['I-2'], ['clash']]);
  });

  it('completed by this candidate, its malformed witness is red through its effect', () => {
    const g = gradeTree(claims(new Set(), ids('I-2')), runs, ids('I-2'), new Set(), new Set());
    assert.deepEqual(g.red, ['I-2']);
  });
});
