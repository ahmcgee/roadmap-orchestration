import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harbour } from './harbour.js';

// The 2026-10-10 14:30 high water's window opens at 13:00.
test('a booking cannot be cancelled within 48 hours of its window', () => {
  const h = harbour();
  assert.equal(h.run(['book', 'Kittiwake', 'B3', '2026-10-10', '14:30']).status, 0);
  assert.equal(h.run(['book', 'Puffin', 'B1', '2026-10-10', '14:30']).status, 0);
  const late = h.run(['cancel', 'bk-1'], '2026-10-08T13:30:00Z');
  assert.equal(late.status, 2, '47.5 hours before the window opens is too late');
  assert.match(late.stderr, /48 hours/);
  assert.equal(h.run(['cancel', 'bk-2'], '2026-10-08T12:30:00Z').status, 0, '48.5 hours before is in good time');
  assert.deepEqual(h.run(['list']).stdout.trim().split('\n').map((l) => l.split(/\s+/)[0]), ['bk-1']);
});
