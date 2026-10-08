import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quayLine } from '../../src/quay.js';

test('the quay sheet names the berth, the vessel, the high water and its window', () => {
  assert.equal(quayLine({ id: 'bk-1', vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' }), 'B3  Kittiwake  HW 20:31  window 19:01-22:01');
  assert.equal(quayLine({ id: 'bk-2', vessel: 'Puffin', berth: 'B1', date: '2026-10-08', window: '00:21' }), 'B1  Puffin  HW 00:21  window 22:51-01:51');
});
