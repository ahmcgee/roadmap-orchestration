// M4b rev 3: the PSI cpu reader (src/host/pressure.ts): the `some` line parsed, the interval fraction over two samples,
// an absent file read as unavailable, a malformed one refused, this host's PSI read, and the per-tick history pruned.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  PRESSURE_SATURATED, PRESSURE_TICKS_MS, PSI_CPU, type PressureSample, PressureTicks, STARVED_MAX, intervalPressure, launchPressure, parsePsiCpu, readPressure,
  readPressureAt,
} from '../src/host/pressure.ts';
import { tmpDir } from './helpers/repo.ts';

const PSI = 'some avg10=68.56 avg60=64.89 avg300=50.87 total=49740819350\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
const sample = (totalUs: number, atMs: number): PressureSample => ({ totalUs, avg10: 0, avg60: 0, atMs });

describe('pressure.parse', () => {
  it('reads total (µs) and avg10/avg60 (as fractions) from the some line', () => {
    assert.deepEqual(parsePsiCpu(PSI), { totalUs: 49740819350, avg10: 0.6856, avg60: 0.6489 });
    assert.deepEqual(parsePsiCpu('some avg10=0.00 avg60=100.00 avg300=0.00 total=0\n'), { totalUs: 0, avg10: 0, avg60: 1 });
  });
  it('refuses a text without a some line, or with a field malformed or missing', () => {
    for (const bad of [
      '', 'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n', 'some avg10=0.00 avg60=0.00 avg300=0.00\n', 'some avg10=0.00 avg300=0.00 total=5\n',
      'some avg10=x avg60=0.00 total=5\n', 'some avg10=0.00 avg60=101.00 total=5\n', 'some avg10=0.00 avg60=0.00 total=-5\n', 'some avg10=0.00 avg60=0.00 total=1.5\n',
      'some avg10 avg60=0.00 total=5\n',
    ]) assert.throws(() => parsePsiCpu(bad), /\/proc\/pressure\/cpu/, JSON.stringify(bad));
  });
});

describe('pressure.interval', () => {
  it('is the stalled µs over the wall µs between two samples', () => {
    assert.equal(intervalPressure(sample(1_000, 0), sample(251_000, 1_000)), 0.25);
    assert.equal(intervalPressure(sample(5, 10), sample(5, 20)), 0);
  });
  it('caps at 1 (the kernel clock and ours are read apart), and refuses time or total going back', () => {
    assert.equal(intervalPressure(sample(0, 0), sample(1_000_010, 1_000)), 1);
    assert.throws(() => intervalPressure(sample(0, 5), sample(0, 5)), /not after start/);
    assert.throws(() => intervalPressure(sample(10, 0), sample(5, 1)), /went back/);
  });
  it('is null over a launch when either end is unavailable', () => {
    assert.equal(launchPressure('unavailable', sample(0, 1)), null);
    assert.equal(launchPressure(sample(0, 0), 'unavailable'), null);
    assert.equal(launchPressure(sample(0, 0), sample(500, 1)), 0.5);
  });
  it('the constants of RC-10 and RC-11', () => {
    assert.equal(PRESSURE_SATURATED, 0.25);
    assert.equal(STARVED_MAX, 3);
  });
});

describe('pressure.read', () => {
  it('an absent file is unavailable; a present malformed one fails loud', () => {
    const dir = tmpDir('pressure');
    assert.equal(readPressureAt(join(dir, 'none')), 'unavailable');
    writeFileSync(join(dir, 'cpu'), 'garbage\n');
    assert.throws(() => readPressureAt(join(dir, 'cpu')), /no "some" line/);
    writeFileSync(join(dir, 'cpu'), PSI);
    const s = readPressureAt(join(dir, 'cpu'));
    assert.ok(s !== 'unavailable');
    assert.equal(s.totalUs, 49740819350);
  });
  it(`reads this host's ${PSI_CPU}, whose total only grows`, () => {
    const a = readPressure();
    const b = readPressure();
    assert.ok(a !== 'unavailable' && b !== 'unavailable', 'PSI is available on this host');
    assert.ok(b.totalUs >= a.totalUs && b.atMs >= a.atMs);
    assert.ok(a.avg60 >= 0 && a.avg60 <= 1);
  });
});

describe('pressure.ticks', () => {
  it('keeps each available tick, newest last, for PRESSURE_TICKS_MS', () => {
    const t = new PressureTicks();
    t.record({ ...sample(0, 0), avg60: 0.3 }, 1_000);
    t.record('unavailable', 2_000);
    t.record({ ...sample(0, 0), avg60: 0.4 }, 3_000);
    assert.deepEqual(t.ticks(), [{ atMs: 1_000, avg60: 0.3 }, { atMs: 3_000, avg60: 0.4 }]);
    t.record({ ...sample(0, 0), avg60: 0.1 }, 2_000 + PRESSURE_TICKS_MS);
    assert.deepEqual(t.ticks(), [{ atMs: 3_000, avg60: 0.4 }, { atMs: 2_000 + PRESSURE_TICKS_MS, avg60: 0.1 }]);
  });
});
