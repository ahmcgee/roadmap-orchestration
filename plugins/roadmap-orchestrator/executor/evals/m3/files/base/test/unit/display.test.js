import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDisplay } from '../../src/display.js';

test('formatDisplay separates thousands', () => {
  assert.equal(formatDisplay(1234.5), '1,234.50');
  assert.equal(formatDisplay(-1234567), '-1,234,567.00');
  assert.equal(formatDisplay(3), '3.00');
  assert.throws(() => formatDisplay(Number.POSITIVE_INFINITY), RangeError);
});
