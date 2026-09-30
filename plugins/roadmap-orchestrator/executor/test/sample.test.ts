import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type HostSample, isBusy, isClear, parseLoadavg, parseMeminfo, readHostSample } from '../src/host/sample.ts';

const MEMINFO = `MemTotal:       31457280 kB
MemFree:         1048576 kB
MemAvailable:   20971520 kB
Buffers:          102400 kB
`;

const sample = (over: Partial<HostSample>): HostSample => ({ load1: 0, cpus: 10, memTotalKb: 1000, memAvailableKb: 500, ...over });

describe('sample.parse', () => {
  it('reads the 1-minute load from /proc/loadavg', () => {
    assert.equal(parseLoadavg('0.52 0.61 0.70 2/1234 98765\n'), 0.52);
  });
  it('rejects a loadavg without a number', () => {
    assert.throws(() => parseLoadavg(''), /no 1-minute load/);
    assert.throws(() => parseLoadavg('abc 1 2'), /no 1-minute load/);
    assert.throws(() => parseLoadavg('-1 1 2'), /no 1-minute load/);
  });
  it('reads MemTotal and MemAvailable from /proc/meminfo', () => {
    assert.deepEqual(parseMeminfo(MEMINFO), { memTotalKb: 31457280, memAvailableKb: 20971520 });
  });
  it('rejects a meminfo missing a field, or with a zero total', () => {
    assert.throws(() => parseMeminfo('MemTotal: 100 kB\n'), /no MemAvailable/);
    assert.throws(() => parseMeminfo('MemAvailable: 100 kB\n'), /no MemTotal/);
    assert.throws(() => parseMeminfo('MemTotal: 0 kB\nMemAvailable: 0 kB\n'), /not positive/);
  });
  it('busy at load1/cpus >= 1.0 or MemAvailable < 5% of MemTotal; clear below 0.7 load per cpu', () => {
    assert.equal(isBusy(sample({ load1: 10 })), true);
    assert.equal(isBusy(sample({ load1: 9.99 })), false);
    assert.equal(isBusy(sample({ memAvailableKb: 49 })), true);
    assert.equal(isBusy(sample({ memAvailableKb: 50 })), false);
    assert.equal(isClear(sample({ load1: 6.99 })), true);
    assert.equal(isClear(sample({ load1: 7 })), false);
    const between = sample({ load1: 8 });
    assert.deepEqual([isBusy(between), isClear(between)], [false, false]);
  });
  it('reads this host into a plausible sample', () => {
    const s = readHostSample();
    assert.ok(s.cpus >= 1 && s.memTotalKb > 0 && s.memAvailableKb <= s.memTotalKb && s.load1 >= 0);
  });
});
