// Zero-token control-flow simulation of the harness's WARM LANES. A strict linear chain of
// contract edges among pending, fresh, in-scope units is implemented by ONE warm Opus session
// (one `chain-plan:` call, one `chain-impl:` call, per-link commits + pinned branches); each
// link then runs the UNCHANGED cold verify → review → gate → merge pipeline through runUnit's
// adoption entry, diffed against its recorded predecessor tip.
//
// The invariants these lock, in the order they matter:
//   1. The lane REPLACES per-link plan/implement calls — never duplicates them.
//   2. warmLanes:false is byte-identical to the pre-warm-lane cold design.
//   3. Every lane-infrastructure failure DEMOTES to cold dispatch. The lane is an optimization;
//      it may never become a new way to lose work, and it may never quarantine on its own.
//   4. A link that fails ITS OWN pipeline quarantines exactly as it would have cold, and the
//      tail blocks behind it exactly as ready()/blockedBy would have held it.
//
// As with harness.test.mjs: the harness is the source of truth. A red here is a fake/assumption
// bug until proven otherwise — expectations are matched to the source, not the reverse.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from './load.mjs'
import { makeAgent, BASE_SHA, assertAllModelsPinned, assertSchemasPresent } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))

// ---- fixtures (same shapes harness.test.mjs uses) ----------------------------------------
const makePlan = (units, edges = [], extra = {}) => ({
  repoPath: '/repo',
  worktreeRoot: '/wt',
  units,
  edges,
  ...extra,
})
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/session-test',
  integrationTip: BASE_SHA,
  consultsUsed: 0,
  wave: 0,
  units: {},
  ...extra,
})

async function runWave(agentFn, plan, state, config = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config } }, agent: agentFn })
}

const has = (calls, prefix) => calls.some((c) => c.label === prefix || c.label.startsWith(prefix))
const seqOf = (calls, prefix) => calls.find((c) => c.label === prefix || c.label.startsWith(prefix))?.seq
const countOf = (calls, prefix) => calls.filter((c) => c.label.startsWith(prefix)).length
const promptOf = (calls, prefix) => calls.find((c) => c.label === prefix || c.label.startsWith(prefix))?.prompt
// Every label the warm lane owns. "No lane labels" is the single assertion that proves a wave
// took the cold design, so it is spelled once here rather than re-derived per test.
const LANE_LABEL = /^(lane-setup:|chain-)/
const laneLabels = (calls) => calls.filter((c) => LANE_LABEL.test(c.label)).map((c) => c.label)

const contract = (from, to) => ({ from, to, type: 'semantic', mode: 'contract' })

// Distinct, non-prefix-overlapping 40-char shas. sameSha() compares by prefix in EITHER
// direction (harness.mjs:175), so a tip that shares a leading run with BASE_SHA would make the
// setup base assertion pass for the wrong reason.
const TIP = { a: '11111111111111111111111111111111111111aa', b: '2222222222222222222222222222222222222bbb', c: '33333333333333333333333333333333333ccccc' }

// ---- warm-lane rule builders --------------------------------------------------------------
// The fakes' built-in chain-plan default returns {links: []}, which the harness reads as "the
// plan missed a link" and DEMOTES. Every test that wants a live lane must therefore supply real
// per-link rules; these three builders are that override, keyed on the chain head.
const chainPlanRule = (head, ids) => ({
  match: new RegExp(`^chain-plan:${head}$`),
  result: () => ({ links: ids.map((id) => ({ id, feasible: true, files: [`${id}.js`], testPlan: 'unit tests', approach: 'x' })) }),
})
const chainImplRule = (head, ids, perLink = {}) => ({
  match: new RegExp(`^chain-impl:${head}$`),
  result: () => ({ links: ids.map((id) => ({ id, done: true, filesChanged: [`${id}.js`], summary: 'done', ...(perLink[id] ?? {}) })) }),
})
const chainTipsRule = (head, tips) => ({
  match: new RegExp(`^chain-tips:${head}$`),
  result: () => ({ ok: true, tips: Object.entries(tips).map(([id, sha]) => ({ id, sha })) }),
})
// The warm call committed on each link's branch and pinned it, so the per-link setup agent finds
// unmerged work and ADOPTS it (harness.mjs:1110-1116) — reporting the pinned tip, not the base.
// The built-in default reports state:'ready' at BASE_SHA, which would send a lane link down the
// fresh-build branch and emit the very plan:/impl: calls the lane exists to replace.
const adoptSetupRules = (tips) =>
  Object.entries(tips).map(([id, sha]) => ({
    match: new RegExp(`^setup:${id}$`),
    result: () => ({ ok: true, sha, state: 'adopted' }),
  }))

// A complete live-lane rule set: plan + impl + tips + per-link adoption.
const liveLane = (head, ids, { tips = Object.fromEntries(ids.map((id) => [id, TIP[id]])), perLink = {}, planIds = ids } = {}) => [
  ...adoptSetupRules(tips),
  chainPlanRule(head, planIds),
  chainImplRule(head, ids, perLink),
  chainTipsRule(head, tips),
]

// =========================================================================================
// 1. Happy chain a→b: ONE plan call, ONE implement call, two cold per-link pipelines, in order.
// =========================================================================================
test('1 happy chain a→b: one warm plan + one warm implement, per-link cold pipelines in order', async () => {
  const { fn, calls } = makeAgent(liveLane('a', ['a', 'b']))
  const state = await runWave(fn, makePlan([unit('a'), unit('b')], [contract('a', 'b')]), makeState())

  // The lane fired exactly once, at the head.
  assert.equal(countOf(calls, 'chain-plan:'), 1, 'exactly one chain plan call')
  assert.equal(countOf(calls, 'chain-impl:'), 1, 'exactly one chain implement call')
  assert.ok(has(calls, 'chain-plan:a'), 'the lane is keyed on the chain head')
  assert.ok(has(calls, 'lane-setup:a'), 'the lane builds one worktree, at the head')

  // ...and it REPLACED the per-link cold plan/implement calls rather than adding to them.
  for (const gone of ['plan:a', 'plan:b', 'impl:a', 'impl:b'])
    assert.ok(!has(calls, gone), `${gone} must not fire — the warm lane already planned/implemented it`)

  // Each link still enters the cold pipeline through setup's ADOPTION path.
  for (const id of ['a', 'b']) {
    const p = promptOf(calls, `setup:${id}`)
    assert.ok(p, `setup:${id} fired`)
    assert.match(p, /adopt it as-is/, `setup:${id} takes the adoption path, never a destructive rebuild`)
  }

  // Merges stay ordered and serial: a is fully settled before b's pipeline judges anything.
  assert.ok(seqOf(calls, 'merge:a') < seqOf(calls, 'merge:b'), 'merge order follows chain order')
  assert.ok(seqOf(calls, 'setup:b') > seqOf(calls, 'merge:a'), "b's pipeline starts only after a merged")
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')

  // The load-bearing bit: link b is diffed against a's RECORDED PINNED TIP, not the integration
  // tip and not the lane base — otherwise b's reviewer/gate would judge a's diff as well as b's.
  assert.ok(promptOf(calls, 'review:a#0').includes(`git diff ${BASE_SHA}..HEAD`),
    'the head link diffs against the lane base')
  assert.ok(promptOf(calls, 'review:b#0').includes(`git diff ${TIP.a}..HEAD`),
    "the second link diffs against its predecessor's pinned tip")

  assertAllModelsPinned(calls)
  assertSchemasPresent(calls)
})

// =========================================================================================
// 2. warmLanes:false restores the cold design exactly. Both disable knobs (warmLanes:false and
//    maxChainLength:1) must produce a byte-identical call stream — the lane is opt-out, and an
//    opt-out that changes any prompt is a silent behaviour change on every legacy arc.
// =========================================================================================
test('2 warmLanes:false: no lane labels, cold plan/impl per unit, byte-identical to maxChainLength:1', async () => {
  // NOTE: no adopt-setup overrides here — a cold wave's setup legitimately reports state:'ready'.
  // The chain rules are supplied anyway, so a lane that fired despite the config would be visible.
  const chainRules = [chainPlanRule('a', ['a', 'b']), chainImplRule('a', ['a', 'b']), chainTipsRule('a', { a: TIP.a, b: TIP.b })]
  const plan = () => makePlan([unit('a'), unit('b')], [contract('a', 'b')])

  const runAt = async (config) => {
    const { fn, calls } = makeAgent(chainRules)
    const state = await runWave(fn, plan(), makeState(), config)
    return { calls, state }
  }

  const off = await runAt({ warmLanes: false })
  assert.deepEqual(laneLabels(off.calls), [], 'warmLanes:false emits no lane-setup:/chain- label at all')
  for (const cold of ['plan:a', 'impl:a', 'plan:b', 'impl:b'])
    assert.ok(has(off.calls, cold), `${cold} fires on the cold path`)
  assert.equal(off.state.units.a.status, 'merged')
  assert.equal(off.state.units.b.status, 'merged')

  // The other disable knob must land on the same wave, prompt for prompt. `seq` is a shared
  // monotonic counter across fakes, so it is excluded — everything the platform actually sees
  // (label, model, effort, phase, prompt text) is compared verbatim.
  const capped = await runAt({ maxChainLength: 1 })
  const sig = ({ calls }) => calls.map((c) => ({ label: c.label, model: c.model, effort: c.effort, phase: c.phase, prompt: c.prompt }))
  assert.deepEqual(sig(capped), sig(off),
    'maxChainLength:1 and warmLanes:false must produce the identical cold wave')
})

// =========================================================================================
// 3. Lane failure DEMOTES, never quarantines. The fakes' default chain-plan reports no links —
//    the "chain plan missed a link" path — and both units must finish through the cold pipeline
//    with a clean degradation ledger (a demote is a design-sanctioned fallback, not a defect).
// =========================================================================================
test('3 demote on lane failure: both links fall back to cold dispatch, no degradations', async () => {
  const { fn, calls } = makeAgent()   // built-in defaults: chain-plan → {links: []}
  const state = await runWave(fn, makePlan([unit('a'), unit('b')], [contract('a', 'b')]), makeState())

  assert.ok(has(calls, 'chain-plan:a'), 'the lane was attempted')
  assert.ok(!has(calls, 'chain-impl:'), 'a demoted lane never reaches the warm implement call')

  for (const cold of ['plan:a', 'impl:a', 'plan:b', 'impl:b'])
    assert.ok(has(calls, cold), `${cold} fires after the demote`)
  assert.ok(seqOf(calls, 'plan:a') > seqOf(calls, 'chain-plan:a'), 'the cold path runs after the lane gave up')
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')
  assert.deepEqual(state.degradations ?? [], [],
    'a demote is a sanctioned fallback — it must not pollute the skill-feedback ledger')
})

// =========================================================================================
// 4. Contingent edges never chain: the conductor may withhold or replan a contingent dependent,
//    so a warm session that already built it would be building work that may be cut.
// =========================================================================================
test('4 contingent edge: never chained, both units run cold', async () => {
  // Live chain rules, but NO adopt-setup overrides: a cold wave's setup legitimately reports
  // state:'ready', and a lane that fired anyway would show up as a missing plan:/impl: pair.
  const { fn, calls } = makeAgent([chainPlanRule('a', ['a', 'b']), chainImplRule('a', ['a', 'b']), chainTipsRule('a', { a: TIP.a, b: TIP.b })])
  const state = await runWave(
    fn,
    makePlan([unit('a'), unit('b')], [{ from: 'a', to: 'b', type: 'semantic', mode: 'contingent' }]),
    makeState(),
  )

  assert.deepEqual(laneLabels(calls), [], 'a contingent edge produces no lane at all')
  for (const cold of ['plan:a', 'impl:a', 'plan:b', 'impl:b'])
    assert.ok(has(calls, cold), `${cold} fires on the cold path`)
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')
})

// =========================================================================================
// 5. maxChainLength caps one warm session's scope: a→b→c at cap 2 chunks to [a,b], and the
//    remainder (a single unit) is not a chain at all — c runs cold, after b merges.
// =========================================================================================
test('5 chain cap: a→b→c at maxChainLength 2 lanes [a,b] and leaves c cold', async () => {
  const { fn, calls } = makeAgent(liveLane('a', ['a', 'b']))
  const state = await runWave(
    fn,
    makePlan([unit('a'), unit('b'), unit('c')], [contract('a', 'b'), contract('b', 'c')]),
    makeState(),
    { maxChainLength: 2 },
  )

  assert.deepEqual(laneLabels(calls).sort(), ['chain-impl:a', 'chain-plan:a', 'chain-tips:a', 'lane-setup:a'],
    'exactly one lane, headed by a, covering only the first chunk')
  const chainPlanPrompt = promptOf(calls, 'chain-plan:a')
  assert.ok(chainPlanPrompt.includes('CHAIN of 2 dependent units'), 'the warm session is told its capped length')
  assert.ok(chainPlanPrompt.includes('a → b'), 'the lane covers the first chunk')
  assert.ok(!chainPlanPrompt.includes('specs/c.md'), "c's spec is outside this lane's scope")

  for (const laned of ['plan:a', 'impl:a', 'plan:b', 'impl:b'])
    assert.ok(!has(calls, laned), `${laned} is the lane's work, not a cold call`)
  assert.ok(has(calls, 'plan:c'), 'the remainder runs cold')
  assert.ok(has(calls, 'impl:c'), 'the remainder runs cold')
  assert.ok(seqOf(calls, 'plan:c') > seqOf(calls, 'merge:b'), 'c only starts once its dependency merged')

  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')
  assert.equal(state.units.c.status, 'merged')
})

// =========================================================================================
// 6. A per-link plan-check quarantine splits the chain at that link: the approved PREFIX still
//    gets implemented and merged, the rejected link quarantines, and the tail blocks — exactly
//    the shape ready()/blockedBy would have produced cold.
// =========================================================================================
test('6 per-link plan-check quarantine: prefix merges, the link quarantines, the tail blocks', async () => {
  const { fn, calls } = makeAgent([
    // b escalates at the Opus plan-check, and the frontier architect kills it.
    { match: /^opus-plan-check:b$/, result: () => ({ verdict: 'escalate', trigger: 'contract', guidance: 'contract call' }) },
    { match: /^plan-check:b$/, result: () => ({ verdict: 'quarantine', guidance: 'the spec contradicts its contract' }) },
    // The warm session only ever implements the approved prefix.
    ...liveLane('a', ['a'], { tips: { a: TIP.a }, planIds: ['a', 'b', 'c'] }),
  ])
  const state = await runWave(
    fn,
    makePlan([unit('a'), unit('b'), unit('c')], [contract('a', 'b'), contract('b', 'c')]),
    makeState(),
  )

  assert.equal(countOf(calls, 'chain-plan:'), 1, 'one lane covering all three links')
  assert.ok(has(calls, 'plan-check:b'), 'the escalated link reached the frontier architect')
  assert.equal(state.units.a.status, 'merged', 'the approved prefix still ships')
  assert.equal(state.units.b.status, 'quarantined')
  assert.match(state.units.b.reason, /plan rejected by architect/)
  assert.equal(state.units.c.status, 'blocked', 'the tail blocks behind the quarantined predecessor')

  // Neither the rejected link nor the tail may be quietly rebuilt cold behind the quarantine.
  for (const gone of ['plan:b', 'impl:b', 'plan:c', 'impl:c', 'setup:b', 'setup:c'])
    assert.ok(!has(calls, gone), `${gone} must not fire — b was killed before code existed`)
})

// =========================================================================================
// 7. Per-link report consumption: each link's warm report is consumed exactly as a cold build
//    consumes its own. A link that confesses a contract mismatch forces the FRONTIER gate; its
//    clean sibling still takes the cheap Opus-first gate.
// =========================================================================================
test('7 per-link report consumption: a link\'s contractMismatch forces its own frontier gate only', async () => {
  const MISMATCH = 'FROZEN_SURFACE_MISMATCH_LINK_A'
  const { fn, calls } = makeAgent(liveLane('a', ['a', 'b'], { perLink: { a: { contractMismatch: MISMATCH } } }))
  const state = await runWave(fn, makePlan([unit('a'), unit('b')], [contract('a', 'b')]), makeState())

  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')

  // a: forced Fable gate carrying the mismatch text; the Opus gate is skipped for that link.
  assert.ok(has(calls, 'gate:a#0'), "the mismatching link's gate is forced to the frontier")
  assert.equal(calls.find((c) => c.label === 'gate:a#0').model, 'fable')
  assert.ok(promptOf(calls, 'gate:a#0').includes(MISMATCH), 'the frontier gate is told what deviated')
  assert.ok(!has(calls, 'opus-gate:a#'), 'a forced frontier gate skips the Opus gate for that link')

  // b: untouched by its predecessor's confession.
  assert.ok(has(calls, 'opus-gate:b#0'), 'the clean link keeps the cheap Opus-first gate')
  assert.ok(!has(calls, 'gate:b#'), 'the clean link never escalates')

  // The mismatch is banked for boundary triage even though the unit merged.
  assert.ok(state.debt.some((d) => d.unit === 'a' && d.kind === 'contract' && d.what.includes(MISMATCH)),
    "the link's contract mismatch reaches the wave ledger")
  assert.ok(!state.debt.some((d) => d.unit === 'b'), 'nothing leaks into the sibling link')
})

// =========================================================================================
// 8. A missing pinned branch demotes the TAIL only: the warm session stopped part-way, so the
//    finished prefix ships through its link pipeline and everything after it falls back to cold
//    dispatch. Losing the lane must never lose the links.
// =========================================================================================
test('8 missing pinned branch: the finished prefix ships, the tail demotes to cold and still merges', async () => {
  // tips reports only a — b was never pinned, so the lane cannot diff or adopt it.
  const { fn, calls } = makeAgent(liveLane('a', ['a', 'b'], { tips: { a: TIP.a } }))
  const state = await runWave(fn, makePlan([unit('a'), unit('b')], [contract('a', 'b')]), makeState())

  assert.ok(has(calls, 'chain-impl:a'), 'the warm implement call ran')
  assert.ok(!has(calls, 'plan:a'), 'the pinned link kept its warm plan')
  assert.equal(state.units.a.status, 'merged', 'the pinned prefix ships through its link pipeline')

  // b falls back to the full cold build, after a's merge (the contract edge still holds it).
  assert.ok(has(calls, 'plan:b'), 'the unpinned link is rebuilt cold')
  assert.ok(has(calls, 'impl:b'), 'the unpinned link is rebuilt cold')
  assert.ok(seqOf(calls, 'plan:b') > seqOf(calls, 'merge:a'), "the demoted tail waits for its dependency's merge")
  assert.equal(state.units.b.status, 'merged')
  assert.deepEqual(state.degradations ?? [], [], 'the demote is a fallback, not a defect')
})

// =========================================================================================
// 9. Crash residue never chains. A unit the last checkpoint left 'running' may have committed
//    work on its branch; a warm lane would rebuild its worktree from the tip and destroy it. It
//    must re-enter ordinary dispatch, where setup ADOPTS whatever it committed.
// =========================================================================================
test('9 crash residue: a `running` link is excluded from chaining and re-enters dispatch by adoption', async () => {
  // Live chain rules with no adopt-setup overrides — a lane that fired despite the residue would
  // be visible as a missing cold plan:/impl: pair.
  const { fn, calls } = makeAgent([chainPlanRule('a', ['a', 'b']), chainImplRule('a', ['a', 'b']), chainTipsRule('a', { a: TIP.a, b: TIP.b })])
  const state = await runWave(
    fn,
    makePlan([unit('a'), unit('b')], [contract('a', 'b')]),
    makeState({ wave: 1, units: { a: { status: 'running', stage: 'implement' } } }),
  )

  assert.deepEqual(laneLabels(calls), [], 'crash residue at the head kills the whole lane — no warm rebuild')
  assert.match(promptOf(calls, 'setup:a'), /adopt it as-is/,
    'the crashed unit re-enters through adoption, so committed work survives')
  assert.ok(has(calls, 'plan:a'), 'a runs the cold pipeline')
  assert.ok(has(calls, 'plan:b'), 'b runs cold too — a one-unit remainder is not a chain')
  assert.ok(seqOf(calls, 'setup:b') > seqOf(calls, 'merge:a'), 'b still waits on the contract edge')
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')
})
