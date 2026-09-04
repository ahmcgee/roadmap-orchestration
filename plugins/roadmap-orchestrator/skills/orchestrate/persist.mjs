#!/usr/bin/env node
// persist.mjs — turn a finished (or crashed) Workflow run into the files under `.roadmap/`.
//
// WHY THIS EXISTS. A workflow script has no filesystem, so since the first version every byte it
// wanted on disk went through a model: a Haiku agent re-transcribed the whole of state.json at
// every checkpoint and every persist point, verified it by cksum, and sometimes lost it anyway. That was
// the second-largest model cost in the system after the root's own wakes, and it bought nothing but
// transport. The platform already journals every agent result, and the scripts are deterministic
// functions of (args, agent results, completion order) — so the run can simply be REPLAYED here, in
// a real Node process, at zero model cost, and its return value written out with `fs`. The journal
// supplies the completion order too: see "journal order is the clock" below.
//
//   node persist.mjs --run <workflowTranscriptDir> --script <harness.mjs|conductor.mjs>
//                    --args <envelope JSON string | path to a JSON file>
//   node persist.mjs --returned <path to a JSON file holding the run's RETURN VALUE>
//                    --args <envelope JSON string | path to a JSON file>
//
// `--run` is the directory holding `journal.jsonl` and the `agent-<id>.jsonl` transcripts; a nested
// `workflow()` child SHARES its parent's journal, so one directory covers a conductor run and every
// wave inside it. `--args` is the same envelope the root passed to Workflow, and is always required
// (it carries `roadmapDir`).
//
// THIS FILE NEVER CALLS A MODEL. Its `agent` is a lookup in the journal; a lookup that misses (the
// run crashed, or the script changed since the journal was written) stops the replay and writes the
// PARTIAL state from the last snapshot the script logged, marked `partial: {stoppedAt}`, so the root
// can relaunch with `resumeFromRunId` and run this again.
//
// A PARTIAL MUST NEVER REGRESS `state.json`. Two partials are worse than no write at all, and both
// are REFUSED — parked in `state.partial.json` beside it, with `state.json` untouched:
//   * `why=divergence`  — the miss is `(out of journal order)`, i.e. the replay asked for a record
//     the cursor had already passed. That is the REPLAY diverging, not the run failing: the live run
//     did not stop there, and its own state is further along than anything replayable here.
//     (wf 2026-09-02 wrote a wave-1 halt over a returned wave-3 state, and a relaunch from that file
//     would have re-forked every unit from the plan-pack tip.)
//   * `why=newer-on-disk` — `state.json` already on disk is a better record: a later wave, or the
//     same wave written whole (no `partial` marker).
// The cure for both is `--returned`: hand this the value the run actually returned (a conductor
// `{status:'conductor-return', …}` envelope or a directly-launched harness's wave state — the same
// two shapes a completed replay produces) and it skips the replay entirely, feeding that value
// through the normal writers. `--run`/`--script` are not needed then.
//
// Exit codes: 0 = complete, 2 = partial (written, or REFUSED and parked in state.partial.json),
// 1 = error (nothing written).
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
const returnedPath = flag('returned')
// `--returned` replaces the replay, so it replaces `--run`/`--script` too; `--args` is required
// either way, because `roadmapDir` is where every writer below points.
if (argsRaw === undefined || (!returnedPath && (!runDir || !scriptPath))) {
  console.error('usage: node persist.mjs --run <workflowTranscriptDir> --script <script.mjs> --args <json|file>\n' +
                '       node persist.mjs --returned <returnValue.json> --args <json|file>')
  process.exit(1)
}

const die = (msg) => { console.error(`persist: ${msg}`); process.exit(1) }

const parseArgs = async () => {
  const text = existsSync(argsRaw) ? await readFile(argsRaw, 'utf8') : argsRaw
  try { return JSON.parse(text) } catch (e) { die(`--args is neither a readable JSON file nor JSON: ${e.message}`) }
}

/* -------------------------- the journal, in order ------------------------ */
// The platform writes, per workflow run:
//   journal.jsonl        {"type":"started"|"result","key":"v2:<hash>","agentId":"<id>",["result":…]}
//   agent-<id>.jsonl     that agent's transcript; the FIRST `type:"user"` record's message.content
//                        is the prompt, verbatim
// `key` is an opaque hash of (prompt, opts) — it cannot be recomputed here, so the prompt is
// recovered from the transcript instead and the records are indexed on it. A `started` with no
// `result` is an agent that DIED, which is not an absence: agent() resolves to `null` there, a code
// path several scripts handle explicitly, so it is recorded as a null result rather than dropped.
//
// The RESULT RECORDS ARE KEPT IN JOURNAL ORDER — that is, in the order the live run's calls
// COMPLETED — because that order is the replay's clock; see "journal order is the clock" below.
const promptOf = (records) => {
  const first = records.find((r) => r?.type === 'user')
  const c = first?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((p) => p?.type === 'text').map((p) => p.text).join('')
  return undefined
}

async function buildJournal(dir) {
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
  const records = []        // [{ prompt, result }] in journal order; prompt null = unrecoverable
  const byPrompt = new Map()// prompt -> [index into records], ascending
  let unmapped = 0
  for (const { agentId, result } of order) {
    const f = `agent-${agentId}.jsonl`
    let prompt
    if (files.has(f)) {
      const recs = (await readFile(path.join(dir, f), 'utf8')).split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
      prompt = promptOf(recs)
    }
    // A record whose prompt cannot be recovered still OCCUPIES ITS SLOT in the order — no lookup can
    // ever ask for it, so the clock simply steps over it, but dropping it would shift every index
    // after it and silently rewrite the completion order.
    if (prompt === undefined) { unmapped++; records.push({ prompt: null, result }); continue }
    if (!byPrompt.has(prompt)) byPrompt.set(prompt, [])
    byPrompt.get(prompt).push(records.length)
    records.push({ prompt, result })
  }
  return { records, byPrompt, total: order.length, unmapped }
}

/* ----------------------------- the replay ------------------------------- */
class CacheMiss extends Error {
  constructor(label) { super(`no journalled result for call "${label}"`); this.label = label }
}

const SNAPSHOT_TAG = 'ROADMAP-SNAPSHOT '

async function replay(entry, entryArgs, { records, byPrompt }) {
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
  const miss = (opts, why = '') => {
    const label = `${opts.label ?? '(unlabeled)'}${why}`
    firstMiss = firstMiss ?? label
    return new CacheMiss(label)
  }

  /* ------------------------ journal order is the clock ---------------------
  // The scripts are deterministic functions of (args, agent results) only UP TO COMPLETION ORDER.
  // The harness merges units through one serial chain in the order their pipelines reach
  // merge-ready, and each merge moves `integrationTip`, which every later prompt embeds — so which
  // unit finishes first decides what the rest of the wave is asked. A replay that resolves every
  // lookup instantly races those pipelines in whatever order the event loop happens to pick; in
  // wf_318afa1b-e9d that reversed two wave-2 merges, the tip diverged from the live run's, and the
  // next prompt missed. The platform's journal is written in COMPLETION order, so it is the missing
  // clock: a lookup for prompt P resolves only when the cursor reaches P's record, every earlier
  // record having been consumed by its own lookup first. Pending lookups wait, and the script's
  // concurrency therefore unfolds exactly as it did live. A nested `workflow()` child shares the
  // journal and so shares this one cursor.
  //
  // Four rules make that total:
  //  1. A lookup CLAIMS the earliest unclaimed record for its prompt at or after the cursor, then
  //     waits for the cursor to reach it. Two concurrent lookups for the same prompt claim
  //     different records, in issue order.
  //  2. A record NOTHING ASKED FOR must never stall the clock: when the run is quiescent (every
  //     microtask the script could take has been taken) and no pending lookup wants the record at
  //     the cursor, the cursor steps over it. That is a prior launch's superseded prompt (this run
  //     was a resume), an agent whose transcript carries no recoverable prompt, or a `started`
  //     whose null result no live call ever consumed.
  //  3. A lookup for a prompt whose only records were already stepped over is a REAL DIVERGENCE —
  //     the replay's control flow reached a call the live run did not make there — and is a miss
  //     marked `(out of journal order)`, never a silent reorder.
  //  4. A prompt whose records are all claimed is the platform's own cache collapsing a
  //     byte-identical repeat into one call: the last record is echoed, consuming nothing, once
  //     the cursor has passed it.
  ------------------------------------------------------------------------ */
  let cursor = 0
  const claimed = new Set()   // record indices some lookup has taken
  const pending = []          // [{ index, echo, resolve, reject, opts }]
  let ticking = false
  const settle = () => new Promise((r) => setImmediate(r))

  // Serve at most one waiter the cursor has reached; `true` if the clock moved.
  const serveOne = () => {
    const e = pending.findIndex((w) => w.echo && w.index < cursor)
    if (e >= 0) { const [w] = pending.splice(e, 1); w.resolve(records[w.index].result); return true }
    const c = pending.findIndex((w) => !w.echo && w.index === cursor)
    if (c >= 0) { const [w] = pending.splice(c, 1); cursor++; w.resolve(records[w.index].result); return true }
    return false
  }

  const tick = () => {
    if (ticking) return
    ticking = true
    void (async () => {
      try {
        for (;;) {
          await settle()                 // every step the script can take without us, it takes now
          if (serveOne()) continue
          if (!pending.length) return    // nothing is waiting on the journal — the script drives
          // A pending lookup always holds its own record against the cursor, so the cursor cannot
          // run off the end while one waits. If it somehow does, fail the waiters loudly rather
          // than hanging the process on a clock that can no longer move.
          if (cursor >= records.length) {
            for (const w of pending.splice(0)) w.reject(miss(w.opts, ' (journal exhausted)'))
            return
          }
          cursor++                       // quiescent, and nothing asked for this record: step over
        }
      } finally { ticking = false }
    })()
  }

  const agent = async (prompt, opts = {}) => {
    const idxs = byPrompt.get(prompt)
    if (!idxs) throw miss(opts)
    const next = idxs.find((i) => i >= cursor && !claimed.has(i))
    if (next === undefined && idxs.some((i) => !claimed.has(i))) throw miss(opts, ' (out of journal order)')
    if (next !== undefined) claimed.add(next)
    const index = next ?? idxs[idxs.length - 1]
    return new Promise((resolve, reject) => {
      pending.push({ index, echo: next === undefined, resolve, reject, opts })
      tick()
    })
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
  // A THROW is the other way a replay ends short of a return value, and it is not exotic: the
  // scripts fail loudly on conditions that should not happen (a malformed plan, a cycle), and the
  // journal of a crashed run replays straight back into the same throw. Dying with an uncaught
  // exception here loses everything the run did decide; the last snapshot is still the honest
  // answer, exactly as for a cache miss. `thrown.label` is carried when the error names a call.
  if (thrown) return { thrown, lastSnapshot }
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

// Is the `state.json` already on disk a BETTER record than this partial snapshot? A later wave is,
// and so is the same wave written WHOLE (no `partial` marker) — either way writing the partial over
// it would regress the arc. A file that is absent, or that does not parse, is no record at all and
// never blocks the write: there is nothing there to lose.
const diskOutranksSnapshot = async (file, snapshot) => {
  if (!existsSync(file)) return false
  let onDisk
  try { onDisk = JSON.parse(await readFile(file, 'utf8')) } catch { return false }
  if (!Number.isFinite(onDisk?.wave) || !Number.isFinite(snapshot?.wave)) return false
  if (onDisk.wave > snapshot.wave) return true
  return onDisk.wave === snapshot.wave && !onDisk.partial
}

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
// The run's returned value, either handed to us directly (`--returned`) or reconstructed by
// replaying the journal. Directly is the honest answer whenever the replay cannot reach the end:
// the root has the real return value in the task output, and no prefix of a replay beats it.
let value, miss, thrown, lastSnapshot
if (returnedPath) {
  if (!existsSync(returnedPath)) die(`--returned ${returnedPath} does not exist`)
  try { value = JSON.parse(await readFile(returnedPath, 'utf8')) }
  catch (e) { die(`--returned ${returnedPath} is not readable JSON: ${e.message}`) }
  console.log(`returned: ${returnedPath} — replay skipped`)
} else {
  const journal = await buildJournal(runDir)
  console.log(`journal: ${journal.total} result(s), ${journal.byPrompt.size} distinct prompt(s)` +
    `${journal.unmapped ? `, ${journal.unmapped} unmapped` : ''}`)
  ;({ value, miss, thrown, lastSnapshot } = await replay(path.resolve(scriptPath), entryArgs, journal))
}
await mkdir(roadmapDir, { recursive: true })
const wrote = []
const write = async (name, text) => { await writeFile(path.join(roadmapDir, name), text); wrote.push(name) }

if (miss || thrown) {
  // The replay stopped short of a return value — the journal ran out, or the script threw.
  // Everything the run decided after this point is unreachable, so the ONLY honest output is the
  // last snapshot the script logged.
  const stoppedAt = miss ?? thrown.label ?? 'script-error'
  const error = thrown ? String(thrown.message ?? thrown) : undefined
  if (!lastSnapshot) die(`replay stopped at "${stoppedAt}" before the first snapshot — nothing to write; ` +
    `${error ? `the error was: ${error}. ` : ''}` +
    'the existing state.json is left untouched. Relaunch with resumeFromRunId and run this again.')
  const partial = json({ ...lastSnapshot, partial: { stoppedAt, ...(error ? { error } : {}) } })

  // A partial may never REGRESS state.json — see the header. `(out of journal order)` says the
  // replay diverged from the run (the run itself did not stop there), and a newer state.json says
  // disk already holds a better record; in both cases the partial is parked beside state.json
  // instead of over it.
  const why = /\(out of journal order\)$/.test(stoppedAt) ? 'divergence'
    : (await diskOutranksSnapshot(path.join(roadmapDir, 'state.json'), lastSnapshot)) ? 'newer-on-disk'
    : null
  if (why) {
    await write('state.partial.json', partial)
    console.log(`PARTIAL-REFUSED stoppedAt=${stoppedAt} why=${why} wrote=${wrote.join(',')}` +
      `${error ? ` error=${error}` : ''}`)
    console.log('state.json was NOT written. Persist the run\'s returned value instead — ' +
      'node persist.mjs --returned <that value as JSON> --args <the same envelope> — ' +
      'then investigate the divergence.')
    process.exit(2)
  }

  await write('state.json', partial)
  console.log(`PARTIAL stoppedAt=${stoppedAt} wrote=${wrote.join(',')}${error ? ` error=${error}` : ''}`)
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
