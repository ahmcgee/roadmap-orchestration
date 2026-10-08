// Texts to skippers: each message is one outbox line `<phone>\t<text>` (TIDEWATER_OUTBOX, default
// ./tidewater-outbox.txt) that the harbour's text gateway picks up.
import { appendFileSync } from 'node:fs';
import { vessel } from './registers.js';
import { windowOf } from './tides.js';

export const outboxPath = () => process.env.TIDEWATER_OUTBOX ?? 'tidewater-outbox.txt';

function send(name, text) {
  const { phone } = vessel(name);
  if (phone === undefined) return;
  appendFileSync(outboxPath(), `${phone}\t${text}\n`);
}

/** The booking confirmation (0040_Notifications/message-templates.md, "Booking confirmed"). */
export function sendConfirmation(b) {
  const w = windowOf(b.date, b.window);
  send(b.vessel, `Tidewater: ${b.vessel} is booked into berth ${b.berth} on ${b.date} for the ${b.window} high water (window ${w.opens}-${w.closes}). Ref ${b.id}.`);
}
