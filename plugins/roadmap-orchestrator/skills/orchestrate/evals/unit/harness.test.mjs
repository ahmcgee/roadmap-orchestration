// Zero-token control-flow simulation of harness.mjs. These lock the harness's deterministic
// scheduling / quarantine-routing / merge-serialization / debt-accounting logic against the
// UNMODIFIED harness — any red here is a fake/assumption bug, never a harness bug (the harness
// is the source of truth; expectations are matched to the source, not the reverse).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from './load.mjs'
import {
  makeAgent,
  sidecarRows,
  assertAppendVerified,
  BASE_SHA,
  assertAllModelsPinned,
  assertSchemasPresent,
  structuredOutputError,
  implCodexOk,
  assertCksumVerified,
} from './fakes.mjs'

// Codex is the only implementer: the code-writing labels are `codex-build:`/`codex-fix:` and
// friends, driven by cheap Haiku steering agents. `impl:`/`fix:`/`review:`/`debt-fix:` no longer
// exist anywhere in the harness, so every assertion below reads the steering labels instead.
// Verify results must carry `diffFiles` (S.verify requires it — it feeds envelope pinning).
const VERIFY_OK = { pass: true, blocked: false, failures: [], contractSurfaceTouched: false, diffFiles: [] }
const VERIFY_FAIL = (failures = ['boom']) => ({ pass: false, blocked: false, failures, contractSurfaceTouched: false, diffFiles: [] })
// There is no review stage any more, so a fix round is forced by failing the mechanical verify
// once and passing on the next round — the only remaining route into the polish loop's fix step.
const failThenPass = (failures = ['boom']) => {
  let n = 0
  return () => (n++ === 0 ? VERIFY_FAIL(failures) : VERIFY_OK)
}

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))

// ---- fixtures ---------------------------------------------------------------------------
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

// Run a wave. Audits are disabled by default (gateAuditRate:0) so low-risk units take the
// deterministic Opus-first gate path; test 8 opts back in explicitly.
async function runWave(agentFn, plan, state, config = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config } }, agent: agentFn })
}

// A controllable deferred promise (for parking a stage mid-flight).
function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
// Flush all pending microtasks by yielding a macrotask turn.
const flush = () => new Promise((r) => setTimeout(r, 15))

const has = (calls, prefix) => calls.some((c) => c.label === prefix || c.label.startsWith(prefix))
const seqOf = (calls, prefix) => calls.find((c) => c.label === prefix || c.label.startsWith(prefix))?.seq

// =========================================================================================
// 1. Plan validation throws (before any agent call).
// =========================================================================================
test('1a validation: unknown edge reference throws', async () => {
  const { fn } = makeAgent()
  await assert.rejects(
    runWave(fn, makePlan([unit('a')], [{ from: 'ghost', to: 'a', type: 'semantic', mode: 'contract' }]), makeState()),
    /unknown unit/,
  )
})

test('1b validation: dependency cycle throws', async () => {
  const { fn } = makeAgent()
  await assert.rejects(
    runWave(
      fn,
      makePlan(
        [unit('a'), unit('b')],
        [
          { from: 'a', to: 'b', mode: 'contract' },
          { from: 'b', to: 'a', mode: 'contract' },
        ],
      ),
      makeState(),
    ),
    /cycle/,
  )
})

test('1c validation: self-referential existingBranch throws', async () => {
  const { fn } = makeAgent()
  await assert.rejects(
    runWave(fn, makePlan([unit('a', { existingBranch: 'unit/a' })]), makeState()),
    /own branch/,
  )
})

// =========================================================================================
// 2. Contract-edge scheduling: B(dep A) must not set up until A's merge resolves.
// =========================================================================================
test('2 contract-edge: dependent setup waits for the dependency merge to settle', async () => {
  const mergeA = deferred()
  const { fn, calls } = makeAgent([{ match: /^merge:a$/, result: () => mergeA.promise }])
  const plan = makePlan([unit('a'), unit('b')], [{ from: 'a', to: 'b', type: 'semantic', mode: 'contract' }])

  const p = runWave(fn, plan, makeState())
  await flush()
  assert.ok(has(calls, 'setup:a'), 'a should have set up')
  assert.ok(has(calls, 'merge:a'), 'a should be parked in the merge queue')
  assert.ok(!has(calls, 'setup:b'), 'b must NOT set up while A is unmerged')

  mergeA.resolve({ merged: true, suitePass: true, head: BASE_SHA, detail: '' })
  const state = await p
  assert.ok(has(calls, 'setup:b'), 'b sets up once A merged')
  assert.ok(seqOf(calls, 'setup:b') > seqOf(calls, 'merge:a'), 'setup:b ordered after merge:a')
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')
  assertAllModelsPinned(calls)
  assertSchemasPresent(calls)
})

// =========================================================================================
// 3. verify.blocked -> env quarantine, zero fix rounds, dossier + dossier-write both issued.
// =========================================================================================
test('3 blocked verify: env quarantine with dossier pair, no fix', async () => {
  const { fn, calls } = makeAgent([
    { match: /^verify:a/, result: () => ({ pass: false, blocked: true, failures: [], contractSurfaceTouched: false, diffFiles: [] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /blocked/)
  assert.match(state.units.a.reason, /environment/)
  assert.ok(!has(calls, 'codex-fix:'), 'no fix rounds on a blocked verify')
  assert.ok(has(calls, 'dossier:a'), 'investigative dossier issued')
  assert.ok(has(calls, 'dossier-write:a'), 'verbatim dossier writer issued')
})

// =========================================================================================
// 4. setup {ok:false, state:'has-commits'} -> quarantine, no plan/impl.
// =========================================================================================
test('4 has-commits setup: quarantine, no plan/impl', async () => {
  const { fn, calls } = makeAgent([
    { match: /^setup:a/, result: () => ({ ok: false, state: 'has-commits', sha: BASE_SHA }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /has commits/)
  assert.ok(!has(calls, 'plan:'), 'no planning')
  assert.ok(!has(calls, 'codex-build:'), 'no implementation')
})

// =========================================================================================
// 5. adopt-tip mismatch: adopt-tip sha != adopted setup sha -> recreated-branch quarantine.
// =========================================================================================
test('5 adopt-tip mismatch: recreated-branch quarantine', async () => {
  const X = 'cccccccccccccccccccccccccccccccccccccccc'
  const Y = 'dddddddddddddddddddddddddddddddddddddddd'
  const { fn, calls } = makeAgent([
    { match: /^adopt-tip:a/, result: () => ({ ok: true, sha: X }) },
    { match: /^setup:a/, result: () => ({ ok: true, sha: Y, state: 'adopted' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a', { existingBranch: 'adopt/a' })]), makeState())
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /recreated/)
  assert.ok(!has(calls, 'codex-build:'), 'quarantined before any pipeline work')
})

// =========================================================================================
// 6. setup state:'already-merged' -> unit merged, no plan/impl.
// =========================================================================================
test('6 already-merged setup: short-circuits to merged', async () => {
  const { fn, calls } = makeAgent([
    { match: /^setup:a/, result: () => ({ ok: true, sha: BASE_SHA, state: 'already-merged' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'merged')
  assert.ok(!has(calls, 'plan:'), 'no planning')
  assert.ok(!has(calls, 'codex-build:'), 'no implementation')
  assert.ok(!has(calls, 'merge:a'), 'no merge-queue work — already merged')
})

// =========================================================================================
// 7. Merge queue strictly serial: merge:b never issues before merge:a settles.
// =========================================================================================
test('7 merge queue serial: merge:b waits for merge:a', async () => {
  const mergeA = deferred()
  const mergeB = deferred()
  const { fn, calls } = makeAgent([
    { match: /^merge:a$/, result: () => mergeA.promise },
    { match: /^merge:b$/, result: () => mergeB.promise },
  ])
  const p = runWave(fn, makePlan([unit('a'), unit('b')]), makeState())
  await flush()
  assert.ok(has(calls, 'merge:a'), 'merge:a issued')
  assert.ok(!has(calls, 'merge:b'), 'merge:b must NOT issue while merge:a is in flight')

  mergeA.resolve({ merged: true, suitePass: true, head: BASE_SHA, detail: '' })
  await flush()
  assert.ok(has(calls, 'merge:b'), 'merge:b issues once merge:a settled')
  assert.ok(seqOf(calls, 'merge:b') > seqOf(calls, 'merge:a'), 'merge:b ordered after merge:a')

  mergeB.resolve({ merged: true, suitePass: true, head: BASE_SHA, detail: '' })
  const state = await p
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')
})

// =========================================================================================
// 8. Audit-sample determinism: rate 1 -> forced Fable audit gate at auditEffort; rate 0 ->
//    Opus gate only. Identical across two runs.
// =========================================================================================
test('8 audit determinism: rate 1 forces low-effort Fable gate, rate 0 does not', async () => {
  const gateLabels = (calls) => calls.filter((c) => c.label.startsWith('gate:')).map((c) => `${c.label}|${c.model}|${c.effort}`)

  const runAt = async (rate) => {
    const { fn, calls } = makeAgent()
    // Pin auditEffort so the assertion tests the wiring (audit-only gate honours auditEffort,
    // distinct from gateEffort) independent of whatever the shipped default happens to be.
    await runWave(fn, makePlan([unit('a')]), makeState(), { gateAuditRate: rate, auditEffort: 'low' })
    return calls
  }

  const one = await runAt(1)
  assert.ok(has(one, 'gate:a'), 'rate 1 forces the Fable gate')
  const g = one.find((c) => c.label.startsWith('gate:a'))
  assert.equal(g.model, 'fable', 'forced audit gate runs on Fable')
  assert.equal(g.effort, 'low', 'audit-only gate runs at auditEffort (pinned low here)')
  assert.ok(!has(one, 'opus-gate:'), 'forced frontier skips the Opus gate')

  const zero = await runAt(0)
  assert.ok(!has(zero, 'gate:a'), 'rate 0 takes no Fable gate')
  assert.ok(has(zero, 'opus-gate:a'), 'rate 0 takes the Opus-first gate')

  // Determinism: re-run each and compare the gate signature.
  assert.deepEqual(gateLabels(await runAt(1)), gateLabels(one))
  assert.deepEqual(gateLabels(await runAt(0)), gateLabels(zero))
})

// =========================================================================================
// 8b. Opus effort wiring: implementEffort drives the Opus code-authoring calls that remain
//     (planning — the implementer itself is Codex now, steered at C.codexSteerModel), opusEffort
//     drives every other Opus call; both default to 'medium' and both honour a config override.
// =========================================================================================
test('8b opus effort wiring: implementEffort and opusEffort defaults + overrides', async () => {
  const effortOf = (calls, prefix) => calls.find((c) => c.label.startsWith(prefix))?.effort
  const modelOf = (calls, prefix) => calls.find((c) => c.label.startsWith(prefix))?.model

  const defaults = await (async () => {
    const { fn, calls } = makeAgent()
    await runWave(fn, makePlan([unit('a')]), makeState())
    return calls
  })()
  assert.equal(effortOf(defaults, 'plan:a'), 'medium', 'implementEffort defaults to medium')
  assert.equal(effortOf(defaults, 'opus-gate:a'), 'medium', 'opusEffort defaults to medium (gate)')
  assert.equal(effortOf(defaults, 'health:w'), 'medium', 'opusEffort defaults to medium (boundary)')
  // The steering agent is deliberately NOT on either Opus knob — it launches and watches a
  // process, it does not reason about the code.
  assert.equal(modelOf(defaults, 'codex-build:a'), 'haiku', 'the codex steering agent runs at codexSteerModel')
  assert.equal(effortOf(defaults, 'codex-build:a'), 'low', 'steering is a low-effort mechanical job')

  const overridden = await (async () => {
    const { fn, calls } = makeAgent()
    await runWave(fn, makePlan([unit('a')]), makeState(),
      { implementEffort: 'xhigh', opusEffort: 'low', codexSteerModel: 'sonnet' })
    return calls
  })()
  assert.equal(effortOf(overridden, 'plan:a'), 'xhigh', 'implementEffort override carried to the plan pass')
  assert.equal(effortOf(overridden, 'opus-gate:a'), 'low', 'opusEffort override carried to the Opus gate')
  assert.equal(effortOf(overridden, 'health:w'), 'low', 'opusEffort override carried to the boundary assessor')
  assert.equal(modelOf(overridden, 'codex-build:a'), 'sonnet', 'codexSteerModel override carried to the steering agent')
})

// =========================================================================================
// 9. Debt banking from every producer, with correct kind/severity.
// =========================================================================================
test('9 debt banking: every producer, contract mismatch -> kind contract / major', async () => {
  const { fn, calls } = makeAgent([
    // unit a: build debt (banks DIRECTLY now — the debt-fix sweep is gone), a forced fix round
    // (fix debt), opus-gate debt (with bankReason).
    { match: /^codex-build:a/, result: () => ({ ...implCodexOk(), debt: [{ what: 'impl-shortcut', kind: 'test', severity: 'minor' }] }) },
    { match: /^verify:a/, result: failThenPass() },
    { match: /^codex-fix:a/, result: () => ({ ...implCodexOk(), debt: [{ what: 'fix-shortcut', kind: 'structure', severity: 'minor' }] }) },
    { match: /^opus-gate:a/, result: () => ({ verdict: 'approve', trigger: 'none', directives: [], debt: [{ what: 'gate-defer', kind: 'ergonomics', severity: 'minor', bankReason: 'needs-migration-or-ruling' }] }) },
    // unit b: contract mismatch (banks contract/major), forces the Fable gate (gate debt —
    // non-correctness, so the approve stands; the correctness case has its own test below).
    { match: /^codex-build:b/, result: () => ({ ...implCodexOk(), contractMismatch: 'auth surface expects a field reality lacks' }) },
    // A contract mismatch now ALSO rides the escalation ladder (tier-2 by construction: only the
    // architect may rule on a frozen surface), so unit b takes a consult before its gate.
    { match: /^gap-consult:b#1/, result: () => ({ action: 'confirm', guidance: 'the surface stands as frozen' }) },
    { match: /^gate:b/, result: () => ({ verdict: 'approve', directives: [], debt: [{ what: 'gate-defer-b', kind: 'structure', severity: 'minor', bankReason: 'needs-migration-or-ruling' }] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())
  const debt = state.debt
  const find = (pred) => debt.find(pred)

  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.units.b.status, 'merged')
  // The mismatch reached the architect rather than only the gate, and it skipped cheap triage.
  assert.ok(calls.some((c) => c.label === 'gap-consult:b#1'), 'a contract mismatch pulls the architect in')
  assert.ok(!calls.some((c) => c.label === 'adjudicate:b#1'),
    'and skips Opus triage — no adjudicator confined to this unit may rule on a surface binding every unit')
  assert.equal(sidecarRows(calls, 'escalations').find((e) => e.unit === 'b')?.boundary, 'contract',
    'the escalation SIDECAR records which boundary was crossed')
  assert.equal(state.escalationStops?.b, 1,
    'and state.json keeps only the stop count the three-strikes brake reads')
  assert.equal(state.escalations, undefined, 'the ruling rows themselves never enter state.json')
  // The post-implement debt-fix sweep is gone with the Claude lane: the Codex brief's SCOPE
  // already demands in-scope fixing before the run reports done, so a surviving confession is
  // out-of-scope BY DECLARATION and goes straight to the ledger. A sweep round here would only
  // be an invitation to widen the diff.
  assert.ok(!calls.some((c) => c.label.startsWith('debt-fix:')), 'no debt-fix sweep exists any more')
  assert.ok(find((d) => d.kind === 'contract' && d.severity === 'major' && /contract mismatch/i.test(d.what)), 'contract mismatch -> contract/major')
  assert.ok(find((d) => d.kind === 'test' && d.what === 'impl-shortcut'), 'the build report\'s confession banks directly')
  assert.ok(find((d) => d.kind === 'structure' && d.what === 'fix-shortcut'), 'fix-round debt banked')
  assert.ok(find((d) => d.kind === 'ergonomics' && d.what === 'gate-defer'), 'opus-gate debt banked')
  assert.ok(find((d) => d.kind === 'structure' && d.what === 'gate-defer-b'), 'fable-gate debt banked')
})

// DELETED: '9b no implementer debt -> no debt-fix round'. The debt-fix sweep no longer exists
// (there is no Claude implementer to re-dispatch), so there is no round to suppress. Test 9's
// `no debt-fix sweep exists any more` assertion carries what remains of the coverage.

// Debt classification must never be a verdict-downgrade path for correctness findings: a gate
// that approves while holding a kind:'correctness' debt item is coerced to revise (rounds
// remaining) and, at the round cap, escalates (Opus) or banks loudly at severity:major (Fable).
test('9c fable gate approve+correctness debt: coerced revise, then banks loudly at the cap', async () => {
  const { fn, calls } = makeAgent([
    { match: /^gate:a/, result: () => ({ verdict: 'approve', directives: [],
      debt: [{ what: 'phantom-flavour-bug', kind: 'correctness', severity: 'minor', bankReason: 'needs-migration-or-ruling' }] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { exitGate: 'always-fable' })

  assert.equal(state.units.a.status, 'merged', 'frontier-approved work is banked-loud, never quarantined')
  assert.ok(calls.some((c) => c.label === 'codex-gate-fix:a#0'), 'round 0 approve was coerced to a revise round')
  assert.ok(calls.some((c) => c.label === 'gate:a#1'), 'the unit was re-gated after the coerced fix')
  const banked = state.debt.find((d) => d.what === 'phantom-flavour-bug')
  assert.ok(banked, 'at the round cap the item banks rather than quarantining approved work')
  assert.equal(banked.severity, 'major', 'correctness debt banked at the cap is promoted to major')
  assert.ok(state.degradations.some((d) => d.kind === 'correctness-debt-banked'),
    'the cap-bank is LOUD — it lands in the skill-feedback ledger')
})

test('9d opus gate approve+correctness debt: coerced revise, then escalates to the frontier gate', async () => {
  const { fn, calls } = makeAgent([
    { match: /^opus-gate:a/, result: () => ({ verdict: 'approve', trigger: 'none', directives: [],
      debt: [{ what: 'owner-check-missing', kind: 'correctness', severity: 'minor', bankReason: 'out-of-scope-file' }] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'merged')
  assert.ok(calls.some((c) => c.label === 'codex-opus-gate-fix:a#0'), 'round 0 approve was coerced to a revise round')
  assert.ok(calls.some((c) => c.label.startsWith('gate:a#')), 'at the cap the unit escalates to the Fable gate')
  assert.ok(!state.debt.some((d) => d.what === 'owner-check-missing'),
    'the correctness item became directives, never a ledger entry')
})

test('9e gate-fix debt is banked (was silently dropped)', async () => {
  const gateA = (() => {
    let n = 0
    return () => n++ === 0
      ? { verdict: 'revise', directives: [{ what: 'tighten the assertion', why: 'weak test' }], debt: [] }
      : { verdict: 'approve', directives: [], debt: [] }
  })()
  const { fn } = makeAgent([
    { match: /^gate:a/, result: gateA },
    { match: /^codex-gate-fix:a/, result: () => ({ ...implCodexOk(),
      debt: [{ what: 'gatefix-shortcut', kind: 'test', severity: 'minor' }] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { exitGate: 'always-fable' })
  assert.equal(state.units.a.status, 'merged')
  assert.ok(state.debt.some((d) => d.what === 'gatefix-shortcut'), 'a gate-fix round\'s confession reaches the ledger')
})

// =========================================================================================
// 10. contractMismatch fires consult (fable) + forces the Fable gate; gate prompt carries text.
// =========================================================================================
test('10 contract mismatch: consult + forced Fable gate carrying the mismatch text', async () => {
  const MISMATCH = 'FROZEN_SURFACE_MISMATCH_XYZ'
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a/, result: () => ({ ...implCodexOk(), contractMismatch: MISMATCH }) },
    { match: /^verify:a/, result: failThenPass(['x']) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'merged')

  const consult = calls.find((c) => c.label.startsWith('consult:'))
  assert.ok(consult, 'a consult fired')
  assert.equal(consult.model, 'fable', 'consult is a Fable call')

  const gate = calls.find((c) => c.label.startsWith('gate:a'))
  assert.ok(gate, 'the Fable gate was forced')
  assert.equal(gate.model, 'fable')
  assert.ok(gate.prompt.includes(MISMATCH), 'gate prompt carries the mismatch text')
  assert.ok(!has(calls, 'opus-gate:'), 'contract mismatch forces frontier, skipping the Opus gate')
})

// =========================================================================================
// 11. Boundary block: health-only present; boundary:'off' absent; all boundary jobs throw absent.
// =========================================================================================
test('11a boundary: no preview -> explorer skipped, health block present', async () => {
  const { fn } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.ok(state.boundary, 'boundary block present')
  assert.equal(state.boundary.explorer, null, 'no preview -> explorer null')
  assert.ok(state.boundary.health, 'health ran')
})

test('11b boundary: config off -> block absent', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' })
  assert.equal(state.boundary, undefined, 'boundary omitted when off')
  assert.ok(!has(calls, 'health:'), 'no health assessor when boundary off')
})

test('11c boundary: all jobs throw -> block absent', async () => {
  const boom = () => {
    throw new Error('boundary agent down')
  }
  const { fn } = makeAgent([
    { match: /^explorer:/, result: boom },
    { match: /^health:/, result: boom },
    { match: /^flake:/, result: boom },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.boundary, undefined, 'boundary omitted when every job failed')
})

// =========================================================================================
// 12. Spend seeding: numeric prior spend carries, junk keys drop.
// =========================================================================================
test('12 spend seeding: numeric carry-over, junk dropped', async () => {
  const { fn } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), makeState({ spend: { opus: 5, junk: 'x' } }))
  assert.ok(state.spend.opus >= 5, 'prior numeric opus spend seeded and accumulated')
  assert.ok(!('junk' in state.spend), 'non-numeric key dropped')
})

// =========================================================================================
// 13. Checkpoint coalescing: writes well under the checkpoint()-site count; last write == return.
// =========================================================================================
test('13 checkpoint coalescing: fewer writes than status changes, last write equals return', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())
  const cps = calls.filter((c) => c.label === 'checkpoint')
  assert.ok(cps.length >= 1, 'at least one checkpoint write')
  // Two merged units drive ~17 checkpoint() invocations (1 running + 5 stages + merge-queue +
  // terminal, per unit, + the final). Coalescing must collapse them below that ceiling.
  assert.ok(cps.length < 17, `expected coalescing below 17 writes, saw ${cps.length}`)

  const last = cps[cps.length - 1]
  const embedded = last.prompt.slice(last.prompt.indexOf('<<<DOCUMENT>>>\n') + '<<<DOCUMENT>>>\n'.length)
  const emb = JSON.parse(embedded)
  const ret = JSON.parse(JSON.stringify(state))
  // The final checkpoint (harness.mjs ~L1034) snapshots serialize() and THEN its own haiku
  // write executes — incrementing spend.haiku by exactly one after the snapshot. That single
  // "field written after" is the only difference; everything load-bearing must match.
  assert.equal(ret.spend.haiku, emb.spend.haiku + 1, 'only the final checkpoint write postdates the snapshot')
  emb.spend.haiku = ret.spend.haiku
  // The RETURN value carries this wave's degradations for the conductor; the persisted document
  // deliberately does not (they are append-only sidecar rows). Compare the rest.
  delete ret.degradations

  assert.deepEqual(emb, ret, 'final checkpoint payload equals the returned state (modulo its own write)')
})

// A 54-unit arc's state exceeded one response's ~32k output-token cap and killed 5 checkpoint
// agents silently; the staged single-writer that replaced it then failed ~28 checkpoints in two
// waves once state reached 3–6 parts ("cannot complete within token budget"). Large states must
// FAN OUT: one writer per line-boundary part (each ≤ ~WRITE_CHUNK of output), then one assembler
// that runs only after every part landed; small states get one here-doc writer. Every writer is cksum-verified (13c).
const bigState = () => makeState({ wave: 1, units: Object.fromEntries(Array.from({ length: 400 }, (_, i) =>
  [`old-${i}`, { status: 'merged', reason: `synthetic terminal record ${'x'.repeat(200)} #${i}` }])) })
const HERE_DOC = (file) => `cat > ${file} <<'ROADMAP_PART'`

test('13b large-state checkpoint: fan-out — one bounded writer per part, assembler last, lossless', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), bigState())

  assert.ok(!calls.some((c) => c.label === 'checkpoint' && c.prompt.includes('<<<PART')),
    'no single agent is ever handed the whole multi-part document')
  // The last checkpoint is the fan-out for the final state: its assembler is the last agent call
  // and its part writers are the contiguous run of `checkpoint:partK` calls before it.
  const asm = calls[calls.length - 1]
  assert.equal(asm.label, 'checkpoint:assemble', 'the assembler is the final call of the wave')
  let i = calls.length - 2
  while (i >= 0 && calls[i].label.startsWith('checkpoint:part')) i--
  const writers = calls.slice(i + 1, calls.length - 1)
  const n = writers.length
  assert.ok(n >= 3, `a ~100 KB state fans out to several writers (saw ${n})`)
  assert.deepEqual(writers.map((w) => w.label), Array.from({ length: n }, (_, k) => `checkpoint:part${k + 1}`),
    'writers are labelled checkpoint:part1..N in order')
  for (const w of [...writers, asm]) {
    assert.equal(w.model, 'haiku', `${w.label} runs on haiku`)
    assert.ok(w.hasSchema && w.schema.required?.includes('ok'), `${w.label} reports through S.ok`)
  }

  const bodies = writers.map((w, k) => {
    const marker = `<<<PART ${k + 1}/${n}>>>\n`
    const at = w.prompt.indexOf(marker)
    assert.ok(at > 0, `writer ${k + 1} carries its own part marker`)
    const body = w.prompt.slice(at + marker.length)
    assert.ok(w.prompt.length <= 24000 + 1500, `writer ${k + 1}'s whole prompt stays near the chunk bound (${w.prompt.length})`)
    assert.ok(body.length <= 24000 + 500, `part ${k + 1} stays near the chunk bound (${body.length})`)
    // Each writer: ONE quoted here-doc into ITS OWN part file, its own byte count, and no other file.
    const file = `/repo/.roadmap/state.json.part${k + 1}`
    assert.ok(w.prompt.includes(HERE_DOC(file)), `part ${k + 1} is written via a quoted here-doc to ${file}`)
    assert.ok(!w.prompt.includes(`cat > /repo/.roadmap/state.json <<`) && !w.prompt.includes('cat >>'),
      `part ${k + 1} never touches state.json itself, and never appends`)
    // Verified by cksum of the part file (its text + the here-doc's trailing newline), never byte count.
    assertCksumVerified(w.prompt, file, `${body}\n`, `writer ${k + 1}`)
    return body
  })

  // The assembler: cats the parts IN ORDER into state.json, checks the total, removes the parts.
  const files = Array.from({ length: n }, (_, k) => `/repo/.roadmap/state.json.part${k + 1}`)
  assert.ok(asm.prompt.includes(`cat ${files.join(' ')} > /repo/.roadmap/state.json`), 'assembler cats the parts in order')
  assert.ok(asm.prompt.includes('On success run `rm -f /repo/.roadmap/state.json.part*`'),
    'assembler removes the part files on success by glob — stale parts from an earlier fan-out with a different count go too')
  assert.match(asm.prompt, /On a mismatch leave the part files in place/, 'a failed assembly leaves the parts for inspection')
  const joined = bodies.join('\n')
  // The assembled file is the cat of the parts = the document + one trailing newline; verified by cksum.
  assertCksumVerified(asm.prompt, '/repo/.roadmap/state.json', `${joined}\n`, 'the assembler')
  assert.ok(!asm.prompt.includes('<<<PART'), 'the assembler is never handed the document itself')

  const reassembled = JSON.parse(joined)
  const ret = JSON.parse(JSON.stringify(state))
  // Same accounting as test 13, but the final write is n writers + 1 assembler after the snapshot.
  assert.equal(ret.spend.haiku, reassembled.spend.haiku + n + 1, 'only the final fan-out postdates the snapshot')
  reassembled.spend.haiku = ret.spend.haiku
  // The RETURN value carries this wave's degradations for the conductor; the persisted document
  // deliberately does not (they are append-only sidecar rows). Compare the rest.
  delete ret.degradations

  assert.deepEqual(reassembled, ret, 'the parts reassemble to the returned state')
})

test('13e a part lost twice: retried once by a fresh agent, no assembler, write-failed names it', async () => {
  const { fn, calls } = makeAgent([
    { match: /^checkpoint:part2$/, result: { ok: false, detail: 'wc printed 24071' } },
    { match: /^checkpoint:part2#retry$/, result: { ok: false, detail: 'cksum printed 9 24071' } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), bigState())
  assert.equal(state.units.a.status, 'merged', 'the wave completes despite the failed write')
  assert.ok(calls.some((c) => c.label === 'checkpoint:part1'), 'the fan-out fired')
  // Every checkpoint of the wave loses part 2 (the rule is label-keyed): each one retries part 2
  // exactly once and retries nothing else.
  const retries = calls.filter((c) => c.label.endsWith('#retry'))
  assert.ok(retries.length >= 1, 'the lost part is retried')
  assert.ok(retries.every((c) => c.label === 'checkpoint:part2#retry'), 'only the lost part is retried — never a part that landed')
  assert.equal(retries.length, calls.filter((c) => c.label === 'checkpoint:part2').length, 'one retry per loss, never a second')
  assert.ok(!calls.some((c) => c.label === 'checkpoint:assemble'), 'a lost part means NO assembler — never a partial state.json')
  const d = state.degradations.filter((x) => x.label === 'checkpoint' && x.kind === 'write-failed')
  assert.ok(d.length >= 1, 'the loss is ledgered under the top-level label')
  assert.match(d[0].what, /part 2\/\d+: cksum printed 9 24071/, 'the degradation names the failed part with the RETRY\'s reason')
  assert.ok(!d[0].what.includes('wc printed 24071'), 'the first attempt\'s reason is superseded by the retry\'s')
  assert.match(d[0].what, /assembly skipped, previous file left intact/, 'and says what that means on disk')
})

// A mis-transcription is per-sample stochastic (live: 2 of 16 part writes, a fresh sample of the same
// part succeeded), so one lost part costs one more writer, not the whole checkpoint.
test('13f a part lost once: the fresh-agent retry lands, the assembler runs, nothing is ledgered', async () => {
  const { fn, calls } = makeAgent([{ match: /^checkpoint:part2$/, result: { ok: false, detail: 'cksum printed 9 24071' } }])
  const state = await runWave(fn, makePlan([unit('a')]), bigState())
  assert.equal(state.units.a.status, 'merged')
  const retries = calls.filter((c) => c.label.endsWith('#retry'))
  assert.ok(retries.every((c) => c.label === 'checkpoint:part2#retry'), 'only the lost part is retried')
  assert.ok(!(state.degradations ?? []).some((x) => x.kind === 'write-failed'), 'a recovered part is not a degradation')
  // Same shape as 13b: the final checkpoint is the last run of `checkpoint:part*` calls (the retry
  // among them, after every first-pass writer) closed by the assembler.
  const asm = calls[calls.length - 1]
  assert.equal(asm.label, 'checkpoint:assemble', 'the assembler runs once every part has landed')
  let i = calls.length - 2
  while (i >= 0 && calls[i].label.startsWith('checkpoint:part')) i--
  const run = calls.slice(i + 1, calls.length - 1)
  const writers = run.filter((c) => !c.label.endsWith('#retry'))
  const n = writers.length
  assert.deepEqual(run.map((w) => w.label),
    [...Array.from({ length: n }, (_, k) => `checkpoint:part${k + 1}`), 'checkpoint:part2#retry'],
    'first pass in order, then the single retry, then the assembler')
  const p2 = writers.find((c) => c.label === 'checkpoint:part2')
  assert.equal(run[run.length - 1].prompt, p2.prompt, 'the retry is handed the identical part prompt')
  // Spend: the recovered checkpoint is n writers + 1 retry + 1 assembler, every call tallied. (13b's
  // snapshot-relative arithmetic is not repeated here: an earlier checkpoint's retry+assembler can
  // still be in flight when the final target is serialized, so its offset is timing-dependent.)
  assert.equal(run.length + 1, n + 2, 'the fan-out costs n + 2 Haiku calls')
  assert.equal(state.spend.haiku, calls.filter((c) => c.model === 'haiku').length, 'the retry is tallied like any writer')
})

// The single-write path is one Haiku writer copying the whole document through the SAME quoted
// here-doc as a part writer, cksum-verified. It used to be an unverified "Overwrite the file … with
// exactly this JSON" — and a file-write tool de-escaped \" inside string values, arc-observed.
test('13c small-state checkpoint: one here-doc writer, cksum-verified, no fan-out', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  const last = calls.filter((c) => c.label === 'checkpoint').pop()
  assert.ok(last.prompt.startsWith('Write the file /repo/.roadmap/state.json so its content is EXACTLY the JSON document below'),
    'below the chunk threshold one writer is handed the whole document')
  assert.ok(!last.prompt.includes('<<<PART'), 'no chunk markers on a small state')
  assert.ok(!calls.some((c) => c.label.startsWith('checkpoint:')), 'no part writers or assembler')
  assert.ok(last.prompt.includes(HERE_DOC('/repo/.roadmap/state.json')), 'written through a single-quoted here-doc')
  assert.match(last.prompt, /never echo, printf, or a file-write\/edit tool \(a file-write tool re-interprets escapes\)/,
    'the writer is told why a file-write tool is forbidden')
  const marker = '<<<DOCUMENT>>>\n'
  const at = last.prompt.indexOf(marker)
  assert.ok(at > 0, 'the document follows a marker line')
  const body = last.prompt.slice(at + marker.length)
  JSON.parse(body)   // the embedded document is the state itself, intact
  assertCksumVerified(last.prompt, '/repo/.roadmap/state.json', `${body}\n`, 'the single writer')
})

test('13d a failed checkpoint write degrades loudly but never blocks the wave', async () => {
  const { fn } = makeAgent([{ match: /^checkpoint$/, result: { ok: false, detail: 'disk full' } }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'merged', 'the wave completes despite the failed write')
  assert.ok(state.degradations.some((d) => d.label === 'checkpoint' && d.kind === 'write-failed'),
    'the loss is ledgered, not silent')
})

// =========================================================================================
// 14. Stringified args behave identically to object args.
// =========================================================================================
test('14 stringified args: identical result to object args', async () => {
  const plan = makePlan([unit('a')])
  const state = makeState()
  const config = { gateAuditRate: 0 }

  const runnerA = await loadScript(HARNESS)
  const objState = await runnerA({ args: { plan, state, config }, agent: makeAgent().fn })

  const runnerB = await loadScript(HARNESS)
  const strState = await runnerB({ args: JSON.stringify({ plan, state, config }), agent: makeAgent().fn })

  assert.deepEqual(strState, objState)
})

// =========================================================================================
// 15. Integration-tip reconciliation: git tip wins over the checkpointed tip.
// =========================================================================================
test('15 integration-tip reconciliation: reported git sha overrides checkpointed tip', async () => {
  const OTHER = 'ffffffffffffffffffffffffffffffffffffffff'
  const { fn } = makeAgent([{ match: /^integration-worktree$/, result: () => ({ ok: true, sha: OTHER }) }])
  // Zero units so nothing forks/merges to move the tip again — isolate the reconciliation.
  const state = await runWave(fn, makePlan([]), makeState(), { boundary: 'off' })
  assert.equal(state.integrationTip, OTHER, 'integrationTip reconciled to the reported git sha')
})

// =========================================================================================
// 16. Preview failure never gates: preview.status 'failed', unit still merges.
// =========================================================================================
test('16 preview failure: status failed, unit outcome unchanged', async () => {
  const { fn } = makeAgent([{ match: /^preview-setup$/, result: () => ({ ok: false, sha: BASE_SHA }) }])
  const plan = makePlan([unit('a')], [], { preview: { kind: 'server', start: 'run', howToAccess: 'http://x' } })
  const state = await runWave(fn, plan, makeState())
  assert.equal(state.preview.status, 'failed', 'preview marked failed')
  assert.equal(state.units.a.status, 'merged', 'unit outcome unaffected by preview failure')
})

// =========================================================================================
// 17. StructuredOutput retry (once, spend counts both); other errors quarantine as pipeline-error.
// =========================================================================================
test('17 StructuredOutput retry counts twice; a plain build-steering error quarantines the unit', async () => {
  const buildARetry = (() => {
    let n = 0
    return () => {
      if (n++ === 0) throw structuredOutputError()
      return implCodexOk()
    }
  })()
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a/, result: buildARetry },
    {
      match: /^codex-build:b/,
      result: () => {
        throw new Error('non-structured explosion')
      },
    },
    { match: /^commit-probe:b$/, result: { ok: false, sha: '', detail: 'no commits' } },
  ])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  // a: retried once, merged; the retry label appears; spend counts every agent call at the
  // steering tier (including the retry) — proving the double-count. The steering agent is Haiku
  // now, so the double-count lands on spend.haiku rather than spend.opus.
  assert.equal(state.units.a.status, 'merged')
  assert.ok(calls.some((c) => c.label === 'codex-build:a#retry'), 'retry label present')
  assert.equal(calls.filter((c) => c.label.startsWith('codex-build:a')).length, 2, 'original + retry recorded')
  assert.equal(state.spend.haiku, calls.filter((c) => c.model === 'haiku').length,
    'spend.haiku counts every haiku call incl. the steering retry')

  // b: the build steering call died and the branch has no commits, so quarantine is still correct.
  assert.equal(state.units.b.status, 'quarantined')
  assert.match(state.units.b.reason, /neither a report nor a commit/)
  // The original cause must still be RECOVERABLE. It reaches the degradation ledger; it no longer
  // reaches the quarantine reason, because the reason's cause lookup still filters on the removed
  // `impl:<id>` label (harness.mjs:1732) — see the report accompanying this suite. Assert what is
  // actually true, and assert it somewhere, so the evidence is not silently lost.
  assert.ok(state.degradations.some((d) => d.label === 'codex-build:b' && /non-structured explosion/.test(d.what)),
    'the real cause survives runOr into the degradation ledger')
})

// The 2026-07-18 regression this whole change exists to prevent: two units whose work was
// COMMITTED were quarantined because the reporting call died. The branch, not the report, is the
// evidence — so a lost report with commits present must proceed to judgment, and must force the
// frontier gate (the debt/contractMismatch signal died with the report).
test('18 lost build report + commits present -> unit proceeds and takes the frontier gate', async () => {
  const { fn, calls } = makeAgent([
    // every attempt fails, including the #retry and #salvage rescues — the real 2026-07-18 shape
    { match: /^codex-build:a/, result: () => { throw structuredOutputError() } },
    // the branch says the work landed
    { match: /^commit-probe:a$/, result: { ok: true, sha: BASE_SHA } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'merged', 'committed work must not be thrown away over a lost report')
  assert.ok(calls.some((c) => c.label === 'commit-probe:a'), 'the branch is asked before assuming the worst')
  assert.ok(calls.some((c) => c.label === 'gate:a#0'), 'a lost report forces the Fable gate, not the cheap Opus one')
  assert.ok(!calls.some((c) => c.label === 'opus-gate:a#0'), 'the Opus-first gate is skipped when evidence is missing')
  assert.match(calls.find((c) => c.label === 'gate:a#0').prompt, /report was lost/i,
    'the gate must be told the self-reported evidence is absent, not merely empty')
  assert.ok(state.degradations.some((d) => d.label === 'codex-build:a'), 'the loss is recorded, not silent')
  // A lost steering report is NOT a retryable codex run: buildStep's one fresh retry keys on the
  // process facts (exit != 0 with zero commits), which a lost report cannot supply.
  assert.ok(!calls.some((c) => c.label.startsWith('codex-build-retry:')), 'a lost report never triggers the fresh retry')
})

// `blocked` was a one-way door: nothing ever reset it, so a unit blocked behind a quarantine that
// was later superseded and merged stayed undispatchable for the rest of the arc. 2026-07-18
// stranded four in-scope units this way; the root un-stuck them by hand, twice.
test('19 blocked units re-enter dispatch once the blocking dependency resolves', async () => {
  const plan = makePlan([unit('dep'), unit('blocked')], [{ from: 'dep', to: 'blocked', mode: 'contract' }])

  // Wave 1: dep quarantines, so `blocked` is stamped blocked. The reviewer's `unsatisfiable`
  // channel is gone with the review stage, so the quarantine is forced through the setup fence
  // instead — the routing under test is blockedBy/ready(), not which fence fired.
  const { fn } = makeAgent([{ match: /^setup:dep$/, result: { ok: false, state: 'has-commits', sha: BASE_SHA } }])
  const w1 = await runWave(fn, plan, makeState(), { warmLanes: false })
  assert.equal(w1.units.dep.status, 'quarantined')
  assert.equal(w1.units.blocked.status, 'blocked')

  // Wave 2 resumes from that state with the dependency now merged (as a respec would leave it).
  // The stale `blocked` stamp must not outlive the condition that caused it.
  const { fn: fn2 } = makeAgent()
  const w2 = await runWave(fn2, plan, makeState({ wave: 1, units: { dep: { status: 'merged' }, blocked: { status: 'blocked' } } }))
  assert.equal(w2.units.blocked.status, 'merged', 'an unblocked unit must be dispatched, not stranded')
})

// Gate-review finding: reportLostEver was wired only at the impl site. A fix agent that dies every
// round leaves verify green, so the polish loop never breaks on failure and the unit reached the
// CHEAP gate carrying the (dead) debt/contractMismatch signal and nothing else. The fix round is
// now reached by failing verify once — there is no review stage to block through.
test('20 a lost FIX report also forces the frontier gate', async () => {
  const { fn, calls } = makeAgent([
    { match: /^verify:a/, result: failThenPass(['a real defect']) },
    { match: /^codex-fix:a/, result: () => { throw structuredOutputError() } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(calls.some((c) => c.label === 'codex-fix:a#0'), 'the failing verify drove exactly one fix round')
  assert.ok(calls.some((c) => c.label === 'gate:a#0'), 'a lost fix report must force the Fable gate')
  assert.ok(!calls.some((c) => c.label === 'opus-gate:a#0'), 'the cheap gate must not adjudicate missing evidence')
  assert.ok(state.degradations.some((d) => d.label === 'codex-fix:a#0'), 'the loss is ledgered')
})

// Gate-review finding: `deferred` was the same one-way door `blocked` was. The harness stamps it on
// any out-of-scope unit at first sight — including contingent units the conductor TRANSIENTLY
// withheld — and nothing reset it. A root replanning a withheld dependent back into scope got an
// arc that silently "completed" without ever dispatching it.
test('21 a stale `deferred` stamp on an in-scope unit is cleared at wave start', async () => {
  const { fn } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]),
    makeState({ wave: 1, units: { a: { status: 'deferred' } } }))
  assert.equal(state.units.a.status, 'merged', 'a unit the plan says is in scope must be dispatched')
})

// Degradations are EVENTS, not state. They used to ride inside state.json, arc-cumulative — a third
// of a 170-190 KB document by wave 19, re-transcribed at every checkpoint, so each row made the next
// write likelier to fail and each failure appended another row (91 lost checkpoints in one arc).
// Now: appended ONCE to .roadmap/degradations.jsonl at the moment they happen, carried back to the
// conductor in the return envelope, and absent from every persisted document.
test('22 degradations are sidecar rows: appended once, never serialized into state.json', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a/, result: () => { throw structuredOutputError() } },
    { match: /^commit-probe:a$/, result: { ok: true, sha: BASE_SHA } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState({ wave: 1 }))

  // The envelope carries this wave's rows; the checkpoint document carries none of them.
  assert.ok(state.degradations.some((d) => d.label === 'codex-build:a'), 'the loss rides back in the return envelope')
  for (const cp of calls.filter((c) => c.label === 'checkpoint'))
    assert.ok(!cp.prompt.includes('"degradations"'), 'no checkpoint document ever carries a degradation ledger')

  // One append per row, verified by cksum over the file's tail, and unable to reach prior rows.
  const rows = sidecarRows(calls, 'degradations')
  assert.ok(rows.some((d) => d.label === 'codex-build:a' && d.kind === 'schema-retry'),
    'the row itself, in full, is on disk in .roadmap/degradations.jsonl')
  assert.deepEqual(rows, state.degradations, 'the sidecar and the envelope agree exactly — one write per event')
  const app = calls.filter((c) => c.label === 'sidecar:degradations')
  assert.ok(app.length >= 1, 'the sidecar was written')
  const body = app[0].prompt.split('<<<APPEND>>>\n')[1]
  assertAppendVerified(app[0].prompt, '/repo/.roadmap/degradations.jsonl', `${body}\n`, 'the degradation sidecar writer')

  // A clean wave writes nothing at all.
  const { fn: fn2, calls: calls2 } = makeAgent()
  const clean = await runWave(fn2, makePlan([unit('a')]), makeState({ wave: 1 }))
  assert.deepEqual(clean.degradations, [], 'a clean wave has nothing to report')
  assert.equal(calls2.some((c) => c.label.startsWith('sidecar:')), false, 'and appends nothing')
})

// A lost sidecar append must NOT degrade — that would recurse into the mechanism that is failing.
// It is counted instead, in a state field that is loud and cannot feed itself.
test('22b a sidecar append lost twice is counted in state.sidecarLost, never re-degraded', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a/, result: () => { throw structuredOutputError() } },
    { match: /^commit-probe:a$/, result: { ok: true, sha: BASE_SHA } },
    { match: /^sidecar:degradations$/, result: { ok: false, detail: 'cksum printed 9 120' } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState({ wave: 1 }))
  assert.ok(state.sidecarLost >= 1, 'the loss is counted where a reader will see it')
  assert.equal(calls.filter((c) => c.label.startsWith('sidecar:')).length,
    calls.filter((c) => c.label === 'sidecar:degradations').length,
    'a failed degradation append never queues another one — no recursion')
  assert.ok(!state.degradations.some((d) => d.kind === 'sidecar-failed'),
    'and never becomes a degradation itself')
})
