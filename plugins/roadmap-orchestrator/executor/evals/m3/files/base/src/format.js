/** An amount as the ledger writes one: an optional minus, digits, and optional decimals (no exponent, no grouping). */
const AMOUNT = /^-?\d+(\.\d+)?$/;

/** Whether `text` is an amount (.roadmap/contracts/ledger.md, amounts). */
export function isAmount(text) {
  return typeof text === 'string' && AMOUNT.test(text);
}

/** The digits of an amount: its sign, its whole part and its decimals. */
function digitsOf(amount) {
  const text = String(amount);
  if (!AMOUNT.test(text)) throw new RangeError(`not an amount: ${JSON.stringify(text)}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  return { negative, whole, fraction };
}

/** The exact sum of amounts, as an amount text: added on their decimal digits, never in binary. */
export function sumAmounts(amounts) {
  const parts = amounts.map(digitsOf);
  const places = Math.max(0, ...parts.map((p) => p.fraction.length));
  const total = parts.reduce((sum, p) => {
    const scaled = BigInt(p.whole + p.fraction.padEnd(places, '0'));
    return sum + (p.negative ? -scaled : scaled);
  }, 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(places + 1, '0');
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return total < 0n ? `-${text}` : text;
}

/** Renders an amount (a number or an amount text) with exactly two decimals (.roadmap/contracts/ledger.md, money). */
export function formatAmount(amount) {
  const { negative, whole, fraction } = digitsOf(amount);
  let cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  const rest = fraction.slice(2);
  const above = rest.slice(1).replace(/0/g, '') !== '';
  if (rest[0] > '5' || (rest[0] === '5' && (above || cents % 2n === 1n))) cents += 1n;
  const sign = negative && cents !== 0n ? '-' : '';
  return `${sign}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
