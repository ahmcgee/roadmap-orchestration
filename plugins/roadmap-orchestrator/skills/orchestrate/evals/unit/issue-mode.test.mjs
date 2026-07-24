// Zero-token control-flow simulation of harness.mjs GitHub issue-mode projection. Locks three
// properties against the unmodified harness: (1) file mode is byte-identical — no gh text, no sync
// sweep; (2) issue mode folds gh clauses into the existing setup/merge/dossier agents and runs one
// wave-tail sync sweep; (3) the projection is best-effort — a failed sweep records a gh-sync
// degradation but never changes a unit outcome. Any red here is a fake/assumption bug, not a harness
// bug (the harness is the source of truth; expectations match the source).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from './load.mjs'
import { makeAgent, BASE_SHA, assertAllModelsPinned, assertSchemasPresent } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))

const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makePlan = (extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units: [unit('a')], edges: [], ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/session-test', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})
async function runWave(agentFn, plan, state, config = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config } }, agent: agentFn })
}
const ISSUE_PLAN = (extra = {}) => makePlan({ tracking: 'issues', repoSlug: 'o/r', trackingIssue: 9, ...extra })
const promptOf = (calls, prefix) => calls.find((c) => c.label === prefix || c.label.startsWith(prefix))?.prompt ?? ''
const has = (calls, prefix) => calls.some((c) => c.label === prefix || c.label.startsWith(prefix))

// =========================================================================================
// 1. File mode: byte-identical — no gh text anywhere, and no wave-tail sync sweep.
// =========================================================================================
test('file mode: no gh clauses and no issue-sync sweep', async () => {
  const { fn, calls } = makeAgent()
  const res = await runWave(fn, makePlan(), makeState())   // no tracking -> file mode
  assert.equal(res.units.a.status, 'merged')
  assert.ok(!has(calls, 'issue-sync:'), 'no sync sweep in file mode')
  for (const c of calls)
    assert.ok(!/gh issue/.test(c.prompt), `file-mode prompt "${c.label}" leaked a gh clause`)
})

// =========================================================================================
// 2. Issue mode: gh clauses fold into setup/merge; one wave-tail sync sweep fires.
// =========================================================================================
test('issue mode: folded gh clauses + one sync sweep', async () => {
  const { fn, calls } = makeAgent()
  const res = await runWave(fn, ISSUE_PLAN(), makeState())
  assert.equal(res.units.a.status, 'merged')
  // running folded into setup, keyed by the id marker; scoped to the repo slug.
  const setup = promptOf(calls, 'setup:')
  assert.match(setup, /roadmap:unit id=a/)
  assert.match(setup, /status:running/)
  assert.match(setup, /--repo o\/r/)
  // merged+close folded into the merge agent.
  const merge = promptOf(calls, 'merge:')
  assert.match(merge, /gh issue close/)
  assert.match(merge, /status:merged/)
  // exactly one wave-tail reconciliation sweep.
  const sweeps = calls.filter((c) => c.label.startsWith('issue-sync:'))
  assert.equal(sweeps.length, 1, 'exactly one issue-sync sweep per wave')
  assert.equal(sweeps[0].model, 'haiku')
  assertAllModelsPinned(calls)
  assertSchemasPresent(calls)
})

// =========================================================================================
// 3. Best-effort: a failed sync sweep degrades (gh-sync) but never changes a unit outcome.
// =========================================================================================
test('issue mode: failed sweep records gh-sync degradation, unit still merged', async () => {
  const { fn, calls } = makeAgent([{ match: /^issue-sync:/, result: { ok: false, detail: 'gh: network' } }])
  const res = await runWave(fn, ISSUE_PLAN(), makeState())
  assert.equal(res.units.a.status, 'merged', 'issue-sync failure must never gate the unit')
  const gh = (res.degradations ?? []).filter((d) => d.kind === 'gh-sync')
  assert.equal(gh.length, 1, 'a failed sweep records exactly one gh-sync degradation')
  assert.ok(has(calls, 'issue-sync:'))
})

// =========================================================================================
// 4. Quarantine path: the dossier-writer carries the gh quarantine clause (issue mode only).
// =========================================================================================
test('issue mode: quarantine dossier-writer carries the gh clause', async () => {
  // A fresh 'ready' worktree on the wrong base quarantines before any build.
  const { fn, calls } = makeAgent([{ match: /^setup:/, result: { ok: true, sha: 'f'.repeat(40), state: 'ready' } }])
  const res = await runWave(fn, ISSUE_PLAN(), makeState())
  assert.equal(res.units.a.status, 'quarantined')
  const dossier = promptOf(calls, 'dossier-write:')
  assert.match(dossier, /roadmap:unit id=a/)
  assert.match(dossier, /status:quarantined/)
})
