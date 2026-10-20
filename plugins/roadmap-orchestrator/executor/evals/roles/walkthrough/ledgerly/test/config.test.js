import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { InputError } from '../src/errors.js';

const FILE = `currency = GBP

[team.platform]
name = Platform
budget = 4200
alert_at = 0.75

[team.data]
budget = 1800
`;

test('teams, budgets and alert shares are read', () => {
  const { config } = parseConfig(FILE, 'ledgerly.conf');
  assert.equal(config.currency, 'GBP');
  assert.deepEqual(config.teams.map((t) => [t.id, t.name, t.budget, t.alertAt]), [['platform', 'Platform', 420000, 0.75], ['data', 'data', 180000, 0.8]]);
});

test('a bad value names the line, the key and the fix', () => {
  assert.throws(() => parseConfig('[team.platform]\nbudget = 4k\n', 'ledgerly.conf'), (e) => e instanceof InputError && /^ledgerly\.conf:2: budget must be a whole amount/.test(e.message));
});

test('a team without a budget is refused', () => {
  assert.throws(() => parseConfig('[team.platform]\nname = Platform\n', 'ledgerly.conf'), /has no budget/);
});
