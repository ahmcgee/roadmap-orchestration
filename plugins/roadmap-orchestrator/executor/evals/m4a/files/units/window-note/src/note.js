// The one-line note of a tide window, as the office reads it out on the radio.
import { windowOf } from './tides.js';

/** `HW <hw>, window <opens>-<closes>` for the `highWater` window of `date`. */
export function windowNote(date, highWater) {
  const w = windowOf(date, highWater);
  return `HW ${w.highWater}, window ${w.opens}-${w.closes}`;
}
