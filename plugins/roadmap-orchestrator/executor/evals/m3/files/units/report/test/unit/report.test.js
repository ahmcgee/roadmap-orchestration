import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcile } from '../../src/report.js';

test('reconcile sums the month exactly (A1)', () => {
  const entries = [
    { date: '2026-09-01', amount: '0.10', memo: 'a' },
    { date: '2026-09-02', amount: '0.20', memo: 'b' },
    { date: '2026-10-01', amount: '1', memo: 'c' },
  ];
  assert.equal(reconcile(entries, '2026-09'), '2026-09 balance 0.30');
  assert.equal(reconcile(entries, '2026-11'), '2026-11 balance 0.00');
});
