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
import { loadScript } from './load.mjs'
import { makeAgent, makeWorkflow, structuredOutputError, BASE_SHA } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))
const HARNESS_PATH = '/abs/path/to/harness.mjs'

// ---- schema introspection ---------------------------------------------------------------
// Walk a JSON schema and collect every `maxLength`, remembering the path. Array items are
// marked with a `[]` segment so nested caps (debt[].what, findings[].repro) are distinguishable
// from top-level ones — they carry different obligations, see below.
function capsOf(schema, path = [], out = []) {
  if (!schema || typeof schema !== 'object') return out
  if (typeof schema.maxLength === 'number')
    out.push({ path: path.join('.'), name: path[path.length - 1], max: schema.maxLength })
  if (schema.properties)
    for (const [k, v] of Object.entries(schema.properties)) capsOf(v, [...path, k], out)
  if (schema.items) capsOf(schema.items, [...path, '[]'], out)
  return out
}

// SAMPLING arrays (findings, drafts — "show me the N worst") should carry maxItems, matching the
// count bound their prompt already states. S.explore/S.health cap findings at 10/12.
//
// COMPLETENESS arrays are exempt, and the distinction matters more than it looks. `debt` is a
// LEDGER: bankReviewDebt() exists so a deferred imperfection is never silently lost, so a
// maxItems there would discard the very thing the field promises to preserve. Absent maxItems,
// array length never fails validation anyway (maxItems IS a validation constraint when present —
// the point is that these arrays don't carry one), so capping the count buys nothing here.
// Observed ledger scale in the 2026-07-18 arc: worst case 10 entries at ~561 chars, ~5.6KB.
// Cap the item FIELDS on a ledger; never the count.
const COMPLETENESS_ARRAYS = new Set(['debt', 'debtLedger', 'filesChanged', 'failures'])

function unboundedArraysOf(schema, path = [], out = []) {
  if (!schema || typeof schema !== 'object') return out
  const name = path[path.length - 1]
  if (schema.type === 'array' && typeof schema.maxItems !== 'number' &&
      capsOf(schema.items).length > 0 && !COMPLETENESS_ARRAYS.has(name))
    out.push(path.join('.') || '(root)')
  if (schema.properties)
    for (const [k, v] of Object.entries(schema.properties)) unboundedArraysOf(v, [...path, k], out)
  if (schema.items) unboundedArraysOf(schema.items, [...path, '[]'], out)
  return out
}

const hasCap = (schema) => capsOf(schema).length > 0

// The generic clause: BE TERSE, and OVERRUNNING COSTS YOU THE WORK. Necessary but NOT sufficient
// — see hole (a). `TERSE` is the shared const; `REPORT` is the code-writing agents' variant.
const statesTheContract = (prompt) => /terse/i.test(prompt) && /oversiz/i.test(prompt)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A field's budget is "stated" if the field is NAMED and a real BOUND EXPRESSION sits near that
// mention. It must be an expression, not merely a digit: these prompts are saturated with shas,
// wave numbers and numbered lists, so `/\d/` within a window passes on almost anything (the
// round-2 review flagged this as a wide false-pass surface). "2-3 short sentences", "<= 1000
// chars" and "one sentence" all qualify; "at most 10 findings" does not — a count of findings
// is not a length budget.
const BOUND_EXPR = new RegExp(
  '\\d+[^.]{0,20}?\\b(?:chars?|characters|sentences?|words?|lines?)\\b' +
  '|\\b(?:one|two|a single)\\s+(?:short\\s+)?(?:sentence|line|word)' +
  '|(?:≤|<=|at most|no more than)\\s*\\d+\\s*(?:chars?|characters)',
  'i',
)
const WINDOW = 80

function statesBudgetFor(prompt, name) {
  const re = new RegExp('`?\\b' + esc(name) + '\\b`?', 'gi')
  let m
  while ((m = re.exec(prompt)) !== null) {
    const win = prompt.slice(Math.max(0, m.index - WINDOW), m.index + m[0].length + WINDOW)
    if (BOUND_EXPR.test(win)) return true
  }
  return false
}

// Does the prompt direct content INTO this field? The field must be the OBJECT of the
// preposition — "in its `notes` field" points at notes; "in `debt` (what, why, severity)" points
// at debt, and must NOT be read as pointing at `what`/`why` (round-2 review: the loose form
// over-fired on exactly that). Verb list includes the intransitive forms, because the live
// instance in MISMATCH_IS_A_TRIGGER reads "...things you merely want flagged go in `notes`"
// (harness.mjs:121-122) and a put/place/dump-only list sails straight past it.
function pointsInto(prompt, name) {
  return new RegExp(
    '\\b(?:put|place|dump|stick|add|include|record|write|report|go(?:es)?|belongs?|route)\\b' +
    '[^.]{0,80}?\\bin(?:to)?\\s+(?:the\\s+|its\\s+|an?\\s+)?`?' + esc(name) + '\\b',
    'i',
  ).test(prompt)
}

// Hole (b), stated as the property that actually matters rather than as a banned vocabulary:
// pointing at a capped field is legitimate — `contractMismatch` and `debt` EXIST to be filled,
// and the conductor's `notes` is a deliberate pressure-release (harness.mjs:253-255). What kills
// a call is pointing at a capped field WITHOUT telling the model the bound. So the two halves
// compose: an unbudgeted pointer is the defect.
const invitesOverflowInto = (prompt, name) => pointsInto(prompt, name) && !statesBudgetFor(prompt, name)

const namesField = (prompt, name) => new RegExp('`?\\b' + esc(name) + '\\b`?', 'i').test(prompt)
const requiredOf = (schema) => (Array.isArray(schema?.required) ? schema.required : [])

// Short machine-value strings — a git `sha`, an `id`, a `branch`/`base` name — are `type:'string'`
// but NOT prose: the model writes a token or two, never an essay, so they carry no format-bleed risk
// and need no prompt gloss. Excluded from the free-text guards (cf. COMPLETENESS_ARRAYS above), which
// target unbounded PROSE like `approach`/`guidance`.
const IDENTIFIER_STRINGS = new Set(['sha', 'id', 'branch', 'base', 'runId', 'mergedAt'])
// A "free-text" field is an UNCAPPED plain string — no `maxLength`, no `enum`, not a known identifier.
// An enum (`oneOf`) is bounded to its values and a capped string is length-bounded; only unbounded
// prose carries the format-bleed risk, and it is the one field kind the model cannot emit unless the
// prompt says what to write there (a scalar/enum/array it can infer from the schema tool-definition).
const isFreeText = (schema, key) => {
  const p = schema?.properties?.[key]
  return !!p && p.type === 'string' && typeof p.maxLength !== 'number' && !Array.isArray(p.enum) && !IDENTIFIER_STRINGS.has(key)
}
const freeTextRequired = (schema) => requiredOf(schema).filter((k) => isFreeText(schema, k))
// Required free-text fields the prompt never names. A prompt that never names its free-text output
// lets the model omit it or fold it into a neighbour (eval-observed on plan:*, where the free-text
// `testPlan` — described only as "how you will test it", never named — was dropped until the retry
// cap blew). TOP-LEVEL required only — naming every nested leaf bloats prompts more than it buys.
const unnamedFreeTextRequired = (prompt, schema) => freeTextRequired(schema).filter((n) => !namesField(prompt, n))

// A required free-text field must be ordered LAST among the required fields, so the model serializes
// the structured/scalar required fields before the free-text — the transition OUT of a long free-text
// into a following field is where Opus bleeds XML tool-call syntax (`</approach><parameter
// name="files">…`) into the JSON, swallowing every field that trails it (eval-observed: S.plan with
// `approach` first burned the retry cap; same required-first fix as S.impl). Violation = a required
// free-text field with a NON-free-text required field still after it.
function misorderedFreeText(schema) {
  const props = schema?.properties ? Object.keys(schema.properties) : []
  const req = new Set(requiredOf(schema))
  const reqInOrder = props.filter((k) => req.has(k))
  return reqInOrder.filter((k, i) => isFreeText(schema, k) && reqInOrder.slice(i + 1).some((j) => !isFreeText(schema, j)))
}

// ---- assertions -------------------------------------------------------------------------
function assertCapsAreContracted(calls, where) {
  const capped = calls.filter((c) => hasCap(c.schema))
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

// Top-level capped fields must have their budget stated. Nested item fields (debt[].what) are
// held to the weaker bar of the generic clause plus the maxItems rule below — naming every leaf
// of every array in every prompt would bloat the prompts more than it buys.
function assertBudgetsAreStated(capped, where) {
  const missing = []
  for (const c of capped)
    for (const cap of capsOf(c.schema))
      if (!cap.path.includes('[]') && !statesBudgetFor(c.prompt, cap.name))
        missing.push(`${c.label} -> \`${cap.name}\` (maxLength ${cap.max})`)

  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    `${where}: these prompts drive a capped field without stating its budget. The model cannot ` +
      `respect a limit it is never told — name the field and give it a bound.`,
  )
}

function assertNoOverflowInvitations(capped, where) {
  const bad = []
  for (const c of capped)
    for (const cap of capsOf(c.schema))
      if (invitesOverflowInto(c.prompt, cap.name)) bad.push(`${c.label} -> \`${cap.name}\``)

  assert.deepEqual(
    [...new Set(bad)].sort(),
    [],
    `${where}: these prompts direct the model to route material INTO a length-capped field — ` +
      `that is an instruction to fail. Point overflow at an uncapped field, or drop it.`,
  )
}

function assertArraysAreBounded(capped, where) {
  const bad = []
  for (const c of capped)
    for (const p of unboundedArraysOf(c.schema)) bad.push(`${c.label} -> ${p}[]`)

  assert.deepEqual(
    [...new Set(bad)].sort(),
    [],
    `${where}: these SAMPLING arrays cap their items but not their count. Add maxItems matching ` +
      `the count bound the prompt states (S.explore/S.health already do). If the array is instead a ` +
      `completeness ledger, add it to COMPLETENESS_ARRAYS with a reason — do not cap it.`,
  )
}

// `expectFreeText` guards against a refactor silently emptying the test WHERE free-text required
// fields are known to exist (harness). The conductor legitimately has none — every conductor free-text
// field is capped or optional — so it passes this rule vacuously and does not assert presence.
function assertFreeTextRequiredAreNamed(calls, where, expectFreeText = true) {
  const withFreeText = calls.filter((c) => freeTextRequired(c.schema).length > 0)
  if (expectFreeText)
    assert.ok(withFreeText.length > 0, `${where}: no required free-text schemas captured — the test would be vacuous`)
  const missing = []
  for (const c of withFreeText)
    for (const f of unnamedFreeTextRequired(c.prompt, c.schema)) missing.push(`${c.label} -> \`${f}\``)

  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    `${where}: these prompts drive a schema with a required free-text field the prompt never names. ` +
      `The model cannot emit prose it is never asked for — name each required free-text field in the prompt.`,
  )
}

function assertFreeTextOrderedLast(calls, where) {
  const bad = []
  for (const c of calls)
    for (const f of misorderedFreeText(c.schema)) bad.push(`${c.label} -> \`${f}\``)

  assert.deepEqual(
    [...new Set(bad)].sort(),
    [],
    `${where}: these schemas place a required free-text (uncapped string) field BEFORE another ` +
      `required field. Reorder so free-text fields come last (as S.plan/S.impl do) — the model bleeds ` +
      `XML tool-call syntax out of a long free-text field and swallows the required fields that trail it.`,
  )
}

// ---- fixtures ---------------------------------------------------------------------------
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makePlan = (units, extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units, edges: [], ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/hygiene', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})

// The default fakes are an unbroken happy path (fakes.mjs:45-46: verify passes, review empty,
// every gate approves), so NO fix round ever runs and `fix:`/`gate-fix:`/`opus-gate-fix:` prompts
// are never emitted at all. Round 1 of this test was blind to them — the labels behind 10 of the
// 19 observed production failures. These rules fail each gate exactly once so every fix path is
// walked, then approve so the wave still terminates.
const FIX_ROUNDS = [
  // impl confesses one deferred item -> the post-impl `debt-fix:` sweep prompt (capped S.impl)
  { match: /^impl:happy$/, result: {
    summary: 'done', filesChanged: [],
    debt: [{ what: 'thin test on the edge case', kind: 'test', severity: 'minor' }] } },
  // review blocks on round 0 only -> the in-loop `fix:` prompt
  { match: /^review:.*#0$/, result: {
    blocking: [{ summary: 'a real defect', file: 'a.js', confidence: 1 }],
    preExisting: [], nonBlocking: [], unsatisfiable: false } },
  // opus exit gate revises once -> `opus-gate-fix:`
  { match: /^opus-gate:.*#0$/, result: {
    verdict: 'revise', trigger: 'none',
    directives: [{ what: 'tighten the seam', why: 'it leaks' }], debt: [] } },
  // fable exit gate revises once -> `gate-fix:`
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
  const seen = new Set(capped.map((c) => c.label.split(':')[0].split('#')[0]))
  for (const required of ['impl', 'debt-fix', 'fix', 'gate-fix', 'opus-gate-fix', 'opus-gate', 'gate', 'explorer', 'health', 'flake', 'design'])
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
      match: /^(impl|fix|gate-fix|opus-gate-fix):/,
      result: (prompt, opts) => {
        if (!thrown.has(opts.label)) { thrown.add(opts.label); throw structuredOutputError() }
        return { summary: 'done', filesChanged: [] }
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
// Warm lanes carry two capped schemas `driveHarness` can never reach: S.chainPlan (nested
// evidence caps) and S.chainImpl (`summary`/`contractMismatch`/`specGap`/`debt` item caps plus
// a top-level `notes` cap). A capped schema no drive reaches is a new trap of exactly the class
// this file exists to catch, and the per-link budgets these prompts state must stay truthful
// against the caps the schemas actually carry.
//
// The lane only forms on a strict contract-edge chain of pending, fresh, in-scope units, and the
// fakes' built-in chain-plan default reports no links (which DEMOTES to cold dispatch and emits
// no chain-impl at all) — so the per-link rules below are what makes the drive non-vacuous.
// =========================================================================================
const CHAIN_TIP = { a: '11111111111111111111111111111111111111aa', b: '2222222222222222222222222222222222222bbb' }

async function driveChainWave() {
  const perLink = (make) => ['a', 'b'].map(make)
  const { fn, calls } = makeAgent([
    { match: /^chain-plan:a$/, result: () => ({
      links: perLink((id) => ({ id, feasible: true, files: [`${id}.js`], testPlan: 'unit tests', approach: 'x' })) }) },
    { match: /^chain-impl:a$/, result: () => ({
      links: perLink((id) => ({ id, done: true, filesChanged: [`${id}.js`], summary: 'done' })) }) },
    { match: /^chain-tips:a$/, result: () => ({ ok: true, tips: perLink((id) => ({ id, sha: CHAIN_TIP[id] })) }) },
    // The warm call committed and pinned each link, so per-link setup ADOPTS rather than rebuilds.
    { match: /^setup:a$/, result: () => ({ ok: true, sha: CHAIN_TIP.a, state: 'adopted' }) },
    { match: /^setup:b$/, result: () => ({ ok: true, sha: CHAIN_TIP.b, state: 'adopted' }) },
    ...FIX_ROUNDS,
  ])
  const runner = await loadScript(HARNESS)
  await runner({
    args: {
      plan: makePlan([unit('a'), unit('b')], { edges: [{ from: 'a', to: 'b', type: 'semantic', mode: 'contract' }] }),
      state: makeState(),
      config: { gateAuditRate: 0 },
    },
    agent: fn,
  })
  return calls
}

test('harness chain prompts: capped schemas state the length contract', async () => {
  const lane = (await driveChainWave()).filter((c) => /^(lane-setup:|chain-)/.test(c.label))
  for (const required of ['chain-plan:a', 'chain-impl:a'])
    assert.ok(lane.some((c) => c.label === required),
      `harness warm lane: expected the drive to reach '${required}' — the lane demoted and this test would be ` +
        `vacuous; saw ${JSON.stringify(lane.map((c) => c.label))}`)

  const capped = assertCapsAreContracted(lane, 'harness warm lane')
  assertBudgetsAreStated(capped, 'harness warm lane')
  assertArraysAreBounded(capped, 'harness warm lane')
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
    args: { plan: makePlan([unit('ok'), unit('broken')]), state: makeState(), config: {}, harnessPath: HARNESS_PATH },
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
