import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextWindow } from '../../src/next.js';

test('the next window is the first of the date still open at the time', () => {
  assert.equal(nextWindow('2026-10-04', '07:00')?.highWater, '08:02');
  assert.equal(nextWindow('2026-10-04', '12:00')?.highWater, '20:31');
  assert.equal(nextWindow('2026-10-04', '22:30'), null);
  assert.equal(nextWindow('2026-10-07', '23:59')?.highWater, '23:47', 'a window that closes after midnight is still open');
  assert.throws(() => nextWindow('2031-01-01', '12:00'), /no entry for 2031-01-01/);
});
