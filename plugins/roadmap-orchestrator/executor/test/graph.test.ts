// The unit graph with re-entry substituted (src/schedule/graph.ts, F15) and the frozen rank order
// (src/schedule/types.ts, F17).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type UnitId, findingId, unitId } from '../src/core/ids.ts';
import { type GraphUnit, effectiveGraph, findCycle, holdCycle, lineageHead } from '../src/schedule/graph.ts';
import { type Rank, compareRank } from '../src/schedule/types.ts';

const g = (id: string, after: readonly string[] = [], reenters?: string): GraphUnit => ({
  id: unitId(id), after: after.map((a) => unitId(a)), ...(reenters === undefined ? {} : { reenters: { unit: unitId(reenters) } }),
});

describe('graph', () => {
  it('graph.effective-cycle: `top after old` plus `new after top, reenters old` is a cycle once old is replaced by new', () => {
    const units = [g('old'), g('top', ['old']), g('new', ['top'], 'old')];
    assert.deepEqual(Object.fromEntries(effectiveGraph(units)), { top: ['new'], new: ['top'] });
    assert.deepEqual(findCycle(effectiveGraph(units)), ['new', 'top', 'new']);
  });

  it('a re-entry without that edge is acyclic, and edges on a superseded unit move to its lineage head, transitively', () => {
    const units = [g('base'), g('old', ['base']), g('top', ['old', 'base']), g('new', ['base'], 'old'), g('newer', [], 'new')];
    assert.equal(lineageHead(units, unitId('old')), 'newer');
    assert.equal(lineageHead(units, unitId('base')), 'base');
    assert.deepEqual(Object.fromEntries(effectiveGraph(units)), { base: [], top: ['base', 'newer'], newer: [] });
    assert.equal(findCycle(effectiveGraph(units)), null);
  });

  it('finds a plain cycle and refuses two re-entries of one unit', () => {
    const cyclic = new Map<UnitId, readonly UnitId[]>([[unitId('a'), [unitId('b')]], [unitId('b'), [unitId('c')]], [unitId('c'), [unitId('a')]]]);
    assert.deepEqual(findCycle(cyclic), ['a', 'b', 'c', 'a']);
    assert.throws(() => effectiveGraph([g('old'), g('x', [], 'old'), g('y', [], 'old')]), /both re-enter old/);
  });
});

describe('hold cycles (arc feedback 2026-10-15)', () => {
  const held = (...rows: readonly (readonly [string, string, string])[]) =>
    new Map(rows.map(([u, finding, owner]) => [unitId(u), { finding: findingId(finding), owner: unitId(owner) }] as const));

  it('graph.hold-cycle: repairs each held by a finding another owns form a cycle of those findings, in canonical order; a chain is none', () => {
    assert.deepEqual(holdCycle(held(['r1', 'F-10', 'r2'], ['r2', 'F-9', 'r1'])), ['F-9', 'F-10']);
    // r3 waits on the cycle without being in it: only the cycle's findings.
    assert.deepEqual(holdCycle(held(['r1', 'F-2', 'r2'], ['r2', 'F-3', 'r3'], ['r3', 'F-1', 'r1'], ['r4', 'F-2', 'r2'])), ['F-1', 'F-2', 'F-3']);
    assert.equal(holdCycle(held(['r1', 'F-2', 'r2'], ['r2', 'F-3', 'r3'])), null);
    assert.equal(holdCycle(held()), null);
  });
});

describe('rank', () => {
  const r = (unit: string, extra: Partial<Rank>): Rank => ({ unit: unitId(unit), priority: 'normal', origin: 'planned', waitStartSeq: 10, bypassMerges: 0, promoted: false, planIndex: 0, ...extra });

  it('promoted units first, by age alone; then checkpoint before planned, then age, then plan index', () => {
    const ranks = [
      r('planned-old', { waitStartSeq: 1, planIndex: 3 }),
      r('checkpoint-young', { origin: 'checkpoint', waitStartSeq: 50, planIndex: 4 }),
      r('promoted-young-checkpoint', { origin: 'checkpoint', promoted: true, bypassMerges: 3, waitStartSeq: 40, planIndex: 5 }),
      r('promoted-old-planned', { promoted: true, bypassMerges: 4, waitStartSeq: 20, planIndex: 6 }),
      r('planned-tie-b', { waitStartSeq: 30, planIndex: 2 }),
      r('planned-tie-a', { waitStartSeq: 30, planIndex: 1 }),
    ];
    assert.deepEqual([...ranks].sort(compareRank).map((x) => x.unit), [
      'promoted-old-planned', 'promoted-young-checkpoint', 'checkpoint-young', 'planned-old', 'planned-tie-a', 'planned-tie-b',
    ]);
  });
});
