import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.TIDEWATER_DATA = join(mkdtempSync(join(tmpdir(), 'tidewater-journey-')), 'ledger.json');

// The module is imported inside the test: before the unit builds it, this test fails (the file still reports it).
test('a booked berth is not offered free for its window', async () => {
  const { book } = await import('../src/ledger.js');
  const { freeBerths } = await import('../src/free.js');
  book({ vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' });
  assert.deepEqual(freeBerths('2026-10-04', '20:31'), ['B1', 'B2', 'B4', 'B5', 'B6']);
  assert.deepEqual(freeBerths('2026-10-04', '08:02'), ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
});
