// Shared disk protocol. No model calls or runtime-specific journal dependencies.
import { mkdir, readFile, rename, rm, open, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const VERSION = 1
export const json = value => `${JSON.stringify(value, null, 2)}\n`
export const hash = value => createHash('sha256').update(value).digest('hex')
export const read = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e }
}
export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
export function gitMaybe(repo, ...args) {
  try { return git(repo, ...args) } catch { return null }
}
export async function atomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
  await rename(temp, file)
}
export async function context(dir) {
  dir = await realpath(dir)
  const repo = git(dir, 'rev-parse', '--show-toplevel')
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return { dir, repo, runtime: path.join(common, 'roadmap-runtime', hash(dir).slice(0, 20)) }
}
export async function checkVersion(ctx) {
  const protocol = await read(path.join(ctx.dir, 'protocol.json'), null)
  if (protocol && protocol.version !== VERSION) throw new Error(`unsupported roadmap protocol: ${protocol.version}`)
  return protocol
}
export async function assertOwner(ctx, token, driver) {
  await checkVersion(ctx)
  const owner = await read(path.join(ctx.runtime, 'owner.json'), null)
  if (!owner || !token || owner.token !== token || (driver && owner.driver !== driver)) {
    throw new Error('driver ownership mismatch; stop the prior driver and acquire ownership before writing')
  }
  return owner
}
// A short process lock serializes helpers and the legacy persister. Never auto-break a lock:
// it may protect a live merge/test. After a crash, inspect its PID before removing it.
export async function exclusive(ctx, fn) {
  await mkdir(ctx.runtime, { recursive: true })
  const lock = path.join(ctx.runtime, 'operation.lock')
  let handle
  try { handle = await open(lock, 'wx', 0o600) }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`another roadmap operation holds ${lock}; inspect its PID before recovery`); throw e }
  try {
    await handle.writeFile(json({ pid: process.pid, started: new Date().toISOString() }))
    return await fn()
  } finally { await handle.close(); await rm(lock, { force: true }) }
}
async function safeFile(ctx, name) {
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) {
    throw new Error(`invalid checkpoint path: ${name}`)
  }
  let file = ctx.dir
  for (const part of name.split('/')) {
    file = path.join(file, part)
    try { if ((await lstat(file)).isSymbolicLink()) throw new Error(`checkpoint path is a symlink: ${name}`) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  return file
}
// Write-ahead, redo-only transaction. Each replacement is atomic; after an interruption readers
// must run recover before loading the pair. The immutable journal is removed only after all writes.
export async function recover(ctx) {
  const pending = path.join(ctx.runtime, 'checkpoint.json')
  const txn = await read(pending, null)
  if (!txn) return false
  if (txn.version !== VERSION) throw new Error('unsupported checkpoint journal')
  for (const [name, content] of Object.entries(txn.files)) {
    const file = await safeFile(ctx, name)
    if (content === null) await rm(file, { force: true })
    else await atomic(file, content)
  }
  await rm(pending)
  return true
}
export async function checkpoint(ctx, files) {
  await checkVersion(ctx)
  if (await read(path.join(ctx.runtime, 'checkpoint.json'), null)) throw new Error('unfinished checkpoint; recover first')
  for (const [name, content] of Object.entries(files)) {
    await safeFile(ctx, name)
    if (content !== null && typeof content !== 'string') throw new Error(`checkpoint content must be text: ${name}`)
  }
  await atomic(path.join(ctx.runtime, 'checkpoint.json'), json({ version: VERSION, files }))
  await recover(ctx)
}
export function validate(plan, state) {
  if (!plan || !state || !Array.isArray(plan.units) || !Array.isArray(plan.edges)) throw new Error('plan needs units and edges arrays')
  if (!path.isAbsolute(plan.repoPath ?? '') || !path.isAbsolute(plan.worktreeRoot ?? '')) throw new Error('plan paths must be absolute')
  const rel = path.relative(plan.repoPath, plan.worktreeRoot)
  if (!rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('worktreeRoot must be outside repoPath')
  const integration = state.integrationBranch
  if (typeof integration !== 'string' || !integration || integration.startsWith('-') || gitMaybe(plan.repoPath, 'check-ref-format', `refs/heads/${integration}`) === null) throw new Error('invalid integration branch name')
  const primary = gitMaybe(plan.repoPath, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  const remoteDefault = gitMaybe(plan.repoPath, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '')
  if (['main', 'master', primary, remoteDefault].includes(integration)) throw new Error('integration must not be the primary checkout or default branch')
  if (!/^[a-f0-9]{40,64}$/.test(state.integrationTip ?? '')) throw new Error('integrationTip must be a full commit SHA')
  if (!Number.isInteger(state.wave) || state.wave < 0 || !state.units || typeof state.units !== 'object') throw new Error('invalid state wave/units')
  for (const [key, value] of Object.entries(plan.config?.codexNative ?? {})) {
    if (['maxConcurrent', 'maxWaves', 'testTimeoutMs'].includes(key) && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`invalid codexNative.${key}`)
  }
  for (const key of ['maxFixRounds', 'maxGateRounds', 'maxGateRoundsLarge']) {
    const value = plan.config?.[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`invalid ${key}`)
  }
  const ids = new Set()
  for (const unit of plan.units) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(unit.id) || ids.has(unit.id)) throw new Error(`invalid/duplicate unit id: ${unit.id}`)
    if (unit.existingBranch === `unit/${unit.id}`) throw new Error(`self-adoption refused: ${unit.id}`)
    ids.add(unit.id)
  }
  for (const id of Object.keys(state.units)) {
    if (!ids.has(id)) throw new Error(`state has unknown unit: ${id}`)
    if (!['pending', 'running', 'merge-ready', 'merged', 'blocked', 'quarantined', 'deferred'].includes(state.units[id].status)) throw new Error(`invalid status: ${id}`)
  }
  const incoming = new Map([...ids].map(id => [id, 0]))
  for (const e of plan.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error('edge references unknown unit')
    incoming.set(e.to, incoming.get(e.to) + 1)
    const to = plan.units.find(u => u.id === e.to), from = plan.units.find(u => u.id === e.from)
    if (to.inScope !== false && from.inScope === false) throw new Error('cut line must include all ancestors')
  }
  const queue = [...ids].filter(id => incoming.get(id) === 0)
  for (let i = 0; i < queue.length; i++) for (const e of plan.edges.filter(e => e.from === queue[i])) {
    incoming.set(e.to, incoming.get(e.to) - 1)
    if (incoming.get(e.to) === 0) queue.push(e.to)
  }
  if (queue.length !== ids.size) throw new Error('dependency cycle')
}
export function monotonic(before, after, { perWaveRounds = false } = {}) {
  if (after.integrationBranch !== before.integrationBranch || after.wave < before.wave) throw new Error('checkpoint regresses arc identity/wave')
  for (const key of ['spend', 'escalationStops']) for (const [name, value] of Object.entries(before[key] ?? {})) {
    if (typeof value === 'number' && (after[key]?.[name] ?? 0) < value) throw new Error(`checkpoint regresses ${key}.${name}`)
  }
  if ((after.consultsUsed ?? 0) < (before.consultsUsed ?? 0)) throw new Error('checkpoint regresses consult budget')
  for (const [id, unit] of Object.entries(before.units)) {
    if (!after.units[id]) throw new Error(`checkpoint drops unit ${id}`)
    if (unit.status === 'merged' && after.units[id].status !== 'merged') throw new Error(`checkpoint unmerges ${id}`)
    for (const [key, value] of Object.entries(unit.rounds ?? {})) {
      if (perWaveRounds && after.wave > before.wave && key !== 'verifyBlocked') continue
      if ((after.units[id].rounds?.[key] ?? 0) < value) throw new Error(`checkpoint resets ${id} round budget`)
    }
  }
}
// Runtime-known fields are deliberately replaceable (e.g. a cleared halt must stay cleared).
// Unknown extension fields survive the Claude serializer's selective reconstruction.
const stateFields = new Set('integrationBranch integrationTip consultsUsed spend run conductor preview debt debtPending escalationStops owed sharedReds scopeRulings boundary halt codex wave units partial degradations escalations'.split(' '))
const unitFields = new Set('status stage branch base mergedAt reason dossierPath rounds parked codexSession issue note'.split(' '))
export function preserveExtensions(before, after) {
  const result = { ...Object.fromEntries(Object.entries(before ?? {}).filter(([k]) => !stateFields.has(k))), ...after }
  result.units = Object.fromEntries(Object.entries(after.units ?? {}).map(([id, unit]) => [id, {
    ...Object.fromEntries(Object.entries(before?.units?.[id] ?? {}).filter(([k]) => !unitFields.has(k))), ...unit,
  }]))
  return result
}
// Called by persist.mjs before replay and again under the write lock. Legacy arcs remain readable;
// once ownership/version metadata exists, a token is compulsory, including for a late old return.
export async function assertLegacyWriter(ctx, token) {
  const protocol = await checkVersion(ctx)
  const owner = await read(path.join(ctx.runtime, 'owner.json'), null)
  if (protocol || owner) await assertOwner(ctx, token, 'claude')
}
