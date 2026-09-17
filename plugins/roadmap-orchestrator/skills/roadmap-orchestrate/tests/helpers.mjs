import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { run } from '../scripts/roadmap.mjs'
import { git, json, read, context } from '../scripts/protocol.mjs'

export async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-roadmap-'))
  if (t) t.after(() => rm(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo'), dir = path.join(repo, '.roadmap'), wt = path.join(root, 'worktrees')
  await mkdir(dir, { recursive: true })
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'config', 'user.name', 'Roadmap fixture')
  await writeFile(path.join(repo, 'calc.mjs'), 'export const twice = x => x * 2\n')
  await writeFile(path.join(repo, 'test.mjs'), "import assert from 'node:assert/strict'; import {twice} from './calc.mjs'; assert.equal(twice(3), 6)\n")
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial fixture')
  const initial = git(repo, 'rev-parse', 'HEAD')
  const units = options.units ?? [{ id: 'a', risk: 'high', kind: 'code', inScope: true }, { id: 'b', risk: 'low', kind: 'code', inScope: true }]
  const plan = { repoPath: repo, worktreeRoot: wt, cutLine: options.cutLine ?? 'fixture', tracking: 'files', units,
    edges: options.edges ?? [], config: { codexNative: { integrationTestCommand: 'node test.mjs' }, ...(options.config ?? {}) } }
  const state = { integrationBranch: 'roadmap/fixture', integrationTip: initial, wave: 0, consultsUsed: 0, units: {} }
  await mkdir(path.join(dir, 'specs'), { recursive: true })
  await writeFile(path.join(dir, 'brief.md'), 'Test: node test.mjs. Pure Node ESM; no provisioning.\n')
  for (const u of units) await writeFile(path.join(dir, 'specs', `${u.id}.md`), `# ${u.id}\nAC-1: preserve twice(3) === 6. Done: node test.mjs. Scope: calc.mjs.\n`)
  const owner = await run({ command: 'init', roadmapDir: dir, plan, state })
  let token = owner.token
  const call = (command, fields = {}) => run({ command, roadmapDir: dir, token, ...fields })
  return { root, repo, dir, wt, plan, state, initial, call, owner,
    setToken: value => { token = value }, getToken: () => token,
    readState: () => read(path.join(dir, 'state.json')) }
}
export async function implement(f, id = 'a', content = 'export const twice = x => x + x\n') {
  const cwd = path.join(f.wt, id)
  await f.call('transition', { unit: id, stage: 'implement' })
  await writeFile(path.join(cwd, 'calc.mjs'), content)
  git(cwd, 'add', 'calc.mjs'); git(cwd, 'commit', '-m', `implement ${id}`)
  return git(cwd, 'rev-parse', 'HEAD')
}
export async function reports(f, id = 'a', overrides = {}) {
  const sha = git(path.join(f.wt, id), 'rev-parse', 'HEAD')
  const dir = path.join(f.dir, 'evidence', id)
  await mkdir(dir, { recursive: true })
  const entries = {
    verify: { head: sha, actor: 'verifier', verdict: 'pass', lanes: [{ command: 'node test.mjs', exitCode: 0 }] },
    review: { head: sha, actor: 'reviewer', verdict: 'approve', findings: [] },
    gate: { head: sha, actor: 'gate', verdict: 'approve', acceptance: [{ clause: 'AC-1', verdict: 'pass' }] },
    ...overrides,
  }
  for (const [role, data] of Object.entries(entries)) await writeFile(path.join(dir, `${role}.json`), json(data))
  return { unit: id, implementer: 'astra-lead', reports: Object.fromEntries(Object.keys(entries).map(role => [role, `evidence/${id}/${role}.json`])) }
}
export async function legacyPersist(f, token, state, plan = f.plan) {
  const returned = path.join(f.root, 'returned.json')
  await writeFile(returned, json({ status: 'conductor-return', state, plan, reason: 'fixture' }))
  const script = new URL('../../orchestrate/persist.mjs', import.meta.url)
  const args = ['--returned', returned, '--args', JSON.stringify({ roadmapDir: f.dir, ownerToken: token })]
  return execFileSync('node', [script.pathname, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
export { git, json, read, context, readFile, writeFile, mkdir, rm, path }
