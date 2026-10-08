// The quay sheet: the line the office pins up by the radio for each booking of the day.
import { windowOf } from './tides.js';

/** `<berth>  <vessel>  HW <hw>  window <opens>-<closes>` for booking `b`. */
export function quayLine(b) {
  const w = windowOf(b.date, b.window);
  return `${b.berth}  ${b.vessel}  HW ${w.highWater}  window ${w.opens}-${w.closes}`;
}
