import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ledger = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('reconcile a month in one command', () => {
  const r = ledger('reconcile', '2026-09', fileURLToPath(new URL('./september.csv', import.meta.url)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '2026-09 balance 12.75\n');
});
