#!/usr/bin/env node
import { continueFromCheckpoint, doctor, resume, run } from '../src/driver.mjs'

const argv = process.argv.slice(2)
const command = argv.shift()

function parse(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    if (arg === '--no-dashboard') { out.dashboard = false; continue }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (['jsonl', 'requireChatgptAuth', 'allowApiKeyAuth', 'network', 'dashboard'].includes(key)) out[key] = true
    else {
      const value = args[++i]
      if (value == null || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      out[key] = ['concurrency', 'maxCalls', 'dashboardPort'].includes(key) ? Number(value) : value
    }
  }
  return out
}

const usage = `roadmap-codex doctor [--repo <path>] [--profile parity|economy] [--require-chatgpt-auth]
roadmap-codex run --repo <path> [--profile parity|economy] [--jsonl] [--no-dashboard] [--require-chatgpt-auth]
roadmap-codex resume --repo <path> --run-id <id> [--profile parity|economy] [--jsonl] [--no-dashboard]
roadmap-codex continue --repo <path> [--profile parity|economy] [--jsonl] [--no-dashboard]

Override a profile hypothesis explicitly with --model-fable/--model-opus/--model-sonnet/--model-haiku.
The default sandbox is workspace-write. Use --sandbox danger-full-access only as an explicit environment workaround.
The dashboard serves live operational progress by default on 0.0.0.0:8787. Override it with
--dashboard-host/--dashboard-port, or disable it explicitly with --no-dashboard.

API-key login is never selected silently. If intentionally using API billing, add --allow-api-key-auth.`

try {
  if (!command || command === 'help' || command === '--help') { process.stdout.write(`${usage}\n`); process.exit(0) }
  const options = parse(argv)
  let result
  if (command === 'doctor') result = await doctor(options)
  else {
    if (!options.repo) throw new Error(`${command} requires --repo <path>`)
    if (command === 'run') result = await run(options)
    else if (command === 'resume') {
      if (!options.runId) throw new Error('resume requires --run-id <id>')
      result = await resume(options)
    } else if (command === 'continue') result = await continueFromCheckpoint(options)
    else throw new Error(`unknown command: ${command}`)
  }
  if (command === 'doctor' || options.jsonl) process.stdout.write(`${JSON.stringify(result)}\n`)
  else process.stdout.write(`run ${result.runId} complete; journal ${result.journalPath}\n`)
  if (result?.ok === false) process.exitCode = 1
} catch (error) {
  process.stderr.write(`roadmap-codex: ${error.message}\n`)
  process.exitCode = 1
}
