import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slipLine } from '../../src/slip.js';

test('the slip names the booking id, the vessel, the berth, the date and the high water', () => {
  assert.equal(slipLine({ id: 'bk-7', vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' }), 'bk-7: Kittiwake in B3 on 2026-10-04, HW 20:31');
});
