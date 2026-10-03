import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { harbour } from './harbour.js';

const TABLE = JSON.parse(readFileSync(new URL('../data/tides.json', import.meta.url), 'utf8'));

test('tide windows come from the harbour tide table', () => {
  const h = harbour();
  for (const date of ['2026-10-04', '2026-10-08']) {
    const r = h.run(['windows', date]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n').map((l) => l.split(/\s+/)[1]), TABLE[date], `the ${date} windows are the table's high waters`);
  }
  const off = h.run(['windows', '2031-01-01']);
  assert.equal(off.status, 2, 'a date the table lacks has no windows');
});
