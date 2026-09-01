// Acceptance / simulation suite for conductor.mjs — written from the FROZEN conductor
// contract and the plan file, independently of the implementation (acceptance-spec
// discipline). Runs as a zero-token control-flow simulation: the conductor is loaded under
// an AsyncFunction wrapper (../../script-loader.mjs) with scripted fakes (./fakes.mjs) standing in for
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
//   * The conductor WRITES NOTHING under .roadmap/. What a boundary decides — the merged
//     plan, the consumed state, the debt.md section, the architect-log section, both event
//     ledgers — rides home in the RETURN envelope, and persist.mjs puts it on disk. What is
//     still an agent call is what a model must actually DO: spec-expand, move-feedback, and
//     the issue-mode gh projections (issue-new / bank-debt).
//   * Staging (spec-expand / gh projection) runs on CONTINUATION boundaries and on every
//     escalating return; boundary + debt reach the root INTACT on tier-4 returns.
// spec-* and move-feedback return the harness's S.ok shape ({ ok: true }).
// -------------------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { loadScript } from '../../script-loader.mjs'
import { makeAgent, makeWorkflow, packRules, assertAllModelsPinned } from './fakes.mjs'

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
  // bank-debt now reports which markers it CONFIRMED. The happy-path fake confirms every marker it
  // was handed (parsed out of the prompt's own item list); tests probing the clearing rule override
  // with a partial list. File mode names no markers, and reads `ok` alone.
  list.push({ match: /^bank-debt:/, result: (prompt) => ({ ok: true,
    banked: [...prompt.matchAll(/"marker":"([^"]+)"/g)].map((m, i) => ({ marker: m[1], number: 100 + i })) }) })
  list.push({ match: /^move-feedback:/, result: OK })
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
  // The plan and state reach the script through the LAUNCH PACK, not through args: the envelope
  // names the directory and a Haiku courier reads it. packRules is what makes that read succeed.
  const agent = makeAgent([...packRules(plan, state), ...agentRules])
  const workflow = makeWorkflow(waveHandler)
  const run = await loadScript(CONDUCTOR)
  const logs = []
  const argObj = { roadmapDir: `${plan.repoPath}/.roadmap`, launchId: 'sim-launch', config, harnessPath }
  const bag = {
    args: stringify ? JSON.stringify(argObj) : argObj,
    agent: agent.fn,
    workflow: workflow.fn,
    // The conductor's crash-recovery record is a tagged `log` line, not a paid write: persist.mjs
    // keeps the last one it sees, so a continuation boundary's decisions survive a later crash.
    log: (line) => logs.push(String(line ?? '')),
    phase: () => {},
  }
  const result = await run(bag)
  return { result, agent, workflow, snapshots: logs
    .filter((l) => l.startsWith('ROADMAP-SNAPSHOT '))
    .map((l) => JSON.parse(l.slice('ROADMAP-SNAPSHOT '.length))) }
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
      assert.ok(hasLabel(agent.calls, /^move-feedback:/), 'the consumed boundary is archived before dispatch')
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
test('a boundary stages its decisions before the next workflow() dispatch', async () => {
  const { agent, workflow, snapshots } = await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.equal(workflow.calls.length, 2)
  const dispatchSeq = workflow.calls[1].seq
  for (const re of [/^spec-expand:consolidate-gcd\b/, /^move-feedback:w1\b/]) {
    const c = firstLabel(agent.calls, re)
    assert.ok(c, `${re} must run before the next dispatch`)
    assert.ok(c.seq < dispatchSeq, `${c.label} (seq ${c.seq}) must precede dispatch (seq ${dispatchSeq})`)
  }
  // The consumed state is snapshotted at the boundary, so a crash in wave 2 still lands wave 1's
  // decisions when persist.mjs replays the run.
  assert.ok(snapshots.some((sn) => sn.wave === 1 && sn.conductor),
    'the continuation boundary leaves a crash-recovery snapshot')
  // And nothing writes: the plan the root gets back is the envelope's, not a file the run authored.
  for (const c of agent.calls)
    assert.ok(!/^(persist-|plan-ids|skill-degradations|log-append|sidecar)/.test(c.label),
      `${c.label}: the scripts no longer pay a model to write .roadmap/`)
})

/* ============================================================================== */
/* 3b. Debt: on disk at receipt, cleared only when the banker confirms it          */
/* ============================================================================== */
// state.debt used to be the ONLY copy, and `consumed.debt = []` ran BEFORE the bank call with its
// result never inspected — 23 items vanished at one live wave-12 boundary. Two independent fixes:
// the raw ledger reaches .roadmap/debt.json the moment it arrives, and nothing is cleared that the
// banker did not name.
test('wave debt joins the run ledger on receipt and rides every return', async () => {
  const debt = [{ unit: 'seed-unit', kind: 'structure', severity: 'minor', what: 'DEBT-ONE', why: 'w' }]
  const state = mkState({ debt, boundary: boundaryBlock() })
  const { result } = await conduct({ state, waveHandler: waves(state) })
  assert.deepStrictEqual(result.debt, debt,
    "the wave's debt is on the envelope verbatim — persist.mjs writes it to .roadmap/debt.json")
})

test('a clean wave carries no debt', async () => {
  const { result } = await conduct()
  assert.deepStrictEqual(result.debt, [], 'no debt -> an empty ledger, not a missing one')
})

test('issue mode: only the markers the banker CONFIRMED are cleared; the rest ride forward', async () => {
  const keep = { unit: 'u1', kind: 'structure', severity: 'minor', what: 'KEEP-ME', why: 'w' }
  const gone = { unit: 'u2', kind: 'test', severity: 'minor', what: 'BANKED-OK', why: 'w' }
  const cont = boundaryBlock({ fixUnits: [draft('consolidate-gcd')] })
  const { agent, workflow, result } = await conduct({
    plan: mkPlan({ tracking: 'issues', repoSlug: 'o/r', trackingIssue: 5 }),
    state: mkState({ debt: [keep, gone], boundary: cont }),
    agentRules: [
      // The banker confirms u2's marker only — u1's is missing from `banked`. The marker is
      // arc-keyed, so it must match the plan's trackingIssue exactly to count as confirmed.
      { match: /^bank-debt:w1$/, result: { ok: true, banked: [{ marker: 'roadmap:debt arc=5 wave=1 unit=u2', number: 7 }] } },
      { match: /^issue-new:/, result: { ok: true, opened: [] } },
      ...rules({ triage: triageAdmit(['consolidate-gcd']) }),
    ],
    waveHandler: waves(
      mkState({ debt: [keep, gone], boundary: cont }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.equal(workflow.calls.length, 2, 'the admitted draft dispatches a second wave')
  assert.deepStrictEqual(workflow.calls[1].args.state.debt, [keep],
    'the unconfirmed item survives in state.debt; the confirmed one is cleared')
  assert.ok(result.degradations.some((d) => d.kind === 'debt-unbanked'), 'and the shortfall is loud')
  const bank2 = firstLabel(agent.calls, /^bank-debt:w2\b/)
  assert.ok(!bank2 || prompt(bank2).includes('KEEP-ME'), 'the carried item is re-banked next wave')
  assert.ok(!bank2 || !prompt(bank2).includes('BANKED-OK'), 'the banked one is not carried')
})

test('file mode: the wave-1 debt.md section is COLLECTED, not written, and the ledger clears', async () => {
  const d = { unit: 'u1', kind: 'structure', severity: 'minor', what: 'KEEP-ME', why: 'w' }
  const cont = boundaryBlock({ fixUnits: [draft('consolidate-gcd')] })
  const { agent, workflow, result } = await conduct({
    state: mkState({ debt: [d], boundary: cont }),
    agentRules: rules({ triage: triageAdmit(['consolidate-gcd']) }),
    waveHandler: waves(mkState({ debt: [d], boundary: cont }), mkState({ wave: 2, boundary: boundaryBlock() })),
  })
  assert.equal(hasLabel(agent.calls, /^bank-debt:/), false, 'file mode pays no banker — the section is data')
  const sec = (result.debtSections ?? []).find((x) => x.wave === 1)
  assert.ok(sec && sec.body.includes('KEEP-ME'), 'the wave-1 section carries the item, for persist.mjs to upsert')
  assert.deepStrictEqual(workflow.calls[1].args.state.debt, [],
    'and the ledger clears: a deterministic writer cannot half-land a section, so nothing stays unbanked')
  assert.equal(result.degradations.some((x) => x.kind === 'debt-unbanked'), false)
})

/* ============================================================================== */
/* 3c. The merged plan rides the envelope; nothing here overwrites plan.json       */
/* ============================================================================== */
// The overwrite is wholesale, so a plan.json carrying a root-added unit would be destroyed with no
// trace. The refusal now lives in persist.mjs, which can simply READ the file — no courier, no
// model, no chance of a dead reporter making the check "not run". What this script owes the root is
// the merged plan itself.
test('a continuation returns the merged plan and issues no plan writer or courier', async () => {
  const { agent, result } = await conduct({
    state: mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.equal(hasLabel(agent.calls, /^(plan-ids|persist-plan):/), false,
    'no courier reads plan.json and no writer overwrites it')
  assert.ok(result.plan.units.some((u) => u.id === 'consolidate-gcd'),
    'the admitted draft is in the plan the root (and persist.mjs) gets back')
})

/* ============================================================================== */
/* 3d. Escalating returns stage their work before handing back                    */
/* ============================================================================== */
// A tier-3 needs-user return used to fire before spec-expand, mergePlan and the debt/journal
// collection, so the boundary's new-unit skeletons, the wave's debt ledger and the architect's
// rationale existed only in the run's journal.jsonl. An escalating return is a HANDOFF, not an abort.
test('a tier-3 needs-user return stages specs, plan, debt and journal before returning', async () => {
  const debt = [{ unit: 'seed-unit', kind: 'structure', severity: 'minor', what: 'DEBT-ONE', why: 'w' }]
  const quarState = () => mkState({
    debt, boundary: boundaryBlock(),
    units: { 'seed-unit': { status: 'merged' }, 'impossible-cache': { status: 'quarantined' } },
  })
  const { agent, result } = await conduct({
    plan: mkPlan({ units: [
      { id: 'seed-unit', title: 's', risk: 'med', kind: 'code', inScope: true },
      { id: 'impossible-cache', title: 'ic', risk: 'high', kind: 'code', inScope: true },
    ] }),
    state: quarState(),
    agentRules: rules({
      census: censusQuar(),
      boundary: boundaryPlan({
        escalate: true, escalateReason: 'needs-user',
        newUnits: [skeleton('cache-v2', { supersedes: 'impossible-cache' })],
        debtLedger: ['LEDGER-ITEM'], journal: 'JOURNAL-TEXT', notes: 'Ship A or B?',
      }),
    }),
    waveHandler: waves(quarState()),
  })
  assert.equal(result.reason, 'needs-user')
  assert.ok(hasLabel(agent.calls, /^spec-expand:cache-v2\b/), 'the respec gets its spec before the handoff')
  const sec = (result.debtSections ?? []).find((x) => x.wave === 1)
  assert.ok(sec && sec.body.includes('LEDGER-ITEM'), 'the triage ledger is banked into the wave-1 debt section')
  assert.ok(sec.body.includes('DEBT-ONE'), 'alongside the wave\'s own items')
  assert.deepStrictEqual(result.journalEntries, [{ wave: 1, journal: 'JOURNAL-TEXT' }], 'the journal survives')
  assert.ok(result.plan.units.some((u) => u.id === 'cache-v2'), 'and the respec is in the plan the root gets back')
})

test('a tier-2 needs-user escalation stages the drafts it admitted', async () => {
  const st = () => mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')],
    explorerFindings: [{ severity: 'major', summary: 'z' }] }) })
  const { agent, result } = await conduct({
    state: st(),
    agentRules: rules({ triage: triageEscalate('needs-user', { admit: ['consolidate-gcd'], notes: 'A or B?' }) }),
    waveHandler: waves(st()),
  })
  assert.equal(result.reason, 'needs-user')
  assert.ok(hasLabel(agent.calls, /^spec-expand:consolidate-gcd\b/), 'the admitted draft gets its spec')
  assert.ok(result.plan.units.some((u) => u.id === 'consolidate-gcd'), 'and the plan carrying it reaches the root')
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

  const writerLabel = /^(bank-debt|move-feedback|spec-expand|spec-revise):/
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
test('tier-3 boundary journal rides the envelope as a wave-1 entry', async () => {
  const { result } = await conduct({
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
  assert.deepStrictEqual(result.journalEntries, [{ wave: 1, journal: 'rationale' }],
    'the journal TEXT is judgment; putting it under a `## Wave 1` header is persist.mjs\'s transcription')
})

test('clean tier-1 boundary never appends the architect log', async () => {
  const { agent, result } = await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.equal(hasLabel(agent.calls, /^log-append:/), false, 'no tier-3 ⇒ no architect-log writer at all')
  assert.deepStrictEqual(result.journalEntries, [], 'and no journal entry to transcribe')
})

/* ============================================================================== */
/* 10. Debt stamped every boundary; not re-banked next wave                        */
/* ============================================================================== */
test('an empty-debt continuation boundary still stamps a wave-1 debt section', async () => {
  // Ruling 5: staging runs on CONTINUATION boundaries only, so the empty-debt stamp needs a
  // boundary that dispatches wave 2 — a tier-1 draft admit is the cheapest continuation.
  const { result } = await conduct({
    waveHandler: waves(
      mkState({ debt: [], boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  assert.deepStrictEqual(result.debtSections, [{ wave: 1, body: 'wave 1: no new entries' }],
    'the section is stamped even when there is nothing to say (ruling 7)')
})

test('debt item text lands in the wave-1 section and is not re-sent at wave 2', async () => {
  const marker = 'DEBT_ONE_MARKER'
  // Wave-1 non-contract debt routes the boundary to tier 2 (debt counts as judgment), so
  // the draft only survives via an explicit admit (ruling 3). Wave 2 carries a fresh draft
  // (no debt → tier 1 auto-admit) so ITS boundary is also a continuation and stamps too;
  // maxWavesPerRun:2 ends the run at max-waves after that.
  const { result } = await conduct({
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
  const [s1, s2] = result.debtSections
  assert.ok(s1.wave === 1 && s1.body.includes(marker), 'wave-1 debt text is in the wave-1 section')
  assert.ok(s2 && s2.wave === 2, 'wave 2 is a continuation boundary, so its section is stamped too')
  assert.ok(!s2.body.includes(marker), 'wave-1 debt is not re-stamped at wave 2')
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
  // ARC-keyed: `wave=1 ledger` alone matched a PREVIOUS arc's wave 1 and would have skipped
  // creation silently (skill-feedback 2026-08-22); the per-unit marker collides the same way
  // whenever a unit id recurs across arcs. The arc key is trackingIssue (else milestone).
  assert.ok(p.includes('roadmap:debt arc=5 wave=1 unit=u1'), 'u1 residue keyed arc+wave+unit')
  assert.ok(p.includes('roadmap:debt arc=5 wave=1 unit=u2'), 'u2 residue keyed arc+wave+unit')
  assert.ok(p.includes('roadmap:debt arc=5 wave=1 ledger'), 'the triage ledger is arc-keyed too')
  assert.doesNotMatch(p, /wave=1 (i|L)=\d/, 'index-keyed markers are gone')
  assert.doesNotMatch(p, /marker": "roadmap:debt wave=/, 'no arc-free marker survives anywhere')

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
// The harness returns THIS WAVE's degradations in its envelope only (its serialize() carries none).
// The conductor absorbs them in memory and must NEVER thread a ledger back into the state — that
// arc-cumulative re-transcription is exactly what made every write bigger than the last.
test('degradations absorb each wave once and never re-enter the threaded state', async () => {
  const W1 = { script: 'harness', wave: 1, label: 'codex-build:x', model: 'haiku', kind: 'threw', what: 'first' }
  const W2 = { script: 'harness', wave: 2, label: 'codex-build:y', model: 'haiku', kind: 'threw', what: 'second' }
  const { result, agent, workflow } = await conduct({
    state: mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
    agentRules: rules({ triage: triageAdmit(['consolidate-gcd']) }),
    waveHandler: (args, i) => (i === 0
      ? mkState({ wave: 1, boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }), degradations: [W1] })
      : mkState({ wave: 2, boundary: boundaryBlock(), degradations: [W2] })),
  })
  assert.deepStrictEqual(result.degradations, [W1, W2], 'each wave absorbed once, in order')
  for (const c of workflow.calls)
    assert.equal(c.args.state.degradations, undefined, 'no ledger is ever threaded into the next dispatch')
  assert.equal(result.state.degradations, undefined, 'and the returned state carries none either')
})

// skill-feedback.md is HUMAN-owned and the orchestrator must not be able to reach it. It used to
// carry a machine-rewritten marker region beside hand-written sections, and twice the growing region
// ate the entry above it. The machine half is now `.roadmap/skill-degradations.md`, rendered by
// persist.mjs from the returned rows — so no agent can reach either file.
test('no agent can write skill-feedback.md, and the rows reach the root in the envelope', async () => {
  const { agent, result } = await conduct({
    waveHandler: waves(mkState({
      boundary: boundaryBlock(),
      degradations: [
        { script: 'harness', wave: 1, label: 'codex-build:x', model: 'haiku', kind: 'no-report', what: 'MARKER_WHAT' },
        { script: 'harness', wave: 1, label: 'codex-build:y', model: 'haiku', kind: 'no-report', what: 'another' },
        { script: 'harness', wave: 1, label: 'gate:z', model: 'opus', kind: 'threw', what: 'lost' },
      ],
    })),
  })
  for (const c of agent.calls)
    assert.ok(!c.prompt.includes('skill-feedback.md: ') && !/(write|edit|append|replace)[^.]{0,80}skill-feedback\.md/i.test(c.prompt),
      `${c.label} must not be able to write skill-feedback.md`)
  assert.equal(hasLabel(agent.calls, /^skill-degradations$/), false, 'no model renders the machine summary any more')
  assert.equal(result.degradations.length, 3, 'the rows reach the root — and persist.mjs — in the envelope')
})

// The conductor's OWN degradations take the same route as the harness's: in memory, then out on
// the envelope.
test('a conductor degradation rides the envelope', async () => {
  const { result } = await conduct({
    // A census that dies twice: runOr ledgers `no-report`, then `salvage-failed`.
    agentRules: [{ match: /^census:/, result: null }, ...rules()],
  })
  assert.ok(result.degradations.some((d) => d.script === 'conductor' && d.kind === 'no-report'),
    'the full row is on the envelope, not a truncated rendering')
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
test('a tier-4 return carries a conductor block (reason + boundaries) on the envelope', async () => {
  const { result } = await conduct({
    state: mkState({ debt: [{ unit: 'seed-unit', kind: 'contract', severity: 'major', what: 'mismatch', why: 'adjudicate' }] }),
  })
  assert.equal(result.reason, 'contract-amendment')
  assert.equal(result.state.conductor.reason, 'contract-amendment', 'the block records the return reason')
  assert.ok(Array.isArray(result.state.conductor.boundaries), 'and carries a boundaries array')
})

test('a tier-1 continuation snapshots state with boundary removed and debt cleared', async () => {
  const { snapshots } = await conduct({
    waveHandler: waves(
      mkState({ boundary: boundaryBlock({ fixUnits: [draft('consolidate-gcd')] }) }),
      mkState({ wave: 2, boundary: boundaryBlock() }),
    ),
  })
  const w1 = snapshots.find((sn) => sn.wave === 1 && sn.conductor)
  assert.ok(w1, 'the continuation leaves a crash-recovery snapshot')
  assert.equal('boundary' in w1, false, 'the consumed boundary block is stripped')
  assert.deepStrictEqual(w1.debt, [], 'consumed debt is carried as an empty array')
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
