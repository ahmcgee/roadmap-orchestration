// Shared prompt-hygiene introspection + assertion toolkit.
//
// Extracted from prompt-hygiene.test.mjs so that other suites (codex-lane.test.mjs holds the
// embedded Codex brief and its --output-schema to the same bar) can reuse the exact same
// checks instead of duplicating them. The invariant these encode, learned the hard way:
//
//   A `maxLength` in a schema is a CONTRACT WITH THE MODEL, and the prompt is the only place
//   that contract is communicated. A capped field with no matching instruction is a trap: the
//   agent overruns it, burns its schema-retries, dies, and agent() returns null WITH NO ERROR
//   OBJECT — so the failure is near-undiagnosable from the outside.
//
// See prompt-hygiene.test.mjs's header for the full arc-observed history (round 1: the tier-2
// triage death; round 2: 16 opus StructuredOutput deaths and the three holes that let the
// round-1 test pass anyway).
import assert from 'node:assert/strict'

// ---- schema introspection ---------------------------------------------------------------
// Walk a JSON schema and collect every `maxLength`, remembering the path. Array items are
// marked with a `[]` segment so nested caps (debt[].what, findings[].repro) are distinguishable
// from top-level ones — they carry different obligations (see assertBudgetsAreStated).
export function capsOf(schema, path = [], out = []) {
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
// Cap the item FIELDS on a ledger; never the count.
export const COMPLETENESS_ARRAYS = new Set(['debt', 'debtLedger', 'filesChanged', 'failures'])

export function unboundedArraysOf(schema, path = [], out = []) {
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

export const hasCap = (schema) => capsOf(schema).length > 0

// The generic clause: BE TERSE, and OVERRUNNING COSTS YOU THE WORK. Necessary but NOT sufficient
// — each capped field also needs its own stated budget. `TERSE` is the shared const; `REPORT` is
// the code-writing agents' variant.
export const statesTheContract = (prompt) => /terse/i.test(prompt) && /oversiz/i.test(prompt)

export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A field's budget is "stated" if the field is NAMED and a real BOUND EXPRESSION sits near that
// mention. It must be an expression, not merely a digit: these prompts are saturated with shas,
// wave numbers and numbered lists, so `/\d/` within a window passes on almost anything. "2-3
// short sentences", "<= 1000 chars" and "one sentence" all qualify; "at most 10 findings" does
// not — a count of findings is not a length budget.
export const BOUND_EXPR = new RegExp(
  '\\d+[^.]{0,20}?\\b(?:chars?|characters|sentences?|words?|lines?)\\b' +
  '|\\b(?:one|two|a single)\\s+(?:short\\s+)?(?:sentence|line|word)' +
  '|(?:≤|<=|at most|no more than)\\s*\\d+\\s*(?:chars?|characters)',
  'i',
)
export const WINDOW = 80

export function statesBudgetFor(prompt, name) {
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
// at debt, and must NOT be read as pointing at `what`/`why`. Verb list includes the intransitive
// forms ("...things you merely want flagged go in `notes`").
export function pointsInto(prompt, name) {
  return new RegExp(
    '\\b(?:put|place|dump|stick|add|include|record|write|report|go(?:es)?|belongs?|route)\\b' +
    '[^.]{0,80}?\\bin(?:to)?\\s+(?:the\\s+|its\\s+|an?\\s+)?`?' + esc(name) + '\\b',
    'i',
  ).test(prompt)
}

// Pointing at a capped field is legitimate — `contractMismatch` and `debt` EXIST to be filled.
// What kills a call is pointing at a capped field WITHOUT telling the model the bound. So the
// two halves compose: an unbudgeted pointer is the defect.
export const invitesOverflowInto = (prompt, name) => pointsInto(prompt, name) && !statesBudgetFor(prompt, name)

export const namesField = (prompt, name) => new RegExp('`?\\b' + esc(name) + '\\b`?', 'i').test(prompt)
export const requiredOf = (schema) => (Array.isArray(schema?.required) ? schema.required : [])

// Short machine-value strings — a git `sha`, an `id`, a `branch`/`base` name — are `type:'string'`
// but NOT prose: the model writes a token or two, never an essay, so they carry no format-bleed risk
// and need no prompt gloss. Excluded from the free-text guards, which target unbounded PROSE like
// `approach`/`guidance`.
export const IDENTIFIER_STRINGS = new Set(['sha', 'id', 'branch', 'base', 'runId', 'mergedAt'])
// A "free-text" field is an UNCAPPED plain string — no `maxLength`, no `enum`, not a known identifier.
// An enum (`oneOf`) is bounded to its values and a capped string is length-bounded; only unbounded
// prose carries the format-bleed risk, and it is the one field kind the model cannot emit unless the
// prompt says what to write there.
export const isFreeText = (schema, key) => {
  const p = schema?.properties?.[key]
  return !!p && p.type === 'string' && typeof p.maxLength !== 'number' && !Array.isArray(p.enum) && !IDENTIFIER_STRINGS.has(key)
}
export const freeTextRequired = (schema) => requiredOf(schema).filter((k) => isFreeText(schema, k))
// Required free-text fields the prompt never names. A prompt that never names its free-text output
// lets the model omit it or fold it into a neighbour. TOP-LEVEL required only — naming every nested
// leaf bloats prompts more than it buys.
export const unnamedFreeTextRequired = (prompt, schema) => freeTextRequired(schema).filter((n) => !namesField(prompt, n))

// A required free-text field must be ordered LAST among the required fields, so the model serializes
// the structured/scalar required fields before the free-text — the transition OUT of a long free-text
// into a following field is where Opus bleeds XML tool-call syntax into the JSON, swallowing every
// field that trails it. Violation = a required free-text field with a NON-free-text required field
// still after it.
export function misorderedFreeText(schema) {
  const props = schema?.properties ? Object.keys(schema.properties) : []
  const req = new Set(requiredOf(schema))
  const reqInOrder = props.filter((k) => req.has(k))
  return reqInOrder.filter((k, i) => isFreeText(schema, k) && reqInOrder.slice(i + 1).some((j) => !isFreeText(schema, j)))
}

// ---- assertions -------------------------------------------------------------------------
export function assertCapsAreContracted(calls, where) {
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
// held to the weaker bar of the generic clause plus the maxItems rule — naming every leaf
// of every array in every prompt would bloat the prompts more than it buys.
export function assertBudgetsAreStated(capped, where) {
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

export function assertNoOverflowInvitations(capped, where) {
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

export function assertArraysAreBounded(capped, where) {
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
export function assertFreeTextRequiredAreNamed(calls, where, expectFreeText = true) {
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

export function assertFreeTextOrderedLast(calls, where) {
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
