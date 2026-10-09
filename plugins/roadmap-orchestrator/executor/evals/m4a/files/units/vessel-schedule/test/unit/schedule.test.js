import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { book } from '../../src/ledger.js';
import { scheduleOf } from '../../src/schedule.js';

beforeEach(() => {
  process.env.TIDEWATER_DATA = join(mkdtempSync(join(tmpdir(), 'tidewater-schedule-')), 'ledger.json');
});

test('a vessel\'s schedule holds its own bookings, earliest first', () => {
  book({ vessel: 'Kittiwake', berth: 'B3', date: '2026-10-05', window: '08:57' });
  book({ vessel: 'Puffin', berth: 'B1', date: '2026-10-04', window: '20:31' });
  book({ vessel: 'Kittiwake', berth: 'B2', date: '2026-10-04', window: '20:31' });
  assert.deepEqual(scheduleOf('Kittiwake').map((b) => b.id), ['bk-3', 'bk-1']);
  assert.deepEqual(scheduleOf('Guillemot'), []);
});
