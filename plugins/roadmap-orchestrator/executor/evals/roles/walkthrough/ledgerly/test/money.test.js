import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMoney, parseAmount, percent, plainAmount } from '../src/money.js';

test('amounts parse into minor units', () => {
  assert.equal(parseAmount('120'), 12000);
  assert.equal(parseAmount('120.5'), 12050);
  assert.equal(parseAmount(' 0.07 '), 7);
});

test('anything but a plain amount is refused', () => {
  for (const bad of ['', '12,50', '€12', '-4', '1.234', 'ten']) assert.equal(parseAmount(bad), null, bad);
});

test('amounts print for people and for scripts', () => {
  assert.equal(formatMoney(123450, 'EUR'), '€1,234.50');
  assert.equal(plainAmount(123450), '1234.50');
  assert.equal(percent(81, 100), 81);
});
