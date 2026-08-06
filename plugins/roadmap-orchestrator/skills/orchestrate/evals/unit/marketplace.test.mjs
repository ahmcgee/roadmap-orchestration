import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const json = async (path) => JSON.parse(await readFile(resolve(repo, path), 'utf8'))

test('Claude and Codex marketplaces coexist with their native, independent schemas', async () => {
  const [claudeMarket, codexMarket, claudePlugin, codexPlugin] = await Promise.all([
    json('.claude-plugin/marketplace.json'),
    json('.agents/plugins/marketplace.json'),
    json('plugins/roadmap-orchestrator/.claude-plugin/plugin.json'),
    json('plugins/roadmap-orchestrator/.codex-plugin/plugin.json'),
  ])

  assert.equal(claudeMarket.name, 'roadmap-orchestration')
  assert.equal(codexMarket.name, 'roadmap-orchestration')
  assert.equal(claudePlugin.name, 'roadmap-orchestrator')
  assert.equal(codexPlugin.name, 'roadmap-orchestrator')

  const claudeEntry = claudeMarket.plugins.find((entry) => entry.name === 'roadmap-orchestrator')
  const codexEntry = codexMarket.plugins.find((entry) => entry.name === 'roadmap-orchestrator')
  assert.equal(claudeEntry.source, './plugins/roadmap-orchestrator')
  assert.deepEqual(codexEntry.source, { source: 'local', path: './plugins/roadmap-orchestrator' })
  assert.deepEqual(codexEntry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' })
  assert.equal(codexEntry.category, 'Developer Tools')
  assert.equal('policy' in claudeEntry, false, 'Codex policy fields must not leak into Claude metadata')
})

test('either discovered skill routes Codex to the SDK sidecar before dispatch', async () => {
  const [shared, codex, openai] = await Promise.all([
    readFile(resolve(repo, 'plugins/roadmap-orchestrator/skills/orchestrate/SKILL.md'), 'utf8'),
    readFile(resolve(repo, 'plugins/roadmap-orchestrator/skills/codex-orchestrate/SKILL.md'), 'utf8'),
    readFile(resolve(repo, 'plugins/roadmap-orchestrator/skills/codex-orchestrate/agents/openai.yaml'), 'utf8'),
  ])
  const hostRoute = shared.indexOf('Select the execution host before dispatch')
  const nativeDispatch = shared.indexOf('Workflow({ scriptPath:')
  assert.ok(hostRoute >= 0 && hostRoute < nativeDispatch, 'shared skill must route hosts before native dispatch')
  assert.match(shared, /Codex:[\s\S]*codex-orchestrate\/SKILL\.md[\s\S]*Never invoke native `Workflow/)
  assert.match(codex, /Mandatory host contract/)
  assert.match(codex, /dispatch\s+only through `runtime\/codex\/bin\/roadmap-codex\.mjs`/)
  assert.match(codex, /ROADMAP_CODEX_RUNTIME\/bin\/roadmap-codex\.mjs/)
  assert.match(codex, /doctor[\s\S]*run[\s\S]*resume[\s\S]*continue/)
  assert.match(openai, /\$roadmap-orchestrate/)
})
