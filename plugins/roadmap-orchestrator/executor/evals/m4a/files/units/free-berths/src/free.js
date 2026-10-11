// The berths still free for a tide window: what the office offers a skipper whose first choice is taken.
import { list } from './ledger.js';
import { BERTHS } from './registers.js';
import { windowOf } from './tides.js';

/** The ids of the berths with no booking for the `highWater` window of `date`, in register order. */
export function freeBerths(date, highWater) {
  windowOf(date, highWater);
  const taken = new Set(list(date).filter((b) => b.window === highWater).map((b) => b.berth));
  return BERTHS.map((b) => b.id).filter((id) => !taken.has(id));
}
