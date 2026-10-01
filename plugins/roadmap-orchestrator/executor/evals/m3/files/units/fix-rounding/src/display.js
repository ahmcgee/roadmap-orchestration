import { formatAmount } from './format.js';

/** Renders an amount for display: formatAmount's cents (half to even on the decimal digits), thousands separated. */
export function formatDisplay(amount) {
  if (!Number.isFinite(amount)) throw new RangeError(`not a finite amount: ${amount}`);
  const [whole, cents] = formatAmount(amount).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}
