// The berth and vessel registers, swept a tick at a time: every entry is found by its own name and well formed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BERTHS, VESSELS, berth, vessel } from '../../src/registers.js';
import { replay } from './clock.js';

test('every berth and vessel in the registers is found and well formed', async () => {
  await replay((i) => {
    const b = BERTHS[i % BERTHS.length];
    assert.deepEqual(berth(b.id), b);
    assert.match(b.id, /^B[1-6]$/);
    assert.ok(b.maxDraught > 0 && b.maxDraught < 5);
    const v = VESSELS[i % VESSELS.length];
    assert.deepEqual(vessel(v.name), v);
    assert.ok(v.draught > 0, `${v.name} has a draught`);
    assert.throws(() => berth(`B${7 + i}`), /there is no berth/);
  });
});
