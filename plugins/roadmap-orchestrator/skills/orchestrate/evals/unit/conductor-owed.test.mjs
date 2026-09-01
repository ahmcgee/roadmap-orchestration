// Zero-token simulation suite for the conductor's OWED-boundary-job pathway.
//
// `state.owed` is written by the HARNESS: a boundary job that was DUE but produced nothing
// (skipped because its precondition was down, or died) is recorded as
// `{ job, wave, why, count }`, where `count` is the number of consecutive boundaries the job
// has been owed. The conductor never discharges an owed entry — the harness does that when the
// job next succeeds — so the conductor's whole contract here is four rules:
//
//   1. non-empty `owed` is a JUDGMENT signal (predicates().anyJudgment), so a wave that would
//      otherwise auto-admit mechanically at tier 1 must instead buy an Opus triage at tier 2;
//   2. an entry owed TWO boundaries running (count >= 2) forces tier 3 outright — the Opus tier
//      is explicitly told it may not waive one, so routing it there again would just burn a
//      paid call to re-escalate;
//   3. only the Fable tier may waive, via `S_boundaryPlan.waiveOwed` (job names), and the waiver
//      is applied to the CONSUMED state before it threads into the next wave;
//   4. anything not waived rides forward byte-identically, and surfaces on the return envelope
//      of every return — including terminal ones, where discharging (or journaling a waiver for)
//      the leftovers becomes the root's job before close-out.
//
// Driving idiom is conductor.test.mjs's: loadScript() + scripted fakes, workflow() returning one
// canned harness wave-state per call, agent rules keyed off the short stable labels.

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { loadScript } from '../../script-loader.mjs'
import { makeAgent, makeWorkflow, packRules, assertAllModelsPinned } from './fakes.mjs'

const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))
const HARNESS_PATH = '/abs/path/to/harness.mjs'

/* ----------------------------- canned agent results ----------------------------- */
const CENSUS_EMPTY = { ok: true, pendingUserFeedback: [], quarantineDossiers: [] }

const TRIAGE_OK = {
  escalate: false, arcComplete: false,
  admit: [], cut: [], promote: [], debtLedger: [], feedback: [], notes: '',
}
const triage = (o = {}) => ({ ...TRIAGE_OK, ...o })

const BOUNDARY_OK = {
  escalate: false, arcComplete: false,
  newUnits: [], reviseSpecs: [], cutUnits: [], debtLedger: [], journal: '', notes: '',
}
const boundaryPlan = (o = {}) => ({ ...BOUNDARY_OK, ...o })

const OK = { ok: true }

/* ------------------------------- fixture builders ------------------------------- */
// A boundary block as the harness's serialize() emits it, with every judgment channel EMPTY —
// these fixtures isolate `owed` as the only signal, so nothing else may route the wave.
function emptyBoundary() {
  return {
    explorer: { findings: [], shaObserved: 'a1b2c3d4' },
    health: { findings: [], fixUnits: [] },
    flake: { runs: 3, flips: [] },
  }
}

// A health-assessor fix-unit draft. Drafts are NOT a judgment signal on their own (tier 1 admits
// them mechanically) — which is exactly what makes them the control for "owed forced tier 2".
const draft = (id) => ({ id, goal: `consolidate ${id}`, files: ['src/stats.js'], acceptance: ['imports gcd'] })

const withDrafts = (...ids) => {
  const b = emptyBoundary()
  b.health.fixUnits = ids.map(draft)
  return b
}

// A new-unit skeleton as a boundary (Fable) or triage (Opus) agent would emit it.
const skeleton = (id, o = {}) => ({ id, risk: 'med', goal: `build ${id}`, acceptance: ['does the thing'], ...o })

// The harness's owed-ledger entry shape (harness.mjs settles `{ job, wave, why, count }`).
const owedEntry = (job, count = 1, why = 'preview down') => ({ job, wave: 1, why, count })

function mkState(o = {}) {
  return {
    integrationBranch: 'roadmap/session-2026',
    integrationTip: 'a1b2c3d4',
    consultsUsed: 0,
    spend: { fable: 0, opus: 4, sonnet: 2, haiku: 12, planChecks: 0, opusPlanChecks: 1, gateRounds: 0, opusGateRounds: 2 },
    preview: { sha: null, status: 'none' },
    debt: [],
    boundary: emptyBoundary(),
    wave: 1,
    units: { 'seed-unit': { status: 'merged' } },
    ...o,
  }
}

function mkPlan(o = {}) {
  return {
    repoPath: '/repo',
    worktreeRoot: '/wt',
    units: [{ id: 'seed-unit', title: 'seed', risk: 'med', kind: 'code', inScope: true }],
    edges: [],
    config: {},
    ...o,
  }
}

// Exhaustive rule set — makeAgent throws on an unmatched label, so every label the conductor can
// emit needs a default. Caller overrides win (first match).
function rules({ census, triage: tr, boundary } = {}) {
  const list = []
  if (census) list.push({ match: /^census:/, result: census })
  if (tr) list.push({ match: /^triage:/, result: tr })
  if (boundary) list.push({ match: /^boundary:/, result: boundary })
  list.push({ match: /^census:/, result: CENSUS_EMPTY })
  list.push({ match: /^triage:/, result: TRIAGE_OK })
  list.push({ match: /^boundary:/, result: BOUNDARY_OK })
  list.push({ match: /^spec-(expand|revise):/, result: OK })
  list.push({ match: /^(bank-debt|move-feedback):/, result: OK })
  return list
}

// One canned wave-state per workflow() call; the last repeats if the conductor asks for more.
const waves = (...states) => (args, i) => states[Math.min(i, states.length - 1)]

/* ----------------------------------- driver ----------------------------------- */
async function conduct({
  plan = mkPlan(), state = mkState(), config = {}, harnessPath = HARNESS_PATH,
  agentRules = rules(), waveHandler = waves(state),
} = {}) {
  const agent = makeAgent([...packRules(plan, state), ...agentRules])
  const workflow = makeWorkflow(waveHandler)
  // The conductor's crash-recovery record is a tagged `log` line, not a paid write — persist.mjs
  // keeps the last one it sees, so a continuation boundary's decisions survive a later crash.
  const logs = []
  const run = await loadScript(CONDUCTOR)
  const result = await run({
    args: { roadmapDir: `${plan.repoPath}/.roadmap`, launchId: 'sim-launch', config, harnessPath },
    agent: agent.fn,
    workflow: workflow.fn,
    log: (line) => logs.push(String(line ?? '')),
    phase: () => {},
  })
  return { result, agent, workflow, snapshots: logs.filter((l) => l.startsWith('ROADMAP-SNAPSHOT ')).map((l) => JSON.parse(l.slice('ROADMAP-SNAPSHOT '.length))) }
}

/* -------------------------------- call helpers -------------------------------- */
const hasLabel = (calls, re) => calls.some((c) => re.test(c.label))
const firstLabel = (calls, re) => calls.find((c) => re.test(c.label))
const prompt = (c) => c?.prompt ?? ''

/* ============================================================================== */
/* 1. A single owed job is judgment: it buys tier 2 instead of a mechanical admit  */
/* ============================================================================== */
// The control below pins the counterfactual: the SAME fixture minus `owed` is a tier-1 wave.
// Without the control this test would pass on any fixture that merely happened to reach tier 2.

test('control: drafts alone (no owed, no findings) stay at tier 1 — no triage, no boundary', async () => {
  const st = mkState({ boundary: withDrafts('consolidate-gcd') })
  const { agent, workflow } = await conduct({
    state: st,
    waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })),
  })
  assert.equal(hasLabel(agent.calls, /^triage:/), false, 'a clean draft-only boundary must not buy an Opus triage')
  assert.equal(hasLabel(agent.calls, /^boundary:/), false, 'nor a Fable boundary')
  assert.ok(hasLabel(agent.calls, /^spec-expand:consolidate-gcd\b/), 'tier 1 admits the draft mechanically')
  assert.equal(workflow.calls.length, 2, 'and dispatches the next wave')
})

test('owed forces judgment: an owed job with no other signal routes the wave to tier 2', async () => {
  // Identical to the control except for `owed`: same empty findings, same draft, no debt, no
  // quarantine, no user feedback. Anything that routes must therefore be `owed`.
  const st = mkState({ boundary: withDrafts('consolidate-gcd'), owed: [owedEntry('design', 1, 'preview down')] })
  const { agent } = await conduct({
    state: st,
    waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })),
  })
  const t = firstLabel(agent.calls, /^triage:w1\b/)
  assert.ok(t, 'a non-empty owed ledger is a judgment signal — tier 1 must not auto-admit past it')
  assert.equal(t.model, 'opus', 'the judgment tier for a first-boundary owed entry is Opus')
  assert.equal(hasLabel(agent.calls, /^boundary:/), false, 'a count-1 entry does not yet warrant the Fable tier')
  // The triager has to see the ledger to act on it — a routed-but-uninformed tier is worse than
  // no routing at all, because it silently disposes of the wave without the evidence.
  assert.ok(prompt(t).includes('"owed"'), 'the owed ledger is in the structured evidence JSON')
  assert.ok(prompt(t).includes('preview down'), 'including each entry\'s `why` — the broken precondition to act on')
  assert.match(prompt(t), /only the Fable tier may waive/i,
    'and the Opus tier is told it may not waive one itself (it can only escalate hard-call)')
  assertAllModelsPinned(agent.calls)
})

test('owed alone (no drafts at all) still forces tier 2 rather than a silent arc-complete', async () => {
  // The nastiest shape: nothing to admit, nothing to cut. Without the owed predicate this wave is
  // indistinguishable from a dry boundary and closes the arc with the ledger unexamined.
  const st = mkState({ boundary: emptyBoundary(), owed: [owedEntry('design', 1, 'preview down')] })
  const { agent } = await conduct({ state: st, waveHandler: waves(st) })
  assert.ok(hasLabel(agent.calls, /^triage:w1\b/), 'an owed ledger is examined before the arc may close')
})

/* ============================================================================== */
/* 2. A repeat offender (count >= 2) skips Opus and goes straight to Fable         */
/* ============================================================================== */
test('repeat-owed (count 2) forces tier 3 directly — no Opus triage on the way', async () => {
  const st = mkState({ boundary: withDrafts('consolidate-gcd'), owed: [owedEntry('design', 2, 'preview down')] })
  const { agent } = await conduct({
    state: st,
    waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary() })),
  })
  const b = firstLabel(agent.calls, /^boundary:w1\b/)
  assert.ok(b, 'a job owed two boundaries running routes to the Fable boundary agent')
  assert.equal(b.model, 'fable', 'the waiver-capable tier is Fable')
  // Not merely "tier 3 was reached" — reached WITHOUT paying Opus first. Opus cannot waive, so
  // routing a repeat offender through it would buy a call whose only possible move is to escalate.
  assert.equal(hasLabel(agent.calls, /^triage:/), false,
    'count>=2 must select tier 3 outright, not arrive there via an Opus hard-call escalation')

  assert.ok(prompt(b).includes('"owed"'), 'the Fable agent gets the owed ledger in its evidence JSON')
  assert.ok(prompt(b).includes('preview down'), 'including the broken precondition')
  assert.match(prompt(b), /waiveOwed/,
    'and is taught the one field that can actually clear an entry — an unreachable schema field is a dead letter')
  assertAllModelsPinned(agent.calls)
})

test('a count-2 entry alongside a count-1 entry still forces tier 3 (any repeat offender suffices)', async () => {
  const st = mkState({
    boundary: emptyBoundary(),
    owed: [owedEntry('explorer', 1, 'explorer skipped'), owedEntry('design', 2, 'preview down')],
  })
  const { agent } = await conduct({
    state: st,
    agentRules: rules({ boundary: boundaryPlan({ newUnits: [skeleton('fix-preview')], journal: 'why' }) }),
    waveHandler: waves(st, mkState({ wave: 2, boundary: emptyBoundary(), units: { 'seed-unit': { status: 'merged' }, 'fix-preview': { status: 'merged' } } })),
  })
  assert.ok(hasLabel(agent.calls, /^boundary:w1\b/), 'the repeat offender dominates the tier choice')
  assert.equal(hasLabel(agent.calls, /^triage:/), false)
})

/* ============================================================================== */
/* 3. waiveOwed is applied to the consumed state before it threads forward         */
/* ============================================================================== */
// The waiver has to land on the state the NEXT wave is dispatched with (and the state persisted
// to disk for a resume). A waiver that only lived in the Fable report would be re-forced to tier 3
// next boundary — the arc would pay Fable every wave to waive the same dead job.

test('waiveOwed clears exactly the named job from the state threaded into the next wave', async () => {
  const st = mkState({
    boundary: emptyBoundary(),
    owed: [owedEntry('design', 2, 'preview down'), owedEntry('explorer', 1, 'explorer skipped')],
  })
  const { snapshots, workflow } = await conduct({
    state: st,
    agentRules: rules({
      boundary: boundaryPlan({
        waiveOwed: ['design'],
        newUnits: [skeleton('fix-preview')],   // keeps the arc alive so there IS a next dispatch
        journal: 'design boundary is moot: the preview target was cut from this arc',
      }),
    }),
    waveHandler: waves(
      st,
      mkState({ wave: 2, boundary: emptyBoundary(), units: { 'seed-unit': { status: 'merged' }, 'fix-preview': { status: 'merged' } } }),
    ),
  })
  assert.equal(workflow.calls.length, 2, 'the new unit keeps the arc running, so a second wave is dispatched')
  const threaded = workflow.calls[1].args.state
  assert.ok(Array.isArray(threaded.owed), 'the surviving ledger is still an array')
  assert.equal(threaded.owed.some((o) => o.job === 'design'), false, 'the waived job is gone from the threaded state')
  assert.deepStrictEqual(threaded.owed, [owedEntry('explorer', 1, 'explorer skipped')],
    'and everything NOT named in waiveOwed rides forward byte-identically — the waiver is surgical')

  // The same waiver must be in the wave-1 continuation SNAPSHOT: that is what persist.mjs writes
  // if the run dies in wave 2, and a resumeFromRunId off a stale copy re-forces the tier-3
  // boundary this arc already paid for.
  const w1 = snapshots.find((sn) => sn.wave === 1 && sn.conductor)
  assert.ok(w1, 'a continuation boundary snapshots its consumed state')
  assert.deepStrictEqual(w1.owed, [owedEntry('explorer', 1, 'explorer skipped')],
    'the snapshot carries the waived-down ledger, so a crash-time persist does not re-force tier 3')
})

test('waiving the last owed entry drops the `owed` key entirely (no empty-array ghost)', async () => {
  // An empty `owed: []` is falsy for `.length` everywhere the conductor reads it, so this is about
  // state hygiene rather than routing: the persisted state should not grow a permanent empty key.
  const st = mkState({ boundary: emptyBoundary(), owed: [owedEntry('design', 2, 'preview down')] })
  const { workflow } = await conduct({
    state: st,
    agentRules: rules({
      boundary: boundaryPlan({ waiveOwed: ['design'], newUnits: [skeleton('fix-preview')], journal: 'moot' }),
    }),
    waveHandler: waves(
      st,
      mkState({ wave: 2, boundary: emptyBoundary(), units: { 'seed-unit': { status: 'merged' }, 'fix-preview': { status: 'merged' } } }),
    ),
  })
  assert.equal(workflow.calls.length, 2)
  const threaded = workflow.calls[1].args.state
  assert.equal('owed' in threaded, false, 'a fully-waived ledger is removed, not left as []')
})

test('a waiver on a TERMINAL boundary sticks: arc-complete does not resurrect the waived job', async () => {
  // Regression pin (eval-observed, fixed 2026-08-03): the waiver used to be applied in the
  // persist section, which the terminal returns jump over — so "this job is moot" + arcComplete
  // (the most natural waiver shape: nothing new to build) silently discarded the waiver AND the
  // journal justifying it, and the same dead job re-forced a paid Fable boundary on every
  // relaunch. Waivers now apply at capture; the journal writes before the terminal return.
  const st = mkState({ boundary: emptyBoundary(), owed: [owedEntry('design', 2, 'preview down')] })
  const { result, agent } = await conduct({
    state: st,
    agentRules: rules({
      boundary: boundaryPlan({ waiveOwed: ['design'], arcComplete: true,
        journal: 'design boundary waived: the preview target was cut from this arc' }),
    }),
    waveHandler: waves(st),
  })
  assert.equal(result.reason, 'arc-complete')
  assert.equal('owed' in result, false, 'the envelope no longer carries the waived job')
  assert.equal('owed' in result.state, false, 'nor does the handed-back state')
  const j = (result.journalEntries ?? []).find((e) => e.wave === 1)
  assert.ok(j, 'the tier-3 journal (the waiver justification) survives the terminal return')
  assert.ok(j.journal.includes('preview target was cut'),
    'and carries the ruling — an unjournaled waiver is untraceable at the next Phase 0')
})

test('a waiveOwed naming an unknown job is inert — it never disturbs the real entries', async () => {
  const st = mkState({ boundary: emptyBoundary(), owed: [owedEntry('design', 2, 'preview down')] })
  const { workflow } = await conduct({
    state: st,
    agentRules: rules({
      boundary: boundaryPlan({ waiveOwed: ['flake'], newUnits: [skeleton('fix-preview')], journal: 'j' }),
    }),
    waveHandler: waves(
      st,
      mkState({ wave: 2, boundary: emptyBoundary(), units: { 'seed-unit': { status: 'merged' }, 'fix-preview': { status: 'merged' } } }),
    ),
  })
  assert.deepStrictEqual(workflow.calls[1].args.state.owed, [owedEntry('design', 2, 'preview down')],
    'waiving a job that is not owed must be a no-op, never a clear-all')
})

/* ============================================================================== */
/* 4. Unwaived owed rides forward untouched                                       */
/* ============================================================================== */
test('tier 2 cannot clear an owed entry: it rides into the next wave byte-identically', async () => {
  // The Opus tier has no waiveOwed field at all, so the only correct behaviour is passthrough.
  // (The prompt tells it to escalate 'hard-call' if it thinks a waiver is warranted.)
  const entry = owedEntry('design', 1, 'preview down')
  const st = mkState({ boundary: emptyBoundary(), owed: [entry] })
  const { agent, workflow } = await conduct({
    state: st,
    agentRules: rules({
      // Admits nothing; promotes a unit purely so the arc continues and there IS a next dispatch.
      triage: triage({ arcComplete: false, admit: [], promote: [skeleton('follow-up')] }),
    }),
    waveHandler: waves(
      st,
      mkState({ wave: 2, boundary: emptyBoundary(), units: { 'seed-unit': { status: 'merged' }, 'follow-up': { status: 'merged' } } }),
    ),
  })
  assert.ok(hasLabel(agent.calls, /^triage:w1\b/), 'tier 2 ran')
  assert.equal(hasLabel(agent.calls, /^boundary:/), false, 'and did not escalate')
  assert.equal(workflow.calls.length, 2, 'the promoted unit dispatches a second wave')
  assert.deepStrictEqual(workflow.calls[1].args.state.owed, [entry],
    'the owed entry survives the boundary untouched — discharge belongs to the harness, waiver to Fable')
})

test('an unwaived owed entry keeps forcing judgment at the NEXT boundary too', async () => {
  // Riding forward is only meaningful if it still routes. Wave 2 carries the same ledger and a
  // fresh draft: without the owed predicate that wave would be a tier-1 auto-admit.
  const entry = owedEntry('design', 1, 'preview down')
  const w1 = mkState({ wave: 1, boundary: emptyBoundary(), owed: [entry] })
  const w2 = mkState({
    wave: 2, boundary: withDrafts('fix-w2'), owed: [entry],
    units: { 'seed-unit': { status: 'merged' }, 'follow-up': { status: 'merged' } },
  })
  const { agent } = await conduct({
    config: { conductor: { maxWavesPerRun: 2 } },
    state: w1,
    agentRules: rules({ triage: triage({ promote: [skeleton('follow-up')] }) }),
    waveHandler: waves(w1, w2),
  })
  assert.ok(hasLabel(agent.calls, /^triage:w1\b/), 'wave 1 routed to judgment')
  assert.ok(hasLabel(agent.calls, /^triage:w2\b/),
    'and so does wave 2 — an undischarged owed job does not decay into silence')
})

/* ============================================================================== */
/* 5. Terminal surfacing — leftovers become the root's business                    */
/* ============================================================================== */
test('a terminal (arc-complete) return surfaces the leftover owed ledger on the envelope', async () => {
  const entry = owedEntry('design', 1, 'preview down')
  const st = mkState({ boundary: emptyBoundary(), owed: [entry] })
  const { result } = await conduct({
    state: st,
    agentRules: rules({ triage: triage({ arcComplete: true }) }),
    waveHandler: waves(st),
  })
  assert.equal(result.status, 'conductor-return')
  assert.equal(result.reason, 'arc-complete', 'the tier closed the arc')
  assert.ok(Array.isArray(result.owed), 'the envelope carries a top-level owed array')
  assert.deepStrictEqual(result.owed, [entry],
    'so the root can discharge or explicitly journal a waiver before close-out, rather than losing it')
  assert.deepStrictEqual(result.state.owed, [entry], 'and the handed-back state agrees with the brief')
})

test('an early (tier-4) return surfaces owed too — not just the arc-complete path', async () => {
  const entry = owedEntry('design', 2, 'preview down')
  const st = mkState({
    boundary: emptyBoundary(),
    owed: [entry],
    debt: [{ unit: 'seed-unit', kind: 'contract', severity: 'major', what: 'frozen surface contradicts reality', why: 'adjudicate' }],
  })
  const { result, agent } = await conduct({ state: st, waveHandler: waves(st) })
  assert.equal(result.reason, 'contract-amendment', 'contract debt outranks the owed routing')
  assert.equal(hasLabel(agent.calls, /^boundary:/), false, 'no boundary agent is paid before a tier-4 return')
  assert.deepStrictEqual(result.owed, [entry], 'the ledger still reaches the root on an early return')
})

test('a clean run omits `owed` from the envelope entirely (absent, not empty)', async () => {
  const st = mkState({ boundary: emptyBoundary() })
  const { result } = await conduct({ state: st, waveHandler: waves(st) })
  assert.equal(result.reason, 'arc-complete')
  assert.equal('owed' in result, false, 'the root never has to distinguish [] from "nothing owed"')
})

/* ============================================================================== */
/* 6. The FINAL wave — `boundary:'off'` no longer defers an owed job forever       */
/* ============================================================================== */
// Owed jobs settle only inside the harness's boundary phase, and the arc's last relaunch is the one
// the architect is told to run with `boundary:'off'`. An explorer or design reconcile owed at that
// point was therefore deferred to a boundary that never came, and left the run as a manual chore in
// the return envelope. The harness now runs the owed jobs — and only those — in that wave;
// `wave-policy.test.mjs` locks that end, and these lock the conductor's half of the handshake.

test('the ledger is handed DOWN to the wave that must discharge it, even with the boundary off', async () => {
  const entry = owedEntry('design', 1, 'preview down')
  const st = mkState({ boundary: emptyBoundary(), owed: [entry] })
  const { workflow } = await conduct({
    state: st,
    config: { boundary: 'off' },
    agentRules: rules({ triage: triage({ arcComplete: true }) }),
    waveHandler: waves(st),
  })
  assert.deepStrictEqual(workflow.calls[0].args.state.owed, [entry],
    'the harness cannot run an owed job it was never told about')
  assert.equal(workflow.calls[0].args.config.boundary, 'off',
    "and it is still told the boundary is off — running the owed job anyway is the harness's call, not a config lie")
})

test('a final wave that discharged its owed job returns clean — nothing left for the root to chase', async () => {
  const st = mkState({ boundary: emptyBoundary(), owed: [owedEntry('design', 1, 'preview down')] })
  // What the harness hands back once the owed reconcile has actually run: no `owed` key at all.
  const discharged = mkState({ wave: 2, boundary: emptyBoundary() })
  const { result } = await conduct({
    state: st,
    config: { boundary: 'off' },
    agentRules: rules({ triage: triage({ arcComplete: true }) }),
    waveHandler: waves(discharged),
  })
  assert.equal(result.reason, 'arc-complete')
  assert.equal('owed' in result, false, 'a discharged job is gone, not carried out as a permanent chore')
})

test('a final wave that could NOT discharge it still routes to judgment and surfaces the leftover', async () => {
  // The nasty shape: `boundary:'off'` means no boundary block, which normally reads as a degraded
  // wave. The owed ledger must still buy a triage rather than being swallowed by that path.
  const entry = owedEntry('design', 1, 'preview still down')
  const stillOwed = mkState({ wave: 2, owed: [entry] })
  delete stillOwed.boundary
  const { result, agent } = await conduct({
    state: mkState({ boundary: emptyBoundary(), owed: [entry] }),
    config: { boundary: 'off' },
    agentRules: rules({ triage: triage({ arcComplete: true }) }),
    waveHandler: waves(stillOwed),
  })
  assert.notEqual(result.reason, 'boundary-degraded', 'a switched-off boundary is not a degraded one')
  assert.ok(hasLabel(agent.calls, /^triage:w2\b/), 'the undischargeable job is still examined before the arc closes')
  assert.deepStrictEqual(result.owed, [entry], 'and rides out to the root, which discharges or waives it')
})
