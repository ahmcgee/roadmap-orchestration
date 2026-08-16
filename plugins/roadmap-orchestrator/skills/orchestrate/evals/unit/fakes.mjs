// Scripted fakes for the zero-token simulation layer. FROZEN API — conductor.test.mjs is
// written independently against these exact signatures, so treat the exported surface as a
// contract:
//   makeAgent(rules, baseSha?) -> { fn, calls }
//   makeWorkflow(handler)      -> { fn, calls }
//   BASE_SHA, INT_SHA
//   assertAllModelsPinned(calls), assertSchemasPresent(calls), conformsToSchema(result, schema)
//   structuredOutputError()
//
// The fakes are deliberately minimal and honest: they return canned STRUCTURED outputs keyed
// off `opts.label` (short, stable, load-bearing — prompts drift with wording edits, labels
// don't). Every fake result is shallow-checked against the call's own schema so a fake that
// drifts from the harness's schema fails loudly rather than silently feeding a bad shape.
import assert from 'node:assert/strict'

// A plausible-looking 40-char sha used as the default base/integration tip everywhere. Tests
// that probe sha-dependent logic (reconciliation, adopt-tip mismatch) inject their own
// divergent shas; in the default happy path nothing about shas changes, so dependent units
// keep forking a stable tip. INT_SHA is exported for tests that want a distinct value.
export const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
export const INT_SHA = 'b0a9f8e7d6c5b4a3d2e1f0d9c8b7a6f5e4d3c2b1'

// Shared monotonic sequence counter ACROSS makeAgent and makeWorkflow — so a test that mixes
// both fakes can assert cross-fake ordering (e.g. persist-before-dispatch).
let __seq = 0
export const nextSeq = () => __seq++

// ---- built-in default results, keyed by harness label prefix ---------------------------
// Each entry: [labelMatches(label) -> bool, (baseSha) -> freshResultObject]. Colons in the
// prefixes disambiguate siblings (`gate:` never matches `gate-verify:` etc.), but the list is
// ordered specific-first defensively. Every generator returns a FRESH object per call so the
// harness can never mutate a shared canned result across units.
const DEFAULTS = [
  [(l) => l === 'integration-worktree', (b) => ({ ok: true, sha: b })],
  [(l) => l.startsWith('setup:'), (b) => ({ ok: true, sha: b, state: 'ready' })],
  [(l) => l.startsWith('adopt-tip:'), (b) => ({ ok: true, sha: b })],

  [(l) => l.startsWith('opus-plan-check:'), () => ({ verdict: 'approve', trigger: 'none', guidance: '' })],
  [(l) => l.startsWith('plan-check:'), () => ({ verdict: 'approve', guidance: '' })],
  [(l) => l.startsWith('replan:'), () => ({ approach: 'x', files: [], testPlan: 'x', feasible: true })],
  [(l) => l.startsWith('plan:'), () => ({ approach: 'x', files: [], testPlan: 'x', feasible: true })],

  [(l) => l.startsWith('opus-gate-verify:'), () => verifyOk()],
  [(l) => l.startsWith('gate-verify:'), () => verifyOk()],
  [(l) => l.startsWith('verify:'), () => verifyOk()],

  [(l) => l.startsWith('opus-gate:'), () => ({ verdict: 'approve', trigger: 'none', directives: [], debt: [] })],
  [(l) => l.startsWith('gate:'), () => ({ verdict: 'approve', directives: [], debt: [] })],

  // Codex lane: the steering agent's report = S.impl + process metadata. The default is a clean
  // one-commit run; tests probing failure axes (exit!=0, no commits, limitHit, timeout) override
  // with their own `codex` block.
  [(l) => l.startsWith('codex-probe:'), () => ({ ok: true })],
  // The cross-model spec critique fires on EVERY fresh build whose risk is in planCheckRisk
  // (the shipped default is all three tiers), so it needs a default or every wave records four
  // spurious degradations. Clean-and-silent: ok with nothing to say, so the plan-check prompt
  // stays byte-identical to the no-critique form.
  [(l) => l.startsWith('codex-spec-review:'), () => ({ ok: true, questions: [], risks: [], notes: '' })],
  [(l) => l.startsWith('codex-build-retry:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-build:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-fix:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-gap-fix:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-opus-gate-fix:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-gate-fix:'), () => implCodexOk()],

  [(l) => l.startsWith('merge:'), (b) => mergeOk(b)],
  [(l) => l.startsWith('resolve:'), (b) => mergeOk(b)],
  [(l) => l.startsWith('integration-fix:'), (b) => mergeOk(b)],


  [(l) => l.startsWith('mirror:'), (b) => ({ ok: true, sha: b })],
  [(l) => l === 'preview-setup', (b) => ({ ok: true, sha: b })],
  [(l) => l.startsWith('provision:'), () => ({ ok: true })],
  [(l) => l === 'checkpoint', () => ({ ok: true })],
  // Large-payload fan-out: `<label>:partK` writers + `<label>:assemble` (harness checkpoint and the
  // conductor's persist-state/persist-plan alike; the conductor labels are matched by prefix).
  [(l) => l.startsWith('checkpoint:part') || l === 'checkpoint:assemble', () => ({ ok: true })],
  [(l) => l === 'skill-feedback', () => ({ ok: true })],   // conductor's degradation-region writer
  [(l) => l.startsWith('dossier-write:'), () => ({ ok: true })],
  [(l) => l.startsWith('issue-sync:'), () => ({ ok: true })],   // issue-mode wave-tail projection sweep
  [(l) => l.startsWith('explorer-write:'), () => ({ ok: true })],
  [(l) => l.startsWith('health-write:'), () => ({ ok: true })],
  [(l) => l.startsWith('design-write:'), () => ({ ok: true })],

  [(l) => l.startsWith('rescue-dossier:'), () => ({ attempted: 'a', evidence: 'e', hypothesis: 'h' })],
  [(l) => l.startsWith('dossier:'), () => ({ attempted: 'a', evidence: 'e', hypothesis: 'h' })],
  [(l) => l.startsWith('consult:'), () => ({ action: 'redirect', guidance: 'g' })],
  [(l) => l.startsWith('explorer:'), (b) => ({ findings: [], shaObserved: b })],
  [(l) => l.startsWith('health:'), () => ({ findings: [], fixUnits: [] })],
  [(l) => l.startsWith('flake:'), () => ({ runs: 3, flips: [] })],
  [(l) => l.startsWith('design:'), (b) => ({ findings: [], fixUnits: [], visionUsed: true, shaObserved: b })],
]

const verifyOk = () => ({ pass: true, blocked: false, failures: [], contractSurfaceTouched: false, diffFiles: [] })
const implOk = () => ({ summary: 'done', filesChanged: [] })
export const codexMetaOk = () => ({ exitCode: 0, commits: 1, turns: 1, inputTokens: 0, outputTokens: 0,
  timedOut: false, doneMarker: true, limitHit: false, sessionCaptured: true, error: '' })
export const implCodexOk = () => ({ ...implOk(), codex: codexMetaOk() })
const mergeOk = (b) => ({ merged: true, suitePass: true, head: b, detail: '' })

const defaultFor = (label, baseSha) => {
  for (const [matches, make] of DEFAULTS) if (matches(label)) return make(baseSha)
  return undefined
}

// conformsToSchema — shallow: every schema.required key must exist on the result. Used to
// catch fake/schema drift (a canned result that forgot a field the harness now requires).
export function conformsToSchema(result, schema) {
  if (!schema || !Array.isArray(schema.required)) return true
  if (result === null || typeof result !== 'object') return false
  return schema.required.every((k) => k in result)
}

// makeAgent(rules, baseSha) — `fn` is the `agent` global. rules: [{match: RegExp (tested
// against opts.label), result: object | (prompt, opts) => object|Promise|throws}], first match
// wins; unmatched labels with no built-in default throw (fail-loud). A rule's result function
// may throw to inject errors (see structuredOutputError). Every invocation is recorded to
// `calls` at call time (so a deferred/parked result is still recorded in issue order).
export function makeAgent(rules = [], baseSha = BASE_SHA) {
  const calls = []
  const fn = (prompt, opts = {}) => {
    const label = opts.label ?? '(unlabeled)'
    calls.push({
      seq: nextSeq(),
      label,
      model: opts.model,
      effort: opts.effort,
      phase: opts.phase,
      prompt,
      hasSchema: !!opts.schema,
      schema: opts.schema,
    })
    return (async () => {
      const rule = rules.find((r) => r.match.test(label))
      let producer
      if (rule) {
        producer = rule.result
      } else {
        const d = defaultFor(label, baseSha)
        if (d === undefined)
          throw new Error(`fakes.makeAgent: unmatched label "${label}" — no rule and no built-in default (fail-loud)`)
        producer = d
      }
      let val = typeof producer === 'function' ? producer(prompt, opts) : producer
      val = await val // a throwing producer rejects here, before conformance
      if (opts.schema && !conformsToSchema(val, opts.schema))
        throw new Error(
          `fakes.makeAgent: canned result for "${label}" violates its schema — ` +
            `required=${JSON.stringify(opts.schema.required)} got keys=${JSON.stringify(Object.keys(val ?? {}))}`,
        )
      return val
    })()
  }
  return { fn, calls }
}

// makeWorkflow(handler) — `fn` is the `workflow` global. Records {seq, scriptPath, args} and
// returns handler(args, callIndex). (Unused by harness.test.mjs — the harness never nests —
// but part of the frozen surface conductor.test.mjs depends on.)
export function makeWorkflow(handler) {
  const calls = []
  let idx = 0
  const fn = (ref, args) => {
    const callIndex = idx++
    calls.push({ seq: nextSeq(), scriptPath: ref?.scriptPath ?? ref, args })
    return handler(args, callIndex)
  }
  return { fn, calls }
}

// Every delegation must pin a real model tier — an omitted model silently inherits the
// main-loop (frontier) model on the real platform.
export function assertAllModelsPinned(calls) {
  const ok = new Set(['fable', 'opus', 'sonnet', 'haiku'])
  for (const c of calls)
    assert.ok(ok.has(c.model), `call "${c.label}" (seq ${c.seq}) has an unpinned/invalid model: ${JSON.stringify(c.model)}`)
}

// Every delegation must carry a schema — the harness never parses prose.
export function assertSchemasPresent(calls) {
  for (const c of calls) assert.ok(c.hasSchema, `call "${c.label}" (seq ${c.seq}) is missing a schema`)
}

// An error whose message contains 'StructuredOutput' — the harness's run() wrapper retries
// exactly these once (any other error propagates). Used to pin the retry contract.
export function structuredOutputError() {
  return new Error('fake agent failure: StructuredOutput report failed validation (payload too long)')
}
