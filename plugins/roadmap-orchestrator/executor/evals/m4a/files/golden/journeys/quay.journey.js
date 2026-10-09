import assert from 'node:assert/strict';
import { test } from 'node:test';

// The module is imported inside the test: before the unit builds it, this test fails (the file still reports it).
test('the quay sheet names the berth, the vessel, the high water and the window', async () => {
  const { quayLine } = await import('../src/quay.js');
  assert.equal(quayLine({ id: 'bk-1', vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' }), 'B3  Kittiwake  HW 20:31  window 19:01-22:01');
});
