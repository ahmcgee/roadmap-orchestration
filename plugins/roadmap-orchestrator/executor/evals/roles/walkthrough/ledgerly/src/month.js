// Months are "YYYY-MM" strings everywhere: in the ledger, the CLI, the API and URLs.
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isMonth = (text) => MONTH.test(String(text));

/** "September 2026". */
export function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 1));
}
