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
const { plan: inPlan, state: inState, config: overrides, harnessPath } = A
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
  ...(inPlan.config?.conductor ?? {}),
  ...(overrides?.conductor ?? {}),
}

const repo = inPlan.repoPath   // absolute path to the repository (agents read .roadmap/ here)

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

// Skill-defect ledger — the orchestrator misbehaving, not the product (same idiom as harness.mjs).
// Seeded arc-cumulative from the passed state so a mid-arc relaunch extends the record rather than
// erasing it, and merged with whatever the child harness reports. The root renders it to
// .roadmap/skill-feedback.md; the conductor also stamps it there at every persist point, because a
// run that dies never returns and its evidence would otherwise die with it.
const degradations = [...(inState.degradations ?? [])]
const degrade = (o) => {
  degradations.push({ script: 'conductor', wave: state?.wave ?? 0, ...o })
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
const STRICT = 'Start by `cd` to the exact absolute path named in this task — if the cd fails or the directory ' +
  'is not the described git checkout, report ok/pass as false with the exact error and stop. Never substitute ' +
  'your current working directory, the enclosing project, or any other repository. '
// EVERY prompt whose schema carries a maxLength must also carry this (same const as harness.mjs).
// A cap is a contract with the model, and the prompt is the only place that contract is stated — a
// capped field with no matching instruction is a trap. Arc-observed: this prompt set had a 600-char
// `notes` cap, no terseness clause, and a closing line inviting the agent to put overflow THERE. It
// overran, exhausted its schema-retries, and died at two consecutive boundaries. See RATIONALE §9.
const TERSE = 'Keep every free-text field terse — an oversized report fails schema validation and the work is ' +
  'lost. Free-text fields are for what the structured fields cannot carry, not a transcript of your reasoning. ' +
  'Respect every character budget named below exactly, and emit no field the schema does not define — an ' +
  'unexpected key is rejected as hard as an over-long one. '
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
  journal: { type: 'string', maxLength: 1500 },
  escalate: { type: 'boolean' },
  escalateReason: oneOf(['contract-amendment', 'contingent-replan', 'needs-user', 'cut-line', 'none']),
  arcComplete: { type: 'boolean' },
  notes: { type: 'string', maxLength: 2000 },   // pressure-release — see S_triage.notes
}, ['newUnits', 'journal', 'escalate', 'arcComplete'])

const S = { ok: obj({ ok: { type: 'boolean' }, detail: { type: 'string' } }, ['ok']) }

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
  const findings = [...(explorer.findings ?? []), ...(health.findings ?? []), ...(design.findings ?? [])]
  const healthFixUnits = [...(health.fixUnits ?? []), ...(design.fixUnits ?? [])]
  const flakeFlips = flake.flips ?? []
  const userFeedback = census.pendingUserFeedback ?? []
  const anyJudgment = findings.length > 0 || flakeFlips.length > 0 || nonContractDebt.length > 0 || userFeedback.length > 0
  return { crossedContingent, contractDebt, nonContractDebt, quarantined, findings, healthFixUnits, drafts: healthFixUnits, flakeFlips, userFeedback, anyJudgment }
}

// A health-assessor fix-unit draft {id, goal, files, acceptance} -> a default skeleton
// (risk 'low', kind 'code'). `files` rides along for the spec prompt only.
const draftSkeleton = (d) => ({
  id: d.id, title: (d.goal ?? d.id).slice(0, 120), risk: 'low', kind: 'code',
  goal: d.goal ?? '', constraints: '', contractRefs: [], acceptance: d.acceptance ?? [], edges: [], files: d.files ?? [],
})

const contractPaths = () => [...new Set(plan.edges.filter((e) => e.contract).map((e) => e.contract))]

// .roadmap/skill-feedback.md — the ORCHESTRATOR's own defect log, and the one artifact meant to
// leave this repo: the user carries it back to the skill's own repo. It is therefore a LIVING doc
// (like constraints.md / debt.md), never archived with the arc, and strictly separate from debt.md
// (product imperfections, a different audience). Written at EVERY persist point, not just on
// return, because a run that dies never returns and its evidence would die with it. Rendering is a
// pure function of `degradations`, so a resume rewrites it byte-identically.
const fmtDegradation = (d) =>
  `- **${d.kind ?? 'unknown'}** \`${d.label ?? 'agent'}\` (${d.script ?? '?'} · ${d.model ?? '?'} · wave ${d.wave ?? '?'}` +
  `${d.phase ? ` · ${d.phase}` : ''}) — ${d.what ?? ''}`
async function writeSkillFeedback() {
  if (!degradations.length) return
  const body = degradations.map(fmtDegradation).join('\n')
  await run(
    STRICT + `Overwrite the file ${repo}/.roadmap/skill-feedback.md with exactly this content and nothing else ` +
    `(create it if missing):\n# Skill feedback — roadmap-orchestrator\n\nDefects in the ORCHESTRATOR itself ` +
    `(not the product) observed while running this arc. Carry these back to the skill's repository; they are ` +
    `not product debt and do not belong in debt.md.\n\n## Degradations (${degradations.length})\n\n${body}\n\n` +
    `Each line names the agent label — find its transcript in the workflow's agent-*.jsonl to see the real ` +
    `error, which the platform does not expose to the script.\n`,
    { model: 'haiku', effort: 'low', label: 'skill-feedback', phase: 'Persist', schema: S.ok },
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
  if (degradations.length) st.degradations = degradations
  phase('Persist')
  await writeSkillFeedback()
  await run(
    STRICT + `Overwrite the file ${repo}/.roadmap/state.json with exactly this JSON and nothing else:\n${JSON.stringify(st, null, 2)}`,
    { model: 'haiku', effort: 'low', label: `persist-state:w${st.wave}`, phase: 'Persist', schema: S.ok },
  ).catch(() => null)
  return {
    status: 'conductor-return', reason, wave: st.wave, wavesRun, state: st, plan,
    spendDelta: deltaSpend(st.spend),
    // Always present (empty when clean) so the root never has to wonder whether the run was healthy.
    degradations,
    ...extra,
  }
}

/* --------------------------- boundary prompts -------------------------- */
// Deterministic functions of repo path + wave N + the JSON of in-memory structured data. Both
// agents read architect-log.md FIRST so successive fresh agents inherit rationale.
const censusPrompt = (N) => STRICT +
  `Take a wave-${N} census of a roadmap build's feedback and quarantine folders. Do two directory listings and ` +
  `report filenames only — read no file contents, change nothing:\n` +
  `1) List the files directly under ${repo}/.roadmap/feedback/user/, EXCLUDING TEMPLATE.md — put their basenames ` +
  `in \`pendingUserFeedback\` (empty array if that directory is absent or holds only TEMPLATE.md).\n` +
  `2) List the *.md files under ${repo}/.roadmap/quarantine/ — put their basenames in \`quarantineDossiers\` ` +
  `(empty array if absent).\nReport ok:true when both listings completed. Never guess filenames. Keep ` +
  `\`detail\` to one sentence (max 300 characters). ${TERSE}`

// The cut-line brake is load-bearing (arc-observed, RATIONALE §7): a healthy assessor drafts
// something EVERY wave, so an admit-by-default triage with no brake never dries — one live run
// admitted fresh test-ergonomics drafts on waves 3/4/5 and returned max-waves. Don't soften it.
const opusTriagePrompt = (N, P) =>
  `You are the wave-${N} boundary triager for a roadmap build, standing in for the architect. Read, in this order: ` +
  `${repo}/.roadmap/architect-log.md FIRST (inherited rationale + dismissal criteria), then ` +
  `${repo}/.roadmap/state.json, ${repo}/.roadmap/plan.json, ${repo}/.roadmap/debt.md, this wave's feedback at ` +
  `${repo}/.roadmap/feedback/{explorer,health}/wave-${N}.md plus any user notes under ` +
  `${repo}/.roadmap/feedback/user/, and the specs/contracts under ${repo}/.roadmap/{specs,contracts} as needed. ` +
  `The wave's structured boundary evidence (authoritative — the files are for detail):\n` +
  `${JSON.stringify({ findings: P.findings, drafts: P.healthFixUnits, flakeFlips: P.flakeFlips, debt: P.nonContractDebt, userFeedback: P.userFeedback })}\n` +
  `Weigh explorer/health findings, dispose of debt and non-contract feedback, and decide which health-assessor ` +
  `fix-unit DRAFTS to admit. ` +
  `${(plan.designAuthorities ?? []).length ? 'A design-fidelity finding (severity bug | adoption-gap | irreconcilable) means a screen that MERGED has drifted from the comp that governs it: the default vehicle is a fix unit, and an "irreconcilable" one is never yours to cut — escalate it, because it means built behaviour and design cannot both stand and only the architect can choose. ' : ''}` +
  `Drafts are the default action — admit them (list ids in \`admit\`) unless they are ` +
  `noise, in which case \`cut\` them with a reason; author any additional new unit you want as a full skeleton in ` +
  `\`promote\`. THE CUT LINE BINDS THE DEFAULT — a healthy assessor drafts something every wave, so admitting by ` +
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
  `${JSON.stringify({ quarantined: P.quarantined, findings: P.findings, drafts: P.healthFixUnits, debt: P.nonContractDebt })}\n` +
  `Route each quarantined unit by its dossier REASON: environment/tooling-blocked -> re-run as-is (prefer ` +
  `instructing the provisioning fix via the \`journal\` plus a fresh \`newUnit\` carrying the SAME spec under a NEW ` +
  `id); unsatisfiable-as-written -> respec under a NEW id; otherwise split or revise. NEVER reuse a failed or ` +
  `quarantined id. Emit new work as full skeletons in \`newUnits\` (each with a NEW kebab id), spec adjustments in ` +
  `\`reviseSpecs\`, and units to drop below the cut line in \`cutUnits\`. Whenever a \`newUnit\` REPLACES a ` +
  `quarantined unit, set its \`supersedes\` field to that unit's id so the failed unit is retired and its edges ` +
  `repoint to the replacement — never leave a replaced quarantine active; a quarantine you abandon without ` +
  `replacing goes in \`cutUnits\`. Append a concise architect \`journal\` ` +
  `entry (decisions + rationale + watch-list) so the next fresh boundary agent inherits your reasoning. You may ` +
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
    plan.units.push({ id: s.id, title: (s.title ?? s.id).slice(0, 120), risk: s.risk ?? 'low', kind: s.kind ?? 'code', inScope: true })
  }
  for (const s of prepared) for (const e of s.edges ?? []) {
    const from = kebab(e.from)
    if (!plan.units.some((u) => u.id === from)) continue
    plan.edges.push({ from, to: s.id, type: e.type ?? 'semantic', mode: e.mode ?? 'contract', ...(e.contract ? { contract: e.contract } : {}) })
  }
}

const fmtDebt = (d) => typeof d === 'string'
  ? `- ${d}`
  : `- [${d.kind ?? 'quality'}/${d.severity ?? 'minor'}] ${d.what ?? ''}${d.why ? ` — ${d.why}` : ''}${d.unit ? ` (${d.unit})` : ''}`

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
    const estimate = 8 + dispatchable.length * CC.perUnitCallEstimate
    if (runLocalCalls + estimate + CC.agentBudgetReserve > 1000)
      return await ret('agent-budget', null, { nextWaveUnits: dispatchable.map((u) => u.id), estimate })
  }

  // 3. Dispatch the wave through the harness. Config is passed UNTOUCHED; boundary:'off' is never
  //    set here (ruling 1). The returned state threads forward (units/spend/wave accumulate).
  phase('Wave')
  state = await workflow({ scriptPath: harnessPath }, { plan: dispatchPlan, state, config: overrides, harnessPath })
  wavesRun++
  const N = state.wave
  // Absorb the wave's skill defects into the arc-cumulative ledger (the harness reports per-wave).
  for (const d of state.degradations ?? []) degradations.push(d)
  if (state.degradations?.length) log(`wave ${N}: ${state.degradations.length} harness degradation(s) recorded`)

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

  let tier
  if (P.quarantined.length || (CC.boundaryTriage === 'always-fable' && P.anyJudgment)) tier = 3
  else if (P.anyJudgment || (CC.fixUnitAdmit === 'triage' && P.drafts.length)) tier = 2
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
      { model: 'opus', effort: 'high', label: `triage:w${N}`, phase: 'Triage-opus', schema: S_triage })
    if (!triageResult) return await degraded()
    if (triageResult.escalate) {
      const er = triageResult.escalateReason
      if (er === 'quarantine-redesign' || er === 'hard-call') {
        tier = 3   // hand to the Fable boundary agent, carrying the Opus assessment as a lead
        opusLead = ` A first-pass Opus boundary triage could not clear this itself (escalation trigger "${er}"). ` +
          `Use its assessment as a lead to confirm or overturn — not as ground truth: ` +
          `${JSON.stringify({ admit: triageResult.admit, cut: triageResult.cut, notes: triageResult.notes })}.`
      } else if (er === 'contract-amendment' || er === 'contingent-replan' || er === 'needs-user') {
        return await ret(er, 2, briefFor(er, P, N, triageResult, null, census))
      }
    }
  }

  // Tier 3 — Fable boundary agent (quarantine respecs + Opus escalations).
  if (tier === 3) {
    phase('Triage-fable')
    cSpend.boundaryFables++
    boundaryPlan = await runOr(null, fableBoundaryPrompt(N, P, opusLead),
      { model: 'fable', effort: 'low', label: `boundary:w${N}`, phase: 'Triage-fable', schema: S_boundaryPlan })
    if (!boundaryPlan) return await degraded()
    if (boundaryPlan.escalate) {
      const er = boundaryPlan.escalateReason
      if (er === 'contract-amendment' || er === 'contingent-replan' || er === 'needs-user')
        return await ret(er, 3, briefFor(er, P, N, triageResult, boundaryPlan, census))
      if (er === 'cut-line') return await finish(3)
    }
  }
  const ranTier = tier

  // Collect the wave's mutations from whichever tier ran.
  const freshId = makeFreshId()
  let newSkeletons = []
  let reviseList = []
  let cutUnitIds = []
  let journal = null
  let arcCompleteFlag = false
  let feedbackDispositions = triageResult?.feedback ?? []
  let debtLedger = []

  if (ranTier === 1) {
    newSkeletons = P.healthFixUnits.map(draftSkeleton)
  } else if (ranTier === 2) {
    arcCompleteFlag = !!triageResult.arcComplete
    const draftById = new Map(P.healthFixUnits.map((d) => [d.id, d]))
    newSkeletons = [
      ...(triageResult.admit ?? []).filter((id) => draftById.has(id)).map((id) => draftSkeleton(draftById.get(id))),
      ...(triageResult.promote ?? []),
    ]
    debtLedger = triageResult.debtLedger ?? []
  } else {
    arcCompleteFlag = !!boundaryPlan.arcComplete
    newSkeletons = boundaryPlan.newUnits ?? []
    reviseList = boundaryPlan.reviseSpecs ?? []
    cutUnitIds = boundaryPlan.cutUnits ?? []
    journal = boundaryPlan.journal
    debtLedger = boundaryPlan.debtLedger ?? []
  }

  // Assign final ids up front so spec files and plan units agree.
  const prepared = newSkeletons.map((s) => ({ ...s, id: freshId(s.id, s.supersedes) }))

  // Arc complete: a tier said so, or the boundary produced no new units and no spec revisions.
  // Routed through finish(), which refuses to close over dispatchable work.
  if (arcCompleteFlag || (prepared.length === 0 && reviseList.length === 0))
    return await finish(ranTier)

  // 7. Materialize — Sonnet renders every new skeleton to a spec, revises where asked; then merge.
  phase('Spec-expand')
  await Promise.all(prepared.map((s) => run(specExpandPrompt(s), { model: 'sonnet', label: `spec-expand:${s.id}`, phase: 'Spec-expand', schema: S.ok }).catch(() => null)))
  await Promise.all(reviseList.map((r) => run(specRevisePrompt(r), { model: 'sonnet', label: `spec-revise:${r.id}`, phase: 'Spec-expand', schema: S.ok }).catch(() => null)))
  mergePlan(prepared, cutUnitIds)

  // 8. Persist (all awaited before the next dispatch; idempotent by wave-N markers for resume).
  phase('Persist')
  const waveDebt = state.debt ?? []   // captured before the consumed state clears it
  // Consumed continuation state: boundary removed + debt cleared (folded), conductor.reason null.
  const consumed = { ...state, spend: { ...(state.spend ?? {}) } }
  if (state.boundary) { lastBoundary = state.boundary; lastBoundaryWave = N }
  delete consumed.boundary
  consumed.debt = []
  mergeConductorSpend(consumed)
  boundaries.push({ wave: N, tier: ranTier, escalated: null })
  consumed.conductor = { reason: null, wavesRun, boundaries }
  // Skill defects are NOT consumed like debt — they are arc-cumulative and outlive the arc.
  if (degradations.length) consumed.degradations = degradations
  await writeSkillFeedback()

  // persist-plan: overwrite plan.json with the merged plan.
  await run(
    STRICT + `Overwrite the file ${repo}/.roadmap/plan.json with exactly this JSON and nothing else (create parent directories if needed):\n${JSON.stringify(plan, null, 2)}`,
    { model: 'haiku', effort: 'low', label: `persist-plan:w${N}`, phase: 'Persist', schema: S.ok },
  ).catch(() => null)

  // bank-debt: stamp a wave-N section into debt.md ALWAYS (even "no new entries" — ruling 7).
  const debtLines = [...waveDebt.map(fmtDebt), ...debtLedger.map((s) => `- ${s}`)]
  const debtBody = debtLines.length ? debtLines.join('\n') : `wave ${N}: no new entries`
  await run(
    STRICT + `In the file ${repo}/.roadmap/debt.md (create it if missing): ensure exactly one section marked ` +
    `\`<!-- wave ${N} -->\`. If a section with that exact marker already exists, replace its body; otherwise ` +
    `append a new one at the end of the file. The section must be exactly:\n<!-- wave ${N} -->\n${debtBody}\n\n` +
    `Change nothing else in the file.`,
    { model: 'haiku', effort: 'low', label: `bank-debt:w${N}`, phase: 'Persist', schema: S.ok },
  ).catch(() => null)

  // log-append: architect journal, ONLY when tier 3 ran (replace-if-header-exists idempotency).
  if (ranTier === 3 && journal)
    await run(
      STRICT + `In the file ${repo}/.roadmap/architect-log.md (create it if missing): ensure exactly one section ` +
      `headed \`## Wave ${N}\`. If that exact header already exists, replace its body; otherwise append it at the ` +
      `end. The section body is:\n${journal}\n\nChange nothing else in the file.`,
      { model: 'haiku', effort: 'low', label: `log-append:w${N}`, phase: 'Persist', schema: S.ok },
    ).catch(() => null)

  // move-feedback: consumed user notes + this wave's explorer/health renderings -> triaged/N/.
  const consumedFiles = feedbackDispositions.filter((f) => f.action === 'actioned' || f.action === 'dismissed').map((f) => f.file)
  await run(
    STRICT + `Move consumed wave-${N} feedback into ${repo}/.roadmap/feedback/triaged/${N}/ (create that directory). ` +
    `Move these files if they exist — skip any that are missing (this is idempotent): ` +
    `${repo}/.roadmap/feedback/explorer/wave-${N}.md, ${repo}/.roadmap/feedback/health/wave-${N}.md, ` +
    `${repo}/.roadmap/feedback/design/wave-${N}.md` +
    `${consumedFiles.length ? `, and these user notes from ${repo}/.roadmap/feedback/user/: ${consumedFiles.join(', ')}` : ''}. ` +
    `Use \`git mv\` when possible, else \`mv\`. Create no other files and move nothing else.`,
    { model: 'haiku', effort: 'low', label: `move-feedback:w${N}`, phase: 'Persist', schema: S.ok },
  ).catch(() => null)

  // persist-state: the consumed state + conductor block.
  await run(
    STRICT + `Overwrite the file ${repo}/.roadmap/state.json with exactly this JSON and nothing else:\n${JSON.stringify(consumed, null, 2)}`,
    { model: 'haiku', effort: 'low', label: `persist-state:w${N}`, phase: 'Persist', schema: S.ok },
  ).catch(() => null)

  state = consumed   // thread the consumed state into the next wave
}

// Loop exhausted without an arc-complete / early return -> relaunch fresh (resets the agent counter).
// Hand back the last wave's boundary (see lastBoundary): the root needs the same evidence here as on
// any other terminal return. Marked `triaged` because, unlike a true terminal boundary, this one was
// already dispositioned — its findings are banked and its feedback moved, so re-actioning it would
// duplicate the ladder's work.
if (lastBoundary) state = { ...state, boundary: { ...lastBoundary, triaged: true, wave: lastBoundaryWave } }
return await ret('max-waves', null, {})

// Reason-specific brief fields for the return envelope. Hoisted (function declaration) so the
// tier-2/3 escalation returns above can call it before its textual position.
function briefFor(reason, P, N, triageResult, boundaryPlan, census) {
  if (reason === 'contingent-replan') return { edges: P.crossedContingent }
  if (reason === 'contract-amendment') return { debt: P.contractDebt, contracts: contractPaths() }
  if (reason === 'needs-user') return { question: (boundaryPlan?.notes ?? triageResult?.notes ?? ''), context: { wave: N, findings: P.findings, userFeedback: P.userFeedback } }
  return {}
}
