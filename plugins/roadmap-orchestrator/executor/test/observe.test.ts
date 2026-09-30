// Observations (src/holistic/observe.ts): the pure verdict over a witness's tests (`observe.verdicts`), and the
// observation store's reuse rule (`observe.reuse-keys`): all four keys and the kept record's hash, never a mutant
// record (G13), the latest by log order.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arcId, envId, findingId, invocationId, laneId, laneRev, opId, sha, sha256, unitId } from '../src/core/ids.ts';
import { canonicalJson as fileJson } from '../src/core/fsx.ts';
import { sha256Hex } from '../src/core/json.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { type WitnessedEntry, observationOf, observationStore, observedVerdict, reuse, verdictOf } from '../src/holistic/observe.ts';
import { type ObservationKey, type WitnessOutcome, type WitnessRecord, WITNESS_OUTCOMES } from '../src/holistic/types.ts';

const LANE = laneId('journey');
const INV = invocationId(opId(arcId('arc-1'), 7), 1);
const TREE = sha('a'.repeat(40));
const KEY: ObservationKey = { treeSha: TREE, lane: LANE, laneRev: laneRev('0123456789abcdef'), envId: envId('fedcba9876543210') };

function record(tests: readonly (readonly [string, WitnessOutcome])[], over: Partial<WitnessRecord> = {}): WitnessRecord {
  return {
    v: SCHEMA_VERSION, ...KEY, inv: INV, runner: 'node-test', purpose: 'witness', malformed: false,
    records: [...tests].sort(([a], [b]) => (a < b ? -1 : 1)).map(([testId, outcome]) => ({ testId, selected: outcome === 'zero-selected' ? 0 : 1, outcome })),
    ...over,
  };
}
const w = (...testIds: string[]) => ({ lane: LANE, testIds });

describe('observe.verdicts', () => {
  it('held, not-held, partial and unwitnessed over every pair of outcomes, a missing test counting as zero-selected', () => {
    const outcomes = [...WITNESS_OUTCOMES, 'missing'] as const;
    for (const a of outcomes) for (const b of outcomes) {
      const tests: (readonly [string, WitnessOutcome])[] = [];
      if (a !== 'missing') tests.push(['a', a]);
      if (b !== 'missing') tests.push(['b', b]);
      const effective = [a, b].map((o) => (o === 'missing' ? 'zero-selected' : o));
      const expected = effective.includes('fail') ? 'not-held'
        : effective.every((o) => o === 'pass') ? 'held'
          : effective.includes('pass') ? 'partial' : 'unwitnessed';
      assert.equal(verdictOf(record(tests), w('a', 'b')), expected, `${a}, ${b}`);
    }
  });

  it('only the declared tests count; a malformed record is unwitnessed', () => {
    const r = record([['a', 'pass'], ['other', 'fail']]);
    assert.equal(verdictOf(r, w('a')), 'held');
    assert.equal(verdictOf(r, w('other')), 'not-held');
    assert.equal(verdictOf(record([], { malformed: true }), w('a')), 'unwitnessed');
  });

  it('a pass counted with more than one selection is still held', () => {
    const r: WitnessRecord = { ...record([]), records: [{ testId: 'a', selected: 3, outcome: 'pass' }] };
    assert.equal(verdictOf(r, w('a')), 'held');
  });
});

describe('observe.reuse-keys', () => {
  const bytesOf = (r: WitnessRecord): string => fileJson(r);
  function entry(r: WitnessRecord, seq: number, over: Partial<WitnessedEntry> = {}): WitnessedEntry {
    return {
      lane: r.lane, laneRev: r.laneRev, envId: r.envId, treeSha: r.treeSha, inv: r.inv, recordsSha256: sha256(sha256Hex(bytesOf(r))), purpose: r.purpose,
      for: r.purpose === 'witness' ? { type: 'candidate', unit: unitId('u1'), attempt: 1 } : { type: 'mutant', finding: findingId('F-1'), of: TREE },
      seq, ...over,
    };
  }
  const held = record([['a', 'pass']]);

  it('an observation is reused only on all four keys', () => {
    const obs = observationOf(entry(held, 10), bytesOf(held));
    assert.ok(obs !== null);
    const store = observationStore([obs]);
    assert.equal(reuse(store, KEY), obs);
    assert.equal(observedVerdict(store, KEY, w('a')), 'held');
    for (const other of [
      { ...KEY, treeSha: sha('b'.repeat(40)) }, { ...KEY, lane: laneId('suite') }, { ...KEY, laneRev: laneRev('1123456789abcdef') }, { ...KEY, envId: envId('0edcba9876543210') },
    ]) {
      assert.equal(reuse(store, other), null, JSON.stringify(other));
      if (other.lane === LANE) assert.equal(observedVerdict(store, other, w('a')), null);
    }
  });

  it('a missing or changed witness file is no observation', () => {
    assert.equal(observationOf(entry(held, 10), null), null);
    const changed = record([['a', 'fail']]);
    assert.equal(observationOf(entry(held, 10), bytesOf(changed)), null);
    assert.equal(observationOf(entry(held, 10), `${bytesOf(held)} `), null);
  });

  it('a mutant record never certifies, even on the key of an unmodified tree (G13)', () => {
    const mutant = record([['a', 'pass']], { purpose: 'mutant' });
    assert.equal(observationOf(entry(mutant, 11), bytesOf(mutant)), null);
    assert.equal(reuse(observationStore([]), KEY), null);
  });

  it('the latest observation of a key is the one reused, whatever order they are read in', () => {
    const failed = record([['a', 'fail']], { inv: invocationId(opId(arcId('arc-1'), 9), 1) });
    const first = observationOf(entry(held, 10), bytesOf(held));
    const second = observationOf(entry(failed, 20), bytesOf(failed));
    assert.ok(first !== null && second !== null);
    for (const order of [[first, second], [second, first]]) assert.equal(observedVerdict(observationStore(order), KEY, w('a')), 'not-held');
  });

  it('a file that hashes right but names another key, purpose or invocation than its fact is refused loudly', () => {
    assert.throws(() => observationOf(entry(held, 10, { treeSha: sha('c'.repeat(40)) }), bytesOf(held)), /names/);
    assert.throws(() => observationOf(entry(held, 10, { inv: invocationId(opId(arcId('arc-1'), 8), 1) }), bytesOf(held)), /names/);
  });

  it('a witness read on another lane is a caller error', () => {
    assert.throws(() => observedVerdict(observationStore([]), KEY, { lane: laneId('suite'), testIds: ['a'] }), /lane suite/);
  });
});
