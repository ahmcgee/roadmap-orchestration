// The soak run: a season of bookings and cancellations against one ledger, the ledger checked after every write.
// It is what tells us the ledger keeps every booking it took, once, and never holds a berth twice for one window.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { book, cancel, ledgerPath, list } from '../../src/ledger.js';
import { BERTHS, VESSELS } from '../../src/registers.js';
import { replay } from './clock.js';

const TABLE = JSON.parse(readFileSync(new URL('../../data/tides.json', import.meta.url), 'utf8'));
/** Well before any window in the table: every cancellation of the soak is in good time. */
const EARLY = new Date('2026-09-01T00:00:00Z');

/** Every berth of every window of the table, in table order. */
const SLOTS = Object.entries(TABLE).flatMap(([date, highWaters]) => highWaters.flatMap((window) => BERTHS.map((b) => ({ berth: b.id, date, window }))));

function checkLedger(expected) {
  const file = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
  assert.deepEqual(file.bookings, expected, 'the ledger holds exactly the bookings still standing, in booking order');
  assert.deepEqual(list(), expected);
  const ids = file.bookings.map((b) => Number(b.id.slice(3)));
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]), 'ids ascend');
  assert.ok(ids.every((id) => id < file.next), 'the next id is past every id given');
  const held = new Set(file.bookings.map((b) => `${b.berth} ${b.date} ${b.window}`));
  assert.equal(held.size, file.bookings.length, 'no berth is held twice for one window');
}

test('the ledger survives a season of bookings and cancellations', async () => {
  process.env.TIDEWATER_DATA = join(mkdtempSync(join(tmpdir(), 'tidewater-soak-')), 'ledger.json');
  const standing = [];
  await replay((i) => {
    for (const slot of SLOTS.slice(2 * i, 2 * i + 2)) {
      standing.push(book({ vessel: VESSELS[standing.length % VESSELS.length].name, ...slot }));
      checkLedger(standing);
    }
    if (i % 3 === 2) {
      const [gone] = standing.splice(0, 1);
      assert.equal(cancel(gone.id, EARLY).id, gone.id);
      checkLedger(standing);
    }
  });
  assert.equal(standing.length, 100);
});
