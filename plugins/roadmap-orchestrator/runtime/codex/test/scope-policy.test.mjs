import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  admitDebt, authorizedPaths, debtIdentity, evidenceIsReproducible, isSubset, pathGrowth,
  routeReview, scopeModeOf, scopePolicyOf, validateScopeUnit,
} from '../../scope-policy.mjs'

test('missing policy and scope mode retain legacy behavior', () => {
  const plan = { units: [{ id: 'old', kind: 'code' }] }
  assert.equal(scopePolicyOf(plan), 'legacy')
  assert.equal(scopeModeOf(plan, plan.units[0]), 'legacy')
})

test('bounded ordinary units default to feature and strict modes require allowed paths', () => {
  const plan = { methodology: { scopePolicy: 'bounded-v1' } }
  assert.equal(scopeModeOf(plan, { id: 'new', kind: 'code' }), 'feature')
  assert.throws(() => validateScopeUnit(plan, { id: 's', kind: 'code', scopeMode: 'surgical' }), /requires/)
  assert.equal(validateScopeUnit(plan, { id: 's', kind: 'code', scopeMode: 'surgical', allowedPaths: ['src/a.js'] }), 'surgical')
})

test('feature expected files and hard path budgets are mechanically distinct', () => {
  assert.deepEqual(authorizedPaths({ scopeMode: 'feature' }, { files: ['b', 'a', 'a'] }), ['a', 'b'])
  assert.equal(isSubset(['a'], ['a', 'b']), true)
  assert.deepEqual(pathGrowth(['a'], ['a', 'c']), ['c'])
})

test('low-confidence blockers become observations and never remain directives', () => {
  const routed = routeReview({ blocking: [
    { summary: 'certain', confidence: 0.9 }, { summary: 'plausible', confidence: 0.4 },
  ], observations: [{ summary: 'watch' }], preExisting: [{ summary: 'old' }] }, 0.6)
  assert.deepEqual(routed.blocking.map((x) => x.summary), ['certain'])
  assert.deepEqual(routed.observations.map((x) => x.summary), ['watch', 'plausible'])
  assert.deepEqual(routed.preExisting.map((x) => x.summary), ['old'])
})

test('durable debt requires evidence and deduplicates by fact rather than file', () => {
  const expiry = { file: 'src/cache.ts', anchor: 'Cache.get()', claim: 'expired value visible',
    probe: 'npm test -- cache-expiry', observed: 'assertion fails' }
  const race = { file: 'src/cache.ts', anchor: 'Cache.put()', claim: 'write race',
    probe: 'npm test -- cache-race', observed: 'assertion fails' }
  assert.equal(evidenceIsReproducible(expiry), true)
  assert.equal(evidenceIsReproducible({ file: 'src/cache.ts', claim: 'contract breach',
    contract: 'cache-contract.md#expired-entries' }), true)
  assert.equal(evidenceIsReproducible({ file: 'src/cache.ts', claim: 'looks untidy' }), false)
  assert.notEqual(debtIdentity(expiry), debtIdentity(race))
  const first = admitDebt([], [expiry, race, { file: 'x', claim: 'aesthetic' }], 'abc')
  assert.equal(first.debt.length, 2)
  assert.equal(first.observations.length, 1)
  const second = admitDebt(first.debt, [{ ...expiry, observed: 'still fails' }], 'def')
  assert.equal(second.debt.length, 2)
  assert.equal(second.debt.find((x) => x.debtKey === debtIdentity(expiry)).lastSeenSha, 'def')
})
