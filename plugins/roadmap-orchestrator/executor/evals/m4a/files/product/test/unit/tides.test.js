import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowOf, windowsFor } from '../../src/tides.js';

test('a window opens 90 minutes before high water and closes 90 minutes after', () => {
  assert.deepEqual(windowsFor('2026-10-04'), [
    { highWater: '08:02', opens: '06:32', closes: '09:32' },
    { highWater: '20:31', opens: '19:01', closes: '22:01' },
  ]);
});

test('windows wrap around midnight', () => {
  assert.deepEqual(windowOf('2026-10-08', '00:21'), { highWater: '00:21', opens: '22:51', closes: '01:51' });
});

test('a date the table lacks, or a high water it lacks, is refused', () => {
  assert.throws(() => windowsFor('2027-01-01'), /no entry/);
  assert.throws(() => windowsFor('tomorrow'), /not a date/);
  assert.throws(() => windowOf('2026-10-04', '12:00'), /no 12:00 high water/);
});
