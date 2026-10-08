import assert from 'node:assert/strict';
import { test } from 'node:test';
import { depthLine } from '../../src/depth.js';

test('the depth line names the berth and the draught it takes', () => {
  assert.equal(depthLine('B3'), 'B3: up to 2.2 m draught');
  assert.throws(() => depthLine('B9'), /there is no berth B9/);
});
