// A day at the kiosk on the quay: skippers book one after another, and each finds the booking on the day's list.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { book, cancel, list } from '../../src/ledger.js';
import { BERTHS, VESSELS } from '../../src/registers.js';
import { replay } from './clock.js';

const TABLE = JSON.parse(readFileSync(new URL('../../data/tides.json', import.meta.url), 'utf8'));
const DATES = Object.keys(TABLE).reverse();
const EARLY = new Date('2026-09-01T00:00:00Z');

test('a day at the kiosk: every skipper who books finds the booking on the list', async () => {
  process.env.TIDEWATER_DATA = join(mkdtempSync(join(tmpdir(), 'tidewater-kiosk-')), 'ledger.json');
  await replay((i) => {
    const date = DATES[Math.floor(i / BERTHS.length) % DATES.length];
    const b = book({ vessel: VESSELS[i % VESSELS.length].name, berth: BERTHS[i % BERTHS.length].id, date, window: TABLE[date][0] });
    assert.ok(list(date).some((x) => x.id === b.id), `${b.id} is on the list for ${date}`);
    if (i % 5 === 4) {
      cancel(b.id, EARLY);
      assert.ok(!list(date).some((x) => x.id === b.id), `${b.id} left the list when cancelled`);
    }
  });
  assert.equal(list().length, 48);
});
