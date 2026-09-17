#!/usr/bin/env node
import { readFile, readdir, mkdir, cp, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { VERSION, json, hash, read, git, gitMaybe, atomic, context, checkVersion,
  assertOwner, exclusive, recover, checkpoint, validate, monotonic } from './protocol.mjs'

const branch = id => `unit/${id}`
const unitPath = (plan, id) => path.join(plan.worktreeRoot, id)
const clean = cwd => !git(cwd, 'status', '--porcelain')
const ancestor = (repo, a, b) => gitMaybe(repo, 'merge-base', '--is-ancestor', a, b) !== null
const head = (repo, ref = 'HEAD') => git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
const merged = (repo, ref, tip) => git(repo, 'log', '--format=%P', '--merges', tip)
  .split('\n').some(row => row.split(' ').slice(1).includes(ref))
const stateFiles = state => ({ 'state.json': json(state) })
const evidence = id => `evidence/${id}/approval.json`
const depsMet = (plan, state, id) => plan.edges.filter(e => e.to === id).every(e =>
  state.units[e.from]?.status === 'merged' && (e.mode !== 'contingent' || (state.units[e.from].mergedWave ?? state.wave) < state.wave))

async function pack(ctx) {
  if (await read(path.join(ctx.runtime, 'checkpoint.json'), null)) throw new Error('unfinished checkpoint; run recover before reading')
  await checkVersion(ctx)
  const plan = await read(path.join(ctx.dir, 'plan.json'))
  const state = await read(path.join(ctx.dir, 'state.json'))
  validate(plan, state)
  if (await realpath(plan.repoPath) !== await realpath(ctx.repo)) throw new Error('plan.repoPath is not this repository')
  return { plan, state }
}
function eligible(plan, state) {
  if (state.halt) return []
  return plan.units.filter(u => u.inScope !== false && (!u.kind || u.kind === 'code') &&
    (!state.units[u.id] || state.units[u.id].status === 'pending') && depsMet(plan, state, u.id)).map(u => u.id)
}
function inspect(plan, state) {
  let integration = gitMaybe(plan.repoPath, 'rev-parse', '--verify', `${state.integrationBranch}^{commit}`)
  if (!integration && state.wave === 0 && Object.values(state.units).every(u => ['pending', 'deferred'].includes(u.status))) integration = state.integrationTip
  if (!integration) throw new Error('integration branch missing; restore it from recorded Git history')
  if (!ancestor(plan.repoPath, state.integrationTip, integration)) throw new Error('integration tip regressed or diverged')
  return plan.units.map(u => {
    const ref = gitMaybe(plan.repoPath, 'rev-parse', '--verify', `${branch(u.id)}^{commit}`)
    const cwd = unitPath(plan, u.id)
    const present = gitMaybe(cwd, 'rev-parse', '--show-toplevel') === cwd
    return { id: u.id, head: ref, worktree: cwd, dirty: present ? git(cwd, 'status', '--porcelain') : '',
      landed: !!ref && merged(plan.repoPath, ref, integration), status: state.units[u.id]?.status ?? 'pending' }
  })
}
async function fingerprint(ctx, plan, id) {
  const unit = plan.units.find(u => u.id === id)
  const files = new Set([path.join(ctx.dir, 'specs', `${id}.md`), path.join(ctx.dir, 'brief.md'),
    ...plan.edges.filter(e => e.contract).map(e => path.resolve(ctx.dir, e.contract))])
  if (plan.conventions) files.add(path.resolve(plan.repoPath, plan.conventions))
  // A spec can cite a contract without an edge (e.g. a security contract). Bind all contracts.
  async function contracts(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) }
    catch (e) { if (e.code === 'ENOENT') return; throw e }
    for (const entry of entries) {
      const name = path.join(dir, entry.name)
      if (entry.isDirectory()) await contracts(name)
      else files.add(name)
    }
  }
  await contracts(path.join(ctx.dir, 'contracts'))
  for (const optional of ['constraints.md', 'architect-log.md']) {
    try { await readFile(path.join(ctx.dir, optional)); files.add(path.join(ctx.dir, optional)) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  const data = [json(unit), json(plan.config ?? {}), json(plan.designAuthorities ?? [])]
  for (const f of [...files].sort()) data.push(f, await readFile(f, 'utf8'))
  return hash(data.join('\n'))
}
async function shell(command, cwd, timeoutMs = 600000) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('missing command')
  return await new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let tail = '', timedOut = false
    const collect = chunk => { tail = (tail + chunk.toString()).slice(-16000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch (e) { if (e.code !== 'ESRCH') throw e } }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ command, exitCode: code, signal, timedOut, tail }) })
  })
}
async function provision(plan, cwd) {
  for (const name of plan.provision?.copy ?? []) {
    if (path.isAbsolute(name) || name.split('/').includes('..') || name === '.git' || name.startsWith('.git/')) throw new Error('invalid provision copy path')
    await cp(path.join(plan.repoPath, name), path.join(cwd, name), { recursive: true, errorOnExist: true, force: false })
  }
  if (plan.provision?.setup) {
    const result = await shell(plan.provision.setup, cwd)
    if (result.exitCode !== 0) throw new Error(`provision blocked: ${result.tail}`)
  }
}
async function worktree(plan, cwd, ref, createFrom) {
  const found = gitMaybe(cwd, 'rev-parse', '--show-toplevel')
  if (found === cwd) {
    if (git(cwd, 'symbolic-ref', '--short', 'HEAD') !== ref) throw new Error(`wrong branch in ${cwd}`)
    if (!clean(cwd)) throw new Error(`dirty worktree preserved: ${cwd}`)
    return
  }
  if (createFrom) git(plan.repoPath, 'worktree', 'add', '-b', ref, cwd, createFrom)
  else git(plan.repoPath, 'worktree', 'add', cwd, ref)
  await provision(plan, cwd)
}
async function save(ctx, plan, before, state, files = {}) {
  validate(plan, state); monotonic(before, state)
  if (!ancestor(plan.repoPath, before.integrationTip, state.integrationTip)) throw new Error('checkpoint regresses integration tip')
  await checkpoint(ctx, { ...files, ...stateFiles(state) })
}

function globRegex(glob) {
  let pattern = '^'
  for (let i = 0; i < glob.length; i++) {
    if (glob.slice(i, i + 3) === '**/') { pattern += '(?:.*/)?'; i += 2 }
    else if (glob.slice(i, i + 2) === '**') { pattern += '.*'; i++ }
    else if (glob[i] === '*') pattern += '[^/]*'
    else if (glob[i] === '?') pattern += '[^/]'
    else pattern += glob[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${pattern}$`)
}

export async function run(request) {
  const { command, roadmapDir, token } = request
  if (!roadmapDir || !path.isAbsolute(roadmapDir)) throw new Error('roadmapDir must be absolute')
  if (command === 'init') await mkdir(roadmapDir, { recursive: true })
  const ctx = await context(roadmapDir)
  if (['status', 'eligible', 'inspect'].includes(command)) {
    const { plan, state } = await pack(ctx)
    if (command === 'eligible') return eligible(plan, state)
    if (command === 'inspect') return inspect(plan, state)
    return { plan, state, stateHash: hash(json(state)), planHash: hash(json(plan)),
      owner: await read(path.join(ctx.runtime, 'owner.json'), null), runtime: ctx.runtime }
  }
  return exclusive(ctx, async () => {
    await checkVersion(ctx)
    if (command === 'init') {
      if (await read(path.join(ctx.dir, 'state.json'), null)) throw new Error('arc already exists; resume it')
      if (await read(path.join(ctx.runtime, 'owner.json'), null)) throw new Error('previous driver still owns this arc')
      validate(request.plan, request.state)
      if (await realpath(request.plan.repoPath) !== ctx.repo) throw new Error('plan.repoPath mismatch')
      const owner = { driver: 'codex', token: randomUUID(), acquired: new Date().toISOString() }
      await atomic(path.join(ctx.runtime, 'owner.json'), json(owner))
      await checkpoint(ctx, { 'protocol.json': json({ version: VERSION }), 'plan.json': json(request.plan), ...stateFiles(request.state) })
      return owner
    }
    if (command === 'acquire') {
      if (!['claude', 'codex'].includes(request.driver)) throw new Error('driver must be claude or codex')
      const prior = await read(path.join(ctx.runtime, 'owner.json'), null)
      if (prior && !(request.previousToken === prior.token && request.stopped === true)) throw new Error('driver active; stop all prior workers before explicit takeover')
      // Stop acknowledgement is deliberate; expiry/time alone cannot prove a worker stopped.
      await recover(ctx)
      await pack(ctx)
      const owner = { driver: request.driver, token: randomUUID(), acquired: new Date().toISOString() }
      await atomic(path.join(ctx.runtime, 'owner.json'), json(owner))
      await checkpoint(ctx, { 'protocol.json': json({ version: VERSION }) })
      return owner
    }
    const owner = await assertOwner(ctx, token)
    if (command === 'assert-owner') return owner
    if (command === 'recover') return { recovered: await recover(ctx) }
    if (command === 'release') {
      if (request.stopped !== true) throw new Error('release requires stopped:true after stopping all workers')
      await recover(ctx)
      await rm(path.join(ctx.runtime, 'owner.json'))
      return { released: true }
    }
    if (owner.driver !== 'codex') throw new Error('this operation belongs to the Codex driver')
    const { plan, state: before } = await pack(ctx)
    const state = structuredClone(before)
    if (command === 'checkpoint') {
      if (request.stateHash !== hash(json(before)) || request.planHash !== hash(json(plan))) throw new Error('stale checkpoint; reread status')
      const nextPlan = request.plan ?? plan, nextState = request.state ?? state
      if (nextPlan.repoPath !== plan.repoPath || nextPlan.worktreeRoot !== plan.worktreeRoot) throw new Error('checkpoint cannot relocate an arc')
      if (nextState.wave !== state.wave || nextState.integrationTip !== state.integrationTip) throw new Error('use lifecycle commands to advance wave/integration')
      for (const u of plan.units) if (!nextPlan.units.some(n => n.id === u.id)) throw new Error(`checkpoint removes unit ${u.id}; defer or supersede it instead`)
      for (const [id, result] of Object.entries(nextState.units ?? {})) {
        const previousStatus = state.units[id]?.status ?? 'pending'
        const scopeStatus = ['pending', 'deferred'].includes(previousStatus) &&
          result.status === (nextPlan.units.find(u => u.id === id)?.inScope === false ? 'deferred' : 'pending')
        if (result.status !== previousStatus && !scopeStatus) throw new Error('use lifecycle commands to change unit status')
      }
      const files = request.files ?? {}
      if (Object.keys(files).some(k => ['state.json', 'plan.json', 'protocol.json'].includes(k))) throw new Error('use structured plan/state fields')
      await save(ctx, nextPlan, before, nextState, { ...files, 'plan.json': json(nextPlan) })
      return { saved: true }
    }
    if (command === 'reconcile') {
      const rows = inspect(plan, state)
      const dirty = rows.filter(r => r.dirty)
      if (dirty.length) return { blocked: 'dirty-worktrees', units: dirty }
      if (!gitMaybe(plan.repoPath, 'rev-parse', '--verify', state.integrationBranch)) {
        // inspect only permits this for an untouched initial arc.
        git(plan.repoPath, 'branch', state.integrationBranch, state.integrationTip)
      }
      state.integrationTip = head(plan.repoPath, state.integrationBranch)
      delete state.run; delete state.partial; delete state.halt
      for (const row of rows) {
        const previous = state.units[row.id] ?? { status: 'pending' }
        if (previous.status === 'merged' && !row.landed && !ancestor(plan.repoPath, previous.mergedAt, state.integrationTip)) throw new Error(`merged unit is unreachable: ${row.id}`)
        if (row.landed) state.units[row.id] = { ...previous, status: 'merged', branch: branch(row.id),
          mergedAt: previous.mergedAt ?? state.integrationTip, mergedWave: previous.mergedWave ?? state.wave }
        else if (['running', 'merge-ready'].includes(previous.status) || (previous.status === 'blocked' && request.retryBlocked === true)) {
          state.units[row.id] = { ...previous, status: 'pending', parked: true }
          delete state.units[row.id].stage
        }
      }
      await save(ctx, plan, before, state)
      return { reconciled: true, units: rows }
    }
    if (command === 'wave') {
      if (Object.values(state.units).some(u => ['running', 'merge-ready'].includes(u.status))) throw new Error('finish or park in-flight units first')
      if (state.wave > 0 && !state.boundary?.triaged) throw new Error('triage the preceding boundary before starting a wave')
      if (state.wave >= (plan.config?.codexNative?.maxWaves ?? 20)) throw new Error('wave cap reached; hand off for a scope/budget decision')
      state.wave++
      delete state.boundary
      await save(ctx, plan, before, state)
      return { wave: state.wave }
    }
    const unit = plan.units.find(u => u.id === request.unit)
    if (!unit) throw new Error('unknown unit')
    const id = unit.id, cwd = unitPath(plan, id)
    const record = state.units[id] ?? { status: 'pending', rounds: {} }
    state.units[id] = record
    if (command === 'setup') {
      if (!plan.config?.codexNative?.integrationTestCommand) throw new Error('configure codexNative.integrationTestCommand from the brief before native dispatch')
      if (!eligible(plan, state).includes(id)) throw new Error('unit is not eligible')
      if (state.wave < 1) throw new Error('start a wave before dispatch')
      const active = Object.values(state.units).filter(u => ['running', 'merge-ready'].includes(u.status)).length
      if (active >= (plan.config?.codexNative?.maxConcurrent ?? 3)) throw new Error('unit concurrency cap reached')
      await readFile(path.join(ctx.dir, 'specs', `${id}.md`))
      const integration = path.join(plan.worktreeRoot, '__integration')
      const intExists = gitMaybe(plan.repoPath, 'rev-parse', '--verify', state.integrationBranch)
      await worktree(plan, integration, state.integrationBranch, intExists ? null : state.integrationTip)
      if (head(integration) !== state.integrationTip) throw new Error('integration moved; reconcile first')
      const existing = gitMaybe(plan.repoPath, 'rev-parse', '--verify', branch(id))
      if (existing && !record.parked && existing !== (unit.existingBranch ? head(plan.repoPath, unit.existingBranch) : state.integrationTip)) {
        throw new Error('unexplained branch commits; explicitly adopt them')
      }
      record.status = 'running'; record.stage = 'setup'; record.branch = branch(id)
      await save(ctx, plan, before, state) // Dispatch intent precedes provisioning or agent work.
      try { await worktree(plan, cwd, branch(id), existing ? null : (unit.existingBranch ? head(plan.repoPath, unit.existingBranch) : state.integrationTip)) }
      catch (e) {
        record.status = 'blocked'; record.parked = true; record.reason = String(e.message)
        await checkpoint(ctx, stateFiles(state)); throw e
      }
      record.stage = unit.existingBranch || record.parked ? 'polish' : 'plan'
      delete record.parked
      const scopePath = `evidence/${id}/scope.json`
      const oldScope = await read(path.join(ctx.dir, scopePath), null)
      const base = git(plan.repoPath, 'merge-base', state.integrationTip, head(cwd))
      const scope = oldScope ?? { base, entryHead: head(cwd), adopted: record.stage === 'polish',
        files: git(plan.repoPath, 'diff', '--name-only', '-z', base, head(cwd)).split('\0').filter(Boolean) }
      await checkpoint(ctx, { ...stateFiles(state), [scopePath]: json(scope) })
      return { worktree: cwd, branch: branch(id), head: head(cwd), stage: record.stage,
        scopePath: path.join(ctx.dir, scopePath), implementer: unit.risk === 'high' ? 'astra-direct' : 'lead-choice' }
    }
    if (command === 'transition') {
      if (record.status !== 'running') throw new Error('only a running unit can transition')
      if (!['plan', 'implement', 'polish', 'gate', 'merge-queue', 'blocked', 'quarantined', 'park'].includes(request.stage)) throw new Error('invalid stage')
      if (request.round) {
        const limits = { fix: plan.config?.maxFixRounds ?? 2, opusGate: plan.config?.maxGateRounds ?? 2, gate: plan.config?.maxGateRoundsLarge ?? 3 }
        if (!(request.round in limits)) throw new Error('unknown round budget')
        record.rounds ??= {}
        if ((record.rounds[request.round] ?? 0) >= limits[request.round]) throw new Error('round budget exhausted; closing review or quarantine required')
        record.rounds[request.round] = (record.rounds[request.round] ?? 0) + 1
      }
      if (request.stage === 'quarantined') {
        const dossier = path.join(ctx.dir, 'quarantine', `${id}.md`)
        await readFile(dossier)
        if (!request.reason) throw new Error('quarantine needs a reason')
        record.status = 'quarantined'; record.reason = request.reason; record.dossierPath = dossier
      } else if (request.stage === 'blocked' || request.stage === 'park') {
        record.status = request.stage === 'park' ? 'pending' : 'blocked'
        record.parked = true; record.reason = request.reason ?? 'interrupted'
        if (request.stage === 'park') state.halt = { reason: 'platform-outage' }
        else {
          record.rounds ??= {}
          if (record.verifyBlockedWave !== state.wave) record.rounds.verifyBlocked = (record.rounds.verifyBlocked ?? 0) + 1
          record.verifyBlockedWave = state.wave
          if (record.rounds.verifyBlocked >= 2) {
            const dossier = path.join(ctx.dir, 'quarantine', `${id}.md`)
            await readFile(dossier)
            record.status = 'quarantined'; record.dossierPath = dossier
            record.reason = `environment/tooling blocked verification: ${record.reason}`
          }
          if (Object.values(state.units).filter(u => u.verifyBlockedWave === state.wave).length >= 2) state.halt = { reason: 'env-verify-blocked' }
        }
      } else record.stage = request.stage
      if (record.status !== 'running') delete record.stage
      await save(ctx, plan, before, state, { [evidence(id)]: null })
      return record
    }
    if (command === 'approve') {
      if (record.status !== 'running' || !depsMet(plan, state, id)) throw new Error('unit is not running or dependencies are unmerged')
      if (!clean(cwd)) throw new Error('commit changes before approval')
      const sha = head(cwd)
      if (head(plan.repoPath, branch(id)) !== sha) throw new Error('unit worktree has wrong branch tip')
      const reports = {}
      for (const role of ['verify', 'review', 'gate']) {
        const reportPath = request.reports?.[role]
        if (!reportPath || path.isAbsolute(reportPath) || reportPath.split('/').includes('..')) throw new Error(`invalid ${role} report path`)
        reports[role] = await read(path.join(ctx.dir, reportPath))
        if (reports[role].head !== sha || !reports[role].actor) throw new Error(`stale or unattributed ${role} report`)
      }
      if (!request.implementer || reports.review.actor === request.implementer || reports.gate.actor === request.implementer) throw new Error('implementation needs independent review and gate')
      if (reports.verify.verdict !== 'pass' || !reports.verify.lanes?.length || reports.verify.lanes.some(l => !l.command || l.exitCode !== 0)) throw new Error('verification did not pass recorded lanes')
      if (reports.review.verdict !== 'approve' || reports.gate.verdict !== 'approve' || !reports.gate.acceptance?.length || reports.gate.acceptance.some(a => a.verdict !== 'pass' || !a.clause)) throw new Error('review/gate did not approve acceptance criteria')
      const changed = git(plan.repoPath, 'diff', '--name-only', '-z', `${git(plan.repoPath, 'merge-base', state.integrationTip, sha)}...${sha}`).split('\0').filter(Boolean)
      if (changed.some(f => f === '.roadmap' || f.startsWith('.roadmap/'))) throw new Error('unit modifies roadmap control files; lead must reconcile separately')
      record.status = 'merge-ready'; record.stage = 'merge-queue'
      await save(ctx, plan, before, state, { [evidence(id)]: json({ head: sha, integrationTip: state.integrationTip,
        fingerprint: await fingerprint(ctx, plan, id), implementer: request.implementer, reports }) })
      return { approved: sha }
    }
    if (command === 'merge') {
      if (record.status !== 'merge-ready') throw new Error('unit is not merge-ready')
      const approval = await read(path.join(ctx.dir, evidence(id)))
      const sha = head(plan.repoPath, branch(id))
      if (!clean(cwd) || approval.head !== sha || approval.integrationTip !== state.integrationTip || approval.fingerprint !== await fingerprint(ctx, plan, id)) throw new Error('stale approval; reconcile and reverify/review')
      if (!depsMet(plan, state, id)) throw new Error('dependencies are not merged')
      const integration = path.join(plan.worktreeRoot, '__integration')
      if (!clean(integration) || git(integration, 'symbolic-ref', '--short', 'HEAD') !== state.integrationBranch || head(integration) !== state.integrationTip) throw new Error('integration checkout changed')
      if (ancestor(plan.repoPath, sha, state.integrationTip)) throw new Error('unit has no unmerged commits')
      const testCommand = plan.config?.codexNative?.integrationTestCommand
      if (!testCommand) throw new Error('set config.codexNative.integrationTestCommand from the codebase brief')
      const candidate = path.join(plan.worktreeRoot, `__merge-${id}-${randomUUID().slice(0, 8)}`)
      git(plan.repoPath, 'worktree', 'add', '--detach', candidate, state.integrationTip)
      let result
      try {
        git(candidate, 'merge', '--no-ff', '--no-edit', branch(id))
        const candidateHead = head(candidate)
        await provision(plan, candidate)
        // Numbered artifact collisions are checked against the pre-merge tree.
        for (const glob of plan.prefixUniqueGlobs ?? []) {
          const counts = ref => {
            const pattern = globRegex(glob)
            const rows = git(candidate, 'ls-tree', '-r', '-z', '--name-only', ref).split('\0').filter(f => pattern.test(f))
            const out = new Map()
            for (const f of rows) { const prefix = path.basename(f).match(/^\d+/)?.[0]; if (prefix) out.set(prefix, (out.get(prefix) ?? 0) + 1) }
            return out
          }
          const old = counts(state.integrationTip), next = counts('HEAD')
          if ([...next].some(([k, n]) => n > 1 && n > (old.get(k) ?? 0))) throw new Error(`duplicate numeric prefix: ${glob}`)
        }
        result = await shell(testCommand, candidate, plan.config?.codexNative?.testTimeoutMs ?? 600000)
        if (result.exitCode !== 0 || !clean(candidate) || head(candidate) !== candidateHead) throw new Error(`integration suite failed or changed candidate: ${result.tail}`)
        if (head(plan.repoPath, branch(id)) !== sha || head(integration) !== state.integrationTip || !clean(integration)) throw new Error('branch changed during integration verification')
        if (approval.fingerprint !== await fingerprint(ctx, plan, id)) throw new Error('specification changed during integration verification')
        // The integration branch moves only after the exact candidate has passed its suite.
        git(integration, 'merge', '--ff-only', head(candidate))
      } catch (e) {
        record.status = 'running'; record.stage = 'gate'
        await checkpoint(ctx, { ...stateFiles(state), [evidence(id)]: null,
          [`evidence/${id}/integration.json`]: json({ candidate, result, error: String(e.message) }) })
        return { merged: false, candidate, error: String(e.message) }
      }
      state.integrationTip = head(integration)
      Object.assign(record, { status: 'merged', mergedAt: state.integrationTip, mergedWave: state.wave })
      delete record.stage
      await save(ctx, plan, before, state, { [`evidence/${id}/integration.json`]: json({ head: state.integrationTip, ...result }) })
      git(plan.repoPath, 'worktree', 'remove', candidate)
      return { merged: true, head: state.integrationTip }
    }
    throw new Error(`unknown command: ${command}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node roadmap.mjs <request.json> (see references/protocol.md)')
    console.log(json(await run(JSON.parse(await readFile(process.argv[2], 'utf8')))))
  } catch (e) { console.error(`roadmap: ${e.message}`); process.exitCode = 1 }
}
