// Zero-token control-flow simulation of harness.mjs. These lock the harness's deterministic
// scheduling / quarantine-routing / merge-serialization / debt-accounting logic against the
// UNMODIFIED harness — any red here is a fake/assumption bug, never a harness bug (the harness
// is the source of truth; expectations are matched to the source, not the reverse).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import {
  makeAgent,
  packRules,
  BASE_SHA,
  assertAllModelsPinned,
  assertSchemasPresent,
  structuredOutputError,
  implCodexOk,
} from './fakes.mjs'

// Codex is the only implementer: the code-writing labels are `codex-build:`/`codex-fix:` and
// friends, driven by cheap Haiku steering agents. `impl:`/`fix:`/`review:`/`debt-fix:` no longer
// exist anywhere in the harness, so every assertion below reads the steering labels instead.
// Verify results must carry `diffFiles` (S.verify requires it — it feeds envelope pinning).
const VERIFY_OK = { pass: true, blocked: false, failures: [], lanes: [{ command: 'npm run test:ci', exitCode: 0 }], contractSurfaceTouched: false, diffFiles: [] }
const VERIFY_FAIL = (failures = ['boom']) => ({ pass: false, blocked: false, failures, lanes: [{ command: 'npm run test:ci', exitCode: 1 }], contractSurfaceTouched: false, diffFiles: [] })
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
// deterministic Opus-first gate path; test 8 opts back in explicitly. `launchId` is the per-launch
// nonce the root is contracted to pass (it salts the environment probes out of resume's cache) —
// supplied here so every wave runs the way a correct root launches one; test 15d drops it on purpose.
async function runWave(agentFn, plan, state, config = {}, args = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config }, launchId: 'launch-1', ...args },
    agent: agentFn })
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
    { match: /^verify:a/, result: () => ({ pass: false, blocked: true, failures: [], lanes: [], contractSurfaceTouched: false, diffFiles: [] }) },
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
  // The wave-tail health assessor was the boundary's opusEffort call until 0.14.0 moved it onto
  // the codex role adapter. It is now a steering courier like every other codex dispatch, so it is
  // pinned to codexSteerModel/low here instead — a changed contract, not a weakened assertion:
  // opusEffort still drives the Opus gate above and the Opus plan-check.
  assert.equal(modelOf(defaults, 'health:w'), 'haiku', 'the boundary health role runs on codex, steered at codexSteerModel')
  assert.equal(effortOf(defaults, 'health:w'), 'low', 'steering is a low-effort mechanical job there too')
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
  assert.equal(modelOf(overridden, 'health:w'), 'sonnet', 'codexSteerModel override reaches the boundary role too')
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
  assert.equal((state.escalations ?? []).find((e) => e.unit === 'b')?.boundary, 'contract',
    'the returned escalation LEDGER records which boundary was crossed')
  assert.equal(state.escalationStops?.b, 1,
    'and state.json keeps only the stop count the three-strikes brake reads')
  const { degradations: _d, escalations: _e, ...serialized } = state
  assert.ok(!JSON.stringify(serialized).includes('"by"'),
    'the ruling rows themselves ride the envelope, never the state persist.mjs writes')
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
// 13. THE LAUNCH PACK. The root no longer pastes plan.json and state.json into `args` — it passes
//     an envelope naming the .roadmap directory, and the script's first act is a Haiku courier that
//     cats both files and reports each one's real `cksum`, which the script verifies IN CODE. The
//     conductor dispatches each wave with its live plan already in memory, so that NESTED path
//     passes both and reads no pack. Both halves are pinned here: a launch that silently accepted a
//     mis-transcribed plan, or one that re-read a stale plan.json over the conductor's, would be a
//     wave built on a document nobody checked.
// =========================================================================================
const packLabels = (calls) => calls.filter((c) => c.label.startsWith('pack-read:')).map((c) => c.label)

test('13 nested launch: an in-memory plan+state is used as-is, and no pack is read', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.deepEqual(packLabels(calls), [], 'the conductor path never re-reads a plan it is mutating in memory')
  assert.equal(state.units.a.status, 'merged')
})

test('13b root launch: the pack is read by one courier per file and verified by cksum', async () => {
  const plan = makePlan([unit('a')])
  const state = makeState()
  const { fn, calls } = makeAgent(packRules(plan, state))
  const out = await (await loadScript(HARNESS))({
    args: { roadmapDir: '/repo/.roadmap', launchId: 'L1', config: { gateAuditRate: 0 } },
    agent: fn,
  })
  assert.deepEqual(packLabels(calls), ['pack-read:plan.json', 'pack-read:state.json'],
    'one courier per file, no retry needed when the transcription is honest')
  const p = calls.find((c) => c.label === 'pack-read:plan.json')
  assert.equal(p.model, 'haiku', 'the pack read is floor-tier work')
  assert.match(p.prompt, /cksum < \/repo\/\.roadmap\/plan\.json/, 'the courier is asked for the file\'s own cksum')
  assert.match(p.prompt, /sed -n '1,\$p' \/repo\/\.roadmap\/plan\.json/, 'and for its content, over an explicit range')
  assert.match(p.prompt, /Probe id L1/, 'salted: a replayed pack would be the LAST run\'s plan')
  assert.match(p.prompt, /truncated copy is worse than no copy/, 'and told to refuse rather than truncate')
  assert.equal(out.units.a.status, 'merged', 'the wave then runs on exactly the plan it read')
})

test('13c a mis-transcribed pack file is re-read once, by a courier with a different prompt', async () => {
  const plan = makePlan([unit('a')])
  const state = makeState()
  const honest = packRules(plan, state)
  let firstTry = true
  const { fn, calls } = makeAgent([
    // The first plan.json courier drops a line — the exact shape cksum exists to catch.
    { match: /^pack-read:plan\.json$/, result: (prompt, opts) => {
      if (!firstTry) return honest[0].result(prompt, opts)
      firstTry = false
      const r = honest[0].result(prompt, opts)
      r.results[3].stdout = r.results[3].stdout.split('\n').slice(1).join('\n')
      return r
    } },
    ...honest,
  ])
  const out = await (await loadScript(HARNESS))({
    args: { roadmapDir: '/repo/.roadmap', launchId: 'L1', config: { gateAuditRate: 0 } },
    agent: fn,
  })
  assert.deepEqual(packLabels(calls),
    ['pack-read:plan.json', 'pack-read:state.json', 'pack-read:plan.json#retry'],
    'only the file that failed is re-read, and exactly once')
  const [first, retry] = calls.filter((c) => c.label.startsWith('pack-read:plan.json'))
  assert.notEqual(first.prompt, retry.prompt,
    'the retry prompt differs, or resumeFromRunId would serve the bad sample straight back')
  assert.match(retry.prompt, /did not match its cksum/, 'and says why it is being asked again')
  assert.equal(out.units.a.status, 'merged', 'the fresh sample lands and the wave proceeds')
})

test('13d a pack that never verifies fails the launch loudly — no wave on an unchecked plan', async () => {
  const plan = makePlan([unit('a')])
  const honest = packRules(plan, makeState())
  const { fn } = makeAgent([
    { match: /^pack-read:state\.json/, result: (prompt, opts) => {
      const r = honest[0].result(prompt, opts)
      r.results[3].stdout = `${r.results[3].stdout}\n{"junk":true}`
      return r
    } },
    ...honest,
  ])
  const runner = await loadScript(HARNESS)
  await assert.rejects(
    () => runner({ args: { roadmapDir: '/repo/.roadmap', launchId: 'L1', config: {} }, agent: fn }),
    /pack-unreadable[\s\S]*state\.json/,
    'an unverifiable pack throws by name rather than dispatching a wave',
  )
})

test('13e one of plan/state without the other is a caller bug, and says so', async () => {
  const runner = await loadScript(HARNESS)
  await assert.rejects(
    () => runner({ args: { plan: makePlan([unit('a')]), roadmapDir: '/repo/.roadmap' }, agent: makeAgent().fn }),
    /only one of plan\/state/,
  )
  await assert.rejects(
    () => runner({ args: { launchId: 'L1' }, agent: makeAgent().fn }),
    /roadmapDir is required/,
  )
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
// 15. Integration-tip reconciliation is STRICTLY ONE-WAY. It adopts the live branch tip only
//     when the checkpointed tip is an ancestor of it (the setup courier reports the raw
//     `merge-base --is-ancestor` exit code). Anything else is corruption — a rewound branch, or
//     merges that landed where no branch reaches them (2026-08-28, a merge on a detached HEAD) —
//     and the wave must halt before dispatch rather than adopt over its own record.
// =========================================================================================
const OTHER_SHA = 'ffffffffffffffffffffffffffffffffffffffff'
const intWorktree = (extra) => ({ match: /^integration-worktree$/, result: () => ({ ok: true, sha: OTHER_SHA, ...extra }) })

test('15a integration-tip reconciliation: adopts the live tip when the checkpointed tip is its ancestor', async () => {
  const { fn, calls } = makeAgent([intWorktree({ priorTipAncestorExit: 0 })])
  // Zero units so nothing forks/merges to move the tip again — isolate the reconciliation.
  const state = await runWave(fn, makePlan([]), makeState(), { boundary: 'off' })
  assert.equal(state.integrationTip, OTHER_SHA, 'integrationTip reconciled to the reported git sha')
  const probe = calls.find((c) => c.label === 'integration-worktree')
  assert.match(probe.prompt, /git merge-base --is-ancestor a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 roadmap\/session-test/,
    'the courier is handed the exact command, not asked whether the branch moved forward')
  assert.match(probe.prompt, /never rewind, reset or force the branch/, 'and is forbidden from making the answer zero')
})

test('15b integration-tip reconciliation: a tip that is NOT an ancestor halts the wave before dispatch', async () => {
  const { fn, calls } = makeAgent([intWorktree({ priorTipAncestorExit: 1 })])
  await assert.rejects(
    runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' }),
    /integration tip regressed/,
  )
  assert.ok(!has(calls, 'setup:a'), 'nothing dispatched onto a branch our own record cannot reach')
  assert.ok(!has(calls, 'provision:integration'), 'the wave stops at the reconcile, before provisioning')
})

test('15c integration-tip reconciliation: an unresolvable checkpointed tip (exit 128) halts too', async () => {
  const { fn } = makeAgent([intWorktree({ priorTipAncestorExit: 128 })])
  await assert.rejects(
    runWave(fn, makePlan([]), makeState(), { boundary: 'off' }),
    /exited 128/,
  )
})

test('15d equal shas need no ancestry answer — the reconcile does not fire', async () => {
  const { fn } = makeAgent([{ match: /^integration-worktree$/, result: () => ({ ok: true, sha: BASE_SHA, priorTipAncestorExit: 1 }) }])
  const state = await runWave(fn, makePlan([]), makeState(), { boundary: 'off' })
  assert.equal(state.integrationTip, BASE_SHA, 'an unchanged tip is never second-guessed')
})

// =========================================================================================
// 16. Preview failure never gates: preview.status 'failed', unit still merges.
// =========================================================================================
test('16 preview failure: status failed, unit outcome unchanged', async () => {
  const { fn } = makeAgent([{ match: /^preview-setup/, result: () => ({ ok: false, results: [] }) }])
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
// of a 170-190 KB document by wave 19, re-transcribed at every write, so each row made the next
// write likelier to fail and each failure appended another row (91 lost checkpoints in one arc).
// Now: collected in memory, handed to the conductor in the RETURN envelope, and absent from the
// state itself — persist.mjs is what appends them to .roadmap/degradations.jsonl, for free.
test('22 degradations ride the return envelope and are never serialized into the state', async () => {
  const { fn } = makeAgent([
    { match: /^codex-build:a/, result: () => { throw structuredOutputError() } },
    { match: /^commit-probe:a$/, result: { ok: true, sha: BASE_SHA } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState({ wave: 1 }))

  assert.ok(state.degradations.some((d) => d.label === 'codex-build:a' && d.kind === 'schema-retry'),
    'the row itself, in full, rides back in the return envelope')
  // serialize() is everything BUT the two event ledgers — that separation is what stops state.json
  // growing with the wave number.
  const { degradations, escalations, ...serialized } = state
  assert.ok(!JSON.stringify(serialized).includes('schema-retry'),
    'and no part of the persisted state carries a degradation ledger')

  // A clean wave has nothing to report, and says so with an empty array rather than an absence.
  const { fn: fn2 } = makeAgent()
  const clean = await runWave(fn2, makePlan([unit('a')]), makeState({ wave: 1 }))
  assert.deepEqual(clean.degradations, [], 'a clean wave has nothing to report')
  assert.deepEqual(clean.escalations, [], 'and no rulings to record')
})

// The escalation ledger takes the same route, and state.json keeps only the STOP COUNT the
// three-strikes brake actually reads.
test('22b escalation rulings ride the envelope; only the stop count is state', async () => {
  const { fn } = makeAgent([
    { match: /^plan-check:a$/, result: () => ({ verdict: 'redirect', guidance: 'g', notes: '' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a', { risk: 'high' })]), makeState({ wave: 1 }))
  assert.ok(state.escalations.some((e) => e.unit === 'a'), 'the ruling is in the envelope')
  assert.equal(state.escalationStops?.a, 1, 'the state keeps the count, not the rulings')
  const { degradations, escalations, ...serialized } = state
  assert.ok(!JSON.stringify(serialized).includes('"by"'), 'no ruling row survives into the state')
})

