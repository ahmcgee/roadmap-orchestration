import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harbour } from './harbour.js';

test('a berth is never booked twice for one tide window', () => {
  const h = harbour();
  assert.equal(h.run(['book', 'Kittiwake', 'B3', '2026-10-04', '20:31']).status, 0);
  const clash = h.run(['book', 'Puffin', 'B3', '2026-10-04', '20:31']);
  assert.equal(clash.status, 2, 'the second booking of B3 for that window is refused');
  assert.match(clash.stderr, /Kittiwake/, 'the refusal names the vessel holding the berth');
  assert.equal(h.run(['book', 'Puffin', 'B3', '2026-10-05', '08:57']).status, 0, 'another window is free');
  assert.deepEqual(h.run(['list', '2026-10-04']).stdout.trim().split('\n').length, 1);
});
