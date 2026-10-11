import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { freeBerths } from '../../src/free.js';
import { book } from '../../src/ledger.js';

beforeEach(() => {
  process.env.TIDEWATER_DATA = join(mkdtempSync(join(tmpdir(), 'tidewater-free-')), 'ledger.json');
});

test('a booked berth is not free for its window, and is for the other one', () => {
  book({ vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' });
  assert.deepEqual(freeBerths('2026-10-04', '20:31'), ['B1', 'B2', 'B4', 'B5', 'B6']);
  assert.deepEqual(freeBerths('2026-10-04', '08:02'), ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
  assert.throws(() => freeBerths('2026-10-04', '12:00'), /no 12:00 high water/);
});
