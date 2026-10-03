import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { outboxPath, sendCancellation, sendConfirmation } from '../../src/confirm.js';

beforeEach(() => {
  process.env.TIDEWATER_OUTBOX = join(mkdtempSync(join(tmpdir(), 'tidewater-')), 'outbox.txt');
});

test('a booking confirmation is one outbox line to the vessel\'s phone', () => {
  sendConfirmation({ id: 'bk-7', vessel: 'Kittiwake', berth: 'B3', date: '2026-10-04', window: '20:31' });
  assert.equal(
    readFileSync(outboxPath(), 'utf8'),
    '+44 7700 900101\tTidewater: Kittiwake is booked into berth B3 on 2026-10-04 for the 20:31 high water (window 19:01-22:01). Ref bk-7.\n',
  );
});

test('a cancellation confirmation is one outbox line to the vessel\'s phone', () => {
  sendCancellation({ id: 'bk-7', vessel: 'Puffin', berth: 'B1', date: '2026-10-05', window: '08:57' });
  assert.equal(readFileSync(outboxPath(), 'utf8'), '+44 7700 900102\tTidewater: booking bk-7 for Puffin in berth B1 on 2026-10-05 is cancelled. The berth is free again.\n');
});
