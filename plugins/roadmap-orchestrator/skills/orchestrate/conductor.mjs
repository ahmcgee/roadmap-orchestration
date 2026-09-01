export const meta = {
  name: 'roadmap-conductor',
  description: 'Loop multiple roadmap waves in one run, routing each boundary through a tiered triage ladder',
  phases: [
    { title: 'Wave', detail: 'dispatch one wave via the harness workflow' },
    { title: 'Census', detail: 'feedback + quarantine folder census (Haiku)' },
    { title: 'Triage-opus', detail: 'tier-2 boundary triage (Opus)' },
    { title: 'Triage-fable', detail: 'tier-3 boundary agent + quarantine respec (Fable)' },
    { title: 'Spec-expand', detail: 'render new-unit skeletons to specs (Sonnet)' },
    { title: 'Persist', detail: 'plan/debt/log/feedback/state writers (Haiku)' },
  ],
}

/* ------------------------------------------------------------------------
 * conductor.mjs — a top-level Workflow script that runs the arc's waves in a
 * single launch, so the root wakes once per RUN instead of once per boundary
 * (each wake is an uncached full-history reload past the 5-min prompt-cache TTL).
 *
 * Runtime is identical to harness.mjs: globals `args, agent, workflow, log,
 * phase, budget`; NO filesystem, NO Date.now/Math.random. It consumes the one
 * allowed workflow-nesting level (conductor -> harness); the harness stays
 * leaf-only. Idioms are mirrored from harness.mjs deliberately:
 *   - defensive stringified-args parse (a stringified args object makes every
 *     destructured field undefined and agents improvise in their cwd);
 *   - obj/arr/oneOf schema helpers, additionalProperties:false, maxLength caps,
 *     and a `notes` pressure-release on tight schemas;
 *   - the STRICT fail-loud location preamble for mechanical writers;
 *   - run(), a thin agent() wrapper that pins model+schema, tallies per-tier
 *     spend, and retries ONCE on a StructuredOutput validation failure;
 *   - deterministic prompts: pure functions of the wave number, unit ids, shas,
 *     and the JSON of in-memory structured data, so resumeFromRunId replays
 *     completed calls (both this script's and the child harness's) for free.
 *
 * Inputs: args = { plan, state, config, harnessPath }. The root MUST pass
 * `harnessPath` (absolute path to harness.mjs). `config` is the caller's raw
 * config and is threaded to the harness UNTOUCHED (the conductor never sets
 * boundary:'off' itself — ruling 1). Conductor knobs live under
 * plan.config.conductor / config.conductor; the harness ignores unknown keys.
 * ---------------------------------------------------------------------- */

// args can arrive JSON-stringified depending on how the caller encoded them — tolerate both.
const A = typeof args === 'string' ? JSON.parse(args) : args
// `launchId` is a per-launch nonce the root regenerates on every launch AND every resume; it is
// passed straight through to each wave so the harness can salt its ENVIRONMENT probes out of
// resumeFromRunId's cache (harness.mjs, LAUNCH). The conductor never reads it — pure passthrough.
const { plan: inPlan, state: inState, config: overrides, harnessPath, launchId } = A
// harnessPath is not optional — the wave dispatch cannot resolve the child script without it.
if (!harnessPath)
  throw new Error('conductor requires args.harnessPath (absolute path to harness.mjs) — the root must pass it')

// Conductor config: defaults, then plan.config.conductor, then the caller's config.conductor.
const CC = {
  maxWavesPerRun: 3,           // wave-loop bound; exhaustion -> max-waves (a fresh relaunch resets the 1000-agent counter)
  boundaryTriage: 'opus-first', // 'opus-first' full ladder | 'always-fable' skip Opus | 'root' every boundary returns
  agentBudgetReserve: 200,     // headroom below the 1000-call cap; the pre-wave guard returns before crossing
  perUnitCallEstimate: 15,     // pre-wave budget estimate per dispatchable unit; corrected by harness spend deltas
  fixUnitAdmit: 'auto',        // 'auto' tier-1 mechanical admit of health drafts | 'triage' force >=Opus veto when drafts present
  // 'open' | 'closed'. The architect flips this to 'closed' once the plan is DRAINED. Under
  // 'closed' tiers 1 and 2 admit NOTHING: drafts and promotions become debt-ledger lines, in CODE,
  // not by asking a triager nicely. Arc-observed: after PLAN DRAINED at wave 17, waves 18 and 19
  // kept admitting 7 and 8 fresh drafts, so the merged fraction sat at ~93% for 12+ hours while the
  // denominator grew in lockstep. Every other brake in this file is prose an Opus turn can
  // rationalise past; this one is not. The single exception is a finding graded `blocker`, which is
  // routed to the architect tier to be RULED on rather than auto-admitted.
  admissions: 'open',
  // Tier 1 admits health/design drafts mechanically, with no judgment and no cut line applied. That
  // is acceptable for a trickle and not for a batch: a healthy assessor drafts something every wave,
  // so a large batch is exactly the denominator growth above, arriving without anyone deciding. Past
  // this count the wave buys an Opus triage instead, which does apply the cut line.
  tier1MaxDrafts: 3,
  fableEffort: 'high',         // effort for the Fable boundary agent (respec/escalation arbiter) — Fable 5's high default for real adjudication
  opusEffort: 'medium',        // effort for the Opus tier-2 triager — mirrors the harness's opusEffort knob
  ...(inPlan.config?.conductor ?? {}),
  ...(overrides?.conductor ?? {}),
}

const repo = inPlan.repoPath   // absolute path to the repository (agents read .roadmap/ here)

// GitHub issue projection (issue mode only; reference.md "GitHub issue tracking"). Mirrors harness.mjs:
// issues are a Haiku-written projection of state, never read by this script's routing. Every gh clause
// below is '' in file mode, keeping those prompts byte-identical to the legacy path. Best-effort: a gh
// failure records a `gh-sync` degradation and continues.
const issueMode = inPlan.tracking === 'issues'
const ghRepo = inPlan.repoSlug ? `--repo ${inPlan.repoSlug} ` : ''
const GH_BEST_EFFORT = 'Do the GitHub-issue steps below on a BEST-EFFORT basis: if any gh command errors (no ' +
  'network, auth, rate limit, missing issue), ignore it and carry on — issue state is observability, never a gate. '
// Find-or-create by BODY MARKER, made mechanical. `--search '"<marker>" in:body'` is GitHub
// FULL-TEXT search: it tokenizes the marker, so `id=raise-verbs` matched an unrelated open agenda
// issue, `id=sweep-truth` a closed unit from a prior arc, and a Phase-0 bootstrap "reused" three
// live issues — overwriting title and body, swapping status:merged for status:pending, moving them
// into the new milestone (2026-08-22; 8 of 11 mis-resolved again on 2026-08-23). A hit is therefore
// a CANDIDATE ONLY, and the exactness test belongs in the shell string THIS SCRIPT composes rather
// than in model compliance: the jq predicate below requires the candidate body's FIRST LINE to be
// exactly the marker comment. Prints `<number> <OPEN|CLOSED>` for the one exact match, or nothing.
// Duplicated across harness.mjs and conductor.mjs (neither can import the other) — keep them in
// sync; shared-consts.test.mjs fails the build if they drift.
const markerFind = (marker) => `gh issue list ${ghRepo}--search '"${marker}" in:body' --state all --limit 30 ` +
  `--json number,body,state --jq '[.[] | select(((.body // "") | split("\\n")[0] | sub("\\r$"; "")) == ` +
  `"<!-- ${marker} -->")] | .[0] | select(. != null) | "\\(.number) \\(.state)"'`
// The obligations that ride with every markerFind. Duplicated in both scripts — keep them in sync.
const MARKER_RULE = 'Run that search command EXACTLY as written: its jq predicate is what makes the match ' +
  'trustworthy, requiring the candidate body\'s FIRST line to be exactly the marker comment. Never widen the ' +
  'search, never fall back to `.[0].number`, and never adopt an issue you found some other way — no exact ' +
  'match means ABSENT, and absent means create. Never edit the labels, milestone, title or body of a CLOSED ' +
  'issue, and never remove a `status:merged` label. '
// The arc key every marker this script mints is scoped by. Without it, `roadmap:debt wave=3 ledger`
// searched across ARCS and matched a prior arc's wave 3 (#1011), which would have silently skipped
// creation; the per-unit `wave=N unit=<id>` marker collides the same way whenever a unit id recurs.
const arcKey = inPlan.trackingIssue ?? inPlan.milestone
// Admissions, enforced in code (not in a prompt an Opus turn can rationalise past). `closed`
// never routes work AWAY from judgment — it only stops judgment from minting units — so it can
// never weaken the termination guarantee. Read by the tier router and by collect()'s bank.
const admissionsClosed = CC.admissions === 'closed'

// Working plan — cloned so wave-to-wave mutation (merged units, edges, cut lines) never aliases
// the caller's object. This is what is persisted and returned; the transient contingent
// withholding below dispatches a SEPARATE copy so a withheld inScope:false is never mistaken
// for a root decision (ruling 2).
let plan = {
  ...inPlan,
  units: (inPlan.units ?? []).map((u) => ({ ...u })),
  edges: (inPlan.edges ?? []).map((e) => ({ ...e })),
}
let state = inState
let wavesRun = 0
// conductor block, checkpointed into state.json every boundary + before every return: forensics
// spine + rung-3 recovery signal. reason is null while in flight, the frozen reason on return.
// `boundaries` is ARC-cumulative (seeded from the passed state's conductor block, same semantics
// as the harness's spend tally): a root adjudication mid-arc relaunches the conductor, and
// without seeding, each relaunch would erase the prior runs' boundary forensics.
const boundaries = (inState.conductor?.boundaries ?? []).map((b) => ({ ...b }))   // [{ wave, tier, escalated: <reason|null> }]
// Last wave's boundary evidence, kept for the max-waves return. Ruling 1 gives the root the final
// wave's evidence on any TERMINAL return, and max-waves is terminal — but it is the one terminal
// return the conductor cannot see coming: every other path returns before the persist step, whereas
// max-waves only becomes terminal after the loop has already triaged the wave and cleared its
// boundary as a continuation. Eval-observed 2026-07-19: a 3-wave run returned max-waves with no
// boundary block at all, so the root relaunching had nothing to read.
let lastBoundary = null
let lastBoundaryWave = null

/* --------------------------- spend accounting -------------------------- */
// Per-tier tally of THIS script's own agent() calls, plus the two conductor-specific counters.
// Merged into the returned/persisted state's arc-cumulative `spend` so the session report sees
// where conductor attention went; a watermark (cMerged) makes the merge idempotent across the
// several persist points so threaded-forward spend is never double-counted.
const cSpend = { fable: 0, opus: 0, sonnet: 0, haiku: 0, boundaryTriages: 0, boundaryFables: 0 }
let cMerged = { ...cSpend }
// Budget arithmetic counts MODEL-TIER keys only: spend also carries derived counters
// (planChecks, gateRounds, boundaryTriages, …) that subset the tier counts — summing
// everything double-counts each gate/check round and trips the guard early.
const TIER_KEYS = ['fable', 'opus', 'sonnet', 'haiku']
const sumTiers = (o) => TIER_KEYS.reduce((a, k) => a + (typeof o?.[k] === 'number' && Number.isFinite(o[k]) ? o[k] : 0), 0)
const initialSpend = { ...(inState.spend ?? {}) }
const initialSpendTotal = sumTiers(initialSpend)
// Add only the conductor spend accrued since the last merge onto st.spend (idempotent).
function mergeConductorSpend(st) {
  st.spend = { ...(st.spend ?? {}) }
  for (const k of Object.keys(cSpend)) {
    const delta = cSpend[k] - (cMerged[k] ?? 0)
    if (delta) st.spend[k] = (st.spend[k] ?? 0) + delta
  }
  cMerged = { ...cSpend }
}
const deltaSpend = (sp) => {
  const d = {}
  for (const k of new Set([...Object.keys(initialSpend), ...Object.keys(sp ?? {})])) {
    const v = (sp?.[k] ?? 0) - (initialSpend[k] ?? 0)
    if (typeof v === 'number' && v !== 0) d[k] = v
  }
  return d
}

// Debt the conductor has RECEIVED but not yet seen banked. Two reasons it cannot live in
// `state.debt` alone: the harness rebuilds that field from scratch every wave (so an unbanked item
// evaporates at the next dispatch), and the clear used to happen BEFORE the bank call with its
// result never inspected — arc-observed, 23 items vanished at one wave-12 boundary.
let pendingDebt = []
// plan.json held unit ids this run never saw, so persist-plan REFUSED to overwrite it. Surfaced on
// the return envelope: the root merges by hand. No automatic merge — a wrong merge is worse than a
// refused one.
const planConflicts = []
// Skill-defect ledger — the orchestrator misbehaving, not the product (same idiom as harness.mjs).
// THIS RUN's rows only: the conductor's own plus whatever the child harness returns. The ARC's
// record is the append-only .roadmap/degradations.jsonl sidecar, written once at the event; nothing
// re-transcribes it and it never rides in state.json (carrying it there is what made every
// checkpoint bigger than the last). What is kept here feeds the return envelope and the summary.
const degradations = []
const degrade = (o) => {
  const row = { script: 'conductor', wave: state?.wave ?? 0, ...o }
  degradations.push(row)
  sidecarAppend('degradations', row)
  log(`DEGRADED [${o.label ?? 'agent'} · ${o.model}] ${o.what}`)
}

// One code-level retry on structured-output failure — identical idiom to harness.mjs's run():
// agents deep in tool-work occasionally end a turn without a valid structured report; a single
// retry with an explicit report-last instruction converts a flake into an occasional double call.
const run = async (prompt, opts) => {
  cSpend[opts.model] = (cSpend[opts.model] ?? 0) + 1
  try { return await agent(prompt, opts) }
  catch (e) {
    if (!String(e?.message ?? e).includes('StructuredOutput')) throw e
    cSpend[opts.model] = (cSpend[opts.model] ?? 0) + 1
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'schema-retry',
      what: `structured output rejected, retrying — ${String(e?.message ?? e).slice(0, 200)}` })
    return agent(
      prompt + ' IMPORTANT: your previous structured report was REJECTED. Emit exactly the requested schema and ' +
      'no other keys — an unexpected key is rejected as hard as an over-long one. Cut every free-text field ' +
      'hard; keep only what the structured fields cannot carry. Do not redo the task.',
      { ...opts, label: `${opts.label ?? 'agent'}#retry` })
  }
}

// agent() RESOLVES TO null (it does NOT throw) when a subagent dies — a terminal API error, OR its
// own schema-retries exhausted. A bare `.catch()` does not cover that path, and neither does run()'s
// StructuredOutput retry, which only fires on a THROW: arc-observed, the tier-2 triager overran a
// 600-char `notes` cap, burned its retries inside the subagent, resolved null, and run()'s
// shorten-aggressively rescue — written for exactly this — never fired once.
// So runOr() re-runs that rescue itself on a null, then falls back. EVERY run() whose result is
// dereferenced must funnel through it: `fallback` (never null) is what keeps a dead agent from
// becoming a dead arc.
const runOr = async (fallback, prompt, opts) => {
  const r = await run(prompt, opts).catch((e) => {
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'threw',
      what: `threw — ${String(e?.message ?? e).slice(0, 200)}` })
    return null
  })
  if (r) return r
  // The null carries NO error object — the platform does not expose the cause. Record what we know
  // and name the transcript, so the next person is not left guessing "network?" for three runs.
  degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'no-report',
    what: 'agent died without a report (agent() returned null — cause not exposed by the platform); ' +
      'salvaging once, then falling back. Read the agent transcript for the real error.' })
  const retried = await run(
    prompt + ' IMPORTANT: your previous report was rejected — most likely a free-text field exceeded ' +
    'its maximum length. Shorten EVERY free-text field aggressively; one sentence each is acceptable, ' +
    'and `notes` is the first thing to cut. Emit exactly the requested schema and no other fields.',
    { ...opts, label: `${opts.label ?? 'agent'}#salvage` },
  ).catch(() => null)
  if (!retried)
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'salvage-failed',
      what: 'salvage retry also produced no report — degrading to the coded fallback' })
  return retried ?? fallback
}

// Location discipline for mechanical writers (copied from harness.mjs): given a bad path,
// Haiku will improvise in its cwd and report plausible success — fail-loud beats adaptive.
const STRICT = 'Start by `cd` to the exact absolute path named in this task — if the cd fails, report ok/pass as ' +
  'false with the exact error and stop. Then confirm the directory is a git checkout MECHANICALLY, with ' +
  '`git rev-parse --git-dir`: a NON-ZERO exit is the only failure. A LINKED WORKTREE IS VALID — its `.git` is a ' +
  'FILE and the command prints a path under `.git/worktrees/`, which is not a defect and must never be reported ' +
  'as one. Never substitute your current working directory, the enclosing project, or any other repository. '
// EVERY prompt whose schema carries a maxLength must also carry this (same const as harness.mjs).
// A cap is a contract with the model, and the prompt is the only place that contract is stated — a
// capped field with no matching instruction is a trap. Arc-observed: this prompt set had a 600-char
// `notes` cap, no terseness clause, and a closing line inviting the agent to put overflow THERE. It
// overran, exhausted its schema-retries, and died at two consecutive boundaries. See RATIONALE §9.
const TERSE = 'Keep every free-text field terse — an oversized report fails schema validation and the work is ' +
  'lost. Free-text fields are for what the structured fields cannot carry, not a transcript of your reasoning. ' +
  'Respect every character budget named below exactly, and emit no field the schema does not define — an ' +
  'unexpected key is rejected as hard as an over-long one. '
// Verbatim-write prompts for a large JSON payload — mirrored from harness.mjs (keep in sync;
// shared-consts.test.mjs enforces it). A single write's content is echoed as agent OUTPUT and one
// response caps at ~32k output tokens; below WRITE_CHUNK one writer copies the document through a
// quoted here-doc, above it the payload is split deterministically and FANNED OUT — one Haiku
// writer per part (`<path>.partK`) and one assembler (runVerbatim). Every writer verifies its file
// by `cksum` (in-script cksumOf), not byte count — a byte count was gamed live (un-escaped values,
// tail padded to the expected size, ok:true, unparseable state.json).
const WRITE_CHUNK = 24000
// POSIX cksum: CRC-32 (poly 0x04C11DB7, MSB-first, init 0), then the byte length fed in
// little-endian until zero, then complemented. Pure JS over UTF-8 code units, no Buffer.
const CK_TABLE = (() => {
  const t = new Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04C11DB7) : (c << 1)
    t[i] = c >>> 0
  }
  return t
})()
const cksumOf = (s) => {
  let crc = 0, len = 0
  const feed = (b) => { crc = ((crc << 8) ^ CK_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0; len++ }
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c < 0x80) feed(c)
    else if (c < 0x800) { feed(0xc0 | (c >> 6)); feed(0x80 | (c & 63)) }
    else if (c < 0x10000) { feed(0xe0 | (c >> 12)); feed(0x80 | ((c >> 6) & 63)); feed(0x80 | (c & 63)) }
    else { feed(0xf0 | (c >> 18)); feed(0x80 | ((c >> 12) & 63)); feed(0x80 | ((c >> 6) & 63)); feed(0x80 | (c & 63)) }
  }
  const bytes = len
  for (let l = bytes; l > 0; l >>>= 8) crc = ((crc << 8) ^ CK_TABLE[((crc >>> 24) ^ (l & 0xff)) & 0xff]) >>> 0
  return { crc: (~crc) >>> 0, bytes }
}
const writeVerbatim = (path, text, extra = '') => {
  // Every writer (single, part, assembler) verifies its file by CONTENT HASH — `cksum` (POSIX,
  // coreutils, present in every sandbox) prints `<crc> <bytes>` for stdin — computed here by
  // cksumOf. Byte count alone was gamed live: a part-writer un-escaped `\"`/`\\` inside string
  // values (losing bytes) and then PADDED the tail with lines copied from the next record until
  // the count matched, reporting ok:true; the assembled state.json did not parse. A CRC cannot be
  // iterated toward, so the writer's only honest move on a mismatch is to report it.
  const check = (file, ck) => `Then verify: \`cksum < ${file}\` must print exactly \`${ck.crc} ${ck.bytes}\`; if it ` +
    `prints anything else, report ok:false with the observed output in detail. NEVER edit, pad, trim, or rewrite the ` +
    `file to make the numbers match — a mismatch is reported, not repaired (padding to hit the count once produced an ` +
    `unparseable state.json). Retry the write at most once.`
  // Shared body of the copy instruction: a quoted here-doc in ONE Bash call, because a file-write
  // tool re-interprets escapes (arc-observed: `\"` → `"` inside JSON string values).
  const copy = (file, what) => `never repair, reformat, re-indent, or re-escape anything (escape sequences such as \\n ` +
    `and \\" inside JSON string values are literal characters to copy, not instructions). Write it in ONE Bash tool ` +
    `call through a single-quoted here-doc so the shell interprets nothing — never echo, printf, or a file-write/edit ` +
    `tool (a file-write tool re-interprets escapes): run \`cat > ${file} <<'ROADMAP_PART'\` followed by ${what} ` +
    `and a closing \`ROADMAP_PART\` line.`
  if (text.length <= WRITE_CHUNK) {
    const ck = cksumOf(`${text}\n`)   // the here-doc leaves one trailing newline
    return {
      single: `Write the file ${path} so its content is EXACTLY the JSON document below, and nothing else${extra} — ` +
        `${copy(path, "the document's lines")} The document is every line after the <<<DOCUMENT>>> marker line to the ` +
        `end of this message, excluding the marker line. ${check(path, ck)}\n<<<DOCUMENT>>>\n${text}`,
    }
  }
  // Split on line boundaries so a part is an exact run of whole lines (pretty-printed JSON keeps
  // every line far below the chunk size — free-text caps bound the longest value). Every part file
  // ends in the newline its here-doc leaves, so a plain `cat` of the part files, in order, IS the
  // document (plus one trailing newline — the same shape the single write leaves).
  const parts = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > WRITE_CHUNK) { parts.push(cur); cur = line }
    else cur = cur ? `${cur}\n${line}` : line
  }
  if (cur) parts.push(cur)
  const n = parts.length
  const partPath = (k) => `${path}.part${k}`
  const cks = parts.map((p) => cksumOf(`${p}\n`))   // each part file: its text + the here-doc's newline
  const whole = cksumOf(`${text}\n`)                // the cat of the parts, in order
  return {
    parts: parts.map((p, i) => ({
      k: i + 1,
      prompt: `Write the file ${partPath(i + 1)} so its content is EXACTLY part ${i + 1} of ${n} below, and nothing ` +
        `else${extra}. It is a mechanical slice of one JSON document on line boundaries — ` +
        `${copy(partPath(i + 1), "the part's lines")} The part's content is every line after the ` +
        `<<<PART ${i + 1}/${n}>>> marker line to the end of this message, excluding the marker line. ` +
        `${check(partPath(i + 1), cks[i])}\n<<<PART ${i + 1}/${n}>>>\n${p}`,
    })),
    assemble: `Assemble ${path} from its ${n} staged part files, which are already written and cksum-verified${extra}: ` +
      `run \`cat ${parts.map((_, i) => partPath(i + 1)).join(' ')} > ${path}\` in exactly that order — never open, ` +
      `edit, or reformat any of them. ${check(path, whole)} On a mismatch leave the part files in place. On success ` +
      `run \`rm -f ${path}.part*\` (the glob also clears stale parts left by an earlier fan-out with a different ` +
      `part count) and report ok:true.`,
  }
}
// Execute a writeVerbatim plan. A single prompt is one run. A fan-out is one Haiku writer per part
// in `parallel` (each echoes ~WRITE_CHUNK of output — the shape that fits one response), then ONE
// assembler, dispatched only when every part landed: a failed part means no assembly, so the file on
// disk stays the previous complete document rather than becoming a partial. A part that fails is
// re-run ONCE, by a fresh agent (`<label>:partK#retry`), before that verdict: a mis-transcription is
// per-sample stochastic, not per-part (live: 2 of 16 part writes mis-transcribed, caught by cksum;
// a fresh sample of the same part succeeded), and with five parts a checkpoint that dies on any one
// first-try loss dies far too often. The assembler is never retried — a bad `cat` is not
// stochastic. `prefix` is prepended to every prompt (the conductor's STRICT). Resolves { ok, detail }
// and never throws — `detail` names the part(s) that failed BOTH attempts (with the retry's reason)
// or the assembler. Mirrored in both scripts.
const runVerbatim = async (plan, opts, prefix = '') => {
  const call = (prompt, label) => run(prefix + prompt, { ...opts, label })
    .then((r) => (r?.ok ? { ok: true }   // covers agent-died-null and an explicit ok:false alike
      : { ok: false, detail: r ? String(r.detail ?? 'ok:false').slice(0, 200) : 'agent died without a report' }))
    .catch((e) => ({ ok: false, detail: String(e?.message ?? e).slice(0, 200) }))
  if (plan.single) return call(plan.single, opts.label)
  const results = await parallel(plan.parts.map((p) => () => call(p.prompt, `${opts.label}:part${p.k}`)))
  const lost = plan.parts.filter((_, i) => !results[i]?.ok)
  const retried = await parallel(lost.map((p) => () => call(p.prompt, `${opts.label}:part${p.k}#retry`)))
  const failed = lost
    .map((p, i) => (retried[i]?.ok ? null : `part ${p.k}/${plan.parts.length}: ${retried[i]?.detail ?? 'writer died'}`))
    .filter(Boolean)
  if (failed.length) return { ok: false, detail: `${failed.join('; ')} — assembly skipped, previous file left intact` }
  const a = await call(plan.assemble, `${opts.label}:assemble`)
  return a.ok ? a : { ok: false, detail: `assemble: ${a.detail}` }
}
// Append-only sidecar write: ONE `>>` here-doc, verified by cksum over the file's TAIL. A sidecar is
// arc-cumulative and lives only on disk, so the script can never know the whole file — but it knows
// exactly the bytes it is appending, and `tail -c <bytes>` isolates them, so the same content hash
// that guards a whole-file write guards an append. Mirrored in both scripts — keep the two in sync
// (shared-consts.test.mjs enforces it).
const appendVerbatim = (path, text) => {
  const ck = cksumOf(`${text}\n`)
  return `Append to the file ${path} (create it if it is missing) EXACTLY the lines below and nothing else. ` +
    `NEVER read, rewrite, reorder, deduplicate, sort or truncate what is already in the file: it is append-only ` +
    `and everything already in it is another agent's record. Append in ONE Bash tool call through a ` +
    `single-quoted here-doc so the shell interprets nothing — never echo, printf, or a file-write/edit tool (a ` +
    `file-write tool re-interprets escapes; escape sequences such as \\n and \\" inside JSON string values are ` +
    `literal characters to copy, not instructions): run \`cat >> ${path} <<'ROADMAP_APPEND'\` followed by the ` +
    `lines and a closing \`ROADMAP_APPEND\` line. Then verify: \`tail -c ${ck.bytes} ${path} | cksum\` must ` +
    `print exactly \`${ck.crc} ${ck.bytes}\`; if it prints anything else, report ok:false with the observed ` +
    `output in detail. NEVER edit, pad, trim, or rewrite the file to make the numbers match — a mismatch is ` +
    `reported, not repaired. Retry the append at most once. The lines are every line after the <<<APPEND>>> ` +
    `marker line to the end of this message, excluding the marker line.\n<<<APPEND>>>\n${text}`
}
// Agent-authored report text can carry raw control characters (an explorer's `repro` string quoting
// a \x01 test input, arc-observed). JSON.stringify escapes those correctly — but every file here is
// written by a Haiku agent TRANSCRIBING the document, and the transcription decodes the escape back
// into a raw byte, producing a document no JSON parser will read. A control character in a
// human-readable report is never load-bearing, so it is replaced with a printable token BEFORE
// serialization, leaving no escape for a transcriber to get wrong. Mirrored from harness.mjs.
const CTRL_UNSAFE = /[\u0000-\u0007\u000b\u000e-\u001f\u007f]/g
const scrubCtrl = (v) => (typeof v === 'string'
  ? v.replace(CTRL_UNSAFE, (c) => `<0x${c.charCodeAt(0).toString(16).padStart(2, '0')}>`)
  : v)
// Event sidecars. `degradations` and `escalations` used to ride INSIDE state.json, arc-cumulative:
// by wave 19 of a live arc they were a third of a 170-190 KB document that EVERY checkpoint
// re-transcribed, so each row made the next write likelier to fail and each failed write appended
// another row (91 `write-failed` rows in one arc, growing with the wave number). They are EVENTS,
// not state — ONE JSON line appended at the moment they happen, never rewritten. state.json keeps
// only what the run's own decisions read; the wave's degradations ride back to the conductor in the
// RETURN value, in memory, never on disk.
const sidecarPath = (kind) => `${repo}/.roadmap/${kind}.jsonl`
let sidecarLost = 0
let sidecarChain = Promise.resolve()
const sidecarPending = { degradations: [], escalations: [] }
// Queue a row and flush on a serial chain: a burst coalesces into one append, and two appends never
// interleave. A LOST append must NOT call degrade() — that recurses into the very mechanism that is
// failing. runVerbatim's own single retry is the only retry; after it the rows are counted in
// `sidecarLost`, which rides in state.json: loud, bounded, and not self-feeding.
function sidecarAppend(kind, row) {
  sidecarPending[kind].push(row)
  sidecarChain = sidecarChain.then(async () => {
    const rows = sidecarPending[kind].splice(0)
    if (!rows.length) return
    const text = rows.map((r) => JSON.stringify(r, (_k, v) => scrubCtrl(v))).join('\n')
    const r = await runVerbatim({ single: appendVerbatim(sidecarPath(kind), text) },
      { model: 'haiku', effort: 'low', label: `sidecar:${kind}`, phase: 'Persist', schema: S.ok }, STRICT)
    if (!r.ok) {
      sidecarLost += rows.length
      log(`SIDECAR LOST ${rows.length} ${kind} row(s) — ${r.detail} (see the agent transcript)`)
    }
  }).catch(() => null)
}
// Await a verbatim write and ledger any failure as a `write-failed` degradation — a lost persist
// is exactly the evidence-destroying silence the degradation ledger exists to catch. Never throws.
const persistVerbatim = async (path, text, opts, extra = '') => {
  const r = await runVerbatim(writeVerbatim(path, text, extra), opts, STRICT)
  if (!r.ok)
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'write-failed',
      what: `${path.split('/').pop()} persist did not land (${r.detail}) — on-disk copy may trail the run` })
}
// Spec writers may touch exactly one file under specs/ — never the rest of the orchestrator's dir.
const SPECWRITE = STRICT +
  `Write ONLY the single spec file named in this task under ${repo}/.roadmap/specs/ — create or modify nothing ` +
  `else under ${repo}/.roadmap/ (not plan.json, state.json, contracts, other specs, or feedback). `

/* ------------------------------- schemas ------------------------------- */
const obj = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })
const arr = (t) => ({ type: 'array', items: { type: t } })
const oneOf = (vals) => ({ type: 'string', enum: vals })
const strArr = (maxItems, maxLength) => ({ type: 'array', maxItems, items: { type: 'string', maxLength } })

// Shared new-unit skeleton — judgment-bearing shape the boundary agents emit; Sonnet expands it
// into a full spec file. Capped hard (rides in state/prompts; the platform resends over-long
// payloads verbatim). `notes`-free by design: the boundary schemas carry the pressure-release.
const specSkeleton = obj({
  id: { type: 'string', maxLength: 60 },
  title: { type: 'string', maxLength: 120 },
  risk: oneOf(['low', 'med', 'high']),
  kind: { type: 'string', maxLength: 30 },
  supersedes: { type: 'string', maxLength: 60 },
  goal: { type: 'string', maxLength: 400 },
  constraints: { type: 'string', maxLength: 600 },
  contractRefs: arr('string'),
  // Issue mode only: existing issue NUMBERS this unit resolves (typically the consolidated
  // roadmap:debt issues a sweep fix-unit folds in) — the merge path closes them on landing.
  closes: { type: 'array', maxItems: 40, items: { type: 'integer', minimum: 1 } },
  acceptance: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 200 } },
  edges: {
    type: 'array', maxItems: 8, items: obj({
      from: { type: 'string', maxLength: 60 },
      mode: oneOf(['contract', 'contingent']),
      type: oneOf(['semantic', 'file-overlap']),
      contract: { type: 'string', maxLength: 120 },
    }, ['from', 'mode']),
  },
}, ['id', 'title', 'risk', 'goal', 'acceptance'])

const S_census = obj({
  ok: { type: 'boolean' },
  pendingUserFeedback: strArr(40, 120),
  quarantineDossiers: strArr(40, 120),
  detail: { type: 'string', maxLength: 300 },
}, ['ok', 'pendingUserFeedback'])

// Opus tier-2 triage: routine boundary judgment. admit = draft ids to fold in; promote = full
// skeletons it authors; cut = drafts to drop; feedback = per-file dispositions; escalate hands
// up (Fable) or out (root) — kill/contract/replan/user are escalate-only.
const S_triage = obj({
  admit: strArr(12, 60),
  cut: { type: 'array', maxItems: 12, items: obj({ id: { type: 'string', maxLength: 60 }, reason: { type: 'string', maxLength: 200 } }, ['id', 'reason']) },
  promote: { type: 'array', maxItems: 8, items: specSkeleton },
  debtLedger: strArr(24, 400),
  feedback: { type: 'array', maxItems: 40, items: obj({ file: { type: 'string', maxLength: 120 }, action: oneOf(['actioned', 'dismissed', 'deferred']), reason: { type: 'string', maxLength: 200 } }, ['file', 'action']) },
  escalate: { type: 'boolean' },
  escalateReason: oneOf(['quarantine-redesign', 'contract-amendment', 'contingent-replan', 'needs-user', 'hard-call', 'none']),
  arcComplete: { type: 'boolean' },
  // `notes` is the PRESSURE-RELEASE valve, so it must not be the thing that bursts. At 600 it was:
  // arc-observed, a triager disposing of 15 findings overran it, exhausted its schema-retries, and
  // died — twice at the same boundary. It is also where a 'needs-user' escalation must carry the
  // exact question AND the context to answer it. Cap it loosely; the payload-size risk the other
  // caps guard lives in the ARRAYS (which stay capped), not here.
  notes: { type: 'string', maxLength: 2000 },
}, ['admit', 'cut', 'promote', 'escalate', 'arcComplete'])

// Fable tier-3 boundary agent: escalations + quarantine respecs. newUnits/reviseSpecs/cutUnits
// are plan data (never code); journal seeds the next fresh boundary agent's inherited rationale.
const S_boundaryPlan = obj({
  newUnits: { type: 'array', maxItems: 12, items: specSkeleton },
  reviseSpecs: { type: 'array', maxItems: 8, items: obj({ id: { type: 'string', maxLength: 60 }, goal: { type: 'string', maxLength: 400 }, acceptance: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 200 } }, constraints: { type: 'string', maxLength: 600 } }, ['id']) },
  cutUnits: strArr(12, 60),
  debtLedger: strArr(24, 400),
  // Explicit waiver of owed boundary jobs (job names, e.g. 'design') — Fable-tier only, and
  // only with the justification journaled; anything not waived rides forward.
  waiveOwed: strArr(8, 30),
  journal: { type: 'string', maxLength: 1500 },
  escalate: { type: 'boolean' },
  escalateReason: oneOf(['contract-amendment', 'contingent-replan', 'needs-user', 'cut-line', 'none']),
  arcComplete: { type: 'boolean' },
  notes: { type: 'string', maxLength: 2000 },   // pressure-release — see S_triage.notes
}, ['newUnits', 'journal', 'escalate', 'arcComplete'])

const S = { ok: obj({ ok: { type: 'boolean' }, detail: { type: 'string' } }, ['ok']) }
// issue-new returns the {id, number} of every unit issue it created or found, so the conductor can
// cache each number into plan.units[].issue. No maxLength anywhere: the ids are echoed from the units
// passed in, so there is nothing for the model to overrun (and nothing for prompt-hygiene to require).
S.newIssues = obj({
  ok: { type: 'boolean' },
  opened: { type: 'array', items: obj({ id: { type: 'string' }, number: { type: 'number' } }, ['id', 'number']) },
  detail: { type: 'string' },
}, ['ok'])
// bank-debt reports back the markers it VERIFIED are present, so the script clears exactly those and
// carries the rest. Uncapped for the same reason as S.newIssues: every marker is echoed from a string
// this script composed and handed in, so there is nothing for the model to overrun.
S.banked = obj({
  ok: { type: 'boolean' },
  banked: { type: 'array', items: obj({ marker: { type: 'string' }, number: { type: 'number' } }, ['marker']) },
  detail: { type: 'string' },
}, ['ok', 'banked'])
// plan-ids: the on-disk unit ids, read back BEFORE persist-plan overwrites plan.json. A courier
// shape — it reports facts, the script judges. Uncapped: the ids are echoed from a file this
// script wrote.
S.planIds = obj({
  ok: { type: 'boolean' },
  ids: { type: 'array', items: { type: 'string' } },
  detail: { type: 'string' },
}, ['ok', 'ids'])

/* ------------------------------- helpers ------------------------------- */
// Kebab-sanitize + 60-char cap. Deterministic (no Date/random) so ids are resume-stable.
const kebab = (s) => (String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'unit')
const uStatus = (id) => (state.units ?? {})[id]?.status
const isMerged = (id) => uStatus(id) === 'merged'
const isTerminal = (id) => ['merged', 'quarantined', 'deferred'].includes(uStatus(id))

// Contingent withholding (ruling 2): ready() ignores edge.mode, so the conductor mechanically
// sets aside any contingent `to`-unit whose `from` is not yet merged, keeping independent work
// running. The flip is transient — applied only to the dispatched copy, never to `plan`.
function withhold() {
  const withheldIds = new Set()
  for (const e of plan.edges) if (e.mode === 'contingent' && !isMerged(e.from)) withheldIds.add(e.to)
  const dispatchPlan = { ...plan, units: plan.units.map((u) => (withheldIds.has(u.id) ? { ...u, inScope: false } : u)) }
  return { dispatchPlan, withheld: [...withheldIds] }
}

// Arc-completeness was STATUS-BLIND: the decision read only what the boundary agents emitted, and
// arcSummary buckets merged/quarantined/deferred, so a pending/running/blocked in-scope unit was
// invisible to the triager that declared the arc done. 2026-07-18: four in-scope, satisfiable units
// were still outstanding when tier-2 called arc-complete, and the root caught it by hand.
//
// The guard is deliberately NOT "refuse while anything is non-terminal" — that livelocks. A unit
// whose dependency was cut or quarantined without a respec can never reach a terminal state, and
// refusing on it would burn a paid boundary every relaunch, forever. So: refuse only for units that
// are actually SATISFIABLE — every dependency merged, or itself outstanding-and-satisfiable — and
// hand the rest to the root as evidence rather than silently dropping them.
function outstanding() {
  const inScopeIds = new Set(plan.units.filter((u) => u.inScope).map((u) => u.id))
  const nonTerminal = [...inScopeIds].filter((id) => !isTerminal(id))
  const depsOf = (id) => plan.edges.filter((e) => e.to === id).map((e) => e.from)
  const set = new Set(nonTerminal)
  // Fixed point: drop anything blocked behind a dependency that is neither merged nor itself
  // still-live. What survives is work the next wave could actually dispatch.
  for (let changed = true; changed;) {
    changed = false
    for (const id of [...set])
      if (!depsOf(id).every((d) => uStatus(d) === 'merged' || set.has(d))) { set.delete(id); changed = true }
  }
  return { satisfiable: [...set], stuck: nonTerminal.filter((id) => !set.has(id)) }
}

// Pure routing predicates (a function of plan + returned state + census + this wave's withheld set).
function predicates(census, withheldIds) {
  const units = state.units ?? {}
  const b = state.boundary ?? {}
  const explorer = b.explorer ?? {}
  const health = b.health ?? {}
  const flake = b.flake ?? {}
  // Design-fidelity drift is judged like health: findings flow to triage, drafts are the default
  // vehicle. Folding them in HERE (rather than a parallel channel) is what delivers "drift admitted
  // as fix units by default" — they inherit tier-1/tier-2 default-admit and the cut-line brake.
  const design = b.design ?? {}
  const debt = state.debt ?? []
  const inScopeIds = new Set(plan.units.filter((u) => u.inScope).map((u) => u.id))
  // crossedContingent: a contingent edge whose `from` merged but whose `to` was NOT dispatched —
  // withheld this wave, or still out of scope. A dependent the root already replanned into scope
  // and that ran this wave is not "crossed": if it quarantined or blocked, that routes through
  // the normal ladder (tier 3 / dossiers), not a spurious contingent-replan return.
  const crossedContingent = plan.edges.filter((e) =>
    e.mode === 'contingent' && units[e.from]?.status === 'merged' && units[e.to]?.status !== 'merged' &&
    (withheldIds.has(e.to) || !inScopeIds.has(e.to)))
  const contractDebt = debt.filter((d) => d && d.kind === 'contract')
  const nonContractDebt = debt.filter((d) => d && d.kind !== 'contract')
  // Only UNRESOLVED quarantines force tier 3. A unit already superseded or cut is inScope:false in
  // the plan (its record stays 'quarantined' — the harness never rewrites an existing record), so
  // excluding out-of-scope ids stops a respecced quarantine from re-triaging forever.
  const quarantined = Object.entries(units).filter(([id, r]) => r?.status === 'quarantined' && inScopeIds.has(id)).map(([id]) => id)
  // Shared pre-existing reds, collapsed by the harness's circuit breaker: ONE entry per red rather
  // than one per affected unit. They arrive as FINDINGS, never as debt items — debt must never
  // create a wave (that brake is what makes arcs terminate), so a shared red rides the
  // promote/escalation path, which the cut line already brakes.
  const sharedReds = (state.sharedReds ?? []).map((r) => ({
    source: 'shared-red', severity: 'major', spec: r.spec, units: r.units ?? [],
    summary: `${r.spec} failed for ${(r.units ?? []).length} units and no unit's diff touches it — one shared ` +
      `pre-existing red, to be homed once`,
  }))
  const findings = [...sharedReds, ...(explorer.findings ?? []), ...(health.findings ?? []), ...(design.findings ?? [])]
  const healthFixUnits = [...(health.fixUnits ?? []), ...(design.fixUnits ?? [])]
  const flakeFlips = flake.flips ?? []
  const userFeedback = census.pendingUserFeedback ?? []
  // Owed boundary jobs (harness-written): due jobs that did not run. Non-empty is a judgment
  // signal — a tier must consciously ride them forward, act on the broken precondition, or
  // (Fable only) waive them; entries owed two boundaries running force tier 3.
  const owedJobs = state.owed ?? []
  const anyJudgment = findings.length > 0 || flakeFlips.length > 0 || nonContractDebt.length > 0 || userFeedback.length > 0 || owedJobs.length > 0
  return { crossedContingent, contractDebt, nonContractDebt, quarantined, findings, sharedReds, healthFixUnits, drafts: healthFixUnits, flakeFlips, userFeedback, owedJobs, anyJudgment }
}

// A health-assessor fix-unit draft {id, goal, files, acceptance} -> a default skeleton
// (risk 'low', kind 'code'). `files` rides along for the spec prompt only.
const draftSkeleton = (d) => ({
  id: d.id, title: (d.goal ?? d.id).slice(0, 120), risk: 'low', kind: 'code',
  goal: d.goal ?? '', constraints: '', contractRefs: [], acceptance: d.acceptance ?? [], edges: [], files: d.files ?? [],
})

const contractPaths = () => [...new Set(plan.edges.filter((e) => e.contract).map((e) => e.contract))]

// .roadmap/skill-degradations.md — the MACHINE-owned half of the orchestrator's own defect log.
// It used to be a marker region INSIDE the hand-written .roadmap/skill-feedback.md, rewritten by an
// unverified Haiku edit whose content grew with every degradation; twice the growing region ate the
// hand-written entry above it (the truncated fragment in the shipped ledger is the evidence). Two
// changes close that for good: the orchestrator never touches skill-feedback.md again — that file is
// human-owned, full stop — and this one is a WHOLE-FILE cksum-verified write of a summary that
// CANNOT grow with the row count (one line per distinct kind; the rows themselves are in the
// append-only sidecar). Written at every persist point, not just on return, because a run that dies
// never returns. A pure function of `degradations`, so a resume rewrites it byte-identically.
async function writeSkillDegradations() {
  if (!degradations.length) return
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
  const doc = `# Skill degradations — roadmap-orchestrator\n\n` +
    `MACHINE-WRITTEN — every persist point overwrites this file. Hand-written observations belong in ` +
    `\`skill-feedback.md\`, which the orchestrator never touches.\n\n` +
    `Defects in the ORCHESTRATOR itself (not the product) observed while running this arc. Carry this file and ` +
    `\`.roadmap/degradations.jsonl\` back to the skill's repository; they are not product debt and do not belong ` +
    `in debt.md.\n\n## This run: ${degradations.length} degradation(s)\n\n` +
    `| kind | count | most recent |\n|---|---|---|\n${rows.join('\n')}\n\n` +
    `Full rows — one JSON line per event, arc-cumulative — are in \`.roadmap/degradations.jsonl\`. Each names ` +
    `the agent label; find its transcript in the workflow's agent-*.jsonl to see the real error, which the ` +
    `platform does not expose to the script.\n`
  await persistVerbatim(`${repo}/.roadmap/skill-degradations.md`, doc,
    { model: 'haiku', effort: 'low', label: 'skill-degradations', phase: 'Persist', schema: S.ok })
}
// log-append: architect journal, tier-3 only (replace-if-header-exists idempotency). A helper
// because it must fire on TERMINAL tier-3 paths too (cut-line, arc-complete) — the persist
// section sits past those returns, and a journal that dies with a terminal boundary takes the
// owed-waiver justifications down with it.
async function writeJournal(N, journal) {
  if (!journal) return
  await run(
    STRICT + `In the file ${repo}/.roadmap/architect-log.md (create it if missing): ensure exactly one section ` +
    `headed \`## Wave ${N}\`. If that exact header already exists, replace its body; otherwise append it at the ` +
    `end. The section body is:\n${journal}\n\nChange nothing else in the file.`,
    { model: 'haiku', effort: 'low', label: `log-append:w${N}`, phase: 'Persist', schema: S.ok },
  ).catch(() => null)
}
const arcSummary = (census) => {
  const u = state.units ?? {}
  const ids = (s) => Object.entries(u).filter(([, r]) => r?.status === s).map(([id]) => id)
  return { merged: ids('merged'), quarantined: ids('quarantined').map((id) => ({ id })), deferred: ids('deferred'), pendingFeedback: census.pendingUserFeedback ?? [], wavesRun }
}

// Persist the current `state` (or a supplied variant) with the conductor block, then build the
// frozen return envelope. Every early return flows through here; `tier` records the boundary
// outcome (null skips the record — pre-dispatch/post-loop guards belong to no wave's boundary).
async function ret(reason, tier, extra = {}) {
  if (tier != null) boundaries.push({ wave: state.wave, tier, escalated: reason })
  const st = { ...state, spend: { ...(state.spend ?? {}) } }   // tier-4 handoff: boundary + debt stay INTACT (the root consumes them)
  mergeConductorSpend(st)
  st.conductor = { reason, wavesRun, boundaries }
  delete st.degradations   // sidecar-only: an arc-cumulative ledger inside state.json IS the growth loop
  // Rows that never reached the sidecar. Loud, bounded, and deliberately not a degradation — a
  // sidecar failure that degraded would feed the ledger it just failed to write.
  if (sidecarLost) st.sidecarLost = (st.sidecarLost ?? 0) + sidecarLost
  phase('Persist')
  await writeSkillDegradations()
  await persistVerbatim(`${repo}/.roadmap/state.json`, JSON.stringify(st, null, 2),
    { model: 'haiku', effort: 'low', label: `persist-state:w${st.wave}`, phase: 'Persist', schema: S.ok })
  await sidecarChain   // every event of this run is on disk before the root sees the envelope
  return {
    status: 'conductor-return', reason, wave: st.wave, wavesRun, state: st, plan,
    spendDelta: deltaSpend(st.spend),
    // Always present (empty when clean) so the root never has to wonder whether the run was healthy.
    degradations,
    // A refused plan.json overwrite is the root's to reconcile — it is the only thing this script
    // deliberately did NOT persist.
    ...(planConflicts.length ? { planConflict: planConflicts } : {}),
    // Owed boundary jobs surface on every return — on a terminal one they are the root's to
    // discharge (or explicitly waive in the architect log) before close-out.
    ...(st.owed?.length ? { owed: st.owed } : {}),
    ...extra,
  }
}

/* --------------------------- boundary prompts -------------------------- */
// Deterministic functions of repo path + wave N + the JSON of in-memory structured data. Both
// agents read architect-log.md FIRST so successive fresh agents inherit rationale.
const censusPrompt = (N) => STRICT +
  `Take a wave-${N} census of a roadmap build's pending bug reports and quarantine dossiers. Report identifiers ` +
  `only — read no contents, change nothing:\n` +
  (issueMode
    ? `1) List open user bug issues: \`gh issue list ${ghRepo}--label roadmap:bug --state open --limit 1000 ` +
      `--json number --jq '.[].number'\` — put each issue NUMBER (as a string) in \`pendingUserFeedback\` (empty ` +
      `array if none or if gh fails). gh defaults to 30 results, so always pass the --limit shown; if the ` +
      `returned count EQUALS the limit the listing is truncated — re-run with the limit doubled until the count ` +
      `is below it, and note in \`detail\` that paging was needed.\n`
    : `1) List the files directly under ${repo}/.roadmap/feedback/user/, EXCLUDING TEMPLATE.md — put their basenames ` +
      `in \`pendingUserFeedback\` (empty array if that directory is absent or holds only TEMPLATE.md).\n`) +
  `2) List the *.md files under ${repo}/.roadmap/quarantine/ — put their basenames in \`quarantineDossiers\` ` +
  `(empty array if absent).\nReport ok:true when both listings completed. Never guess ` +
  `${issueMode ? 'issue numbers' : 'filenames'}. Keep \`detail\` to one sentence (max 300 characters). ${TERSE}`

// The cut-line brake is load-bearing (arc-observed, RATIONALE §7): a healthy assessor drafts
// something EVERY wave, so an admit-by-default triage with no brake never dries — one live run
// admitted fresh test-ergonomics drafts on waves 3/4/5 and returned max-waves. Don't soften it.
const opusTriagePrompt = (N, P) =>
  `You are the wave-${N} boundary triager for a roadmap build, standing in for the architect. Read, in this order: ` +
  `${repo}/.roadmap/architect-log.md FIRST (inherited rationale + dismissal criteria), then ` +
  `${repo}/.roadmap/state.json, ${repo}/.roadmap/plan.json, ${issueMode ? 'the open roadmap:debt issues (`gh issue list ' + ghRepo + '--label roadmap:debt --state open --limit 1000` — if exactly 1000 come back the listing is truncated: re-run with a higher limit; never trust a result equal to its limit)' : `${repo}/.roadmap/debt.md`}, this wave's feedback at ` +
  `${repo}/.roadmap/feedback/{explorer,health}/wave-${N}.md plus ` +
  `${issueMode ? `the open user bug issues named in the evidence below (read each with \`gh issue view ${ghRepo}<n>\`)` : `any user notes under ${repo}/.roadmap/feedback/user/`}, and the specs/contracts under ${repo}/.roadmap/{specs,contracts} as needed. ` +
  `The wave's structured boundary evidence (authoritative — the files are for detail):\n` +
  `${JSON.stringify({ findings: P.findings, drafts: P.healthFixUnits, flakeFlips: P.flakeFlips, debt: P.nonContractDebt, userFeedback: P.userFeedback, owed: P.owedJobs })}\n` +
  `Weigh explorer/health findings, dispose of debt and non-contract feedback, and decide which health-assessor ` +
  `fix-unit DRAFTS to admit. ` +
  (P.owedJobs.length
    ? `The \`owed\` list names boundary jobs that were DUE but did not run (count = consecutive boundaries owed). ` +
      `They discharge automatically when the job next succeeds — never silently ignore one: if its precondition is ` +
      `broken (e.g. the preview is down), that is itself a finding to act on, and only the Fable tier may waive an ` +
      `owed job outright — escalate 'hard-call' if you believe one should be. `
    : '') +
  (P.sharedReds.length
    ? `A finding marked \`source:"shared-red"\` is ONE pre-existing failure that broke several units' gates at once ` +
      `and lies outside every one of their diffs. It is not evidence against those units and their specs are not ` +
      `wrong: home it in a single fix unit (or bank it), and never respec a unit over it. `
    : '') +
  (CC.admissions === 'closed'
    ? `ADMISSIONS ARE CLOSED for this arc: the plan is drained. Nothing you list in \`admit\` or \`promote\` will ` +
      `become a unit — the scheduler banks those entries to the debt ledger instead, in code, whatever you decide. ` +
      `Dispose of the wave on that basis: say what is real so it is banked with a reason, cut what is noise, and set ` +
      `arcComplete. The one exception is a finding graded \`blocker\`, which the scheduler routes to the architect ` +
      `tier to be ruled on — do not try to admit one yourself. `
    : '') +
  `${(plan.designAuthorities ?? []).length ? 'A design-fidelity finding (severity bug | adoption-gap | irreconcilable) means a screen that MERGED has drifted from the comp that governs it: the default vehicle is a fix unit, and an "irreconcilable" one is never yours to cut — escalate it, because it means built behaviour and design cannot both stand and only the architect can choose. ' : ''}` +
  `Drafts are the default action — admit them (list ids in \`admit\`) unless they are ` +
  `noise, in which case \`cut\` them with a reason; author any additional new unit you want as a full skeleton in ` +
  `\`promote\`. SWEEP THE WAVE'S DEBT, don't just bank it: while the plan's own in-scope units still have work ` +
  `left to run (a next wave is happening anyway), fold this wave's debt — even minor items — into one or more ` +
  `consolidation fix-units in \`promote\`, so debt is cleaned up next wave rather than accumulating. ` +
  `${issueMode ? 'When a unit you `promote` resolves specific OPEN roadmap:debt or roadmap:bug issues you read above, set its `closes` field to exactly those issue NUMBERS — the merge path closes them automatically when the unit merges; omit `closes` otherwise and never guess a number. ' : ''}` +
  `But debt must ` +
  `never CREATE a wave: once the plan's own units are all terminal (merged/quarantined), do NOT promote debt — ` +
  `bank it to \`debtLedger\` and set arcComplete, so it becomes durable tracked debt the next session picks up. ` +
  `THE CUT LINE BINDS THE DEFAULT — a healthy assessor drafts something every wave, so admitting by ` +
  `default with no brake would extend the arc forever: once the plan's own units are merged, a ` +
  `draft must justify a WAVE, not merely be an improvement — refactors without a defect, ergonomics polish, and ` +
  `marginal coverage on a healthy suite are noise to cut even though they are real; bank them to \`debtLedger\` ` +
  `instead so nothing is lost. When you cut the last drafts as below-the-line, set arcComplete:true in the same ` +
  `verdict — an arc that never dries is a failure mode, not diligence. ` +
  `Findings observed at a superseded sha are discounted, not re-litigated. You may NOT kill a unit, ` +
  `amend a contract, design a contingent dependent, or answer for the user: set escalate:true with the matching ` +
  `escalateReason — 'quarantine-redesign' or 'hard-call' hands to the Fable boundary agent; ` +
  `'contract-amendment'/'contingent-replan'/'needs-user' return to the root. When escalating 'needs-user', put ` +
  `the exact user-facing question (with the context needed to answer it) in \`notes\` — that text IS what reaches ` +
  `the user. Set arcComplete:true if the cut line ` +
  `is reached and no further work remains. Return structured output only — write nothing. Hold \`notes\` to a ` +
  `few short paragraphs (max 2000 characters). ` + TERSE

const fableBoundaryPrompt = (N, P, lead) =>
  `You are the wave-${N} Fable boundary agent for a roadmap build — the architect's in-workflow stand-in for ` +
  `escalations and quarantine respecs. Read ${repo}/.roadmap/architect-log.md FIRST (inherited rationale), then the ` +
  `dossiers of the quarantined units named here (${JSON.stringify(P.quarantined)}) under ` +
  `${repo}/.roadmap/quarantine/, then ${repo}/.roadmap/state.json, ${repo}/.roadmap/plan.json, this wave's feedback ` +
  `under ${repo}/.roadmap/feedback/, and ${repo}/.roadmap/debt.md. Structured evidence:\n` +
  `${JSON.stringify({ quarantined: P.quarantined, findings: P.findings, drafts: P.healthFixUnits, debt: P.nonContractDebt, owed: P.owedJobs })}\n` +
  (P.owedJobs.length
    ? `The \`owed\` list names boundary jobs that were DUE but did not run (count = consecutive boundaries owed); ` +
      `they discharge automatically when the job next succeeds. For each, either act on the broken precondition ` +
      `(e.g. a fix unit or journal instruction for a downed preview) or — if the job is genuinely moot for this ` +
      `arc — waive it explicitly by putting its job name in \`waiveOwed\` and justifying the waiver in your ` +
      `journal. An owed job you neither act on nor waive rides forward and forces this tier again. `
    : '') +
  (P.sharedReds.length
    ? `A finding marked \`source:"shared-red"\` is ONE pre-existing failure that broke several units' gates at once ` +
      `and lies outside every one of their diffs. Home it once; it is never grounds to respec the units it failed. `
    : '') +
  (CC.admissions === 'closed'
    ? `ADMISSIONS ARE CLOSED for this arc: the plan is drained, and you are reading this tier only because a ` +
      `quarantine, an owed job, or a blocker-graded finding needs a ruling. New units are still yours to emit, but ` +
      `only work of that grade justifies one — everything else belongs in \`debtLedger\`. `
    : '') +
  `Route each quarantined unit by its dossier REASON: environment/tooling-blocked -> re-run as-is (prefer ` +
  `instructing the provisioning fix via the \`journal\` plus a fresh \`newUnit\` carrying the SAME spec under a NEW ` +
  `id); unsatisfiable-as-written -> respec under a NEW id; otherwise split or revise. NEVER reuse a failed or ` +
  `quarantined id. Emit new work as full skeletons in \`newUnits\` (each with a NEW kebab id), spec adjustments in ` +
  `\`reviseSpecs\`, and units to drop below the cut line in \`cutUnits\`. ` +
  `${issueMode ? 'When a `newUnit` resolves specific OPEN roadmap:debt or roadmap:bug issues you read above, set its `closes` field to exactly those issue NUMBERS — the merge path closes them automatically when the unit merges; omit `closes` otherwise and never guess a number. ' : ''}` +
  `Whenever a \`newUnit\` REPLACES a ` +
  `quarantined unit, set its \`supersedes\` field to that unit's id so the failed unit is retired and its edges ` +
  `repoint to the replacement — never leave a replaced quarantine active; a quarantine you abandon without ` +
  `replacing goes in \`cutUnits\`. Append a concise architect \`journal\` ` +
  `entry (decisions + rationale + watch-list) so the next fresh boundary agent inherits your rationale. You may ` +
  `NEVER amend a contract or design a contingent dependent: set escalate:true with escalateReason ` +
  `'contract-amendment'/'contingent-replan'/'needs-user' to return to the root, or 'cut-line' when the arc is ` +
  `complete. When escalating 'needs-user', put the exact user-facing question (with the context needed to answer ` +
  `it) in \`notes\` — that text IS what reaches the user. ` +
  `Return skeletons and journal only — write no code and no files. Hold \`journal\` to one short paragraph ` +
  `(max 1500 characters) and \`notes\` to a few (max 2000 characters). ${TERSE}${lead}`

const specExpandPrompt = (skel) => SPECWRITE +
  `Expand this unit skeleton into a full spec and write it to exactly ${repo}/.roadmap/specs/${skel.id}.md and no ` +
  `other file. Skeleton:\n${JSON.stringify(skel)}\nThe spec must contain: a Goal section (from \`goal\`), a ` +
  `Constraints section (from \`constraints\`), a Contract references section (from \`contractRefs\`), and an ` +
  `Acceptance criteria section written as individually gradeable clauses (from \`acceptance\`) — the exit gate ` +
  `grades them one by one. Render the skeleton's content faithfully; invent no requirements. Report ok:false with ` +
  `the exact error if the path cannot be written.`

const specRevisePrompt = (rev) => SPECWRITE +
  `Revise the existing spec at ${repo}/.roadmap/specs/${rev.id}.md in place, applying these changes and nothing ` +
  `else: ${JSON.stringify(rev)}. Update the Goal, Acceptance criteria (keep them individually gradeable), and ` +
  `Constraints sections to match; leave the rest of the spec intact. Report ok:false with the exact error if the ` +
  `file cannot be written.`

/* ---------------------------- plan mutation ---------------------------- */
// Assign resume-stable, collision-free kebab ids to a batch of new skeletons. A respec NEVER
// reuses its superseded (quarantined) id — that would re-run a failed spec.
function makeFreshId() {
  const taken = new Set(plan.units.map((u) => u.id))
  const N = state.wave
  return (candidate, supersedes) => {
    let id = kebab(candidate)
    if (supersedes && id === kebab(supersedes)) id = kebab(`${candidate}-r${N}`)
    const base = id
    let i = 2
    while (taken.has(id)) { id = kebab(`${base}-${i}`); i++ }
    taken.add(id)
    return id
  }
}

// Drop drafts a boundary filed twice in ONE batch. makeFreshId dedupes by id string and RENAMES a
// collision (`x` -> `x-2`), which is right for a genuine respec and exactly wrong here: it turned
// one draft filed twice into two real units (arc-observed, #1261/#1262). Exact duplicates go —
// same id, or same title once kebabbed — and suffixing survives only for a `supersedes` respec,
// which legitimately re-files a topic under a new id.
function dedupeDrafts(skeletons) {
  const seen = new Set()
  const kept = []
  const dropped = []
  for (const sk of skeletons) {
    if (sk?.supersedes) { kept.push(sk); continue }
    const id = kebab(sk?.id ?? '')
    const title = kebab(sk?.title ?? sk?.goal ?? '')
    if (seen.has(`id:${id}`) || (title && seen.has(`title:${title}`))) { dropped.push(sk); continue }
    seen.add(`id:${id}`)
    if (title) seen.add(`title:${title}`)
    kept.push(sk)
  }
  return { kept, dropped }
}

// Pure-code merge: append units (inScope:true) + edges, apply supersedes (old unit inScope:false,
// edges repointed old->new), and cut units (inScope:false). Dangling edges are dropped so the
// harness's plan-validation never throws on an unknown reference.
function mergePlan(prepared, cutIds) {
  for (const cid of cutIds ?? []) {
    const u = plan.units.find((x) => x.id === cid || x.id === kebab(cid))
    if (u) u.inScope = false
  }
  for (const s of prepared) {
    if (s.supersedes) {
      const oldId = s.supersedes
      const oldU = plan.units.find((x) => x.id === oldId)
      if (oldU) oldU.inScope = false
      for (const e of plan.edges) { if (e.from === oldId) e.from = s.id; if (e.to === oldId) e.to = s.id }
    }
    plan.units.push({ id: s.id, title: (s.title ?? s.id).slice(0, 120), risk: s.risk ?? 'low', kind: s.kind ?? 'code', inScope: true,
      // The push is a whitelist — an unlisted skeleton field is dropped here, so `closes` must be
      // carried explicitly or the merge path never sees it.
      ...(Array.isArray(s.closes) && s.closes.length
        ? { closes: s.closes.filter((n) => Number.isInteger(n) && n > 0) } : {}) })
  }
  for (const s of prepared) for (const e of s.edges ?? []) {
    const from = kebab(e.from)
    if (!plan.units.some((u) => u.id === from)) continue
    plan.edges.push({ from, to: s.id, type: e.type ?? 'semantic', mode: e.mode ?? 'contract', ...(e.contract ? { contract: e.contract } : {}) })
  }
}

const fmtDebt = (d) => typeof d === 'string'
  ? `- ${d}`
  : `- [${d.kind ?? 'structure'}/${d.severity ?? 'minor'}] ${d.what ?? ''}${d.why ? ` — ${d.why}` : ''}` +
    `${d.bankReason ? ` [bank: ${d.bankReason}]` : ''}${d.unit ? ` (${d.unit})` : ''}`

/* ------------------------------ main loop ------------------------------ */
for (let w = 0; w < CC.maxWavesPerRun; w++) {
  // 1. Contingent withholding, computed before dispatch from the latest state.
  const { dispatchPlan, withheld } = withhold()
  if (withheld.length) log(`wave ${w}: withholding ${withheld.length} contingent-dependent unit(s): ${withheld.join(', ')}`)
  const dispatchable = dispatchPlan.units.filter((u) => u.inScope && !isTerminal(u.id))
  // Excluding withheld units nothing dispatchable remains, but withheld ones do -> the root must replan.
  if (dispatchable.length === 0 && withheld.length > 0) {
    const edges = plan.edges.filter((e) => e.mode === 'contingent' && withheld.includes(e.to))
    return await ret('contingent-replan', 4, { edges })
  }

  // 2. Budget guard (waves after the first): refuse to dispatch a wave that could cross the 1000-call cap.
  if (w > 0) {
    // state.spend already carries conductor calls merged at prior continuations; add only the
    // not-yet-merged remainder so the conductor's own work is never counted twice.
    const runLocalCalls = (sumTiers(state.spend) - initialSpendTotal) + (sumTiers(cSpend) - sumTiers(cMerged))
    // Issue mode adds a per-wave overhead of a few Haiku calls (the harness's wave-tail issue-sync
    // sweep + the new-unit issue writer) that fold no work onto individual units — a small fixed bump.
    const estimate = (issueMode ? 12 : 8) + dispatchable.length * CC.perUnitCallEstimate
    if (runLocalCalls + estimate + CC.agentBudgetReserve > 1000)
      return await ret('agent-budget', null, { nextWaveUnits: dispatchable.map((u) => u.id), estimate })
  }

  // 3. Dispatch the wave through the harness. Config is passed UNTOUCHED; boundary:'off' is never
  //    set here (ruling 1). The returned state threads forward (units/spend/wave accumulate).
  phase('Wave')
  state = await workflow({ scriptPath: harnessPath }, { plan: dispatchPlan, state, config: overrides, harnessPath, launchId })
  wavesRun++
  const N = state.wave
  // The harness returns THIS WAVE's degradations in its ENVELOPE only — it has already written each
  // one to the shared sidecar, and its serialize() carries none of them. Absorb them in memory for
  // the return envelope and the summary, then strip them so nothing threads a ledger back onto disk.
  const newDegradations = state.degradations ?? []
  for (const d of newDegradations) degradations.push(d)
  if (newDegradations.length) log(`wave ${N}: ${newDegradations.length} harness degradation(s) recorded`)
  if ('degradations' in state) { state = { ...state }; delete state.degradations }

  // Wave debt reaches DISK the moment it arrives — before the census, before triage, before any
  // return can skip past the bank. `.roadmap/debt.json` is the wave's raw ledger as received;
  // debt.md / the roadmap:debt issues remain the durable, human-facing record that bank-debt writes.
  pendingDebt = [...pendingDebt, ...(state.debt ?? [])]
  if (pendingDebt.length)
    await persistVerbatim(`${repo}/.roadmap/debt.json`, JSON.stringify({ wave: N, items: pendingDebt }, null, 2),
      { model: 'haiku', effort: 'low', label: `persist-debt:w${N}`, phase: 'Persist', schema: S.ok },
      ' (create parent directories if needed)')

  // Codex hard stop (Codex is the only implementer — there is no lane to fall back to). The
  // harness already halted dispatch and parked in-flight units; no census/triage spend against a
  // wave the root must hand to the human anyway (re-auth, or wait out the usage-limit window,
  // then relaunch — state and parked units resume cleanly).
  if (state.codex?.halt)
    return await ret(state.codex.halt, 4, { parked: Object.entries(state.units ?? {})
      .filter(([, u]) => u.parked).map(([id]) => id) })

  // 4. Census (Haiku) — feedback + quarantine folder listing. A dead census degrades to an empty
  // one rather than killing the run: the authoritative boundary evidence is the in-memory state,
  // and an empty census only means user-feedback files go untriaged this boundary (they persist
  // on disk and are picked up at the next one).
  phase('Census')
  const census = await runOr(
    { ok: false, pendingUserFeedback: [], quarantineDossiers: [] },
    censusPrompt(N), { model: 'haiku', effort: 'low', label: `census:w${N}`, phase: 'Census', schema: S_census })

  // Single choke point for BOTH arc-complete exits (tier-3 cut-line and the tier-agnostic one
  // below) — each was independently status-blind, so guarding only one would leave the same bug
  // reachable by the other path.
  const finish = async (tier) => {
    const { satisfiable, stuck } = outstanding()
    // An owed boundary job must never leave a TERMINAL return quietly. The harness now runs owed
    // jobs in the final boundary even when it is switched off — which is where they used to vanish
    // — so anything still owed here survived that too and is the root's to discharge or waive
    // before close-out. `ret()` carries the ledger out; this makes it loud in the journal as well.
    if (state.owed?.length)
      log(`wave ${state.wave}: closing with ${state.owed.length} owed boundary job(s) unsettled ` +
        `(${state.owed.map((o) => o.job).join(', ')}) — discharge or waive them before close-out`)
    if (satisfiable.length)
      return await ret('arc-stalled', tier, { arcSummary: arcSummary(census), outstanding: satisfiable, stuck })
    // Nothing dispatchable remains. Units stuck behind an unresolved quarantine are NOT a reason to
    // refuse — nothing further can move them — but they must be named, not silently dropped.
    return await ret('arc-complete', tier, { arcSummary: arcSummary(census), ...(stuck.length ? { stuck } : {}) })
  }

  // 5. Predicates (the wave's withheld set disambiguates crossed vs already-replanned contingents).
  const P = predicates(census, new Set(withheld))

  // 6. Tier routing (first match wins). Contingent/contract routing outranks the degraded check:
  // both are actionable root business computable without a boundary block, and returning
  // 'boundary-degraded' over a pending contract amendment would bury the higher-priority reason.
  if (P.crossedContingent.length) return await ret('contingent-replan', 4, { edges: P.crossedContingent })
  if (P.contractDebt.length) return await ret('contract-amendment', 4, { debt: P.contractDebt, contracts: contractPaths() })

  // Boundary block absent while the caller left it enabled, and nothing to triage -> degraded wave.
  const callerBoundaryOff = (overrides?.boundary ?? inPlan.config?.boundary) === 'off'
  if (!state.boundary && !callerBoundaryOff && P.quarantined.length === 0)
    return await ret('boundary-degraded', 4, {})
  if (CC.boundaryTriage === 'root') return await ret('root-triage', 4, { pendingFeedback: census.pendingUserFeedback ?? [], quarantined: P.quarantined.map((id) => ({ id })) })

  const blockerFinding = P.findings.some((f) => f?.severity === 'blocker')

  let tier
  if (P.quarantined.length || P.owedJobs.some((o) => (o.count ?? 1) >= 2) ||
      // Closed admissions bank everything except a blocker, which needs a ruling, not a bank line.
      (admissionsClosed && blockerFinding) ||
      (CC.boundaryTriage === 'always-fable' && P.anyJudgment)) tier = 3
  else if (P.anyJudgment || (CC.fixUnitAdmit === 'triage' && P.drafts.length) ||
      P.drafts.length > CC.tier1MaxDrafts) tier = 2
  else tier = 1

  let triageResult = null
  let boundaryPlan = null
  let opusLead = ''

  // A dead triage tier has no safe fallback — inventing an empty verdict would silently admit or
  // drop work the root never saw. Hand the boundary back instead: the root triages it by hand (the
  // same recovery as boundary-degraded) and relaunches. Legible return beats a stack trace.
  const degraded = () => ret('triage-degraded', tier,
    { pendingFeedback: census.pendingUserFeedback ?? [], quarantined: P.quarantined.map((id) => ({ id })) })

  // Tier 2 — Opus boundary triager.
  if (tier === 2) {
    phase('Triage-opus')
    cSpend.boundaryTriages++
    triageResult = await runOr(null, opusTriagePrompt(N, P),
      { model: 'opus', effort: CC.opusEffort, label: `triage:w${N}`, phase: 'Triage-opus', schema: S_triage })
    if (!triageResult) return await degraded()
    if (triageResult.escalate) {
      const er = triageResult.escalateReason
      if (er === 'quarantine-redesign' || er === 'hard-call') {
        tier = 3   // hand to the Fable boundary agent, carrying the Opus assessment as a lead
        opusLead = ` A first-pass Opus boundary triage could not clear this itself (escalation trigger "${er}"). ` +
          `Use its assessment as a lead to confirm or overturn — not as ground truth: ` +
          `${JSON.stringify({ admit: triageResult.admit, cut: triageResult.cut, notes: triageResult.notes })}.`
      } else if (er === 'contract-amendment' || er === 'contingent-replan' || er === 'needs-user') {
        // An escalating return is a HANDOFF, not an abort: stage first, or the triager's admitted
        // units, this wave's debt ledger and the journal exist nowhere the root can read them.
        // `unbanked` is deliberately ignored — a tier-4 return hands `state.debt` back INTACT.
        await stage(N, 2, collect(2, P, triageResult, null))
        return await ret(er, 2, briefFor(er, P, N, triageResult, null, census))
      }
    }
  }

  // Tier 3 — Fable boundary agent (quarantine respecs + Opus escalations).
  if (tier === 3) {
    phase('Triage-fable')
    cSpend.boundaryFables++
    boundaryPlan = await runOr(null, fableBoundaryPrompt(N, P, opusLead),
      { model: 'fable', effort: CC.fableEffort, label: `boundary:w${N}`, phase: 'Triage-fable', schema: S_boundaryPlan })
    if (!boundaryPlan) return await degraded()
    // Apply owed-job waivers HERE, at capture — not at persist. The terminal returns below
    // (cut-line, and arc-complete when the plan yields nothing new) are exactly the shape a
    // waiver usually takes ("this job is moot for this arc" comes with no new units), and
    // applying late silently discarded it: the same dead job then re-forced a paid Fable
    // boundary on every relaunch, forever, since only a successful run discharges a marker
    // (eval-observed). Waiving into `state` means every downstream path — finish()/ret()
    // envelope, consumed threading, persisted state.json — inherits it.
    if (boundaryPlan.waiveOwed?.length && state.owed?.length) {
      const owedLeft = state.owed.filter((o) => !boundaryPlan.waiveOwed.includes(o.job))
      state = { ...state }
      if (owedLeft.length) state.owed = owedLeft
      else delete state.owed
      log(`wave ${N}: fable tier waived owed job(s): ${boundaryPlan.waiveOwed.join(', ')}`)
    }
    if (boundaryPlan.escalate) {
      const er = boundaryPlan.escalateReason
      if (er === 'contract-amendment' || er === 'contingent-replan' || er === 'needs-user') {
        await stage(N, 3, collect(3, P, triageResult, boundaryPlan))   // handoff, not abort — see tier 2
        return await ret(er, 3, briefFor(er, P, N, triageResult, boundaryPlan, census))
      }
      // The journal (waiver justifications included) must survive a terminal boundary — the
      // persist-section writer sits past this return and used to drop it.
      if (er === 'cut-line') { await writeJournal(N, boundaryPlan.journal); return await finish(3) }
    }
  }
  const ranTier = tier
  const collected = collect(ranTier, P, triageResult, boundaryPlan)
  const { prepared, reviseList, journal, arcCompleteFlag, feedbackDispositions } = collected

  // Arc complete: a tier said so, or the boundary produced no new units and no spec revisions.
  // Routed through finish(), which refuses to close over dispatchable work. A tier-3 journal
  // still lands first — this terminal return used to jump the persist-section writer and drop
  // it (waiver justifications with it).
  if (arcCompleteFlag || (prepared.length === 0 && reviseList.length === 0)) {
    if (ranTier === 3) await writeJournal(N, journal)
    return await finish(ranTier)
  }

  // 7. Stage this boundary's decisions on disk — specs, plan, issues, debt, journal.
  const { unbanked } = await stage(N, ranTier, collected)

  // 8. Persist (all awaited before the next dispatch; idempotent by wave-N markers for resume).
  phase('Persist')
  // Consumed continuation state: boundary removed + banked debt cleared, conductor.reason null.
  const consumed = { ...state, spend: { ...(state.spend ?? {}) } }
  if (state.boundary) { lastBoundary = state.boundary; lastBoundaryWave = N }
  delete consumed.boundary
  // Only what the banker CONFIRMED is cleared; the rest rides into the next wave's bank attempt.
  pendingDebt = unbanked
  consumed.debt = pendingDebt
  mergeConductorSpend(consumed)
  boundaries.push({ wave: N, tier: ranTier, escalated: null })
  consumed.conductor = { reason: null, wavesRun, boundaries }
  await writeSkillDegradations()

  // move-feedback: consumed user notes + this wave's explorer/health renderings -> triaged/N/.
  // ISSUE MODE: still archive the internal explorer/health/design files, but dispose of user bug reports
  // by closing/commenting the roadmap:bug ISSUES instead of moving user-note files.
  const consumedFiles = feedbackDispositions.filter((f) => f.action === 'actioned' || f.action === 'dismissed').map((f) => f.file)
  if (issueMode) {
    const disposed = feedbackDispositions.filter((f) => f.action === 'actioned' || f.action === 'dismissed')
      .map((f) => ({ number: f.file, action: f.action, reason: String(f.reason ?? '').slice(0, 140) }))
    const deferred = feedbackDispositions.filter((f) => f.action === 'deferred').map((f) => String(f.file))
    await run(
      STRICT + `Archive this wave's internal feedback renderings into ${repo}/.roadmap/feedback/triaged/${N}/ ` +
      `(create that directory). Move these files if they exist — skip any missing (idempotent): ` +
      `${repo}/.roadmap/feedback/explorer/wave-${N}.md, ${repo}/.roadmap/feedback/health/wave-${N}.md, ` +
      `${repo}/.roadmap/feedback/design/wave-${N}.md. Use \`git mv\` when possible, else \`mv\`. ` + GH_BEST_EFFORT +
      `Then dispose of the triaged user bug ISSUES: for each {number, action, reason} below, run ` +
      `\`gh issue comment ${ghRepo}<number> --body "Triaged wave ${N}: <action> — <reason>"\` then ` +
      `\`gh issue close ${ghRepo}<number> --reason completed\`: ${JSON.stringify(disposed)}. ` +
      (deferred.length ? `Leave these deferred issues OPEN, adding the label status:deferred: ${deferred.join(', ')}. ` : '') +
      `Create no other files and move nothing else.`,
      { model: 'haiku', effort: 'low', label: `move-feedback:w${N}`, phase: 'Persist', schema: S.ok },
    ).catch(() => null)
  } else {
    await run(
      STRICT + `Move consumed wave-${N} feedback into ${repo}/.roadmap/feedback/triaged/${N}/ (create that directory). ` +
      `Move these files if they exist — skip any that are missing (this is idempotent): ` +
      `${repo}/.roadmap/feedback/explorer/wave-${N}.md, ${repo}/.roadmap/feedback/health/wave-${N}.md, ` +
      `${repo}/.roadmap/feedback/design/wave-${N}.md` +
      `${consumedFiles.length ? `, and these user notes from ${repo}/.roadmap/feedback/user/: ${consumedFiles.join(', ')}` : ''}. ` +
      `Use \`git mv\` when possible, else \`mv\`. Create no other files and move nothing else.`,
      { model: 'haiku', effort: 'low', label: `move-feedback:w${N}`, phase: 'Persist', schema: S.ok },
    ).catch(() => null)
  }

  // persist-state: the consumed state + conductor block.
  await persistVerbatim(`${repo}/.roadmap/state.json`, JSON.stringify(consumed, null, 2),
    { model: 'haiku', effort: 'low', label: `persist-state:w${N}`, phase: 'Persist', schema: S.ok })

  state = consumed   // thread the consumed state into the next wave
}

// Loop exhausted without an arc-complete / early return -> relaunch fresh (resets the agent counter).
// Hand back the last wave's boundary (see lastBoundary): the root needs the same evidence here as on
// any other terminal return. Marked `triaged` because, unlike a true terminal boundary, this one was
// already dispositioned — its findings are banked and its feedback moved, so re-actioning it would
// duplicate the ladder's work.
if (lastBoundary) state = { ...state, boundary: { ...lastBoundary, triaged: true, wave: lastBoundaryWave } }
return await ret('max-waves', null, {})


// The wave's mutations, read off whichever tier ran. No disk writes and no agent calls — so an
// escalating return can collect exactly what the continuation path would have. It DOES mint debt
// in memory (the admissions bank below), which every return path carries out one way or another.
function collect(ranTier, P, triageResult, boundaryPlan) {
  const N = state.wave
  const freshId = makeFreshId()
  let newSkeletons = []
  let reviseList = []
  let cutUnitIds = []
  let journal = null
  let arcCompleteFlag = false
  let debtLedger = []

  // Nothing an admissions-closed boundary was not allowed to mint is merely dropped: each unit
  // becomes a debt line carrying its origin. It banks through BOTH debt channels, because the two
  // terminate differently. `state.debt` is what `ret()` hands the root INTACT on a terminal return
  // — the normal outcome under closed admissions, and it fires before the persist section. And
  // `pendingDebt` is what bank-debt banks and verifies on a continuation; the receipt-time snapshot
  // of `state.debt` is taken right after the harness returns, long before this boundary mints
  // anything, so a line added only to `state.debt` here would never reach a debt issue. On a
  // continuation `consumed.debt` is overwritten from `pendingDebt`, so the pair never double-banks;
  // an unbanked line rides into the next wave's debt.json like any other carried item.
  const bankLine = (sk) => `[not admitted — admissions closed] ${sk?.id ?? 'unnamed'}: ${sk?.goal ?? sk?.title ?? ''}`.slice(0, 400)
  const bankUnadmitted = (skeletons) => {
    if (!skeletons.length) return
    const lines = skeletons.map(bankLine)
    state = { ...state, debt: [...(state.debt ?? []), ...lines] }
    pendingDebt = [...pendingDebt, ...lines]
    log(`wave ${N}: admissions closed — banked ${skeletons.length} draft(s)/promotion(s), admitted 0 units`)
  }

  if (ranTier === 1) {
    const drafts = P.healthFixUnits.map(draftSkeleton)
    if (admissionsClosed) bankUnadmitted(drafts)
    newSkeletons = admissionsClosed ? [] : drafts
  } else if (ranTier === 2) {
    arcCompleteFlag = !!triageResult.arcComplete
    const draftById = new Map(P.healthFixUnits.map((d) => [d.id, d]))
    const admitted = [
      ...(triageResult.admit ?? []).filter((id) => draftById.has(id)).map((id) => draftSkeleton(draftById.get(id))),
      ...(triageResult.promote ?? []),
    ]
    if (admissionsClosed) bankUnadmitted(admitted)
    newSkeletons = admissionsClosed ? [] : admitted
    debtLedger = triageResult.debtLedger ?? []
  } else {
    arcCompleteFlag = !!boundaryPlan.arcComplete
    newSkeletons = boundaryPlan.newUnits ?? []
    reviseList = boundaryPlan.reviseSpecs ?? []
    cutUnitIds = boundaryPlan.cutUnits ?? []
    journal = boundaryPlan.journal
    debtLedger = boundaryPlan.debtLedger ?? []
  }

  // Assign final ids up front so spec files and plan units agree — after dropping duplicates, so a
  // draft filed twice can never be renamed into a second unit.
  const { kept: uniqueSkeletons, dropped: duplicateDrafts } = dedupeDrafts(newSkeletons)
  if (duplicateDrafts.length) {
    const names = duplicateDrafts.map((d) => d?.id ?? '(no id)').join(', ')
    log(`wave ${N}: dropped ${duplicateDrafts.length} duplicate draft(s) from this batch: ${names}`)
    degrade({ label: ranTier === 3 ? `boundary:w${N}` : `triage:w${N}`, model: ranTier === 3 ? 'fable' : 'opus',
      phase: 'Persist', kind: 'duplicate-draft',
      what: `the wave-${N} boundary filed ${duplicateDrafts.length} draft(s) already present in the same batch ` +
        `(${names}) — dropped, not suffixed into a second unit` })
  }
  const prepared = uniqueSkeletons.map((s) => ({ ...s, id: freshId(s.id, s.supersedes) }))

  return { prepared, reviseList, cutUnitIds, journal, debtLedger, arcCompleteFlag,
    feedbackDispositions: triageResult?.feedback ?? [] }
}

// Everything a boundary's decisions must leave ON DISK: specs, the merged plan, the issue
// projection, the debt ledger and the architect journal. Hoisted out of the wave tail so the
// ESCALATING returns can stage before handing back — arc-observed: a tier-3 needs-user return
// jumped every one of these, and the boundary's new-unit skeletons, the wave's debt and the journal
// survived only in the run's journal.jsonl. Returns the debt items whose banking could NOT be
// confirmed; the caller decides what to do with them, and never clears blind.
async function stage(N, ranTier, c) {
  const { prepared, reviseList, cutUnitIds, journal, debtLedger } = c
  // 7. Materialize — Sonnet renders every new skeleton to a spec, revises where asked; then merge.
  phase('Spec-expand')
  await Promise.all(prepared.map((s) => run(specExpandPrompt(s), { model: 'sonnet', label: `spec-expand:${s.id}`, phase: 'Spec-expand', schema: S.ok }).catch(() => null)))
  await Promise.all(reviseList.map((r) => run(specRevisePrompt(r), { model: 'sonnet', label: `spec-revise:${r.id}`, phase: 'Spec-expand', schema: S.ok }).catch(() => null)))
  mergePlan(prepared, cutUnitIds)

  // Issue mode: open a roadmap:unit tracking issue for each new unit added this wave (fix-units and
  // respecs), idempotent by marker, so the harness's per-unit sync clauses have an issue to edit next
  // wave. It reports each unit's issue number back, and we CACHE it into plan.units[].issue: without
  // that, a mid-arc unit has no cached number, gets dropped from the arc-issue task-list rollup (the
  // sweep skips unknown-number units), and forces a marker-search fallback in every folded clause.
  // One Haiku call, only when there is new work; a no-op / '' path in file mode.
  if (issueMode && prepared.length) {
    const opened = await run(
      STRICT + GH_BEST_EFFORT + MARKER_RULE +
      `Open a GitHub tracking issue for each new roadmap unit added in wave ${N}, idempotently. For each unit ` +
      `below: run \`${markerFind('roadmap:unit id=<id>')}\`, substituting that unit's id in BOTH places. If it ` +
      `prints a \`<number> <state>\` pair, the issue already exists: report that number and change NOTHING about ` +
      `the issue — no duplicate, no edit, whether it is open or closed. If it prints nothing at all, the issue is ` +
      `ABSENT: create it with title "[unit] <id>", labels \`roadmap:unit,status:pending,risk:<risk>,wave:${N}\`` +
      `${inPlan.milestone ? `, assigned to milestone "${inPlan.milestone}" (\`--milestone\` takes the milestone NAME)` : ''}, and a body ` +
      `whose FIRST line is exactly \`<!-- roadmap:unit id=<id> -->\` followed by the full contents of ` +
      `${repo}/.roadmap/specs/<id>.md. Units:\n${JSON.stringify(prepared.map((s) => ({ id: s.id, risk: s.risk ?? 'low' })))}\n` +
      `Report ok:true when every unit has an issue, and in \`opened\` give each unit's {id, number} — the issue ` +
      `number you created or found — so the scheduler can cache it. Note any gh failure in detail.`,
      { model: 'haiku', effort: 'low', label: `issue-new:w${N}`, phase: 'Persist', schema: S.newIssues },
    ).catch(() => null)
    // Cache the numbers so this wave's persisted plan AND next wave's dispatchPlan carry them.
    for (const o of opened?.opened ?? []) {
      const u = plan.units.find((x) => x.id === o.id)
      if (u && Number.isInteger(o.number)) u.issue = o.number
    }
  }

  phase('Persist')
  // persist-plan: overwrite plan.json with the merged plan — but never blind. The write is
  // wholesale, so a plan.json that already carries units this run has not seen (a root edit between
  // launches, a hand-merged respec) would be destroyed with no trace. The script cannot read a file,
  // so one Haiku courier reports the on-disk unit ids and the SCRIPT decides. No merge is attempted:
  // a loud refusal is the whole ask.
  const onDisk = await run(
    STRICT + `Read the file ${repo}/.roadmap/plan.json and report facts only — change nothing. In \`ids\`, give ` +
    `the \`id\` of every entry in its top-level \`units\` array, in file order. If the file does not exist, ` +
    `report ok:true with an empty \`ids\`. If it exists but will not parse, report ok:false with the parse error ` +
    `in \`detail\` and an empty \`ids\`.`,
    { model: 'haiku', effort: 'low', label: `plan-ids:w${N}`, phase: 'Persist', schema: S.planIds },
  ).catch(() => null)
  const knownIds = new Set(plan.units.map((u) => u.id))
  const strangers = (onDisk?.ids ?? []).filter((id) => !knownIds.has(id))
  if (!onDisk?.ok)
    // A dead courier is not evidence of a conflict, but it IS evidence the check did not run. The
    // plan is the arc's spine and a stale plan.json breaks the next resume, so persist — and say so.
    degrade({ label: `plan-ids:w${N}`, model: 'haiku', phase: 'Persist', kind: 'plan-conflict',
      what: `could not read the on-disk unit ids of plan.json (${onDisk?.detail ?? 'agent died without a report'}) ` +
        '— persisting the in-memory plan unchecked' })
  if (strangers.length) {
    planConflicts.push({ wave: N, unknownUnits: strangers })
    degrade({ label: `persist-plan:w${N}`, model: 'haiku', phase: 'Persist', kind: 'plan-conflict',
      what: `.roadmap/plan.json holds ${strangers.length} unit id(s) this run has never seen ` +
        `(${strangers.join(', ')}) — REFUSED to overwrite it; the root must merge the two plans by hand` })
  } else {
    await persistVerbatim(`${repo}/.roadmap/plan.json`, JSON.stringify(plan, null, 2),
      { model: 'haiku', effort: 'low', label: `persist-plan:w${N}`, phase: 'Persist', schema: S.ok },
      ' (create parent directories if needed)')
  }

  // bank-debt: the durable technical-debt record. ISSUE MODE -> find-or-create roadmap:debt issues:
  // ONE consolidated issue per unit-with-residue, keyed arc+wave+unit (arc-observed: per-finding
  // minting produced 650+ issues in one arc, and index-keyed markers duplicated on a reordered
  // resume — the arc+wave+unit key is a pure function of stable ids, and the arc half is what stops
  // a search from matching the SAME wave number in a previous arc). FILE MODE -> a <!-- wave N --> section in
  // debt.md, ALWAYS stamped (even "no new entries" — ruling 7); per-finding lines are fine there,
  // the volume problem was issues, so the file branch is deliberately untouched.
  // Nothing is cleared until the banker says the marker is THERE. `unbanked` is what it did not
  // confirm; the caller carries it rather than dropping it.
  const unbanked = []
  const debtKind = (k) => (['correctness', 'test', 'structure', 'ergonomics'].includes(k) ? k : 'structure')
  if (issueMode) {
    const byUnit = new Map()
    for (const d of pendingDebt) {
      const k = d.unit ?? 'general'
      if (!byUnit.has(k)) byUnit.set(k, [])
      byUnit.get(k).push(d)
    }
    // marker -> the debt rows it carries, so an unconfirmed marker gives its items back verbatim.
    const rowsFor = new Map()
    const items = [
      ...[...byUnit].map(([uid, ds]) => {
        const marker = `roadmap:debt arc=${arcKey} wave=${N} unit=${uid}`
        rowsFor.set(marker, ds)
        return { marker,
          title: `[debt] ${uid}: ${ds.length} deferred item${ds.length === 1 ? '' : 's'} (wave ${N})`,
          labels: ['roadmap:debt',
            `severity:${ds.some((d) => d.severity === 'major') ? 'major' : 'minor'}`,
            ...new Set(ds.map((d) => `debt:${debtKind(d.kind)}`))].join(','),
          body: ds.map(fmtDebt).join('\n') }
      }),
      ...(debtLedger.length ? [{ marker: `roadmap:debt arc=${arcKey} wave=${N} ledger`,
        title: `[debt] wave ${N} triage ledger (${debtLedger.length} item${debtLedger.length === 1 ? '' : 's'})`,
        labels: 'roadmap:debt', body: debtLedger.map((s) => `- ${s}`).join('\n') }] : []),
    ]
    if (items.length) {
      const res = await run(
        STRICT + GH_BEST_EFFORT + MARKER_RULE +
        `Project wave-${N} technical debt into GitHub issues, idempotently. For EACH item below run ` +
        `\`${markerFind('<marker>')}\`, substituting that item's marker in BOTH places. If it prints a ` +
        `\`<number> <state>\` pair the item is already banked: leave that issue completely untouched. If it ` +
        `prints nothing at all, create the issue with the item's title, comma-joined labels, and a body whose ` +
        `FIRST line is exactly \`<!-- <marker> -->\` followed by the item body. Items:\n${JSON.stringify(items)}\n` +
        `Report ok:true when every item is present, and in \`banked\` give one {marker, number} entry for each ` +
        `item you have CONFIRMED is now present on an issue — its own marker, verbatim, and that issue's number. ` +
        `Omit any item you could not confirm rather than guessing: an omitted marker is re-banked next wave, a ` +
        `wrongly-claimed one is lost. Note any gh failure in detail.`,
        { model: 'haiku', effort: 'low', label: `bank-debt:w${N}`, phase: 'Persist', schema: S.banked },
      ).catch(() => null)
      const confirmed = new Set((res?.banked ?? []).map((b) => b.marker))
      for (const it of items) if (!confirmed.has(it.marker)) unbanked.push(...(rowsFor.get(it.marker) ?? []))
    }
  } else {
    const debtLines = [...pendingDebt.map(fmtDebt), ...debtLedger.map((s) => `- ${s}`)]
    const debtBody = debtLines.length ? debtLines.join('\n') : `wave ${N}: no new entries`
    // One section for the whole wave, so the write landing IS the confirmation: no ok, nothing banked.
    const res = await run(
      STRICT + `In the file ${repo}/.roadmap/debt.md (create it if missing): ensure exactly one section marked ` +
      `\`<!-- wave ${N} -->\`. If a section with that exact marker already exists, replace its body; otherwise ` +
      `append a new one at the end of the file. The section must be exactly:\n<!-- wave ${N} -->\n${debtBody}\n\n` +
      `Change nothing else in the file.`,
      { model: 'haiku', effort: 'low', label: `bank-debt:w${N}`, phase: 'Persist', schema: S.ok },
    ).catch(() => null)
    if (!res?.ok) unbanked.push(...pendingDebt)
  }
  if (unbanked.length)
    degrade({ label: `bank-debt:w${N}`, model: 'haiku', phase: 'Persist', kind: 'debt-unbanked',
      what: `${unbanked.length} of ${pendingDebt.length} debt item(s) were not confirmed banked — kept in ` +
        'state.debt and .roadmap/debt.json, and re-banked at the next boundary' })

  // log-append: architect journal, ONLY when tier 3 ran (terminal tier-3 paths write it
  // before their own returns — see writeJournal).
  if (ranTier === 3) await writeJournal(N, journal)

  return { unbanked }
}

// Reason-specific brief fields for the return envelope. Hoisted (function declaration) so the
// tier-2/3 escalation returns above can call it before its textual position.
function briefFor(reason, P, N, triageResult, boundaryPlan, census) {
  if (reason === 'contingent-replan') return { edges: P.crossedContingent }
  if (reason === 'contract-amendment') return { debt: P.contractDebt, contracts: contractPaths() }
  if (reason === 'needs-user') return { question: (boundaryPlan?.notes ?? triageResult?.notes ?? ''), context: { wave: N, findings: P.findings, userFeedback: P.userFeedback } }
  return {}
}
