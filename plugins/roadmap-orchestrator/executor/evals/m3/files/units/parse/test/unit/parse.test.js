import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LedgerError, parseLedger } from '../../src/parse.js';

test('parseLedger reads entries in order, skipping blank lines (A1)', () => {
  assert.deepEqual(parseLedger('2026-09-01,10.50,refund\r\n\n2026-09-02,-3,fee\n'), [
    { date: '2026-09-01', amount: '10.50', memo: 'refund' },
    { date: '2026-09-02', amount: '-3', memo: 'fee' },
  ]);
});

test('a malformed line is refused, naming its line number (A2)', () => {
  for (const line of ['nope', '2026-02-30,1.00,x', '2026-09-01,1e3,x', '2026-09-01,1,234.50,x', '2026-09-01,1.00, ']) {
    assert.throws(() => parseLedger(`2026-09-01,1.00,ok\n${line}`), (e) => e instanceof LedgerError && /line 2/.test(e.message), line);
  }
});
