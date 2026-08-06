import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const MODEL_PROFILES = {
  parity: { fable: 'gpt-5.6-sol', opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.6-luna' },
  economy: { fable: 'gpt-5.6-sol', opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.6-luna' },
}
export const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])

export function inspectAuth() {
  const result = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  if (result.error || result.status !== 0)
    return { ok: false, mode: 'none', summary: output || result.error?.message || `exit ${result.status}` }
  const lower = output.toLowerCase()
  return { ok: true, mode: lower.includes('chatgpt') ? 'chatgpt' : lower.includes('api') ? 'api-key' : 'unknown', summary: output }
}

export function validateProfile(name, override = {}) {
  if (!MODEL_PROFILES[name]) throw new Error(`invalid profile ${name}; expected parity or economy`)
  const mapping = { ...MODEL_PROFILES[name], ...override }
  for (const tier of ['fable', 'opus', 'sonnet', 'haiku'])
    if (typeof mapping[tier] !== 'string' || !mapping[tier].trim()) throw new Error(`profile ${name} has no model for ${tier}`)
  return mapping
}

export function validatePaths({ repo, worktreeRoot, scriptPath }) {
  for (const [name, value] of Object.entries({ repo, worktreeRoot, scriptPath })) {
    if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
    if (name !== 'worktreeRoot' && !statSync(value).isDirectory() && name === 'repo') throw new Error(`${repo} is not a directory`)
  }
  const realRepo = realpathSync(repo)
  const resolvedRoot = resolve(worktreeRoot)
  if (resolvedRoot === realRepo || resolvedRoot.startsWith(`${realRepo}/`))
    throw new Error('worktreeRoot must be outside the target repository')
  return { repo: realRepo, worktreeRoot: resolvedRoot, scriptPath: resolve(scriptPath) }
}

export function normalizeEffort(effort, semanticTier = 'opus') {
  const selected = effort ?? ({ haiku: 'low', sonnet: 'medium', opus: 'medium', fable: 'high' }[semanticTier] ?? 'medium')
  if (!EFFORTS.has(selected)) throw new Error(`unsupported Codex reasoning effort: ${selected}`)
  return selected
}
