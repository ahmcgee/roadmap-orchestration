// Zero-token control-flow simulation of the 0.10.0 hardening pathways in harness.mjs: the owed
// boundary ledger, the two merge fences (.roadmap/ strip, numbered-prefix collision), the specGap
// pull channel, the plan's evidence manifest handed to the implementer, and crash-residue reopen.
//
// Same contract as harness.test.mjs: the UNMODIFIED harness is the source of truth — any red here
// is a fake/assumption bug in this file, never a licence to edit the harness. Every test names the
// invariant it locks and the failure that bought it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from './load.mjs'
import { makeAgent, sidecarRows, BASE_SHA, assertAllModelsPinned, assertSchemasPresent, implCodexOk } from './fakes.mjs'

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
  integrationBranch: 'roadmap/session-hardening',
  integrationTip: BASE_SHA,
  consultsUsed: 0,
  wave: 0,
  units: {},
  ...extra,
})

// Audits off by default (gateAuditRate:0) so low-risk units take the deterministic Opus-first
// gate path — the gate-routing assertions below read that route, not a sampled one.
async function runWave(agentFn, plan, state, config = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config } }, agent: agentFn })
}

const has = (calls, prefix) => calls.some((c) => c.label === prefix || c.label.startsWith(prefix))
const promptFor = (calls, label) => calls.find((c) => c.label === label)?.prompt ?? ''
const owedFor = (state, job) => (state.owed ?? []).find((o) => o.job === job)

// Canned shapes the built-in fake defaults do not cover. The implementer is Codex now, so a
// code-writing report is the steering agent's S.implCodex shape (S.impl + the `codex` process
// meta) — `implCodexOk()` builds a fresh clean one per call.
const IMPL_OK = () => implCodexOk()
const VERIFY_OK = { pass: true, blocked: false, failures: [], contractSurfaceTouched: false, diffFiles: [] }
const MERGE_REFUSAL = (extra) => ({ merged: false, suitePass: false, head: BASE_SHA, detail: '', ...extra })

// A design authority + preview block: the design reconcile is the owed ledger's most load-bearing
// consumer (a preview-down wave silently skipping it is the arc-observed failure that created it).
const AUTH = [{ id: 'checkin', source: 'design-project', path: 'apps/web/src/design/checkin/', covers: ['/checkin'] }]
const PREVIEW = { kind: 'server', howToAccess: 'http://localhost:5173', start: 'npm run dev' }

// =========================================================================================
// 1. Owed markers: a preview-down wave leaves machine-readable IOUs. Arc-observed — a wave whose
//    preview never came up skipped the design reconcile over five design-cited units, and nothing
//    re-queued it; the root had to notice by hand. The explorer/design jobs were DUE and produced
//    nothing, so both must be owed, and the dead mirror must degrade loudly at its own label.
// =========================================================================================
test('1 owed: a preview-down wave owes explorer and design (and degrades preview-setup loudly)', async () => {
  const { fn, calls } = makeAgent([
    { match: /^preview-setup$/, result: () => ({ ok: false, sha: '', detail: 'dirty' }) },
  ])
  const plan = makePlan([unit('ui', { design: ['checkin#chrome'] })], [], { preview: PREVIEW, designAuthorities: AUTH })
  const state = await runWave(fn, plan, makeState())

  assert.equal(state.preview.status, 'failed', 'the mirror never came up')
  assert.equal(state.units.ui.status, 'merged', 'a dead preview is observability, never a gate')

  const expl = owedFor(state, 'explorer')
  assert.ok(expl, 'the explorer was due (a preview block exists) and produced nothing — it must be owed')
  assert.equal(expl.count, 1, 'first consecutive boundary owed')

  const dsgn = owedFor(state, 'design')
  assert.ok(dsgn, 'a design-cited unit merged with no live preview — the reconcile is owed')
  assert.deepEqual(dsgn.units, ['ui'], 'the owed entry names the units, so the debt can actually be paid')

  assert.ok(!has(calls, 'explorer:'), 'no live preview -> no explorer call')
  assert.ok(!has(calls, 'design:'), 'no live preview -> no design reconcile call')
  assert.ok(state.degradations.some((d) => d.label === 'preview-setup' && d.kind === 'preview-failed'),
    'the dead mirror is a skill defect with operator instructions, not a log line')
  // Regression pin (paid-eval-observed, fixed 2026-08-03): the dirty-primary check must EXCLUDE
  // .roadmap/ — the conductor's own persist writers dirty it every boundary, and an unscoped
  // porcelain gate killed the preview on every wave after the first in the conductor fixture.
  const ps = calls.find((c) => c.label === 'preview-setup')
  assert.ok(ps.prompt.includes(":(exclude).roadmap"),
    'the porcelain pre-check is scoped to real user edits — orchestrator-owned dirt never blocks the mirror')
  assertAllModelsPinned(calls)
  assertSchemasPresent(calls)
})

// =========================================================================================
// 2. Discharge: an owed job that RUNS successfully clears its marker. Without this the ledger is
//    write-only and every arc ends holding IOUs it already paid.
// =========================================================================================
test('2 owed: a healthy wave discharges a prior health marker', async () => {
  const { fn } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]),
    makeState({ wave: 1, owed: [{ job: 'health', wave: 1, why: 'x', count: 1 }] }))

  assert.ok(state.boundary?.health, 'the health assessor ran')
  assert.equal(owedFor(state, 'health'), undefined, 'a successful run discharges the marker')
})

// =========================================================================================
// 3. Carry + increment: a job owed again keeps its ORIGINAL wave and bumps `count`. `count` is
//    consecutive-boundaries-owed — the conductor escalates repeat offenders on it, so a reset
//    wave number or a reset count would hide exactly the chronic case.
// =========================================================================================
test('3 owed: a second consecutive miss increments count and preserves the original wave', async () => {
  const { fn } = makeAgent([
    { match: /^health:/, result: () => { throw new Error('health assessor down') } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]),
    makeState({ wave: 1, owed: [{ job: 'health', wave: 1, why: 'x', count: 1 }] }))

  const h = owedFor(state, 'health')
  assert.ok(h, 'a dead assessor is owed exactly like a skipped one')
  assert.equal(h.count, 2, 'consecutive misses accumulate')
  assert.equal(h.wave, 1, 'the marker keeps the wave it was first owed at')
})

// =========================================================================================
// 4. Owed design units re-enter the due set. `designUnits` normally excludes units already merged
//    in a PRIOR wave — so without the owed re-entry the debt would be remembered forever and never
//    paid. A live preview plus an owed marker must actually re-run the reconcile over those ids.
// =========================================================================================
test('4 owed: an owed design unit is re-reconciled once the preview is live again', async () => {
  const plan = makePlan([unit('u1', { design: ['checkin#chrome'] })], [], { preview: PREVIEW, designAuthorities: AUTH })
  const priorMerged = { wave: 1, units: { u1: { status: 'merged' } } }

  // Control: a unit that merged in an EARLIER wave is out of the due set — without the marker
  // there is no reconcile, which is exactly why the marker has to exist.
  const { fn: fn0, calls: calls0 } = makeAgent()
  await runWave(fn0, plan, makeState(priorMerged))
  assert.ok(!has(calls0, 'design:'), 'a previously-merged design unit is not re-reconciled on its own')

  const { fn, calls } = makeAgent()
  const state = await runWave(fn, plan, makeState({
    ...priorMerged,
    owed: [{ job: 'design', wave: 1, why: 'no live preview this wave', count: 1, units: ['u1'] }],
  }))

  assert.equal(state.preview.status, 'live', 'the mirror is up this wave')
  const design = calls.find((c) => c.label.startsWith('design:'))
  assert.ok(design, 'the owed reconcile re-fired even though u1 merged in an earlier wave')
  assert.match(design.prompt, /u1/, 'the reconcile names the owed unit')
  assert.equal(owedFor(state, 'design'), undefined, 'paying the debt clears the marker')
})

// =========================================================================================
// 5. Merge fence 1 — .roadmap/ refusal. NOROADMAP made mechanical: a unit diff that edits the
//    orchestrator's own directory is stripped (content preserved in branch history), re-merged,
//    and the adjudication routed to the architect as contract/major debt. Arc-observed: a unit
//    edited a frozen contract from its worktree and the queue accepted it — content sound,
//    channel wrong. The strip path must never be confused with a conflict (no resolve call).
// =========================================================================================
test('5 merge fence: roadmapPaths refusal strips, re-merges, and banks contract/major debt', async () => {
  const { fn, calls } = makeAgent([
    { match: /^merge:a$/, result: () => MERGE_REFUSAL({ roadmapPaths: ['.roadmap/contracts/x.md'] }) },
    { match: /^strip-roadmap:a$/, result: () => ({ ok: true, sha: BASE_SHA }) },
    // merge:a#restrip is unmatched here on purpose — it falls through to the clean-merge default.
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(has(calls, 'strip-roadmap:a'), 'the refusal triggers the strip commit')
  assert.ok(has(calls, 'merge:a#restrip'), 'the stripped branch is re-offered to the same merge prompt')
  assert.equal(state.units.a.status, 'merged', 'a stripped diff merges — the fence is a channel correction, not a kill')
  const d = state.debt.find((x) => x.kind === 'contract' && x.severity === 'major' && /\.roadmap\/contracts\/x\.md/.test(x.what))
  assert.ok(d, 'the stripped paths reach the ledger at contract/major so the architect adjudicates the content')
  assert.ok(!has(calls, 'resolve:a'), 'a refusal is not a conflict — the Opus resolver must not be paid for it')
})

// =========================================================================================
// 6. Merge fence 2 — numbered-prefix collision. Arc-observed: next-free-at-dispatch numbering
//    collided twice in one arc and one collision silently erased a CHECK constraint at merge.
//    A collision is quarantined, never repaired — renumbering silently is how the erasure happened.
// =========================================================================================
test('6 merge fence: prefixCollision quarantines the unit, never resolves it', async () => {
  const { fn, calls } = makeAgent([
    { match: /^merge:a$/, result: () => MERGE_REFUSAL({ prefixCollision: ['0042_a.sql', '0042_b.sql'] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')], [], { prefixUniqueGlobs: ['migrations/*'] }), makeState())

  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /prefix collision/, 'the reason names the fence that fired')
  assert.match(state.units.a.reason, /0042_a\.sql/, 'and the colliding filenames')
  assert.ok(!has(calls, 'resolve:a'), 'never hand a collision to the conflict resolver — it would renumber')
})

// =========================================================================================
// 7. Byte-identity guard: the prefix clause is plan-driven and must be EXACTLY '' when unset.
//    The paid fixtures carry no prefixUniqueGlobs, so an unconditional clause would silently
//    change every merge prompt they validate.
// =========================================================================================
test('7 merge prompt: the prefix clause appears only when plan.prefixUniqueGlobs is set', async () => {
  const withoutGlobs = await (async () => {
    const { fn, calls } = makeAgent()
    await runWave(fn, makePlan([unit('a')]), makeState())
    return promptFor(calls, 'merge:a')
  })()
  assert.ok(!withoutGlobs.includes('digit run'), 'no globs -> no digit-run instruction')
  assert.ok(!withoutGlobs.includes('prefixCollision'), 'no globs -> the refusal channel is never mentioned')

  const withGlobs = await (async () => {
    const { fn, calls } = makeAgent()
    await runWave(fn, makePlan([unit('a')], [], { prefixUniqueGlobs: ['migrations/*'] }), makeState())
    return promptFor(calls, 'merge:a')
  })()
  assert.ok(withGlobs.includes('digit run'), 'globs -> the merge agent is told how to detect a collision')
  assert.ok(withGlobs.includes('prefixCollision'), 'globs -> and which channel to refuse through')
  assert.ok(withGlobs.includes('migrations/*'), 'the globs themselves are named')
  // Twice arc-observed: a GLOBAL uniqueness check refused every merge in a wave on duplicate
  // pairs the repo's history already held. The check must diff pre-merge tip vs merged tree.
  assert.ok(withGlobs.includes('git ls-tree -r --name-only HEAD^1'), 'the pre-merge tip is the comparison base')
  assert.ok(withGlobs.includes('grandfathered and never refuse'), 'pre-existing duplicates are grandfathered')
  assert.ok(withGlobs.includes('NOT already have'), 'only a duplicate the merge introduces refuses')
})

// =========================================================================================
// 8. specGap pull channel on an ALL-GREEN unit. The polish loop's rescue consult only fires on
//    failure signals, so the class this closes is precisely a silent design decision under a
//    green suite. Opus triages first; only a boundary-crossing escalation reaches Fable, where a
//    'confirm' means the decision stands as built: no fix round, and — because the gap WAS
//    adjudicated — no frontier force either (the unit keeps the cheap Opus gate).
// =========================================================================================
test('8 spec gap: Opus triage escalates, Fable confirms, and the unit merges with no fix and no forced gate', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(), specGap: 'chose soft-delete; spec silent' }) },
    { match: /^adjudicate:a#1$/, result: () => ({ tier: 'escalate', boundary: 'contract', guidance: 'contract forbids it' }) },
    { match: /^gap-consult:a#1$/, result: () => ({ action: 'confirm', guidance: 'stands' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  const triage = calls.find((c) => c.label === 'adjudicate:a#1')
  assert.ok(triage, 'the gap is triaged before it reaches the frontier')
  assert.equal(triage.model, 'opus', 'first-line adjudication is an Opus call, not a frontier one')
  assert.ok(triage.prompt.includes('chose soft-delete; spec silent'), 'the adjudicator is given the actual decision')
  const consult = calls.find((c) => c.label === 'gap-consult:a#1')
  assert.ok(consult, 'an escalated gap still pulls the architect in with everything green')
  assert.equal(consult.model, 'fable', 'boundary-crossing adjudication is a frontier call')
  assert.ok(consult.prompt.includes('contract'), 'the architect is told which boundary was crossed')
  assert.ok(!has(calls, 'codex-gap-fix:a#1'), 'confirm means the decision stands as built — no fix round')
  assert.equal(state.units.a.status, 'merged')
  assert.ok(has(calls, 'opus-gate:a#0'), 'an ADJUDICATED gap leaves the cheap Opus-first gate in place')
  assert.ok(!has(calls, 'gate:a#0'), 'nothing here forces the frontier gate')
  assert.equal(state.consultsUsed, 1, 'only the ESCALATION rides the shared consult budget')
})

// =========================================================================================
// 8b. Opus triage that resolves the stop itself never reaches Fable and never spends the consult
//     budget. This is the common case on generously sized units — a decision the spec DOES settle
//     that the implementer failed to read — and charging it to maxConsults would let three
//     misreads starve the rescue channel.
// =========================================================================================
test('8b spec gap: a cited stop is answered by Opus alone, costs no consult budget, and still fixes', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(), specGap: 'chose soft-delete; spec silent' }) },
    { match: /^adjudicate:a#1$/, result: () => ({ tier: 'cited', boundary: 'none', guidance: 'spec §4 says hard delete' }) },
    { match: /^codex-gap-fix:a#1$/, result: () => IMPL_OK() },
    { match: /^gap-verify:a#1$/, result: () => VERIFY_OK },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(!has(calls, 'gap-consult:a#1'), 'a citable stop never reaches the frontier')
  assert.equal(state.consultsUsed, 0, 'triage is free — it must not ride the rescue budget')
  assert.ok(promptFor(calls, 'codex-gap-fix:a#1').includes('spec §4 says hard delete'), 'the citation is carried back')
  assert.ok(!has(calls, 'spec-append:a#1'), 'a citation settles nothing new — the spec is not amended')
  assert.ok(has(calls, 'opus-gate:a#0'), 'an adjudicated gap leaves the cheap gate in place')
  assert.equal(state.units.a.status, 'merged')
})

// =========================================================================================
// 8c. A 'decided' ruling settles something the spec did not, so it must land IN the spec. The
//     implementer's own context may compact before the unit ends, and review, the gate and every
//     later reader see the spec — never the resume prompt that carried the ruling.
// =========================================================================================
test('8c spec gap: a decided ruling is appended to the spec, not just fed back to the implementer', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(), specGap: 'chose soft-delete; spec silent' }) },
    { match: /^adjudicate:a#1$/, result: () => ({ tier: 'decided', boundary: 'none', guidance: 'soft-delete stands; add tombstone' }) },
    { match: /^spec-append:a#1$/, result: () => ({ ok: true }) },
    { match: /^codex-gap-fix:a#1$/, result: () => IMPL_OK() },
    { match: /^gap-verify:a#1$/, result: () => VERIFY_OK },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  const append = calls.find((c) => c.label === 'spec-append:a#1')
  assert.ok(append, 'a decision the spec did not settle is written back into the spec')
  assert.ok(append.prompt.includes('soft-delete stands; add tombstone'), 'the ruling is recorded verbatim')
  assert.ok(append.prompt.includes('chose soft-delete; spec silent'), 'so is the question it answered')
  assert.equal(state.consultsUsed, 0, 'deciding inside the unit envelope is not a frontier consult')
  assert.equal(state.units.a.status, 'merged')
})

// =========================================================================================
// 8d. Three strikes. Repeated stops on one unit are evidence the UNIT is specified wrongly, not
//     that each decision is hard — so the third stop skips triage entirely and is Fable's.
// =========================================================================================
test('8d spec gap: the third stop on a unit bypasses Opus triage and goes straight to Fable', async () => {
  const gapAgain = (n) => ({ ...IMPL_OK(), specGap: `gap ${n}` })
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => gapAgain(1) },
    { match: /^adjudicate:a#1$/, result: () => ({ tier: 'cited', boundary: 'none', guidance: 'see §4' }) },
    { match: /^codex-gap-fix:a#1$/, result: () => gapAgain(2) },
    { match: /^gap-verify:a#1$/, result: () => VERIFY_OK },
    { match: /^adjudicate:a#2$/, result: () => ({ tier: 'cited', boundary: 'none', guidance: 'see §5' }) },
    { match: /^codex-gap-fix:a#2$/, result: () => gapAgain(3) },
    { match: /^gap-verify:a#2$/, result: () => VERIFY_OK },
    { match: /^gap-consult:a#3$/, result: () => ({ action: 'confirm', guidance: 'stands' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(has(calls, 'adjudicate:a#1') && has(calls, 'adjudicate:a#2'), 'the first two stops are triaged cheaply')
  assert.ok(!has(calls, 'adjudicate:a#3'), 'the third stop is not triaged — it is escalated by rule')
  const consult = calls.find((c) => c.label === 'gap-consult:a#3')
  assert.ok(consult, 'the third stop reaches the architect')
  assert.equal(consult.model, 'fable')
  assert.ok(consult.prompt.includes('third stop'), 'the architect is told this is a repeat, not an isolated decision')
  assert.equal(state.units.a.status, 'merged')
})

// =========================================================================================
// 8e. The ladder terminates. A unit that stops on every fix round must hit the maxStops brake and
//     still reach a gate — an escalation valve that can loop forever is the review spiral again.
// =========================================================================================
test('8e spec gap: an endlessly stopping unit is capped by maxStops and still gates', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(), specGap: 'never settled' }) },
    { match: /^adjudicate:a#\d+$/, result: () => ({ tier: 'cited', boundary: 'none', guidance: 'see §4' }) },
    { match: /^gap-consult:a#\d+$/, result: () => ({ action: 'redirect', guidance: 'do it this way' }) },
    { match: /^codex-gap-fix:a#\d+$/, result: () => ({ ...IMPL_OK(), specGap: 'still not settled' }) },
    { match: /^gap-verify:a#\d+$/, result: () => VERIFY_OK },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { maxStops: 3 })

  assert.equal(calls.filter((c) => /^codex-gap-fix:a#\d+$/.test(c.label)).length, 3, 'the brake caps the rounds')
  assert.ok(!has(calls, 'codex-gap-fix:a#4'), 'and nothing runs past it')
  assert.ok(has(calls, 'gate:a#0') || has(calls, 'opus-gate:a#0'), 'the unit still reaches a gate')
})

// =========================================================================================
// 9. specGap redirect: the architect steers, the engineer applies it as ONE fix round, and the
//    unit is re-verified before the gate — a ruling applied but never re-checked is a green
//    verify that predates the change.
// =========================================================================================
test('9 spec gap: redirect applies one fix round and re-verifies, and the unit still merges', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(), specGap: 'chose soft-delete; spec silent' }) },
    { match: /^adjudicate:a#1$/, result: () => ({ tier: 'escalate', boundary: 'contract', guidance: 'contract forbids it' }) },
    { match: /^gap-consult:a#1$/, result: () => ({ action: 'redirect', guidance: 'use hard delete' }) },
    { match: /^codex-gap-fix:a#1$/, result: () => IMPL_OK() },
    { match: /^gap-verify:a#1$/, result: () => VERIFY_OK },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(has(calls, 'codex-gap-fix:a#1'), 'a redirect is applied as a fix round')
  assert.ok(promptFor(calls, 'codex-gap-fix:a#1').includes('use hard delete'), 'the ruling is carried into the fix')
  assert.ok(has(calls, 'gap-verify:a#1'), 'the post-ruling tree is re-verified before the gate')
  assert.equal(state.units.a.status, 'merged')
  // The channel DOES loop by design now (8d/8e cover that); what must not happen is a second
  // round for a stop that was already answered and not re-reported.
  assert.equal(calls.filter((c) => /^codex-gap-fix:a#\d+$/.test(c.label)).length, 1,
    'one round per reported stop — a settled gap does not re-fire')
})

// =========================================================================================
// 10. Budget-exhausted gap forces the frontier gate. An UNADJUDICATED spec-silence decision is the
//     same missing-signal/high-stakes case mismatchEver and reportLostEver cover: with no consult
//     available the cheap gate must not be the last word.
// =========================================================================================
test('10 spec gap: with the consult budget spent, the gap forces the Fable exit gate', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(), specGap: 'chose soft-delete; spec silent' }) },
    // Triage escalates, so the stop genuinely NEEDS the frontier — and the budget is gone.
    { match: /^adjudicate:a#1$/, result: () => ({ tier: 'escalate', boundary: 'contract', guidance: 'contract forbids it' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { maxConsults: 0 })

  assert.ok(!has(calls, 'gap-consult:a#1'), 'no budget -> no consult')
  const gate = calls.find((c) => c.label === 'gate:a#0')
  assert.ok(gate, 'an unadjudicated gap forces the frontier gate')
  assert.equal(gate.model, 'fable')
  assert.ok(!has(calls, 'opus-gate:a#0'), 'the cheap gate must not adjudicate a decision nobody ruled on')
  assert.equal(state.units.a.status, 'merged')
})

// =========================================================================================
// 11. Plan evidence -> the implementer's starting context. The plan pass already paid to explore
//     the code; that manifest must be handed FORWARD instead of re-acquired. The adversarial
//     reviewer that used to receive keyFiles as a reading list is gone, so the surviving consumer
//     is the Codex build brief, which inlines the approved plan whole. With no evidence the brief
//     must invent nothing — pre-0.10 plans and adopted branches have no plan pass.
// =========================================================================================
test('11 plan evidence: the planner\'s manifest reaches the implementer; absent evidence adds nothing', async () => {
  const withEvidence = await (async () => {
    const { fn, calls } = makeAgent([
      { match: /^plan:a$/, result: () => ({
        approach: 'x', files: [], testPlan: 'x', feasible: true,
        evidence: { keyFiles: ['src/x.js — the seam'] } }) },
    ])
    await runWave(fn, makePlan([unit('a')]), makeState())
    return promptFor(calls, 'codex-build:a')
  })()
  assert.ok(withEvidence.includes('already planned this unit'), 'the brief hands the approved plan forward')
  assert.ok(withEvidence.includes('keyFiles'), 'including the evidence manifest the plan pass earned')
  assert.ok(withEvidence.includes('src/x.js'), 'with the actual key files in it')

  const withoutEvidence = await (async () => {
    const { fn, calls } = makeAgent()
    await runWave(fn, makePlan([unit('a')]), makeState())
    return promptFor(calls, 'codex-build:a')
  })()
  assert.ok(!withoutEvidence.includes('keyFiles'), 'no evidence -> no manifest in the brief')
  assert.ok(!withoutEvidence.includes('src/x.js'), 'and certainly no invented file list')
})

// =========================================================================================
// 12. Crash residue reopen. `running`/`merge-ready` in the PASSED state cannot be true — the
//     script just started — so both are residue from a crashed wave. Before the reopen loop,
//     ready() required 'pending' and nothing ever restored it, which made runUnit's adoption
//     guard unreachable on relaunch and stranded crashed units exactly like the `blocked` class.
//     Reopened units must re-enter dispatch and ADOPT their committed work: no re-plan, no re-impl.
// =========================================================================================
test('12 crash residue: running/merge-ready reopen at wave start and adopt their committed work', async () => {
  for (const residue of ['running', 'merge-ready']) {
    const { fn, calls } = makeAgent([
      { match: /^setup:a$/, result: () => ({ ok: true, sha: BASE_SHA, state: 'adopted' }) },
    ])
    const state = await runWave(fn, makePlan([unit('a')]), makeState({ wave: 1, units: { a: { status: residue } } }))

    assert.ok(has(calls, 'setup:a'), `${residue} residue re-enters dispatch`)
    assert.equal(state.units.a.status, 'merged', `${residue} residue runs to completion`)
    assert.ok(!has(calls, 'plan:a'), `${residue}: adopted work is never re-planned`)
    assert.ok(!has(calls, 'codex-build:a'), `${residue}: adopted work is never re-implemented`)
    assert.ok(!has(calls, 'codex-spec-review:a'), `${residue}: no plan pass means no cross-model spec critique either`)
    assert.ok(has(calls, 'verify:a#0'), `${residue}: it still runs the unchanged verify -> gate pipeline`)
  }
})

// =========================================================================================
// 13. The prefixCollision fence is CONFIG-gated. Paid-run-observed (2026-08-11): a merge
//     agent facing an ordinary textual conflict filled `prefixCollision` with the conflicting
//     paths as a scratchpad, and the unguarded check quarantined the unit before the Opus
//     resolver ever ran — on a plan with NO prefixUniqueGlobs at all. Without configured
//     globs there is no prefix policy to violate: the conflict must route to `resolve:`.
// =========================================================================================
test('13 merge fence: prefixCollision is ignored when the plan sets no prefixUniqueGlobs', async () => {
  const { fn, calls } = makeAgent([
    { match: /^merge:a$/, result: () => MERGE_REFUSAL({ detail: 'conflict in calc.js', prefixCollision: ['calc.js', 'test.js'] }) },
    // The resolver clears it — the historical behaviour for a plain positional conflict.
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.ok(has(calls, 'resolve:a'), 'the conflict routed to the Opus resolver, not a prefix quarantine')
  assert.equal(state.units.a.status, 'merged', 'the resolved merge lands')
})

test('13b merge fence: prefixCollision still quarantines when prefixUniqueGlobs IS configured', async () => {
  const { fn, calls } = makeAgent([
    { match: /^merge:a$/, result: () => MERGE_REFUSAL({ prefixCollision: ['migrations/007_x.sql'] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')], [], { prefixUniqueGlobs: ['migrations/*'] }), makeState())
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /numbered-prefix collision/)
  assert.ok(!has(calls, 'resolve:a'), 'a real prefix collision never reaches the resolver — it is respec business')
})

// =========================================================================================
// 13. state.json must survive an agent TRANSCRIBING it. Agent-authored report text can carry raw
//     control characters (arc-observed: an explorer `repro` quoting a \x01 test input).
//     JSON.stringify escapes them correctly as \u0001 — but the checkpoint is written by a Haiku
//     agent copying the document, and that transcription decoded the escape back into a raw byte,
//     leaving a state.json no parser would read. An unresumable arc is far worse than a lossy
//     repro string, and a control character in a report is never load-bearing.
// =========================================================================================
test('13 checkpoint: control characters never reach the state.json payload', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(),
      // A confessed debt entry DOES reach state.json — that is the path that corrupted it.
      debt: [{ what: 'repro: f("a\x01b")', why: 'control chars in a quoted repro, arc-observed "\x1f"' }] }) },
  ])
  await runWave(fn, makePlan([unit('a')]), makeState())

  const writes = calls.filter((c) => c.label === 'checkpoint')
  assert.ok(writes.length, 'the wave checkpoints at least once')
  for (const w of writes) {
    assert.ok(!/[\x01\x1f]/.test(w.prompt),
      'no raw control character may appear in the document handed to the transcriber')
    assert.ok(!/\\u0001/.test(w.prompt),
      'nor an escape a transcriber could decode back into one')
  }
  const payload = writes.at(-1).prompt
  assert.ok(payload.includes('<0x01>') && payload.includes('<0x1f>'),
    'they are replaced with a printable token, so the evidence survives in readable form')
})

// =========================================================================================
// 14. The empty-trigger artifact. Codex emits the two-character string `""` when it means "nothing
//     to report" (arc-observed) — truthy, so it fired the contractMismatch AND specGap triggers,
//     summoned an adjudicator for a stop with no content, and banked a bogus `major` debt entry.
//     A trigger whose content is empty once quote characters are stripped IS an empty trigger.
// =========================================================================================
test('14 empty triggers: a literal double-quote pair is not a report', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(), specGap: '""', contractMismatch: '""' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(!has(calls, 'adjudicate:a#1'), 'an empty gap summons no adjudicator')
  assert.ok(!has(calls, 'gap-consult:a#1'), 'and certainly no frontier consult')
  assert.equal(state.consultsUsed, 0)
  assert.deepEqual(sidecarRows(calls, 'escalations'), [], 'nothing is recorded in the escalation ledger')
  assert.ok(!(state.debt ?? []).some((d) => /contract mismatch/.test(d.what ?? '')),
    'and no bogus contract-mismatch debt is banked')
  assert.ok(has(calls, 'opus-gate:a#0'), 'an empty trigger does not force the frontier gate either')
  assert.equal(state.units.a.status, 'merged')
})

// =========================================================================================
// 15. The arc's DIRECTION reaches judgment, and only judgment. architect-log.md was previously
//     read by the conductor's boundary agents alone, so plan-check, the exit gate and the
//     escalation adjudicator ruled with no sense of where the codebase was heading — arc-observed
//     (horizon fixture, run 3): a named open decision with two defensible answers and nothing to
//     choose by. The hard half of this invariant is the ABSENCE: a target state in an
//     implementer's prompt is an invitation to build the end state instead of the unit.
// =========================================================================================
test('15 direction: threaded into every judgment surface, and into no implementer brief', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...IMPL_OK(), specGap: 'two defensible shapes; spec silent' }) },
    { match: /^adjudicate:a#1$/, result: () => ({ tier: 'decided', boundary: 'none', guidance: 'the direction prefers the loud one' }) },
    { match: /^spec-append:a#1$/, result: () => ({ ok: true }) },
    { match: /^codex-gap-fix:a#1$/, result: () => IMPL_OK() },
    { match: /^gap-verify:a#1$/, result: () => VERIFY_OK },
  ])
  await runWave(fn, makePlan([unit('a', { risk: 'high' })]), makeState())

  const LOG = '/repo/.roadmap/architect-log.md'
  for (const label of ['plan-check:a', 'adjudicate:a#1', 'gate:a#0']) {
    const p = promptFor(calls, label)
    assert.ok(p, `${label} fired`)
    assert.ok(p.includes(LOG) && p.includes('## Direction'),
      `${label} must be told where the arc is heading`)
    assert.ok(/subordinate to the spec/i.test(p),
      `${label} must be told direction never overrides a spec or a frozen contract`)
  }
  for (const label of ['codex-build:a', 'codex-gap-fix:a#1']) {
    assert.ok(!promptFor(calls, label).includes(LOG),
      `${label} is an IMPLEMENTER brief — the arc's target state must never reach it`)
  }
})

// =========================================================================================
// 16. Two adjudication paths, one ledger. The plan-check may name the resolution of a spec
//     contradiction (its charter says so) — so it must record that ruling where the escalation
//     ladder records its own. Arc-observed (horizon fixture, run 3): it resolved a named open
//     decision, twelve modules were built on it, and the exit gate — reading an EMPTY ledger —
//     correctly judged the ruling fabricated and demanded an escalation that had already
//     happened. The unit quarantined with its retry budget spent. The gate was right.
// =========================================================================================
test('16 plan-check rulings are recorded in the same ledger the ladder writes to', async () => {
  const { fn, calls } = makeAgent([
    { match: /^plan-check:a$/, result: () => ({ verdict: 'redirect', guidance: 'resolve the open decision as a loud failure', notes: '' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a', { risk: 'high' })]), makeState())

  const entry = sidecarRows(calls, 'escalations').find((e) => e.by === 'plan-check')
  assert.ok(entry, 'a plan-check redirect is an adjudication and must leave a trace')
  assert.equal(entry.unit, 'a')
  assert.equal(entry.tier, 'decided')
  assert.ok(/loud failure/.test(entry.gap), 'the ruling itself is recorded, not just that one happened')
  assert.ok(has(calls, 'spec-append:a#plan'),
    'and it lands in the spec, which outlives the prompt that carried it')
})
