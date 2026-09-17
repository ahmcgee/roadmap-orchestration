import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { makeAgent, BASE_SHA } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
async function resume({ rounds, rules = [], portable = true, status = 'pending' }) {
  const agent = makeAgent(rules)
  const runner = await loadScript(HARNESS)
  const result = await runner({ args: {
    plan: { repoPath: '/repo', worktreeRoot: '/wt', units: [{ id: 'a', risk: 'low', kind: 'code', inScope: true }], edges: [],
      ...(portable ? { config: { codexNative: { integrationTestCommand: 'npm test' } } } : {}) },
    state: { integrationBranch: 'roadmap/test', integrationTip: BASE_SHA, wave: 1, consultsUsed: 0,
      units: { a: { status, parked: true, rounds } } },
    config: { boundary: 'off', gateAuditRate: 0 }, launchId: 'handoff-1',
  }, agent: agent.fn })
  return { result, calls: agent.calls }
}

test('native-to-Claude resume keeps consumed fix rounds and uses the remaining gate rounds', async () => {
  const { result, calls } = await resume({ rounds: { fix: 1, opusGate: 1, gate: 0, verifyBlocked: 1 } })
  assert.equal(result.units.a.status, 'merged')
  assert.equal(result.units.a.rounds.fix, 1)
  assert.equal(result.units.a.rounds.opusGate, 2)
  assert.equal(result.units.a.rounds.verifyBlocked, 1)
  assert.ok(calls.some(c => c.label === 'opus-gate:a#1'))
  assert.ok(!calls.some(c => c.label === 'opus-gate:a#0'))
})

test('an exhausted shared fix budget gets verification and a dossier, not another fix', async () => {
  const { result, calls } = await resume({ rounds: { fix: 2, opusGate: 0, gate: 0 }, rules: [
    { match: /^verify:a#0$/, result: () => ({ pass: false, blocked: false, failures: ['incorrect result'],
      lanes: [{ command: 'npm test', exitCode: 1 }], contractSurfaceTouched: false, diffFiles: ['calc.js'] }) },
  ] })
  assert.equal(result.units.a.status, 'quarantined')
  assert.match(result.units.a.reason, /shared fix budget exhausted/)
  assert.equal(result.units.a.rounds.fix, 2)
  assert.ok(!calls.some(c => c.label.startsWith('codex-fix:')))
})

test('exhausted shared gate rounds still get a closing judgment without revision rounds', async () => {
  const { result, calls } = await resume({ rounds: { fix: 2, opusGate: 2, gate: 2 } })
  assert.equal(result.units.a.status, 'merged')
  assert.deepEqual(result.units.a.rounds, { fix: 2, opusGate: 2, gate: 2 })
  assert.ok(calls.some(c => c.label === 'gate:a#close'))
  assert.ok(!calls.some(c => /^opus-gate:a#\d|^gate:a#\d/.test(c.label)))
})

test('ordinary Claude-only arcs retain per-wave revision accounting', async () => {
  const { result, calls } = await resume({ portable: false, rounds: { fix: 2, opusGate: 2, gate: 2, verifyBlocked: 1 } })
  assert.equal(result.units.a.status, 'merged')
  assert.equal(result.units.a.rounds.fix, 0)
  assert.equal(result.units.a.rounds.opusGate, 1)
  assert.equal(result.units.a.rounds.verifyBlocked, 1)
  assert.ok(calls.some(c => c.label === 'opus-gate:a#0'))
})
