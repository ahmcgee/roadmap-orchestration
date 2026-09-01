// Zero-token PROMPT-HYGIENE simulation. Locks one invariant that cost a full day to learn:
//
//   A `maxLength` in a schema is a CONTRACT WITH THE MODEL, and the prompt is the only place
//   that contract is communicated. A capped field with no matching instruction is a trap: the
//   agent overruns it, burns its schema-retries, dies, and agent() returns null WITH NO ERROR
//   OBJECT — so the failure is near-undiagnosable from the outside.
//
// Arc-observed (round 1): the conductor's tier-2 triage prompt carried a 600-char `notes` cap, no
// terseness clause, and a closing line ("overflow goes in `notes`") that pointed the agent straight
// AT the capped field. It died at two consecutive boundaries and was misdiagnosed as network
// flakiness across three paid runs.
//
// Arc-observed (round 2 — 2026-07-18, atlas2): this file PASSED while 16 opus calls died on
// StructuredOutput across three runs, manufacturing two false quarantines. What the run records
// support, and what they do not, matters here — the caps below are a defence, not a proven
// post-mortem:
//   PROVEN from the workflow records: deaths occurred ONLY on maxLength-capped schemas —
//   16/62 capped opus calls vs 0/102 uncapped (p~4e-8), a split that survives matching on turn
//   length (toolCalls>=20: 13/43 capped vs 0/44 uncapped) and on repo-mutation. All 16 died WITH
//   lastToolName=StructuredOutput, i.e. they emitted reports and were rejected, five times each.
//   NOT PROVEN: which FIELD overran. No payloads or ajv errors survive for workflow agents, so
//   "`notes` overran 1000" is a plausible inference, never an observation. Do not let this
//   comment launder it into evidence. One capped-schema-independent death exists in the record
//   (`plan:` on the uncapped S.plan), so caps are not the whole mechanism.
// Three holes let this file pass anyway, each fixed below:
//   (a) `statesTheContract` only looked for a generic terseness clause. `REPORT` contains the words
//       "terse" and "oversized", so every S.impl prompt passed — while never naming the 1000-char
//       `notes` cap, the 300-char `contractMismatch` cap, or the 400-char debt caps. A generic
//       clause is necessary, not sufficient: each capped field needs its own stated budget.
//   (b) the overflow-invitation regex encoded the ROUND-1 WORDING ("overflow goes in `notes`")
//       rather than the class. The live retry nudge says "put any commentary in its `notes` field"
//       — same instruction, different noun, no match. The check is now driven by the call's OWN
//       capped field names, so it cannot be dodged by rephrasing.
//   (c) the retry prompt was never captured at all (the default fake never throws) AND was
//       explicitly exempted as "the cure, not the disease". The cure was pointing at the disease's
//       favourite field. Retries are now driven and held to the same bar.
//
// This is a dynamic check, not a static one: it drives both scripts under the sim harness and
// inspects the real (prompt, schema) pairs the scripts actually emit — so it cannot be fooled by
// template-literal assembly, and a prompt that only appears on an escalation path is still caught.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { makeAgent, makeWorkflow, packRules, structuredOutputError, BASE_SHA, implCodexOk, codexMetaOk } from './fakes.mjs'
// The introspection + assertion toolkit lives in hygiene-lib.mjs so other suites
// (codex-lane.test.mjs holds the embedded Codex brief to the same bar) share one copy.
import {
  hasCap,
  assertCapsAreContracted, assertBudgetsAreStated, assertNoOverflowInvitations,
  assertArraysAreBounded, assertFreeTextRequiredAreNamed, assertFreeTextOrderedLast,
} from './hygiene-lib.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))
const HARNESS_PATH = '/abs/path/to/harness.mjs'

// ---- fixtures ---------------------------------------------------------------------------
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makePlan = (units, extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units, edges: [], ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/hygiene', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})

// The default fakes are an unbroken happy path (verify passes, every gate approves), so NO fix
// round ever runs and the `codex-fix:`/`codex-gate-fix:`/`codex-opus-gate-fix:` prompts are never
// emitted at all. Round 1 of this test was blind to them — the labels behind 10 of the 19 observed
// production failures. These rules fail the mechanical verify exactly once and each gate exactly
// once so every fix path is walked, then pass/approve so the wave still terminates.
//
// The route into the polish loop's fix step CHANGED with the codex lane: there is no adversarial
// review stage any more, so a blocking review finding can no longer force a fix round. The only
// remaining route is a FAILING verify — hence the `verify:*#0` rule below.
const FIX_ROUNDS = [
  // the build confesses one deferred item -> it banks straight to the ledger (no sweep round);
  // kept because the S.implCodex prompt is capped and must be in scope either way.
  { match: /^codex-build:happy$/, result: () => ({
    ...implCodexOk(),
    debt: [{ what: 'thin test on the edge case', kind: 'test', severity: 'minor' }] }) },
  // the mechanical verify fails on round 0 only -> the in-loop `codex-fix:` prompt.
  // Anchored at ^verify: so it never catches `opus-gate-verify:`/`gate-verify:`.
  { match: /^verify:.*#0$/, result: {
    pass: false, blocked: false, failures: ['assert: expected 1, got 2'],
    lanes: [{ command: 'npm run test:ci', exitCode: 1 }],
    contractSurfaceTouched: false, diffFiles: [] } },
  // opus exit gate revises once -> `codex-opus-gate-fix:`
  { match: /^opus-gate:.*#0$/, result: {
    verdict: 'revise', trigger: 'none',
    directives: [{ what: 'tighten the seam', why: 'it leaks' }], debt: [] } },
  // fable exit gate revises once -> `codex-gate-fix:`
  { match: /^gate:.*#0$/, result: {
    verdict: 'revise',
    directives: [{ what: 'tighten the seam', why: 'it leaks' }], debt: [] } },
]

// Drives one wave that reaches every capped schema in the harness: a `preview` block fires the
// wave-tail explorer, and a risk:'high' unit forces BOTH frontier paths (fable plan-check + fable
// exit gate). `rules` lets a test inject failures on top; FIX_ROUNDS is always applied so the
// fix-family prompts are in scope, and caller rules take precedence (listed first).
async function driveHarness(rules = []) {
  const { fn, calls } = makeAgent([...rules, ...FIX_ROUNDS])
  const runner = await loadScript(HARNESS)
  await runner({
    args: {
      plan: makePlan(
        // 'happy' cites a design authority so the capped S.design boundary schema is in scope too —
        // a new capped schema that no drive reaches is a new trap, which is this file's whole subject.
        [unit('happy', { design: ['checkin#chrome'] }), unit('risky', { risk: 'high' })],
        {
          preview: { kind: 'api', howToAccess: 'node -e require("./x")' },
          provision: { setup: 'npm ci' },
          designAuthorities: [{ id: 'checkin', source: 'design-project', path: 'apps/web/src/design/checkin/', covers: ['/checkin'] }],
        },
      ),
      state: makeState(),
      config: { gateAuditRate: 0 },
    },
    agent: fn,
  })
  return calls
}

// =========================================================================================
// harness.mjs — the generic clause.
// =========================================================================================
test('harness: every capped-schema prompt states the length contract', async () => {
  const capped = assertCapsAreContracted(await driveHarness(), 'harness')

  // Guard against a future refactor quietly narrowing what this test sees.
  // The code-writing family is now the CODEX STEERING family: `impl`/`debt-fix`/`fix`/`gate-fix`/
  // `opus-gate-fix` no longer exist, and `codex-spec-review` is a new capped schema (S.specReview)
  // that must not be allowed to slip in untested — a capped schema no drive reaches is exactly the
  // trap this file exists to catch. 0.14.0 adds four more: `plan`, `verify` and `flake` became
  // codex ROLES (so their courier carries the adapter envelope, which is itself capped), and
  // `codex-review` is a brand-new capped schema — the pre-gate digest the exit gate now eats.
  const seen = new Set(capped.map((c) => c.label.split(':')[0].split('#')[0]))
  for (const required of ['codex-build', 'codex-fix', 'codex-gate-fix', 'codex-opus-gate-fix', 'codex-spec-review',
    'plan', 'verify', 'codex-review',
    'opus-gate', 'gate', 'explorer', 'health', 'flake', 'design'])
    assert.ok(seen.has(required), `harness: expected to exercise a capped '${required}' prompt; saw ${[...seen]}`)
})

// =========================================================================================
// Hole (a): the generic clause is not enough — each capped field needs a stated budget.
// =========================================================================================
test('harness: every capped field has its budget stated in the prompt', async () => {
  const calls = await driveHarness()
  assertBudgetsAreStated(calls.filter((c) => hasCap(c.schema)), 'harness')
})

// =========================================================================================
// Hole (b): schema-driven overflow-invitation check, covering retries (hole (c)).
// The rule throws StructuredOutput ONCE per impl/fix label so run()'s retry actually fires and
// its prompt lands in `calls` — the round-1 test never saw this prompt at all.
// =========================================================================================
test('no prompt invites overflow into one of its own capped fields', async () => {
  const thrown = new Set()
  const calls = await driveHarness([
    {
      match: /^codex-(build|fix|gate-fix|opus-gate-fix):/,
      result: (prompt, opts) => {
        if (!thrown.has(opts.label)) { thrown.add(opts.label); throw structuredOutputError() }
        return implCodexOk()
      },
    },
  ])

  assert.ok(
    calls.some((c) => c.label.includes('#retry')),
    'the StructuredOutput retry path never fired — this test would be vacuous (check run()\'s catch)',
  )
  assertNoOverflowInvitations(calls.filter((c) => hasCap(c.schema)), 'harness')
})

// =========================================================================================
// A per-item cap on an unbounded array bounds nothing.
// =========================================================================================
test('harness: arrays with capped items also cap their count', async () => {
  const calls = await driveHarness()
  assertArraysAreBounded(calls.filter((c) => hasCap(c.schema)), 'harness')
})

// =========================================================================================
// conductor.mjs — capped schemas are S_census, S_triage (tier 2) and S_boundaryPlan (tier 3).
// Two waves: wave 1 has an in-scope quarantine (forces tier 3), wave 2 has findings only
// (forces tier 2). Tier 3's newUnit ends the arc on wave 2 via arcComplete.
// =========================================================================================
async function driveConductor() {
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

  const hygienePlan = makePlan([unit('ok'), unit('broken')])
  const hygieneState = makeState()
  const { fn: agentFn, calls } = makeAgent([
    // The launch pack read — the conductor's first act, and itself a capped-schema prompt.
    ...packRules(hygienePlan, hygieneState),
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
    args: { roadmapDir: `${hygienePlan.repoPath}/.roadmap`, launchId: 'sim-launch', config: {}, harnessPath: HARNESS_PATH },
    agent: agentFn,
    workflow: workflowFn,
  })
  return calls
}

test('conductor: every capped-schema prompt states the length contract', async () => {
  const capped = assertCapsAreContracted(await driveConductor(), 'conductor')

  const seen = new Set(capped.map((c) => c.label.split(':')[0].split('#')[0]))
  for (const required of ['census', 'triage', 'boundary'])
    assert.ok(seen.has(required), `conductor: expected to exercise a capped '${required}' prompt; saw ${[...seen]}`)
})

test('conductor: every capped field has its budget stated in the prompt', async () => {
  const calls = await driveConductor()
  assertBudgetsAreStated(calls.filter((c) => hasCap(c.schema)), 'conductor')
})

test('conductor: no prompt invites overflow into one of its own capped fields', async () => {
  const calls = await driveConductor()
  assertNoOverflowInvitations(calls.filter((c) => hasCap(c.schema)), 'conductor')
})

test('conductor: arrays with capped items also cap their count', async () => {
  const calls = await driveConductor()
  assertArraysAreBounded(calls.filter((c) => hasCap(c.schema)), 'conductor')
})

// =========================================================================================
// The retry-cap class: a required free-text field must be NAMED in its prompt and ORDERED last in
// its schema (both eval-observed on plan:*; see the helper comments).
// =========================================================================================
test('harness: every required free-text field is named in its prompt', async () => {
  assertFreeTextRequiredAreNamed(await driveHarness(), 'harness')
})

test('harness: required free-text fields are ordered last in their schema', async () => {
  assertFreeTextOrderedLast(await driveHarness(), 'harness')
})

test('conductor: every required free-text field is named in its prompt', async () => {
  assertFreeTextRequiredAreNamed(await driveConductor(), 'conductor', false)
})

test('conductor: required free-text fields are ordered last in their schema', async () => {
  assertFreeTextOrderedLast(await driveConductor(), 'conductor')
})
