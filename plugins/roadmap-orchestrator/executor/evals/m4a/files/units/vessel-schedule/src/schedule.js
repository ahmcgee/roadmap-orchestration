// A vessel's schedule: what a skipper has booked ahead, earliest first.
import { list } from './ledger.js';

/** Every booking of `vessel`, by date and then high water, earliest first. */
export function scheduleOf(vessel) {
  return list()
    .filter((b) => b.vessel === vessel)
    .sort((a, b) => (a.date === b.date ? a.window.localeCompare(b.window) : a.date.localeCompare(b.date)));
}
