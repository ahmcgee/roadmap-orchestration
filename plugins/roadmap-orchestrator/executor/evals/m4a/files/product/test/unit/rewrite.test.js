// The ledger is read whole and written whole by every command: after each rewrite it reads back exactly as written.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { book, ledgerPath, load } from '../../src/ledger.js';
import { BERTHS } from '../../src/registers.js';
import { replay } from './clock.js';

const TABLE = JSON.parse(readFileSync(new URL('../../data/tides.json', import.meta.url), 'utf8'));
const DATES = Object.keys(TABLE);

test('the ledger reads back the same after every rewrite', async () => {
  process.env.TIDEWATER_DATA = join(mkdtempSync(join(tmpdir(), 'tidewater-rewrite-')), 'ledger.json');
  const written = [];
  await replay((i) => {
    const date = DATES[i % DATES.length];
    written.push(book({ vessel: 'Puffin', berth: BERTHS[Math.floor(i / DATES.length) % BERTHS.length].id, date, window: TABLE[date][1] }));
    const text = readFileSync(ledgerPath(), 'utf8');
    assert.ok(text.endsWith('}\n'), 'the file ends with one newline');
    assert.deepEqual(JSON.parse(text), load());
    assert.deepEqual(load(), { next: written.length + 1, bookings: written });
  });
});
