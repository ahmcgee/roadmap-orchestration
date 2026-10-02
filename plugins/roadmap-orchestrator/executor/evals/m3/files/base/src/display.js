/** Renders an amount for display: two decimals, thousands separated (.roadmap/contracts/ledger.md, money). */
export function formatDisplay(amount) {
  if (!Number.isFinite(amount)) throw new RangeError(`not a finite amount: ${amount}`);
  const [whole, cents] = amount.toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}
