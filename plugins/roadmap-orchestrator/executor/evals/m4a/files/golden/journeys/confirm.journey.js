import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harbour } from './harbour.js';

test('every booking is confirmed by text', () => {
  const h = harbour();
  assert.equal(h.run(['book', 'Kittiwake', 'B3', '2026-10-04', '20:31']).status, 0);
  assert.equal(h.run(['book', 'Puffin', 'B1', '2026-10-05', '08:57']).status, 0);
  const texts = h.outbox().trim().split('\n');
  assert.equal(texts.length, 2, 'one text per booking');
  assert.match(texts[0], /^\+44 7700 900101\t.*Kittiwake.*B3.*2026-10-04.*20:31.*bk-1/);
  assert.match(texts[1], /^\+44 7700 900102\t.*Puffin.*B1.*2026-10-05.*08:57.*bk-2/);
});
