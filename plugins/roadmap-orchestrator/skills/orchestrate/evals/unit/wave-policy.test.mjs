// Zero-token simulation of the harness's WAVE-LEVEL policy machinery — the brakes that live in
// code rather than in a prompt an Opus turn can rationalise past.
//
// Four mechanisms, each closing an arc-observed failure:
//   1. `gateMaxConcurrent` — a counting semaphore on TEST lanes. Unit dispatch is unbounded on
//      purpose; their suites are not, or the wave saturates the box and then judges wall-clock
//      budgets against the load it created. Load is REPORTED by every lane and never gated on.
//   2. the shared-red circuit breaker — one failing spec that broke N units' gates and lies in
//      none of their diffs collapses to ONE signal instead of N fix loops and N quarantines.
//   3. scope rulings + precedent — the gate's verdict on an out-of-scope file is recorded and
//      shown to later gates, so two identical breaches in one wave get the same answer; and the
//      re-emit guard is superset-aware, so one incident is one degradation row.
//   4. owed boundary jobs run in the FINAL wave even when the boundary is switched off — that is
//      the boundary they used to be deferred past, into a boundary that never came.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { makeAgent, BASE_SHA, assertAllModelsPinned, implCodexOk } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))

const makePlan = (units, edges = [], extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units, edges, ...extra })
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/session-test', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})
// `launchId` is the per-launch probe salt: without it the harness degrades `no-launch-id` on every
// run, which would put a row in the ledger of every fixture here (see git-truth.test.mjs 5b).
async function runWave(agentFn, plan, state, config = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config }, launchId: 'launch-1' }, agent: agentFn })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const labels = (calls, re) => calls.filter((c) => re.test(c.label))
const promptOf = (calls, re) => calls.find((c) => re.test(c.label))?.prompt ?? ''

// The lane ledger is a REQUIRED verify field (see S.verify): a green with no command behind it is
// not evidence, and the script degrades `lane-substituted` on one. Every fixture below reports it.
const GREEN_LANES = [{ command: 'npm run test:ci', exitCode: 0 }]
const RED_LANES = [{ command: 'npm run test:ci', exitCode: 1 }]
const verifyOk = (extra = {}) => ({ pass: true, blocked: false, failures: [], lanes: GREEN_LANES, contractSurfaceTouched: false, diffFiles: [], ...extra })

/* ====================================================================== */
/* 1. gateMaxConcurrent bounds concurrent test lanes                        */
/* ====================================================================== */
// The bound is asserted against a CONTROL run of the identical fixture with a wide semaphore: the
// control proves the units really do want to run their lanes at once, so a passing bound is the
// semaphore's doing and not the scheduler's.
async function peakVerifyConcurrency(gateMaxConcurrent) {
  let live = 0
  let peak = 0
  const lane = async () => {
    live++
    peak = Math.max(peak, live)
    await sleep(4)
    live--
    return verifyOk()
  }
  const { fn } = makeAgent([{ match: /^verify:/, result: lane }])
  const units = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => unit(id))
  await runWave(fn, makePlan(units), makeState(), { gateMaxConcurrent })
  return peak
}

test('gate semaphore: concurrent verify lanes never exceed gateMaxConcurrent', async () => {
  const wide = await peakVerifyConcurrency(6)
  assert.ok(wide > 2, `control: with a wide semaphore the six units do overlap their lanes (peak ${wide})`)
  const bounded = await peakVerifyConcurrency(2)
  assert.equal(bounded, 2, `the same fixture peaks at exactly the bound (peak ${bounded})`)
})

test('gate semaphore: a bound of 1 still completes every unit — the queue drains, it does not deadlock', async () => {
  const { fn } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a'), unit('b'), unit('c')]), makeState(), { gateMaxConcurrent: 1 })
  for (const id of ['a', 'b', 'c']) assert.equal(state.units[id].status, 'merged', `${id} merged under a bound of 1`)
})

/* ====================================================================== */
/* 2. host load: reported by every lane, recorded, never gated on           */
/* ====================================================================== */
test('load facts: every test lane is told to report loadavg1 + cpuCount, by exact command', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a#0$/, result: () => ({ pass: false, blocked: false, failures: ['x'], lanes: RED_LANES, contractSurfaceTouched: false, diffFiles: [] }) }])
  await runWave(fn, makePlan([unit('a')]), makeState())
  for (const re of [/^verify:/, /^gate-verify:|^opus-gate-verify:/]) {
    const p = promptOf(calls, re)
    if (!p) continue
    assert.match(p, /cat \/proc\/loadavg/, 'the lane is given the exact command, not a goal')
    assert.match(p, /nproc/, 'and the exact cpu-count command')
    assert.match(p, /loadavg1/, 'reported into loadavg1')
  }
  // Nothing may WAIT on the numbers — the wave's own concurrency is what produces the load.
  const all = calls.map((c) => c.prompt).join('\n')
  assert.ok(!/wait until the load|only run when.{0,40}load|loadavg1 <|load average is below/i.test(all),
    'no prompt gates work on the load it just reported')
})

test('load facts: a blocked verify degrades with the host load attached', async () => {
  const { fn } = makeAgent([{
    match: /^verify:a#0$/,
    result: () => ({ pass: false, blocked: true, failures: ['runner missing'], lanes: [], contractSurfaceTouched: false, diffFiles: [], loadavg1: 34.5, cpuCount: 16 }),
  }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'blocked', 'a blocked verify blocks the unit — it is never a verdict about it')
  const d = (state.degradations ?? []).find((x) => x.kind === 'verify-blocked')
  assert.ok(d, 'the environment fact is ledgered, not silent')
  assert.match(d.what, /host load 34\.5 on 16 cpu/, 'and carries the load, so the verdict is auditable after the fact')
})

test('load facts: the flake band records one load sample per run', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  const p = promptOf(calls, /^flake:/)
  assert.match(p, /BEFORE each run/, 'the band samples the load per run, not once')
  assert.match(p, /`loads`/, 'into the loads array')
  assert.match(p, /must not[\s\S]{0,60}withhold, wait, or re-run/,
    'and is explicitly forbidden from waiting on the load — its co-tenants are its own siblings')
})

/* ====================================================================== */
/* 3. shared-red circuit breaker                                           */
/* ====================================================================== */
// One pre-existing red outside every diff. Before the breaker this produced per-unit fix rounds,
// per-unit contract majors, independent patches to the same file on N branches, and quarantines.
const SHARED = 'e2e/calendar-smoke.spec.ts'
const sharedRedVerify = (id) => () => ({
  pass: false, blocked: false, failures: ['calendar-smoke: expected 3 got 0'],
  failingSpecs: [SHARED], lanes: RED_LANES, contractSurfaceTouched: false, diffFiles: [`src/${id}.ts`],
})

async function sharedRedWave() {
  const ids = ['alpha', 'beta', 'gamma']
  const { fn, calls } = makeAgent(ids.map((id) => ({ match: new RegExp(`^(verify|gate-verify|opus-gate-verify):${id}`), result: sharedRedVerify(id) })))
  const state = await runWave(fn, makePlan(ids.map((id) => unit(id))), makeState())
  return { state, calls, ids }
}

test('shared red: N units failing one spec none of them touch collapse to ONE degradation', async () => {
  const { state } = await sharedRedWave()
  const rows = (state.degradations ?? []).filter((d) => d.kind === 'shared-red')
  assert.equal(rows.length, 1, 'one shared assertion is one signal, not one per affected unit')
  assert.match(rows[0].what, new RegExp(SHARED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the row names the spec')
  assert.equal(state.sharedReds.length, 1, 'and it rides back in the wave state for the boundary to adjudicate')
  assert.ok(state.sharedReds[0].units.length >= 2, 'naming the units it hit')
})

test('shared red: no unit is quarantined for it, and it is never banked as debt', async () => {
  const { state, ids } = await sharedRedWave()
  for (const id of ids)
    assert.notEqual(state.units[id].status, 'quarantined',
      `${id} must not die on an assertion its own diff never touched`)
  // A debt item would reopen the "debt creates a wave" hole. It has to reach the boundary as a
  // FINDING (state.sharedReds), which rides the cut-line-braked promote path instead.
  const banked = (state.debt ?? []).filter((d) => new RegExp('calendar-smoke').test(`${d.what} ${d.why}`))
  assert.deepEqual(banked, [], 'a shared red is a finding, never a debt item')
})

test('shared red: a unit with its OWN red too still fixes, and is told to leave the shared spec alone', async () => {
  // The mixed case is the one the clause exists for: a fully-suppressed unit skips fix rounds
  // entirely (asserted below), so only a unit with a real failure of its own reaches a fix prompt
  // while the breaker holds a spec.
  const mine = 'src/gamma.spec.ts'
  const { fn, calls } = makeAgent([
    { match: /^(verify|gate-verify|opus-gate-verify):alpha/, result: sharedRedVerify('alpha') },
    { match: /^(verify|gate-verify|opus-gate-verify):beta/, result: sharedRedVerify('beta') },
    {
      match: /^(verify|gate-verify|opus-gate-verify):gamma/,
      result: () => ({ pass: false, blocked: false, failures: ['calendar-smoke red', 'gamma red'],
        failingSpecs: [SHARED, mine], lanes: RED_LANES, contractSurfaceTouched: false, diffFiles: ['src/gamma.ts', mine] }),
    },
  ])
  await runWave(fn, makePlan([unit('alpha'), unit('beta'), unit('gamma')]), makeState())
  const fixes = labels(calls, /^codex-fix:gamma/)
  assert.ok(fixes.length > 0, 'a unit with a red of its own still runs its fix rounds')
  const clause = fixes.find((c) => /SHARED pre-existing red/.test(c.prompt))
  assert.ok(clause, 'and carries the suppression clause once the breaker owns the shared spec')
  assert.match(clause.prompt, /Do not attempt to fix them and do not edit them/,
    'which is what stops N branches independently patching one shared file')
  assert.ok(clause.prompt.includes(SHARED), 'the clause names the shared spec')
  assert.ok(!new RegExp(`${mine.replace(/\./g, '\\.')}[^]{0,120}adjudicated once`).test(clause.prompt),
    'and not the unit\'s own failing spec, which it must still fix')
})

test('shared red: a FULLY suppressed unit spends no fix round at all', async () => {
  const { calls } = await sharedRedWave()
  // alpha is the first to see the red and cannot yet know it is shared, so it fixes once. beta and
  // gamma verify after the breaker has taken over, and must not burn a round on it.
  assert.equal(labels(calls, /^codex-fix:beta/).length, 0, 'beta spends nothing on an assertion it did not break')
  assert.equal(labels(calls, /^codex-fix:gamma/).length, 0, 'nor does gamma')
})

test('shared red control: a failing spec ONE unit owns in its own diff is not shared', async () => {
  const own = 'src/alpha.spec.ts'
  const { fn } = makeAgent([
    { match: /^(verify|gate-verify|opus-gate-verify):alpha/, result: () => ({ pass: false, blocked: false, failures: ['x'], failingSpecs: [own], lanes: RED_LANES, contractSurfaceTouched: false, diffFiles: ['src/alpha.ts', own] }) },
    { match: /^(verify|gate-verify|opus-gate-verify):beta/, result: () => ({ pass: false, blocked: false, failures: ['x'], failingSpecs: [own], lanes: RED_LANES, contractSurfaceTouched: false, diffFiles: ['src/beta.ts', own] }) },
  ])
  const state = await runWave(fn, makePlan([unit('alpha'), unit('beta')]), makeState())
  assert.equal((state.degradations ?? []).filter((d) => d.kind === 'shared-red').length, 0,
    'a spec a claimant actually edited is that unit\'s business — the breaker must not take it over')
  assert.equal(state.sharedReds, undefined, 'and nothing reaches the boundary')
})

/* ====================================================================== */
/* 4. scope rulings, precedent, and the superset-aware re-emit guard        */
/* ====================================================================== */
const OUT_OF_SCOPE = 'e2e/shared.spec.ts'
const planWithFiles = (files) => () => ({ approach: 'x', files, testPlan: 'x', feasible: true })

test('scope rulings: the gate is asked to record a verdict per out-of-scope file, and it is kept', async () => {
  const { fn, calls } = makeAgent([
    { match: /^(plan|replan):a$/, result: planWithFiles(['src/a.ts']) },
    { match: /^verify:a/, result: () => verifyOk({ diffFiles: ['src/a.ts', OUT_OF_SCOPE] }) },
    { match: /^opus-gate:a/, result: () => ({ verdict: 'approve', trigger: 'none', directives: [], debt: [], scopeRulings: [{ file: OUT_OF_SCOPE, verdict: 'approve' }] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.match(promptOf(calls, /^opus-gate:a/), /Record one entry per file in `scopeRulings`/,
    'the gate is told the ruling is the deliverable, not just the verdict')
  assert.deepEqual(state.scopeRulings, [{ unit: 'a', file: OUT_OF_SCOPE, verdict: 'approve' }],
    'the ruling is written to wave state — previously only the breach ever was')
})

test('scope precedent: a later gate in the same wave is shown its sibling\'s ruling', async () => {
  // b depends on a, so a's gate strictly precedes b's — the precedent is deterministic here.
  const { fn, calls } = makeAgent([
    { match: /^(plan|replan):/, result: planWithFiles(['src/x.ts']) },
    { match: /^verify:/, result: () => verifyOk({ diffFiles: ['src/x.ts', OUT_OF_SCOPE] }) },
    { match: /^opus-gate:a/, result: () => ({ verdict: 'approve', trigger: 'none', directives: [], debt: [], scopeRulings: [{ file: OUT_OF_SCOPE, verdict: 'revert' }] }) },
  ])
  await runWave(fn, makePlan([unit('a'), unit('b')], [{ from: 'a', to: 'b', type: 'semantic', mode: 'contract' }]), makeState())
  const gb = promptOf(calls, /^opus-gate:b/)
  assert.match(gb, /Precedent — rulings other gates already made/, 'b\'s gate is handed the precedent')
  assert.match(gb, new RegExp(`${OUT_OF_SCOPE.replace(/\./g, '\\.')} \\(a\\) → revert`), 'naming the file, the unit, and the verdict')
  const ga = promptOf(calls, /^opus-gate:a/)
  assert.ok(!/Precedent —/.test(ga), 'the first gate has no precedent to follow and is not handed an empty one')
})

test('scope growth: a diff that adds a NEW out-of-scope file re-degrades; re-reporting the same set does not', async () => {
  let round = 0
  const { fn } = makeAgent([
    { match: /^(plan|replan):a$/, result: planWithFiles(['src/a.ts']) },
    {
      match: /^verify:a/,
      result: () => {
        const grew = round++ === 0 ? ['e2e/one.spec.ts'] : ['e2e/one.spec.ts', 'e2e/two.spec.ts']
        return { pass: round > 2, blocked: false, failures: round > 2 ? [] : ['x'], lanes: round > 2 ? GREEN_LANES : RED_LANES, contractSurfaceTouched: false, diffFiles: ['src/a.ts', ...grew] }
      },
    },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  const rows = (state.degradations ?? []).filter((d) => d.kind === 'scope-growth')
  // Round 0 reaches one file, round 1 adds a second (a genuinely new reach), round 2 repeats
  // round 1's set — a superset repeat, the double-count the old set-equality guard produced.
  assert.equal(rows.length, 2, 'two real reaches, two rows — the repeated set does not bill a third')
})

/* ====================================================================== */
/* 5. owed boundary jobs run in the final wave                             */
/* ====================================================================== */
test('owed at the final wave: boundary off + an owed job still runs THAT job, and discharges it', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]),
    makeState({ wave: 1, owed: [{ job: 'health', wave: 1, why: 'assessor died', count: 1 }] }),
    { boundary: 'off' })
  assert.ok(labels(calls, /^health:w2$/).length === 1, 'the owed health assessor runs in the last boundary there is')
  assert.equal(labels(calls, /^flake:w2$/).length, 0, 'a job that is NOT owed stays off — owed-only means owed-only')
  assert.equal(state.owed, undefined, 'and running it discharges the marker instead of deferring it forever')
  assertAllModelsPinned(calls)
})

test('owed at the final wave control: boundary off with nothing owed runs no boundary job at all', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), makeState({ wave: 1 }), { boundary: 'off' })
  assert.equal(labels(calls, /^(health|explorer|flake|design):w/).length, 0, 'switched off stays switched off')
  assert.equal(state.boundary, undefined, 'and no boundary block is manufactured')
})

test('owed at the final wave: a codex halt still skips the boundary entirely', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-probe:/, result: { ok: false, detail: 'codex CLI not found' } },
  ])
  await runWave(fn, makePlan([unit('a')]),
    makeState({ wave: 1, owed: [{ job: 'health', wave: 1, why: 'assessor died', count: 1 }] }),
    { boundary: 'off' })
  assert.equal(labels(calls, /^health:w2$/).length, 0,
    'a halted wave returns to the root regardless — boundary spend against it buys nothing')
})

/* ====================================================================== */
/* 6. the whole thing still delivers a clean wave                          */
/* ====================================================================== */
test('a clean wave is unchanged: no shared reds, no rulings, no new degradations', async () => {
  const { fn, calls } = makeAgent([{ match: /^codex-build:/, result: () => implCodexOk() }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'merged')
  assert.equal(state.sharedReds, undefined, 'nothing shared')
  assert.equal(state.scopeRulings, undefined, 'nothing out of scope, so no rulings block')
  // The envelope ALWAYS carries the array (empty when clean) so the root never has to guess
  // whether the run was healthy — so the clean-wave assertion is emptiness, not absence.
  assert.deepStrictEqual(state.degradations ?? [], [], 'and a clean wave still ledgers nothing')
  assertAllModelsPinned(calls)
})

/* ====================================================================== */
/* 6. the flake band: identical failure is UNASSESSED, never "no flips"    */
/* ====================================================================== */
// 2026-09-14: all three `make verify` re-runs exited 2 because the integration tip had no
// `verify` target (the foundation had not merged), and the boundary block still reported
// `runs: 3, flips: []` — read by every tier as a stable suite. A band whose every run fails
// identically measured nothing about intermittence.
test('flake band: every run exiting non-zero is unassessed — flips emptied, job owed, degradation recorded', async () => {
  const { fn } = makeAgent([{ match: /^flake:/, result: () => ({ runs: 3, flips: [], exits: [2, 2, 2], loads: [1, 1, 1], cpuCount: 4 }) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.boundary.flake.unassessed, true, 'the block says UNASSESSED, not clean')
  assert.deepEqual(state.boundary.flake.flips, [], 'and carries no flips for a tier to read as stability')
  assert.ok((state.owed ?? []).some((o) => o.job === 'flake' && /unassessed/.test(o.why)), 'the job is owed, so it re-runs next boundary')
  const d = (state.degradations ?? []).find((x) => x.kind === 'flake-unassessed')
  assert.ok(d, 'and the ledger says why')
  assert.match(d.what, /2, 2, 2/, 'naming the exit codes it saw')
})

test('flake band control: a band whose runs completed green is assessed and discharges nothing owed', async () => {
  const { fn } = makeAgent([{ match: /^flake:/, result: () => ({ runs: 3, flips: [], exits: [0, 0, 0] }) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.boundary.flake.unassessed, undefined)
  assert.ok(!(state.owed ?? []).some((o) => o.job === 'flake'), 'not owed')
  assert.ok(!(state.degradations ?? []).some((x) => x.kind === 'flake-unassessed'))
})

test('flake band control: a mixed band (one red run) is real intermittence data, not unassessed', async () => {
  const { fn } = makeAgent([{ match: /^flake:/, result: () => ({ runs: 3, flips: ['spec/a.test.js'], exits: [0, 1, 0] }) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.deepEqual(state.boundary.flake.flips, ['spec/a.test.js'], 'a genuine flip survives')
  assert.equal(state.boundary.flake.unassessed, undefined)
})

test('flake band: the brief asks for the per-run exit codes it is judged on', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  assert.match(promptOf(calls, /^flake:/), /`exits` = the suite's exit code per run/, 'the band is told what to report')
})

/* ====================================================================== */
/* 7. the explorer hold: a finding attributed to an unlanded unit          */
/* ====================================================================== */
// 2026-09-14: the runtime explorer reported the same `blocker` ("make estate-up: no rule") at
// waves 1 and 3 because the estate unit was blocked behind a quarantine, and each boundary had
// to dismiss it again. The explorer now attributes such a finding (`blockedBy`) and the harness
// holds it, in code, until the unit lands.
const PREVIEW = { kind: 'server', howToAccess: 'http://localhost:5173', start: 'npm run dev' }
test('explorer hold: a finding attributed to an in-scope unlanded unit is held out of the boundary findings', async () => {
  const { fn, calls } = makeAgent([
    // `a` quarantines at its gate, so `estate` (which depends on it) never lands this wave.
    { match: /^opus-gate:a/, result: () => ({ verdict: 'escalate', trigger: 'stuck', directives: [], debt: [] }) },
    { match: /^gate:a/, result: () => ({ verdict: 'quarantine', directives: [], debt: [] }) },
    { match: /^explorer:/, result: () => ({ shaObserved: BASE_SHA, findings: [
      { severity: 'blocker', summary: 'make estate-up: no rule', blockedBy: 'estate' },
      { severity: 'major', summary: 'attributed to nothing in the plan', blockedBy: 'ghost' },
      { severity: 'minor', summary: 'an ordinary finding' },
    ] }) },
  ])
  const plan = makePlan([unit('a'), unit('estate', { title: 'bring up the estate' })],
    [{ from: 'a', to: 'estate', type: 'semantic', mode: 'contract' }], { preview: PREVIEW })
  const state = await runWave(fn, plan, makeState())
  assert.equal(state.units.a.status, 'quarantined')
  const ex = state.boundary.explorer
  assert.deepEqual(ex.findings.map((f) => f.summary), ['attributed to nothing in the plan', 'an ordinary finding'],
    'the held finding is gone from what the triager reads; an attribution to an unknown id holds nothing')
  assert.deepEqual(ex.heldFindings.map((f) => f.summary), ['make estate-up: no rule'], 'and kept beside them, not dropped')
  const brief = promptOf(calls, /^explorer:/)
  assert.match(brief, /Units of this arc that have NOT landed yet: .*estate \(bring up the estate\)/, 'the explorer is told which units have not landed')
  assert.match(brief, /`blockedBy`/, 'and how to attribute a finding to one')
})

test('explorer hold control: with everything landed the brief carries no unit list and nothing is held', async () => {
  const { fn, calls } = makeAgent([
    { match: /^explorer:/, result: () => ({ shaObserved: BASE_SHA, findings: [{ severity: 'minor', summary: 'x', blockedBy: 'a' }] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')], [], { preview: PREVIEW }), makeState())
  assert.equal(state.units.a.status, 'merged')
  assert.ok(!promptOf(calls, /^explorer:/).includes('have NOT landed yet'), 'byte-identical brief on a drained plan')
  assert.equal(state.boundary.explorer.findings.length, 1, 'an attribution to a MERGED unit holds nothing')
  assert.equal(state.boundary.explorer.heldFindings, undefined)
})
