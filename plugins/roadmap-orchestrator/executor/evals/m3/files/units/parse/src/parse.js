import { isAmount } from './format.js';

/** A ledger file the ledger refuses: its message names the 1-based line and why. */
export class LedgerError extends Error {}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `text` is a real calendar date, YYYY-MM-DD. */
function isDate(text) {
  const m = DATE.exec(text);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** The entries of a ledger file, `{date, amount, memo}`, `amount` the amount text as written (.roadmap/contracts/ledger.md, ledger file). */
export function parseLedger(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    const fields = line.split(',');
    const [date = '', amount = '', memo = ''] = fields;
    const why = fields.length !== 3 ? 'expected three comma-separated fields, date,amount,memo (a memo may not contain a comma)'
      : !isDate(date) ? `${JSON.stringify(date)} is not a calendar date (YYYY-MM-DD)`
      : !isAmount(amount) ? `${JSON.stringify(amount)} is not an amount (digits, an optional minus and decimals)`
      : memo.trim() === '' ? 'the memo is empty'
      : null;
    if (why !== null) throw new LedgerError(`line ${i + 1}: ${why}`);
    entries.push({ date, amount, memo });
  });
  return entries;
}
