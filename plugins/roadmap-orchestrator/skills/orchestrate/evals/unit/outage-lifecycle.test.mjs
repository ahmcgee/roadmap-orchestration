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
import { makeAgent, makeWorkflow, packRules, courierResult, BASE_SHA, implCodexOk, codexMetaOk, structuredOutputError } from './fakes.mjs'

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
// The four `verify.blocked` derefs of the ledger. A null verify used to reach the scheduler's
// catch as a TypeError and be recorded as the UNIT's pipeline error.
test('a null verify parks the unit — never a quarantine, never a pipeline-error verdict', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: () => null }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'pending', 'a dead agent leaves the unit resumable')
  assert.equal(state.units.a.parked, true, '`parked` is what makes next wave adopt its commits')
  assert.match(state.units.a.note, /platform outage/, 'the record says whose failure it was')
  assert.ok(!/pipeline error/.test(state.units.a.note ?? ''), 'and never blames the unit for it')
  assert.ok(!has(calls, 'dossier:a'), 'no redesign dossier is written for a platform failure')
  assert.equal(state.halt.reason, 'platform-outage', 'the wave halts, so nothing else is dispatched into a dead platform')
  assert.equal(state.halt.platform, 'platform-outage')
  assert.ok(kinds(state, 'platform-outage').length, 'the outage is ledgered, once')
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
  // b sits behind a's merge, so the halt is observed before b is ever ready.
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: () => null }])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')],
    [{ from: 'a', to: 'b', type: 'semantic', mode: 'contract' }]), makeState(), { warmLanes: false })

  assert.equal(state.units.b.status, 'pending')
  assert.ok(!has(calls, 'setup:b'), 'not even a worktree is built into a dead platform')
})

// The throw path is the ONLY one carrying text — a null carries no error object at all — so quota
// and connection strings are read there, and only as a fast path.
test('a quota error on the throw path halts immediately, without burning a salvage agent', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: () => { throw new Error('Usage limit reached for this week') } }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.halt.reason, 'platform-outage')
  assert.ok(!has(calls, 'verify:a#0#salvage'), 'a platform that just said it is down is not asked twice')
  assert.equal(state.units.a.parked, true)
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
    { match: /^commit-probe:a$/, result: { ok: false, sha: '' } },
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
  assert.match(p, /1\. cat \/sys\/fs\/cgroup\/pids\.current \/sys\/fs\/cgroup\/pids\.max/, 'exact commands, not a goal')
  assert.match(p, /2\. ps -eo stat= \| grep -c '\^Z' \|\| true/,
    'the zombie count carries `|| true` — grep -c exits 1 on zero, and the courier stops at the first non-zero exit')
  assert.match(p, /3\. ps -p 1 -o comm=/)
  assert.match(p, /4\. cat \/proc\/loadavg/, 'the load pair rides the same courier, so lastLoad exists before any lane')
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
  assert.match(p, /setsid nohup sh -c 'timeout -k 30 1800 codex exec /,
    'timeout wraps codex INSIDE the detached sh -c — the steerer\'s death cannot outlive the deadline')
  assert.match(p, /exit-code contains 124/, 'and the launcher\'s own deadline is read back as timedOut')
})

test('a resumed session is wrapped too — the wedge is on the resume path as often as the fresh one', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a#0$/, result: VERIFY_FAIL }])
  await runWave(fn, makePlan([unit('a')]), makeState(), { codexFixTimeoutMin: 10 })
  const p = promptOf(calls, 'codex-fix:a#0')
  assert.match(p, /COMMAND R: cd \/wt\/a && setsid nohup sh -c 'timeout -k 30 600 codex exec resume/)
  assert.match(p, /COMMAND F: setsid nohup sh -c 'timeout -k 30 600 codex exec -C/)
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
  const withMismatch = () => ({ ...implCodexOk(), contractMismatch: 'the frozen surface disagrees' })
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
/* 6. The conductor reads one halt field and one debt flag                 */
/* ====================================================================== */
async function driveConductorWith(waveState, extraState = {}) {
  const { fn: workflowFn } = makeWorkflow(() => waveState)
  const plan = makePlan([unit('a'), unit('b')])
  const state = makeState({ spend: {}, wave: 0, ...extraState })
  const { fn: agentFn, calls } = makeAgent([
    ...packRules(plan, state),
    { match: /^(bank-debt|move-feedback):/, result: { ok: true } },
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
