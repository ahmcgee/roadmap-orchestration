// Zero-token control-flow simulation of THE LANE SPLIT (0.19.0, RATIONALE §24): the cheap
// execution model builds at its top effort, the strong model of the same family writes the
// specification (plan/replan/critique), reads the output (the review digest), takes the units the
// root appoints it to, and becomes the builder once a unit's fix rounds pile up.
//
// What this file locks, and why:
//   1. THE DEFAULTS — luna at `max` builds, luna at `high` fixes, and every judgment role runs on
//      sol. A silent drift here (a fix round back on `max`, the plan on the cheap model) costs a paid
//      arc to notice.
//   2. APPOINTMENT — `unit.codexModel: 'strong'`, `codexStrongRisk`, a literal pin, and 'default'
//      each route exactly as documented, and a literal pin is absolute.
//   3. THE ESCALATION RUNG — the fix round at which the strong model takes over is the summed
//      tally of every round kind, the escalated round is COLD (no resume across models), and the
//      rung is off at 0 or with no strong model.
//   4. THE PLAN BRIEF carries the specification standard only when a different model builds.
//   5. `spend.codexStrong` counts what actually ran on the strong model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { makeAgent } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const WT = '/wt'
const makePlan = (units, edges = [], extra = {}) => ({ repoPath: '/repo', worktreeRoot: WT, units, edges, ...extra })
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/session-codex', integrationTip: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', consultsUsed: 0, wave: 0, units: {}, ...extra,
})
async function runWave(agentFn, plan, state, config = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config } }, agent: agentFn })
}
const promptOf = (calls, label) => calls.find((c) => c.label === label)?.prompt ?? ''
// The composed `codex exec` launch line is the only place the model and effort are observable:
// `-m <model> -c model_reasoning_effort=<effort>` on the exec (and, on a resume-carrying fix
// prompt, on both COMMAND R and COMMAND F — they must agree).
const laneOf = (calls, label) => {
  const p = promptOf(calls, label)
  assert.ok(p, `${label} fired`)
  const found = [...p.matchAll(/-m (\S+) -c model_reasoning_effort=(\w+)/g)].map((m) => ({ model: m[1], effort: m[2] }))
  assert.ok(found.length >= 1, `${label} carries a model + effort pair`)
  for (const f of found) assert.deepEqual(f, found[0], `${label}: every launch line in the prompt names the same model/effort`)
  return { ...found[0], cold: !p.includes('codex exec resume') }
}

const VERIFY_OK = { pass: true, blocked: false, failures: [], lanes: [{ command: 'npm test', exitCode: 0 }], contractSurfaceTouched: false, diffFiles: [] }
const VERIFY_FAIL = { ...VERIFY_OK, pass: false, failures: ['assert: expected 1, got 2'] }
const failN = (n) => { let i = 0; return () => (i++ < n ? VERIFY_FAIL : VERIFY_OK) }
const revise = { verdict: 'revise', directives: [{ what: 'tighten the seam', why: 'it leaks' }], debt: [] }

// =========================================================================================
// 1. Defaults: the execution model at its ceiling for the build, one step down for a fix; every
//    judgment role on the strong model; the pre-gate review on it too.
// =========================================================================================
test('1 defaults: luna/max builds, luna/high fixes, sol writes the plan, the critique and the review digest', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: failN(1) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'merged')
  assert.deepEqual(laneOf(calls, 'codex-build:a'), { model: 'gpt-5.6-luna', effort: 'max', cold: true })
  assert.deepEqual(laneOf(calls, 'codex-fix:a#0'), { model: 'gpt-5.6-luna', effort: 'high', cold: false },
    'the first fix round stays on the execution model and resumes its session')
  assert.deepEqual(laneOf(calls, 'plan:a'), { model: 'gpt-5.6-sol', effort: 'high', cold: true }, 'the plan is the strong model\'s at codexPlanEffort')
  assert.equal(laneOf(calls, 'codex-spec-review:a').model, 'gpt-5.6-sol', 'the spec critique is the strong model\'s')
  assert.equal(laneOf(calls, 'codex-review:a').model, 'gpt-5.6-sol', 'the review digest is the strong model\'s')
  assert.equal(laneOf(calls, 'verify:a#0').model, 'gpt-5.6-luna', 'verify is mechanical and stays on the execution model')
  assert.ok(!('codexStrong' in state.spend), 'nothing ran on the strong BUILD lane, so no strong tally appears')
})

// =========================================================================================
// 2. Appointment: the root's per-unit pin, the risk-tier default, a literal, and 'default'.
// =========================================================================================
test('2 appointment: unit.codexModel "strong", codexStrongRisk, a literal pin, and "default"', async () => {
  const plan = makePlan([
    unit('s', { codexModel: 'strong' }),
    unit('h', { risk: 'high' }),
    unit('t', { codexModel: 'gpt-5.6-terra', codexEffort: 'medium' }),
    unit('d', { risk: 'high', codexModel: 'default' }),
  ])
  const { fn, calls } = makeAgent([
    { match: /^plan-check:h|^plan-check:d/, result: { verdict: 'approve', guidance: '', notes: '' } },
    { match: /^gate:h|^gate:d/, result: { verdict: 'approve', directives: [], debt: [] } },
  ])
  const state = await runWave(fn, plan, makeState())
  for (const id of ['s', 'h', 't', 'd']) assert.equal(state.units[id].status, 'merged', `${id} merged`)
  assert.deepEqual(laneOf(calls, 'codex-build:s'), { model: 'gpt-5.6-sol', effort: 'high', cold: true }, '"strong" resolves through codexStrongModel at codexStrongEffort')
  assert.deepEqual(laneOf(calls, 'codex-build:h'), { model: 'gpt-5.6-sol', effort: 'high', cold: true }, 'risk:high is in codexStrongRisk by default')
  assert.deepEqual(laneOf(calls, 'codex-build:t'), { model: 'gpt-5.6-terra', effort: 'medium', cold: true }, 'a literal pin and a per-unit effort pass through verbatim')
  assert.deepEqual(laneOf(calls, 'codex-build:d'), { model: 'gpt-5.6-luna', effort: 'max', cold: true }, '"default" opts a high-risk unit back out of the strong lane')
  assert.equal(state.spend.codexStrong, 2, 'two builds ran on the strong lane (s and h)')
  // The plan brief's specification standard: present exactly where a DIFFERENT model builds.
  assert.ok(promptOf(calls, 'plan:d').includes('DIFFERENT, less capable model (gpt-5.6-luna)'), 'luna builds d → the plan is told to specify for it')
  assert.ok(promptOf(calls, 'plan:t').includes('DIFFERENT, less capable model (gpt-5.6-terra)'), 'a literal builder is named too')
  assert.ok(!promptOf(calls, 'plan:s').includes('DIFFERENT, less capable model'), 'sol plans AND builds s → no clause')
  assert.ok(!promptOf(calls, 'plan:h').includes('DIFFERENT, less capable model'), 'same for a risk-appointed unit')

  const { fn: fn2, calls: calls2 } = makeAgent([
    { match: /^plan-check:h/, result: { verdict: 'approve', guidance: '', notes: '' } },
    { match: /^gate:h/, result: { verdict: 'approve', directives: [], debt: [] } },
  ])
  await runWave(fn2, makePlan([unit('h', { risk: 'high' })]), makeState(), { codexStrongRisk: [] })
  assert.equal(laneOf(calls2, 'codex-build:h').model, 'gpt-5.6-luna', 'codexStrongRisk: [] turns the tier route off')
})

// =========================================================================================
// 3. The escalation rung: the summed round tally, cold on the model change, off at 0 / no model.
// =========================================================================================
test('3a escalation by verify-fix rounds: the second fix of any kind runs cold on the strong model', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: failN(2) }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'merged')
  assert.deepEqual(laneOf(calls, 'codex-fix:a#0'), { model: 'gpt-5.6-luna', effort: 'high', cold: false }, 'round 1: execution model, resumed')
  assert.deepEqual(laneOf(calls, 'codex-fix:a#1'), { model: 'gpt-5.6-sol', effort: 'high', cold: true }, 'round 2 reaches codexStrongAfterRounds: strong model, COLD')
  const p = promptOf(calls, 'codex-fix:a#1')
  assert.ok(!p.includes('COMMAND R') && p.includes('use this launch command'), 'no resume branch survives a model change')
  assert.equal(state.spend.codexStrong, 1)
})

test('3b escalation counts gate rounds too: verify-fix + first-pass gate-fix sum to the rung', async () => {
  const { fn, calls } = makeAgent([
    { match: /^verify:a/, result: failN(1) },
    { match: /^opus-gate:a#0/, result: revise },
    { match: /^opus-gate:a#1/, result: { verdict: 'approve', directives: [], debt: [] } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.equal(state.units.a.status, 'merged')
  assert.equal(laneOf(calls, 'codex-fix:a#0').model, 'gpt-5.6-luna', 'fix tally 1 → execution model')
  assert.deepEqual(laneOf(calls, 'codex-opus-gate-fix:a#0'), { model: 'gpt-5.6-sol', effort: 'high', cold: true },
    'fix 1 + opusGate 1 = 2 → the first gate-fix already escalates, cold')
})

test('3c the frontier gate loop escalates the same way, and the fresh last round stays fresh', async () => {
  const { fn, calls } = makeAgent([
    { match: /^gate:a#close$/, result: { verdict: 'approve', debt: [] } },
    { match: /^gate:a#/, result: revise },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { exitGate: 'always-fable' })
  assert.equal(state.units.a.status, 'merged')
  assert.deepEqual(laneOf(calls, 'codex-gate-fix:a#0'), { model: 'gpt-5.6-luna', effort: 'high', cold: false }, 'gate tally 1 → execution model, resumed')
  assert.deepEqual(laneOf(calls, 'codex-gate-fix:a#1'), { model: 'gpt-5.6-sol', effort: 'high', cold: true }, 'gate tally 2 → strong, and cold either way')
})

test('3d the rung is off at codexStrongAfterRounds: 0, and with no strong model at all', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: failN(2) }])
  await runWave(fn, makePlan([unit('a')]), makeState(), { codexStrongAfterRounds: 0 })
  assert.deepEqual(laneOf(calls, 'codex-fix:a#1'), { model: 'gpt-5.6-luna', effort: 'high', cold: false }, '0 disables the rung: round 2 resumes on the execution model')

  const { fn: fn2, calls: calls2 } = makeAgent([
    { match: /^verify:a/, result: failN(2) },
    { match: /^plan-check:h/, result: { verdict: 'approve', guidance: '', notes: '' } },
    { match: /^gate:h/, result: { verdict: 'approve', directives: [], debt: [] } },
  ])
  const state = await runWave(fn2, makePlan([unit('a'), unit('h', { risk: 'high', codexModel: 'strong' })]), makeState(),
    { codexStrongModel: null })
  assert.equal(laneOf(calls2, 'codex-fix:a#1').model, 'gpt-5.6-luna', 'no strong model → the escalated round stays on the execution model')
  assert.equal(laneOf(calls2, 'codex-fix:a#1').cold, false, 'and, no model change, it still resumes')
  assert.equal(laneOf(calls2, 'codex-build:h').model, 'gpt-5.6-luna', 'an appointment with no strong model resolves to the execution model')
  assert.equal(laneOf(calls2, 'plan:h').model, 'gpt-5.6-luna', 'so does the judgment alias')
  assert.ok(!promptOf(calls2, 'plan:h').includes('DIFFERENT, less capable model'), 'same model plans and builds → no clause')
  assert.ok(!('codexStrong' in state.spend), 'nothing is tallied as strong when the rung is off')
})

test('3e a literal per-unit pin is absolute: no escalation moves it', async () => {
  const { fn, calls } = makeAgent([{ match: /^verify:a/, result: failN(2) }])
  await runWave(fn, makePlan([unit('a', { codexModel: 'gpt-5.6-terra' })]), makeState())
  assert.deepEqual(laneOf(calls, 'codex-fix:a#1'), { model: 'gpt-5.6-terra', effort: 'high', cold: false },
    'round 2 stays on the literal model at codexFixEffort and resumes')
})

// =========================================================================================
// 4. Judgment-role knob, the wave-start smoke, and determinism.
// =========================================================================================
test('4 codexJudgmentModel routes the four judgment roles; the smoke stays on the execution model; prompts are deterministic', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState(), { codexJudgmentModel: 'default' })
  for (const l of ['plan:a', 'codex-spec-review:a', 'codex-review:a'])
    assert.equal(laneOf(calls, l).model, 'gpt-5.6-luna', `${l} follows codexJudgmentModel: 'default'`)
  const { fn: fn2, calls: calls2 } = makeAgent()
  await runWave(fn2, makePlan([unit('a')]), makeState(), { codexJudgmentModel: 'gpt-6-astra' })
  assert.equal(laneOf(calls2, 'plan:a').model, 'gpt-6-astra', 'a literal judgment model passes through')
  assert.ok(promptOf(calls2, 'codex-probe:w1').includes('-m gpt-5.6-luna -c model_reasoning_effort=low'),
    'the wave-start smoke probes the execution model, as before')

  const { fn: fa, calls: ca } = makeAgent([{ match: /^verify:a/, result: failN(2) }])
  const { fn: fb, calls: cb } = makeAgent([{ match: /^verify:a/, result: failN(2) }])
  await runWave(fa, makePlan([unit('a')]), makeState())
  await runWave(fb, makePlan([unit('a')]), makeState())
  assert.deepEqual(ca.map((c) => [c.label, c.prompt]), cb.map((c) => [c.label, c.prompt]),
    'two identical drives through an escalation produce byte-identical prompts (resumeFromRunId replay)')
})

// =========================================================================================
// 5. The Fable plan-check tier knob: the lean default (['high']) sends med Opus-first; ['med','high']
//    restores the 0.14.0–0.18.0 routing; high and feasible:false are Fable regardless.
// =========================================================================================
test('5 fablePlanCheckRisk: med-risk rides Opus-first by default (lean) and Fable when the knob names it', async () => {
  const approve = { verdict: 'approve', guidance: '', notes: '' }
  const { fn, calls } = makeAgent([{ match: /^plan-check:m|^opus-plan-check:m/, result: approve }])
  await runWave(fn, makePlan([unit('m', { risk: 'med' })]), makeState())
  assert.ok(calls.some((c) => c.label === 'opus-plan-check:m' && c.model === 'opus'), 'lean default: med → Opus-first')
  assert.ok(!calls.some((c) => c.label === 'plan-check:m'), 'and Fable is not consulted on an Opus approve')

  const { fn: fn2, calls: calls2 } = makeAgent([{ match: /^plan-check:m|^opus-plan-check:m/, result: approve }])
  await runWave(fn2, makePlan([unit('m', { risk: 'med' })]), makeState(), { fablePlanCheckRisk: ['med', 'high'] })
  // 0.20.0: the FRONTIER plan-check's model is `planCheckModel[risk]` — opus for med by default
  // (calibration.test.mjs pins the map and the `adversarial` pin); the knob decides the ROUND.
  assert.ok(calls2.some((c) => c.label === 'plan-check:m' && c.model === 'opus'), "['med','high']: med → the frontier plan-check, on planCheckModel.med")
  assert.ok(!calls2.some((c) => c.label === 'opus-plan-check:m'), 'and no Opus pass')

  const { fn: fn4, calls: calls4 } = makeAgent([{ match: /^plan-check:h|^gate:h/, result: (l) => l.startsWith('gate') ? { verdict: 'approve', directives: [], debt: [] } : approve }])
  await runWave(fn4, makePlan([unit('h', { risk: 'high' })]), makeState())
  assert.ok(calls4.some((c) => c.label === 'plan-check:h' && c.model === 'fable' && c.effort === 'medium'), 'high → Fable at the lean fableEffort (medium)')

  const { fn: fn3, calls: calls3 } = makeAgent([{ match: /^plan-check:m|^opus-plan-check:m/, result: approve }])
  await runWave(fn3, makePlan([unit('m', { risk: 'med' })]), makeState(), { fablePlanCheckRisk: ['high'], planCheck: 'always-fable' })
  assert.ok(calls3.some((c) => c.label === 'plan-check:m'), "planCheck: 'always-fable' still forces Fable regardless of the tier knob")
})
