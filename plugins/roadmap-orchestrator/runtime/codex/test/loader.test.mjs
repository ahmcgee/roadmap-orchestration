import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadScript, loadWorkflow } from '../../workflow-loader.mjs'

test('production and compatibility loaders execute identical injected control flow', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'roadmap-loader-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'flow.mjs')
  await writeFile(path, `export const meta = { name: 'fixture', phases: [] }\n` +
    `phase('work'); const rows = await parallel(args.items.map((n) => async () => agent('n='+n, ` +
    `{model:'haiku',effort:'low',label:'item:'+n,phase:'work',schema:{type:'object'}}))); ` +
    `return { rows, budget: budget.used() }\n`)
  const globals = { args: { items: [1, 2] }, phase: () => {},
    agent: async (prompt) => ({ prompt }), budget: { used: () => 7 } }
  const production = await loadWorkflow(path)
  const compatibility = await loadScript(path)
  assert.deepEqual(await production.run(globals), await compatibility({ ...globals }))
  assert.equal(production.metadata.name, 'fixture')
  assert.equal(production.sourceDigest, compatibility.sourceDigest)
})

test('loader rejects unexpected exports instead of rewriting arbitrary source', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'roadmap-loader-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'bad.mjs')
  await writeFile(path, `export const meta = { name: 'bad' }\nexport const surprise = true\nreturn surprise\n`)
  await assert.rejects(loadWorkflow(path), /exactly one leading export/)
})
