import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv } from '../src/csv.js';
import { InputError } from '../src/errors.js';

test('rows carry their line numbers', () => {
  const rows = parseCsv('team,month,vendor,amount,note\nplatform,2026-09,Hetzner,120.50,runners\n\ndata,2026-09,Snyk,80,\n', 'x.csv');
  assert.deepEqual(rows.map((r) => [r.line, r.team, r.amount]), [[2, 'platform', '120.50'], [4, 'data', '80']]);
});

test('a wrong header or a short row names the file and line', () => {
  assert.throws(() => parseCsv('team,vendor\n', 'x.csv'), (e) => e instanceof InputError && e.message.startsWith('x.csv:1:'));
  assert.throws(() => parseCsv('team,month,vendor,amount,note\nplatform,2026-09\n', 'x.csv'), (e) => e instanceof InputError && e.message.startsWith('x.csv:2:'));
});
