// Zero-token simulation of the conductor's ADMISSIONS brake, the draft de-duplicator, and the
// shared-red finding channel.
//
// The arc's termination guarantee has always been "debt must never CREATE a wave". Drafts were
// never covered by it: explorer/health/design drafts are findings, not debt, so a healthy assessor
// drafting something every wave grew the denominator forever — observed at ~93% merged for 12+
// hours after the architect had already logged PLAN DRAINED. `conductor.admissions: 'closed'`
// closes that hole in CODE (every other brake here is prose a frontier turn can rationalise past):
//
//   1. under `closed`, tiers 1 and 2 mint nothing — `admit` AND `promote` alike become debt lines;
//   2. the one exception is a finding graded `blocker`, which routes to the architect tier to be
//      RULED on rather than auto-admitted — closed admissions never route work away from judgment,
//      they only stop judgment minting units;
//   3. `tier1MaxDrafts` bounds the mechanical tier, so a BATCH of drafts buys the cut line;
//   4. a draft filed twice in one batch is DROPPED, not renamed into a second unit;
//   5. a shared red arrives as a FINDING, never as debt — a debt item would reopen the hole.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { loadScript } from '../../script-loader.mjs'
import { makeAgent, makeWorkflow, packRules, launchPackOf, assertAllModelsPinned, courierOk } from './fakes.mjs'

const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))
const HARNESS_PATH = '/abs/path/to/harness.mjs'

const CENSUS_EMPTY = { ok: true, pendingUserFeedback: [], quarantineDossiers: [] }
const TRIAGE_OK = { escalate: false, arcComplete: false, admit: [], cut: [], promote: [], debtLedger: [], feedback: [], notes: '' }
const triage = (o = {}) => ({ ...TRIAGE_OK, ...o })
const BOUNDARY_OK = { escalate: false, arcComplete: false, newUnits: [], reviseSpecs: [], cutUnits: [], debtLedger: [], journal: '', notes: '' }
const boundaryPlan = (o = {}) => ({ ...BOUNDARY_OK, ...o })
const OK = { ok: true }

const draft = (id) => ({ id, goal: `consolidate ${id}`, files: ['src/stats.js'], acceptance: ['imports gcd'] })
const skeleton = (id, o = {}) => ({ id, risk: 'med', goal: `build ${id}`, acceptance: ['does the thing'], ...o })

function emptyBoundary() {
  return { explorer: { findings: [], shaObserved: 'a1b2c3d4' }, health: { findings: [], fixUnits: [] }, flake: { runs: 3, flips: [] } }
}
const withDrafts = (...ids) => {
  const b = emptyBoundary()
  b.health.fixUnits = ids.map(draft)
  return b
}
const withFindings = (...findings) => {
  const b = emptyBoundary()
  b.explorer.findings = findings
  return b
}

function mkState(o = {}) {
  return {
    integrationBranch: 'roadmap/session-2026', integrationTip: 'a1b2c3d4', consultsUsed: 0,
    spend: { fable: 0, opus: 4, sonnet: 2, haiku: 12 },
    preview: { sha: null, status: 'none' }, debt: [], boundary: emptyBoundary(),
    wave: 1, units: { 'seed-unit': { status: 'merged' } }, ...o,
  }
}
function mkPlan(o = {}) {
  return {
    repoPath: '/repo', worktreeRoot: '/wt',
    units: [{ id: 'seed-unit', title: 'seed', risk: 'med', kind: 'code', inScope: true }],
    edges: [], config: {}, ...o,
  }
}

function rules({ census, triage: tr, boundary } = {}) {
  const list = []
  if (census) list.push({ match: /^census:/, result: census })
  if (tr) list.push({ match: /^triage:/, result: tr })
  if (boundary) list.push({ match: /^boundary:/, result: boundary })
  list.push({ match: /^census:/, result: CENSUS_EMPTY })
  list.push({ match: /^triage:/, result: TRIAGE_OK })
  list.push({ match: /^boundary:/, result: BOUNDARY_OK })
  list.push({ match: /^bank-debt:/, result: OK })
  list.push({ match: /^move-feedback:/, result: courierOk })
  return list
}

const waves = (...states) => (args, i) => states[Math.min(i, states.length - 1)]

async function conduct({ plan = mkPlan(), state = mkState(), config = {}, agentRules = rules(), waveHandler } = {}) {
  const roadmapDir = `${plan.repoPath}/.roadmap`
  const agent = makeAgent([...packRules(plan, state), ...agentRules])
  // The launch pack arrives through workflow() (0.18.0) — no courier transcribes it.
  const workflow = makeWorkflow(waveHandler ?? waves(state), { pack: launchPackOf(plan, state, 'sim-launch') })
  const run = await loadScript(CONDUCTOR)
  const result = await run({
    args: { roadmapDir, launchId: 'sim-launch', config, harnessPath: HARNESS_PATH, pack: `${roadmapDir}/launch/pack-sim-launch.mjs` },
    agent: agent.fn, workflow: workflow.fn, log: () => {}, phase: () => {},
  })
  return { result, agent, workflow }
}

const hasLabel = (calls, re) => calls.some((c) => re.test(c.label))
const firstLabel = (calls, re) => calls.find((c) => re.test(c.label))
const promptOf = (calls, re) => firstLabel(calls, re)?.prompt ?? ''
const closed = { conductor: { admissions: 'closed' } }

/* ============================================================================== */
/* 1. admissions: 'closed' admits nothing at tier 1                                */
/* ============================================================================== */
test('control: with admissions open, tier 1 admits its drafts mechanically', async () => {
  const st = mkState({ boundary: withDrafts('consolidate-gcd') })
  const { agent } = await conduct({ state: st, waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })) })
  assert.ok(hasLabel(agent.calls, /^spec-expand:consolidate-gcd\b/), 'the draft becomes a unit')
})

test('closed: tier 1 mints nothing, banks the draft, and the arc closes', async () => {
  const st = mkState({ boundary: withDrafts('consolidate-gcd') })
  const { result, agent, workflow } = await conduct({ state: st, config: closed, waveHandler: waves(st) })
  assert.equal(hasLabel(agent.calls, /^spec-expand:/), false, 'no spec is written — nothing was admitted')
  assert.equal(workflow.calls.length, 1, 'and no second wave is dispatched')
  assert.equal(result.reason, 'arc-complete', 'the boundary yields nothing new, so the arc closes')
  const banked = (result.state.debt ?? []).filter((d) => typeof d === 'string' && d.includes('consolidate-gcd'))
  assert.equal(banked.length, 1, 'the draft is banked, not dropped')
  assert.match(banked[0], /admissions closed/, 'and the line says why it was not admitted')
})

/* ============================================================================== */
/* 2. closed covers `promote`, not just `admit`                                    */
/* ============================================================================== */
test('closed: tier 2 banks BOTH admitted drafts and promoted skeletons', async () => {
  // Explorer findings force tier 2. Without covering `promote`, an explorer finding walks straight
  // through the brake as a triager-authored unit.
  const st = mkState({ boundary: { ...withDrafts('consolidate-gcd'), explorer: { findings: [{ severity: 'major', summary: 'sluggish list' }], shaObserved: 'a1b2c3d4' } } })
  const { result, agent } = await conduct({
    state: st, config: closed, waveHandler: waves(st),
    agentRules: rules({ triage: triage({ admit: ['consolidate-gcd'], promote: [skeleton('fix-sluggish-list')], arcComplete: false }) }),
  })
  assert.ok(hasLabel(agent.calls, /^triage:w1\b/), 'the tier still runs — closed admissions do not skip judgment')
  assert.equal(hasLabel(agent.calls, /^spec-expand:/), false, 'but nothing it decided becomes a unit')
  const debt = (result.state.debt ?? []).filter((d) => typeof d === 'string')
  assert.ok(debt.some((d) => d.includes('consolidate-gcd')), 'the admitted draft is banked')
  assert.ok(debt.some((d) => d.includes('fix-sluggish-list')), 'and so is the promoted skeleton')
  assert.equal(result.reason, 'arc-complete')
})

test('closed: the tier-2 prompt says admissions are closed, and says so only when they are', async () => {
  const st = mkState({ boundary: withFindings({ severity: 'major', summary: 'sluggish list' }) })
  const { agent } = await conduct({ state: st, config: closed, waveHandler: waves(st) })
  assert.match(promptOf(agent.calls, /^triage:/), /ADMISSIONS ARE CLOSED/, 'the triager is told, so it banks with reasons rather than arguing')
  const open = await conduct({ state: st, waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })) })
  assert.ok(!/ADMISSIONS ARE CLOSED/.test(promptOf(open.agent.calls, /^triage:/)),
    'and the open path stays byte-identical to the legacy prompt')
})

/* ============================================================================== */
/* 3. the blocker exception routes UP, it does not admit                           */
/* ============================================================================== */
test('closed: a blocker-graded finding routes the wave to the architect tier', async () => {
  const st = mkState({ boundary: withFindings({ severity: 'blocker', summary: 'checkout drops the cart' }) })
  const { agent } = await conduct({
    state: st, config: closed, waveHandler: waves(st),
    agentRules: rules({ boundary: boundaryPlan({ escalate: false, newUnits: [] }) }),
  })
  const b = firstLabel(agent.calls, /^boundary:w1\b/)
  assert.ok(b, 'a blocker is ruled on, never banked away')
  assert.equal(b.model, 'fable', 'by the architect tier')
  assert.equal(hasLabel(agent.calls, /^triage:/), false, 'and directly — the Opus tier cannot admit it either')
  assertAllModelsPinned(agent.calls)
})

test('closed: tier 3 may still mint the unit a blocker needs', async () => {
  const st = mkState({ boundary: withFindings({ severity: 'blocker', summary: 'checkout drops the cart' }) })
  const { agent } = await conduct({
    state: st, config: closed,
    waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })),
    agentRules: rules({ boundary: boundaryPlan({ newUnits: [skeleton('fix-cart-drop')] }) }),
  })
  assert.ok(hasLabel(agent.calls, /^spec-expand:fix-cart-drop\b/),
    'the exception is real — the architect tier is not gagged, only the mechanical tiers are')
})

test('control: a blocker finding with admissions OPEN is ordinary tier-2 judgment', async () => {
  const st = mkState({ boundary: withFindings({ severity: 'blocker', summary: 'checkout drops the cart' }) })
  const { agent } = await conduct({ state: st, waveHandler: waves(st) })
  assert.ok(hasLabel(agent.calls, /^triage:w1\b/), 'severity alone does not buy the Fable tier when admissions are open')
  assert.equal(hasLabel(agent.calls, /^boundary:/), false)
})

/* ============================================================================== */
/* 4. tier1MaxDrafts bounds the mechanical tier                                    */
/* ============================================================================== */
test('a batch of drafts past tier1MaxDrafts buys an Opus triage instead of a mechanical admit', async () => {
  const st = mkState({ boundary: withDrafts('d1', 'd2', 'd3', 'd4') })
  const { agent } = await conduct({
    state: st, waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })),
    agentRules: rules({ triage: triage({ admit: ['d1'] }) }),
  })
  assert.ok(hasLabel(agent.calls, /^triage:w1\b/), 'four drafts is a batch — the cut line must actually be applied to it')
  assert.ok(hasLabel(agent.calls, /^spec-expand:d1\b/), 'and only what the triager admitted becomes a unit')
  assert.equal(hasLabel(agent.calls, /^spec-expand:d4\b/), false, 'the rest are cut, not admitted mechanically')
})

test('control: a trickle of drafts still takes the free mechanical tier', async () => {
  const st = mkState({ boundary: withDrafts('d1', 'd2', 'd3') })
  const { agent } = await conduct({ state: st, waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })) })
  assert.equal(hasLabel(agent.calls, /^triage:/), false, 'three drafts is a trickle — no frontier tokens')
  assert.ok(hasLabel(agent.calls, /^spec-expand:d3\b/), 'admitted mechanically as before')
})

/* ============================================================================== */
/* 5. duplicate drafts collapse                                                    */
/* ============================================================================== */
test('a draft filed twice in one batch becomes ONE unit, and the drop is ledgered', async () => {
  const st = mkState({ boundary: emptyBoundary(), units: { 'seed-unit': { status: 'quarantined' } } })
  const { result, agent } = await conduct({
    state: st, waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })),
    agentRules: rules({ boundary: boundaryPlan({ newUnits: [skeleton('fit-sort-poll-test-timers'), skeleton('fit-sort-poll-test-timers')] }) }),
  })
  const expands = agent.calls.filter((c) => /^spec-expand:/.test(c.label))
  assert.equal(expands.length, 1, 'the repeat is dropped, never renamed to fit-sort-poll-test-timers-2')
  assert.equal(expands[0].label, 'spec-expand:fit-sort-poll-test-timers')
  const d = (result.degradations ?? []).find((x) => x.kind === 'duplicate-draft')
  assert.ok(d, 'a boundary filing the same draft twice is the orchestrator misbehaving — it is ledgered')
  assert.match(d.what, /fit-sort-poll-test-timers/, 'and the row names it')
})

test('a supersedes respec is NOT a duplicate — it keeps the fresh-id path', async () => {
  const st = mkState({ boundary: emptyBoundary(), units: { 'seed-unit': { status: 'quarantined' } } })
  const { result, agent } = await conduct({
    state: st, waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })),
    agentRules: rules({ boundary: boundaryPlan({ newUnits: [skeleton('seed-unit', { supersedes: 'seed-unit' })] }) }),
  })
  assert.ok(agent.calls.some((c) => /^spec-expand:seed-unit-r1\b/.test(c.label)),
    'a respec of a quarantined id is renamed, as before — dedupe must not eat it')
  assert.equal((result.degradations ?? []).filter((x) => x.kind === 'duplicate-draft').length, 0)
})

/* ============================================================================== */
/* 6. shared reds arrive as findings, never as debt                                */
/* ============================================================================== */
test('a shared red reaches triage as a finding, and forces judgment on an otherwise dry boundary', async () => {
  const st = mkState({
    boundary: emptyBoundary(),
    sharedReds: [{ spec: 'e2e/calendar-smoke.spec.ts', units: ['alpha', 'beta', 'gamma'], wave: 1 }],
  })
  const { result, agent } = await conduct({ state: st, waveHandler: waves(st) })
  const t = firstLabel(agent.calls, /^triage:w1\b/)
  assert.ok(t, 'a shared red is judgment — a dry boundary must not close the arc over it unexamined')
  assert.ok(t.prompt.includes('e2e/calendar-smoke.spec.ts'), 'the triager sees the spec')
  assert.ok(t.prompt.includes('shared-red'), 'tagged, so it is not read as three separate unit defects')
  assert.match(t.prompt, /never respec a unit over it/, 'and is told the units it failed are not the problem')
  // The whole point: it must not become debt, or "debt never creates a wave" stops being a brake
  // it can be routed around.
  const debt = result.state.debt ?? []
  assert.equal(debt.filter((d) => JSON.stringify(d).includes('calendar-smoke')).length, 0,
    'a shared red is never banked as a debt item')
})

test('control: no sharedReds means no shared-red text anywhere in the triage prompt', async () => {
  const st = mkState({ boundary: withFindings({ severity: 'minor', summary: 'x' }) })
  const { agent } = await conduct({ state: st, waveHandler: waves(st) })
  assert.ok(!/shared-red/.test(promptOf(agent.calls, /^triage:/)), 'the clause is absent, keeping the legacy prompt byte-identical')
})
