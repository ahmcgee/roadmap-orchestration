// persist.mjs — end-to-end, against a journal this suite WRITES from a real sim run.
//
// The point of persist.mjs is that a workflow script is a deterministic function of (args, agent
// results), so a finished run can be replayed in a real Node process and its return value written
// to `.roadmap/` at zero model cost. That claim is only worth anything if the replay actually
// reproduces the run — so these tests drive a script with the scripted fakes, record every
// (prompt, result) pair in the platform's own journal shape, and then run the real CLI over it.
// The fakes' results ARE the journal.
//
// Covered: the harness path (state.json + the event ledgers), the conductor path (plan.json,
// debt.md, architect-log.md, skill-degradations.md and both ledgers), the plan.json
// read-and-refuse, and the cache-miss partial marker a crashed run leaves behind.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadScript } from '../../script-loader.mjs'
import { makeAgent, makeWorkflow, packRules } from './fakes.mjs'

const SKILL = fileURLToPath(new URL('../../', import.meta.url))
const HARNESS = path.join(SKILL, 'harness.mjs')
const CONDUCTOR = path.join(SKILL, 'conductor.mjs')
const PERSIST = path.join(SKILL, 'persist.mjs')

/* ------------------------------- fixtures -------------------------------- */
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const mkPlan = (units = [unit('a')], extra = {}) => ({
  repoPath: '/repo', worktreeRoot: '/wt', units, edges: [], config: {}, ...extra,
})
const mkState = (extra = {}) => ({
  integrationBranch: 'roadmap/x', integrationTip: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  consultsUsed: 0, spend: {}, preview: { sha: null, status: 'none' }, debt: [], wave: 0, units: {}, ...extra,
})

/* --------------------- recording a run into a journal --------------------- */
// The platform's own shape: journal.jsonl carries a `started`/`result` pair per call keyed by an
// opaque hash, and each agent's transcript opens with the prompt verbatim as its first `user`
// record. persist.mjs recovers the prompt from the transcript, so that is what has to be faithful.
function newRun() {
  const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-persist-'))
  const runDir = path.join(dir, 'run')
  const roadmapDir = path.join(dir, '.roadmap')
  mkdirSync(runDir)
  mkdirSync(roadmapDir)
  let n = 0
  const record = (prompt, result) => {
    const agentId = `a${String(n++).padStart(16, '0')}`
    const key = `v2:${agentId}`
    appendFileSync(path.join(runDir, 'journal.jsonl'),
      `${JSON.stringify({ type: 'started', key, agentId })}\n${JSON.stringify({ type: 'result', key, agentId, result })}\n`)
    writeFileSync(path.join(runDir, `agent-${agentId}.jsonl`),
      `${JSON.stringify({ agentId, type: 'user', message: { role: 'user', content: prompt } })}\n`)
    writeFileSync(path.join(runDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1, model: 'haiku' }))
  }
  return { dir, runDir, roadmapDir, record }
}

// Wrap a scripted agent so every call it serves is journalled exactly as the platform would —
// including a call that dies, which the platform records as a `started` with no `result` and which
// agent() surfaces as `null`.
const recording = (fn, record) => async (prompt, opts) => {
  let result
  try { result = await fn(prompt, opts) } catch (e) { record(prompt, null); throw e }
  record(prompt, result)
  return result
}

const persist = (runDir, script, args, expect = 0) => {
  try {
    const out = execFileSync('node', [PERSIST, '--run', runDir, '--script', script, '--args', JSON.stringify(args)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(expect, 0, `expected exit ${expect}, got 0:\n${out}`)
    return out
  } catch (e) {
    assert.equal(e.status, expect, `persist.mjs exited ${e.status}, expected ${expect}:\n${e.stdout}${e.stderr}`)
    return `${e.stdout}${e.stderr}`
  }
}

const read = (roadmapDir, name) => readFileSync(path.join(roadmapDir, name), 'utf8')

/* ================================ harness ================================= */
test('a harness run replays from its own journal and lands state.json + the event ledgers', async () => {
  const { runDir, roadmapDir, record } = newRun()
  const plan = mkPlan([unit('a', { risk: 'high' })])
  const state = mkState()
  const { fn } = makeAgent([
    ...packRules(plan, state),
    // A plan-check redirect IS an adjudication, so it leaves a ruling in the escalation ledger.
    { match: /^plan-check:a$/, result: () => ({ verdict: 'redirect', guidance: 'g', notes: '' }) },
  ])
  const args = { roadmapDir, launchId: 'L1', config: { gateAuditRate: 0 } }
  const live = await (await loadScript(HARNESS))({ args, agent: recording(fn, record) })

  const out = persist(runDir, HARNESS, args)
  assert.match(out, /^OK /m, 'a complete replay reports OK')

  const written = JSON.parse(read(roadmapDir, 'state.json'))
  const { degradations, escalations, ...expected } = live
  assert.deepStrictEqual(written, expected,
    'the replay reproduces the live run exactly, and the event ledgers stay out of state.json')

  const rows = read(roadmapDir, 'escalations.jsonl').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepStrictEqual(rows, escalations, 'the rulings are appended, one JSON line each')
  assert.equal(existsSync(path.join(roadmapDir, 'plan.json')), false,
    'a directly-launched harness owns no plan — only the conductor returns one')
})

test('a replay that runs out of journal writes the last snapshot, marked partial', async () => {
  const { runDir, roadmapDir, record } = newRun()
  const plan = mkPlan([unit('a'), unit('b')])
  const state = mkState()
  const { fn } = makeAgent(packRules(plan, state))
  const args = { roadmapDir, launchId: 'L1', config: { gateAuditRate: 0 } }
  await (await loadScript(HARNESS))({ args, agent: recording(fn, record) })

  // Truncate the journal mid-run, exactly as a crash would leave it.
  const journal = path.join(runDir, 'journal.jsonl')
  const lines = readFileSync(journal, 'utf8').split('\n').filter(Boolean)
  writeFileSync(journal, `${lines.slice(0, 24).join('\n')}\n`)

  const out = persist(runDir, HARNESS, args, 2)
  assert.match(out, /^PARTIAL stoppedAt=/m, 'the replay stops and says which call it could not serve')
  const partial = JSON.parse(read(roadmapDir, 'state.json'))
  assert.ok(partial.partial?.stoppedAt, 'the marker names the call, so the root knows to relaunch and re-run this')
  assert.ok(partial.units, 'and the snapshot is real state, not a stub')
})

/* =============================== conductor ================================ */
// The conductor's replay is the interesting one: a nested `workflow()` child SHARES the parent's
// journal, so one run directory covers the conductor AND every wave inside it. The wave here is a
// STUB workflow script — a real script the loader runs, returning a canned wave state and calling
// no agent — so the live run and the replay dispatch identically and the whole envelope is graded.
const stubWave = (dir, waveState) => {
  const p = path.join(dir, 'wave-stub.mjs')
  writeFileSync(p, `export const meta = { name: 'stub', phases: [] }\nreturn ${JSON.stringify(waveState)}\n`)
  return p
}

async function conductorRun({ onDisk } = {}) {
  const { dir, runDir, roadmapDir, record } = newRun()
  const plan = mkPlan([unit('a'), unit('ic')], { units: [unit('a'), unit('ic', { risk: 'high' })] })
  const state = mkState({ units: { a: { status: 'merged' } } })
  const { fn } = makeAgent([
    ...packRules(plan, state),
    { match: /^census:/, result: { ok: true, pendingUserFeedback: [], quarantineDossiers: ['ic.md'] } },
    // Tier 3 (a quarantine is present): a journal and a debt ledger, then the arc closes.
    // A tier-3 boundary that CONTINUES (a respec) is the one that stages: `maxWavesPerRun: 1` then
    // ends the run at max-waves, so one run exercises the whole staging path exactly once.
    { match: /^boundary:/, result: {
      newUnits: [{ id: 'ic-v2', title: 'respec', risk: 'low', goal: 'g', acceptance: ['a'], supersedes: 'ic' }],
      reviseSpecs: [], cutUnits: [], debtLedger: ['LEDGER-ITEM'],
      journal: 'JOURNAL-TEXT', escalate: false, arcComplete: false, notes: '' } },
    { match: /^move-feedback:/, result: { ok: true } },
  ])
  const waveState = {
    ...mkState({ wave: 1, units: { a: { status: 'merged' }, ic: { status: 'quarantined' } } }),
    debt: [{ unit: 'a', kind: 'structure', severity: 'minor', what: 'DEBT-ONE', why: 'w' }],
    boundary: { explorer: null, health: { findings: [], fixUnits: [] }, flake: null },
    degradations: [{ script: 'harness', wave: 1, label: 'gate:a', model: 'opus', kind: 'threw', what: 'boom' }],
    escalations: [{ script: 'harness', wave: 1, unit: 'a', stop: 1, tier: 'decided', boundary: 'none', by: 'opus' }],
  }
  const args = { roadmapDir, launchId: 'L1', config: { conductor: { maxWavesPerRun: 1 } }, harnessPath: stubWave(dir, waveState) }
  const live = await (await loadScript(CONDUCTOR))({
    args,
    agent: recording(fn, record),
    workflow: async (ref, childArgs) => (await loadScript(ref.scriptPath))({ args: childArgs }),
  })
  if (onDisk) writeFileSync(path.join(roadmapDir, 'plan.json'), `${JSON.stringify(onDisk, null, 2)}\n`)
  return { runDir, roadmapDir, args, live }
}

test('a conductor run lands every document it stopped writing', async () => {
  const { runDir, roadmapDir, args, live } = await conductorRun()
  assert.equal(live.reason, 'max-waves', 'one wave, staged, then the run hands back for a relaunch')
  const out = persist(runDir, CONDUCTOR, args)
  assert.match(out, /^OK reason=max-waves/m)

  assert.deepStrictEqual(JSON.parse(read(roadmapDir, 'state.json')), live.state, 'the final state')
  assert.deepStrictEqual(JSON.parse(read(roadmapDir, 'plan.json')), live.plan, 'the merged plan')
  assert.equal(existsSync(path.join(roadmapDir, 'debt.json')), false,
    'a banked wave leaves no raw ledger behind — debt.json exists for the returns that skip the bank')

  assert.match(read(roadmapDir, 'debt.md'), /<!-- wave 1 -->/, 'the living debt ledger gets its wave section')
  assert.ok(read(roadmapDir, 'debt.md').includes('DEBT-ONE') && read(roadmapDir, 'debt.md').includes('LEDGER-ITEM'))
  assert.match(read(roadmapDir, 'architect-log.md'), /^## Wave 1$/m, 'the tier-3 journal gets its header')
  assert.ok(read(roadmapDir, 'architect-log.md').includes('JOURNAL-TEXT'))

  const sd = read(roadmapDir, 'skill-degradations.md')
  assert.ok(sd.includes('| threw | 1 |'), 'the machine summary counts KINDS, never rows')
  assert.ok(!sd.includes('boom'), 'and carries no row text — the rows are in the sidecar')

  const degs = read(roadmapDir, 'degradations.jsonl').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepStrictEqual(degs, live.degradations, 'one appended line per degradation')
  const escs = read(roadmapDir, 'escalations.jsonl').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepStrictEqual(escs, live.escalations, 'and per escalation ruling')
})

test('re-running the persister over the same run is idempotent for the living documents', async () => {
  const { runDir, roadmapDir, args } = await conductorRun()
  persist(runDir, CONDUCTOR, args)
  const debt = read(roadmapDir, 'debt.md')
  const log = read(roadmapDir, 'architect-log.md')
  const degs = read(roadmapDir, 'degradations.jsonl')
  const escs = read(roadmapDir, 'escalations.jsonl')
  persist(runDir, CONDUCTOR, args)
  assert.equal(read(roadmapDir, 'debt.md'), debt, 'the wave section is replaced, never duplicated')
  assert.equal(read(roadmapDir, 'architect-log.md'), log, 'and so is the journal section')
  assert.equal(read(roadmapDir, 'degradations.jsonl'), degs, 'and the append-only ledger is not doubled')
  assert.equal(read(roadmapDir, 'escalations.jsonl'), escs)
})

// A `.roadmap/plan.json` carrying unit ids this run has never seen is a root edit or a hand-merged
// respec, and the wholesale overwrite would destroy it with no trace. The refusal used to cost a
// Haiku courier that could itself die; here it is one `readFileSync`.
test('persist.mjs refuses to overwrite a plan.json holding unit ids the run never saw', async () => {
  const { runDir, roadmapDir, args } = await conductorRun({ onDisk: mkPlan([unit('a'), unit('root-added-unit')]) })
  const before = read(roadmapDir, 'plan.json')
  const out = persist(runDir, CONDUCTOR, args)
  assert.equal(read(roadmapDir, 'plan.json'), before, 'the file is left exactly as it was')
  assert.match(out, /PLAN-CONFLICT unknownUnits=root-added-unit/, 'and the refusal is loud')
  const degs = read(roadmapDir, 'degradations.jsonl')
  assert.match(degs, /"kind":"plan-conflict"/, 'ledgered too, so a later reader finds it without the console')
})
