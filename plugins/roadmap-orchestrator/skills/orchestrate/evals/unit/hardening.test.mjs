// Zero-token control-flow simulation of the 0.10.0 hardening pathways in harness.mjs: the owed
// boundary ledger, the two merge fences (.roadmap/ strip, numbered-prefix collision), the specGap
// pull channel, the plan's evidence manifest as a reviewer reading list, and crash-residue reopen.
//
// Same contract as harness.test.mjs: the UNMODIFIED harness is the source of truth — any red here
// is a fake/assumption bug in this file, never a licence to edit the harness. Every test names the
// invariant it locks and the failure that bought it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from './load.mjs'
import { makeAgent, BASE_SHA, assertAllModelsPinned, assertSchemasPresent } from './fakes.mjs'

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

// Canned shapes the built-in fake defaults do not cover (the harness labels below are newer than
// the DEFAULTS table in fakes.mjs, which is a frozen surface this file must not edit).
const IMPL_OK = { summary: 'done', filesChanged: [] }
const VERIFY_OK = { pass: true, blocked: false, failures: [], contractSurfaceTouched: false }
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
})

// =========================================================================================
// 8. specGap pull channel on an ALL-GREEN unit. The polish loop's rescue consult only fires on
//    failure signals, so the class this closes is precisely a silent design decision under a
//    green suite. A 'confirm' means the decision stands as built: no fix round, and — because the
//    gap WAS adjudicated — no frontier force either (the unit keeps the cheap Opus gate).
// =========================================================================================
test('8 spec gap: a green unit pulls a Fable consult; confirm merges with no fix and no forced gate', async () => {
  const { fn, calls } = makeAgent([
    { match: /^impl:a$/, result: () => ({ ...IMPL_OK, specGap: 'chose soft-delete; spec silent' }) },
    { match: /^gap-consult:a$/, result: () => ({ action: 'confirm', guidance: 'stands' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  const consult = calls.find((c) => c.label === 'gap-consult:a')
  assert.ok(consult, 'the gap pulls the architect in even with everything green')
  assert.equal(consult.model, 'fable', 'spec-silence adjudication is a frontier call')
  assert.ok(consult.prompt.includes('chose soft-delete; spec silent'), 'the architect is given the actual decision')
  assert.ok(!has(calls, 'gap-fix:a'), 'confirm means the decision stands as built — no fix round')
  assert.equal(state.units.a.status, 'merged')
  assert.ok(has(calls, 'opus-gate:a#0'), 'an ADJUDICATED gap leaves the cheap Opus-first gate in place')
  assert.ok(!has(calls, 'gate:a#0'), 'nothing here forces the frontier gate')
  assert.equal(state.consultsUsed, 1, 'the gap consult rides the shared consult budget')
})

// =========================================================================================
// 9. specGap redirect: the architect steers, the engineer applies it as ONE fix round, and the
//    unit is re-verified before the gate — a ruling applied but never re-checked is a green
//    verify that predates the change.
// =========================================================================================
test('9 spec gap: redirect applies one fix round and re-verifies, and the unit still merges', async () => {
  const { fn, calls } = makeAgent([
    { match: /^impl:a$/, result: () => ({ ...IMPL_OK, specGap: 'chose soft-delete; spec silent' }) },
    { match: /^gap-consult:a$/, result: () => ({ action: 'redirect', guidance: 'use hard delete' }) },
    { match: /^gap-fix:a$/, result: () => IMPL_OK },
    { match: /^gap-verify:a$/, result: () => VERIFY_OK },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(has(calls, 'gap-fix:a'), 'a redirect is applied as a fix round')
  assert.ok(promptFor(calls, 'gap-fix:a').includes('use hard delete'), 'the ruling is carried into the fix')
  assert.ok(has(calls, 'gap-verify:a'), 'the post-ruling tree is re-verified before the gate')
  assert.equal(state.units.a.status, 'merged')
  assert.equal(calls.filter((c) => c.label === 'gap-fix:a').length, 1, 'exactly one round — the gap channel never loops')
})

// =========================================================================================
// 10. Budget-exhausted gap forces the frontier gate. An UNADJUDICATED spec-silence decision is the
//     same missing-signal/high-stakes case mismatchEver and reportLostEver cover: with no consult
//     available the cheap gate must not be the last word.
// =========================================================================================
test('10 spec gap: with the consult budget spent, the gap forces the Fable exit gate', async () => {
  const { fn, calls } = makeAgent([
    { match: /^impl:a$/, result: () => ({ ...IMPL_OK, specGap: 'chose soft-delete; spec silent' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { maxConsults: 0 })

  assert.ok(!has(calls, 'gap-consult:a'), 'no budget -> no consult')
  const gate = calls.find((c) => c.label === 'gate:a#0')
  assert.ok(gate, 'an unadjudicated gap forces the frontier gate')
  assert.equal(gate.model, 'fable')
  assert.ok(!has(calls, 'opus-gate:a#0'), 'the cheap gate must not adjudicate a decision nobody ruled on')
  assert.equal(state.units.a.status, 'merged')
})

// =========================================================================================
// 11. Plan evidence -> reviewer reading list. The plan pass already paid to explore the code; the
//     reviewer gets keyFiles ONLY (its fresh-eyes judgment stays its own). With no evidence the
//     clause must be exactly absent — pre-0.10 plans and adopted branches have no plan pass.
// =========================================================================================
test('11 plan evidence: keyFiles reach the reviewer as a reading list; absent evidence adds nothing', async () => {
  const withEvidence = await (async () => {
    const { fn, calls } = makeAgent([
      { match: /^plan:a$/, result: () => ({
        approach: 'x', files: [], testPlan: 'x', feasible: true,
        evidence: { keyFiles: ['src/x.js — the seam'] } }) },
    ])
    await runWave(fn, makePlan([unit('a')]), makeState())
    return promptFor(calls, 'review:a#0')
  })()
  assert.ok(withEvidence.includes('reading list'), 'the reviewer is handed the planner\'s reading list')
  assert.ok(withEvidence.includes('src/x.js'), 'with the actual key files in it')

  const withoutEvidence = await (async () => {
    const { fn, calls } = makeAgent()
    await runWave(fn, makePlan([unit('a')]), makeState())
    return promptFor(calls, 'review:a#0')
  })()
  assert.ok(!withoutEvidence.includes('reading list'), 'no evidence -> no clause at all')
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
    assert.ok(!has(calls, 'impl:a'), `${residue}: adopted work is never re-implemented`)
    assert.ok(has(calls, 'verify:a#0'), `${residue}: it still runs the unchanged verify -> review -> gate pipeline`)
  }
})
