import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ledger = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('amounts render to the cent', () => {
  const cases = [['0.125', '0.12'], ['0.625', '0.62'], ['2.675', '2.68'], ['1.015', '1.02'], ['1.005', '1.00'], ['1.255', '1.26'], ['-0.125', '-0.12'], ['10.5', '10.50']];
  for (const [amount, printed] of cases) {
    const r = ledger('format', amount);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${printed}\n`, `format ${amount}`);
  }
});
