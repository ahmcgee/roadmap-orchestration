// Zero-token PROMPT-HYGIENE simulation. Locks one invariant that cost a full day to learn:
//
//   A `maxLength` in a schema is a CONTRACT WITH THE MODEL, and the prompt is the only place
//   that contract is communicated. A capped field with no matching instruction is a trap: the
//   agent overruns it, burns its schema-retries, dies, and agent() returns null WITH NO ERROR
//   OBJECT — so the failure is near-undiagnosable from the outside.
//
// Arc-observed: the conductor's tier-2 triage prompt carried a 600-char `notes` cap, no terseness
// clause, and a closing line ("overflow goes in `notes`") that pointed the agent straight AT the
// capped field. It died at two consecutive boundaries and was misdiagnosed as network flakiness
// across three paid runs. The harness's explorer/health prompts, which DID carry the clause, never
// failed once. That contrast is the whole test.
//
// This is a dynamic check, not a static one: it drives both scripts under the sim harness and
// inspects the real (prompt, schema) pairs the scripts actually emit — so it cannot be fooled by
// template-literal assembly, and a prompt that only appears on an escalation path is still caught.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from './load.mjs'
import { makeAgent, makeWorkflow, BASE_SHA } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))
const HARNESS_PATH = '/abs/path/to/harness.mjs'

// A schema "carries a cap" if a maxLength appears anywhere in it — including nested array items,
// which is where most of them hide (debt[].what, findings[].repro, …).
const hasCap = (schema) => schema != null && JSON.stringify(schema).includes('maxLength')

// The two accepted forms of the contract, both of which say the same two things: BE TERSE, and
// OVERRUNNING COSTS YOU THE WORK. `TERSE` is the shared const; `REPORT` is the code-writing
// agents' variant (which additionally tells them to commit first).
const statesTheContract = (prompt) => /terse/i.test(prompt) && /oversiz/i.test(prompt)

// Retry/salvage variants re-prompt an ALREADY-FAILED call and carry their own shorten-aggressively
// text; they are the cure, not the disease, so they are not the subject of this invariant.
const isRetry = (label = '') => label.includes('#retry') || label.includes('#salvage')

function assertCapsAreContracted(calls, where) {
  const capped = calls.filter((c) => hasCap(c.schema) && !isRetry(c.label))
  assert.ok(capped.length > 0, `${where}: no capped-schema calls captured — the test would be vacuous`)

  const naked = capped.filter((c) => !statesTheContract(c.prompt))
  assert.deepEqual(
    naked.map((c) => c.label).sort(),
    [],
    `${where}: these prompts drive a schema with a maxLength but never tell the model to be terse. ` +
      `A cap the model is not told about is a trap — add the shared TERSE const (or REPORT for ` +
      `code-writing agents) to each.`,
  )
  return capped
}

// ---- fixtures ---------------------------------------------------------------------------
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makePlan = (units, extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units, edges: [], ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/hygiene', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})

// =========================================================================================
// harness.mjs — sweep the paths that reach a capped schema.
//
// Capped schemas in the harness: S.impl (impl/fix/gate-fix), S.opusGate, S.gate, S.explore,
// S.health, S.flake. A `preview` block makes the wave-tail explorer fire; a `risk:'high'` unit
// forces BOTH frontier paths (fable plan-check + fable exit gate), so one wave covers the lot.
// =========================================================================================
test('harness: every capped-schema prompt states the length contract', async () => {
  const { fn, calls } = makeAgent()
  const runner = await loadScript(HARNESS)
  await runner({
    args: {
      plan: makePlan(
        [unit('happy'), unit('risky', { risk: 'high' })],
        { preview: { kind: 'api', howToAccess: 'node -e require("./x")' }, provision: { setup: 'npm ci' } },
      ),
      state: makeState(),
      config: { gateAuditRate: 0 },
    },
    agent: fn,
  })

  const capped = assertCapsAreContracted(calls, 'harness')

  // Guard against a future refactor quietly narrowing what this test sees.
  const seen = new Set(capped.map((c) => c.label.split(':')[0].split('#')[0]))
  for (const required of ['impl', 'opus-gate', 'gate', 'explorer', 'health', 'flake'])
    assert.ok(seen.has(required), `harness: expected to exercise a capped '${required}' prompt; saw ${[...seen]}`)
})

// =========================================================================================
// conductor.mjs — capped schemas are S_census, S_triage (tier 2) and S_boundaryPlan (tier 3).
// Two waves: wave 1 has an in-scope quarantine (forces tier 3), wave 2 has findings only
// (forces tier 2). Tier 3's newUnit ends the arc on wave 2 via arcComplete.
// =========================================================================================
test('conductor: every capped-schema prompt states the length contract', async () => {
  const quarantined = { status: 'quarantined', branch: 'unit/broken', reason: 'unsatisfiable' }
  const findings = [{ area: 'test', what: 'thin coverage', where: 'a.js' }]

  let wave = 0
  const { fn: workflowFn } = makeWorkflow(() => {
    wave++
    return {
      integrationBranch: 'roadmap/hygiene', integrationTip: BASE_SHA, consultsUsed: 0,
      spend: {}, wave, debt: [],
      units: wave === 1
        ? { ok: { status: 'merged' }, broken: quarantined }
        : { ok: { status: 'merged' }, broken: quarantined, fresh: { status: 'merged' } },
      boundary: { explorer: null, health: { findings, fixUnits: [] }, flake: null },
    }
  })

  const { fn: agentFn, calls } = makeAgent([
    // Tier 3 (wave 1): respec the quarantine so the arc continues into wave 2.
    {
      match: /^boundary:w1$/,
      result: {
        newUnits: [{ id: 'fresh', title: 'respec', risk: 'low', goal: 'g', acceptance: ['a'], supersedes: 'broken' }],
        reviseSpecs: [], cutUnits: [], debtLedger: [], journal: 'j', escalate: false, arcComplete: false, notes: '',
      },
    },
    // Tier 2 (wave 2): nothing left worth a wave → arc-complete.
    {
      match: /^triage:w2$/,
      result: {
        admit: [], cut: [], promote: [], debtLedger: [], feedback: [],
        escalate: false, arcComplete: true, notes: '',
      },
    },
  ])

  const runner = await loadScript(CONDUCTOR)
  await runner({
    args: {
      plan: makePlan([unit('ok'), unit('broken')]),
      state: makeState(),
      config: {},
      harnessPath: HARNESS_PATH,
    },
    agent: agentFn,
    workflow: workflowFn,
  })

  const capped = assertCapsAreContracted(calls, 'conductor')

  const seen = new Set(capped.map((c) => c.label.split(':')[0].split('#')[0]))
  for (const required of ['census', 'triage', 'boundary'])
    assert.ok(seen.has(required), `conductor: expected to exercise a capped '${required}' prompt; saw ${[...seen]}`)
})

// =========================================================================================
// The specific regression: nothing may point an agent AT its own capped field. The tier-2
// prompt used to end "overflow goes in `notes`" — an instruction to do the one thing that
// kills the call.
// =========================================================================================
test('no prompt invites overflow into a capped field', async () => {
  const { fn, calls } = makeAgent()
  const runner = await loadScript(HARNESS)
  await runner({
    args: {
      plan: makePlan([unit('u')], { preview: { kind: 'api', howToAccess: 'x' } }),
      state: makeState(),
      config: { gateAuditRate: 0 },
    },
    agent: fn,
  })

  for (const c of calls.filter((x) => hasCap(x.schema)))
    assert.doesNotMatch(
      c.prompt,
      /overflow goes in|put (any |the )?overflow|dump .* in `?notes`?/i,
      `${c.label}: prompt directs overflow into a length-capped field — that is an instruction to fail`,
    )
})
