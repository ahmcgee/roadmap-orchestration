// Zero-token simulation of theme D: a model's death is a PLATFORM fact, never a unit verdict —
// plus the codex process lifecycle that has to survive its own steering agent.
//
// The arc-observed failures this locks down:
//   2026-08-25  a weekly-quota outage: every dead agent became a unit-level conclusion — three
//               units quarantined on "pipeline error: null is not an object (evaluating
//               'verify.blocked')" and one on "implementer produced neither a report nor a
//               commit" with all three milestones committed on its branch.
//   2026-08-25  six "Connection lost mid-response" deaths on a resume, same conversion again, this
//               time through the frontier exit gate (`capDirectives(gate)` on a null gate).
//   2026-08-22  a devcontainer whose PID 1 was `sleep infinity` accumulated 35,940 zombies; the
//               pid cgroup filled and a whole wave's gates died of EAGAIN, quarantined one by one.
//   2026-08-23  a steering agent inferred death from "no exit-code file yet" after 96 seconds and
//               fired build-retry into a LIVE worktree — two codex processes, one checkout.
//   2026-08-25  a contract debt item banked from a CACHED implementer report was re-banked on
//               resume after the branch resolved it, forcing a contract-amendment return.
//
// The shape of the fix: `runReq` for every result the script dereferences (salvage once, then halt
// the PLATFORM and throw), one halt record for every wave-level brake, and a host preflight that
// reads the box before the box eats the wave.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { makeAgent, makeWorkflow, packRules, courierResult, courierSaying, BASE_SHA, implCodexOk, codexMetaOk,
  structuredOutputError, courierOk, codexRoleDead, codexRoleMetaOk } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))

const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makePlan = (units, edges = [], extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units, edges, ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/session-test', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})
async function runWave(agentFn, plan, state, config = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, boundary: 'off', ...config }, launchId: 'launch-1' }, agent: agentFn })
}
const has = (calls, prefix) => calls.some((c) => c.label === prefix || c.label.startsWith(prefix))
const promptOf = (calls, label) => calls.find((c) => c.label === label)?.prompt ?? ''
const kinds = (state, kind) => (state.degradations ?? []).filter((d) => d.kind === kind)
const GREEN_LANES = [{ command: 'npm run test:ci', exitCode: 0 }]
const VERIFY_FAIL = () => ({ pass: false, blocked: false, failures: ['boom'],
  lanes: [{ command: 'npm run test:ci', exitCode: 1 }], contractSurfaceTouched: false, diffFiles: [] })
// A codex run that died with nothing on the branch — the one shape that earns the one-shot retry.
const deadRun = () => ({ ...implCodexOk(), codex: { ...codexMetaOk(), exitCode: 1, commits: 0, doneMarker: false } })

/* ====================================================================== */
/* 1. A dead REQUIRED result parks the unit and halts the wave             */
/* ====================================================================== */
// CHANGED CONTRACT (0.14.0): the verifier is a CODEX ROLE, so a dead verify is codex's failure,
// not the Claude platform's — the adapter never throws, never sets `halt.platform`, and hands back
// null. The unit is BLOCKED rather than quarantined or parked-on-outage: nothing about it was
// judged, its commits are intact, and the wave-start loop re-opens a `blocked` unit whose blocker
// is gone, so it re-enters dispatch next wave. What must NOT happen is unchanged and is still the
// point: no quarantine, no pipeline-error verdict, no dossier over an infrastructure failure.
test('a null verify BLOCKS the unit — never a quarantine, never a pipeline-error verdict', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: () => null }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'blocked', 'a role that never reported is not a verdict about the unit')
  assert.ok(!/pipeline error/.test(state.units.a.note ?? ''), 'and never blames the unit for it')
  assert.ok(!has(calls, 'dossier:a'), 'no redesign dossier is written for an infrastructure failure')
  assert.equal(state.halt, undefined, 'a codex role failure halts nothing — the Claude platform is fine')
  const d = kinds(state, 'verify-unrun')
  assert.equal(d.length, 1, 'the never-ran verify is ledgered, once')
  assert.match(d[0].what, /BLOCKED, not quarantined/, 'and the row says which door the unit went through')
  assert.ok(kinds(state, 'codex-role').length, 'the adapter has already ledgered the role death itself')
})

test('the salvage retry is real: a verify that dies once and then reports is NOT an outage', async () => {
  let n = 0
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: () => (n++ === 0 ? null : { pass: true, blocked: false,
    failures: [], lanes: GREEN_LANES, contractSurfaceTouched: false, diffFiles: [] }) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'merged', 'one death is a flake — the salvage rescues it')
  assert.equal(state.halt, undefined, 'and nothing halts')
  assert.ok(has(calls, 'verify:a#0#salvage'), 'the rescue is the salvage re-run, not a silent fallback')
  assert.ok(kinds(state, 'no-report').length, 'the death is still ledgered — a rescued flake is not a silent one')
})

test('a null frontier gate parks too — capDirectives never dereferences a dead gate', async () => {
  const { fn, calls } = makeAgent([{ match: /^gate:a/, result: () => null }])
  // risk:high forces the frontier gate, which is where the 2026-08-25 `g.directives` crash landed.
  const state = await runWave(fn, makePlan([unit('a', { risk: 'high' })]), makeState())

  assert.equal(state.units.a.status, 'pending')
  assert.equal(state.units.a.parked, true)
  assert.ok(!has(calls, 'dossier:a'), 'a dead gate is not a rejection')
  assert.equal(state.halt.reason, 'platform-outage')
})

test('a null merge result parks the unit at merge-ready — the gate-approved work is kept', async () => {
  const { fn } = makeAgent([{ match: /^merge:a/, result: () => null }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'merge-ready', 'an approved unit stays approved when the merge agent dies')
  assert.equal(state.units.a.parked, true)
  assert.equal(state.integrationTip, BASE_SHA, 'and the tip never moves on a merge nobody reported')
})

test('an outage stops new dispatch: ready() gates on the halt record, whatever set it', async () => {
  // b sits behind a's merge, so the halt is observed before b is ever ready. Driven through the
  // FRONTIER GATE rather than the verify: verify is a codex role since 0.14.0 and no longer speaks
  // for the Claude platform, while the gate is still a `runReq` result nobody can substitute for.
  const { fn, calls } = makeAgent([{ match: /^gate:a/, result: () => null }])
  const state = await runWave(fn, makePlan([unit('a', { risk: 'high' }), unit('b')],
    [{ from: 'a', to: 'b', type: 'semantic', mode: 'contract' }]), makeState(), { warmLanes: false })

  assert.equal(state.units.b.status, 'pending')
  assert.ok(!has(calls, 'setup:b'), 'not even a worktree is built into a dead platform')
})

// The throw path is the ONLY one carrying text — a null carries no error object at all — so quota
// and connection strings are read there, and only as a fast path.
test('a quota error on the throw path halts immediately, without burning a salvage agent', async () => {
  // On the frontier gate, for the same reason as the test above: the throw path with quota TEXT on
  // it is a Claude-platform signal, and verify no longer runs on Claude.
  const { fn, calls } = makeAgent([{ match: /^gate:a/, result: () => { throw new Error('Usage limit reached for this week') } }])
  const state = await runWave(fn, makePlan([unit('a', { risk: 'high' })]), makeState())

  assert.equal(state.halt.reason, 'platform-outage')
  assert.ok(!has(calls, 'gate:a#0#salvage'), 'a platform that just said it is down is not asked twice')
  assert.equal(state.units.a.parked, true)
})

/* ====================================================================== */
/* 1b. The codex BACKEND breaker — section 1's rule, for the other provider */
/* ====================================================================== */
// 2026-09-03, from ~14:43 UTC: every codex run failed with `turn.failed: unexpected status 404 Not
// Found … chatgpt.com/backend-api/codex/responses`, while `codex login status` still said "Logged
// in" so the wave-start probe passed. The wave ran to the end on a dead backend: 23 `codex-exec`
// rows, five units BLOCKED at verify, one QUARANTINED as "the planner died twice", the whole
// boundary owed, and a tier-4 return that spent Fable on nothing. The breaker is deliberately the
// same design as `haltPlatform` above — a provider's death is a fact about the PROVIDER — and
// differs only in its signal: text, but text plus repetition across DIFFERENT work.
const ERR_404 = 'turn.failed: unexpected status 404 Not Found (chatgpt.com/backend-api/codex/responses)'
const ERR_503 = 'turn.failed: unexpected status 503 Service Unavailable'
const outageRun = (error) => () =>
  ({ ...implCodexOk(), codex: { ...codexMetaOk(), exitCode: 1, commits: 0, doneMarker: false, error } })

test('two units 404ing back to back trip the breaker: both PARK, neither is quarantined', async () => {
  const { fn, calls } = makeAgent([{ match: /^codex-(build|build-retry|fix):/, result: outageRun(ERR_404) }])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  assert.equal(state.halt.codex, 'codex-unavailable', 'the same status on two different units is the provider')
  assert.equal(state.halt.reason, 'codex-unavailable')
  for (const id of ['a', 'b']) {
    assert.equal(state.units[id].status, 'pending', `${id} parks — an outage is never a verdict about a unit`)
    assert.equal(state.units[id].parked, true, `${id} carries the park flag, so it re-enters by adoption`)
    assert.ok(!has(calls, `dossier:${id}`), `${id} gets no redesign dossier over a provider outage`)
  }
  const d = kinds(state, 'codex-unavailable')
  assert.equal(d.length, 1, 'the breaker speaks once, however many runs go on to fail')
  assert.match(d[0].what, /consecutive codex runs across different units or roles failed with HTTP 404/)
  assert.match(d[0].what, /provider outage, not unit defects/)
  assert.match(d[0].what, /units park/)
})

// The unit that hit the FIRST 404 is the hard case: nothing was known to be wrong when its own run
// came back, and by the time a sibling tripped the breaker its retry had already been skipped by
// `haltReason()`. Its outcome after that must be a park — the 2026-09-03 arc quarantined exactly
// this unit as "the planner died twice".
test('the unit that failed FIRST parks too, and nothing is dispatched past the halt', async () => {
  const seen = []
  const { fn, calls } = makeAgent([{ match: /^codex-(build|build-retry|fix):/,
    result: (p, opts) => { seen.push(opts.label); return outageRun(ERR_404)() } }])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  assert.equal(state.units.a.status, 'pending')
  assert.equal(state.units.a.parked, true)
  assert.equal(state.units.b.status, 'pending')
  assert.equal(state.units.b.parked, true)
  assert.equal(state.halt.codex, 'codex-unavailable')
  // Distinctness is by unit, so two ids among the launched runs is what tripped it — and after
  // that no third run may exist: `worthRetry` gates on `!haltReason()`.
  const ids = [...new Set(seen.map((l) => l.replace(/^codex-[a-z-]+:/, '').replace(/#.*$/, '')))]
  assert.deepEqual(ids.sort(), ['a', 'b'], 'both units did run before anything halted')
  assert.ok(!has(calls, 'verify:'), 'nothing downstream is asked to judge work the outage prevented')
})

test('a plan role that dies under the outage parks the unit — never "the planner died twice"', async () => {
  const { fn, calls } = makeAgent([{ match: /^plan:/, result: () => codexRoleDead({ error: ERR_404 }) }])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  assert.equal(state.halt.codex, 'codex-unavailable', 'roles count toward the census — the provider is the provider')
  for (const id of ['a', 'b']) {
    assert.equal(state.units[id].status, 'pending', `${id} parks`)
    assert.equal(state.units[id].parked, true)
    assert.ok(!/planner died twice/.test(state.units[id].reason ?? ''), `${id} is not blamed for the outage`)
  }
  assert.ok(!has(calls, 'dossier:'), 'no dossier is written for a provider outage')
})

test('one unit 404ing while another succeeds is NOT an outage — the unit-level handling stands', async () => {
  const { fn } = makeAgent([{ match: /^codex-(build|build-retry):a/, result: outageRun(ERR_404) }])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  assert.equal(state.halt, undefined, 'one unit failing is that unit — a breaker that trips here is useless')
  assert.equal(state.units.b.status, 'merged', 'and the healthy unit finishes normally')
  assert.notEqual(state.units.a.parked, true, 'the failing unit is judged as before, never parked on an outage')
  assert.ok(kinds(state, 'codex-exec').length, 'its own failure is ledgered the way it always was')
})

// WHAT COUNTS AS A STATUS. The signal is text, so its precision is the only thing standing between
// "the provider is down" and "two units failed and one of the error lines had a number in it". Both
// halves are preconditions: `turn.failed` must be there, AND the 4xx/5xx must stand next to the word
// that makes it a status. The bare `\b([45]\d\d)\b` fallback this used to carry made a millisecond
// count, a line number and a byte count all read as provider verdicts.
test('outage signal: a status is a status only next to `status`/`HTTP`/`code`, and only under turn.failed', async () => {
  const halted = async (error) => {
    const { fn } = makeAgent([{ match: /^codex-(build|build-retry|fix):/, result: outageRun(error) }])
    return (await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())).halt
  }
  for (const error of [
    'turn.failed: unexpected status 404 Not Found (chatgpt.com/backend-api/codex/responses)',
    'turn.failed: HTTP 502 Bad Gateway',
    'turn.failed: request rejected, status code 503',
  ]) assert.equal((await halted(error))?.codex, 'codex-unavailable', `a real provider status counts: ${error}`)

  for (const error of [
    'turn.failed: took 503ms and produced no output',        // a duration, not a status
    'turn.failed: apply_patch failed at line 404 of app.ts',  // a line number
    'unexpected status 404 Not Found',                        // a status with no failed turn under it
  ]) assert.equal(await halted(error), undefined, `and nothing else does: ${error}`)
})

test('two units failing with DIFFERENT statuses is not one outage', async () => {
  const { fn } = makeAgent([
    { match: /^codex-(build|build-retry|fix):a/, result: outageRun(ERR_404) },
    { match: /^codex-(build|build-retry|fix):b/, result: outageRun(ERR_503) },
  ])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  assert.equal(state.halt, undefined, 'a 404 and a 503 are two facts, not one provider verdict')
  assert.equal(kinds(state, 'codex-unavailable').length, 0)
})

test('one unit failing twice is one unit — distinctness is by id, not by run', async () => {
  const { fn } = makeAgent([{ match: /^codex-(build|build-retry|fix):a/, result: outageRun(ERR_404) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.halt, undefined, 'a build and its retry both 404ing is still one unit\'s story')
  assert.equal(kinds(state, 'codex-unavailable').length, 0)
})

// CONSECUTIVE, in the other direction: any codex result WITHOUT the signature CLEARS the run. An
// outage has to be happening now, not to have happened once an hour ago — otherwise two unrelated
// 404s a wave apart, with every unit in between succeeding, halt a healthy wave. One unit's own
// codex steps are the cleanest way to see it: a single unit produces a strictly ORDERED sequence of
// results under distinct ids (`codex-spec-review:a`, then the build's `a`, then `verify:a#0`), so
// the sim states "404, success, 404" and "404, 404" as sequences and nothing else has to be true.
test('C1 breaker clear: a clean codex result between two 404s means they are not consecutive', async () => {
  // 404 (the spec critique) → SUCCESS (the build) → 404 (the verifier). Two 404s, one clear
  // between them, and the wave must run on.
  const { fn, calls } = makeAgent([
    { match: /^codex-spec-review:a/, result: () => codexRoleDead({ error: ERR_404 }) },
    { match: /^verify:a/, result: () => codexRoleDead({ error: ERR_404 }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.halt, undefined, 'the successful build in between cleared the run — this is not an outage')
  assert.equal(kinds(state, 'codex-unavailable').length, 0, 'and no breaker row is written')
  assert.equal(state.units.a.status, 'blocked', 'the dead verifier is handled the way it always was')
  assert.notEqual(state.units.a.parked, true, 'never parked on an outage nobody observed')
  assert.ok(!has(calls, 'dossier:a'))
})

test('C1 control: the SAME two ids with no clean result between them do trip it', async () => {
  // Identical to the sim above except the build 404s instead of succeeding, so nothing clears.
  const { fn } = makeAgent([
    { match: /^codex-spec-review:a/, result: () => codexRoleDead({ error: ERR_404 }) },
    { match: /^codex-(build|build-retry):a/, result: outageRun(ERR_404) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.halt.codex, 'codex-unavailable', 'two 404s back to back across different ids IS the provider')
  assert.equal(kinds(state, 'codex-unavailable').length, 1)
  assert.equal(state.units.a.parked, true, 'and the unit parks with whatever is on its branch')
})

// C4. The build RAN, reported, and left commits — and the backend was dead under it. `reportLost`
// is false here, so the ONLY thing that can park this unit is the error line's own outage
// signature. Without that arm the unit walks into verify → review → gate on work produced against
// a dead provider, which is the 2026-09-03 shape: judged, not parked.
test('C4 a 404\'d build that DID report is still parked once the breaker has tripped — its report is not a verdict', async () => {
  const reported = () => ({ ...implCodexOk(), codex: { ...codexMetaOk(), exitCode: 1, commits: 1, doneMarker: true, error: ERR_404 } })
  const { fn, calls } = makeAgent([
    { match: /^codex-spec-review:a/, result: () => codexRoleDead({ error: ERR_404 }) },   // trips id #1
    { match: /^codex-(build|build-retry):a/, result: reported },                          // trips id #2, WITH a report
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.halt.codex, 'codex-unavailable')
  assert.equal(state.units.a.status, 'pending')
  assert.equal(state.units.a.parked, true, 'the report exists, but nothing about this unit was judged')
  assert.match(state.units.a.note, /parked at implement:a/, 'and the note says where it stopped')
  assert.ok(!has(calls, 'verify:a'), 'the diff is never verified against a provider that is down')
  assert.ok(!has(calls, 'dossier:a'))
})

// C3. `halt.codex = halt.codex ?? 'codex-unavailable'`: a usage limit already observed is the more
// specific truth and keeps the slot — "wait the limit window out" and "wait the outage out" are
// different human actions. The breaker still trips (parking still happens); only the REASON is
// already spoken for, and since 2026-09-04 the breaker's own degradation row says which one won
// instead of always claiming `codex-unavailable`.
// The rendezvous is the sim: b and c must be IN FLIGHT when the limit lands, because a halt makes
// `codexRole` return null without ever launching — so they could not 404 after it if they waited.
const tick = () => new Promise((r) => setTimeout(r, 0))
test('C3 a usage limit keeps the halt slot when the breaker trips under it — and the row says so', async () => {
  let inFlight = 0
  let limitReturned = false
  const { fn, calls } = makeAgent([
    { match: /^plan:a$/, result: async () => {
      for (let i = 0; i < 500 && inFlight < 2; i++) await tick()
      limitReturned = true
      return { ok: true, result: { approach: 'x', files: [], testPlan: 'x', feasible: true },
        codex: { ...codexRoleMetaOk(), limitHit: true }, notes: '' }
    } },
    { match: /^plan:(b|c)$/, result: async () => {
      inFlight++
      for (let i = 0; i < 500 && !limitReturned; i++) await tick()
      await tick()   // one macrotask boundary drains every microtask that records the limit
      return codexRoleDead({ error: ERR_404 })
    } },
  ])
  const state = await runWave(fn, makePlan([unit('a'), unit('b'), unit('c')]), makeState())

  assert.equal(state.halt.codex, 'codex-usage-limit', 'the limit was recorded first and `??` keeps it')
  assert.equal(state.halt.reason, 'codex-usage-limit', 'so that is the reason the conductor hands the human')
  const rows = kinds(state, 'codex-usage-limit')
  assert.equal(rows.length, 2, 'the limit itself, and the breaker that tripped under it')
  const breaker = rows.find((d) => /consecutive codex runs/.test(d.what))
  assert.ok(breaker, 'the breaker row is there — the trip really happened')
  assert.match(breaker.what, /dispatch halts on codex-usage-limit/, 'and it names the reason that WON, not its own kind')
  assert.match(breaker.what, /relaunch after the limit window/, 'so the operator is told the right human action')
  assert.equal(kinds(state, 'codex-unavailable').length, 0,
    'no row claims `codex-unavailable` — the halt never said that, and a mislabelled row is a misdirected operator')
  for (const id of ['a', 'b', 'c']) {
    assert.equal(state.units[id].status, 'pending', `${id} parks`)
    assert.equal(state.units[id].parked, true)
    assert.ok(!has(calls, `dossier:${id}`), `${id} gets no dossier`)
  }
})

// A HALT AT A CODEX STEP IS A HALT, WHATEVER SLOT IT FILLED. `codexRole` returns null the moment
// `haltReason()` is set — it never launches the run — so an env or platform halt declared while a
// unit sits at its plan role produces exactly the same empty-handed return a dead planner does.
// Testing `codexOutaged()` alone there quarantined the unit as "the codex planner died twice" and
// spent a dossier on a halted wave (2026-09-04 review; the arc-observed version of this is the
// 2026-09-03 quarantine one line further down).
test('an ENV halt while a unit sits at its plan role parks it — never "the planner died twice"', async () => {
  // b and c block their verifiers, which is the two-in-one-wave HOST fact: `env-verify-blocked`.
  // a is still waiting on its plan role when that lands, and its role then comes back empty.
  let blocked = 0
  const { fn, calls } = makeAgent([
    { match: /^verify:(b|c)/, result: () => { blocked++; return BLOCKED_VERIFY() } },
    // `/^plan:a/`, not `/^plan:a$/`: a null result earns one salvage re-run (`plan:a#salvage`), and
    // a rule that let the salvage land a real plan would be testing the wrong thing entirely.
    { match: /^plan:a/, result: async () => {
      for (let i = 0; i < 500 && blocked < 2; i++) await tick()
      await tick()   // …and let the halt the second block declares be recorded
      return null
    } },
  ])
  const state = await runWave(fn, makePlan([unit('a'), unit('b'), unit('c')]), makeState(), { warmLanes: false })

  assert.equal(state.halt.env, 'env-verify-blocked', 'the host fact filled the ENV slot, not the codex one')
  assert.ok(!state.halt.codex, 'codex was never accused of anything')
  assert.equal(state.units.a.status, 'pending', 'and the unit at the plan role parks')
  assert.equal(state.units.a.parked, true)
  assert.match(state.units.a.note, /parked at plan:a: env-verify-blocked/,
    'the note names the halt reason that actually won — the operator fixes the host, not the provider')
  assert.ok(!/planner died twice/.test(state.units.a.reason ?? ''), 'never blamed for a halted wave')
  assert.ok(!has(calls, 'dossier:a'), 'and no dossier is spent on a halted wave')
})

test('the REPLAN site parks on a halt too — the architect redirected and the wave went down under it', async () => {
  // The plan lands, the plan-check redirects, and the revision is dispatched into a wave whose
  // codex slot is already halted by a usage limit the plan role itself reported. `codexRole`
  // refuses to launch, so the revision never comes back — and building the plan the architect just
  // rejected is the one thing that must not happen here.
  const { fn, calls } = makeAgent([
    { match: /^plan:a$/, result: () => ({ ok: true, result: { approach: 'x', files: [], testPlan: 'x', feasible: true },
      codex: { ...codexRoleMetaOk(), limitHit: true }, notes: '' }) },
    { match: /^opus-plan-check:a$/, result: () => ({ verdict: 'redirect', trigger: 'none', guidance: 'fold it into the existing seam' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  // The redirect branch really ran: the ruling was appended to the spec, which happens only there.
  // `replan:a` itself never reaches the agent — that IS the failure mode: `codexRole` refuses to
  // launch past a halt and hands back null, and this site used to read that null as a dead planner.
  assert.ok(has(calls, 'spec-append:a#plan'), 'the plan-check redirected and its ruling was recorded')
  assert.ok(!has(calls, 'replan:a'), 'and the revision was never launched — the halt stopped it before dispatch')
  assert.equal(state.units.a.status, 'pending')
  assert.equal(state.units.a.parked, true)
  assert.match(state.units.a.note, /parked at replan:a: codex-usage-limit/, 'and it names the halt, not the planner')
  assert.ok(!has(calls, 'codex-build:a'), 'the rejected plan is never built')
  assert.ok(!has(calls, 'dossier:a'))
})

/* ====================================================================== */
/* 2. The commit probe: absence of an answer is not an answer              */
/* ====================================================================== */
test('a dead commit probe parks the unit instead of quarantining it for building nothing', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a/, result: () => { throw structuredOutputError() } },   // report lost
    { match: /^commit-probe:a/, result: () => null },                               // and the probe dies too
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'pending', 'the branch may hold every milestone — nobody knows')
  assert.equal(state.units.a.parked, true)
  assert.ok(!has(calls, 'dossier:a'), 'and it is certainly not quarantined for having built nothing')
  assert.ok(kinds(state, 'commit-probe-unknown').length, 'the unknown is loud')
  assert.equal(state.halt, undefined,
    'one cheap probe dying twice is not a platform outage — the rest of the wave keeps running')
})

test('a commit probe that ANSWERS "no commits" still quarantines — the old verdict is intact', async () => {
  const { fn } = makeAgent([
    { match: /^codex-build:a/, result: () => { throw structuredOutputError() } },
    { match: /^commit-probe:a$/, result: courierSaying([[/rev-list --count/, '0']]) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /neither a report nor a commit/)
})

/* ====================================================================== */
/* 3. The host preflight: read the box before the box eats the wave        */
/* ====================================================================== */
const envProbe = (stdoutFor) => ({ match: /^env-probe:/, result: (p) => courierResult(p, BASE_SHA, stdoutFor) })
// Default host: pid cgroup nearly empty, no zombies, PID 1 = the ordinary devcontainer `sh`
// supervisor (`while sleep 1 & wait $!; do :; done`) — a name that is NOT on any init list and
// reaps perfectly well, which is exactly why the name decides nothing.
const host = ({ pids = '412\n36792', zombies = '0', pid1 = 'sh' }) => envProbe((cmd) =>
  /pids\.current/.test(cmd) ? pids : /grep -c '\^Z'/.test(cmd) ? zombies : /^ps -p 1\b/.test(cmd) ? pid1
    : /proc\/loadavg/.test(cmd) ? '30.5 20.0 10.0 3/512 1' : /^nproc$/.test(cmd) ? '16' : '')

test('pid-cgroup headroom below the floor halts the wave BEFORE dispatch', async () => {
  const { fn, calls } = makeAgent([host({ pids: '36350\n36792' })])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  assert.equal(state.halt.reason, 'env-pids-exhausted')
  assert.equal(state.halt.env, 'env-pids-exhausted')
  assert.equal(state.units.a.status, 'pending', 'a full pid cgroup is not a unit defect')
  assert.equal(state.units.b.status, 'pending')
  assert.ok(!has(calls, 'setup:'), 'ready() gates on the halt — not one worktree is built')
  assert.ok(!has(calls, 'codex-build:'), 'and no codex round is burned against a box that cannot fork')
  const [d] = kinds(state, 'env-pids-exhausted')
  assert.match(d.what, /36350\/36792/, 'the degradation carries the numbers it judged')
  assert.match(d.what, /init: true/, 'and names the operator action')
})

// The reaper axis is judged on the OUTCOME. The first cut of this guard was a known-init
// allowlist, and it was wrong on the very box the skill runs on: PID 1 = `sh` reaps fine (0
// zombies, 35 of 36,790 pids after three days), so a name test halts a healthy host while proving
// nothing about an unlisted one. The two real incidents were ~9,500 and 35,940 zombies.
test('a pathological zombie count halts, naming the count and PID 1', async () => {
  const { fn } = makeAgent([host({ zombies: '35940', pid1: 'sleep' })])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.halt.reason, 'env-no-reaper')
  assert.equal(state.units.a.status, 'pending')
  const [d] = kinds(state, 'env-no-reaper')
  assert.match(d.what, /35940 zombie processes/, 'the evidence it judged on is on the record')
  assert.match(d.what, /PID 1 is `sleep`/, 'PID 1 is reported — the operator needs it — but it decided nothing')
  assert.match(d.what, /init: true/, 'and the operator action is named')
})

test('a reaping host never halts, whatever PID 1 is called', async () => {
  // `sh` is the devcontainer idiom and is on no init list; the control is that it dispatches.
  for (const pid1 of ['sh', 'sleep', 'init', 'tini', 'bash', 'my-supervisor']) {
    const { fn } = makeAgent([host({ pid1 })])
    const state = await runWave(fn, makePlan([unit('a')]), makeState())
    assert.equal(state.halt, undefined, `PID 1 \`${pid1}\` with zero zombies is a reaping host`)
    assert.equal(state.units.a.status, 'merged', `PID 1 \`${pid1}\` dispatches normally`)
  }
})

test('a handful of zombies is a transient, not a halt — the threshold is far from both edges', async () => {
  for (const zombies of ['7', '999']) {
    const { fn } = makeAgent([host({ zombies })])
    const state = await runWave(fn, makePlan([unit('a')]), makeState())
    assert.equal(state.halt, undefined, `${zombies} zombies is under the 1000 floor`)
  }
  const { fn } = makeAgent([host({ zombies: '1000' })])
  assert.equal((await runWave(fn, makePlan([unit('a')]), makeState())).halt.reason, 'env-no-reaper',
    '1000 is the documented threshold, and it is inclusive')
})

test('an unlimited cgroup (`max`) and an unreadable one both fail SOFT — unknown is not exhausted', async () => {
  const unlimited = await runWave(makeAgent([host({ pids: '412\nmax' })]).fn, makePlan([unit('a')]), makeState())
  assert.equal(unlimited.halt, undefined, '`pids.max` = max is unlimited, not a breach')
  assert.equal(unlimited.units.a.status, 'merged')

  // cgroup v1 / a non-Linux host: the file is not there. A guard is a floor under a known fact.
  const { fn } = makeAgent([{ match: /^env-probe:/, result: (p) => {
    const r = courierResult(p, BASE_SHA, (cmd) => (/grep -c '\^Z'/.test(cmd) ? '0' : ''))
    r.results[0] = { ...r.results[0], exitCode: 1, stdout: 'No such file or directory' }
    return r
  } }])
  const unknown = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(unknown.halt, undefined, 'an unreadable file never halts a wave')
  assert.equal(unknown.units.a.status, 'merged')
  assert.ok(kinds(unknown, 'env-unprobed').length, 'but it is recorded — the wave ran unguarded on that axis')
})

test('the preflight is a closed command list, salted, and switchable off', async () => {
  const { fn, calls } = makeAgent([host({})])
  await runWave(fn, makePlan([unit('a')]), makeState())
  const p = promptOf(calls, 'env-probe:w1')
  // CHANGED CONTRACT (0.14.0): every numbered command carries the script-composed working directory
  // (`cd '/repo' && ( … )`), so a courier that never cd's itself first (0.14.0 update, wf_318afa1b-e9d:
  // couriers are told NOT to cd or pwd — the guard rides inside each command) still fails that
  // command's own exit code instead of probing whatever host directory it happened to start in.
  assert.match(p, /1\. cd '\/repo' && \( cat \/sys\/fs\/cgroup\/pids\.current \/sys\/fs\/cgroup\/pids\.max \)/,
    'exact commands, not a goal, and the cwd is part of the command')
  assert.match(p, /2\. cd '\/repo' && \( ps -eo stat= \| grep -c '\^Z' \|\| true \)/,
    'the zombie count carries `|| true` — grep -c exits 1 on zero, and the courier stops at the first non-zero exit')
  assert.match(p, /3\. cd '\/repo' && \( ps -p 1 -o comm= \)/)
  assert.match(p, /4\. cd '\/repo' && \( cat \/proc\/loadavg \)/,
    'the load pair rides the same courier, so lastLoad exists before any lane')
  assert.match(p, /judge none of it/, 'the pass test is the script\'s, not the courier\'s')
  assert.match(p, /Probe id launch-1/, 'salted like every environment probe — a resume re-reads the box')

  const { fn: fn2, calls: calls2 } = makeAgent()
  const state = await runWave(fn2, makePlan([unit('a')]), makeState(), { envPreflight: 'off' })
  assert.ok(!has(calls2, 'env-probe:'), 'off means off — no probe at all')
  assert.equal(state.units.a.status, 'merged')
})

/* ====================================================================== */
/* 4. Codex lifecycle: the deadline, the liveness rule, the reap           */
/* ====================================================================== */
test('the deadline rides inside the launched command line, so it survives the steerer', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState(), { codexTimeoutMin: 30 })
  const p = promptOf(calls, 'codex-build:a')
  assert.match(p, /setsid nohup sh -c 'echo \$\$ > \/wt\/__codex\/a\/build\/codex\.pid; timeout -k 30 1800 codex exec /,
    'timeout wraps codex INSIDE the detached sh -c — the steerer\'s death cannot outlive the deadline')
  assert.match(p, /exit-code contains 124/, 'and the launcher\'s own deadline is read back as timedOut')
})

test('a resumed session is wrapped too — the wedge is on the resume path as often as the fresh one', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a#0$/, result: VERIFY_FAIL }])
  await runWave(fn, makePlan([unit('a')]), makeState(), { codexFixTimeoutMin: 10 })
  const p = promptOf(calls, 'codex-fix:a#0')
  const D = '/wt/__codex/a/fix0'
  assert.match(p, new RegExp(`COMMAND R: cd /wt/a && setsid nohup sh -c 'echo \\$\\$ > ${D}/codex\\.pid; ` +
    'timeout -k 30 600 codex exec resume'))
  assert.match(p, new RegExp(`COMMAND F: setsid nohup sh -c 'echo \\$\\$ > ${D}/codex\\.pid; ` +
    'timeout -k 30 600 codex exec -C'))
  // COMMAND R used to run codex in the sh's FOREGROUND (`…; echo $? > exit-code`), which left the
  // resume path with no CPID to forward a TERM to. Both commands are now the same shape.
  assert.equal(p.split('& CPID=$!;').length - 1, 2, 'both launch commands background codex and hold its pid')
})

// The launch line, pinned as one shape across all three sites. 2026-09-02: `… & echo $! > codex.pid`
// recorded the pid of the fork setsid makes under job control — a process dead within a second — so
// `tail --pid`, `kill -0` and every group kill in the steer prompt hung off a corpse: 82 phantom
// `codex-lifecycle` rows, a second codex launched into a live worktree per "reattempt", and "exit
// 137" manufactured by the reap fallback. 3 waves, 14 of 20 units, none of the deaths real.
// 2026-09-04 added the LAST clause and the reason the whole body is pinned as one ORDERED sequence
// rather than as a head, a tail and an unchecked middle: the launch ends in `' &`, so the detached
// sh's "first act" pidfile write races the steerer's NEXT Bash call. `tail --pid=$(cat codex.pid)`,
// `kill -0`, and the "already launched?" re-dispatch guard would all read an absent file and
// manufacture the very false death the pidfile mechanic removes. The bounded wait closes it INSIDE
// the same command (probe-verified: the pidfile is genuinely absent on the first check).
test('every codex launch: the detached shell writes its OWN pid, forwards TERM, waits twice — and the command waits for the pidfile', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a#0$/, result: VERIFY_FAIL }])
  await runWave(fn, makePlan([unit('a')]), makeState())
  const prompts = calls.filter((c) => /^codex-(build|fix):a/.test(c.label))
  assert.ok(prompts.length >= 2, `build and fix both steer a codex run (saw ${prompts.length})`)
  for (const { label, prompt } of prompts) {
    // Every `setsid nohup sh -c '` opens a launch; its body must start with the pidfile write.
    const bodies = prompt.split("setsid nohup sh -c '").slice(1)
    assert.ok(bodies.length >= 1, `${label}: at least one launch command`)
    for (const body of bodies) {
      const dir = /^echo \$\$ > (\S+)\/codex\.pid; /.exec(body)?.[1]
      assert.ok(dir, `${label}: the detached shell records its own pid as its FIRST act, before anything else`)
      const d = dir.replace(/[.]/g, '\\.')
      // The resume launch (COMMAND R) has no session-id watcher — it already HAS the session id —
      // so that one member of the sequence is optional; every other member, and the ORDER, is not.
      const watcher = body.includes('codex exec resume ')
        ? ''
        : `\\( i=0; while \\[ "\\$i" -lt \\d+ \\] && \\[ ! -s ${d}/session-id \\];[^']*?` +
          `> ${d}/session-id; fi; sleep 1; i=\\$\\(\\(i\\+1\\)\\); done \\) & `
      assert.match(body, new RegExp(
        `^echo \\$\\$ > ${d}/codex\\.pid; ` +                                    // 1. pidfile, first act
        `timeout -k 30 \\d+ codex exec [^']*?` +                                 // 2. the deadline, inside
        `> ${d}/events\\.jsonl 2> ${d}/stderr\\.log & CPID=\\$!; ` +              // 3. backgrounded, pid held
        watcher +                                                                // 4. session-id watcher
        `trap "kill -TERM \\$CPID; T=1" TERM; ` +                                 // 5. TERM forwarded on
        `wait \\$CPID; RC=\\$\\?; ` +                                             // 6. the real wait
        `if \\[ -n "\\$T" \\]; then wait \\$CPID; RC=\\$\\?; fi; ` +               // 7. re-wait on the FLAG
        `echo \\$RC > ${d}/exit-code' & ` +                                       // 8. exit code, then detach
        `i=0; while \\[ ! -s ${d}/codex\\.pid \\] && \\[ "\\$i" -lt 50 \\]; ` +    // 9. …and wait for the pidfile
        `do sleep 0\\.2; i=\\$\\(\\(i\\+1\\)\\); done`),
      `${label}: the whole launch body, in order — pidfile write, deadline, background + CPID, ` +
      'session-id watcher, TERM trap, wait, flag-gated re-wait, exit code, detach, pidfile wait. ' +
      'The second wait is gated on the trap\'s FLAG, never on RC > 128: only a trap-interrupted ' +
      'wait leaves the child unreaped, and re-waiting a SIGKILLed (already reaped) child reports ' +
      'whatever the shell remembers rather than its true 137.')
      assert.ok(!body.includes('-gt 128'), `${label}: no exit-code test may stand in for the flag`)
      assert.ok(!/exit-code' &;/.test(body),
        `${label}: no \`;\` after the backgrounding \`&\` — \`cmd & ; next\` is a shell syntax error`)
    }
    assert.ok(!/echo \$! >/.test(prompt),
      `${label}: NEVER \`echo $! >\` after the \`&\` — under job control that names a fork that is already dead`)
  }
})

test('an absent exit-code file is RUNNING: -1 needs a dead pid, never a long wait', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  const p = promptOf(calls, 'codex-build:a')
  assert.match(p, /A MISSING \/wt\/__codex\/a\/build\/exit-code MEANS RUNNING, NEVER DEAD/)
  assert.match(p, /kill -0 \$\(cat \/wt\/__codex\/a\/build\/codex\.pid\)/, 'the liveness test is named as a command')
  assert.match(p, /only if it FAILS while \S+exit-code is still absent may you stop and report exitCode -1/,
    '-1 is licensed by a dead pid and nothing else')
  assert.match(p, /Elapsed time on its own is never evidence/)
})

test('a re-dispatched steer prompt attaches instead of launching a second codex', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  const p = promptOf(calls, 'codex-build:a')
  assert.match(p, /if \/wt\/__codex\/a\/build\/codex\.pid already exists, a run was ALREADY launched/,
    'the idempotence preamble makes any replay of this prompt safe by construction')
  assert.match(p, /do NOT launch a second one and do NOT delete the file/)
  assert.match(p, /skip straight to step 4 and attach/)
})

test('the build retry reaps the previous pid and tells codex the sibling would be a bug', async () => {
  const { fn, calls } = makeAgent([{ match: /^codex-build:a$/, result: deadRun }])
  await runWave(fn, makePlan([unit('a')]), makeState())

  const p = promptOf(calls, 'codex-build-retry:a')
  assert.ok(p, 'the one-shot retry still fires')
  assert.match(p, /REAP THE PREVIOUS ATTEMPT FIRST/)
  assert.match(p, /kill -TERM -- -\$\(cat \/wt\/__codex\/a\/build\/codex\.pid\)/, 'the OLD dir is the kill target')
  assert.match(p, /kill -KILL -- -\$\(cat \/wt\/__codex\/a\/build\/codex\.pid\)/)
  assert.match(p, /wait until \/wt\/__codex\/a\/build\/exit-code exists/, 'and it waits for the corpse')
  assert.match(p, /# PRIOR ATTEMPT/, 'the brief itself says the previous attempt is dead')
  assert.match(p, /that is a HARNESS bug, not a condition to wait on/,
    'a live sibling is reported as blocked, never narrated for an hour')
  assert.match(p, /\/wt\/__codex\/a\/build-retry\//, 'the retry writes its own artifact dir')
})

test('the fix step gets the same one-shot retry — and exactly one', async () => {
  const { fn, calls } = makeAgent([
    { match: /^verify:a#0$/, result: VERIFY_FAIL },
    { match: /^codex-fix:a#0$/, result: deadRun },
    { match: /^codex-fix:a#0#reattempt$/, result: deadRun },   // the retry dies too
  ])
  await runWave(fn, makePlan([unit('a')]), makeState())

  const tries = calls.filter((c) => c.label.startsWith('codex-fix:a#0'))
  assert.deepEqual(tries.map((c) => c.label), ['codex-fix:a#0', 'codex-fix:a#0#reattempt'],
    'one reattempt, and a dead reattempt never spawns another')
  assert.match(tries[1].prompt, /REAP THE PREVIOUS ATTEMPT FIRST/, 'it reaps like the build retry does')
  assert.match(tries[1].prompt, /kill -TERM -- -\$\(cat \/wt\/__codex\/a\/fix0\/codex\.pid\)/, 'its own round is the target')
})

test('codex-exec splits: -1 is a lifecycle failure, a real non-zero exit is not', async () => {
  const lifecycle = await runWave(makeAgent([{ match: /^codex-build:a$/,
    result: () => ({ ...implCodexOk(), codex: { ...codexMetaOk(), exitCode: -1, commits: 1 } }) }]).fn,
  makePlan([unit('a')]), makeState())
  assert.equal(kinds(lifecycle, 'codex-exec').length, 0, 'an unobserved exit is not evidence codex failed')
  assert.match(kinds(lifecycle, 'codex-lifecycle')[0].what, /never observed to finish/)

  const failed = await runWave(makeAgent([{ match: /^codex-build:a$/,
    result: () => ({ ...implCodexOk(), codex: { ...codexMetaOk(), exitCode: 2, commits: 1 } }) }]).fn,
  makePlan([unit('a')]), makeState())
  assert.equal(kinds(failed, 'codex-lifecycle').length, 0)
  assert.match(kinds(failed, 'codex-exec')[0].what, /codex exited 2/)
})

test('the error sliver is one line under its cap, not five concatenated ones', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  const p = promptOf(calls, 'codex-build:a')
  assert.match(p, /tail -5 \| cut -c1-250/, 'each candidate line is cut to the field budget')
  assert.match(p, /never concatenate several of them/, 'and the report may take exactly one of them')
  assert.ok(!/cut -c1-300/.test(p), 'the old 5×300-into-300 shape is gone')
})

/* ====================================================================== */
/* 5. Debt: dedupe, and resolved ghosts stop forcing a return              */
/* ====================================================================== */
test('identical debt items bank once; a reworded one still banks', async () => {
  const { fn } = makeAgent([{ match: /^codex-build:a$/, result: () => ({ ...implCodexOk(), debt: [
    { what: 'same finding', why: 'x', kind: 'structure' },
    { what: 'same finding', why: 'x', kind: 'structure' },
    { what: 'same finding', why: 'a different why does not make it a different item', kind: 'structure' },
    { what: 'a genuinely different finding', why: 'x', kind: 'structure' },
  ] }) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  const whats = state.debt.map((d) => d.what)
  assert.equal(whats.filter((w) => w === 'same finding').length, 1, 'the repeat is dropped, not renamed or renumbered')
  assert.ok(whats.includes('a genuinely different finding'))
})

test('a contract mismatch on a unit whose work already landed banks as `rebanked`', async () => {
  // Names a contract file, so the mismatch is CORROBORATED and banks as kind:'contract' (an
  // uncorroborated one banks as a major non-contract item — harness.test.mjs 9f).
  const withMismatch = () => ({ ...implCodexOk(), contractMismatch: 'the frozen surface in .roadmap/contracts/auth.md disagrees' })
  // A resume: the record says merge-ready, so the branch has already been through the gate. The
  // cached implementer report replays verbatim and re-banks its mismatch.
  const { fn } = makeAgent([{ match: /^codex-build:a$/, result: withMismatch }])
  const resumed = await runWave(fn, makePlan([unit('a')]),
    makeState({ units: { a: { status: 'merge-ready', branch: 'unit/a', base: BASE_SHA } } }))
  const ghost = resumed.debt.find((d) => d.kind === 'contract')
  assert.ok(ghost, 'the item is kept — dropping evidence is worse than marking it')
  assert.equal(ghost.rebanked, true, 'but stamped, so the conductor can tell a ghost from a live finding')

  const { fn: fn2 } = makeAgent([{ match: /^codex-build:a$/, result: withMismatch }])
  const fresh = await runWave(fn2, makePlan([unit('a')]), makeState())
  assert.equal(fresh.debt.find((d) => d.kind === 'contract').rebanked, undefined,
    'a first-time mismatch is a live finding and is NOT stamped')
})

/* ====================================================================== */
/* 6. A blocked VERIFY: tooling that could not run is a host fact          */
/* ====================================================================== */
// 2026-09-04: `pnpm audit --audit-level high` inside `pnpm verify` hung on a black-holed registry
// POST. The verifier reported `blocked:true` — honestly — and the FIRST unit to reach it was
// quarantined for it, dossier and all, for a defect that was not its own and that no respec could
// fix. Same family as every other entry in this file: an environment fact converted into a unit
// verdict. The graduated answer: block once (commits intact, re-verified next wave), quarantine on
// a repeat (it is this checkout's problem), and halt the wave the moment TWO units say it in one
// wave (it is the box's problem, and no number of unit verdicts fixes a box).
const BLOCKED_VERIFY = () => ({ pass: false, blocked: true, failures: ['ECONNRESET https://registry.npmjs.org/-/npm/v1/security/audits'],
  lanes: [], contractSurfaceTouched: false, diffFiles: [] })

test('one blocked verify BLOCKS the unit: no quarantine, no dossier, commits intact', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: BLOCKED_VERIFY }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'blocked', 'tooling that could not run is not a verdict about the unit')
  assert.equal(state.units.a.branch, 'unit/a', 'the branch — and everything committed on it — is named on the record')
  assert.equal(state.units.a.rounds?.verifyBlocked, 1, 'tallied, so a repeat next wave is countable')
  assert.ok(!has(calls, 'dossier:a'), 'no redesign dossier over a registry that went dark')
  assert.ok(!has(calls, 'codex-fix:a'), 'and no fix round — there is nothing to fix in the unit')
  assert.equal(state.halt, undefined, 'ONE blocked verify halts nothing: it may still be this checkout alone')
  const d = kinds(state, 'verify-blocked')
  assert.equal(d.length, 1, 'the environment fact is ledgered, once')
  assert.match(d[0].what, /BLOCKED, not/, 'and the row says which door the unit went through')
  assert.match(d[0].what, /ECONNRESET/, 'carrying the verifier\'s own first failure line, so the operator can act')
})

test('blocked AGAIN on a later wave quarantines: twice is not transient', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: BLOCKED_VERIFY }])
  const state = await runWave(fn, makePlan([unit('a')]),
    makeState({ wave: 1, units: { a: { status: 'blocked', branch: 'unit/a', rounds: { verifyBlocked: 1 } } } }))

  assert.equal(state.units.a.status, 'quarantined', 'the second blocked verify is the unit\'s own problem to route')
  assert.match(state.units.a.reason, /environment\/tooling blocked verification/)
  assert.equal(state.units.a.rounds?.verifyBlocked, 2, 'the tally survived the wave boundary — that is what counts it')
  assert.ok(has(calls, 'dossier:a'), 'and NOW a dossier is written: the boundary has to route it')
  const [d] = kinds(state, 'verify-blocked')
  assert.match(d.what, /on 2 separate waves/, 'the ledger says why this one quarantined and the first did not')
})

test('a blocked unit\'s commits are ADOPTED next wave, never re-read as un-adopted work', async () => {
  // The whole point of blocking rather than quarantining is that the branch survives. Without
  // adoption the next wave's setup sees commits beyond base that nothing claims and quarantines on
  // 'has-commits' — the same verdict by another route.
  const { fn, calls } = makeAgent([
    // The branch exists (sha), was never merged, worktree present…
    { match: /^merged-probe:a$/, result: () => ({ ok: true, exitCodes: [0, 1, 0], out: ['d'.repeat(40)] }) },
    // …and holds 3 commits beyond base: last wave's implementation, which nobody judged.
    { match: /^setup-commits:a$/, result: () => ({ ok: true, exitCodes: [0], out: ['3'] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]),
    makeState({ wave: 1, units: { a: { status: 'blocked', branch: 'unit/a', rounds: { verifyBlocked: 1 } } } }))

  assert.equal(state.units.a.status, 'merged', 'the adopted branch runs the pipeline again and lands')
  assert.ok(!has(calls, 'codex-build:a'), 'and it is NOT rebuilt from scratch — the commits are its own progress')
  assert.equal(kinds(state, 'verify-blocked').length, 0, 'nothing was blocked this wave')
})

test('TWO units blocked in one wave halts the wave: a host fact, not two unit defects', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:(a|b|d)/, result: BLOCKED_VERIFY }])
  // `c` depends on `m`, which merges normally — so `c` becomes dependency-ready DURING the wave and
  // is the unit that proves the halt gates NEW dispatch rather than merely stopping the two blocked.
  // `d` blocks too, AFTER the halt is already declared: the ledger must still carry exactly one row.
  const state = await runWave(fn,
    makePlan([unit('m'), unit('a'), unit('b'), unit('d'), unit('c')], [{ from: 'm', to: 'c', type: 'semantic', mode: 'contract' }]),
    makeState(), { warmLanes: false })

  assert.equal(state.halt.reason, 'env-verify-blocked', 'the wave halts on the host, not on either unit')
  assert.equal(state.halt.env, 'env-verify-blocked', 'and it fills the env slot of the halt record')
  for (const id of ['a', 'b']) {
    assert.equal(state.units[id].status, 'blocked', `${id} is blocked, with its commits`)
    assert.notEqual(state.units[id].status, 'quarantined', `${id} is never quarantined for the box`)
  }
  assert.ok(!has(calls, 'dossier:a') && !has(calls, 'dossier:b'), 'no dossiers: nothing about either unit was judged')
  assert.equal(state.units.c.status, 'pending', 'the unit behind the halt is left pending, not judged')
  assert.ok(!has(calls, 'setup:c'), 'and never dispatched — ready() gates on the halt record')
  assert.equal(state.units.d.status, 'blocked', 'the third unit blocks too, on the same host fact')
  const rows = kinds(state, 'env-verify-blocked')
  // ONE row, however many units go on to block. `!halt.env` is what makes it fire once — and the
  // same test is what stops it overwriting a preflight halt (`env-pids-exhausted`, `env-no-reaper`)
  // that was already the wave's reason before a single verifier ran.
  assert.equal(rows.length, 1, 'the host fact is ledgered once, not once per blocked unit')
  const [d] = rows
  assert.match(d.what, /host fact/, 'the row says what it is')
  assert.match(d.what, /\(a, b\)/, 'and names the two units it judged on — the third arrived after the verdict')
  assert.match(d.what, /fix the host, relaunch/, 'and the one human action')
})

// C5. A halt is never a verdict, so a halted wave BLOCKS a unit whatever its own tally says. Without
// the `!haltReason()` half of this test, the second unit to reach a two-round blocked tally inside a
// wave the host has already halted is quarantined — for the box, on the round the box itself caused.
test('C5 a unit on its SECOND blocked round inside an already-halted wave blocks — it is not quarantined', async () => {
  // `a` carries `rounds.verifyBlocked: 1` from last wave and is adopted with its commits, so this
  // wave is its second. `b` and `c` block first, which is what declares `env-verify-blocked`; only
  // then does `a`'s own verifier report blocked.
  let others = 0
  const { fn, calls } = makeAgent([
    { match: /^verify:(b|c)/, result: () => { others++; return BLOCKED_VERIFY() } },
    { match: /^verify:a/, result: async () => {
      for (let i = 0; i < 500 && others < 2; i++) await tick()
      await tick()   // …and let the halt the second block declares be recorded
      return BLOCKED_VERIFY()
    } },
    { match: /^merged-probe:a$/, result: () => ({ ok: true, exitCodes: [0, 1, 0], out: ['d'.repeat(40)] }) },
    { match: /^setup-commits:a$/, result: () => ({ ok: true, exitCodes: [0], out: ['3'] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a'), unit('b'), unit('c')]),
    makeState({ wave: 1, units: { a: { status: 'blocked', branch: 'unit/a', rounds: { verifyBlocked: 1 } } } }),
    { warmLanes: false })

  assert.equal(state.halt.env, 'env-verify-blocked', 'the wave is halted on the host before `a` reports')
  assert.equal(state.units.a.rounds.verifyBlocked, 2, 'and `a` really is on its second blocked round')
  assert.equal(state.units.a.status, 'blocked', 'which still blocks — the halt outranks the tally')
  assert.notEqual(state.units.a.status, 'quarantined')
  assert.ok(!has(calls, 'dossier:a'), 'no dossier: nothing about this unit was judged either')
  assert.ok(!kinds(state, 'verify-blocked').some((r) => /on 2 separate waves/.test(r.what)),
    'and the ledger never claims two INDEPENDENT waves proved anything about this unit')
})

/* ====================================================================== */
/* 7. The conductor reads one halt field and one debt flag                 */
/* ====================================================================== */
async function driveConductorWith(waveState, extraState = {}) {
  const { fn: workflowFn } = makeWorkflow(() => waveState)
  const plan = makePlan([unit('a'), unit('b')])
  const state = makeState({ spend: {}, wave: 0, ...extraState })
  const { fn: agentFn, calls } = makeAgent([
    ...packRules(plan, state),
    { match: /^bank-debt:/, result: { ok: true } },
    { match: /^move-feedback:/, result: courierOk },
  ])
  const runner = await loadScript(CONDUCTOR)
  const res = await runner({
    args: {
      roadmapDir: `${plan.repoPath}/.roadmap`,
      launchId: 'sim-launch',
      config: {},
      harnessPath: '/skills/orchestrate/harness.mjs',
    },
    agent: agentFn,
    workflow: workflowFn,
  })
  return { res, calls }
}
const HALTED = (reason, slot) => ({
  integrationBranch: 'roadmap/session-test', integrationTip: BASE_SHA, consultsUsed: 0, spend: {}, wave: 1, debt: [],
  units: { a: { status: 'pending', parked: true }, b: { status: 'pending' } },
  halt: { reason, [slot]: reason },
  codex: { probed: 1, available: slot !== 'codex' },
})

test('every halt reason early-returns at tier 4, before any census or triage spend', async () => {
  for (const [reason, slot] of [['platform-outage', 'platform'], ['env-no-reaper', 'env'],
    ['env-pids-exhausted', 'env'], ['codex-usage-limit', 'codex']]) {
    const { res, calls } = await driveConductorWith(HALTED(reason, slot))
    assert.equal(res.reason, reason, `${reason} is returned verbatim — the root reads it as the human action`)
    assert.deepEqual(res.parked, ['a'], 'and the parked units are named')
    assert.ok(!has(calls, 'census:'), `${reason}: no census against a wave the root must hand to a human`)
    assert.ok(!has(calls, 'triage:'))
    assert.ok(res.state?.units, 'the full wave state rides home on the envelope — every halt must be resumable')
    assert.deepEqual((res.state.conductor?.boundaries ?? []).map((x) => x.tier), [4])
  }
})

test('a rebanked contract ghost does not force a contract-amendment return; a live one does', async () => {
  const item = (extra = {}) => ({ unit: 'a', kind: 'contract', severity: 'major', what: 'surface disagrees', why: 'y', ...extra })
  const wave = (debt) => ({
    integrationBranch: 'roadmap/session-test', integrationTip: BASE_SHA, consultsUsed: 0, spend: {}, wave: 1,
    debt, units: { a: { status: 'merged' }, b: { status: 'merged' } },
    codex: { probed: 1, available: true },
    boundary: { explorer: null, health: { findings: [], fixUnits: [] }, flake: null, design: null },
  })
  const live = await driveConductorWith(wave([item()]))
  assert.equal(live.res.reason, 'contract-amendment', 'a live mismatch still goes to the architect')

  const ghost = await driveConductorWith(wave([item({ rebanked: true })]))
  assert.notEqual(ghost.res.reason, 'contract-amendment', 'a resolved ghost never drags the arc back')
  assert.ok(ghost.res.state.debt.some((d) => d.rebanked), 'and it is still debt — banked, just not escalated')
})
