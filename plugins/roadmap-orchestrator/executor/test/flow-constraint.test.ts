// M4b A1: code's constraint (src/flow/constraint.ts): the largest wait in front of a station when it is at least 10 % of
// mean lead, else the largest service (the slot as its components' sum), never `held`; the slot's largest component; the
// last ten points only. M4b rev 3 (RC-10): host:cpu ahead of both rules at a saturated window.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stationId, unitId } from '../src/core/ids.ts';
import { isoTime } from '../src/core/values.ts';
import { codeConstraintOf, windowPressure } from '../src/flow/constraint.ts';
import type { FlowPoint } from '../src/flow/types.ts';

const AT = isoTime('2026-10-08T09:00:00.000Z');
const point = (minutes: Readonly<Record<string, number>>, pressure: number | null = null): FlowPoint => ({
  unit: unitId('u1'), admittedAt: AT, mergedAt: AT, leadMin: Object.values(minutes).reduce((a, b) => a + b, 0), minutes: minutes as FlowPoint['minutes'],
  costUsd: null, rework: 0, firstRunReds: 0, pressure, stationPressure: {},
});

describe('flow constraint: code\'s reading', () => {
  it('none before the first point', () => {
    assert.equal(codeConstraintOf([]), null);
  });

  it('the largest wait at 10 % of mean lead or more names the station it waits for', () => {
    const p = point({ 'wait:build': 2, 'stage:build': 10, 'wait:gate': 1, 'stage:gate': 6, 'suite:unit': 1 });
    assert.deepEqual(codeConstraintOf([p]), { station: 'stage:build', internal: true, component: null });
  });

  it('a wait in front of the slot names the slot and its largest component', () => {
    const p = point({ 'wait:slot:integration': 5, 'stage:build': 20, 'suite:unit': 4, 'suite:e2e': 6, 'arc-lanes': 2, ff: 0.1, snapshot: 0.1 });
    assert.deepEqual(codeConstraintOf([p]), { station: 'slot:integration', internal: true, component: 'suite:e2e' });
  });

  it('below 10 %, the largest service: the slot competes as its components\' sum; held never counts', () => {
    const slot = point({ 'wait:build': 0.5, 'stage:build': 8, 'suite:unit': 5, 'candidate-rest': 4, held: 30 });
    assert.deepEqual(codeConstraintOf([slot]), { station: 'slot:integration', internal: false, component: 'suite:unit' });
    const stage = point({ 'wait:build': 0.5, 'stage:build': 10, 'suite:unit': 5, 'candidate-rest': 4, held: 30 });
    assert.deepEqual(codeConstraintOf([stage]), { station: 'stage:build', internal: false, component: null });
  });

  it('the finding wait, when it is the largest wait, is the constraint itself (diagnostic)', () => {
    const p = point({ 'wait:finding': 20, 'wait:slot:integration': 2, 'stage:build': 10, 'suite:unit': 4 });
    assert.deepEqual(codeConstraintOf([p]), { station: 'wait:finding', internal: true, component: null });
  });

  it('reads the last ten points only', () => {
    const old = Array.from({ length: 5 }, () => point({ 'wait:gate': 50, 'stage:gate': 1 }));
    const recent = Array.from({ length: 10 }, () => point({ 'stage:build': 9, 'stage:gate': 1 }));
    assert.deepEqual(codeConstraintOf([...old, ...recent]), { station: 'stage:build', internal: false, component: null });
    assert.deepEqual(codeConstraintOf([...old, ...recent.slice(1)])?.station, 'stage:gate');
  });
});

describe('flow constraint: host:cpu (RC-10)', () => {
  const HOST_CPU = { station: 'host:cpu', internal: true, component: null };
  const slowWait = { 'wait:slot:integration': 5, 'stage:build': 20, 'suite:unit': 6 };

  it('a window mean pressure at the threshold or above names host:cpu, ahead of the wait and service rules', () => {
    assert.deepEqual(codeConstraintOf([point(slowWait, 0.4), point(slowWait, 0.6)]), HOST_CPU, 'mean 0.5');
    assert.deepEqual(codeConstraintOf([point(slowWait, 0.4), point(slowWait, 0.59)])?.station, 'slot:integration', 'mean 0.495');
  });

  it('the mean reads the window\'s measured points only; none measured (no schedstat) turns the rule off', () => {
    assert.equal(windowPressure([point(slowWait, null), point(slowWait, 0.6)]), 0.6);
    assert.deepEqual(codeConstraintOf([point(slowWait, null), point(slowWait, 0.6)]), HOST_CPU);
    assert.equal(windowPressure([point(slowWait), point(slowWait)]), null);
    assert.deepEqual(codeConstraintOf([point(slowWait), point(slowWait)])?.station, 'slot:integration');
    const old = Array.from({ length: 5 }, () => point(slowWait, 0.9));
    const calm = Array.from({ length: 10 }, () => point(slowWait, 0.05));
    assert.equal(codeConstraintOf([...old, ...calm])?.station, 'slot:integration', 'the last ten points only');
  });
});
