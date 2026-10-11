// The pace of the replay tests. Each replays a stretch of harbour time one step per tick and waits TICK_MS between
// steps, as the kiosk paces its own screens, so one file takes about TICKS × TICK_MS of wall time: about a minute.
import { setTimeout as sleep } from 'node:timers/promises';

export const TICK_MS = 1000;
export const TICKS = 60;

/** Runs `step(i)` for every tick in order, waiting TICK_MS after each. */
export async function replay(step) {
  for (let i = 0; i < TICKS; i++) {
    await step(i);
    await sleep(TICK_MS);
  }
}
