// Every date of the tide table, a date a tick: its windows are the table's high waters, 90 minutes either side.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WINDOW_MINUTES, windowOf, windowsFor } from '../../src/tides.js';
import { replay } from './clock.js';

const TABLE = JSON.parse(readFileSync(new URL('../../data/tides.json', import.meta.url), 'utf8'));
const DATES = Object.keys(TABLE);
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const gap = (from, to) => (minutes(to) - minutes(from) + 1440) % 1440;

test('every high water in the tide table opens a window either side of it', async () => {
  await replay((i) => {
    const date = DATES[i % DATES.length];
    const windows = windowsFor(date);
    assert.deepEqual(windows.map((w) => w.highWater), TABLE[date]);
    for (const w of windows) {
      assert.equal(gap(w.opens, w.highWater), WINDOW_MINUTES);
      assert.equal(gap(w.highWater, w.closes), WINDOW_MINUTES);
      assert.deepEqual(windowOf(date, w.highWater), w);
    }
  });
});
