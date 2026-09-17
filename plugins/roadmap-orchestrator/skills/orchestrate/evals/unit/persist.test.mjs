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
// read-and-refuse, the cache-miss partial marker a crashed run leaves behind, and — the property
// the rest of it rests on — that the replay reproduces the live run's COMPLETION ORDER, because
// the journal is written in that order and the harness's serial merge queue is ordered by it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadScript } from '../../script-loader.mjs'
import { makeAgent, makeWorkflow, packRules, courierOk } from './fakes.mjs'

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

const persistArgv = (argv, expect = 0) => {
  try {
    const out = execFileSync('node', [PERSIST, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(expect, 0, `expected exit ${expect}, got 0:\n${out}`)
    return out
  } catch (e) {
    assert.equal(e.status, expect, `persist.mjs exited ${e.status}, expected ${expect}:\n${e.stdout}${e.stderr}`)
    return `${e.stdout}${e.stderr}`
  }
}

const persist = (runDir, script, args, expect = 0) =>
  persistArgv(['--run', runDir, '--script', script, '--args', JSON.stringify(args)], expect)

// The other entry point: no journal, no replay — the run's RETURNED value, fed straight through the
// same writers. `--args` still carries roadmapDir; `--run`/`--script` are not passed at all.
const persistReturned = (dir, returned, args, expect = 0) => {
  const file = path.join(dir, 'returned.json')
  writeFileSync(file, `${JSON.stringify(returned, null, 2)}\n`)
  return persistArgv(['--returned', file, '--args', JSON.stringify(args)], expect)
}

const dirSnapshot = (dir) => Object.fromEntries(
  readdirSync(dir).sort().map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]))

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

/* ==================== journal order is the clock ========================== */
test('a swallowed cache miss cannot publish a later speculative quarantine snapshot', () => {
  const { runDir, roadmapDir, record } = newRun()
  record('completed-call', { ok: true })
  const trusted = mkState({ wave: 1, units: { a: { status: 'running', stage: 'plan-check' } } })
  const speculative = mkState({ wave: 1, units: { a: {
    status: 'quarantined', dossierPath: '/missing/dossier.md',
  } } })
  const script = path.join(runDir, 'interrupted.mjs')
  writeFileSync(script, `export const meta = { name: 'interrupted', phases: [] }
await agent('completed-call', { label: 'completed' })
log('ROADMAP-SNAPSHOT ' + ${JSON.stringify(JSON.stringify(trusted))})
await agent('never-ran', { label: 'dossier' }).catch(() => null)
log('ROADMAP-SNAPSHOT ' + ${JSON.stringify(JSON.stringify(speculative))})
return ${JSON.stringify(speculative)}
`)
  const out = persist(runDir, script, { roadmapDir }, 2)
  assert.match(out, /^PARTIAL stoppedAt=dossier/m)
  const written = JSON.parse(read(roadmapDir, 'state.json'))
  assert.deepStrictEqual(written.units, trusted.units,
    'a caught cache miss is not a real failed agent; later snapshots must not invent its outcome')
})

// The claim "a script is a deterministic function of (args, agent results)" is true only UP TO
// COMPLETION ORDER. The harness merges units through ONE serial chain in the order their pipelines
// reach merge-ready, and each merge moves `integrationTip`, which every later prompt embeds. A
// replay that resolves lookups instantly races those pipelines however the event loop feels like
// it — which is what wf_318afa1b-e9d hit: two wave-2 merges came back reversed, the tip diverged
// from the live run's, and the next prompt missed. So the journal's order IS the clock.
//
// Here `slow` stalls on a real timer at its first step, so `fast` runs its whole pipeline and takes
// the merge queue first; the LIVE tip is therefore `slow`'s merge head, the second one applied. The
// replay has no timers at all — every lookup could resolve at once — so it reproduces that only by
// following the journal.
test('the replay reproduces the live MERGE ORDER, not the one the event loop would pick', async () => {
  const { runDir, roadmapDir, record } = newRun()
  const plan = mkPlan([unit('slow'), unit('fast')])
  const state = mkState()
  const HEAD = { slow: 'c'.repeat(40), fast: 'd'.repeat(40) }
  const { fn, calls } = makeAgent([
    ...packRules(plan, state),
    { match: /^plan:slow$/, result: async () => {
      await new Promise((r) => setTimeout(r, 50))
      return { approach: 'x', files: [], testPlan: 'x', feasible: true }
    } },
    { match: /^merge:/, result: (_p, opts) =>
      ({ merged: true, suitePass: true, head: HEAD[opts.label.slice('merge:'.length)], detail: '' }) },
  ])
  const args = { roadmapDir, launchId: 'L1', config: { gateAuditRate: 0 } }
  const live = await (await loadScript(HARNESS))({ args, agent: recording(fn, record) })

  const merges = calls.filter((c) => c.label.startsWith('merge:')).map((c) => c.label)
  assert.deepStrictEqual(merges, ['merge:fast', 'merge:slow'], 'live, the unstalled unit merged first')
  assert.equal(live.integrationTip, HEAD.slow, 'so the live tip is the SECOND merge head')

  const out = persist(runDir, HARNESS, args)
  assert.match(out, /^OK /m, 'the replay serves every call — a reordered merge would miss on the tip')
  const written = JSON.parse(read(roadmapDir, 'state.json'))
  assert.equal(written.integrationTip, HEAD.slow,
    'and lands the live tip: the merges were applied in the order the journal recorded them')
  const { degradations, escalations, ...expected } = live
  assert.deepStrictEqual(written, expected, 'the whole wave state matches, not just the tip')
})

// A RESUMED run's journal opens with the failed launch's records, whose prompts the resumed run
// never asks for (its own carry a different launchId). Those must not stall the clock: a record no
// pending lookup wants, once the run is quiescent, is stepped over.
test('stale records from a superseded launch are stepped over, and the replay still completes', async () => {
  const { runDir, roadmapDir, record } = newRun()
  const plan = mkPlan([unit('a')])
  const state = mkState()
  // The first launch's leftovers, journalled BEFORE anything this run asks for.
  record('a first-launch prompt this run never issues', { verdict: 'approve', directives: [], debt: [] })
  record('another one, with a dead agent behind it', null)
  const { fn } = makeAgent(packRules(plan, state))
  const args = { roadmapDir, launchId: 'L2', config: { gateAuditRate: 0 } }
  const live = await (await loadScript(HARNESS))({ args, agent: recording(fn, record) })

  const out = persist(runDir, HARNESS, args)
  assert.match(out, /^OK /m, 'the two unrequested records never block the cursor')
  const { degradations, escalations, ...expected } = live
  assert.deepStrictEqual(JSON.parse(read(roadmapDir, 'state.json')), expected)
})

// The other side of stepping over a record: if the replay LATER asks for one the cursor has already
// passed, its control flow diverged from the live run's. That is a miss with a marker naming the
// call, never a silent reorder — a reorder is precisely the bug the clock exists to stop.
//
// A script whose two calls are journalled in the opposite order to the one it makes them in: the
// second lookup asks for a record the cursor is already past.
const outOfOrderRun = (waveOfSnapshot = 0) => {
  const { runDir, roadmapDir, record } = newRun()
  record('P-FIRST', { ok: true })
  record('P-SECOND', { ok: true })
  const script = path.join(runDir, 'reversed.mjs')
  writeFileSync(script, "export const meta = { name: 'reversed', phases: [] }\n" +
    `log('ROADMAP-SNAPSHOT ' + ${JSON.stringify(JSON.stringify(mkState({ wave: waveOfSnapshot })))})\n` +
    "await agent('P-SECOND', { label: 'second' })\n" +
    "await agent('P-FIRST', { label: 'first' })\n")
  return { runDir, roadmapDir, script }
}

// An out-of-order miss is the REPLAY diverging, not the run failing — the live run did not stop
// there, so its own state is further along than any prefix reachable here. wf 2026-09-02 wrote such
// a prefix (a wave-1 halt) over a returned wave-3 state, and a relaunch from that file would have
// re-forked every unit from the plan-pack tip. So the partial is parked BESIDE state.json, never
// over it, even when there is no state.json at all to protect.
test('an out-of-order miss is refused: the partial is parked in state.partial.json, not state.json', async () => {
  const { runDir, roadmapDir, script } = outOfOrderRun()

  const out = persistArgv(['--run', runDir, '--script', script, '--args', JSON.stringify({ roadmapDir })], 2)
  assert.match(out, /^PARTIAL-REFUSED stoppedAt=first \(out of journal order\) why=divergence wrote=state\.partial\.json/m,
    'the line names the call, why it was refused, and what it did write instead')
  assert.match(out, /--returned/, "and points at the cure: persist the run's returned value")
  assert.equal(existsSync(path.join(roadmapDir, 'state.json')), false,
    'nothing is written to state.json — a diverged prefix is not a state')
  assert.equal(JSON.parse(read(roadmapDir, 'state.partial.json')).partial.stoppedAt, 'first (out of journal order)',
    'the parked file still carries the marker naming the call, for the investigation')
})

test('an out-of-order miss leaves a NEWER state.json byte-identical', async () => {
  const { runDir, roadmapDir, script } = outOfOrderRun()
  const live = `${JSON.stringify(mkState({ wave: 3, integrationTip: 'c1a0801d'.repeat(5) }), null, 2)}\n`
  writeFileSync(path.join(roadmapDir, 'state.json'), live)

  const out = persistArgv(['--run', runDir, '--script', script, '--args', JSON.stringify({ roadmapDir })], 2)
  assert.match(out, /^PARTIAL-REFUSED /m)
  assert.equal(read(roadmapDir, 'state.json'), live, 'the wave-3 state on disk is untouched, byte for byte')
  assert.equal(JSON.parse(read(roadmapDir, 'state.partial.json')).wave, 0, 'and the wave-0 prefix is parked beside it')
})

// The second refusal, on its own: an ORDINARY journal-exhausted miss whose snapshot is behind what
// state.json already holds. A partial marker on disk is the carve-out — that file is this same
// partial, so re-persisting a crashed run stays idempotent.
test('a partial never overwrites a state.json at a later wave, or a whole one at the same wave', async () => {
  const { runDir, roadmapDir, record } = newRun()
  const plan = mkPlan([unit('a'), unit('b')])
  const { fn } = makeAgent(packRules(plan, mkState()))
  const args = { roadmapDir, launchId: 'L1', config: { gateAuditRate: 0 } }
  await (await loadScript(HARNESS))({ args, agent: recording(fn, record) })
  const journal = path.join(runDir, 'journal.jsonl')
  writeFileSync(journal, `${readFileSync(journal, 'utf8').split('\n').filter(Boolean).slice(0, 24).join('\n')}\n`)

  assert.match(persist(runDir, HARNESS, args, 2), /^PARTIAL stoppedAt=/m, 'nothing on disk: the partial lands')
  const written = read(roadmapDir, 'state.json')
  assert.match(persist(runDir, HARNESS, args, 2), /^PARTIAL stoppedAt=/m,
    'and re-persisting the same crashed run is allowed — the file on disk IS this partial')
  assert.equal(read(roadmapDir, 'state.json'), written, 'idempotently')

  // The root repaired it by hand (or a later run persisted): same wave, no partial marker.
  const { partial: _p, ...whole } = JSON.parse(written)
  const repaired = `${JSON.stringify(whole, null, 2)}\n`
  writeFileSync(path.join(roadmapDir, 'state.json'), repaired)
  let out = persist(runDir, HARNESS, args, 2)
  assert.match(out, /^PARTIAL-REFUSED stoppedAt=.* why=newer-on-disk wrote=state\.partial\.json/m)
  assert.equal(read(roadmapDir, 'state.json'), repaired, 'a whole state at the same wave outranks a partial')

  const ahead = `${JSON.stringify({ ...whole, wave: whole.wave + 1 }, null, 2)}\n`
  writeFileSync(path.join(roadmapDir, 'state.json'), ahead)
  out = persist(runDir, HARNESS, args, 2)
  assert.match(out, /why=newer-on-disk/, 'and so does a later wave')
  assert.equal(read(roadmapDir, 'state.json'), ahead)
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
    { match: /^move-feedback:/, result: courierOk },
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

/* ================================ --returned ============================== */
// The cure for a refused partial: the root has the run's real return value in the task output, so
// it hands that over instead of a replayed prefix. No journal is read, no script is loaded — the
// value goes straight through the same writers, so it must land exactly what a full replay lands.
test('--returned writes the same files a full replay does, byte for byte', async () => {
  const { runDir, roadmapDir, args, live } = await conductorRun()
  persist(runDir, CONDUCTOR, args)

  const other = mkdtempSync(path.join(tmpdir(), 'roadmap-persist-returned-'))
  const otherRoadmap = path.join(other, '.roadmap')
  const out = persistReturned(other, live, { ...args, roadmapDir: otherRoadmap })
  assert.match(out, /^returned: .*replay skipped$/m, 'it says plainly that no replay happened')
  assert.match(out, /^OK reason=max-waves/m, 'and reports the same completion the replay does')

  const replayed = dirSnapshot(roadmapDir)
  assert.ok(Object.keys(replayed).includes('state.json') && Object.keys(replayed).includes('plan.json'),
    'sanity: the replay wrote the documents we are comparing against')
  assert.deepStrictEqual(dirSnapshot(otherRoadmap), replayed,
    'every document, same names and same bytes — --returned is the same writers, not a second path')
})

test('--returned needs neither --run nor --script, but still needs roadmapDir', async () => {
  const { args, live } = await conductorRun()
  const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-persist-returned-'))
  const { roadmapDir: _drop, ...noDir } = args
  const out = persistReturned(dir, live, noDir, 1)
  assert.match(out, /roadmapDir/, 'the refusal names what is missing')
  assert.match(persistArgv(['--args', JSON.stringify(args)], 1), /usage:/,
    'and without --returned, --run and --script are still required')
})

// The plan read-and-refuse is a writer, not a replay step, so it must fire on this path too — the
// out-of-order case this flag exists for is exactly when a root edit is most likely to be sitting
// in plan.json.
test('--returned still refuses to overwrite a plan.json holding unit ids the run never saw', async () => {
  const { roadmapDir, args, live } = await conductorRun({ onDisk: mkPlan([unit('a'), unit('root-added-unit')]) })
  const before = read(roadmapDir, 'plan.json')
  const out = persistReturned(path.dirname(roadmapDir), live, args)
  assert.match(out, /PLAN-CONFLICT unknownUnits=root-added-unit/, 'the refusal is as loud as on the replay path')
  assert.equal(read(roadmapDir, 'plan.json'), before, 'and the file is left exactly as it was')
  assert.match(read(roadmapDir, 'degradations.jsonl'), /"kind":"plan-conflict"/, 'ledgered too')
})

// A replay that THROWS is not the same as one that runs out of journal, and it used to be fatal: a
// crashed run's journal replays straight back into the crash, and an uncaught exception here lost
// everything the run did decide (wf_c6971376-1a5 — the harness's cyclic-plan throw). The last
// snapshot is the honest answer either way, so the throw takes the partial path too.
test('a replay whose script throws mid-run writes the last snapshot, marked partial with the error', async () => {
  const { runDir, roadmapDir, record } = newRun()
  const plan = mkPlan([unit('a')])
  const state = mkState()
  const { fn } = makeAgent(packRules(plan, state))
  const args = { roadmapDir, launchId: 'L1', config: { gateAuditRate: 0 } }
  await (await loadScript(HARNESS))({ args, agent: recording(fn, record) })

  // Replay the SAME journal through a script that snapshots and then fails the way a real script
  // does — loudly, on a condition that should not happen. The launch-pack calls are served from the
  // journal, so the throw lands well after the first snapshot.
  const failing = path.join(runDir, 'throws.mjs')
  writeFileSync(failing, "export const meta = { name: 'throws', phases: [] }\n" +
    `log('ROADMAP-SNAPSHOT ' + ${JSON.stringify(JSON.stringify({ ...state, wave: 1, units: { a: { status: 'merged' } } }))})\n` +
    "throw new Error('plan dependency graph contains a cycle — fix the plan before dispatch: a -> b, b -> a')\n")

  const out = persist(runDir, failing, args, 2)
  assert.match(out, /^PARTIAL stoppedAt=script-error/m, 'the throw is reported as a partial, not a crash')
  assert.match(out, /contains a cycle/, 'and the console names what actually went wrong')
  const partial = JSON.parse(read(roadmapDir, 'state.json'))
  assert.equal(partial.partial.stoppedAt, 'script-error')
  assert.match(partial.partial.error, /contains a cycle/, 'the marker carries the message, not just the fact')
  assert.deepStrictEqual(partial.units, { a: { status: 'merged' } }, 'and the snapshot is real state')
})

test('a script that throws BEFORE its first snapshot leaves state.json untouched and exits 1', async () => {
  const { runDir, roadmapDir, record } = newRun()
  const plan = mkPlan([unit('a')])
  const state = mkState()
  const { fn } = makeAgent(packRules(plan, state))
  const args = { roadmapDir, launchId: 'L1', config: { gateAuditRate: 0 } }
  await (await loadScript(HARNESS))({ args, agent: recording(fn, record) })
  writeFileSync(path.join(roadmapDir, 'state.json'), '{"keep":"me"}\n')

  const failing = path.join(runDir, 'throws-early.mjs')
  writeFileSync(failing, "export const meta = { name: 'early', phases: [] }\nthrow new Error('boom before any snapshot')\n")

  const out = persist(runDir, failing, args, 1)
  assert.match(out, /boom before any snapshot/, 'the refusal names the error')
  assert.equal(read(roadmapDir, 'state.json'), '{"keep":"me"}\n', 'a partial with nothing in it overwrites nothing')
})

/* ==================== the parked partial is cleaned up on success ==================== */
// A refusal parks its prefix in `state.partial.json` and prints the cure. Once that cure runs and a
// WHOLE state lands, the parked file is stale — evidence of a divergence already resolved — and
// leaving it beside a current `state.json` is how a later reader (or a root working the recovery
// ladder) relaunches from the wrong file. So a successful persist removes it, and says it did.
test('the --returned cure clears the state.partial.json the refusal parked, and names it', async () => {
  const { runDir, roadmapDir, script } = outOfOrderRun()
  const args = { roadmapDir }
  assert.match(persistArgv(['--run', runDir, '--script', script, '--args', JSON.stringify(args)], 2),
    /^PARTIAL-REFUSED /m, 'setup: the refusal parks the prefix')
  assert.ok(existsSync(path.join(roadmapDir, 'state.partial.json')))

  const out = persistReturned(path.dirname(roadmapDir), mkState({ wave: 3 }), args)
  assert.match(out, /^OK .*removed=state\.partial\.json$/m, 'the OK line says the stale park is gone')
  assert.equal(existsSync(path.join(roadmapDir, 'state.partial.json')), false, 'and it really is gone')
  assert.equal(JSON.parse(read(roadmapDir, 'state.json')).wave, 3, 'the whole state is what stands')
})

test('a completed REPLAY clears it too, and a run with none to clear says nothing about it', async () => {
  const { runDir, roadmapDir, args } = await conductorRun()
  writeFileSync(path.join(roadmapDir, 'state.partial.json'), '{"wave":0,"partial":{"stoppedAt":"stale"}}\n')

  const out = persist(runDir, CONDUCTOR, args)
  assert.match(out, /^OK reason=max-waves .*removed=state\.partial\.json$/m)
  assert.equal(existsSync(path.join(roadmapDir, 'state.partial.json')), false)

  const again = persist(runDir, CONDUCTOR, args)
  assert.match(again, /^OK reason=max-waves /m, 'and re-persisting stays idempotent')
  assert.doesNotMatch(again, /removed=/, 'with no removal to report the second time')
})
