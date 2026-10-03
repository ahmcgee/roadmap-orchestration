import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harbour } from './harbour.js';

test('a cancellation is confirmed by text', () => {
  const h = harbour();
  assert.equal(h.run(['book', 'Guillemot', 'B5', '2026-10-12', '15:52']).status, 0);
  assert.equal(h.run(['cancel', 'bk-1'], '2026-10-01T00:00:00Z').status, 0);
  const texts = h.outbox().trim().split('\n');
  assert.equal(texts.length, 2, 'the booking text, then the cancellation text');
  assert.match(texts[1], /^\+44 7700 900103\t.*bk-1.*Guillemot.*B5.*cancelled/);
});
