import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, implement, reports, legacyPersist, json, readFile, writeFile, path, rm } from './helpers.mjs'

test('Claude → Codex → Claude preserves extensions, obligations and budgets', async t => {
  const f = await fixture(t)
  await f.call('wave'); await f.call('setup', { unit: 'a' }); await implement(f)
  await f.call('transition', { unit: 'a', stage: 'polish', round: 'fix' })
  const initial = await f.readState()
  initial.extension = { future: 'keep' }; initial.units.a.extra = { future: true }
  initial.owed = [{ job: 'health', wave: 1, count: 1, why: 'interrupted' }]
  initial.spend = { opus: 4, codexRuns: 2 }; initial.escalationStops = { a: 1 }
  initial.debt = [{ unit: 'a', detail: 'unbanked' }]
  await writeFile(path.join(f.dir, 'state.json'), json(initial))
  let owner = await f.call('acquire', { driver: 'claude', previousToken: f.getToken(), stopped: true })
  const returned = structuredClone(initial)
  delete returned.extension; delete returned.units.a.extra // simulate selective legacy serializer
  await legacyPersist(f, owner.token, returned)
  assert.deepEqual((await f.readState()).extension, initial.extension)
  assert.deepEqual((await f.readState()).units.a.extra, initial.units.a.extra)
  owner = await f.call('acquire', { driver: 'codex', previousToken: owner.token, stopped: true })
  f.setToken(owner.token)
  await f.call('reconcile'); await f.call('setup', { unit: 'a' })
  await f.call('approve', await reports(f)); await f.call('merge', { unit: 'a' })
  const resumed = await f.readState()
  assert.equal(resumed.units.a.rounds.fix, 1)
  assert.deepEqual(resumed.owed, initial.owed); assert.deepEqual(resumed.debt, initial.debt)
  assert.deepEqual(resumed.spend, initial.spend); assert.deepEqual(resumed.escalationStops, initial.escalationStops)
  owner = await f.call('acquire', { driver: 'claude', previousToken: owner.token, stopped: true })
  await legacyPersist(f, owner.token, resumed)
  assert.deepEqual(await f.readState(), resumed)
})

test('a revoked Claude return cannot overwrite new Codex progress', async t => {
  const f = await fixture(t)
  const old = await f.call('acquire', { driver: 'claude', previousToken: f.getToken(), stopped: true })
  const stale = await f.readState()
  const current = await f.call('acquire', { driver: 'codex', previousToken: old.token, stopped: true })
  f.setToken(current.token); await f.call('wave')
  const bytes = await readFile(path.join(f.dir, 'state.json'), 'utf8')
  await assert.rejects(legacyPersist(f, old.token, stale), /ownership mismatch/)
  assert.equal(await readFile(path.join(f.dir, 'state.json'), 'utf8'), bytes)
})

test('legacy unversioned arc can be upgraded without changing plan or state', async t => {
  const f = await fixture(t)
  await f.call('release', { stopped: true })
  await rm(path.join(f.dir, 'protocol.json'))
  const state = await readFile(path.join(f.dir, 'state.json'), 'utf8')
  const plan = await readFile(path.join(f.dir, 'plan.json'), 'utf8')
  const owner = await f.call('acquire', { driver: 'codex' })
  f.setToken(owner.token)
  assert.equal(await readFile(path.join(f.dir, 'state.json'), 'utf8'), state)
  assert.equal(await readFile(path.join(f.dir, 'plan.json'), 'utf8'), plan)
})

test('legacy persistence refuses future versions and decreasing retry budgets', async t => {
  const f = await fixture(t)
  await f.call('wave'); await f.call('setup', { unit: 'a' })
  await f.call('transition', { unit: 'a', stage: 'implement', round: 'fix' })
  const owner = await f.call('acquire', { driver: 'claude', previousToken: f.getToken(), stopped: true })
  const state = await f.readState(); state.units.a.rounds.fix = 0
  await assert.rejects(legacyPersist(f, owner.token, state), /resets a round budget/)
  await writeFile(path.join(f.dir, 'protocol.json'), json({ version: 777 }))
  await assert.rejects(legacyPersist(f, owner.token, await f.readState()), /unsupported roadmap protocol/)
})

test('versioned Claude-only arcs keep legacy per-wave counters while retaining verification blocks', async t => {
  const f = await fixture(t)
  const plan = { ...f.plan, config: {} }
  await writeFile(path.join(f.dir, 'plan.json'), json(plan))
  const old = await f.readState()
  old.wave = 1; old.units.a = { status: 'pending', parked: true, rounds: { fix: 2, opusGate: 2, verifyBlocked: 1 } }
  await writeFile(path.join(f.dir, 'state.json'), json(old))
  const owner = await f.call('acquire', { driver: 'claude', previousToken: f.getToken(), stopped: true })
  const next = structuredClone(old); next.wave = 2; next.units.a.rounds = { fix: 0, opusGate: 1, verifyBlocked: 1 }
  await legacyPersist(f, owner.token, next, plan)
  assert.deepEqual((await f.readState()).units.a.rounds, next.units.a.rounds)
})
