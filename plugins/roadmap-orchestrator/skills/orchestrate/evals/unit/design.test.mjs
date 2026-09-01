// Zero-token control-flow simulation of the DESIGN-AUTHORITY path in harness.mjs.
//
// Phase 0 makes designs bind like frozen contracts; this file locks the harness half. Arc-observed
// (atlas2, 2026-07-18): with no concept of a design authority, UI units built without their comps
// in the fork base and "comp-conformant" acceptance criteria were graded by jsdom presence tests —
// the result was systematic bespoke reimplementation of every designed screen, and a dedicated
// reconcile arc to undo it. The dominant failure was ADOPTION (the implementer could have read the
// comp and rebuilt anyway), which is why most of what is locked here is text-agent judgment rather
// than vision.
//
// The load-bearing test is `byte-identical` below: on an arc that declares no designAuthorities,
// every prompt must be unchanged. That is what allows a design-carrying change to ride the paid
// fixtures — which have no designs — as valid evidence for whatever else ships alongside it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { makeAgent, BASE_SHA } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))

const makePlan = (units, edges = [], extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units, edges, ...extra })
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/design-test', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})
const runWave = async (agentFn, plan, state, config = {}) =>
  (await loadScript(HARNESS))({ args: { plan, state, config: { gateAuditRate: 0, ...config } }, agent: agentFn })

const AUTH = [{ id: 'checkin', source: 'design-project', path: 'apps/web/src/design/checkin/', covers: ['/checkin'] }]
const PREVIEW = { kind: 'server', howToAccess: 'http://localhost:5173', start: 'npm run dev' }

test('design: no designAuthorities -> every prompt byte-identical (fixture-neutrality)', async () => {
  const runOne = async (plan) => {
    const { fn, calls } = makeAgent()
    await runWave(fn, plan, makeState())
    return calls.map((c) => `${c.label} :: ${c.prompt}`)
  }
  const before = await runOne(makePlan([unit('a')]))
  const after = await runOne(makePlan([unit('a')], [], { designAuthorities: AUTH }))
  assert.deepEqual(after, before,
    'declaring designAuthorities must not perturb a single prompt while no unit cites one — the paid ' +
    'fixtures (which have no designs) depend on this to stay valid evidence for co-shipped changes')
})

test('design: a citing unit gets the clause; a non-citing sibling is untouched', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('ui', { design: ['checkin#chrome'] }), unit('plain')], [],
    { designAuthorities: AUTH }), makeState())

  const promptFor = (l) => calls.find((c) => c.label === l)?.prompt ?? ''
  // The implementer is now Codex, briefed through the steering agent's `codex-build:` prompt (the
  // brief is embedded verbatim in it), and the adversarial review stage is gone — the exit gate is
  // where reimplementation is now judged. Both still have to carry the clause.
  for (const label of ['plan:ui', 'codex-build:ui', 'opus-gate:ui#0', 'opus-plan-check:ui'])
    assert.match(promptFor(label), /design authorities/i, `${label} must carry the design clause`)
  // The authority PATH must be named, not just the citation — an implementer that cannot open the
  // comp is an implementer that reinvents it, which is the original failure.
  assert.match(promptFor('codex-build:ui'), /apps\/web\/src\/design\/checkin\//, 'the codex brief names the authority path')
  assert.match(promptFor('codex-build:ui'), /never rebuild a designed screen from primitives/i,
    'the implementer is told adoption is the default, not reimplementation')
  assert.match(promptFor('opus-gate:ui#0'), /grade conformance against the comp SOURCE/,
    'the exit gate — which replaced the review stage — grades fidelity against the comp, not a jsdom presence test')
  assert.match(promptFor('plan:ui'), /feasible:false/, 'a missing comp in the fork base is an early quarantine')

  for (const label of ['plan:plain', 'codex-build:plain', 'opus-gate:plain#0'])
    assert.doesNotMatch(promptFor(label), /design authorities/i, `${label} must be untouched`)
})

test('design: a citation naming an unknown authority throws at plan validation', async () => {
  const { fn } = makeAgent()
  await assert.rejects(
    () => runWave(fn, makePlan([unit('ui', { design: ['nosuch#x'] })], [], { designAuthorities: AUTH }), makeState()),
    /design citation "nosuch#x" names no authority/,
    'a citation that silently degrades to an empty clause is the invisible-to-the-pipeline failure this ends')
})

test('design: boundary job fires only for units merged THIS wave, and needs a live preview', async () => {
  const plan = makePlan([unit('ui', { design: ['checkin#chrome'] })], [], { designAuthorities: AUTH, preview: PREVIEW })

  const { fn, calls } = makeAgent()
  const state = await runWave(fn, plan, makeState())
  assert.ok(calls.some((c) => c.label === 'design:w1'), 'runs when a design-cited unit merged this wave')
  assert.ok(state.boundary?.design, 'result serialized into the boundary block')
  assert.ok(calls.some((c) => c.label === 'design-write:w1'), 'narrative persisted like explorer/health')

  // Already merged in an earlier wave: nothing new to reconcile.
  const { fn: fn2, calls: c2 } = makeAgent()
  await runWave(fn2, plan, makeState({ units: { ui: { status: 'merged' } } }))
  assert.ok(!c2.some((c) => c.label === 'design:w1'), 'no re-reconcile of a unit merged in an earlier wave')

  // No preview: no browsable surface. Must skip cleanly, not crash.
  const { fn: fn3, calls: c3 } = makeAgent()
  await runWave(fn3, makePlan([unit('ui', { design: ['checkin#chrome'] })], [], { designAuthorities: AUTH }), makeState())
  assert.ok(!c3.some((c) => c.label === 'design:w1'), 'design job requires a live preview')
})

test('design: the job must declare whether it could actually SEE', async () => {
  const plan = makePlan([unit('ui', { design: ['checkin#chrome'] })], [], { designAuthorities: AUTH, preview: PREVIEW })
  const { fn, calls } = makeAgent([{ match: /^design:w1$/, result: {
    findings: [{ surface: '/checkin', severity: 'adoption-gap', what: 'rebuilt the opening chrome' }],
    fixUnits: [], visionUsed: false } }])
  const state = await runWave(fn, plan, makeState())

  assert.equal(state.boundary.design.visionUsed, false)
  assert.ok(calls.find((c) => c.label === 'design:w1').schema.required.includes('visionUsed'),
    'visionUsed is REQUIRED — a fidelity check that silently cannot see is worse than none')
  // A degraded check must be visible in the narrative a human reads, not only in state.json.
  assert.match(calls.find((c) => c.label === 'design-write:w1').prompt, /NO SCREENSHOT CAPABILITY/)
})

test('design: the reconciler is told to read approved divergences before reporting drift', async () => {
  const plan = makePlan([unit('ui', { design: ['checkin#chrome'] })], [], { designAuthorities: AUTH, preview: PREVIEW })
  const { fn, calls } = makeAgent()
  await runWave(fn, plan, makeState())
  // Arc-observed: the architect folded approved divergences INTO the comp mid-arc. Re-reporting
  // those as drift burns a wave on decisions already made.
  assert.match(calls.find((c) => c.label === 'design:w1').prompt, /architect-log\.md/,
    'the reconciler must read approved divergences before calling anything drift')
})

// Conditional clauses are spliced into prompts by string concatenation, and a clause dropped mid-
// sentence produces prose no reviewer would write: the Fable gate shipped reading "…without further
// steering. Small <comp-fidelity sentence> oversights — subtle spec misses…". It happened three
// times during one change and no test caught it, because every other assertion checks that a clause
// is PRESENT, never that it landed somewhere a sentence can survive. This checks the seam.
test('design: injected clauses land on sentence boundaries, not mid-sentence', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('ui', { design: ['checkin#chrome'] }, )], [],
    { designAuthorities: AUTH, preview: PREVIEW }), makeState())

  // Every distinct opening of a conditionally-injected clause.
  const OPENERS = [
    'This unit’s surface is governed by design authorities',   // designClause (curly apostrophe safe)
    "This unit's surface is governed by design authorities",
    'For a comp-governed criterion',
    'Rebuilding from primitives',
    'A spec clause contradicting the comp',
    'A spec clause that contradicts the comp',
  ]
  const problems = []
  for (const c of calls) {
    if (!c.prompt) continue
    for (const opener of OPENERS) {
      let from = 0, i
      while ((i = c.prompt.indexOf(opener, from)) !== -1) {
        from = i + 1
        if (i === 0) continue
        const before = c.prompt.slice(0, i).trimEnd()
        // A clause may follow a sentence terminator, a colon, or a newline — never a bare word.
        if (!/[.!?:\n]$/.test(before))
          problems.push(`${c.label}: "...${before.slice(-58)}" >>> "${opener}..."`)
      }
    }
  }
  assert.deepEqual(problems, [],
    'a conditional clause was spliced into the middle of a sentence — the surrounding prose is now ' +
    'broken for exactly the units the clause exists to help')
})
