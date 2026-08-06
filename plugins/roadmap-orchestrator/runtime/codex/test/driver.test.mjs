import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { continueFromCheckpoint, resume, run } from '../src/driver.mjs'

class ReplayFakeCodex {
  constructor({ forbid = false } = {}) { this.calls = 0; this.forbid = forbid }
  startThread() {
    if (this.forbid) throw new Error('completed prefix must not be re-issued')
    this.calls++
    return { id: `thread-${this.calls}`, runStreamed: async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' }
      yield { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }
      yield { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }
    })() }) }
  }
}

test('cross-host continuation starts a new Codex journal from plan/state, not the Claude run id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-driver-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'); const wt = join(root, 'worktrees')
  await mkdir(join(repo, '.roadmap'), { recursive: true }); await mkdir(wt)
  const scriptPath = join(root, 'conductor.mjs'); const harnessPath = join(root, 'harness.mjs')
  await writeFile(scriptPath, `export const meta={name:'driver-fixture'}\nreturn {state:args.state}\n`)
  await writeFile(harnessPath, `export const meta={name:'unused'}\nreturn {}\n`)
  await writeFile(join(repo, '.roadmap', 'plan.json'), JSON.stringify({ repoPath: repo, worktreeRoot: wt,
    methodology: { scopePolicy: 'bounded-v1' }, units: [], edges: [] }))
  await writeFile(join(repo, '.roadmap', 'state.json'), JSON.stringify({ integrationBranch: 'roadmap/x',
    integrationTip: 'abc', wave: 1, units: {}, run: { host: 'claude', runId: 'claude-native' } }))
  const result = await continueFromCheckpoint({ repo, runId: 'codex-new', scriptPath, harnessPath,
    codex: {}, dashboardPort: 0, authInspector: () => ({ ok: true, mode: 'chatgpt', summary: 'test' }) })
  assert.equal(result.runId, 'codex-new')
  assert.equal(result.dashboard.host, '0.0.0.0', 'dashboard is enabled and promiscuous by default')
  const state = JSON.parse(await readFile(join(repo, '.roadmap', 'state.json'), 'utf8'))
  assert.equal(state.run.host, 'codex')
  assert.equal(state.run.runId, 'codex-new')
  assert.notEqual(state.run.runId, 'claude-native')
  assert.match(state.run.journalPath, /__codex-runtime\/codex-new$/)
})

test('resume refuses a run id or host that state does not identify', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-driver-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'); const wt = join(root, 'worktrees')
  await mkdir(join(repo, '.roadmap'), { recursive: true }); await mkdir(wt)
  const scriptPath = join(root, 'conductor.mjs'); const harnessPath = join(root, 'harness.mjs')
  await writeFile(scriptPath, `export const meta={name:'driver-fixture'}\nreturn {}\n`)
  await writeFile(harnessPath, `export const meta={name:'unused'}\nreturn {}\n`)
  await writeFile(join(repo, '.roadmap', 'plan.json'), JSON.stringify({ repoPath: repo, worktreeRoot: wt, units: [], edges: [] }))
  await writeFile(join(repo, '.roadmap', 'state.json'), JSON.stringify({ run: { host: 'claude', runId: 'native' } }))
  await assert.rejects(resume({ repo, runId: 'wrong', scriptPath, harnessPath,
    dashboard: false, authInspector: () => ({ ok: true, mode: 'chatgpt', summary: 'test' }) }), /does not identify/)
})

test('resume replays from journaled initial args without overwriting the newer checkpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-driver-replay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'); const wt = join(root, 'worktrees')
  await mkdir(join(repo, '.roadmap'), { recursive: true }); await mkdir(wt)
  const scriptPath = join(root, 'flow.mjs'); const harnessPath = join(root, 'harness.mjs')
  await writeFile(scriptPath, `export const meta={name:'replay-fixture'}\nreturn agent('tip='+args.state.integrationTip,{model:'haiku',effort:'low',label:'probe',phase:'Test',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}})\n`)
  await writeFile(harnessPath, `export const meta={name:'unused'}\nreturn {}\n`)
  const plan = { repoPath: repo, worktreeRoot: wt, units: [], edges: [] }
  await writeFile(join(repo, '.roadmap', 'plan.json'), JSON.stringify(plan))
  await writeFile(join(repo, '.roadmap', 'state.json'), JSON.stringify({ integrationTip: 'old' }))
  const authInspector = () => ({ ok: true, mode: 'chatgpt', summary: 'test' })
  const firstSdk = new ReplayFakeCodex()
  await run({ repo, runId: 'durable', scriptPath, harnessPath, codex: firstSdk, dashboard: false, authInspector })
  assert.equal(firstSdk.calls, 1)
  const checkpoint = JSON.parse(await readFile(join(repo, '.roadmap', 'state.json'), 'utf8'))
  checkpoint.integrationTip = 'new-checkpoint'
  await writeFile(join(repo, '.roadmap', 'state.json'), JSON.stringify(checkpoint))
  const replaySdk = new ReplayFakeCodex({ forbid: true })
  const replayed = await resume({ repo, runId: 'durable', scriptPath, harnessPath,
    codex: replaySdk, dashboard: false, authInspector })
  assert.deepEqual(replayed.result, { ok: true })
  assert.equal(replaySdk.calls, 0)
  const after = JSON.parse(await readFile(join(repo, '.roadmap', 'state.json'), 'utf8'))
  assert.equal(after.integrationTip, 'new-checkpoint')
})
