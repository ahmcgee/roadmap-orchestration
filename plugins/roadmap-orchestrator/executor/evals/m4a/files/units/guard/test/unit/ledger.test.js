import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { book, cancel, list } from '../../src/ledger.js';

beforeEach(() => {
  process.env.TIDEWATER_DATA = join(mkdtempSync(join(tmpdir(), 'tidewater-')), 'ledger.json');
});

test('bookings get ascending ids and are listed in booking order', () => {
  const a = book({ vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' });
  const b = book({ vessel: 'Puffin', berth: 'B1', date: '2026-10-05', window: '08:57' });
  assert.deepEqual([a.id, b.id], ['bk-1', 'bk-2']);
  assert.deepEqual(list().map((x) => x.id), ['bk-1', 'bk-2']);
  assert.deepEqual(list('2026-10-05').map((x) => x.id), ['bk-2']);
});

test('a cancelled booking is gone; an unknown one is refused', () => {
  const a = book({ vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' });
  assert.equal(cancel(a.id).id, a.id);
  assert.deepEqual(list(), []);
  assert.throws(() => cancel('bk-9'), /no booking bk-9/);
});

test('a berth taken for a window is refused to a second vessel, naming the first', () => {
  book({ vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' });
  assert.throws(() => book({ vessel: 'Puffin', berth: 'B3', date: '2026-10-04', window: '20:31' }), /B3 is already booked .* by Kittiwake/);
  assert.equal(book({ vessel: 'Puffin', berth: 'B3', date: '2026-10-04', window: '08:02' }).id, 'bk-2');
  assert.equal(list().length, 2);
});

test('a cancelled booking frees its berth at once', () => {
  const a = book({ vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' });
  cancel(a.id);
  assert.equal(book({ vessel: 'Puffin', berth: 'B3', date: '2026-10-04', window: '20:31' }).vessel, 'Puffin');
});
