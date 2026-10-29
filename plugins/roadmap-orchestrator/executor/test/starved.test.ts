// M4b rev 3 (RC-11, step H2): charging under host pressure, pure. The ruling over a run's end and interval pressure
// (src/host/pressure.ts `pressureRuling`), the hold's release (`pressureHoldWaits`), and the transition table's reading
// of the hold a stage records for it: `interrupted` with cause `host-pressure{inv}` at every stage a run can starve,
// uncharged, no fix round, no park. The admission side is in test/ready.test.ts; the integrated one, under real CPU
// burners, in test/serial/pressure.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { invocationId, opId } from '../src/core/ids.ts';
import { newUnitState } from '../src/core/state.ts';
import {
  PRESSURE_SATURATED, type PressureRun, STARVED_HOLD_MS, STARVED_MAX, pressureHoldWaits, pressureRuling,
} from '../src/host/pressure.ts';
import { type StageOutcome, outcomeFact, transition } from '../src/pipeline/transitions.ts';
import { ARC, U1 } from './fixtures/log-records.ts';

const INV = invocationId(opId(ARC, 7), 1);
const INV2 = invocationId(opId(ARC, 9), 1);
const run = (end: PressureRun['end'], pressure: number | null, inv = INV): PressureRun => ({ inv, end, pressure });
const FIRST = { count: 0, rerun: false };

describe('pressure.ruling', () => {
  it('starved: a deadline or stall kill at or above the threshold; below it, or without a pressure, today\'s handling', () => {
    assert.deepEqual(pressureRuling([run('deadline', PRESSURE_SATURATED)], FIRST), { kind: 'starved', inv: INV, pressure: PRESSURE_SATURATED });
    assert.deepEqual(pressureRuling([run('stall', 0.9)], FIRST), { kind: 'starved', inv: INV, pressure: 0.9 });
    assert.deepEqual(pressureRuling([run('deadline', 0.4999)], FIRST), { kind: 'counts' });
    assert.deepEqual(pressureRuling([run('deadline', null)], FIRST), { kind: 'counts' }, 'no pressure (no schedstat, or a short run): null never counts as starved');
    assert.deepEqual(pressureRuling([run('other', 1)], FIRST), { kind: 'counts' }, 'a signal or a lost runner is no watchdog kill');
  });

  it('red-rerun: a red at or above the threshold reruns once; the rerun\'s red counts; a starved run wins over a red one', () => {
    assert.deepEqual(pressureRuling([run('red', 0.5)], FIRST), { kind: 'red-rerun', inv: INV, pressure: 0.5 });
    assert.deepEqual(pressureRuling([run('red', 0.5)], { count: 1, rerun: true }), { kind: 'counts' }, 'only the rerun\'s verdict counts');
    assert.deepEqual(pressureRuling([run('red', 0.49)], FIRST), { kind: 'counts' });
    assert.deepEqual(pressureRuling([run('red', null)], FIRST), { kind: 'counts' });
    // A red lane and its diagnostic rerun killed by its deadline: the starved rerun decides.
    assert.deepEqual(pressureRuling([run('red', 0.6), run('deadline', 0.7, INV2)], FIRST), { kind: 'starved', inv: INV2, pressure: 0.7 });
    assert.deepEqual(pressureRuling([run('red', 0.6), run('deadline', 0.7, INV2)], { count: 1, rerun: true }), { kind: 'starved', inv: INV2, pressure: 0.7 }, 'a rerun may starve');
    assert.deepEqual(pressureRuling([run('red', 0.1), run('red', 0.6, INV2)], FIRST), { kind: 'red-rerun', inv: INV2, pressure: 0.6 });
  });

  it('bound: from STARVED_MAX holds on, every run is charged as without pressure', () => {
    assert.equal(STARVED_MAX, 3);
    assert.equal(pressureRuling([run('deadline', 1)], { count: STARVED_MAX - 1, rerun: true }).kind, 'starved');
    assert.deepEqual(pressureRuling([run('deadline', 1)], { count: STARVED_MAX, rerun: true }), { kind: 'counts' });
    assert.deepEqual(pressureRuling([run('red', 1)], { count: STARVED_MAX, rerun: false }), { kind: 'counts' });
  });
});

describe('pressure.hold-release', () => {
  const AT = 1_000_000;
  const t = (dMs: number, runNs: number, waitNs: number) => ({ atMs: AT + dMs, runNs, waitNs });
  it('waits under 30 min unless a minute of ticks since the hold shows the host\'s cpu wait below the threshold', () => {
    assert.equal(pressureHoldWaits(AT, { ticks: [], nowMs: AT }), true);
    assert.equal(pressureHoldWaits(AT, { ticks: [], nowMs: AT + STARVED_HOLD_MS }), false);
    assert.equal(pressureHoldWaits(AT, { ticks: [t(0, 0, 0), t(60_000, 80, 20)], nowMs: AT + 60_001 }), false);
    assert.equal(pressureHoldWaits(AT, { ticks: [t(-1, 0, 0), t(59_999, 80, 20)], nowMs: AT + 60_001 }), true, 'the first tick is before the hold');
    assert.equal(pressureHoldWaits(AT, { ticks: [t(0, 0, 0), t(60_000, 20, 80)], nowMs: AT + 60_001 }), true);
  });
});

describe('pressure.transition', () => {
  const u = { ...newUnitState(U1, 'lanes', 'med'), counters: { ...newUnitState(U1, 'lanes', 'med').counters, chargeableFailures: 2 } };
  const STARVABLE: readonly StageOutcome[] = [
    { stage: 'plan-check', kind: 'interrupted' }, { stage: 'build', kind: 'interrupted' }, { stage: 'lanes', kind: 'interrupted' },
    { stage: 'gate', kind: 'interrupted' }, { stage: 'candidate', kind: 'interrupted' },
  ];
  it('the hold a starved or red-rerun run records is uncharged, no fix round and no park, even one failure short of the chargeable bound', () => {
    for (const o of STARVABLE) {
      assert.deepEqual(transition(u, o), { kind: 'hold' }, `${o.stage}`);
      const f = outcomeFact(u, o, 5, { cause: { type: 'host-pressure', inv: INV } });
      assert.deepEqual([f.class, f.chargeable, f.park, f.cause], ['hold', false, undefined, { type: 'host-pressure', inv: INV }], `${o.stage}`);
    }
  });
  it('with the certification allowance exhausted: a red lane charges a fix round, a blocked one retries, a judgment\'s process fault parks', () => {
    assert.equal(outcomeFact({ ...u, counters: { ...u.counters, unchargedLanesReds: 3 } }, { stage: 'lanes', kind: 'red' }, 5).class, 'park', 'the third chargeable failure parks');
    assert.equal(outcomeFact({ ...u, counters: { ...u.counters, chargeableFailures: 0, unchargedLanesReds: 3 } }, { stage: 'lanes', kind: 'red' }, 5).chargeable, true);
    assert.equal(outcomeFact(u, { stage: 'lanes', kind: 'blocked' }, 5).class, 'retry');
    assert.equal(outcomeFact(u, { stage: 'plan-check', kind: 'process-fault' }, 5).class, 'park');
  });
});
