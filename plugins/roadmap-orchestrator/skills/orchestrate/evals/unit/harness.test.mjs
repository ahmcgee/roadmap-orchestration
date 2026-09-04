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
  courierResult,
  courierSaying,
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
// Let the wave run until it parks on the deferred call this test is about, then give it one more
// full turn so a call that must NOT issue has had its chance to. `until` is polled rather than
// slept through: a fixed sleep is a race on a loaded box (it failed here at 15ms), and waiting
// LONGER for a call that should not exist only strengthens the negative assertions beneath.
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
const flush = async (until) => {
  const deadline = Date.now() + 5000
  do { await tick(5) } while (until && !until() && Date.now() < deadline)
  await tick(15)
}

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
  await flush(() => has(calls, 'merge:a'))
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
// 3. verify.blocked -> the unit BLOCKS (zero fix rounds, no dossier); a REPEAT quarantines.
// CHANGED CONTRACT (2026-09-04): tooling that could not run is a fact about the host, never a
// verdict about the unit, so the first blocked verify leaves the unit `blocked` with its commits
// intact and it is re-verified next wave. Only a second blocked verify — the tally start() carries
// across the wave boundary — buys the environment quarantine and its dossier pair.
// =========================================================================================
const blockedVerify = () =>
  ({ pass: false, blocked: true, failures: ['ENOTFOUND registry.npmjs.org'], lanes: [], contractSurfaceTouched: false, diffFiles: [] })

test('3a blocked verify: the unit blocks with its commits, no fix rounds, no dossier', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: blockedVerify }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'blocked', 'an environment failure is not a verdict about the unit')
  assert.equal(state.units.a.branch, 'unit/a', 'and its branch — with its commits — is named on the record')
  assert.equal(state.units.a.rounds?.verifyBlocked, 1, 'the blocked verify is tallied so a repeat is countable')
  assert.ok(!has(calls, 'codex-fix:'), 'no fix rounds on a blocked verify')
  assert.ok(!has(calls, 'dossier:a'), 'and no dossier — nothing about the unit was judged')
  const d = (state.degradations ?? []).find((x) => x.kind === 'verify-blocked')
  assert.match(d.what, /BLOCKED, not\s+quarantined/, 'the ledger says what happened')
  assert.match(d.what, /ENOTFOUND registry\.npmjs\.org/, 'and carries the verifier\'s own first failure line')
})

test('3b blocked AGAIN next wave: env quarantine with dossier pair, no fix', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: blockedVerify }])
  // Wave 2 for this unit: it entered blocked, with one blocked verify already on its record.
  const state = await runWave(fn, makePlan([unit('a')]),
    makeState({ wave: 1, units: { a: { status: 'blocked', rounds: { verifyBlocked: 1 } } } }))
  assert.equal(state.units.a.status, 'quarantined', 'twice is not transient — it is this checkout\'s problem')
  assert.match(state.units.a.reason, /blocked/)
  assert.match(state.units.a.reason, /environment/)
  assert.equal(state.units.a.rounds?.verifyBlocked, 2, 'the tally carried across the wave boundary')
  assert.ok(!has(calls, 'codex-fix:'), 'no fix rounds on a blocked verify')
  assert.ok(has(calls, 'dossier:a'), 'investigative dossier issued')
  assert.ok(has(calls, 'dossier-write:a'), 'verbatim dossier writer issued')
  // The FILE is the record; the state carries only its path. The dossier prose used to ride home
  // in the unit record too, and a handful of ~5 KB ones took an arc's state.json to 145 KB — past
  // what the launch courier can copy, so the arc could not be relaunched at all (2026-09-03).
  assert.equal(state.units.a.dossierPath, '/repo/.roadmap/quarantine/a.md',
    'the quarantined record names the dossier file the redesign tiers already read')
  assert.ok(!('dossier' in state.units.a), 'and carries none of its prose — state stays launchable')
  assert.ok(JSON.stringify(state).length < 4000,
    'a whole wave-1 state with a quarantine is still a small document, not a prose archive')
})

// =========================================================================================
// 4. setup {ok:false, state:'has-commits'} -> quarantine, no plan/impl.
// =========================================================================================
test('4 has-commits setup: quarantine, no plan/impl', async () => {
  // CHANGED CONTRACT (0.14.0): 'has-commits' is no longer a state an agent REPORTS — it is the
  // script's reading of two git probes, so the test states the git facts instead of the verdict.
  const { fn, calls } = makeAgent([
    { match: /^merged-probe:a$/, result: () => ({ ok: true, exitCodes: [0, 1, 0], out: [BASE_SHA] }) },
    { match: /^setup-commits:a$/, result: () => ({ ok: true, exitCodes: [0], out: ['3'] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /has commits/)
  assert.ok(!has(calls, 'setup:a'), 'nothing was touched — no worktree command was even composed')
  assert.ok(!has(calls, 'plan:'), 'no planning')
  assert.ok(!has(calls, 'codex-build:'), 'no implementation')
})

// =========================================================================================
// 5. adopt-tip mismatch: adopt-tip sha != adopted setup sha -> recreated-branch quarantine.
// =========================================================================================
test('5 adopt-tip mismatch: recreated-branch quarantine', async () => {
  // The pre-captured tip is a COURIER read now (`git rev-parse adopt/a^{commit}`), and the setup
  // courier's read-back HEAD is the other half of the comparison — both facts, neither a verdict.
  const X = 'cccccccccccccccccccccccccccccccccccccccc'
  const { fn, calls } = makeAgent([
    { match: /^adopt-tip:a$/, result: (p) => courierResult(p, X) },
  ])
  const state = await runWave(fn, makePlan([unit('a', { existingBranch: 'adopt/a' })]), makeState())
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /recreated/)
  assert.ok(!has(calls, 'codex-build:'), 'quarantined before any pipeline work')
})

// The adopt-tip invariant is EQUALITY at the fork (test 5 above) and ANCESTRY on re-entry (5b/5c).
// wf_ec56ce3b-59f: a relaunch re-entered a parked `existingBranch` unit whose earlier fix round had
// already landed two commits on unit/<id>, and the equality form quarantined it as "recreated" —
// destroying no work but refusing to continue any. On re-entry the worktree is on unit/<id>, not on
// existingBranch, so the fact that still has to hold is that unit/<id> CONTAINS the captured tip.
const adoptedReentry = (id, ancestorExit, head) => [
  // branch exists with commits beyond base + an existingBranch => the script's 'adopted' case.
  { match: new RegExp(`^merged-probe:${id}$`), result: () => ({ ok: true, exitCodes: [0, 1, 0], out: [head] }) },
  { match: new RegExp(`^setup-commits:${id}$`), result: () => ({ ok: true, exitCodes: [0], out: ['2'] }) },
  { match: new RegExp(`^setup:${id}$`),
    result: courierSaying([[/rev-parse HEAD/, head], [/merge-base --is-ancestor/, String(ancestorExit)]]) },
]

test('5b adopted re-entry: a unit branch that grew fix commits past existingBranch is NOT a mismatch', async () => {
  const NEW = 'f3adb46f3adb46f3adb46f3adb46f3adb46f3adb'   // two fix commits past the captured tip
  const { fn, calls } = makeAgent(adoptedReentry('a', 0, NEW))
  const state = await runWave(fn, makePlan([unit('a', { existingBranch: 'adopt/a' })]), makeState())
  assert.notEqual(state.units.a.status, 'quarantined',
    `an adopted branch ahead of its captured tip is the normal case — got: ${state.units.a.reason}`)
  assert.ok(has(calls, 'verify:a'), 'the unit re-enters the pipeline with its prior commits intact')
  const ancestry = calls.find((c) => c.label === 'setup:a').prompt
  assert.match(ancestry, /merge-base --is-ancestor [0-9a-f]{40} HEAD; echo \$\?/,
    'the ancestry fact is a command the SCRIPT composed, with the exit code printed by the shell')
})

test('5c adopted re-entry: a recreated existingBranch (not an ancestor) still quarantines', async () => {
  const NEW = 'f3adb46f3adb46f3adb46f3adb46f3adb46f3adb'
  const { fn, calls } = makeAgent(adoptedReentry('a', 1, NEW))
  const state = await runWave(fn, makePlan([unit('a', { existingBranch: 'adopt/a' })]), makeState())
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /does not contain pre-captured adopt\/a/)
  assert.match(state.units.a.reason, /recreated or force-moved/)
  assert.ok(!has(calls, 'verify:a'), 'quarantined before any pipeline work')
})

// =========================================================================================
// 6. Already-merged short-circuits to merged. CHANGED CONTRACT (0.14.0): the setup prompt's
//    'already-merged' CASE is gone — the second-parent test is `merged-probe`'s exit codes and the
//    script's reading of them, before a single worktree command is composed.
// =========================================================================================
test('6 already-merged: git answers before setup, and no worktree command is composed', async () => {
  const { fn, calls } = makeAgent([
    { match: /^merged-probe:a$/, result: () => ({ ok: true, exitCodes: [0, 0, 0], out: [BASE_SHA] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'merged')
  assert.ok(!has(calls, 'setup:a'), 'the setup courier carries no already-merged case — git answered first')
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
  await flush(() => has(calls, 'merge:a'))
  assert.ok(has(calls, 'merge:a'), 'merge:a issued')
  assert.ok(!has(calls, 'merge:b'), 'merge:b must NOT issue while merge:a is in flight')

  mergeA.resolve({ merged: true, suitePass: true, head: BASE_SHA, detail: '' })
  await flush(() => has(calls, 'merge:b'))
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
// 8b. Opus effort wiring. CHANGED CONTRACT (0.14.0): `implementEffort` is GONE. It only ever drove
//     plan/replan, and the implementer plans its own work on codex now — so there is no Opus
//     code-authoring pipeline left to dial, and the plan pass is a codex role steered at
//     codexSteerModel/low like every other one. `opusEffort` still drives every Opus call the
//     harness makes, defaults to 'medium', and honours a config override.
// =========================================================================================
test('8b opus effort wiring: opusEffort defaults + overrides; the plan pass is a codex role', async () => {
  const effortOf = (calls, prefix) => calls.find((c) => c.label.startsWith(prefix))?.effort
  const modelOf = (calls, prefix) => calls.find((c) => c.label.startsWith(prefix))?.model

  const defaults = await (async () => {
    const { fn, calls } = makeAgent()
    await runWave(fn, makePlan([unit('a')]), makeState())
    return calls
  })()
  assert.equal(modelOf(defaults, 'plan:a'), 'haiku', 'the plan pass is steered at codexSteerModel now')
  assert.equal(effortOf(defaults, 'plan:a'), 'low', 'steering a codex role is a low-effort mechanical job')
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
      { opusEffort: 'low', codexSteerModel: 'sonnet' })
    return calls
  })()
  assert.equal(modelOf(overridden, 'plan:a'), 'sonnet', 'codexSteerModel override carried to the plan role too')
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

// A pack whose documents carry every escape that ever broke a launch, in one document each:
//   `\"`      — a quoted word inside a prose field (12 of these made wf_de8b04a2-b80 unlaunchable)
//   `\\`      — a literal backslash (a Windows-ish path in a note)
//   `\n`/`\t` — the two-character escapes a serializer emits for whitespace inside a string
//   `\u2014`  — an em dash from an `ensure_ascii` serializer (four of these killed a 2026-09-02 launch)
//   `—` / `→` — the SAME characters written raw, which cksumOf has to hash as UTF-8 BYTES
// The `\uXXXX` form is not something JSON.stringify emits, so the serializer below re-escapes the
// non-ASCII glyphs of ONE document — modelling exactly the writer that produced the failing pack —
// while the other keeps them raw. Both still parse to the documents the test passed (packRules
// asserts it), so a successful read must produce a wave that runs on precisely this plan.
const ESCAPEY = 'a "quoted" word, a C:\\path\\here, a line\nbreak, a\ttab, an em dash — and an arrow →'
const escapeyPlan = () => makePlan([unit('a', { title: ESCAPEY })], [], { notes: ESCAPEY })
// The state's escapey prose rides on a unit record the harness carries forward untouched, so the
// assertion is the one that matters on a relaunch: the arc resumes from EXACTLY the text on disk.
const escapeyState = () => makeState({ units: { seeded: { status: 'merged', branch: 'unit/seeded', note: ESCAPEY } } })
// `ensure_ascii`: every non-ASCII character becomes a `\uXXXX` escape, exactly as the Python-side
// serializer that wrote the 2026-09-02 plan.json did.
const asciiOnly = (doc) => `${JSON.stringify(doc, null, 2).replace(/[^\x00-\x7f]/g,
  (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`)}\n`

test('13f a pack full of JSON escapes and raw glyphs reads clean — nothing in it needs escaping in transit', async () => {
  const plan = escapeyPlan()
  const state = escapeyState()
  // plan.json comes from an ensure_ascii serializer (`\u2014`); state.json keeps its glyphs raw.
  const { fn, calls } = makeAgent(packRules(plan, state,
    (doc, name) => (name === 'plan.json' ? asciiOnly(doc) : `${JSON.stringify(doc, null, 2)}\n`)))
  const out = await (await loadScript(HARNESS))({
    args: { roadmapDir: '/repo/.roadmap', launchId: 'L1', config: { gateAuditRate: 0 } },
    agent: fn,
  })
  assert.deepEqual(packLabels(calls), ['pack-read:plan.json', 'pack-read:state.json'],
    'no retry: an escape-heavy document is an ordinary read now, not a coin flip')
  const p = calls.find((c) => c.label === 'pack-read:plan.json')
  assert.match(p.prompt, /sed -n '1,\$p' \/repo\/\.roadmap\/plan\.json \| sed 's\/\\\\\/@@BSLASH@@\/g'/,
    'the read command itself strips every backslash out of the transport')
  assert.match(p.prompt, /@@BSLASH@@/, 'and the courier is told what the marker it is copying means')
  assert.equal(out.units.a.status, 'merged', 'and the wave runs on exactly the plan that was on disk')
  assert.equal(out.units.seeded.note, ESCAPEY,
    'every escape and glyph survives the round trip byte for byte — this is the state the arc resumes from')
})

test('13g the OLD failure — a courier that decodes the escapes — is caught, not accepted', async () => {
  // What Haiku actually did, twice: a report is JSON, so `\"` in the file needs `\\\"` in the
  // report's string value and it supplied `\"`. The result is the document with one level of
  // escaping stripped: shorter than the file, and parseable often enough to be dangerous.
  const plan = escapeyPlan()
  const honest = packRules(plan, escapeyState(), (doc, name) => (name === 'plan.json' ? asciiOnly(doc) : `${JSON.stringify(doc, null, 2)}\n`))
  const { fn, calls } = makeAgent([
    { match: /^pack-read:plan\.json/, result: (prompt, opts) => {
      const r = honest[0].result(prompt, opts)
      // Undo the sentinel the read command inserted, then drop one escaping level — the courier
      // that "helpfully" renders `\u2014` as an em dash and `\"` as a bare quote.
      for (let i = 3; i < r.results.length; i++)
        r.results[i].stdout = r.results[i].stdout
          .split('@@BSLASH@@').join('\\')
          .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/\\(["\\/])/g, '$1')
      return r
    } },
    ...honest,
  ])
  await assert.rejects(
    () => (loadScript(HARNESS)).then((r) => r({
      args: { roadmapDir: '/repo/.roadmap', launchId: 'L1', config: { gateAuditRate: 0 } }, agent: fn })),
    /pack-unreadable[\s\S]*plan\.json[\s\S]*@@BSLASH@@ transport sentinel/,
    'the cksum still decides, and the failure names the sentinel as one of the things to check',
  )
  assert.deepEqual(packLabels(calls),
    ['pack-read:plan.json', 'pack-read:state.json', 'pack-read:plan.json#retry'],
    'one honest retry, then a loud refusal — never a wave on a decoded plan')
})

test('13h a file too big for one response is split into line ranges, sentinel and all', async () => {
  // A state.json past READ_CHUNK: the first courier can only truncate, so the retry reads it over
  // several ranges and the whole-file cksum still decides. The escapey prose is on every record, so
  // the sentinel has to survive being cut across a range boundary as well as inside one.
  const plan = makePlan([unit('a')])
  const seeded = {}
  for (let i = 0; i < 60; i++)
    seeded[`old-${i}`] = { status: 'merged', branch: `unit/old-${i}`, note: `${ESCAPEY} ${'padding '.repeat(30)}` }
  const state = makeState({ units: seeded })
  const honest = packRules(plan, state)
  let truncated = false
  const { fn, calls } = makeAgent([
    { match: /^pack-read:state\.json$/, result: (prompt, opts) => {
      truncated = true
      const r = honest[0].result(prompt, opts)
      r.results[3].stdout = r.results[3].stdout.slice(0, 24000)   // all one courier can carry
      return r
    } },
    ...honest,
  ])
  const out = await (await loadScript(HARNESS))({
    args: { roadmapDir: '/repo/.roadmap', launchId: 'L1', config: { gateAuditRate: 0 } },
    agent: fn,
  })
  assert.ok(truncated, 'the first read really did hit the response ceiling')
  assert.deepEqual(packLabels(calls),
    ['pack-read:plan.json', 'pack-read:state.json', 'pack-read:state.json#split'],
    'the oversized file is re-read over ranges, not re-sampled whole')
  const split = calls.find((c) => c.label === 'pack-read:state.json#split')
  const ranges = (split.prompt.match(/sed -n '\d+,\d+p' \S+ \| sed 's\/\\\\\/@@BSLASH@@\/g'/g) ?? [])
  assert.ok(ranges.length > 1, `the read fans out over several ranges (got ${ranges.length})`)
  assert.equal(out.units['old-59'].note, `${ESCAPEY} ${'padding '.repeat(30)}`,
    'and the reassembled document is byte-identical to the file on disk')
  assert.equal(out.units.a.status, 'merged')
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
// CHANGED CONTRACT (0.14.0): integration setup is a courier, so the ancestry answer is the stdout
// of `git merge-base --is-ancestor <tip> <branch>; echo $?` (printed by the SHELL, which also keeps
// a legitimate answer of 1 off the courier's stop-at-first-failure path) and the tip is the stdout
// of `git -C <intWt> rev-parse HEAD`.
const intWorktree = (ancestorExit, sha = OTHER_SHA) =>
  ({ match: /^integration-worktree$/, result: courierSaying([[/merge-base --is-ancestor/, String(ancestorExit)]], sha) })

test('15a integration-tip reconciliation: adopts the live tip when the checkpointed tip is its ancestor', async () => {
  const { fn, calls } = makeAgent([intWorktree(0)])
  // Zero units so nothing forks/merges to move the tip again — isolate the reconciliation.
  const state = await runWave(fn, makePlan([]), makeState(), { boundary: 'off' })
  assert.equal(state.integrationTip, OTHER_SHA, 'integrationTip reconciled to the reported git sha')
  const probe = calls.find((c) => c.label === 'integration-worktree')
  assert.match(probe.prompt, /git merge-base --is-ancestor a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 roadmap\/session-test/,
    'the courier is handed the exact command, not asked whether the branch moved forward')
  assert.match(probe.prompt, /never rewind, reset or force a branch/, 'and is forbidden from making the answer zero')
})

test('15b integration-tip reconciliation: a tip that is NOT an ancestor halts the wave before dispatch', async () => {
  const { fn, calls } = makeAgent([intWorktree(1)])
  await assert.rejects(
    runWave(fn, makePlan([unit('a')]), makeState(), { boundary: 'off' }),
    /integration tip regressed/,
  )
  assert.ok(!has(calls, 'setup:a'), 'nothing dispatched onto a branch our own record cannot reach')
  assert.ok(!has(calls, 'provision:integration'), 'the wave stops at the reconcile, before provisioning')
})

test('15c integration-tip reconciliation: an unresolvable checkpointed tip (exit 128) halts too', async () => {
  const { fn } = makeAgent([intWorktree(128)])
  await assert.rejects(
    runWave(fn, makePlan([]), makeState(), { boundary: 'off' }),
    /exited 128/,
  )
})

test('15d equal shas need no ancestry answer — the reconcile does not fire', async () => {
  const { fn } = makeAgent([intWorktree(1, BASE_SHA)])
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
    { match: /^commit-probe:b$/, result: courierSaying([[/rev-list --count/, '0']]) },
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
    { match: /^commit-probe:a$/, result: courierSaying([[/rev-list --count/, '3']]) },
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
    { match: /^commit-probe:a$/, result: courierSaying([[/rev-list --count/, '3']]) },
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

