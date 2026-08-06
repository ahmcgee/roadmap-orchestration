import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createBudget, parallel, pipeline } from './workflow-primitives.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const META_PREFIX = 'export const meta'
const GLOBALS = ['args', 'agent', 'workflow', 'log', 'phase', 'budget', 'parallel', 'pipeline']

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function extractMetadata(raw, absPath) {
  if (!raw.startsWith(META_PREFIX) || !/^export const meta\s*=/.test(raw))
    throw new Error(`workflow-loader: ${absPath} must begin with \`export const meta = ...\``)
  const eq = raw.indexOf('=')
  const open = raw.indexOf('{', eq)
  if (open < 0) throw new Error(`workflow-loader: ${absPath} has no metadata object`)
  let depth = 0
  let quote = null
  let escaped = false
  let close = -1
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    if (ch === '}' && --depth === 0) { close = i; break }
  }
  if (close < 0) throw new Error(`workflow-loader: ${absPath} metadata object is unterminated`)
  try {
    return Function(`"use strict"; return (${raw.slice(open, close + 1)})`)()
  } catch (error) {
    throw new Error(`workflow-loader: ${absPath} metadata is not a standalone object: ${error.message}`)
  }
}

function defaultGlobals() {
  return {
    args: {},
    agent: async () => { throw new Error('workflow-loader: agent() was called without an injected agent') },
    workflow: async () => { throw new Error('workflow-loader: workflow() was called without an injected workflow') },
    log: () => {},
    phase: () => {},
    budget: createBudget(),
    parallel,
    pipeline,
  }
}

export async function loadWorkflow(absPath) {
  const raw = await readFile(absPath, 'utf8')
  const exportMatches = [...raw.matchAll(/\bexport\s+/g)]
  if (exportMatches.length !== 1 || exportMatches[0].index !== 0)
    throw new Error(`workflow-loader: ${absPath} must contain exactly one leading export (export const meta)`)
  const metadata = extractMetadata(raw, absPath)
  const source = raw.slice('export '.length)
  let compiled
  try {
    compiled = new AsyncFunction(...GLOBALS, source)
  } catch (error) {
    throw new Error(`workflow-loader: failed to compile ${absPath}: ${error.message}`)
  }
  const run = async (globals = {}) => {
    const injected = { ...defaultGlobals(), ...globals }
    return compiled(...GLOBALS.map((name) => injected[name]))
  }
  return { absPath, metadata, sourceDigest: sha256(raw), run }
}

// Backward-compatible test-loader surface.
export async function loadScript(absPath) {
  const loaded = await loadWorkflow(absPath)
  const runner = loaded.run
  runner.meta = loaded.metadata
  runner.sourceDigest = loaded.sourceDigest
  return runner
}

export { parallel, pipeline }
