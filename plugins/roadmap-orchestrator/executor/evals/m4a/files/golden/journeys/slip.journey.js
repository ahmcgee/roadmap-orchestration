import assert from 'node:assert/strict';
import { test } from 'node:test';

// The module is imported inside the test: before the unit builds it, this test fails (the file still reports it).
test('a booking slip names the booking id, the vessel, the berth, the date and the high water', async () => {
  const { slipLine } = await import('../src/slip.js');
  assert.equal(slipLine({ id: 'bk-7', vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' }), 'bk-7: Kittiwake in B3 on 2026-10-04, HW 20:31');
});
