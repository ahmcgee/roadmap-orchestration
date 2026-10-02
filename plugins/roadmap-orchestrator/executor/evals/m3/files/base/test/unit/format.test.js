import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAmount, isAmount, sumAmounts } from '../../src/format.js';

test('isAmount accepts digits with an optional minus and decimals, nothing else', () => {
  for (const ok of ['0', '12', '-3', '12.50', '0.125']) assert.equal(isAmount(ok), true, ok);
  for (const bad of ['', '1e3', '+1', '1,234.50', '1.', '.5', 'NaN', 'Infinity', ' 1', 12]) assert.equal(isAmount(bad), false, String(bad));
});

test('sumAmounts adds on the decimal digits', () => {
  assert.equal(sumAmounts(['0.1', '0.2']), '0.3');
  assert.equal(sumAmounts(['10.50', '-12.75']), '-2.25');
  assert.equal(sumAmounts([]), '0');
});

test('formatAmount renders two decimals', () => {
  assert.equal(formatAmount(12.5), '12.50');
  assert.equal(formatAmount('3'), '3.00');
  assert.equal(formatAmount(0.1 + 0.2), '0.30');
  assert.equal(formatAmount('-1234.5'), '-1234.50');
  assert.throws(() => formatAmount(Number.NaN), RangeError);
});
