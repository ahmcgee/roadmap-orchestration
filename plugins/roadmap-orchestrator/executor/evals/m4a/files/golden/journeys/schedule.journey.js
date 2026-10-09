import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.TIDEWATER_DATA = join(mkdtempSync(join(tmpdir(), 'tidewater-journey-')), 'ledger.json');

// The module is imported inside the test: before the unit builds it, this test fails (the file still reports it).
test('a vessel\'s schedule lists its own bookings, earliest first', async () => {
  const { book } = await import('../src/ledger.js');
  const { scheduleOf } = await import('../src/schedule.js');
  book({ vessel: 'Kittiwake', berth: 'B3', date: '2026-10-05', window: '08:57' });
  book({ vessel: 'Puffin', berth: 'B1', date: '2026-10-04', window: '20:31' });
  book({ vessel: 'Kittiwake', berth: 'B2', date: '2026-10-04', window: '20:31' });
  assert.deepEqual(scheduleOf('Kittiwake').map((b) => [b.date, b.window, b.berth]), [['2026-10-04', '20:31', 'B2'], ['2026-10-05', '08:57', 'B3']]);
});
