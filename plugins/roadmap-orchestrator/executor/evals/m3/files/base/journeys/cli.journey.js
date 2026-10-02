import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ledger = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('unknown commands exit 2', () => {
  const r = ledger('frobnicate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /frobnicate/);
});
