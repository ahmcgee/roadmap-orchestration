import { formatAmount, sumAmounts } from './format.js';

/** The month's balance line: the exact sum of its entries' amounts (.roadmap/contracts/ledger.md, commands). */
export function reconcile(entries, month) {
  const amounts = entries.filter((e) => e.date.startsWith(`${month}-`)).map((e) => e.amount);
  return `${month} balance ${formatAmount(sumAmounts(amounts))}`;
}
