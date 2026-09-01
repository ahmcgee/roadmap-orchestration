// Zero-token simulation of the "git is truth, enforced in code" contract.
//
// Three ledger entries share one root cause: the harness took an AGENT's word for a git fact, and
// on a resume it took a CACHED agent's word for it.
//   2026-08-28  a merge ran on a detached HEAD in the integration worktree, reported merged:true,
//               and was recorded as `merged` with a `mergedAt` no branch pointed at.
//   2026-08-25  a resume replayed a pre-merge setup report and drove an already-merged unit back
//               through build, verify and quarantine.
//   2026-08-26  a resume replayed a pre-rebuild `cd: No such file` provisioning failure.
// The fix is structural, and these sims lock it: every git fact the harness ACTS on comes from a
// closed-list courier that reports exit codes verbatim (`merged-probe:`, `merge-reach:`, and the
// integration-worktree setup's `priorTipAncestorExit`), the SCRIPT judges them, and every
// environment probe carries the per-launch `args.launchId` so no resume can serve one from cache.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from './load.mjs'
import { makeAgent, BASE_SHA, assertAllModelsPinned, assertSchemasPresent } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const NEW_SHA = 'cafebabecafebabecafebabecafebabecafebabe'
const UNIT_TIP = 'dddddddddddddddddddddddddddddddddddddddd'

const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makePlan = (units, edges = [], extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units, edges, ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/session-test', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})
async function runWave(agentFn, plan, state, config = {}, args = { launchId: 'launch-1' }) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config }, ...args }, agent: agentFn })
}
const has = (calls, prefix) => calls.some((c) => c.label === prefix || c.label.startsWith(prefix))
const labelled = (calls, prefix) => calls.filter((c) => c.label.startsWith(prefix))
const degradationsOf = (state, kind) => (state.degradations ?? []).filter((d) => d.kind === kind)
// The courier's report: one exit code per interpolated command, plus each command's first stdout line.
const probe = (exitCodes, out = []) => ({ ok: true, exitCodes, out })
// merged-probe: [branch resolves, branch tip is a second parent on the integration branch, worktree present]
const NOT_MERGED = probe([0, 1, 0], [UNIT_TIP, '', ''])
const MERGED = probe([0, 0, 0], [UNIT_TIP, '', ''])

// =========================================================================================
// 1. A merge is not merged until git says the commit is reachable from the branch.
// =========================================================================================
test('1a detached-HEAD merge: merged:true with an unreachable commit quarantines, and the tip does not move', async () => {
  const { fn, calls } = makeAgent([
    { match: /^merge:a$/, result: () => ({ merged: true, suitePass: true, head: NEW_SHA, detail: '' }) },
    // HEAD is not on the integration branch; the merge commit is dangling.
    { match: /^merge-reach:a$/, result: () => probe([1, 1, 1]) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.units.a.status, 'quarantined', 'an unreachable merge is never recorded as merged')
  assert.equal(state.units.a.mergedAt, undefined, 'and carries no mergedAt')
  assert.equal(state.integrationTip, BASE_SHA, 'the integration tip never adopts a commit no branch can reach')
  assert.match(state.units.a.reason, /not reachable from roadmap\/session-test/)
  assert.ok(has(calls, 'dossier:a'), 'it quarantines through the normal dossier path')
})

test('1b reachability is three separate facts: a reported head off the branch also refuses', async () => {
  const { fn } = makeAgent([
    { match: /^merge:a$/, result: () => ({ merged: true, suitePass: true, head: NEW_SHA, detail: '' }) },
    // HEAD attached and the branch is an ancestor, but the sha the agent reported is not.
    { match: /^merge-reach:a$/, result: () => probe([0, 0, 1]) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /head cafebabe.* is-ancestor exit 1/)
})

test('1c a reachable merge still merges, and the courier ran the exact commands', async () => {
  const { fn, calls } = makeAgent([
    { match: /^merge:a$/, result: () => ({ merged: true, suitePass: true, head: NEW_SHA, detail: '' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.a.mergedAt, NEW_SHA)
  assert.equal(state.integrationTip, NEW_SHA)
  const reach = calls.find((c) => c.label === 'merge-reach:a')
  assert.match(reach.prompt, /test "\$\(git symbolic-ref --quiet --short HEAD\)" = "roadmap\/session-test"/)
  assert.match(reach.prompt, /git merge-base --is-ancestor unit\/a roadmap\/session-test/)
  assert.match(reach.prompt, new RegExp(`git merge-base --is-ancestor ${NEW_SHA} roadmap/session-test`))
  assert.match(reach.prompt, /Change NOTHING/, 'the courier may not repair what it finds')
  assert.equal(reach.model, 'haiku', "couriering exit codes is the cheapest tier's job")
})

test('1d the merge agent must put HEAD on the integration branch before merging', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  const merge = calls.find((c) => c.label === 'merge:a')
  assert.match(merge.prompt, /confirm HEAD is ON branch roadmap\/session-test/)
  assert.match(merge.prompt, /git checkout roadmap\/session-test/)
  assert.match(merge.prompt, /detached HEAD produces a commit no branch can reach/)
})

// =========================================================================================
// 2. Merged is decided by git BEFORE dispatch — and the decision cannot be cache-replayed.
// =========================================================================================
test('2a an already-merged unit is never dispatched: no setup, no build, no merge', async () => {
  const { fn, calls } = makeAgent([{ match: /^merged-probe:a$/, result: () => MERGED }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.a.mergedAt, UNIT_TIP, 'mergedAt is the branch tip git reported, not an agent claim')
  for (const p of ['setup:a', 'plan:a', 'codex-build:a', 'verify:a', 'merge:a'])
    assert.ok(!has(calls, p), `${p} must not run for a unit git already calls merged`)
})

test('2b the probe is the second-parent test, not a bare is-ancestor', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  const p = calls.find((c) => c.label === 'merged-probe:a')
  assert.match(p.prompt, /git log --merges --format=%P roadmap\/session-test \| awk '\{print \$2\}' \| grep -qxF "\$SHA"/,
    'a commit-less branch parked at an old integration commit false-positives on bare is-ancestor')
  assert.match(p.prompt, /test -d \/wt\/a/, 'and the live worktree directory is read in the same breath')
})

test('2c a dead probe never reads as merged — the unit dispatches normally', async () => {
  const { fn, calls } = makeAgent([{ match: /^merged-probe:a$/, result: () => ({ ok: false, exitCodes: [], out: [] }) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.units.a.status, 'merged', 'it merges the ordinary way')
  assert.ok(has(calls, 'setup:a'), 'silence from the courier is not a git fact')
})

// =========================================================================================
// 3. quarantine() refuses a unit git says is merged — with one deliberate exception.
// =========================================================================================
test('3a quarantine is refused for a merged branch and recorded as merged instead', async () => {
  let n = 0
  const { fn, calls } = makeAgent([
    // Not merged at dispatch; merged by the time the (stale) verdict asks for a quarantine.
    { match: /^merged-probe:a$/, result: () => (n++ === 0 ? NOT_MERGED : MERGED) },
    { match: /^verify:a/, result: () => ({ pass: false, blocked: true, failures: [], contractSurfaceTouched: false, diffFiles: [] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.units.a.status, 'merged', 'landed work is never re-opened for redesign')
  assert.equal(state.units.a.mergedAt, UNIT_TIP)
  assert.ok(!has(calls, 'dossier:a'), 'and no dossier is written for a unit that is not quarantined')
  const [d] = degradationsOf(state, 'quarantine-refused')
  assert.ok(d, 'the refusal is loud — the verdict that asked for it was reading stale state')
  assert.match(d.what, /git says its branch landed on roadmap\/session-test/)
})

test('3b an unmerged branch quarantines exactly as before', async () => {
  const { fn, calls } = makeAgent([
    { match: /^verify:a/, result: () => ({ pass: false, blocked: true, failures: [], contractSurfaceTouched: false, diffFiles: [] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.units.a.status, 'quarantined')
  assert.ok(has(calls, 'dossier:a'))
  assert.equal(degradationsOf(state, 'quarantine-refused').length, 0)
})

test('3c a REVERTED merge still quarantines: `git revert -m 1` leaves the merge commit in history', async () => {
  // Not merged at dispatch (or nothing would run), merged on every later ask — which is exactly
  // what git reports after the integration fix reverts: the merge commit is still in history.
  let dispatched = false
  const { fn, calls } = makeAgent([
    { match: /^merged-probe:a$/, result: () => (dispatched ? MERGED : ((dispatched = true), NOT_MERGED)) },
    { match: /^merge:a$/, result: () => ({ merged: true, suitePass: false, head: NEW_SHA, detail: 'red' }) },
    { match: /^integration-fix:a$/, result: () => ({ merged: true, suitePass: false, head: NEW_SHA, detail: 'reverted' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.units.a.status, 'quarantined', 'the one caller that may quarantine a branch git calls merged')
  assert.match(state.units.a.reason, /broke the integrated suite/)
  assert.equal(degradationsOf(state, 'quarantine-refused').length, 0, 'and it does not consult the probe at all')
  assert.equal(labelled(calls, 'merged-probe:').length, 1, 'only the dispatch probe ran')
})

// =========================================================================================
// 4. Crash residue is only residue if git says the unit did not finish.
// =========================================================================================
test('4a a merge-ready record whose merge landed is adopted as merged, not rebuilt', async () => {
  const { fn, calls } = makeAgent([{ match: /^merged-probe:a$/, result: () => MERGED }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState({ units: { a: { status: 'merge-ready' } } }), { boundary: 'off' })
  assert.equal(state.units.a.status, 'merged')
  assert.match(state.units.a.note, /crash residue/)
  assert.ok(!has(calls, 'setup:a'), 'the unit is not re-dispatched')
})

test('4b a running record whose branch did NOT land still resets to pending and re-enters dispatch', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), makeState({ units: { a: { status: 'running' } } }), { boundary: 'off' })
  assert.equal(state.units.a.status, 'merged')
  assert.ok(has(calls, 'setup:a'), 'crash-residue recovery is unchanged for work that really is unfinished')
})

// =========================================================================================
// 5. Environment probes are salted out of resume's cache; work product is not.
// =========================================================================================
const PROBE_LABELS = ['integration-worktree', 'provision:integration', 'merged-probe:a', 'provision:a', 'merge-reach:a']
const WORK_LABELS = ['plan:a', 'codex-build:a', 'verify:a', 'opus-gate:a', 'merge:a']

test('5a every environment probe carries args.launchId; no work-product call does', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')], [], { provision: { setup: 'pnpm i' } }), makeState(), { boundary: 'off' })
  for (const l of PROBE_LABELS) {
    const c = calls.find((x) => x.label === l)
    assert.ok(c, `${l} was never called — the assertion would be vacuous`)
    assert.match(c.prompt, /Probe id launch-1/, `${l} must not be replayable from a stale run's cache`)
  }
  for (const l of WORK_LABELS) {
    const c = calls.find((x) => x.label.startsWith(l))
    assert.ok(c, `${l} was never called — the assertion would be vacuous`)
    assert.ok(!/Probe id/.test(c.prompt), `${l} is work product: replaying it from cache is the point of resume`)
  }
})

test('5b a missing launchId degrades once and falls back to unsalted — it never kills the arc', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' }, {})
  assert.equal(state.units.a.status, 'merged', 'the wave still runs')
  const d = degradationsOf(state, 'no-launch-id')
  assert.equal(d.length, 1, 'recorded exactly once per wave')
  assert.match(d[0].what, /pass a fresh args.launchId on every launch and every resume/)
  assert.ok(!calls.some((c) => /Probe id/.test(c.prompt)), 'and nothing is salted with an undefined nonce')
})

test('5c setup is salted only when the worktree directory is gone', async () => {
  const { fn: fn1, calls: c1 } = makeAgent()
  await runWave(fn1, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.ok(!/Probe id/.test(c1.find((c) => c.label === 'setup:a').prompt),
    'a worktree that is still there makes the cached setup report true — replay it')

  // exitCodes[2] is the `test -d` on the worktree path: absent.
  const { fn: fn2, calls: c2 } = makeAgent([{ match: /^merged-probe:a$/, result: () => probe([0, 1, 1], [UNIT_TIP, '', '']) }])
  await runWave(fn2, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.match(c2.find((c) => c.label === 'setup:a').prompt, /Probe id launch-1/,
    'a cached setup report describing a checkout that no longer exists must not be served')
})

test('5d the git couriers are pinned, schema-bearing, and judgment-free', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assertAllModelsPinned(calls)
  assertSchemasPresent(calls)
  for (const c of [...labelled(calls, 'merged-probe:'), ...labelled(calls, 'merge-reach:')]) {
    assert.deepEqual(c.schema.required, ['ok', 'exitCodes'], 'the courier returns facts, never a verdict')
    assert.ok(!/\bis it\b|decide|judge/i.test(c.prompt), 'and is never asked to interpret them')
  }
})
