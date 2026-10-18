// One check for an entry, whichever way it arrives (the dashboard form, the API, a CSV import). Each problem names its
// field and how to fix it, in the product's voice (design/DESIGN.md, "Copy").
import { parseAmount } from './money.js';
import { isMonth } from './month.js';

const VENDOR_MAX = 60;
const NOTE_MAX = 140;

/** `{ok: true, entry}`, or `{ok: false, errors: [{field, message}]}` with every problem found. */
export function checkEntry(input, config) {
  const errors = [];
  const team = String(input.team ?? '').trim();
  const month = String(input.month ?? '').trim();
  const vendor = String(input.vendor ?? '').trim();
  const note = String(input.note ?? '').trim();
  const amount = parseAmount(input.amount ?? '');
  if (!config.teams.some((t) => t.id === team)) {
    errors.push({ field: 'team', message: `Choose a team: one of ${config.teams.map((t) => t.id).join(', ')}.` });
  }
  if (!isMonth(month)) errors.push({ field: 'month', message: 'Month must look like 2026-09: the year, a dash, then the two-digit month.' });
  if (vendor === '') errors.push({ field: 'vendor', message: 'Enter the vendor: who was paid, for example Hetzner.' });
  else if (vendor.length > VENDOR_MAX) errors.push({ field: 'vendor', message: `Vendor must be ${VENDOR_MAX} characters or fewer; this one has ${vendor.length}.` });
  if (amount === null || amount === 0) {
    errors.push({ field: 'amount', message: 'Amount must be a number above zero, like 120 or 120.50, without a currency sign.' });
  }
  if (note.length > NOTE_MAX) errors.push({ field: 'note', message: `Note must be ${NOTE_MAX} characters or fewer; this one has ${note.length}.` });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, entry: { team, month, vendor, amount, note } };
}

/** A monthly limit typed by a person: minor units, or the problem. */
export function checkLimit(text) {
  const t = String(text ?? '').trim();
  if (!/^\d{1,7}$/.test(t) || Number(t) === 0) {
    return { ok: false, errors: [{ field: 'limit', message: 'Limit must be a whole amount above zero, like 5000, without a currency sign.' }] };
  }
  return { ok: true, limit: Number(t) * 100 };
}
