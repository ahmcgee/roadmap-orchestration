#!/usr/bin/env node
// persist.mjs — turn a finished (or crashed) Workflow run into the files under `.roadmap/`.
//
// WHY THIS EXISTS. A workflow script has no filesystem, so for two years every byte it wanted on
// disk went through a model: a Haiku agent re-transcribed the whole of state.json at every
// checkpoint and every persist point, verified it by cksum, and sometimes lost it anyway. That was
// the second-largest model cost in the system after the root's own wakes, and it bought nothing but
// transport. The platform already journals every agent result, and the scripts are deterministic
// functions of (args, agent results) — so the run can simply be REPLAYED here, in a real Node
// process, at zero model cost, and its return value written out with `fs`.
//
//   node persist.mjs --run <workflowTranscriptDir> --script <harness.mjs|conductor.mjs>
//                    --args <envelope JSON string | path to a JSON file>
//
// `--run` is the directory holding `journal.jsonl` and the `agent-<id>.jsonl` transcripts; a nested
// `workflow()` child SHARES its parent's journal, so one directory covers a conductor run and every
// wave inside it. `--args` is the same envelope the root passed to Workflow.
//
// THIS FILE NEVER CALLS A MODEL. Its `agent` is a lookup in the journal; a lookup that misses (the
// run crashed, or the script changed since the journal was written) stops the replay and writes the
// PARTIAL state from the last snapshot the script logged, marked `partial: {stoppedAt}`, so the root
// can relaunch with `resumeFromRunId` and run this again.
//
// Exit codes: 0 = complete, 2 = partial (cache miss), 1 = error.
import { readFile, writeFile, readdir, mkdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadScript } from './script-loader.mjs'

/* ------------------------------- CLI ----------------------------------- */
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const runDir = flag('run')
const scriptPath = flag('script')
const argsRaw = flag('args')
if (!runDir || !scriptPath || argsRaw === undefined) {
  console.error('usage: node persist.mjs --run <workflowTranscriptDir> --script <script.mjs> --args <json|file>')
  process.exit(1)
}

const die = (msg) => { console.error(`persist: ${msg}`); process.exit(1) }

const parseArgs = async () => {
  const text = existsSync(argsRaw) ? await readFile(argsRaw, 'utf8') : argsRaw
  try { return JSON.parse(text) } catch (e) { die(`--args is neither a readable JSON file nor JSON: ${e.message}`) }
}

/* --------------------------- the journal map ---------------------------- */
// The platform writes, per workflow run:
//   journal.jsonl        {"type":"started"|"result","key":"v2:<hash>","agentId":"<id>",["result":…]}
//   agent-<id>.jsonl     that agent's transcript; the FIRST `type:"user"` record's message.content
//                        is the prompt, verbatim
// `key` is an opaque hash of (prompt, opts) — it cannot be recomputed here, so the prompt is
// recovered from the transcript instead and the map is keyed on it. A `started` with no `result` is
// an agent that DIED, which is not an absence: agent() resolves to `null` there, a code path several
// scripts handle explicitly, so it is recorded as a null result rather than dropped.
const promptOf = (records) => {
  const first = records.find((r) => r?.type === 'user')
  const c = first?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((p) => p?.type === 'text').map((p) => p.text).join('')
  return undefined
}

async function buildMap(dir) {
  const journal = path.join(dir, 'journal.jsonl')
  if (!existsSync(journal)) die(`no journal.jsonl under ${dir}`)
  const lines = (await readFile(journal, 'utf8')).split('\n').filter(Boolean)
  const order = []          // [{ agentId, result }] in journal order, one per call
  const seen = new Set()
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (!rec?.agentId) continue
    if (rec.type === 'result') { order.push({ agentId: rec.agentId, result: rec.result ?? null }); seen.add(rec.agentId) }
  }
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    // A started-without-result agent died; agent() resolved to null for it.
    if (rec?.type === 'started' && rec.agentId && !seen.has(rec.agentId)) {
      order.push({ agentId: rec.agentId, result: null })
      seen.add(rec.agentId)
    }
  }
  const files = new Set((await readdir(dir)).filter((f) => /^agent-.*\.jsonl$/.test(f)))
  const map = new Map()     // prompt -> { queue: [result], last: result }
  let unmapped = 0
  for (const { agentId, result } of order) {
    const f = `agent-${agentId}.jsonl`
    if (!files.has(f)) { unmapped++; continue }
    const recs = (await readFile(path.join(dir, f), 'utf8')).split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
    const prompt = promptOf(recs)
    if (prompt === undefined) { unmapped++; continue }
    if (!map.has(prompt)) map.set(prompt, { queue: [], last: undefined })
    map.get(prompt).queue.push(result)
  }
  return { map, total: order.length, unmapped }
}

/* ----------------------------- the replay ------------------------------- */
class CacheMiss extends Error {
  constructor(label) { super(`no journalled result for call "${label}"`); this.label = label }
}

const SNAPSHOT_TAG = 'ROADMAP-SNAPSHOT '

async function replay(entry, entryArgs, map) {
  let lastSnapshot = null
  // The FIRST miss is what matters, and it is recorded rather than merely thrown: the scripts wrap
  // most calls in their own `.catch()` (a dead agent is a fact they are built to survive), so a
  // thrown CacheMiss can be swallowed and the replay carry on down a path the live run never took.
  // Once a miss has happened, nothing after it is trustworthy — return value included.
  let firstMiss = null
  const log = (line) => {
    const s = String(line ?? '')
    if (s.startsWith(SNAPSHOT_TAG)) {
      try { lastSnapshot = JSON.parse(s.slice(SNAPSHOT_TAG.length)) } catch { /* a truncated snapshot is not state */ }
    }
  }
  const miss = (opts) => {
    const label = opts.label ?? '(unlabeled)'
    firstMiss = firstMiss ?? label
    return new CacheMiss(label)
  }
  const agent = async (prompt, opts = {}) => {
    const hit = map.get(prompt)
    if (!hit) throw miss(opts)
    // Consume in journal order; once the queue is spent, serve the last result again. Two calls
    // with a byte-identical (prompt, opts) are exactly what the platform's own cache collapses,
    // so repeating the answer is what the live run would have seen.
    if (hit.queue.length) hit.last = hit.queue.shift()
    else if (hit.last === undefined) throw miss(opts)
    return hit.last
  }
  const globals = (a) => ({
    args: a, agent, log, phase: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    workflow: async (ref, childArgs) => {
      const child = ref?.scriptPath ?? ref
      if (!child) throw new Error('replay: workflow() called without a scriptPath')
      return (await loadScript(child))(globals(childArgs))
    },
  })
  const runner = await loadScript(entry)
  let value
  let thrown
  try { value = await runner(globals(entryArgs)) } catch (e) { thrown = e }
  if (firstMiss) return { miss: firstMiss, lastSnapshot }
  if (thrown) throw thrown
  return { value, lastSnapshot }
}

/* ------------------------------ writers --------------------------------- */
const json = (v) => `${JSON.stringify(v, null, 2)}\n`

// Ensure exactly one marked section in a living document: replace its body if the marker is already
// there, else append the section at the end, separated by one blank line. `endRe` says where a
// section stops. The document is normalized to "no trailing whitespace, one final newline" on every
// pass, which is what makes this IDEMPOTENT — re-running the persister over the same run must be a
// no-op, or a root that persists twice (a crash, then a resume) doubles the ledger.
function upsertSection(doc, header, body, endRe) {
  const lines = doc ? doc.replace(/\s+$/, '').split('\n') : []
  const at = lines.findIndex((l) => l.trim() === header)
  const block = [header, ...body.split('\n')]
  if (at < 0) return `${[...lines, ...(lines.length ? [''] : []), ...block].join('\n')}\n`
  let end = at + 1
  while (end < lines.length && !endRe.test(lines[end])) end++
  const tail = lines.slice(end)
  return `${[...lines.slice(0, at), ...block, ...(tail.length ? [''] : []), ...tail].join('\n')}\n`
}

const readOr = async (file, fallback) => (existsSync(file) ? readFile(file, 'utf8') : fallback)

// The per-kind count summary of this run's degradations. A pure function of `degradations`, and it
// CANNOT grow with the row count (one line per distinct kind; the rows themselves are in the
// append-only .jsonl) — the property that stopped it eating the hand-written skill-feedback.md it
// once shared a file with.
function skillDegradationsDoc(degradations) {
  const byKind = new Map()
  for (const d of degradations) {
    const k = d.kind ?? 'unknown'
    if (!byKind.has(k)) byKind.set(k, { n: 0, last: '' })
    const e = byKind.get(k)
    e.n++
    e.last = `${d.label ?? 'agent'} (${d.script ?? '?'} · ${d.model ?? '?'} · wave ${d.wave ?? '?'})`
  }
  const rows = [...byKind].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([k, e]) => `| ${k} | ${e.n} | \`${e.last}\` |`)
  return '# Skill degradations — roadmap-orchestrator\n\n' +
    'MACHINE-WRITTEN — every `persist.mjs` run overwrites this file. Hand-written observations belong in ' +
    '`skill-feedback.md`, which the orchestrator never touches.\n\n' +
    'Defects in the ORCHESTRATOR itself (not the product) observed while running this arc. Carry this file and ' +
    '`.roadmap/degradations.jsonl` back to the skill\'s repository; they are not product debt and do not belong ' +
    `in debt.md.\n\n## This run: ${degradations.length} degradation(s)\n\n` +
    `| kind | count | most recent |\n|---|---|---|\n${rows.join('\n')}\n\n` +
    'Full rows — one JSON line per event, arc-cumulative — are in `.roadmap/degradations.jsonl`. Each names ' +
    'the agent label; find its transcript in the workflow\'s agent-*.jsonl to see the real error, which the ' +
    'platform does not expose to the script.\n'
}

/* -------------------------------- main ---------------------------------- */
const entryArgs = await parseArgs()
const roadmapDir = entryArgs.roadmapDir
if (!roadmapDir) die('args carries no roadmapDir — nothing to write to')
const { map, total, unmapped } = await buildMap(runDir)
console.log(`journal: ${total} result(s), ${map.size} distinct prompt(s)${unmapped ? `, ${unmapped} unmapped` : ''}`)

const { value, miss, lastSnapshot } = await replay(path.resolve(scriptPath), entryArgs, map)
await mkdir(roadmapDir, { recursive: true })
const wrote = []
const write = async (name, text) => { await writeFile(path.join(roadmapDir, name), text); wrote.push(name) }

if (miss) {
  // The replay stopped short of a return value. Everything the run decided after this point is
  // unreachable, so the ONLY honest output is the last snapshot the script logged.
  if (!lastSnapshot) die(`replay stopped at "${miss}" before the first snapshot — nothing to write; ` +
    'the existing state.json is left untouched. Relaunch with resumeFromRunId and run this again.')
  await write('state.json', json({ ...lastSnapshot, partial: { stoppedAt: miss } }))
  console.log(`PARTIAL stoppedAt=${miss} wrote=${wrote.join(',')}`)
  process.exit(2)
}

// Both entry points return the same things under different envelopes: the conductor wraps the final
// state in `state`, a directly-launched harness IS its wave state.
const ret = value ?? {}
const isConductor = ret.status === 'conductor-return'
const state = isConductor ? ret.state : (() => {
  const { degradations: _d, escalations: _e, ...rest } = ret
  return rest
})()
const degradations = ret.degradations ?? []
const escalations = ret.escalations ?? []
const debt = ret.debt ?? state?.debt ?? []
const debtSections = ret.debtSections ?? []
const journalEntries = ret.journalEntries ?? []

await write('state.json', json(state))

// plan.json — never blind. A plan on disk carrying unit ids this run has never seen is a root edit
// or a hand-merged respec, and overwriting it would destroy work with no trace. A loud refusal is
// the whole ask: no merge is attempted, because a wrong merge is worse than a refused one.
if (isConductor && ret.plan) {
  const planFile = path.join(roadmapDir, 'plan.json')
  let strangers = []
  if (existsSync(planFile)) {
    try {
      const onDisk = JSON.parse(await readFile(planFile, 'utf8'))
      const known = new Set((ret.plan.units ?? []).map((u) => u.id))
      strangers = (onDisk.units ?? []).map((u) => u.id).filter((id) => !known.has(id))
    } catch (e) {
      degradations.push({ script: 'persist', wave: state?.wave ?? 0, label: 'persist-plan', model: 'none',
        phase: 'Persist', kind: 'plan-conflict',
        what: `.roadmap/plan.json does not parse (${e.message}) — overwriting it with the run's merged plan` })
    }
  }
  if (strangers.length) {
    degradations.push({ script: 'persist', wave: state?.wave ?? 0, label: 'persist-plan', model: 'none',
      phase: 'Persist', kind: 'plan-conflict',
      what: `.roadmap/plan.json holds ${strangers.length} unit id(s) this run has never seen ` +
        `(${strangers.join(', ')}) — REFUSED to overwrite it; the root must merge the two plans by hand` })
    console.log(`PLAN-CONFLICT unknownUnits=${strangers.join(',')} — plan.json left as it was`)
  } else {
    await write('plan.json', json(ret.plan))
  }
}

if (debt.length) await write('debt.json', json({ wave: state?.wave ?? 0, items: debt }))

// The living debt ledger, file mode only (issue mode banks to roadmap:debt issues instead).
if (debtSections.length) {
  let doc = await readOr(path.join(roadmapDir, 'debt.md'), '')
  for (const { wave, body } of debtSections) doc = upsertSection(doc, `<!-- wave ${wave} -->`, body, /^<!-- wave \d+ -->$/)
  await write('debt.md', doc)
}

// The architect journal: tier-3 rationale the next fresh boundary agent inherits.
if (journalEntries.length) {
  let doc = await readOr(path.join(roadmapDir, 'architect-log.md'), '')
  for (const { wave, journal } of journalEntries) doc = upsertSection(doc, `## Wave ${wave}`, journal, /^## /)
  await write('architect-log.md', doc)
}

// Event ledgers: append-only, one JSON line per row, arc-cumulative. Appended LAST, and skipped when
// this run's block is ALREADY the tail of the file — a root that persists the same completed run
// twice (a crash, a resume, a re-run out of caution) must not double the ledger. Exact-tail rather
// than per-row dedupe: two genuinely identical events in one wave are possible, and dropping one of
// those would lose evidence.
const appendRows = async (name, rows) => {
  if (!rows.length) return
  const file = path.join(roadmapDir, name)
  const block = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
  if ((await readOr(file, '')).endsWith(block)) { wrote.push(`${name}(unchanged)`); return }
  await appendFile(file, block)
  wrote.push(`${name}(+${rows.length})`)
}
if (degradations.length) await write('skill-degradations.md', skillDegradationsDoc(degradations))
await appendRows('degradations.jsonl', degradations)
await appendRows('escalations.jsonl', escalations)

console.log(`OK ${isConductor ? `reason=${ret.reason} ` : ''}wave=${state?.wave ?? '?'} wrote=${wrote.join(',')}`)
