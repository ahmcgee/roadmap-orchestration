import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, implement, reports, git, json, read, context, readFile, writeFile, mkdir, rm, path } from './helpers.mjs'
import { run } from '../scripts/roadmap.mjs'
import { validate, checkpoint, exclusive } from '../scripts/protocol.mjs'

test('Astra high-risk lane, independent approval, tested merge and dependency release', async t => {
  const f = await fixture(t, { edges: [{ from: 'a', to: 'b', type: 'semantic', mode: 'contract' }] })
  await f.call('wave')
  assert.deepEqual(await f.call('eligible'), ['a'])
  assert.equal((await f.call('setup', { unit: 'a' })).implementer, 'astra-direct')
  await implement(f)
  await f.call('approve', await reports(f))
  assert.equal((await f.call('merge', { unit: 'a' })).merged, true)
  assert.equal((await f.readState()).units.a.status, 'merged')
  assert.deepEqual(await f.call('eligible'), ['b'])
  assert.equal(git(f.repo, 'rev-parse', 'main'), f.initial)
  assert.equal(git(f.repo, 'symbolic-ref', '--short', 'HEAD'), 'main')
  assert.equal((await f.call('inspect'))[0].landed, true)
})

test('independent review and real lane evidence are required', async t => {
  const f = await fixture(t)
  await f.call('wave'); await f.call('setup', { unit: 'a' }); const sha = await implement(f)
  await assert.rejects(f.call('approve', await reports(f, 'a', { review: { head: sha, actor: 'astra-lead', verdict: 'approve' } })), /independent/)
  await assert.rejects(f.call('approve', await reports(f, 'a', { verify: { head: sha, actor: 'v', verdict: 'pass', lanes: [] } })), /recorded lanes/)
  await assert.rejects(f.call('approve', await reports(f, 'a', { gate: { head: sha, actor: 'g', verdict: 'reject', acceptance: [] } })), /did not approve/)
})

test('a lying green unit report cannot bypass the actual integration suite', async t => {
  const f = await fixture(t)
  await f.call('wave'); await f.call('setup', { unit: 'a' })
  await implement(f, 'a', 'export const twice = x => x * 3\n')
  await f.call('approve', await reports(f))
  const result = await f.call('merge', { unit: 'a' })
  assert.equal(result.merged, false)
  assert.match(result.error, /suite failed/)
  assert.equal(git(f.repo, 'rev-parse', 'roadmap/fixture'), f.initial)
  assert.equal((await f.readState()).units.a.status, 'running')
  assert.equal(git(result.candidate, 'rev-parse', '--show-toplevel'), result.candidate)
})

test('changed code, spec, or integration tip invalidates approval', async t => {
  for (const change of ['code', 'spec', 'integration']) {
    const f = await fixture(t)
    await f.call('wave'); await f.call('setup', { unit: 'a' }); await implement(f)
    await f.call('approve', await reports(f))
    if (change === 'code') {
      const cwd = path.join(f.wt, 'a')
      await writeFile(path.join(cwd, 'extra.txt'), 'changed'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'later change')
    } else if (change === 'spec') await writeFile(path.join(f.dir, 'specs/a.md'), 'different acceptance')
    else {
      const cwd = path.join(f.wt, '__integration')
      await writeFile(path.join(cwd, 'extra.txt'), 'changed'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'later integration')
    }
    await assert.rejects(f.call('merge', { unit: 'a' }), /stale approval|integration checkout changed/)
  }
})

test('interrupted work is adopted, counters preserved, dirty files never reset', async t => {
  const f = await fixture(t)
  await f.call('wave'); await f.call('setup', { unit: 'a' }); const sha = await implement(f)
  await f.call('transition', { unit: 'a', stage: 'implement', round: 'fix' })
  const cwd = path.join(f.wt, 'a')
  await writeFile(path.join(cwd, 'uncommitted.txt'), 'keep me')
  assert.equal((await f.call('reconcile')).blocked, 'dirty-worktrees')
  assert.equal(await readFile(path.join(cwd, 'uncommitted.txt'), 'utf8'), 'keep me')
  await rm(path.join(cwd, 'uncommitted.txt'))
  await f.call('reconcile')
  const record = (await f.readState()).units.a
  assert.equal(record.parked, true); assert.equal(record.rounds.fix, 1)
  assert.equal((await f.call('setup', { unit: 'a' })).stage, 'polish')
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), sha)
  await f.call('transition', { unit: 'a', stage: 'implement', round: 'fix' })
  await assert.rejects(f.call('transition', { unit: 'a', stage: 'implement', round: 'fix' }), /budget exhausted/)
})

test('recovery after branch advance skips completed work; an empty branch is not merged', async t => {
  const f = await fixture(t)
  await f.call('wave'); await f.call('setup', { unit: 'a' }); await implement(f)
  const stale = await f.readState()
  await f.call('approve', await reports(f)); await f.call('merge', { unit: 'a' })
  // Simulate a crash after git advanced but before the final state checkpoint.
  await writeFile(path.join(f.dir, 'state.json'), json(stale))
  git(f.repo, 'branch', 'unit/b', 'roadmap/fixture')
  await f.call('reconcile')
  const state = await f.readState()
  assert.equal(state.units.a.status, 'merged')
  assert.notEqual(state.units.b?.status, 'merged')
  assert.deepEqual(await f.call('eligible'), ['b'])
})

test('future versions, stale checkpoints, state loss and regressed Git fail closed', async t => {
  const f = await fixture(t)
  const status = await f.call('status')
  await f.call('wave')
  await assert.rejects(f.call('checkpoint', { stateHash: status.stateHash, planHash: status.planHash, state: status.state }), /stale checkpoint/)
  await writeFile(path.join(f.dir, 'protocol.json'), json({ version: 99 }))
  await assert.rejects(f.call('status'), /unsupported roadmap protocol/)
  await writeFile(path.join(f.dir, 'protocol.json'), json({ version: 1 }))
  await f.call('setup', { unit: 'a' }); await implement(f)
  await f.call('approve', await reports(f)); await f.call('merge', { unit: 'a' })
  git(f.repo, 'update-ref', 'refs/heads/roadmap/fixture', f.initial)
  await assert.rejects(f.call('reconcile'), /regressed or diverged/)
})

test('interrupted multi-file checkpoint redoes every artifact before reads', async t => {
  const f = await fixture(t)
  const ctx = await context(f.dir)
  const plan = { ...f.plan, cutLine: 'updated' }
  const state = { ...await f.readState(), wave: 1 }
  await writeFile(path.join(ctx.runtime, 'checkpoint.json'), json({ version: 1, files: {
    'plan.json': json(plan), 'state.json': json(state), 'debt.md': 'durable debt\n',
  } }))
  await writeFile(path.join(f.dir, 'plan.json'), json(plan)) // only first replacement landed
  await assert.rejects(f.call('status'), /unfinished checkpoint/)
  assert.equal((await f.call('recover')).recovered, true)
  assert.equal((await f.call('status')).state.wave, 1)
  assert.equal(await readFile(path.join(f.dir, 'debt.md'), 'utf8'), 'durable debt\n')
  assert.equal((await f.call('recover')).recovered, false)
})

test('checkpoint rejects traversal and symlink destinations', async t => {
  const f = await fixture(t), ctx = await context(f.dir)
  const { symlink } = await import('node:fs/promises')
  await assert.rejects(exclusive(ctx, () => checkpoint(ctx, { '../outside': 'bad' })), /invalid checkpoint path/)
  await symlink(f.root, path.join(f.dir, 'escape'))
  await assert.rejects(exclusive(ctx, () => checkpoint(ctx, { 'escape/outside': 'bad' })), /symlink/)
})

test('DAG cycles, missing ancestors and malformed identifiers are rejected', async t => {
  const f = await fixture(t)
  assert.throws(() => validate({ ...f.plan, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }, f.state), /cycle/)
  assert.throws(() => validate({ ...f.plan, units: [{ id: 'a', inScope: false }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] }, f.state), /ancestors/)
  assert.throws(() => validate({ ...f.plan, units: [{ id: '../escape' }] }, f.state), /unit id/)
})

test('two drivers and simultaneous helper operations cannot write the same arc', async t => {
  const f = await fixture(t), ctx = await context(f.dir)
  await assert.rejects(f.call('acquire', { driver: 'claude' }), /driver active/)
  await assert.rejects(f.call('acquire', { driver: 'claude', previousToken: f.getToken() }), /driver active/)
  await exclusive(ctx, async () => {
    await assert.rejects(f.call('wave'), /another roadmap operation/)
  })
  const prior = f.getToken()
  const owner = await f.call('acquire', { driver: 'codex', previousToken: prior, stopped: true })
  await assert.rejects(f.call('wave'), /ownership mismatch/)
  f.setToken(owner.token); await f.call('wave')
})

test('an interrupted initial arc can be inspected and reconciled before its branch exists', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('inspect'))[0].landed, false)
  await f.call('reconcile')
  assert.equal(git(f.repo, 'rev-parse', 'roadmap/fixture'), f.initial)
})

test('a contingent dependency waits for the boundary and next wave', async t => {
  const f = await fixture(t, { edges: [{ from: 'a', to: 'b', mode: 'contingent', type: 'semantic' }] })
  await f.call('wave'); await f.call('setup', { unit: 'a' }); await implement(f)
  await f.call('approve', await reports(f)); await f.call('merge', { unit: 'a' })
  assert.deepEqual(await f.call('eligible'), [])
  await assert.rejects(f.call('wave'), /triage the preceding boundary/)
  const current = await f.call('status')
  current.state.boundary = { triaged: true, wave: 1 }
  await f.call('checkpoint', { stateHash: current.stateHash, planHash: current.planHash, state: current.state,
    files: { 'architect-log.md': '## Wave 1\nContingent follow-up spec confirmed.\n' } })
  await f.call('wave')
  assert.deepEqual(await f.call('eligible'), ['b'])
})

test('a boundary checkpoint cannot declare an unreviewed unit merged', async t => {
  const f = await fixture(t), current = await f.call('status')
  current.state.units.a = { status: 'merged', mergedAt: f.initial }
  await assert.rejects(f.call('checkpoint', { stateHash: current.stateHash, planHash: current.planHash, state: current.state }), /lifecycle commands/)
})

test('all frozen contracts participate in approval even without a DAG edge', async t => {
  const f = await fixture(t)
  await mkdir(path.join(f.dir, 'contracts'))
  await writeFile(path.join(f.dir, 'contracts/security.md'), 'Frozen policy v1')
  await f.call('wave'); await f.call('setup', { unit: 'a' }); await implement(f)
  await f.call('approve', await reports(f))
  await writeFile(path.join(f.dir, 'contracts/security.md'), 'Amended policy v2')
  await assert.rejects(f.call('merge', { unit: 'a' }), /stale approval/)
})

test('numbered migration collisions fail before integration advances', async t => {
  const f = await fixture(t)
  await mkdir(path.join(f.repo, 'migrations'))
  await writeFile(path.join(f.repo, 'migrations/001_base.sql'), '-- base')
  git(f.repo, 'add', 'migrations'); git(f.repo, 'commit', '-m', 'base migration')
  const state = await f.readState(); state.integrationTip = git(f.repo, 'rev-parse', 'HEAD')
  await writeFile(path.join(f.dir, 'state.json'), json(state))
  const plan = { ...f.plan, prefixUniqueGlobs: ['migrations/*'] }
  await writeFile(path.join(f.dir, 'plan.json'), json(plan))
  await f.call('wave'); await f.call('setup', { unit: 'a' }); await implement(f)
  const cwd = path.join(f.wt, 'a')
  await writeFile(path.join(cwd, 'migrations/001_other.sql'), '-- duplicate')
  git(cwd, 'add', 'migrations'); git(cwd, 'commit', '-m', 'collision')
  await f.call('approve', await reports(f))
  const result = await f.call('merge', { unit: 'a' })
  assert.equal(result.merged, false); assert.match(result.error, /duplicate numeric prefix/)
  assert.equal(git(f.repo, 'rev-parse', 'roadmap/fixture'), state.integrationTip)
})

test('two blocked verification lanes halt dispatch without falsely quarantining work', async t => {
  const f = await fixture(t)
  await f.call('wave')
  for (const unit of ['a', 'b']) {
    await f.call('setup', { unit })
    await f.call('transition', { unit, stage: 'blocked', reason: 'registry unavailable' })
  }
  const state = await f.readState()
  assert.equal(state.halt.reason, 'env-verify-blocked')
  assert.equal(state.units.a.status, 'blocked'); assert.equal(state.units.b.status, 'blocked')
  assert.deepEqual(await f.call('eligible'), [])
})

test('an adoption source does not authorize overwriting another existing unit branch', async t => {
  const f = await fixture(t)
  const tree = git(f.repo, 'rev-parse', `${f.initial}^{tree}`)
  const source = git(f.repo, 'commit-tree', tree, '-p', f.initial, '-m', 'adoption source')
  const other = git(f.repo, 'commit-tree', tree, '-p', f.initial, '-m', 'unexplained prior work')
  git(f.repo, 'branch', 'adopt/a', source); git(f.repo, 'branch', 'unit/a', other)
  const plan = structuredClone(f.plan); plan.units[0].existingBranch = 'adopt/a'
  await writeFile(path.join(f.dir, 'plan.json'), json(plan))
  await f.call('wave')
  await assert.rejects(f.call('setup', { unit: 'a' }), /unexplained branch commits/)
  assert.equal(git(f.repo, 'rev-parse', 'unit/a'), other)
})

test('a test command cannot change the candidate commit and still advance integration', async t => {
  const f = await fixture(t, { config: { codexNative: {
    integrationTestCommand: 'git commit --allow-empty -m generated && node test.mjs',
  } } })
  await f.call('wave'); await f.call('setup', { unit: 'a' }); await implement(f)
  await f.call('approve', await reports(f))
  const result = await f.call('merge', { unit: 'a' })
  assert.equal(result.merged, false); assert.match(result.error, /changed candidate/)
  assert.equal(git(f.repo, 'rev-parse', 'roadmap/fixture'), f.initial)
})

test('quoted Git filenames cannot hide unit edits to roadmap control files', async t => {
  const f = await fixture(t)
  await f.call('wave'); await f.call('setup', { unit: 'a' }); await implement(f)
  const cwd = path.join(f.wt, 'a')
  await mkdir(path.join(cwd, '.roadmap'))
  await writeFile(path.join(cwd, '.roadmap/évidence.md'), 'unauthorized control change')
  git(cwd, 'add', '.roadmap'); git(cwd, 'commit', '-m', 'control edit')
  await assert.rejects(f.call('approve', await reports(f)), /roadmap control files/)
})

test('legacy custom integration branch names survive handoff; primary/default branches are refused', async t => {
  const f = await fixture(t)
  const state = await f.readState(); state.integrationBranch = 'delivery/custom-arc'
  await writeFile(path.join(f.dir, 'state.json'), json(state))
  await f.call('reconcile')
  assert.equal(git(f.repo, 'rev-parse', 'delivery/custom-arc'), f.initial)
  assert.throws(() => validate(f.plan, { ...state, integrationBranch: 'main' }), /primary checkout or default branch/)
})
