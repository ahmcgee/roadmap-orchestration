// Acceptance / simulation suite for conductor.mjs — written from the FROZEN conductor
// contract and the plan file, independently of the implementation (acceptance-spec
// discipline). Runs as a zero-token control-flow simulation: the conductor is loaded under
// an AsyncFunction wrapper (./load.mjs) with scripted fakes (./fakes.mjs) standing in for
// every agent() / workflow() side effect.
//
// -------------------------------------------------------------------------------------
// RECONCILED SHAPES (Gate A rulings) — canned results match the implemented schemas:
//   * CENSUS (S_census)   → { ok, pendingUserFeedback: string[], quarantineDossiers: string[] }
//   * TRIAGE (S_triage)   → { admit[], cut[], promote[], debtLedger[], feedback[],
//       escalate: boolean, escalateReason?: enum, arcComplete: boolean, notes }
//       (needs-user question/context are SYNTHESIZED by the conductor: question ← notes)
//   * BOUNDARY (S_boundaryPlan) → { newUnits[], reviseSpecs[], cutUnits[], debtLedger[],
//       journal, escalate: boolean, escalateReason?: enum, arcComplete: boolean, notes }
//   * Quarantine routing reads state.units[id].status === 'quarantined' AND counts only
//     units that are inScope:true in the PLAN (a superseded/cut quarantine never re-forces
//     tier 3) — fixtures keep quarantined units in plan.units with inScope:true.
//   * Tier-2 admits ONLY draft ids listed in `admit` (the default-admit doctrine lives in
//     the triager's PROMPT, not the code) — any fixture whose draft must survive a tier-2
//     boundary carries an explicit admit rule (triageAdmit below).
//   * Writers (persist-plan/bank-debt/log-append/move-feedback) run on CONTINUATION
//     boundaries only; every return (early or terminal) persists via persist-state, with
//     boundary + debt handed to the root INTACT on tier-4 returns.
// The verbatim writers (persist-*/bank-*/log-*/move-*) and spec-* return the harness's
// S.ok shape ({ ok: true }).
// -------------------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { loadScript } from './load.mjs'
import { makeAgent, makeWorkflow, assertAllModelsPinned, assertCksumVerified } from './fakes.mjs'

const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))
const HARNESS_PATH = '/abs/path/to/harness.mjs'

/* ----------------------------- canned agent results ----------------------------- */
const CENSUS_EMPTY = { ok: true, pendingUserFeedback: [], quarantineDossiers: [] }
const censusQuar = (files = ['impossible-cache.md']) => ({ ok: true, pendingUserFeedback: [], quarantineDossiers: files })
const censusFeedback = (files = ['note-1.md']) => ({ ok: true, pendingUserFeedback: files, quarantineDossiers: [] })

const TRIAGE_OK = {
  escalate: false, arcComplete: false,
  admit: [], cut: [], promote: [], debtLedger: [], feedback: [], notes: '',
}
const triageEscalate = (reason, extra = {}) => ({ ...TRIAGE_OK, escalate: true, escalateReason: reason, ...extra })
// Ruling 3: tier-2 folds in ONLY the draft ids it lists in `admit`.
const triageAdmit = (ids, extra = {}) => ({ ...TRIAGE_OK, admit: ids, ...extra })

const BOUNDARY_OK = {
  escalate: false, arcComplete: false,
  newUnits: [], reviseSpecs: [], cutUnits: [], debtLedger: [], journal: '', notes: '',
}
const boundaryPlan = (o = {}) => ({ ...BOUNDARY_OK, ...o })

const OK = { ok: true }

/* ------------------------------- fixture builders ------------------------------- */
// A boundary block mimicking harness serialize(): explorer/health/flake with the shape the
// reference.md documents. `fixUnits` are health-assessor consolidation drafts; loose
// `healthFindings`/`explorerFindings`/`flips` are the judgment signals.
function boundaryBlock({ explorerFindings = [], healthFindings = [], fixUnits = [], flips = [] } = {}) {
  return {
    explorer: { findings: explorerFindings, shaObserved: 'a1b2c3d4' },
    health: { findings: healthFindings, fixUnits },
    flake: { runs: 3, flips },
  }
}

const draft = (id, acceptance = ['imports gcd from the shared module']) => ({
  id, goal: `consolidate ${id}`, files: ['src/stats.js'], acceptance,
})

// A new-unit skeleton as a boundary (Fable) agent would emit it.
const skeleton = (id, o = {}) => ({
  id, risk: 'med', goal: `build ${id}`, acceptance: ['does the thing'], ...o,
})

function mkState(o = {}) {
  return {
    integrationBranch: 'roadmap/session-2026',
    integrationTip: 'a1b2c3d4',
    consultsUsed: 0,
    spend: { fable: 0, opus: 4, sonnet: 2, haiku: 12, planChecks: 0, opusPlanChecks: 1, gateRounds: 0, opusGateRounds: 2 },
    preview: { sha: null, status: 'none' },
    debt: [],
    boundary: boundaryBlock(),
    wave: 1,
    units: { 'seed-unit': { status: 'merged' } },
    ...o,
  }
}

function mkPlan(o = {}) {
  return {
    repoPath: '/repo',
    worktreeRoot: '/wt',
    units: [{ id: 'seed-unit', title: 'seed', risk: 'med', kind: 'code', inScope: true }],
    edges: [],
    config: {},
    ...o,
  }
}

// Compose an agent rule set: caller overrides (first-match-wins) then defaults for every
// label the conductor can emit. `unmatched label throws` in makeAgent, so defaults must be
// exhaustive.
function rules({ census, triage, boundary } = {}) {
  const list = []
  if (census) list.push({ match: /^census:/, result: census })
  if (triage) list.push({ match: /^triage:/, result: triage })
  if (boundary) list.push({ match: /^boundary:/, result: boundary })
  list.push({ match: /^census:/, result: CENSUS_EMPTY })
  list.push({ match: /^triage:/, result: TRIAGE_OK })
  list.push({ match: /^boundary:/, result: BOUNDARY_OK })
  list.push({ match: /^spec-(expand|revise):/, result: OK })
  list.push({ match: /^(persist-plan|persist-state|bank-debt|log-append|move-feedback):/, result: OK })
  list.push({ match: /^skill-feedback$/, result: OK })
  return list
}

// A wave handler returning a distinct state per workflow() call. Pass explicit states; the
// last is repeated if the conductor asks for more (it should not, given our fixtures).
const waves = (...states) => (args, i) => states[Math.min(i, states.length - 1)]

/* ----------------------------------- driver ----------------------------------- */
async function conduct({
  plan = mkPlan(), state = mkState(), config = {}, harnessPath = HARNESS_PATH,
  stringify = false, agentRules = rules(), waveHandler = waves(state),
} = {}) {
  const agent = makeAgent(agentRules)
  const workflow = makeWorkflow(waveHandler)
  const run = await loadScript(CONDUCTOR)
  const argObj = { plan, state, config, harnessPath }
  const bag = {
    args: stringify ? JSON.stringify(argObj) : argObj,
    agent: agent.fn,
    workflow: workflow.fn,
    log: () => {},
    phase: () => {},
  }
  const result = await run(bag)
  return { result, agent, workflow }
}

/* -------------------------------- call helpers -------------------------------- */
const labeled = (calls, re) => calls.filter((c) => re.test(c.label))
const hasLabel = (calls, re) => calls.some((c) => re.test(c.label))
const firstLabel = (calls, re) => calls.find((c) => re.test(c.label))
const prompt = (c) => c?.prompt ?? ''

/* ============================================================================== */
/* 1. Tier-routing table                                                          */
/* ============================================================================== */
const routingRows = [
  {
    name: 'tier-1: clean boundary with only health fix-unit drafts → mechanical admit',
    plan: mkPlan(),
    state: mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
    config: {},
    agentRules: rules(),
    // wave 1 admits a draft → dispatch wave 2 (clean) → arc-complete.
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
    check({ agent, workflow }) {
      assert.equal(hasLabel(agent.calls, /^triage:/), false, 'tier-1 must not call the Opus triager')
      assert.equal(hasLabel(agent.calls, /^boundary:/), false, 'tier-1 must not call the Fable boundary agent')
      assert.equal(hasLabel(agent.calls, /^census:/), true, 'census always runs')
      assert.ok(hasLabel(agent.calls, /^spec-expand:/), 'draft materialization issues a spec-expand')
      assert.ok(hasLabel(agent.calls, /^persist-plan:/), 'persists the revised plan before dispatch')
      assert.equal(workflow.calls.length, 2, 'next wave dispatched')
      const census = firstLabel(agent.calls, /^census:/)
      assert.equal(census.model, 'haiku', 'census is haiku')
    },
  },
  {
    name: 'tier-2: explorer findings → Opus triage call',
    state: mkState({ boundary: boundaryBlock({ explorerFindings: [{ severity: 'major', summary: 'weird flow' }] }) }),
    check({ agent }) {
      const t = firstLabel(agent.calls, /^triage:w1\b/)
      assert.ok(t, 'explorer findings route to the Opus triager')
      assert.equal(t.model, 'opus', 'triage is opus')
    },
  },
  {
    name: 'tier-3: quarantine present → Fable boundary call, no triage',
    // Ruling 4: the quarantine predicate counts only units inScope:true in the PLAN.
    plan: mkPlan({
      units: [
        { id: 'seed-unit', title: 'seed', risk: 'med', kind: 'code', inScope: true },
        { id: 'impossible-cache', title: 'ic', risk: 'high', kind: 'code', inScope: true },
      ],
    }),
    state: mkState({
      boundary: boundaryBlock(),
      units: { 'seed-unit': { status: 'merged' }, 'impossible-cache': { status: 'quarantined' } },
    }),
    agentRules: rules({ census: censusQuar() }),
    check({ agent }) {
      const b = firstLabel(agent.calls, /^boundary:w1\b/)
      assert.ok(b, 'quarantine routes to the Fable boundary agent')
      assert.equal(b.model, 'fable', 'boundary is fable')
      assert.equal(hasLabel(agent.calls, /^triage:/), false, 'quarantine skips the Opus tier')
    },
  },
  {
    name: 'contract debt → immediate contract-amendment return, no triage/boundary, debt intact',
    state: mkState({ debt: [{ unit: 'seed-unit', kind: 'contract', severity: 'major', what: 'frozen surface contradicts reality', why: 'needs adjudication' }] }),
    check({ result, agent }) {
      assert.equal(result.reason, 'contract-amendment')
      assert.equal(hasLabel(agent.calls, /^triage:/), false, 'no triage before a contract early-return')
      assert.equal(hasLabel(agent.calls, /^boundary:/), false, 'no boundary before a contract early-return')
      assert.ok(Array.isArray(result.state.debt) && result.state.debt.some((d) => d.kind === 'contract'),
        'state.debt kept intact on a tier-4 return')
    },
  },
  {
    name: "boundaryTriage:'root' + judgment → root-triage return",
    state: mkState({ boundary: boundaryBlock({ explorerFindings: [{ severity: 'minor', summary: 'x' }] }) }),
    config: { conductor: { boundaryTriage: 'root' } },
    check({ result, agent }) {
      assert.equal(result.reason, 'root-triage')
      assert.equal(hasLabel(agent.calls, /^triage:/), false)
      assert.equal(hasLabel(agent.calls, /^boundary:/), false)
      assert.ok(result.state.boundary, 'boundary handed to root intact')
    },
  },
  {
    name: 'always-fable + judgment → boundary call without triage',
    state: mkState({ boundary: boundaryBlock({ explorerFindings: [{ severity: 'major', summary: 'y' }] }) }),
    config: { conductor: { boundaryTriage: 'always-fable' } },
    check({ agent }) {
      assert.ok(hasLabel(agent.calls, /^boundary:w1\b/), 'always-fable routes judgment straight to Fable')
      assert.equal(hasLabel(agent.calls, /^triage:/), false, 'Opus tier skipped under always-fable')
    },
  },
]

for (const row of routingRows) {
  test(`routing — ${row.name}`, async () => {
    const out = await conduct({
      plan: row.plan ?? mkPlan(),
      state: row.state,
      config: row.config ?? {},
      agentRules: row.agentRules ?? rules(),
      waveHandler: row.waveHandler ?? waves(row.state),
    })
    row.check(out)
  })
}

/* ============================================================================== */
/* 1b. Issue mode: issue-new caches created issue numbers back into the plan       */
/* ============================================================================== */
// A mid-arc unit (fix-unit/respec) whose issue number is NOT cached back into plan.units[].issue is
// orphaned from the arc-issue task-list rollup (the harness sweep skips unknown-number units) and
// forces a marker-search fallback in every folded clause. issue-new reports the numbers; the conductor
// must cache them so the NEXT wave's dispatch carries them.
test('issue mode: issue-new caches new-unit issue numbers into the next wave plan', async () => {
  const { agent, workflow } = await conduct({
    plan: mkPlan({ tracking: 'issues', repoSlug: 'o/r', milestone: 'roadmap: eval', trackingIssue: 5 }),
    state: mkState({ boundary: boundaryBlock({ fixUnits: [draft('my-fix')] }) }),
    agentRules: [
      { match: /^issue-new:/, result: { ok: true, opened: [{ id: 'my-fix', number: 4242 }] } },
      ...rules(),
    ],
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('my-fix')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.ok(hasLabel(agent.calls, /^issue-new:w1\b/), 'issue mode opens an issue for the new fix-unit')
  assert.equal(workflow.calls.length, 2, 'the admitted draft dispatches a second wave')
  const newUnit = workflow.calls[1].args.plan.units.find((u) => u.id === 'my-fix')
  assert.ok(newUnit, 'the new unit is carried into the next wave plan')
  assert.equal(newUnit.issue, 4242, 'issue-new cached the created issue number into unit.issue')
})

// The boundary census lists open user bug issues by the renamed `roadmap:bug` label (v0.8.6). This
// guards the rename: the census (and, by the same query, Phase-0 candidate scope) must key on
// roadmap:bug, and the retired roadmap:feedback label must not linger anywhere in the census clause.
test('issue mode: census lists open roadmap:bug issues (not the retired roadmap:feedback label)', async () => {
  const { agent } = await conduct({
    plan: mkPlan({ tracking: 'issues', repoSlug: 'o/r', milestone: 'roadmap: eval', trackingIssue: 5 }),
    state: mkState({ boundary: boundaryBlock({ fixUnits: [draft('a-fix')] }) }),
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('a-fix')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  const census = firstLabel(agent.calls, /^census:/)
  assert.ok(census, 'census runs in issue mode')
  assert.match(prompt(census), /--label roadmap:bug --state open/)
  assert.doesNotMatch(prompt(census), /roadmap:feedback/)
  // Census discipline: gh silently caps at --limit (default 30) — every census must pass an
  // explicit limit and must never trust a result equal to it (arc-observed: a 333-issue debt
  // ledger silently truncated to 100).
  assert.match(prompt(census), /--limit 1000/, 'the census passes an explicit high limit')
  assert.match(prompt(census), /EQUALS the limit/i, 'and is told a full page means truncation')
})

// Every gh listing embedded in any issue-mode prompt must carry an explicit --limit — a census-
// style listing without one silently truncates at 30. (--limit 1 marker lookups satisfy this.)
test('issue mode: every embedded `gh issue list` carries an explicit --limit', async () => {
  const { agent } = await conduct({
    plan: mkPlan({ tracking: 'issues', repoSlug: 'o/r', milestone: 'roadmap: eval', trackingIssue: 5 }),
    state: mkState({
      debt: [{ unit: 'seed-unit', kind: 'test', severity: 'minor', what: 'w', why: '' }],
      boundary: boundaryBlock({ fixUnits: [draft('a-fix')] }),
    }),
    agentRules: rules({ triage: triageAdmit(['a-fix'], { debtLedger: ['leftover'] }) }),
    waveHandler: waves(
      mkState({
        debt: [{ unit: 'seed-unit', kind: 'test', severity: 'minor', what: 'w', why: '' }],
        boundary: boundaryBlock({ fixUnits: [draft('a-fix')] }),
      }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  for (const c of agent.calls) {
    for (const m of c.prompt.matchAll(/`(gh issue list[^`]*)`/g))
      assert.match(m[1], /--limit \d+/, `unbounded listing in ${c.label}: ${m[1]}`)
  }
})

/* ============================================================================== */
/* 2. Draft → plan-unit conversion + spec-expand carries acceptance               */
/* ============================================================================== */
test('draft is materialized into an in-scope plan unit; spec-expand prompt carries acceptance', async () => {
  const acc = 'imports gcd from the shared module'
  const d = draft('consolidate-gcd', [acc])
  const { workflow, agent } = await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [d] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.equal(workflow.calls.length, 2, 'admitting a draft dispatches the next wave')
  const nextPlan = workflow.calls[1].args.plan
  const unit = nextPlan.units.find((u) => u.id === 'consolidate-gcd')
  assert.ok(unit, 'the draft appears as a plan unit in the next dispatch')
  assert.equal(unit.inScope, true, 'materialized unit is in scope')
  assert.equal(unit.kind, 'code', 'materialized unit is code-kind')
  assert.ok(['low', 'med', 'high'].includes(unit.risk), 'materialized unit carries a risk tier')

  const spec = firstLabel(agent.calls, /^spec-expand:consolidate-gcd\b/)
  assert.ok(spec, 'a spec-expand is issued for the new unit')
  assert.equal(spec.model, 'sonnet', 'spec expansion is sonnet')
  assert.ok(prompt(spec).includes(acc), 'the spec-expand prompt carries the acceptance text')
})

/* ============================================================================== */
/* 3. Persist-before-dispatch ordering (seq monotonic across fakes)               */
/* ============================================================================== */
test('all persist/bank/move writes precede the next workflow() dispatch', async () => {
  const { agent, workflow } = await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.equal(workflow.calls.length, 2)
  const dispatchSeq = workflow.calls[1].seq
  for (const re of [/^persist-plan:w1\b/, /^persist-state:w1\b/, /^bank-debt:w1\b/, /^move-feedback:w1\b/]) {
    const c = firstLabel(agent.calls, re)
    if (c) assert.ok(c.seq < dispatchSeq, `${c.label} (seq ${c.seq}) must precede dispatch (seq ${dispatchSeq})`)
  }
  // persist-plan and persist-state are non-optional on a continuation.
  assert.ok(firstLabel(agent.calls, /^persist-plan:w1\b/), 'persist-plan present')
  assert.ok(firstLabel(agent.calls, /^persist-state:w1\b/), 'persist-state present')
})

/* ============================================================================== */
/* 4. maxWavesPerRun cap                                                           */
/* ============================================================================== */
test('maxWavesPerRun:2 with an always-fresh draft caps at 2 waves and returns max-waves', async () => {
  const { result, workflow } = await conduct({
    config: { conductor: { maxWavesPerRun: 2 } },
    // Each wave yields a brand-new draft id → tier-1 keeps admitting → keeps wanting more.
    waveHandler: (args, i) => mkState({ wave: i + 1, boundary: boundaryBlock({ fixUnits: [draft(`fix-w${i + 1}`)] }) }),
  })
  assert.equal(workflow.calls.length, 2, 'exactly two waves dispatched')
  assert.equal(result.reason, 'max-waves')
  assert.equal(result.wavesRun, 2)
  assert.equal(result.status, 'conductor-return')
  assert.equal(result.wave, 2)
  assert.ok(result.state && result.plan, 'envelope carries state + plan')

  // Ruling 1: a TERMINAL return hands the final wave's boundary evidence to the root. max-waves is
  // terminal, but it is the only terminal return the conductor cannot see coming — every other path
  // returns before the persist step, while this one becomes terminal only after the loop has already
  // triaged the wave and cleared its boundary as a continuation. Eval-observed 2026-07-19: a 3-wave
  // run returned max-waves with no boundary at all, leaving the relaunching root nothing to read.
  assert.ok(result.state.boundary, 'max-waves must hand the final boundary back, not swallow it')
  assert.equal(result.state.boundary.triaged, true,
    'and must mark it triaged — unlike a true terminal boundary this evidence was already ' +
    'dispositioned, so a root that re-actions it duplicates the ladder')
  assert.equal(result.state.boundary.wave, 2, 'the boundary names the wave it came from')
})

/* ============================================================================== */
/* 5. Agent-budget guard fires BEFORE the second dispatch                          */
/* ============================================================================== */
test('agent-budget guard fires before wave 2 when the arc-cumulative spend is high', async () => {
  // spend sums to ~900; 900 + 8 + units*15 + 200 reserve > 1000 → guard trips pre-dispatch.
  const heavySpend = { fable: 80, opus: 450, sonnet: 70, haiku: 300, planChecks: 0, opusPlanChecks: 0, gateRounds: 0, opusGateRounds: 0 }
  const bigPlan = mkPlan({
    units: [
      { id: 'seed-unit', title: 's', risk: 'med', kind: 'code', inScope: true },
      { id: 'u2', title: 'u2', risk: 'med', kind: 'code', inScope: true },
      { id: 'u3', title: 'u3', risk: 'med', kind: 'code', inScope: true },
    ],
  })
  const { result, workflow } = await conduct({
    plan: bigPlan,
    waveHandler: (args, i) => mkState({
      wave: i + 1,
      spend: heavySpend,
      boundary: boundaryBlock({ fixUnits: [draft(`fix-w${i + 1}`)] }),
      units: { 'seed-unit': { status: 'merged' }, u2: { status: 'pending' }, u3: { status: 'pending' } },
    }),
  })
  assert.equal(workflow.calls.length, 1, 'guard blocks the second workflow() call')
  assert.equal(result.reason, 'agent-budget')
  assert.ok(typeof result.nextWaveUnits !== 'undefined', 'brief carries nextWaveUnits')
  assert.ok(typeof result.estimate !== 'undefined', 'brief carries estimate')
})

/* ============================================================================== */
/* 6. Early-return shape matrix — one per reason                                   */
/* ============================================================================== */
const BASE_KEYS = ['status', 'reason', 'wave', 'wavesRun', 'state', 'plan']

const returnRows = [
  {
    name: 'contingent-replan',
    reason: 'contingent-replan',
    briefKey: 'edges',
    plan: mkPlan({
      units: [
        { id: 'a', title: 'a', risk: 'med', kind: 'code', inScope: true },
        { id: 'b', title: 'b', risk: 'med', kind: 'code', inScope: false },
      ],
      edges: [{ from: 'a', to: 'b', type: 'semantic', mode: 'contingent' }],
    }),
    state: mkState({ units: { a: { status: 'merged' }, b: { status: 'deferred' } } }),
  },
  {
    name: 'contract-amendment',
    reason: 'contract-amendment',
    briefKey: 'debt',
    state: mkState({ debt: [{ unit: 'seed-unit', kind: 'contract', severity: 'major', what: 'mismatch', why: 'adjudicate' }] }),
  },
  {
    name: 'needs-user (tier-2 escalation)',
    reason: 'needs-user',
    briefKeys: ['question', 'context'],
    state: mkState({ boundary: boundaryBlock({ explorerFindings: [{ severity: 'major', summary: 'z' }] }) }),
    // The conductor synthesizes the brief's `question` from the triager's `notes`.
    agentRules: rules({ triage: triageEscalate('needs-user', { notes: 'Ship A or B?' }) }),
  },
  {
    name: 'arc-complete (empty boundary yield)',
    reason: 'arc-complete',
    briefKey: 'arcSummary',
    state: mkState({ boundary: boundaryBlock() }),
  },
  {
    name: 'max-waves',
    reason: 'max-waves',
    config: { conductor: { maxWavesPerRun: 1 } },
    waveHandler: (args, i) => mkState({ wave: i + 1, boundary: boundaryBlock({ fixUnits: [draft(`fix-w${i + 1}`)] }) }),
  },
  {
    name: 'agent-budget',
    reason: 'agent-budget',
    briefKeys: ['nextWaveUnits', 'estimate'],
    waveHandler: (args, i) => mkState({
      wave: i + 1,
      spend: { fable: 100, opus: 500, sonnet: 100, haiku: 200 },
      boundary: boundaryBlock({ fixUnits: [draft(`fix-w${i + 1}`)] }),
    }),
  },
  {
    name: 'boundary-degraded (boundary block absent, enabled, no quarantine)',
    reason: 'boundary-degraded',
    // No boundary block on the returned state, config boundary on (default), census empty.
    state: mkState({ boundary: undefined }),
  },
  {
    name: 'root-triage',
    reason: 'root-triage',
    config: { conductor: { boundaryTriage: 'root' } },
    state: mkState({ boundary: boundaryBlock({ healthFindings: [{ area: 'structure', what: 'drift' }] }) }),
  },
]

for (const row of returnRows) {
  test(`early-return shape — ${row.name}`, async () => {
    const state = row.state ?? mkState()
    const { result } = await conduct({
      plan: row.plan ?? mkPlan(),
      state,
      config: row.config ?? {},
      agentRules: row.agentRules ?? rules(),
      waveHandler: row.waveHandler ?? waves(state),
    })
    assert.equal(result.status, 'conductor-return')
    assert.equal(result.reason, row.reason)
    for (const k of BASE_KEYS) assert.ok(k in result, `envelope has ${k}`)
    if (row.briefKey) assert.ok(row.briefKey in result, `brief has ${row.briefKey}`)
    for (const k of row.briefKeys ?? []) assert.ok(k in result, `brief has ${k}`)
  })
}

/* ============================================================================== */
/* 7. Boundary config passthrough + post-hoc arc-complete                          */
/* ============================================================================== */
test('caller config is passed to every workflow() call verbatim, never boundary:off', async () => {
  const callerConfig = { gateEffort: 'high' }
  const { workflow } = await conduct({
    config: callerConfig,
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.ok(workflow.calls.length >= 1)
  for (const c of workflow.calls) {
    assert.deepStrictEqual(c.args.config, { gateEffort: 'high' }, 'config passed through unmutated')
    assert.notEqual(c.args.config.boundary, 'off', 'conductor never injects boundary:off')
  }
})

test('post-hoc arc-complete: boundary ran but yielded nothing → arc-complete, boundary intact', async () => {
  const { result, workflow } = await conduct({ state: mkState({ boundary: boundaryBlock() }) })
  assert.equal(result.reason, 'arc-complete')
  assert.equal(workflow.calls.length, 1, 'no further wave dispatched')
  assert.ok(result.state.boundary, 'the final boundary block is handed to the root untriaged')
})

/* ============================================================================== */
/* 8. Contract-write bar — no writer ever targets .roadmap/contracts/             */
/* ============================================================================== */
test('no persist/bank/log/move/spec prompt names .roadmap/contracts/ as a write target', async () => {
  const runs = []
  // tier-1 continuation
  runs.push(await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  }))
  // tier-2
  runs.push(await conduct({
    state: mkState({ boundary: boundaryBlock({ explorerFindings: [{ severity: 'major', summary: 'x' }] }) }),
  }))
  // tier-3 respec (ruling 4: the quarantined unit must be inScope:true in the plan)
  runs.push(await conduct({
    plan: mkPlan({
      units: [
        { id: 'seed-unit', title: 's', risk: 'med', kind: 'code', inScope: true },
        { id: 'impossible-cache', title: 'ic', risk: 'high', kind: 'code', inScope: true },
      ],
    }),
    state: mkState({
      boundary: boundaryBlock(),
      units: { 'seed-unit': { status: 'merged' }, 'impossible-cache': { status: 'quarantined' } },
    }),
    agentRules: rules({
      census: censusQuar(),
      boundary: boundaryPlan({ newUnits: [skeleton('cache-v2', { supersedes: 'impossible-cache' })], journal: 'why' }),
    }),
    waveHandler: waves(
      mkState({ boundary: boundaryBlock(), units: { 'seed-unit': { status: 'merged' }, 'impossible-cache': { status: 'quarantined' } } }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  }))

  const writerLabel = /^(persist-plan|persist-state|bank-debt|log-append|move-feedback|spec-expand|spec-revise):/
  for (const { agent } of runs) {
    for (const c of labeled(agent.calls, writerLabel)) {
      assert.ok(!prompt(c).includes('.roadmap/contracts/'),
        `${c.label} must not name .roadmap/contracts/ as a write target`)
    }
  }
})

/* ============================================================================== */
/* 9. Architect-log appended only when tier-3 ran                                  */
/* ============================================================================== */
test('tier-3 boundary journal is appended under a ## Wave 1 header', async () => {
  const { agent } = await conduct({
    // Ruling 4: the quarantined unit must be present AND inScope:true in the plan for
    // the quarantine predicate to force tier 3.
    plan: mkPlan({
      units: [
        { id: 'seed-unit', title: 's', risk: 'med', kind: 'code', inScope: true },
        { id: 'impossible-cache', title: 'ic', risk: 'high', kind: 'code', inScope: true },
      ],
    }),
    state: mkState({
      boundary: boundaryBlock(),
      units: { 'seed-unit': { status: 'merged' }, 'impossible-cache': { status: 'quarantined' } },
    }),
    agentRules: rules({
      census: censusQuar(),
      boundary: boundaryPlan({ newUnits: [skeleton('fix-quar')], journal: 'rationale' }),
    }),
    waveHandler: waves(
      mkState({ boundary: boundaryBlock(), units: { 'seed-unit': { status: 'merged' }, 'impossible-cache': { status: 'quarantined' } } }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  const log = firstLabel(agent.calls, /^log-append:w1\b/)
  assert.ok(log, 'tier-3 appends the architect log')
  assert.equal(log.model, 'haiku', 'the log writer is haiku')
  assert.ok(prompt(log).includes('rationale'), 'journal text is carried into the append')
  assert.ok(prompt(log).includes('## Wave 1'), 'append uses a ## Wave N header')
})

test('clean tier-1 boundary never appends the architect log', async () => {
  const { agent } = await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.equal(hasLabel(agent.calls, /^log-append:/), false, 'no tier-3 ⇒ no architect-log append')
})

/* ============================================================================== */
/* 10. Debt stamped every boundary; not re-banked next wave                        */
/* ============================================================================== */
test('debt.md is stamped on an empty-debt continuation boundary with a wave-1 marker', async () => {
  // Ruling 5: writers run on CONTINUATION boundaries only, so the empty-debt stamp needs a
  // boundary that dispatches wave 2 — a tier-1 draft admit is the cheapest continuation.
  const { agent } = await conduct({
    waveHandler: waves(
      mkState({ debt: [], boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  const bank = firstLabel(agent.calls, /^bank-debt:w1\b/)
  assert.ok(bank, 'bank-debt fires even with an empty ledger')
  assert.match(prompt(bank), /wave[\s-]*1\b/i, 'the append carries a wave-1 marker')
})

test('debt item text appears in bank-debt:w1 and is not re-sent at wave 2', async () => {
  const marker = 'DEBT_ONE_MARKER'
  // Wave-1 non-contract debt routes the boundary to tier 2 (debt counts as judgment), so
  // the draft only survives via an explicit admit (ruling 3). Wave 2 carries a fresh draft
  // (no debt → tier 1 auto-admit) so ITS boundary is also a continuation and bank-debt:w2
  // actually fires; maxWavesPerRun:2 ends the run at max-waves after that.
  const { agent } = await conduct({
    config: { conductor: { maxWavesPerRun: 2 } },
    agentRules: rules({ triage: triageAdmit(['consolidate-gcd']) }),
    waveHandler: waves(
      mkState({
        debt: [{ unit: 'seed-unit', kind: 'quality', severity: 'minor', what: marker, why: 'later' }],
        boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }),
      }),
      mkState({ wave: 2, debt: [], boundary: boundaryBlock({ fixUnits: [draft('fix-w2')] }) }),
    ),
  })
  const bank1 = firstLabel(agent.calls, /^bank-debt:w1\b/)
  assert.ok(bank1 && prompt(bank1).includes(marker), 'wave-1 debt text is banked')
  const bank2 = firstLabel(agent.calls, /^bank-debt:w2\b/)
  assert.ok(bank2, 'wave 2 is a continuation boundary, so its stamp fires too')
  assert.ok(!prompt(bank2).includes(marker), 'wave-1 debt is not re-banked at wave 2')
})

// Issue mode mints ONE consolidated roadmap:debt issue per unit-with-residue, keyed wave+unit
// (arc-observed: one-issue-per-finding produced 650+ issues; index-keyed markers duplicated on a
// reordered resume). The ledger gets a single wave-level issue.
const CONSOLIDATION_DEBT = () => [
  { unit: 'u1', kind: 'test', severity: 'minor', what: 'W1_THIN_TEST', why: '' },
  { unit: 'u1', kind: 'structure', severity: 'major', what: 'W2_DUP_HELPER', why: '' },
  { unit: 'u2', kind: 'test', severity: 'minor', what: 'W3_WEAK_ASSERT', why: '' },
]
const consolidationConduct = (debtItems) => conduct({
  plan: mkPlan({ tracking: 'issues', repoSlug: 'o/r', milestone: 'roadmap: eval', trackingIssue: 5 }),
  state: mkState({ debt: debtItems, boundary: boundaryBlock({ fixUnits: [draft('a-fix')] }) }),
  agentRules: [
    { match: /^issue-new:/, result: { ok: true, opened: [] } },
    ...rules({ triage: triageAdmit(['a-fix'], { debtLedger: ['LEDGE_LEFTOVER'] }) }),
  ],
  waveHandler: waves(
    mkState({ debt: debtItems, boundary: boundaryBlock({ fixUnits: [draft('a-fix')] }) }),
    mkState({ wave: 2, boundary: boundaryBlock() }),
  ),
})

test('issue mode: bank-debt consolidates one issue per unit-residue plus one ledger issue', async () => {
  const { agent } = await consolidationConduct(CONSOLIDATION_DEBT())
  const bank = firstLabel(agent.calls, /^bank-debt:w1\b/)
  assert.ok(bank, 'bank-debt fires')
  const p = prompt(bank)
  assert.ok(p.includes('roadmap:debt wave=1 unit=u1'), 'u1 residue keyed wave+unit')
  assert.ok(p.includes('roadmap:debt wave=1 unit=u2'), 'u2 residue keyed wave+unit')
  assert.ok(p.includes('roadmap:debt wave=1 ledger'), 'triage-ledger leftovers get one wave issue')
  assert.doesNotMatch(p, /wave=1 (i|L)=\d/, 'index-keyed markers are gone')

  const items = JSON.parse(p.slice(p.indexOf('Items:\n') + 'Items:\n'.length, p.lastIndexOf('\nReport ok:true')))
  assert.equal(items.length, 3, 'three issues, not four findings')
  const u1 = items.find((i) => i.marker.endsWith('unit=u1'))
  assert.ok(u1.labels.includes('severity:major'), 'a mixed group takes the max severity')
  assert.ok(u1.labels.includes('debt:test') && u1.labels.includes('debt:structure'), 'one kind facet per distinct kind')
  assert.ok(u1.body.includes('W1_THIN_TEST') && u1.body.includes('W2_DUP_HELPER'), 'both findings in the one body')
  assert.ok(items.find((i) => i.marker.endsWith('ledger')).body.includes('LEDGE_LEFTOVER'))
})

test('issue mode: consolidation markers are stable under a reordered debt array (resume-safe)', async () => {
  const markersOf = ({ agent }) => {
    const p = prompt(firstLabel(agent.calls, /^bank-debt:w1\b/))
    return JSON.parse(p.slice(p.indexOf('Items:\n') + 'Items:\n'.length, p.lastIndexOf('\nReport ok:true')))
      .map((i) => i.marker).sort()
  }
  const forward = markersOf(await consolidationConduct(CONSOLIDATION_DEBT()))
  const reversed = markersOf(await consolidationConduct(CONSOLIDATION_DEBT().reverse()))
  assert.deepStrictEqual(reversed, forward, 'the marker set is a function of stable ids, not array order')
})

// A promoted skeleton's `closes` list must survive the mergePlan whitelist into the next wave's
// plan (the push drops unlisted fields), and the triage prompt teaches the field in issue mode
// only — file mode stays byte-identical.
test('issue mode: a promoted skeleton\'s `closes` survives into the next wave plan', async () => {
  const { agent, workflow } = await conduct({
    plan: mkPlan({ tracking: 'issues', repoSlug: 'o/r', milestone: 'roadmap: eval', trackingIssue: 5 }),
    state: mkState({
      debt: [{ unit: 'seed-unit', kind: 'test', severity: 'minor', what: 'w', why: '' }],
      boundary: boundaryBlock(),
    }),
    agentRules: [
      { match: /^issue-new:/, result: { ok: true, opened: [{ id: 'debt-sweep', number: 77 }] } },
      ...rules({ triage: { ...TRIAGE_OK, promote: [skeleton('debt-sweep', { closes: [7, 8] })] } }),
    ],
    waveHandler: waves(
      mkState({ debt: [{ unit: 'seed-unit', kind: 'test', severity: 'minor', what: 'w', why: '' }], boundary: boundaryBlock() }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  const triage = firstLabel(agent.calls, /^triage:w1\b/)
  assert.match(prompt(triage), /`closes`/, 'issue-mode triage prompt teaches the closes field')
  assert.equal(workflow.calls.length, 2, 'the promoted unit dispatches a second wave')
  const promoted = workflow.calls[1].args.plan.units.find((u) => u.id === 'debt-sweep')
  assert.ok(promoted, 'promoted skeleton lands in the next plan')
  assert.deepStrictEqual(promoted.closes, [7, 8], 'closes survives the whitelist push')
})

test('file mode: the triage prompt never mentions the closes field', async () => {
  const { agent } = await conduct({
    state: mkState({
      debt: [{ unit: 'seed-unit', kind: 'test', severity: 'minor', what: 'w', why: '' }],
      boundary: boundaryBlock({ fixUnits: [draft('a-fix')] }),
    }),
    agentRules: rules({ triage: triageAdmit(['a-fix']) }),
    waveHandler: waves(
      mkState({ debt: [{ unit: 'seed-unit', kind: 'test', severity: 'minor', what: 'w', why: '' }], boundary: boundaryBlock({ fixUnits: [draft('a-fix')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.doesNotMatch(prompt(firstLabel(agent.calls, /^triage:w1\b/)), /closes/,
    'file-mode triage prompt is byte-identical to legacy')
})

/* ============================================================================== */
/* 11. Feedback move to triaged/<wave>/                                            */
/* ============================================================================== */
test('user feedback reported by census is moved to feedback/triaged/1/', async () => {
  // Pending user feedback is a judgment signal → tier 2; the draft survives only via an
  // explicit admit (ruling 3), and the consumed note is named by a triage disposition.
  const { agent } = await conduct({
    agentRules: rules({
      census: censusFeedback(['note-1.md']),
      triage: triageAdmit(['consolidate-gcd'], { feedback: [{ file: 'note-1.md', action: 'actioned' }] }),
    }),
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  const mv = firstLabel(agent.calls, /^move-feedback:w1\b/)
  assert.ok(mv, 'consumed feedback triggers a move')
  assert.equal(mv.model, 'haiku', 'the mover is haiku')
  assert.ok(prompt(mv).includes('triaged/1'), 'feedback moves under feedback/triaged/1/')
  assert.ok(prompt(mv).includes('note-1.md'), 'the consumed user note is named in the move')
})

/* ============================================================================== */
/* 12. State threaded verbatim wave→wave (minus consumed boundary/debt)            */
/* ============================================================================== */
test('the returned state is threaded to the next wave, boundary/debt consumed', async () => {
  // Non-contract debt routes this boundary to tier 2, so the draft needs an explicit admit
  // (ruling 3). The conductor folds its OWN agent tally into spend.{fable,opus,sonnet,haiku}
  // before re-dispatch, so the untouched-passthrough sentinel is a harness-only counter
  // (opusGateRounds) plus run.runId; the model tallies are asserted as lower bounds.
  const wave1 = mkState({
    wave: 1,
    run: { runId: 'r1', scriptPath: HARNESS_PATH },
    spend: { fable: 0, opus: 7, sonnet: 2, haiku: 5, opusGateRounds: 9 },
    debt: [{ unit: 'seed-unit', kind: 'quality', severity: 'minor', what: 'noted', why: '' }],
    boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }),
  })
  const { workflow } = await conduct({
    agentRules: rules({ triage: triageAdmit(['consolidate-gcd']) }),
    waveHandler: waves(wave1, mkState({ wave: 2, boundary: boundaryBlock() })),
  })
  assert.equal(workflow.calls.length, 2)
  const threaded = workflow.calls[1].args.state
  assert.equal(threaded.wave, 1, 'the wave cursor is passed forward for the harness to bump')
  assert.equal(threaded.run.runId, 'r1', 'run identity preserved')
  assert.equal(threaded.spend.opusGateRounds, 9, 'harness-only spend counters pass through untouched')
  assert.ok(threaded.spend.opus >= 7, 'arc-cumulative spend preserved (conductor may add its own tally)')
  assert.ok(!threaded.boundary, 'consumed boundary removed before re-dispatch')
  assert.deepStrictEqual(threaded.debt, [], 'consumed debt cleared before re-dispatch')
})

// The harness now returns prior+wave degradations (arc-cumulative); the conductor must absorb
// only the delta past what it dispatched — seeding from inState AND pushing the full returned
// array would double-count every prior entry at each wave.
test('degradations absorb the wave delta only — no duplication across waves', async () => {
  const SEED = { script: 'harness', wave: 1, label: 'old:x', model: 'haiku', kind: 'no-report', what: 'seeded' }
  const NEW = { script: 'harness', wave: 2, label: 'codex-build:y', model: 'haiku', kind: 'threw', what: 'fresh' }
  const { result } = await conduct({
    state: mkState({
      degradations: [SEED],
      boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }),
    }),
    agentRules: rules({ triage: triageAdmit(['consolidate-gcd']) }),
    // Mimic the fixed harness contract: wave 1 returns cumulative (dispatched + its own new
    // entry); wave 2 returns its cumulative input untouched (a clean wave).
    waveHandler: (args, i) => (i === 0
      ? mkState({ wave: 1, boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }),
          degradations: [...(args.state.degradations ?? []), NEW] })
      : mkState({ wave: 2, boundary: boundaryBlock(),
          degradations: args.state.degradations ?? [] })),
  })
  assert.deepStrictEqual(result.degradations, [SEED, NEW],
    'exactly seed + delta, each once — neither dropped nor double-counted')
})

// skill-feedback.md carries hand-written sections alongside the rendered degradations; the
// writer must replace ONLY its marker-delimited region, never the whole file (arc-observed:
// a full-file overwrite destroyed a user's design-feedback section mid-run).
test('skill-feedback writes only its marker region, preserving the rest of the file', async () => {
  const { agent } = await conduct({
    state: mkState({ degradations: [{ script: 'harness', wave: 1, label: 'codex-build:x', model: 'haiku', kind: 'no-report', what: 'MARKER_WHAT' }] }),
  })
  const sf = firstLabel(agent.calls, /^skill-feedback$/)
  assert.ok(sf, 'a degradation-carrying run writes skill-feedback')
  assert.equal(sf.model, 'haiku')
  assert.ok(sf.prompt.includes('<!-- roadmap:degradations -->'), 'opening marker present')
  assert.ok(sf.prompt.includes('<!-- /roadmap:degradations -->'), 'closing marker present')
  assert.ok(sf.prompt.includes('MARKER_WHAT'), 'the rendered entry is in the region')
  assert.match(sf.prompt, /replace ONLY the lines between/, 'replace-region instruction present')
  assert.ok(!/Overwrite the file [^\n]*skill-feedback\.md with exactly/.test(sf.prompt),
    'the clobbering whole-file form is gone')
})

test('a clean run never writes skill-feedback', async () => {
  const { agent } = await conduct()
  assert.equal(hasLabel(agent.calls, /^skill-feedback$/), false, 'no degradations -> no write')
})

/* ============================================================================== */
/* 13. Respec via supersedes never reuses a failed id                              */
/* ============================================================================== */
test('a supersedes respec adds a new id, quarantines the old, and repoints its edges', async () => {
  const { workflow } = await conduct({
    plan: mkPlan({
      units: [
        { id: 'seed-unit', title: 's', risk: 'med', kind: 'code', inScope: true },
        // Ruling 4: still in scope — an UNRESOLVED quarantine (that is what forces tier 3).
        { id: 'impossible-cache', title: 'ic', risk: 'high', kind: 'code', inScope: true },
        { id: 'consumer', title: 'c', risk: 'med', kind: 'code', inScope: true },
      ],
      edges: [{ from: 'impossible-cache', to: 'consumer', type: 'semantic', mode: 'contract' }],
    }),
    state: mkState({
      boundary: boundaryBlock(),
      units: { 'seed-unit': { status: 'merged' }, 'impossible-cache': { status: 'quarantined' }, consumer: { status: 'deferred' } },
    }),
    agentRules: rules({
      census: censusQuar(),
      boundary: boundaryPlan({ newUnits: [skeleton('cache-v2', { supersedes: 'impossible-cache' })], journal: 'respec rationale' }),
    }),
    waveHandler: waves(
      mkState({ boundary: boundaryBlock(), units: { 'seed-unit': { status: 'merged' }, 'impossible-cache': { status: 'quarantined' }, consumer: { status: 'deferred' } } }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.equal(workflow.calls.length, 2, 'the respec dispatches a follow-up wave')
  const nextPlan = workflow.calls[1].args.plan

  const fresh = nextPlan.units.find((u) => u.id === 'cache-v2')
  assert.ok(fresh, 'the respec unit is present under its NEW id')
  assert.equal(fresh.inScope, true, 'the respec unit is in scope')
  assert.notEqual(fresh.id, 'impossible-cache', 'the new id is not the failed one')

  const old = nextPlan.units.find((u) => u.id === 'impossible-cache')
  assert.ok(old, 'the superseded unit remains in the plan')
  assert.equal(old.inScope, false, 'the superseded unit stays out of scope')

  const edge = nextPlan.edges.find((e) => e.to === 'consumer')
  assert.ok(edge, 'the dependent edge survives')
  assert.equal(edge.from, 'cache-v2', 'edges from the failed unit are repointed to the respec')
})

/* ============================================================================== */
/* 14. Persisted `conductor` block                                                 */
/* ============================================================================== */
test('tier-4 return persists a conductor block (reason + boundaries) before returning', async () => {
  const { agent } = await conduct({
    state: mkState({ debt: [{ unit: 'seed-unit', kind: 'contract', severity: 'major', what: 'mismatch', why: 'adjudicate' }] }),
  })
  const ps = firstLabel(agent.calls, /^persist-state:w1\b/)
  assert.ok(ps, 'a persist-state precedes the tier-4 return')
  const p = prompt(ps)
  assert.ok(p.includes('"conductor"'), 'the persisted JSON carries a conductor block')
  assert.ok(p.includes('contract-amendment'), 'the conductor block records the return reason')
  assert.ok(p.includes('"boundaries"'), 'the conductor block carries a boundaries array')
})

test('a tier-1 continuation persists state with boundary removed and debt cleared', async () => {
  const { agent } = await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  const ps = firstLabel(agent.calls, /^persist-state:w1\b/)
  assert.ok(ps, 'continuation persists state')
  const p = prompt(ps)
  assert.ok(!p.includes('"boundary"'), 'the consumed boundary block is stripped from the persisted state')
  assert.match(p, /"debt"\s*:\s*\[\s*\]/, 'consumed debt is persisted as an empty array')
})

// A large state fans out exactly as the harness checkpoint does (shared-consts pins the two
// executors byte-identical; this pins the conductor actually ROUTING through it): one STRICT-
// prefixed Haiku writer per `.partK`, then one assembler under the same top-level label.
test('persist-state of a large state fans out to part writers + one assembler, STRICT-prefixed', async () => {
  const units = Object.fromEntries(Array.from({ length: 400 }, (_, i) =>
    [`old-${i}`, { status: 'merged', reason: `synthetic terminal record ${'x'.repeat(200)} #${i}` }]))
  const { agent } = await conduct({ state: mkState({ units }) })
  assert.ok(!hasLabel(agent.calls, /^persist-state:w1$/), 'no single agent is handed the whole document')
  const writers = labeled(agent.calls, /^persist-state:w1:part\d+$/)
  const asm = labeled(agent.calls, /^persist-state:w1:assemble$/)
  assert.ok(writers.length >= 3, `several part writers (saw ${writers.length})`)
  assert.equal(asm.length, 1, 'exactly one assembler')
  assert.ok(asm[0].seq > Math.max(...writers.map((w) => w.seq)), 'the assembler is dispatched after every writer')
  for (const c of [...writers, asm[0]]) {
    assert.ok(c.prompt.startsWith('Start by `cd`'), `${c.label} carries the STRICT location discipline`)
    assert.equal(c.model, 'haiku')
  }
  const bodies = writers.map((w, k) => {
    const file = `/repo/.roadmap/state.json.part${k + 1}`
    assert.ok(w.prompt.includes(`cat > ${file} <<'ROADMAP_PART'`), `writer ${k + 1} targets its own part file`)
    assert.ok(w.prompt.length <= 24000 + 1500, `writer ${k + 1} stays near the chunk bound (${w.prompt.length})`)
    const marker = `<<<PART ${k + 1}/${writers.length}>>>\n`
    const body = w.prompt.slice(w.prompt.indexOf(marker) + marker.length)
    assertCksumVerified(w.prompt, file, `${body}\n`, `writer ${k + 1}`)
    return body
  })
  assert.ok(asm[0].prompt.includes(`cat ${writers.map((_, k) => `/repo/.roadmap/state.json.part${k + 1}`).join(' ')} > /repo/.roadmap/state.json`),
    'the assembler cats the parts in order')
  assertCksumVerified(asm[0].prompt, '/repo/.roadmap/state.json', `${bodies.join('\n')}\n`, 'the assembler')
  assert.ok(asm[0].prompt.includes('On success run `rm -f /repo/.roadmap/state.json.part*`'), 'the assembler clears parts by glob')
})

test('persist-state of a small state: one STRICT-prefixed here-doc writer, cksum-verified', async () => {
  const { agent } = await conduct()
  const ps = labeled(agent.calls, /^persist-state:w1$/)
  assert.equal(ps.length, 1, 'one single writer, no fan-out')
  assert.ok(!hasLabel(agent.calls, /^persist-state:w1:/), 'no part writers or assembler')
  const p = ps[0].prompt
  assert.ok(p.startsWith('Start by `cd`'), 'STRICT-prefixed')
  assert.ok(p.includes(`cat > /repo/.roadmap/state.json <<'ROADMAP_PART'`), 'written through a quoted here-doc')
  const marker = '<<<DOCUMENT>>>\n'
  const body = p.slice(p.indexOf(marker) + marker.length)
  JSON.parse(body)
  assertCksumVerified(p, '/repo/.roadmap/state.json', `${body}\n`, 'the persist-state writer')
})

test('persist-state: a part lost twice is retried once, then skips the assembler and ledgers write-failed', async () => {
  const units = Object.fromEntries(Array.from({ length: 400 }, (_, i) =>
    [`old-${i}`, { status: 'merged', reason: `synthetic terminal record ${'x'.repeat(200)} #${i}` }]))
  const { agent, result } = await conduct({
    state: mkState({ units }),
    agentRules: [
      { match: /^persist-state:w1:part1$/, result: { ok: false, detail: 'wc printed 9' } },
      { match: /^persist-state:w1:part1#retry$/, result: { ok: false, detail: 'cksum printed 9 24071' } },
      ...rules(),
    ],
  })
  const retries = labeled(agent.calls, /#retry$/)
  assert.deepEqual(retries.map((c) => c.label), ['persist-state:w1:part1#retry'], 'the lost part is retried once, by a fresh agent, and nothing else is')
  assert.ok(retries[0].prompt.startsWith('Start by `cd`'), 'the retry carries the STRICT prefix like every writer')
  assert.ok(!hasLabel(agent.calls, /^persist-state:w1:assemble$/), 'no assembler after a part lost twice')
  const d = result.degradations.find((x) => x.label === 'persist-state:w1' && x.kind === 'write-failed')
  assert.ok(d, 'the loss is ledgered under the top-level persist label')
  assert.match(d.what, /part 1\/\d+: cksum printed 9 24071/, 'the failed part is named with the retry\'s reason')
  assert.ok(!d.what.includes('wc printed 9'), 'the first attempt\'s reason is superseded')
})

test('persist-state: a part lost once is recovered by its retry — assembler runs, nothing ledgered', async () => {
  const units = Object.fromEntries(Array.from({ length: 400 }, (_, i) =>
    [`old-${i}`, { status: 'merged', reason: `synthetic terminal record ${'x'.repeat(200)} #${i}` }]))
  const { agent, result } = await conduct({
    state: mkState({ units }),
    agentRules: [{ match: /^persist-state:w1:part1$/, result: { ok: false, detail: 'cksum printed 9 24071' } }, ...rules()],
  })
  const writers = labeled(agent.calls, /^persist-state:w1:part\d+$/)
  const retries = labeled(agent.calls, /#retry$/)
  const asm = labeled(agent.calls, /^persist-state:w1:assemble$/)
  assert.deepEqual(retries.map((c) => c.label), ['persist-state:w1:part1#retry'], 'only the lost part is retried, once')
  assert.equal(retries[0].prompt, writers[0].prompt, 'the retry is handed the identical part prompt')
  assert.ok(retries[0].seq > Math.max(...writers.map((w) => w.seq)), 'the retry follows the first pass')
  assert.equal(asm.length, 1, 'the assembler runs once the retry lands')
  assert.ok(asm[0].seq > retries[0].seq, 'and follows the retry')
  assert.ok(!result.degradations.some((x) => x.kind === 'write-failed'), 'a recovered part is not a degradation')
  assert.equal(labeled(agent.calls, /^persist-state:w1/).length, writers.length + 2, 'spend: n writers + 1 retry + 1 assembler')
})

/* ============================================================================== */
/* 15. Hygiene                                                                     */
/* ============================================================================== */
test('stringified args produce identical routing to object args', async () => {
  const state = mkState({ boundary: boundaryBlock() })  // empty boundary → arc-complete
  const asObj = await conduct({ state, stringify: false, waveHandler: waves(state) })
  const asStr = await conduct({ state, stringify: true, waveHandler: waves(state) })
  assert.equal(asStr.result.reason, asObj.result.reason)
  assert.equal(asStr.result.status, 'conductor-return')
})

test('missing harnessPath is rejected', async () => {
  const run = await loadScript(CONDUCTOR)
  const agent = makeAgent(rules())
  const workflow = makeWorkflow(waves(mkState()))
  await assert.rejects(async () => run({
    args: { plan: mkPlan(), state: mkState(), config: {} },   // no harnessPath
    agent: agent.fn, workflow: workflow.fn, log: () => {}, phase: () => {},
  }))
})

test('every agent call pins its model', async () => {
  const { agent } = await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assertAllModelsPinned(agent.calls)
})

test('the conductor opens exactly one workflow nesting level (always the harness)', async () => {
  const { workflow } = await conduct({
    waveHandler: (args, i) => mkState({ wave: i + 1, boundary: boundaryBlock({ fixUnits: [draft(`fix-w${i + 1}`)] }) }),
    config: { conductor: { maxWavesPerRun: 3 } },
  })
  assert.ok(workflow.calls.length >= 1)
  for (const c of workflow.calls) {
    assert.equal(c.scriptPath, HARNESS_PATH, 'every workflow() call targets the harness, never another workflow script')
  }
})

/* --------------------- arc-completeness is status-aware ---------------------- */
// Arc-completeness read only what the boundary agents EMITTED — never unit statuses — and
// arcSummary buckets merged/quarantined/deferred, so pending/running/blocked in-scope units were
// invisible to the tier that declared the arc done. 2026-07-18: tier-2 called arc-complete with
// four in-scope, satisfiable units outstanding; only the root caught it.
const unitOf = (id, o = {}) => ({ id, title: id, risk: 'low', kind: 'code', inScope: true, ...o })

test('arc-complete is refused while in-scope dispatchable work remains -> arc-stalled', async () => {
  const plan = mkPlan({ units: [unitOf('seed-unit'), unitOf('leftover')] })
  const state = mkState({ units: { 'seed-unit': { status: 'merged' } } })   // leftover: no record = pending
  const { result } = await conduct({ plan, state, waveHandler: waves(state) })

  assert.equal(result.reason, 'arc-stalled', 'a satisfiable in-scope unit must block the close')
  assert.deepEqual(result.outstanding, ['leftover'])
})

test('arc-stalled does NOT livelock on work wedged behind an unresolved quarantine', async () => {
  // `wedged` depends on a quarantined unit that was never respecced: it can never reach a terminal
  // state, so refusing on it would burn a paid boundary on every relaunch, forever. It must be
  // reported as `stuck` and let the arc close.
  const plan = mkPlan({
    units: [unitOf('seed-unit'), unitOf('dead'), unitOf('wedged')],
    edges: [{ from: 'dead', to: 'wedged', type: 'semantic', mode: 'contract' }],
  })
  const state = mkState({ units: { 'seed-unit': { status: 'merged' }, dead: { status: 'quarantined' } } })
  const { result } = await conduct({ plan, state, waveHandler: waves(state) })

  assert.equal(result.reason, 'arc-complete', 'unreachable work must not hold the arc open forever')
  assert.deepEqual(result.stuck, ['wedged'], 'but it must be named, never silently dropped')
})

test('a fully merged arc still closes as arc-complete', async () => {
  const plan = mkPlan({ units: [unitOf('seed-unit')] })
  const state = mkState({ units: { 'seed-unit': { status: 'merged' } } })
  const { result } = await conduct({ plan, state, waveHandler: waves(state) })
  assert.equal(result.reason, 'arc-complete')
})
