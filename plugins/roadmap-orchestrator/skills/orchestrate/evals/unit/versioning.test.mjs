import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const script = resolve(repoRoot, 'scripts/bump-marketplace-version.mjs')
const versionedFiles = [
  '.claude-plugin/marketplace.json',
  'plugins/roadmap-orchestrator/.claude-plugin/plugin.json',
  'plugins/roadmap-orchestrator/.codex-plugin/plugin.json',
  'plugins/roadmap-orchestrator/runtime/codex/package.json',
  'plugins/roadmap-orchestrator/runtime/codex/package-lock.json',
]

test('marketplace version helper verifies and previews the coordinated bump without writing', () => {
  const before = versionedFiles.map(path => readFileSync(resolve(repoRoot, path), 'utf8'))
  const check = execFileSync(process.execPath, [script, '--check'], { cwd: repoRoot, encoding: 'utf8' })
  const preview = execFileSync(process.execPath, [script, '--dry-run', '99.0.0'], { cwd: repoRoot, encoding: 'utf8' })
  const after = versionedFiles.map(path => readFileSync(resolve(repoRoot, path), 'utf8'))

  assert.match(check, /marketplace versions synchronized at \d+\.\d+\.\d+/)
  assert.match(preview, /would bump marketplace versions .* -> 99\.0\.0 in 5 files/)
  assert.deepEqual(after, before)
})

test('marketplace version helper rejects a downgrade', () => {
  const result = spawnSync(process.execPath, [script, '0.0.0'], { cwd: repoRoot, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must be greater than current version/)
})
