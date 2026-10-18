// Amounts are stored as integer minor units (cents) and shown in the ledger's currency.
const AMOUNT = /^\d{1,7}(\.\d{1,2})?$/;

/** "120.50" or "120" as minor units; null when the text is not a plain amount. */
export function parseAmount(text) {
  const t = String(text).trim();
  if (!AMOUNT.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** "€1,234.50": an amount as people read it. */
export function formatMoney(minor, currency) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);
}

/** "1234.50": the form JSON and CSV use (a decimal string, never a float). */
export const plainAmount = (minor) => (minor / 100).toFixed(2);

/** Whole percent of `part` in `whole`. */
export const percent = (part, whole) => Math.round((part / whole) * 100);
