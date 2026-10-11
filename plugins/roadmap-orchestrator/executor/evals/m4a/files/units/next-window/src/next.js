// The next window: the first window of a date a skipper on passage can still make.
import { windowsFor } from './tides.js';

const minutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** When window `w` closes, in minutes from the start of its date (past 24:00 when it closes after midnight). */
const closesAt = (w) => minutes(w.closes) + (minutes(w.closes) < minutes(w.highWater) ? 1440 : 0);

/** The first window of `date` that has not closed by `time` (HH:MM), or null once the last one has. */
export function nextWindow(date, time) {
  return windowsFor(date).find((w) => closesAt(w) > minutes(time)) ?? null;
}
