import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from './load.mjs'
import { BASE_SHA, makeAgent } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const boundedPlan = (unit) => ({
  repoPath: '/repo', worktreeRoot: '/wt', methodology: { scopePolicy: 'bounded-v1' },
  units: [unit], edges: [], config: { gateAuditRate: 0 },
})
const surgical = { id: 'target', risk: 'low', kind: 'code', scopeMode: 'surgical',
  allowedPaths: ['src/target.js'], inScope: true }
const state = () => ({ integrationBranch: 'roadmap/scope', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {} })
const verify = (paths) => ({ head: BASE_SHA, changedPaths: paths, pass: true, blocked: false,
  failures: [], contractSurfaceTouched: false })
const run = async (rules, unit = surgical) => {
  const fake = makeAgent(rules)
  const harness = await loadScript(HARNESS)
  const result = await harness({ args: { plan: boundedPlan(unit), state: state(), config: { gateAuditRate: 0 } },
    agent: fake.fn, log: () => {}, phase: () => {} })
  return { result, calls: fake.calls }
}

test('surgical initial path expansion routes through explicit approve', async () => {
  const { result, calls } = await run([
    { match: /^verify:target#0$/, result: () => verify(['src/target.js', 'src/necessary.js']) },
    { match: /^scope-expand:/, result: () => ({ action: 'approve', paths: ['src/necessary.js'],
      guidance: 'criterion requires it', basis: 'acceptance criterion 1' }) },
  ])
  assert.equal(result.units.target.status, 'merged')
  assert.equal(calls.filter((c) => c.label.startsWith('scope-expand:')).length, 1)
  assert.deepEqual(result.units.target.scopeExpansions[0].requested, ['src/necessary.js'])
})

test('scope expansion revert restores the new path and retains the legitimate diff', async () => {
  const { result, calls } = await run([
    { match: /^verify:target#0$/, result: () => verify(['src/target.js', 'src/temptation.js']) },
    { match: /^scope-expand:/, result: () => ({ action: 'revert', paths: ['src/temptation.js'],
      guidance: 'not required', basis: 'outside criterion' }) },
    { match: /^scope-revert-verify:/, result: () => verify(['src/target.js']) },
  ])
  assert.equal(result.units.target.status, 'merged')
  assert.ok(calls.some((c) => c.label.startsWith('scope-revert:')))
})

test('scope expansion quarantine stops the unit even with green checks', async () => {
  const { result, calls } = await run([
    { match: /^verify:target#0$/, result: () => verify(['src/target.js', 'src/redesign.js']) },
    { match: /^scope-expand:/, result: () => ({ action: 'quarantine', paths: ['src/redesign.js'],
      guidance: 'premise changed', basis: 'requires redesign' }) },
  ])
  assert.equal(result.units.target.status, 'quarantined')
  assert.ok(!calls.some((c) => c.label.startsWith('merge:target')))
})

test('low-confidence and pre-existing findings remain visible but never enter a fix prompt', async () => {
  const { result, calls } = await run([
    { match: /^verify:/, result: () => verify(['src/target.js']) },
    { match: /^review:/, result: () => ({
      blocking: [{ summary: 'plausible race', file: 'src/target.js', confidence: 0.4,
        evidence: 'timing only', basis: 'not reproduced' }],
      observations: [{ summary: 'watch allocation', file: 'src/target.js', confidence: 0.5, evidence: 'profile hint' }],
      preExisting: [{ summary: 'old unrelated bug', file: 'src/target.js', confidence: 1,
        evidence: 'present at base', basis: 'base diff' }], unsatisfiable: false,
    }) },
  ])
  assert.equal(result.units.target.status, 'merged')
  assert.equal(calls.filter((c) => c.label.startsWith('fix:')).length, 0)
  assert.deepEqual(result.units.target.observations.map((o) => o.routeReason).sort(),
    ['below-minBlockConfidence', 'pre-existing', 'review-observation'])
})

test('unrequested cleanup is a blocking scope violation and the correction prompt is directive-only', async () => {
  let reviews = 0
  const { result, calls } = await run([
    { match: /^verify:/, result: () => verify(['src/target.js']) },
    { match: /^review:/, result: () => ++reviews === 1 ? ({
      blocking: [{ summary: 'unrequested formatting cleanup', file: 'src/target.js', confidence: 1,
        evidence: 'unrelated hunk in diff', basis: 'diff fact' }], observations: [], preExisting: [], unsatisfiable: false,
    }) : ({ blocking: [], observations: [], preExisting: [], unsatisfiable: false }) },
  ])
  assert.equal(result.units.target.status, 'merged')
  const correction = calls.find((c) => c.label === 'fix:target#0')
  assert.ok(correction)
  assert.match(correction.prompt, /This is a bounded correction turn/)
  assert.match(correction.prompt, /Do not fix additional issues you discover/)
})

test('mechanical unit rejects an initial edit outside its hard allowedPaths', async () => {
  const mechanical = { ...surgical, scopeMode: 'mechanical' }
  const { calls } = await run([
    { match: /^verify:target#0$/, result: () => verify(['src/target.js', 'docs/nice-to-have.md']) },
    { match: /^scope-expand:/, result: () => ({ action: 'quarantine', paths: ['docs/nice-to-have.md'],
      guidance: 'not the exact operation', basis: 'mechanical boundary' }) },
  ], mechanical)
  assert.ok(calls.some((c) => c.label.startsWith('scope-expand:')))
})

test('bounded implementer reports with a bankReason never trigger the legacy debt-fix sweep', async () => {
  const { result, calls } = await run([
    { match: /^impl:target$/, result: () => ({ summary: 'done', filesChanged: ['src/target.js'], debt: [{
      what: 'adjacent old defect', why: 'outside surgical goal', severity: 'major', kind: 'correctness',
      bankReason: 'pre-existing-untouched', file: 'src/target.js', anchor: 'oldFunction',
    }] }) },
    { match: /^verify:/, result: () => verify(['src/target.js']) },
  ])
  assert.equal(result.units.target.status, 'merged')
  assert.equal(calls.filter((c) => c.label.startsWith('debt-fix:')).length, 0)
  assert.ok(result.observations.some((o) => o.routeReason === 'insufficient-durable-evidence'))
})
