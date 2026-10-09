// M4b A1: the XmR chart on log(leadMin) (src/flow/spc.ts): limits, seeding (previous completed arcs on an equal host with
// at least five points, else this arc's first five merges, else none), zones, the two special-cause rules, in-flight ages.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arcId, unitId } from '../src/core/ids.ts';
import { isoTime } from '../src/core/values.ts';
import { XMR_D2, XMR_E2, chartOf, seedLimits, specialCause, xmrLimits, zoneOf } from '../src/flow/spc.ts';
import { FLOW_SERIES_V, type FlowPoint, type FlowSeries, type HostFingerprint } from '../src/flow/types.ts';
import { HOST } from './helpers/flowlog.ts';

const AT = isoTime('2026-10-08T09:00:00.000Z');
const point = (n: number, leadMin: number): FlowPoint => ({ unit: unitId(`u${n}`), admittedAt: AT, mergedAt: AT, leadMin, minutes: {}, costUsd: null, rework: 0, firstRunReds: 0, pressure: null });
const series = (arc: string, leads: readonly number[], host: HostFingerprint | null = HOST): FlowSeries => ({
  v: FLOW_SERIES_V, arc: arcId(arc), host, points: leads.map((l, i) => point(i + 1, l)), suiteRuns: [],
  accounting: { tAdvances: null, tOther: null, tUnits: 0, wip: 0, oeUsdPerHour: 0 },
});
const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≉ ${b}`);
const e = Math.E;

describe('flow spc: limits and seeding', () => {
  it('centre is the mean, the limit the mean plus 2.66 mean moving ranges', () => {
    const l = xmrLimits([0, 1, 0, 1]);
    close(l.centre, 0.5);
    close(l.mrBar, 1);
    close(l.ucl, 0.5 + XMR_E2);
    assert.throws(() => xmrLimits([1]), /at least 2/);
  });

  it('seeds from the newest 20 points of completed arcs on an equal host, oldest first, naming the arcs', () => {
    const current = series('arc-z', []);
    const newer = series('arc-b', Array.from({ length: 15 }, (_, i) => e ** (i % 2)));
    const older = series('arc-a', [e ** 5, e ** 5, e ** 5, e ** 5, e ** 5, e ** 5, e ** 5, e ** 0, e ** 0, e ** 0]);
    const otherHost = series('arc-c', Array.from({ length: 10 }, () => 1), { ...HOST, cpus: 2 });
    const noHost = series('arc-d', Array.from({ length: 10 }, () => 1), null);
    const seeded = seedLimits([newer, otherHost, noHost, older], current)!;
    assert.deepEqual(seeded.seed, { type: 'previous', arcs: ['arc-a', 'arc-b'], points: 20 });
    // arc-a's last five in merge order (log 5, 5, 0, 0, 0), then arc-b's fifteen (log 0, 1, 0, ...).
    const values = [5, 5, 0, 0, 0, ...Array.from({ length: 15 }, (_, i) => i % 2)];
    const want = xmrLimits(values);
    close(seeded.centre, want.centre);
    close(seeded.mrBar, want.mrBar);
  });

  it('self-seeds from the first five merges when previous arcs give fewer than five; none before five', () => {
    const few = series('arc-a', [1, 1, 1, 1]);
    const leads = [e, e ** 2, e, e ** 2, e, e ** 9];
    const s = seedLimits([few], series('arc-z', leads))!;
    assert.deepEqual(s.seed, { type: 'self', points: 5 });
    close(s.centre, 1.4);
    close(s.mrBar, 1);
    assert.equal(seedLimits([few], series('arc-z', leads.slice(0, 4))), null);
    // A current series without a host never takes previous arcs' points.
    assert.deepEqual(seedLimits([series('arc-a', [1, 1, 1, 1, 1, 1])], series('arc-z', leads, null))!.seed, { type: 'self', points: 5 });
  });
});

describe('flow spc: zones and special causes', () => {
  // centre 0 (one minute), mR̄ 1: 2σ at 2/1.128 ≈ 1.773, the limit at 2.66.
  const L = { centre: 0, ucl: XMR_E2, mrBar: 1 };
  const twoSigma = 2 / XMR_D2;

  it('zones: green up to the centre, yellow up to the limit, red above', () => {
    assert.equal(zoneOf(L, 1), 'green');
    assert.equal(zoneOf(L, 0.5), 'green');
    assert.equal(zoneOf(L, e ** 2), 'yellow');
    assert.equal(zoneOf(L, e ** 2.65), 'yellow');
    assert.equal(zoneOf(L, e ** 2.7), 'red');
  });

  it('rule 1: the latest point or an in-flight age above the limit is buffer-red', () => {
    assert.equal(specialCause(L, [point(1, 1), point(2, e ** 3)], []), 'buffer-red');
    assert.equal(specialCause(L, [point(1, e ** 3), point(2, 1)], []), null, 'an earlier red point fired when it was the latest');
    assert.equal(specialCause(L, [point(1, 1)], [{ ageMin: e ** 3 }]), 'buffer-red');
    assert.equal(specialCause(L, [], [{ ageMin: e ** 3 }]), 'buffer-red');
    assert.equal(specialCause(L, [], [{ ageMin: 0 }, { ageMin: e }]), null);
  });

  it('rule 2: two of the last three beyond 2σ, the latest among them, is yellow-worsening; one alone is common cause', () => {
    const beyond = e ** (twoSigma + 0.2);
    assert.ok(Math.log(beyond) < L.ucl);
    assert.equal(specialCause(L, [point(1, beyond), point(2, 1), point(3, beyond)], []), 'yellow-worsening');
    assert.equal(specialCause(L, [point(1, beyond), point(2, beyond)], []), 'yellow-worsening');
    assert.equal(specialCause(L, [point(1, beyond), point(2, 1), point(3, 1), point(4, beyond)], []), null);
    assert.equal(specialCause(L, [point(1, beyond), point(2, beyond), point(3, 1)], []), null);
    assert.equal(specialCause(L, [point(1, e ** 1.7), point(2, e ** 1.7)], []), null, 'yellow but within 2σ');
  });

  it('the chart zones the recent points and the in-flight ages', () => {
    const c = chartOf({ ...L, seed: { type: 'self', points: 5 } }, Array.from({ length: 12 }, (_, i) => point(i + 1, i === 11 ? e ** 3 : 1)), [
      { unit: unitId('w1'), ageMin: e ** 2 }, { unit: unitId('w2'), ageMin: 0 },
    ]);
    assert.equal(c.recent.length, 10);
    assert.deepEqual(c.recent.at(-1), { unit: 'u12', leadMin: e ** 3, zone: 'red' });
    assert.deepEqual(c.inFlight.map((u) => u.zone), ['yellow', 'green']);
  });
});
