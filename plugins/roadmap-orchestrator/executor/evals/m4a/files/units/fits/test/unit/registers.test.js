import assert from 'node:assert/strict';
import { test } from 'node:test';
import { berthsFor } from '../../src/registers.js';

test('a vessel fits the berths whose maximum draught takes it, shallowest first', () => {
  assert.deepEqual(berthsFor(2.2).map((b) => b.id), ['B3', 'B4', 'B5', 'B6']);
  assert.deepEqual(berthsFor(3.6), []);
});

test('a draught that is not a positive number is refused', () => {
  assert.throws(() => berthsFor(0), /positive number/);
});
