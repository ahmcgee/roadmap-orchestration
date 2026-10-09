import assert from 'node:assert/strict';
import { test } from 'node:test';

// The module is imported inside the test: before the unit builds it, this test fails (the file still reports it).
test('the next window is the first of the date still open', async () => {
  const { nextWindow } = await import('../src/next.js');
  assert.equal(nextWindow('2026-10-04', '12:00')?.highWater, '20:31');
  assert.equal(nextWindow('2026-10-04', '22:30'), null, 'after the last window has closed, none');
});
