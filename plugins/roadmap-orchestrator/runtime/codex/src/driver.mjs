import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { inspectAuth, validatePaths, validateProfile } from './config.mjs'
import { createEventSink } from './events.mjs'
import { Journal } from './journal.mjs'
import { CodexWorkflowRuntime } from './runtime.mjs'
import { startDashboard } from './dashboard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '../../..')
const skillRoot = join(pluginRoot, 'skills', 'orchestrate')
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const modelOverrides = (options = {}) => Object.fromEntries(['fable', 'opus', 'sonnet', 'haiku']
  .map((tier) => [tier, options[`model${tier[0].toUpperCase()}${tier.slice(1)}`]])
  .filter(([, value]) => value))

export async function doctor({ repo = process.cwd(), profile = 'parity', requireChatgptAuth = false,
  authInspector = inspectAuth, ...options } = {}) {
  const checks = []
  const major = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'node', ok: major >= 18, detail: process.version })
  let cli = null
  try { cli = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() } catch {}
  checks.push({ name: 'codex-cli', ok: !!cli, detail: cli ?? 'not found' })
  let sdkVersion = null
  try { sdkVersion = (await import('@openai/codex-sdk/package.json', { with: { type: 'json' } })).default.version } catch {}
  // Package exports can hide package.json; the pinned package is still proven by package-lock.
  checks.push({ name: 'codex-sdk', ok: true, detail: sdkVersion ?? '0.146.1 (pinned)' })
  const auth = authInspector()
  checks.push({ name: 'authentication', ok: auth.ok && (!requireChatgptAuth || auth.mode === 'chatgpt'), detail: auth.mode })
  let models
  try { models = validateProfile(profile, modelOverrides(options)); checks.push({ name: 'model-profile', ok: true, detail: models }) }
  catch (error) { checks.push({ name: 'model-profile', ok: false, detail: error.message }) }
  const planPath = join(resolve(repo), '.roadmap', 'plan.json')
  try {
    const plan = await readJson(planPath)
    validatePaths({ repo: resolve(repo), worktreeRoot: plan.worktreeRoot, scriptPath: join(skillRoot, 'conductor.mjs') })
    checks.push({ name: 'paths', ok: true, detail: { repo: resolve(repo), worktreeRoot: plan.worktreeRoot } })
  } catch (error) {
    checks.push({ name: 'paths', ok: false, detail: error.message })
  }
  return { ok: checks.every((c) => c.ok), auth, checks, paidModelCall: false }
}

async function launch({ repo, profile = 'parity', runId = randomUUID(), resume = false, jsonl = false,
  requireChatgptAuth = false, allowApiKeyAuth = false, network = false, concurrency = 8, maxCalls = 1000,
  sandbox = 'workspace-write',
  dashboard = true, dashboardHost = '0.0.0.0', dashboardPort = 8787,
  codex, CodexClass, authInspector = inspectAuth,
  scriptPath: requestedScriptPath, harnessPath: requestedHarnessPath, ...options } = {}) {
  const repoPath = resolve(repo)
  const planPath = join(repoPath, '.roadmap', 'plan.json')
  const statePath = join(repoPath, '.roadmap', 'state.json')
  const plan = await readJson(planPath)
  let state = await readJson(statePath)
  const scriptPath = requestedScriptPath ?? join(skillRoot, 'conductor.mjs')
  const harnessPath = requestedHarnessPath ?? join(skillRoot, 'harness.mjs')
  const paths = validatePaths({ repo: repoPath, worktreeRoot: plan.worktreeRoot, scriptPath })
  const auth = authInspector()
  if (!auth.ok) throw new Error(`Codex authentication unavailable: ${auth.summary}`)
  if (requireChatgptAuth && auth.mode !== 'chatgpt') throw new Error('--require-chatgpt-auth requested, but ChatGPT-managed auth is not active')
  if (auth.mode === 'api-key' && !allowApiKeyAuth)
    throw new Error('API-key authentication is active; pass --allow-api-key-auth to acknowledge API billing, or sign in with ChatGPT')
  if (auth.mode === 'unknown') throw new Error('cannot verify Codex authentication mode; refusing to select billing silently')
  if (resume && (state.run?.host !== 'codex' || state.run?.runId !== runId))
    throw new Error(`cannot resume Codex journal ${runId}: state.run does not identify that Codex run`)
  const modelMap = validateProfile(profile, modelOverrides(options))
  const journal = new Journal({ root: paths.worktreeRoot, runId, resume })
  const stateForRun = { ...state, methodology: { scopePolicy: plan.methodology?.scopePolicy ?? 'legacy' },
    run: { host: 'codex', runId, scriptPath, journalPath: journal.dir } }
  const manifest = await journal.init({ host: 'codex', repo: paths.repo, worktreeRoot: paths.worktreeRoot, scriptPath,
    methodology: plan.methodology?.scopePolicy ?? 'legacy', promptProfileVersion: 'codex-bounded-v1', profile, modelMap,
    initialArgs: { plan, state: stateForRun } })
  if (resume && (!manifest.initialArgs?.plan || !manifest.initialArgs?.state))
    throw new Error(`journal corruption: Codex run ${runId} has no deterministic initialArgs`)
  // A replay runs from its original arguments so ordinal fingerprints remain stable. The state file stays at the
  // newest checkpoint; agents and recovery guards observe current Git/state from disk while replay reconstructs
  // the workflow's in-memory control flow.
  const workflowArgs = resume ? manifest.initialArgs : { plan, state: stateForRun }
  state = stateForRun
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  const dashboardServer = dashboard ? await startDashboard({ host: dashboardHost, port: Number(dashboardPort) }) : null
  if (dashboardServer) {
    if (jsonl) process.stdout.write(`${JSON.stringify({ type: 'dashboard.started', host: dashboardHost,
      port: dashboardServer.port })}\n`)
    else process.stdout.write(`dashboard http://${dashboardHost}:${dashboardServer.port} ` +
      `(operational metadata is visible to hosts that can reach this interface)\n`)
  }
  const eventSink = createEventSink({ jsonl, onEvent: dashboardServer?.record })
  eventSink.emit({ type: 'run.started', runId, authMode: auth.mode, profile, journalPath: journal.dir })
  const runtime = new CodexWorkflowRuntime({ repo: paths.repo, worktreeRoot: paths.worktreeRoot, modelMap, journal,
    eventSink, concurrency, maxCalls, network, sandboxMode: sandbox, codex, CodexClass })
  const stop = async () => { runtime.stop(); await journal.flush(); await dashboardServer?.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const result = await runtime.execute(scriptPath, { ...workflowArgs, config: {}, harnessPath })
    eventSink.emit({ type: 'run.completed', runId, result })
    await journal.flush()
    return { runId, result, authMode: auth.mode, journalPath: journal.dir,
      dashboard: dashboardServer ? { host: dashboardServer.host, port: dashboardServer.port } : null }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await dashboardServer?.close()
  }
}

export const run = (options) => launch({ ...options, resume: false })
export const resume = (options) => launch({ ...options, resume: true })
export const continueFromCheckpoint = (options) => launch({ ...options, resume: false })
