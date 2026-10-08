// A day of office commands through the tidewater command itself: windows, the berth register and the list, paced.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { replay } from './clock.js';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const TABLE = JSON.parse(readFileSync(new URL('../../data/tides.json', import.meta.url), 'utf8'));
const DATES = Object.keys(TABLE);

test('a day of office commands through the tidewater command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tidewater-office-'));
  const env = { ...process.env, TIDEWATER_DATA: join(dir, 'ledger.json'), TIDEWATER_OUTBOX: join(dir, 'outbox.txt') };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  await replay((i) => {
    const date = DATES[i % DATES.length];
    const windows = run('windows', date);
    assert.equal(windows.status, 0, windows.stderr);
    assert.equal(windows.stdout.trim().split('\n').length, TABLE[date].length);
    if (i % 4 === 0) {
      const berths = run('berths');
      assert.equal(berths.status, 0, berths.stderr);
      assert.equal(berths.stdout.trim().split('\n').length, 6);
    }
    if (i % 6 === 0) {
      const listed = run('list', date);
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(listed.stdout, '', 'nobody booked from the office today');
    }
  });
});
