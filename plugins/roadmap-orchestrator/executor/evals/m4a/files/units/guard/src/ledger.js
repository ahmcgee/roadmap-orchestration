// The booking ledger: one JSON file (TIDEWATER_DATA, default ./tidewater-ledger.json) that only this command writes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TidewaterError } from './errors.js';

export const ledgerPath = () => process.env.TIDEWATER_DATA ?? 'tidewater-ledger.json';

export function load() {
  const path = ledgerPath();
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { next: 1, bookings: [] };
}

function save(ledger) {
  writeFileSync(ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Records a booking of `berth` for `vessel` on `date` at the `window` high water; returns it with its id. A berth is
 * never booked to two vessels for the same window: a clash is refused, naming the vessel that holds the berth.
 */
export function book({ vessel, berth, date, window }) {
  const ledger = load();
  const held = ledger.bookings.find((b) => b.berth === berth && b.date === date && b.window === window);
  if (held !== undefined) throw new TidewaterError(`berth ${berth} is already booked for ${date}, ${window} high water, by ${held.vessel}; pick another berth or window`);
  const booking = { id: `bk-${ledger.next}`, vessel, berth, date, window };
  ledger.next += 1;
  ledger.bookings.push(booking);
  save(ledger);
  return booking;
}

/** Removes booking `id`; returns it. */
export function cancel(id) {
  const ledger = load();
  const i = ledger.bookings.findIndex((b) => b.id === id);
  if (i < 0) throw new TidewaterError(`there is no booking ${id}`);
  const [booking] = ledger.bookings.splice(i, 1);
  save(ledger);
  return booking;
}

/** The bookings, of `date` only when given, in booking order. */
export function list(date) {
  return load().bookings.filter((b) => date === undefined || b.date === date);
}
