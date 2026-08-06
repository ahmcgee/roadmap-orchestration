import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { DASHBOARD_PAGE, startDashboard } from '../src/dashboard.mjs'

test('dashboard inline script is syntactically valid JavaScript', () => {
  const script = DASHBOARD_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script, 'inline dashboard script should exist')
  assert.doesNotThrow(() => new vm.Script(script))
})

test('dashboard serves a live metadata snapshot without exposing run results', async (t) => {
  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0 })
  t.after(() => dashboard.close())
  dashboard.record({ type: 'call.started', ordinal: 1, label: 'impl:x', phase: 'Implement', model: 'terra',
    effort: 'medium', prompt: 'must-not-leak', journalPath: '/private/journal' })
  dashboard.record({ type: 'run.completed', runId: 'r1', result: { secret: 'must-not-leak' } })
  const page = await fetch(`http://127.0.0.1:${dashboard.port}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Roadmap Codex/)
  const snapshot = await (await fetch(`http://127.0.0.1:${dashboard.port}/snapshot`)).json()
  assert.equal(snapshot.events[0].label, 'impl:x')
  assert.equal(snapshot.events[0].phase, 'Implement')
  assert.deepEqual(snapshot.events[1], { type: 'run.completed', runId: 'r1' })
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-leak/)
  assert.doesNotMatch(JSON.stringify(snapshot), /private\/journal/)
})
