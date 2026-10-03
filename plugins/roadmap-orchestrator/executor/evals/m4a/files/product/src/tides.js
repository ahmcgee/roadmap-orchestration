// Tide windows from the harbour's printed tide table (data/tides.json): each high water opens a window
// WINDOW_MINUTES before it and closes it WINDOW_MINUTES after.
import { readFileSync } from 'node:fs';
import { TidewaterError } from './errors.js';

const TABLE = JSON.parse(readFileSync(new URL('../data/tides.json', import.meta.url), 'utf8'));

export const WINDOW_MINUTES = 90;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function shift(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The windows of `date`, one per high water: `{highWater, opens, closes}`. */
export function windowsFor(date) {
  if (!DATE.test(date)) throw new TidewaterError(`${date} is not a date (YYYY-MM-DD)`);
  const highWaters = TABLE[date];
  if (highWaters === undefined) throw new TidewaterError(`the tide table has no entry for ${date}`);
  return highWaters.map((highWater) => ({ highWater, opens: shift(highWater, -WINDOW_MINUTES), closes: shift(highWater, WINDOW_MINUTES) }));
}

/** The window of `date` around high water `highWater`. */
export function windowOf(date, highWater) {
  const found = windowsFor(date).find((w) => w.highWater === highWater);
  if (found === undefined) throw new TidewaterError(`there is no ${highWater} high water on ${date}`);
  return found;
}
