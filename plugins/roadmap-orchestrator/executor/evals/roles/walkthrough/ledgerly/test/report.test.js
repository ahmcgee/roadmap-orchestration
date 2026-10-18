import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestMonth, stateOf, teamMonth } from '../src/report.js';

const team = { id: 'platform', name: 'Platform', budget: 100000, alertAt: 0.8 };
const ledger = {
  entries: [
    { id: 'e-0001', team: 'platform', month: '2026-08', vendor: 'Hetzner', amount: 50000, note: '' },
    { id: 'e-0002', team: 'platform', month: '2026-09', vendor: 'Hetzner', amount: 70000, note: '' },
    { id: 'e-0003', team: 'platform', month: '2026-09', vendor: 'Sentry', amount: 15000, note: '' },
    { id: 'e-0004', team: 'data', month: '2026-09', vendor: 'Snyk', amount: 9000, note: '' },
  ],
  limits: {},
};

test('a team month totals its own entries only', () => {
  const view = teamMonth(ledger, team, '2026-09');
  assert.deepEqual([view.entries.length, view.total, view.limit, view.state], [2, 85000, 100000, 'near']);
});

test('a limit set from the dashboard overrides the budget', () => {
  assert.equal(teamMonth({ ...ledger, limits: { platform: 200000 } }, team, '2026-09').state, 'within');
});

test('states', () => {
  assert.equal(stateOf(10, 100, 0.8), 'within');
  assert.equal(stateOf(80, 100, 0.8), 'near');
  assert.equal(stateOf(101, 100, 0.8), 'over');
  assert.equal(latestMonth(ledger), '2026-09');
});
