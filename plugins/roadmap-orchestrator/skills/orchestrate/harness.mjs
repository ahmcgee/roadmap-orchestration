export const meta = {
  name: 'roadmap-wave',
  description: 'Execute one wave of a roadmap plan: per-unit build/gate pipelines and a serial merge queue',
  phases: [
    { title: 'Setup', detail: 'integration + unit worktrees' },
    { title: 'Implement', detail: 'plan + code (Opus)' },
    { title: 'Architect', detail: 'escalated plan-check + exit gate (Fable)' },
    { title: 'Opus-gate', detail: 'Opus exit gate; escalates to Fable when hard' },
    { title: 'Verify', detail: 'build/tests (Haiku)' },
    { title: 'Review', detail: 'adversarial review (Opus)' },
    { title: 'Fix', detail: 'apply findings/directives (Opus)' },
    { title: 'Escalate', detail: 'rescue consults (Fable, capped)' },
    { title: 'Merge', detail: 'serial queue + integrated suite gate' },
    { title: 'Preview', detail: 'green-tip mirror advance (Haiku)' },
    { title: 'Quarantine', detail: 'dossiers for redesign' },
    { title: 'Boundary', detail: 'wave-tail explorer + health assessor (Opus) + flake re-runs' },
  ],
}

/* ------------------------------------------------------------------------
 * Inputs. This script has no filesystem access: the main loop reads
 * .roadmap/plan.json and .roadmap/state.json and passes them in as args.
 * Shapes: reference.md. Every call pins its model explicitly — agents would
 * otherwise inherit the main-loop model (frontier) silently. All delegations go
 * through run(), a thin wrapper that also tallies per-tier spend for the report.
 * Prompts are deterministic functions of unit ids and shas so that
 * resumeFromRunId can replay completed calls from the journal.
 * ---------------------------------------------------------------------- */
// args can arrive JSON-stringified depending on how the caller encoded them — tolerate both.
// (Observed in smoke testing: a stringified args object makes every destructured field
// `undefined`, and undefined paths in prompts make agents improvise in their cwd.)
const A = typeof args === 'string' ? JSON.parse(args) : args
const { plan, state: prior, config: overrides } = A
const C = {
  maxFixRounds: 2,
  maxGateRounds: 2,
  maxConsults: 3,
  minBlockConfidence: 0.6,
  gateEffort: 'medium',
  planCheckRisk: ['low', 'med', 'high'],
  previewRefresh: 'merge',   // 'merge' | 'wave' | 'off' — inert without a plan.preview block
  // Frontier economy: Fable is the metered tier, so Opus grades first everywhere and escalates
  // only on a genuinely hard call. The plan-check is Opus-first (see below) unless
  // planCheck === 'always-fable'; the exit gate is Opus-first unless exitGate === 'always-fable'.
  // High-risk and contract-touching units always take the Fable gate regardless; gateAuditRate
  // deterministically samples a fraction of Opus-approved units for a Fable audit (0 disables),
  // and audit-only forced gates run at the cheaper auditEffort.
  planCheck: 'opus-first',   // 'opus-first' | 'always-fable'
  exitGate: 'opus-first',    // 'opus-first' | 'always-fable'
  gateAuditRate: 0.10,
  auditEffort: 'low',
  boundary: 'on',            // 'on' | 'off' — wave-tail explorer + health assessor inside the
                             //   workflow; 'off' for the arc's final wave (the session
                             //   integration review supersedes it)
  healthCheck: 'each-wave',  // 'each-wave' | 'off' — the health-assessor half of the boundary
  flakeReruns: 3,            // full-suite re-runs hunting intermittents; 0 disables
  ...(plan.config ?? {}),
  ...(overrides ?? {}),
}
const repo = plan.repoPath          // absolute path to the repository
const wtRoot = plan.worktreeRoot    // absolute path OUTSIDE the repository
const intBranch = prior.integrationBranch
const intWt = `${wtRoot}/__integration`
// Preview process artifacts live OUTSIDE the repo so mirror checkouts never touch them.
const prevPid = `${wtRoot}/__preview.pid`
const prevLog = `${wtRoot}/__preview.log`
// Preview process control, shared by first setup and every mirror restart. setsid makes the
// recorded pid a process-group leader so stop can kill the whole tree, not just the parent —
// a single-pid kill strands child listeners and leaves ports held. All best-effort.
const previewStartCmd = (start) => `\`setsid nohup ${start} > ${prevLog} 2>&1 & echo $! > ${prevPid}\``
// Eval-observed: repeating the long pidfile path buries the STRICT preamble's cd target, so
// the stop text names it exactly once and uses pronouns after.
const previewStopCmd =
  `kill the whole preview process group recorded in the pidfile at ${prevPid}, if that file exists: ` +
  `\`kill -TERM -- -$(cat <pidfile>)\` (the leading minus targets the group), falling back to \`pkill -g\` on ` +
  `the same pid and then a plain \`kill\` of it; ignore all kill errors, then delete the pidfile`
const previewSweepRetry =
  `If the start or its healthcheck fails because a port is already in use, sweep leftover listeners exactly once ` +
  `(kill the old pidfile's process group if ${prevPid} exists, otherwise \`fuser -k\` / \`lsof\` the preview's ` +
  `ports), retry the start once, then report ok:false with the exact error. `
const specOf = (u) => `${repo}/.roadmap/specs/${u.id}.md`
const wtOf = (u) => `${wtRoot}/${u.id}`
// Location discipline for mechanical agents: smoke testing showed that given a bad path
// they improvise in their cwd and report plausible success. Fail-loud beats adaptive.
const STRICT = 'Start by `cd` to the exact absolute path named in this task — if the cd fails or the directory ' +
  'is not the described git checkout, report ok/pass as false with the exact error and stop. Never substitute ' +
  'your current working directory, the enclosing project, or any other repository. '
// Report discipline for the code-writing agents: commit first (the commit is the deliverable,
// and it is what makes a killed unit recoverable), then keep the structured report short. The
// platform's schema-retry resends an over-long payload verbatim until the unit dies, so an
// oversized report can waste all the work it describes.
const REPORT = 'Commit your work BEFORE emitting the structured report — the commit is the deliverable. Then keep ' +
  'the report tight: `summary` in 2–3 short sentences, every other free-text field terse. An oversized report ' +
  'fails validation and can kill this unit even though the work is done. '
// .roadmap/ belongs to the orchestrator, never to a coding agent. Arc-observed: an
// implementer that respected the write-bar still left a "see debt.md" comment for an
// entry it could not write, and a gate quarantined partly on the phantom reference.
const NOROADMAP = `You cannot create or modify anything under ${repo}/.roadmap/ — that directory is the ` +
  `orchestrator's. Never leave code comments or commit messages referencing debt-ledger or dossier entries: ` +
  `you cannot write those entries, so the reference would be fabricated. Report deviations and deferred ` +
  `imperfections ONLY through your structured output fields. `
const sameSha = (a, b) => !!a && !!b && (a.trim().startsWith(b.trim()) || b.trim().startsWith(a.trim()))
const brief = plan.briefPath ?? `${repo}/.roadmap/brief.md`   // Phase-0 codebase brief: commands + conventions
// Optional standing cross-cutting conventions contract (shared-utility catalog + naming/
// error/pattern conventions). Threaded into implement/review/both gates so units enforce
// cross-unit consistency proactively; '' when absent, leaving those prompts byte-identical.
// Place it under .roadmap/contracts/ so edits to it fire the same frozen-surface escalation.
const conventions = plan.conventions
const convClause = conventions
  ? `A standing cross-cutting conventions contract at ${conventions} catalogues shared utilities every unit must ` +
    `reuse rather than reinvent and conventions (naming, error handling, recurring patterns) every unit must ` +
    `follow; treat it as a frozen contract alongside the unit's own. `
  : ''
// Per-tier spend tally, returned in the wave state so the session report can show
// where frontier attention actually went (and the dial can be tuned on evidence).
const spend = { fable: 0, opus: 0, sonnet: 0, haiku: 0, planChecks: 0, opusPlanChecks: 0, gateRounds: 0, opusGateRounds: 0 }
// Arc-cumulative semantics — relaunches accumulate instead of resetting (arc-observed: cross-crash
// tallies had to be hand-summed). Tolerant of older state files: unknown numeric keys carry over, junk drops.
for (const [k, v] of Object.entries(prior.spend ?? {}))
  if (typeof v === 'number' && Number.isFinite(v)) spend[k] = (spend[k] ?? 0) + v
// Debt ledger for this wave: consciously-deferred imperfections surfaced by the reviewer,
// the exit gates, or the implementer. Returned in the wave state; the architect triages it
// at the next boundary and appends un-promoted items to the living .roadmap/debt.md.
const debtLog = []
const addDebt = (unitId, sha, items, defaults = {}) => {
  for (const d of items ?? []) {
    if (!d) continue
    const o = typeof d === 'string' ? { what: d } : d
    debtLog.push({
      unit: unitId, sha,
      kind: o.kind ?? defaults.kind ?? 'quality',
      severity: o.severity ?? defaults.severity ?? 'minor',
      what: o.what ?? '', why: o.why ?? '',
    })
  }
}
// One code-level retry on structured-output failure: agents deep in tool-work
// occasionally end their turn without a valid structured report (observed ~1 in 15
// impl-stage calls across eval runs). A single retry with an explicit report-last
// instruction converts a unit-killing flake into an occasional double-cost call.
const run = async (prompt, opts) => {
  spend[opts.model] = (spend[opts.model] ?? 0) + 1
  try { return await agent(prompt, opts) }
  catch (e) {
    if (!String(e?.message ?? e).includes('StructuredOutput')) throw e
    spend[opts.model] = (spend[opts.model] ?? 0) + 1
    return agent(
      prompt + ' IMPORTANT: after completing the task, your final action must be a single structured-output ' +
      'report matching the requested schema — put any commentary in its `notes` field and add no other fields. ' +
      'Your previous report likely failed because it was too long — shorten every free-text field aggressively; ' +
      'one sentence each is acceptable.',
      { ...opts, label: `${opts.label ?? 'agent'}#retry` })
  }
}
// Verdict-threshold tilt by plan-time risk tier — makes `risk` bind at review/gate time.
const riskTilt = (r) =>
  r === 'high' ? 'This unit is high-risk: a missed defect ships — when in doubt, demand revision rather than approve. '
  : r === 'low' ? 'This unit is low-risk: block only on clear correctness or contract violations; do not gold-plate. '
  : ''
// Deterministic audit sampling — a stable fraction of Opus-approved units still take the
// Fable gate as an anti-rubber-stamp check. Keyed on the unit id so it is a pure function
// (no Date.now/Math.random — those are forbidden and would break resumeFromRunId replay).
const hashUnit = (id) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h }
const auditPick = (unit) => C.gateAuditRate > 0 && (hashUnit(unit.id) % 1000) < Math.round(C.gateAuditRate * 1000)

/* ------------------------------- schemas ------------------------------- */
const obj = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })
const arr = (t) => ({ type: 'array', items: { type: t } })
const oneOf = (vals) => ({ type: 'string', enum: vals })
// Deferred-imperfection items — consciously accepted, not blocking. Collected into the
// wave's debt ledger. `what` is the only hard requirement; the rest classify for triage.
const debtArr = { type: 'array', items: obj({
  what: { type: 'string', maxLength: 400 }, why: { type: 'string', maxLength: 400 },
  severity: oneOf(['minor', 'major']), kind: oneOf(['correctness', 'test', 'structure', 'ergonomics']),
}, ['what']) }
const directiveArr = { type: 'array', items: obj({ what: { type: 'string' }, why: { type: 'string' } }, ['what', 'why']) }
const S = {
  ok: obj({ ok: { type: 'boolean' }, detail: { type: 'string' } }, ['ok']),
  ws: obj({ ok: { type: 'boolean' }, sha: { type: 'string' }, detail: { type: 'string' } }, ['ok', 'sha']),
  // Unit-worktree setup outcome. `state` drives the destructive-re-run guards: 'already-merged'
  // and 'has-commits' touch nothing; 'adopted' enters the pipeline at verify; 'ready' is fresh.
  setup: obj({ ok: { type: 'boolean' }, sha: { type: 'string' },
    state: oneOf(['ready', 'already-merged', 'adopted', 'has-commits']), detail: { type: 'string' } },
    ['ok', 'sha', 'state']),
  // `feasible:false` is the planner's escape valve for an unsatisfiable spec — without
  // it, an agent that correctly refuses to build has no legal output (eval-observed).
  // Optional `notes` on the tight schemas is a pressure-release: with
  // additionalProperties:false and no free-text field, agents with something unusual to
  // report emit extra keys and burn the structured-output retry cap (eval-observed).
  plan: obj({
    approach: { type: 'string' }, files: arr('string'), testPlan: { type: 'string' },
    feasible: { type: 'boolean' }, notes: { type: 'string' },
  }, ['approach', 'files', 'testPlan', 'feasible']),
  planVerdict: obj({
    verdict: oneOf(['approve', 'redirect', 'quarantine']), guidance: { type: 'string' }, notes: { type: 'string' },
  }, ['verdict', 'guidance']),
  // Opus-first plan-check: approve/redirect itself, but killing a unit is frontier-only, so it
  // escalates (never quarantines) — trigger names why frontier judgment is needed on the plan.
  opusPlanVerdict: obj({
    verdict: oneOf(['approve', 'redirect', 'escalate']),
    trigger: oneOf(['uncertain', 'foundational', 'contract', 'quarantine-candidate', 'none']),
    guidance: { type: 'string' }, notes: { type: 'string' },
  }, ['verdict', 'guidance']),
  // filesChanged first so a truncated payload loses free text, not the required audit trail;
  // summary/notes capped because the platform's schema-retry resends over-long output verbatim.
  impl: obj({
    filesChanged: arr('string'),
    summary: { type: 'string', maxLength: 700 },
    // Conscious deviation from a frozen contract's *implementation* (the contract file is
    // untouchable, so contractSurfaceTouched can never see this case — arc-observed).
    // Presence fires the mid-loop architect consult and forces the Fable exit gate.
    contractMismatch: { type: 'string', maxLength: 300 },
    debt: debtArr, notes: { type: 'string', maxLength: 1000 },
  }, ['summary', 'filesChanged']),
  // Opus exit gate: approve as-is, revise (a mechanical fix Opus can specify itself), or
  // escalate to the Fable architect — trigger names the reason frontier judgment is needed.
  opusGate: obj({
    verdict: oneOf(['approve', 'revise', 'escalate']),
    trigger: oneOf(['stuck', 'hard-tradeoff', 'foundational', 'oversight', 'none']),
    directives: directiveArr, debt: debtArr, notes: { type: 'string' },
  }, ['verdict']),
  // `blocked` = the tooling itself could not run (env/deps/config) — a third outcome,
  // never conflated with a failing assertion. Routed to env-quarantine, not fix rounds.
  verify: obj({
    pass: { type: 'boolean' }, blocked: { type: 'boolean' },
    failures: arr('string'), contractSurfaceTouched: { type: 'boolean' }, notes: { type: 'string' },
  }, ['pass', 'blocked', 'failures', 'contractSurfaceTouched']),
  review: obj({
    blocking: {
      type: 'array',
      items: obj({ summary: { type: 'string' }, file: { type: 'string' }, confidence: { type: 'number' } },
        ['summary', 'confidence']),
    },
    preExisting: arr('string'),          // real issues the diff did NOT introduce — never block, flow to dossier
    nonBlocking: arr('string'),
    unsatisfiable: { type: 'boolean' },  // spec/contract contradictory as written — quarantine now, don't grind
  }, ['blocking', 'preExisting', 'nonBlocking', 'unsatisfiable']),
  gate: obj({
    verdict: oneOf(['approve', 'revise', 'quarantine']),
    directives: directiveArr, debt: debtArr,
    notes: { type: 'string' },
  }, ['verdict', 'directives']),
  directive: obj({ action: oneOf(['redirect', 'quarantine']), guidance: { type: 'string' } }, ['action', 'guidance']),
  dossier: obj({ attempted: { type: 'string' }, evidence: { type: 'string' }, hypothesis: { type: 'string' } },
    ['attempted', 'evidence', 'hypothesis']),
  merge: obj({
    merged: { type: 'boolean' }, suitePass: { type: 'boolean' },
    head: { type: 'string' }, detail: { type: 'string' },
  }, ['merged', 'suitePass', 'head', 'detail']),
  // Boundary results — capped hard: these ride in state.json and the platform's
  // schema-retry resends over-long payloads verbatim (the H-1 failure mode).
  explore: obj({
    findings: { type: 'array', maxItems: 10, items: obj({
      severity: oneOf(['blocker', 'major', 'minor', 'idea']),
      summary: { type: 'string', maxLength: 300 }, repro: { type: 'string', maxLength: 400 },
      observed: { type: 'string', maxLength: 300 }, expected: { type: 'string', maxLength: 300 },
    }, ['severity', 'summary']) },
    shaObserved: { type: 'string' }, notes: { type: 'string', maxLength: 500 },
  }, ['findings', 'shaObserved']),
  health: obj({
    findings: { type: 'array', maxItems: 12, items: obj({
      area: oneOf(['test', 'structure', 'consistency', 'ergonomics']),
      what: { type: 'string', maxLength: 400 }, where: { type: 'string', maxLength: 200 },
    }, ['area', 'what']) },
    // Ready-to-dispatch consolidation fix-unit drafts — a unit spec's shape, so boundary
    // triage admits them without re-authoring (drafts are the default action, not a suggestion).
    fixUnits: { type: 'array', maxItems: 6, items: obj({
      id: { type: 'string', maxLength: 60 }, goal: { type: 'string', maxLength: 300 },
      files: arr('string'), acceptance: arr('string'),
    }, ['id', 'goal', 'acceptance']) },
    notes: { type: 'string', maxLength: 500 },
  }, ['findings', 'fixUnits']),
  flake: obj({ runs: { type: 'number' }, flips: arr('string'), detail: { type: 'string', maxLength: 400 } },
    ['runs', 'flips']),
}

/* --------------------------- live wave state --------------------------- */
const units = new Map(Object.entries(prior.units ?? {}))
for (const u of plan.units) {
  if (!units.has(u.id)) units.set(u.id, { status: u.inScope ? 'pending' : 'deferred' })
}
let integrationTip = prior.integrationTip
let consultsUsed = prior.consultsUsed ?? 0
let inFlight = 0
let mergeChain = Promise.resolve()
let checkpointChain = Promise.resolve()
let settleWaiters = []
// Green-tip mirror (DESIGN §7.5): the PRIMARY checkout rides the latest suite-green
// integration tip so the user — and the between-wave explorer — only ever observe real
// states, never mid-merge trees. Strictly observability: every path below logs and
// continues on failure; no unit outcome may depend on the preview.
let previewStatus = plan.preview && C.previewRefresh !== 'off' ? 'pending' : 'none'
let previewSha = null
let previewTarget = null
let previewChain = Promise.resolve()
let boundary = null

const rec = (id) => units.get(id)
// Per-unit forensic breadcrumb: stamp the pipeline stage onto a running record and checkpoint.
// Guarded to `running` so a terminal result (which replaces the record wholesale) never keeps
// a stale stage — after a crash, `stage` tells you how far a running unit got.
const setStage = (id, stage) => {
  const r = units.get(id)
  if (r?.status !== 'running') return
  units.set(id, { ...r, stage })
  checkpoint()
}
const depsOf = (id) => plan.edges.filter((e) => e.to === id).map((e) => e.from)
const ready = (u) => rec(u.id).status === 'pending' && depsOf(u.id).every((d) => rec(d)?.status === 'merged')
const blockedBy = (u) => depsOf(u.id).some((d) => ['quarantined', 'blocked'].includes(rec(d)?.status))
const serialize = () => ({
  integrationBranch: intBranch, integrationTip, consultsUsed, spend,
  // Run identity ({runId, scriptPath}) set by the architect at launch — carried through so
  // same-session resume is mechanical and crash forensics are one `cat` of state.json.
  ...(prior.run ? { run: prior.run } : {}),
  preview: { sha: previewSha, status: previewStatus },
  // Debt surfaced THIS wave (not accumulated across waves): the architect triages it at the
  // boundary and appends un-promoted items to the living .roadmap/debt.md ledger.
  debt: debtLog,
  ...(boundary ? { boundary } : {}),
  wave: (prior.wave ?? 0) + 1, units: Object.fromEntries(units),
})
const notifySettle = () => { const w = settleWaiters; settleWaiters = []; w.forEach((f) => f()) }
const nextSettle = () => new Promise((r) => settleWaiters.push(r))

// Crash-safety checkpoint of the whole wave state. Coalesced latest-wins (same idiom as the
// preview mirror below): a burst of status changes collapses to a single Haiku write, since
// only the newest snapshot matters for recovery. The final `await checkpointChain` still
// guarantees the last state lands — the last queued segment observes the final target.
let checkpointTarget = null
let checkpointWritten = null
function checkpoint() {
  checkpointTarget = JSON.stringify(serialize(), null, 2)
  checkpointChain = checkpointChain.then(async () => {
    if (checkpointTarget === checkpointWritten) return   // coalesce: latest already written
    const snap = checkpointTarget
    checkpointWritten = snap
    await run(`Overwrite the file ${repo}/.roadmap/state.json with exactly this JSON and nothing else:\n${snap}`,
      { model: 'haiku', effort: 'low', label: 'checkpoint', phase: 'Setup', schema: S.ok }).catch(() => null)
  }).catch(() => null)
}

// Optional environment provisioning (plan.provision: {copy: [...gitignored files], setup: "cmd"}).
// A fresh worktree has no deps/env; without this, the test gate fails for non-code reasons.
async function provision(where, label) {
  if (!plan.provision) return { ok: true }
  const p = plan.provision
  return run(
    STRICT +
    `Provision the checkout at ${where} so its build and tests can run: ` +
    (p.copy?.length ? `copy these gitignored files from ${repo} into the same relative locations: ${p.copy.join(', ')}. ` : '') +
    (p.setup ? `Then run, from inside ${where}: ${p.setup}. ` : '') +
    `Report ok:false with the exact error if any step cannot complete.`,
    { model: 'haiku', phase: 'Setup', label, schema: S.ok })
}

// Green-tip mirror advance: detach the primary checkout at a suite-green tip and refresh
// the preview process there. Coalescing latest-wins chain — merges never wait for it, and
// an advance that finds the mirror already at target is a no-op. Failure leaves the mirror
// stale (or 'failed' at setup) and the wave continues: observability, never a gate.
const previewRestart = () => {
  const p = plan.preview
  if (p.refresh) return `Then run, from inside ${repo}: ${p.refresh}. `
  if (!p.start) return ''
  return `Then restart the preview: ${p.stop || previewStopCmd}; then start it again from inside ${repo} with ` +
    `${previewStartCmd(p.start)}. ${previewSweepRetry}`
}
const previewHealth = () => plan.preview.healthcheck
  ? `Then verify it responds: ${plan.preview.healthcheck} (retry a few times over ~15 seconds before concluding failure). `
  : ''
function refreshMirror() {
  if (previewStatus !== 'live') return
  previewTarget = integrationTip
  previewChain = previewChain.then(async () => {
    if (previewSha === previewTarget) return   // coalesce: latest-wins
    const sha = previewTarget
    const r = await run(
      STRICT +
      `In the git repository at ${repo} (the primary checkout, currently a detached-HEAD preview mirror): ` +
      `run \`git checkout --detach ${sha}\`. If git refuses (for example locally-modified files), report ` +
      `ok:false with the exact error — never stash, reset, or force. ` +
      previewRestart() + previewHealth() +
      `Report ok plus the checkout's HEAD sha.`,
      { model: 'haiku', phase: 'Preview', label: `mirror:${sha.slice(0, 7)}`, schema: S.ws },
    ).catch(() => null)
    if (r?.ok && sameSha(r.sha, sha)) previewSha = sha
    else log(`preview mirror stale (advance to ${sha.slice(0, 7)} failed: ${r?.detail ?? r?.sha ?? 'agent error'})`)
  }).catch(() => null)
}

async function quarantine(unit, reason, extra) {
  // The dossier is the redesign feed, so its content must survive any file-level mishap:
  // the investigator RETURNS findings through the schema (landing in checkpointed
  // state.json), and a separate verbatim-writer renders the file — investigative agents
  // flake on side-effects; verbatim writers don't (observed across eval runs).
  const dossierPath = `${repo}/.roadmap/quarantine/${unit.id}.md`
  const d = await run(
    `Unit ${unit.id} of a roadmap build is being quarantined (${reason}). Its spec is at ${specOf(unit)} and its ` +
    `work-in-progress lives on branch unit/${unit.id} (worktree ${wtOf(unit)}). Investigate briefly and report a ` +
    `concise redesign dossier: what was attempted, what failed (with the strongest evidence), and your best ` +
    `hypothesis for the root cause. Report your findings in the structured output — do not write any files. ` +
    `Additional context: ${JSON.stringify(extra ?? {})}`,
    { model: 'sonnet', phase: 'Quarantine', label: `dossier:${unit.id}`, schema: S.dossier },
  ).catch(() => null)
  const dossier = d ?? {
    attempted: 'investigation agent failed — raw harness evidence only',
    evidence: JSON.stringify(extra ?? {}),
    hypothesis: reason,
  }
  await run(
    `Create the file ${dossierPath} (creating parent directories as needed) with exactly this content:\n` +
    `# ${unit.id} — quarantine dossier\n\nReason: ${reason}\n\n## Attempted\n${dossier.attempted}\n\n` +
    `## Evidence\n${dossier.evidence}\n\n## Hypothesis\n${dossier.hypothesis}\n`,
    { model: 'haiku', effort: 'low', phase: 'Quarantine', label: `dossier-write:${unit.id}`, schema: S.ok },
  ).catch(() => null)
  return { status: 'quarantined', branch: `unit/${unit.id}`, reason, dossier }
}

// Wave-tail boundary phase (invariant 8: strictly after every merge and mirror advance;
// findings gate nothing — they are the NEXT boundary's triage input). In-workflow so the
// root wakes exactly once, cache warm, with explorer findings, health findings + fix-unit
// drafts, and flake flips all in the returned state (arc-observed: separately-launched
// boundary agents finishing minutes apart cost two cold full-history reloads).
async function runBoundary() {
  const waveN = (prior.wave ?? 0) + 1
  const tip = integrationTip
  const explSha = previewSha ?? tip
  const doExplore = previewStatus === 'live'
  const doHealth = C.healthCheck !== 'off'
  const [expl, hlth, flk] = await Promise.all([
    !doExplore ? null : run(
      `You are the wave-${waveN} runtime explorer for a roadmap build. The integrated result is live as a ` +
      `preview — drive it via: ${plan.preview.howToAccess}. It serves integration tip ${explSha}. Your charter ` +
      `is runtime behavior ONLY — the diff, tests, and gates already judged the code: drive flows end to end ` +
      `the way a skeptical user would, poke edge cases, feed hostile/empty/huge inputs, break expected ` +
      `sequences — hunting behavior that is unexpected, counterintuitive, underdocumented, brittle, or ` +
      `misaligned with the specs' intent (specs: ${repo}/.roadmap/specs/). Change nothing: no commits, no file ` +
      `edits, no restarts. At most 10 findings — severity, exact repro, observed vs expected; an empty report ` +
      `is legitimate and better than manufactured findings. Keep every free-text field terse — an oversized ` +
      `report fails validation. Report shaObserved: ${explSha}.`,
      { model: 'opus', effort: 'high', phase: 'Boundary', label: `explorer:w${waveN}`, schema: S.explore }
    ).catch(() => null),
    !doHealth ? null : run(
      `You are the wave-${waveN} codebase-health assessor for a roadmap build. In the integration worktree at ` +
      `${intWt} (tip ${tip}): per-unit gates each saw one unit; you own what none could see. Report with ` +
      `file-level specifics: test health — coverage gaps, slow tests, brittleness (assertions on ` +
      `implementation detail, over-mocking, order/timing dependence); structural health — files grown too ` +
      `large, misplaced code, architectural drift; cross-unit consistency — units that independently added ` +
      `equivalent helpers, diverged on the pattern for the same task, or reimplemented something ` +
      `${conventions ? `the conventions contract at ${conventions} already catalogs` : `another unit already provides`}; ` +
      `ergonomics — manual dev steps that should be automated, missing tooling that taxes every round. For ` +
      `each finding worth fixing, also return a ready-to-dispatch fix-unit draft (id, goal, files, acceptance ` +
      `criteria as individually checkable clauses). Read-only — change nothing. An empty report is legitimate. ` +
      `Keep every free-text field terse — an oversized report fails validation.`,
      { model: 'opus', effort: 'high', phase: 'Boundary', label: `health:w${waveN}`, schema: S.health }
    ).catch(() => null),
    !(doHealth && C.flakeReruns > 0) ? null : run(
      STRICT +
      `In the integration worktree at ${intWt}: run the project's full test suite ${C.flakeReruns} times in a ` +
      `row (commands: ${brief}). Report runs = how many completed, and in flips the exact name of every test ` +
      `that changed pass/fail between runs (empty when stable). Fix nothing.`,
      { model: 'haiku', phase: 'Boundary', label: `flake:w${waveN}`, schema: S.flake }
    ).catch(() => null),
  ])
  // Only assign when a job actually ran, so serialize() omits an empty all-null block.
  if (!expl && !hlth && !flk) return
  boundary = { explorer: expl, health: hlth, flake: flk }
  // Persist narratives via Haiku verbatim-writers (investigators flake on side effects;
  // verbatim writers don't — same idiom as the quarantine dossier). Rendering is a pure
  // function of the structured results, so a resume replays it byte-identically.
  const fb = `${repo}/.roadmap/feedback`
  const writes = []
  if (expl) writes.push(run(
    `Create the file ${fb}/explorer/wave-${waveN}.md (creating parent directories as needed) with exactly this ` +
    `content:\n# Wave ${waveN} — runtime exploration (sha ${explSha})\n\n` +
    (expl.findings.length
      ? expl.findings.map((f) => `- **${f.severity}** ${f.summary}\n  - repro: ${f.repro ?? ''}\n  - observed: ${f.observed ?? ''} · expected: ${f.expected ?? ''}`).join('\n')
      : 'No findings.') + (expl.notes ? `\n\nNotes: ${expl.notes}` : '') + '\n',
    { model: 'haiku', effort: 'low', phase: 'Boundary', label: `explorer-write:w${waveN}`, schema: S.ok }).catch(() => null))
  if (hlth || flk) writes.push(run(
    `Create the file ${fb}/health/wave-${waveN}.md (creating parent directories as needed) with exactly this ` +
    `content:\n# Wave ${waveN} — codebase health (tip ${tip})\n\n` +
    ((hlth?.findings ?? []).map((f) => `- **${f.area}** ${f.what}${f.where ? ` (${f.where})` : ''}`).join('\n') || 'No findings.') +
    `\n\n## Fix-unit drafts\n` +
    ((hlth?.fixUnits ?? []).map((u) => `- ${u.id}: ${u.goal}\n  - files: ${(u.files ?? []).join(', ')}\n  - acceptance: ${u.acceptance.join(' · ')}`).join('\n') || 'None.') +
    `\n\n## Flake re-runs\n` +
    (flk ? (flk.flips.length ? `${flk.runs} runs; flips: ${flk.flips.join(', ')}` : `${flk.runs} runs; stable`) : 'not run') +
    (flk?.detail ? ` — ${flk.detail}` : '') + '\n',
    { model: 'haiku', effort: 'low', phase: 'Boundary', label: `health-write:w${waveN}`, schema: S.ok }).catch(() => null))
  await Promise.all(writes)
}

/* --------------------------- per-unit pipeline -------------------------- */
async function runUnit(unit) {
  setStage(unit.id, 'setup')   // status became 'running' in start() before this call
  const spec = specOf(unit)
  const w = wtOf(unit)
  const base = integrationTip // diff base: the freshest integrated tip we know
  // unit.existingBranch adopts pre-written work (a hand-authored branch, or an eval
  // fixture): skip plan/implement and run it through the same verify → review → gate.
  const source = unit.existingBranch ?? base
  // Adoption intent — read from the ORIGINAL prior.units, not the live map (start() overwrote
  // the record with {status:'running'} before us). A unit that was 'running' in the last
  // checkpoint crashed mid-flight, so committed work on its branch is its own prior progress.
  const adopt = !!unit.existingBranch || prior.units?.[unit.id]?.status === 'running'

  // H-7: implementer-reported deviation from a frozen surface. `mismatch` is consumable
  // (one consult per report, respecting the consult budget); `mismatchEver` sticks — carrying
  // the latest report's text — forces the Fable exit gate and feeds its prompt. Banked into
  // the wave ledger so boundary triage sees it even when the unit merges.
  let mismatch = null
  let mismatchEver = null
  const noteMismatch = (r) => {
    if (!r?.contractMismatch) return
    mismatch = r.contractMismatch
    mismatchEver = r.contractMismatch
    debtLog.push({ unit: unit.id, sha: base, kind: 'contract', severity: 'major',
      what: `implementer-reported contract mismatch: ${r.contractMismatch}`,
      why: 'frozen surface contradicts reality — needs architect adjudication' })
  }

  // The sha assertion below must never trust the SAME agent that could have recreated the branch
  // (arc-observed: a setup agent deleted its own source branch and recreated it from main).
  let adoptTip = null
  if (unit.existingBranch) {
    const rp = await run(
      STRICT +
      `In the git repository at ${repo}: run \`git rev-parse ${unit.existingBranch}\` and report the sha. ` +
      `Read-only — change nothing, create nothing. If the ref does not resolve, report ok:false with the exact error.`,
      { model: 'haiku', effort: 'low', phase: 'Setup', label: `adopt-tip:${unit.id}`, schema: S.ws })
    if (!rp.ok || !rp.sha)
      return quarantine(unit, `existingBranch ${unit.existingBranch} does not resolve — fix the plan; nothing was touched`, rp)
    adoptTip = rp.sha
  }

  const ws = await run(
    STRICT +
    `In the git repository at ${repo}, set up the worktree for unit ${unit.id} at ${w} on branch unit/${unit.id} ` +
    `(fork base ${source}). Work these cases in order and report the FIRST that matches:\n` +
    // "Already merged" = the tip LANDED via one of our --no-ff merges, i.e. it is the second
    // parent of a merge commit on the integration branch. is-ancestor alone false-positives on
    // commit-less branches (eval-observed: a quarantined unit's empty branch, parked at an old
    // integration commit, reported already-merged and short-circuited to 'merged' on relaunch).
    `1) Branch unit/${unit.id} exists and its tip is the second parent of a merge commit on ${intBranch} ` +
    `(\`git log --merges --format=%P ${intBranch} | awk '{print $2}' | grep -q "$(git rev-parse unit/${unit.id})"\` ` +
    `succeeds) — it is already merged. Touch nothing; report ok:true, state:'already-merged', sha = the branch tip.\n` +
    // Case 2 tests against base, not source: under self-adoption (existingBranch = the unit's own
    // branch) source..branch is always empty, and case 3 would delete the work adoption preserves.
    `2) Branch unit/${unit.id} exists with unmerged work ` +
    `(\`git rev-list ${base}..unit/${unit.id}\` is non-empty): ` +
    (adopt
      ? `adopt it as-is: if a stale worktree occupies ${w}, clear the WORKTREE ONLY first ` +
        `(\`git worktree remove --force ${w}\`, then \`git worktree prune\`; if the directory still exists, ` +
        `delete it) — the branch itself must never be touched. Then \`git worktree add ${w} unit/${unit.id}\` ` +
        `(NO -b, no reset); report ok:true, state:'adopted', sha = the branch tip.\n`
      : `do NOT touch it — delete nothing; report ok:false, state:'has-commits', sha = the branch tip.\n`) +
    `3) Otherwise remove any stale branch/worktree remnants and create a fresh worktree ` +
    `(git worktree add ${w} -b unit/${unit.id} ${source}); report ok:true, state:'ready', sha = HEAD.`,
    { model: 'haiku', phase: 'Setup', label: `setup:${unit.id}`, schema: S.setup })
  // Already merged: unblock dependents, re-run nothing (holds even with existingBranch set).
  if (ws.state === 'already-merged')
    return { status: 'merged', branch: `unit/${unit.id}`, mergedAt: ws.sha, note: 'detected already merged at setup' }
  // Un-adopted commits beyond base: nothing was destroyed — surface for a deliberate decision.
  if (ws.state === 'has-commits')
    return quarantine(unit, `branch unit/${unit.id} has commits beyond its base and was not adopted — nothing was ` +
      `destroyed; adopt via unit.existingBranch on relaunch, or delete the branch deliberately`, ws)
  // Trust but verify in code: a fresh 'ready' worktree must sit exactly on the expected base
  // unless forked from an explicit existingBranch (an eval fixture legitimately differs);
  // adopted/already-merged branches legitimately diverge, so the assertion is 'ready'-only.
  if (!ws.ok || (ws.state === 'ready' && !unit.existingBranch && !sameSha(ws.sha, base)))
    return quarantine(unit, `workspace setup failed or wrong base (got ${ws.sha || 'nothing'}, expected ${source})`, ws)
  if (adoptTip && !sameSha(ws.sha, adoptTip))
    return quarantine(unit, `adopt tip mismatch (got ${ws.sha || 'nothing'}, pre-captured ` +
      `${unit.existingBranch} = ${adoptTip}) — the branch may have been recreated; check reflog / git fsck --unreachable`, ws)
  const prov = await provision(w, `provision:${unit.id}`)
  if (!prov.ok)
    return quarantine(unit, `environment provisioning failed — fix tooling/provision config, not the spec: ${prov.detail}`, prov)

  if (!unit.existingBranch && ws.state !== 'adopted') {
  setStage(unit.id, 'plan')
  // Plan first, then the architect plan-check — wrong approaches die before code exists.
  let implPlan = await run(
    `You will implement one unit of a larger roadmap, but first: plan. Read the unit spec at ${spec} and any ` +
    `contract files it references under ${repo}/.roadmap/contracts/ (contracts are frozen — treat them as ` +
    `immutable requirements). Codebase conventions and build/test commands are documented at ${brief}. Explore ` +
    `the code in ${w} as needed. Produce an implementation plan: your approach, the files you expect to touch, ` +
    `and how you will test it. If the spec cannot be satisfied within its contracts, do not force it: set ` +
    `feasible:false and explain the contradiction in \`approach\`. Do not write code yet.`,
    { model: 'opus', effort: 'high', phase: 'Implement', label: `plan:${unit.id}`, schema: S.plan })

  // Plan-check — Opus-first: every eligible unit still gets a check (wrong approaches die
  // before code exists), but only structural calls (high risk, claimed-infeasible, or the
  // always-fable policy) pay the Fable architect up front. Everything else gets a free Opus
  // plan-check that escalates to Fable only when the call turns frontier.
  if (C.planCheckRisk.includes(unit.risk) || !implPlan.feasible) {
    // The Fable plan-check — the frontier pass. `lead` carries an Opus escalation's assessment
    // so the architect confirms/overturns a concrete concern rather than re-deriving it; '' when
    // reached directly, keeping that prompt byte-identical to before.
    const fablePlanCheck = (lead = '') => {
      spend.planChecks++
      return run(
        `You are the architect of a roadmap build. A capable engineer proposes this implementation plan for unit ` +
        `${unit.id} — read the spec at ${spec} and its contracts yourself, then judge it:\n${JSON.stringify(implPlan)}\n` +
        `Your verdict controls what happens next — use it precisely: "approve" = proceed to IMPLEMENT this plan ` +
        `as-is; "redirect" = the engineer revises the plan per your guidance, then implements; "quarantine" = do ` +
        `not implement at all (e.g. the spec is unsatisfiable within its contracts, or needs redesign above the ` +
        `engineer's pay grade). Approve unless something is meaningfully wrong. If redirecting, say what and why ` +
        `in a few sentences — the engineer needs direction, not instructions.${lead}`,
        { model: 'fable', effort: 'low', phase: 'Architect', label: `plan-check:${unit.id}`, schema: S.planVerdict })
    }

    let check
    if (unit.risk === 'high' || !implPlan.feasible || C.planCheck === 'always-fable') {
      check = await fablePlanCheck()
    } else {
      spend.opusPlanChecks++
      const oc = await run(
        `You are an Opus plan-checker standing in for the architect on unit ${unit.id} of a roadmap build — but ` +
        `killing a unit is frontier-only, so you may approve or redirect the plan yourself, never quarantine. Read ` +
        `the spec at ${spec} and the contracts it references, then judge this plan against them:\n` +
        `${JSON.stringify(implPlan)}\n` +
        `Choose a verdict: "approve" = proceed to IMPLEMENT as-is (approve unless something is meaningfully wrong); ` +
        `"redirect" = the engineer revises per your guidance, then implements (say what and why in a few sentences, ` +
        `not instructions); "escalate" = hand to the frontier architect when the call turns on contract ` +
        `interpretation, architectural foundations, genuine uncertainty, or the unit looks unbuildable. Name the ` +
        `escalation trigger.`,
        { model: 'opus', effort: 'high', phase: 'Implement', label: `opus-plan-check:${unit.id}`, schema: S.opusPlanVerdict })
      if (oc.verdict === 'escalate') {
        const lead = ` A first-pass Opus plan-check could not clear this itself` +
          `${oc.trigger && oc.trigger !== 'none' ? ` (escalation trigger "${oc.trigger}")` : ''}; use its assessment ` +
          `as a lead to confirm or overturn — not as ground truth: ` +
          `${JSON.stringify({ guidance: oc.guidance, notes: oc.notes })}.`
        check = await fablePlanCheck(lead)
      } else {
        // approve/redirect map straight onto the shared verdict handling below.
        check = { verdict: oc.verdict, guidance: oc.guidance, notes: oc.notes }
      }
    }
    if (check.verdict === 'quarantine') return quarantine(unit, 'plan rejected by architect', check)
    if (check.verdict === 'redirect') {
      implPlan = await run(
        `Revise your implementation plan for unit ${unit.id} (spec: ${spec}). Your previous plan:\n` +
        `${JSON.stringify(implPlan)}\nThe architect's direction: ${check.guidance}`,
        { model: 'opus', effort: 'high', phase: 'Implement', label: `replan:${unit.id}`, schema: S.plan })
    }
  }
  // Never hand an infeasible plan to an implementer — there is no honest way to execute it.
  if (!implPlan.feasible)
    return quarantine(unit, 'spec unsatisfiable at planning (architect-confirmed) — needs respec, not retry', implPlan)

  setStage(unit.id, 'implement')
  const impl = await run(
    `Implement unit ${unit.id} in the worktree at ${w}, following this plan:\n${JSON.stringify(implPlan)}\n` +
    `The spec at ${spec} and its contracts under ${repo}/.roadmap/contracts/ are the requirements; contracts are ` +
    `frozen. ${convClause}Conventions and commands are documented at ${brief}. Before writing new code, search the codebase ` +
    `for existing implementations or symbols to reuse — do not duplicate what already exists. Write the code ` +
    `and the tests the spec's acceptance criteria call for. If you consciously defer any imperfection (a shortcut, ` +
    `a thin test, a known-suboptimal structure) rather than fix it now, record it in \`debt\` — do not silently ` +
    `leave it. If a frozen contract contradicts code that already exists or cannot be implemented as written, ` +
    `choose the deviation you judge correct, keep building, and describe it in the structured \`contractMismatch\` ` +
    `field (one or two sentences: which surface, how reality differs) — never amend the contract file and never ` +
    `note the deviation only in code comments. ${NOROADMAP}Work only inside ${w}. Commit your work on the current ` +
    `branch with clear messages. ${REPORT}`,
    { model: 'opus', effort: 'high', phase: 'Implement', label: `impl:${unit.id}`, schema: S.impl })
  addDebt(unit.id, base, impl.debt, { kind: 'quality' })
  noteMismatch(impl)
  } // end fresh-build block — existingBranch and adopted (crash-recovered) branches enter the pipeline here

  // Free-tier polish loop: verify → adversarial review → fix, bounded.
  setStage(unit.id, 'polish')
  let verify, review
  for (let round = 0; round <= C.maxFixRounds; round++) {
    verify = await run(
      STRICT +
      `In the worktree at ${w}: check cheapest-first — lint/typecheck the changed files, then run the tests ` +
      `scoped to this unit plus the acceptance checks listed in ${spec} (commands and conventions: ${brief}). ` +
      `Do NOT run the full project suite — that happens at merge. Also check whether ` +
      `\`git diff ${base}..HEAD\` touches any path under .roadmap/contracts/. Report failures with the exact ` +
      `verbatim error output, never paraphrased. If the tooling itself cannot run (missing dependency, broken ` +
      `command, environment failure) — as opposed to an assertion failing — report blocked:true and stop. ` +
      `Do not fix anything.`,
      { model: 'haiku', phase: 'Verify', label: `verify:${unit.id}#${round}`, schema: S.verify })
    if (verify.blocked)
      return quarantine(unit, 'environment/tooling blocked verification — fix provisioning, not the spec', verify)
    review = await run(
      riskTilt(unit.risk) +
      `Adversarially review unit ${unit.id}: in ${w}, read \`git diff ${base}..HEAD\` and judge it against the ` +
      `spec at ${spec} and its contracts. ${convClause}You did not write this code; assume it contains mistakes. Report a ` +
      `finding as blocking only if it would cause incorrect behavior, violate the spec or a contract, or leave ` +
      `acceptance criteria untested — AND the defect is introduced by this diff. Real issues that predate the ` +
      `diff go in preExisting (they never block). Do not flag style, nitpicks, or anything a linter/formatter/` +
      `typechecker would catch. The tests are part of the diff under review, and a green check is evidence only ` +
      `if the test could fail: for each new or modified test, ask whether it would fail if the behaviour were ` +
      `actually wrong — a tautological test (asserting whatever the code currently does) or a test that mocks ` +
      `away the very thing it claims to test is a blocking finding. When unsure, check empirically: introduce a ` +
      `plausible bug in the worktree, run the tests, confirm at least one fails, then restore your change. ` +
      `Give each blocking finding a confidence in [0,1]. If the spec or its contracts ` +
      `are internally contradictory or unsatisfiable as written, set unsatisfiable:true. ` +
      `Verification evidence: ${JSON.stringify(verify)}`,
      { model: 'opus', effort: 'high', phase: 'Review', label: `review:${unit.id}#${round}`, schema: S.review })
    if (review.unsatisfiable)
      return quarantine(unit, 'spec/contract unsatisfiable as written — needs respec, not retry', review)

    const blockers = review.blocking.filter((b) => (b.confidence ?? 1) >= C.minBlockConfidence)
    if (verify.pass && blockers.length === 0) break

    // Mid-loop rescue: fired by code over objective signals only, and capped.
    let directive = null
    const stuck = (!verify.pass && round >= C.maxFixRounds) || verify.contractSurfaceTouched || !!mismatch
    if (stuck && consultsUsed < C.maxConsults) {
      consultsUsed++
      const dossier = await run(
        `Distill a brief dossier for an architect about unit ${unit.id}, which is stuck. Read the spec at ${spec}; ` +
        `summarize what was attempted (branch unit/${unit.id}, worktree ${w}), the strongest failure evidence, and ` +
        `the most plausible root cause. Verify: ${JSON.stringify(verify)}. Review: ${JSON.stringify(review)}` +
        ` Implementer-reported contract mismatch: ${mismatch ?? 'none'}.`,
        { model: 'sonnet', phase: 'Escalate', label: `rescue-dossier:${unit.id}`, schema: S.dossier })
      directive = await run(
        `You are the architect. Unit ${unit.id} is stuck. Dossier: ${JSON.stringify(dossier)} (spec: ${spec} — ` +
        `consult it and the code in ${w} yourself if the dossier is not enough). Decide: redirect with brief ` +
        `guidance, or quarantine for redesign. Do not write code.`,
        { model: 'fable', effort: 'low', phase: 'Escalate', label: `consult:${unit.id}`, schema: S.directive })
      if (directive.action === 'quarantine') return quarantine(unit, 'architect consult', directive)
      mismatch = null   // consumed — one consult per reported mismatch
    }

    const fixed = await run(
      `Fix unit ${unit.id} in ${w}. Spec: ${spec}. Failing checks (verbatim): ${JSON.stringify(verify.failures)}. ` +
      `Blocking review findings: ${JSON.stringify(blockers)}.` +
      `${directive ? ` Architect direction: ${directive.guidance}` : ''}` +
      ` If a fix forces you to deviate from a frozen contract surface, report it in \`contractMismatch\`. ${NOROADMAP}` +
      `Commit your fixes. ${REPORT}`,
      { model: 'opus', effort: 'high', phase: 'Fix', label: `fix:${unit.id}#${round}`, schema: S.impl })
    addDebt(unit.id, base, fixed.debt, { kind: 'quality' })
    noteMismatch(fixed)
  }
  if (!verify.pass) return quarantine(unit, 'verification never passed', verify)

  // Any deferred imperfection the reviewer surfaced but did not block on is real debt —
  // bank it whichever gate approves, so it is never silently lost.
  const bankReviewDebt = () => {
    addDebt(unit.id, base, review?.nonBlocking, { kind: 'quality' })
    addDebt(unit.id, base, review?.preExisting, { kind: 'quality', severity: 'major' })
  }
  const gateReverify = (label) => run(
    STRICT +
    `In ${w}: re-run lint/typecheck on the changed files, the unit-scoped tests, and the acceptance checks ` +
    `from ${spec} (commands: ${brief}). Report failures verbatim. blocked:true if the tooling itself cannot ` +
    `run. Fix nothing.`,
    { model: 'haiku', phase: 'Verify', label, schema: S.verify })

  // Exit gate — Opus-first, escalating to the Fable architect only when the call is
  // genuinely hard. High-risk units, contract-touching diffs, and a deterministic audit
  // sample skip straight to the guaranteed Fable gate: Opus cannot reliably self-detect the
  // subtle oversights that gate exists to catch, so where the stakes are structurally
  // highest, frontier judgment stays mandatory (DESIGN.md decision 4).
  setStage(unit.id, 'gate')
  // mismatchEver: the Fable gate catching exactly this case (silent frozen-surface deviation,
  // all-green tests) is arc-observed value.
  const forceFrontier =
    C.exitGate === 'always-fable' || unit.risk === 'high' ||
    verify.contractSurfaceTouched || auditPick(unit) || mismatchEver
  // An audit-only force (the sample fired, nothing structural did) is a spot-check of an
  // Opus-approved unit, not a from-scratch re-gate: it runs at the cheaper auditEffort and
  // reads a diet of the diff. Any structural force keeps the full-read gateEffort path.
  const auditOnly = auditPick(unit) && C.exitGate !== 'always-fable' &&
    unit.risk !== 'high' && !verify.contractSurfaceTouched && !mismatchEver

  // When the Opus-first gate hands off to the Fable gate (escalation or non-convergence),
  // carry its last assessment across so the frontier gate confirms/overturns a concrete lead
  // rather than re-deriving the concern from the spec, contracts, and diff from scratch.
  let opusHandoff = null
  if (!forceFrontier) {
    // Bounded Opus self-gate: a FRESH adversarial Opus (not the implementer) grades the
    // acceptance criteria one by one, then approves, self-revises (free), or escalates.
    for (let g = 0; g < C.maxGateRounds; g++) {
      spend.opusGateRounds++
      const og = await run(
        riskTilt(unit.risk) +
        `You are the exit gate for unit ${unit.id} of a roadmap build, standing in for the architect — but you ` +
        `are Opus, so escalate to the frontier architect the moment the call exceeds a capable engineer's ` +
        `authority rather than guessing. In the worktree at ${w}: read the spec at ${spec} and the contracts it ` +
        `references, then read \`git diff ${base}..HEAD\` in full and whatever surrounding code you need. ` +
        `${convClause}Verification evidence: ${JSON.stringify(verify)}. Grade each of the spec's acceptance criteria ` +
        `individually before any overall verdict — a gestalt impression hides exactly the misses you are here to ` +
        `catch; subtle spec misses, contract edge cases, and tests that would not fail if the behaviour were ` +
        `actually wrong are exactly what to hunt. Then choose a verdict: "approve" only if you would merge this ` +
        `as-is and personally vouch for it; "revise" if there is a concrete, mechanical fix you can specify and it ` +
        `needs no frontier judgment (give directives — what and why, not code); "escalate" to the frontier ` +
        `architect if you are stuck, if the right choice is a genuinely hard trade-off where every option carries ` +
        `a substantive drawback, if the increment is architecturally foundational to the wider solution, or if ` +
        `you have found an oversight you are not confident you can resolve. Name the escalation trigger. Record ` +
        `any imperfection you consciously ship rather than fix in \`debt\` (what, why, severity, kind).` +
        `${g > 0 ? ' You gated this unit before; focus on whether your previous directives were properly addressed.' : ''}`,
        { model: 'opus', effort: 'high', phase: 'Opus-gate', label: `opus-gate:${unit.id}#${g}`, schema: S.opusGate })
      addDebt(unit.id, base, og.debt)
      opusHandoff = og
      if (og.verdict === 'approve') { bankReviewDebt(); return { status: 'merge-ready', branch: `unit/${unit.id}`, base } }
      if (og.verdict === 'escalate') break
      await run(
        `Address the exit gate's directives on unit ${unit.id} in ${w} (spec: ${spec}):\n` +
        `${JSON.stringify(og.directives)}\nCommit your changes. ${REPORT}`,
        { model: 'opus', effort: 'high', phase: 'Fix', label: `opus-gate-fix:${unit.id}#${g}`, schema: S.impl })
      verify = await gateReverify(`opus-gate-verify:${unit.id}#${g}`)
      if (verify.blocked)
        return quarantine(unit, 'environment/tooling blocked verification — fix provisioning, not the spec', verify)
    }
    // Opus approved nothing across its rounds — whether it escalated or merely failed to
    // converge, the frontier architect decides next. Fall through to the Fable gate below.
  }

  // Fable architect gate — the frontier pass. Reached by force policy, an Opus escalation,
  // or Opus non-convergence. Nothing merges through here without frontier approval.
  // On an Opus handoff, the first Fable round inherits Opus's lead (see opusHandoff above);
  // '' when the gate was forced, so a forced-frontier prompt is byte-identical to before.
  const opusContext = opusHandoff
    ? ` A first-pass Opus exit gate already examined this unit and could not clear it itself ` +
      `(last verdict "${opusHandoff.verdict}"` +
      `${opusHandoff.trigger && opusHandoff.trigger !== 'none' ? `, escalation trigger "${opusHandoff.trigger}"` : ''}). ` +
      `Use its findings as a lead to confirm or overturn — not as ground truth, and do not re-derive them from ` +
      `scratch: ${JSON.stringify({ directives: opusHandoff.directives, notes: opusHandoff.notes })}.`
    : ''
  // Hand the gate the implementer's own report — forcing the Fable gate and then making it
  // rediscover the deviation from the diff would defeat half the structured channel.
  const mismatchClause = mismatchEver
    ? ` The implementer reported deviating from a frozen contract surface: "${mismatchEver}". Adjudicate that ` +
      `deviation explicitly — approve it as recorded debt, direct a revert to the contract as written, or ` +
      `quarantine for contract amendment (amendments are the architect's alone, above this gate).`
    : ''
  // Audit-only gates read a diet first and expand on suspicion (a full re-read of an
  // Opus-approved unit is the false economy the audit is meant to avoid); every forced gate
  // keeps the byte-identical full-read instruction, since summarising their diff hides misses.
  const diffRead = auditOnly
    ? `read \`git diff --stat ${base}..HEAD\`, the spec's acceptance criteria, and the verification evidence ` +
      `first, then read in full the diff of every file where a spec or contract violation would be consequential ` +
      `— expand to the complete diff the moment anything looks off. You are auditing an Opus-approved unit for ` +
      `systematic rubber-stamping, not re-gating from scratch. `
    : `read \`git diff ${base}..HEAD\` in full and whatever surrounding code you need. `
  for (let g = 0; g < C.maxGateRounds; g++) {
    spend.gateRounds++
    const gate = await run(
      riskTilt(unit.risk) +
      `You are the architect gate for unit ${unit.id} of a roadmap build; nothing merges without your approval. ` +
      `In the worktree at ${w}: read the spec at ${spec} and the contracts it references, then ${diffRead}${convClause}Verification evidence: ` +
      `${JSON.stringify(verify)}. Grade each of the spec's acceptance criteria individually before forming your ` +
      `overall verdict — a gestalt impression hides exactly the misses you are here to catch. Judge the work as ` +
      `if you must personally vouch for it: approve only if you would merge it without further steering. Small ` +
      `oversights — subtle spec misses, contract edge cases, tests that would not fail if the behaviour were ` +
      `actually wrong, the things a capable engineer plausibly overlooks — are exactly your job. If revising, ` +
      `give specific directives: what and why, not code. Record any imperfection you consciously approve rather ` +
      `than fix in \`debt\`.${mismatchClause}` +
      `${g === 0 ? opusContext : ' You gated this unit before; focus on whether your previous directives were properly addressed.'}`,
      { model: 'fable', effort: auditOnly ? C.auditEffort : C.gateEffort, phase: 'Architect', label: `gate:${unit.id}#${g}`, schema: S.gate })
    addDebt(unit.id, base, gate.debt)
    if (gate.verdict === 'approve') { bankReviewDebt(); return { status: 'merge-ready', branch: `unit/${unit.id}`, base } }
    if (gate.verdict === 'quarantine') return quarantine(unit, 'rejected at architect gate', gate)
    await run(
      `Address the architect's directives on unit ${unit.id} in ${w} (spec: ${spec}):\n` +
      `${JSON.stringify(gate.directives)}\nCommit your changes. ${REPORT}`,
      { model: 'opus', effort: 'high', phase: 'Fix', label: `gate-fix:${unit.id}#${g}`, schema: S.impl })
    verify = await gateReverify(`gate-verify:${unit.id}#${g}`)
    if (verify.blocked)
      return quarantine(unit, 'environment/tooling blocked verification — fix provisioning, not the spec', verify)
  }
  return quarantine(unit, 'architect gate did not converge')
}

/* --------------------- serial merge queue + suite gate ------------------ */
async function mergeUnit(unit) {
  let res = await run(
    STRICT +
    `In the integration worktree at ${intWt} (branch ${intBranch}): first, if a merge is already in progress ` +
    `(a MERGE_HEAD exists), clear it with \`git merge --abort\`. Then, if unit/${unit.id} is already an ancestor ` +
    `of HEAD (\`git merge-base --is-ancestor unit/${unit.id} HEAD\` succeeds — a crash-replay after this merge ` +
    `already landed), skip the merge but still run the project's full test suite (commands: ${brief}) and report ` +
    `merged:true with the current HEAD sha. Otherwise merge branch unit/${unit.id} ` +
    `(git merge --no-ff unit/${unit.id}). If the merge conflicts, abort it (git merge --abort) and report ` +
    `merged:false naming the conflicting paths in detail — do not resolve conflicts yourself. If it merges ` +
    `cleanly, run the project's full test suite (commands: ${brief}) and report the result. Report the current ` +
    `HEAD sha either way.`,
    { model: 'haiku', phase: 'Merge', label: `merge:${unit.id}`, schema: S.merge })

  if (!res.merged) {
    res = await run(
      `In the integration worktree at ${intWt} (branch ${intBranch}): merge branch unit/${unit.id}, resolving ` +
      `conflicts. Both sides are intentional work — consult ${specOf(unit)}, the specs of recently merged units ` +
      `under ${repo}/.roadmap/specs/, and the contracts under ${repo}/.roadmap/contracts/ to decide each ` +
      `resolution. Then run the full test suite. If you are genuinely unsure a resolution is semantically right, ` +
      `abort the merge and report merged:false rather than guessing. Report the HEAD sha and suite result.`,
      { model: 'opus', effort: 'high', phase: 'Merge', label: `resolve:${unit.id}`, schema: S.merge })
    if (!res.merged) return quarantine(unit, 'unresolvable merge conflicts', res)
  }

  if (!res.suitePass) {
    res = await run(
      `The integrated test suite fails after merging unit/${unit.id} into ${intBranch} (worktree ${intWt}). ` +
      `Evidence: ${res.detail}. First check whether the failure predates this merge. If the merge caused it, ` +
      `diagnose and fix on ${intBranch} — this may be a cross-unit interaction; the specs of all units live under ` +
      `${repo}/.roadmap/specs/. Re-run the suite. If you cannot make it pass, revert the merge commit ` +
      `(git revert -m 1 HEAD, keeping the branch intact for later redesign) and report suitePass:false.`,
      { model: 'opus', effort: 'high', phase: 'Merge', label: `integration-fix:${unit.id}`, schema: S.merge })
    if (!res.suitePass) return quarantine(unit, 'broke the integrated suite', res)
  }

  integrationTip = res.head
  if (C.previewRefresh === 'merge') refreshMirror()
  return { status: 'merged', branch: `unit/${unit.id}`, mergedAt: res.head }
}

/* ------------------------------- scheduler ------------------------------ */
function start(unit) {
  inFlight++
  units.set(unit.id, { status: 'running' })
  checkpoint()   // coalesces with the wave-start burst to ~1 Haiku write; a 'running' record is what recovery adopts
  ;(async () => {
    let result = await runUnit(unit)
      .catch((e) => quarantine(unit, `pipeline error: ${e?.message ?? e}`).catch(() =>
        ({ status: 'quarantined', reason: `pipeline error: ${e?.message ?? e}` })))
    if (result.status === 'merge-ready') {
      // Stamp 'merge-queue' directly (not via setStage — status is 'merge-ready', not 'running');
      // this transient record is overwritten by the terminal result below, so no stale stage survives.
      units.set(unit.id, { ...result, stage: 'merge-queue' })
      checkpoint()
      const segment = mergeChain.then(() => mergeUnit(unit)).catch((e) =>
        quarantine(unit, `merge pipeline error: ${e?.message ?? e}`))
      mergeChain = segment.then(() => null, () => null)
      result = await segment
    }
    units.set(unit.id, result)
    log(`${unit.id}: ${result.status}`)
    inFlight--
    checkpoint()
    notifySettle()
  })()
}

// Fail loudly on a malformed graph — a bad edge reference or a cycle otherwise strands
// units as silently-pending: ready() never fires, no error is raised, the wave just ends.
{
  const ids = new Set(plan.units.map((u) => u.id))
  for (const e of plan.edges)
    if (!ids.has(e.from) || !ids.has(e.to))
      throw new Error(`plan edge references unknown unit: ${e.from} -> ${e.to}`)
  const indeg = new Map(plan.units.map((u) => [u.id, 0]))
  for (const e of plan.edges) indeg.set(e.to, indeg.get(e.to) + 1)
  const q = plan.units.map((u) => u.id).filter((id) => indeg.get(id) === 0)
  let seen = 0
  while (q.length) {
    const id = q.shift()
    seen++
    for (const e of plan.edges) {
      if (e.from !== id) continue
      indeg.set(e.to, indeg.get(e.to) - 1)
      if (indeg.get(e.to) === 0) q.push(e.to)
    }
  }
  if (seen < plan.units.length)
    throw new Error('plan dependency graph contains a cycle — fix the plan before dispatch')
  // A self-referential adopt makes the setup agent's remove-stale-remnants path delete its own
  // source — this destroyed finished work once; refuse at validation.
  for (const u of plan.units)
    if (u.existingBranch && u.existingBranch === `unit/${u.id}`)
      throw new Error(`unit ${u.id}: existingBranch is the unit's own branch unit/${u.id} — setup could delete ` +
        `its own source and recreate it from the wrong base. Anchor the commits under a differently-named ref ` +
        `first (e.g. \`git branch adopt/${u.id} $(git rev-parse unit/${u.id})\`) and set existingBranch to that.`)
}

phase('Setup')
const intSetup = await run(
  STRICT +
  `In the git repository at ${repo}: 1) ensure branch ${intBranch} exists — if not, create it at ` +
  `${integrationTip}; 2) ensure a worktree for it exists at ${intWt} (git worktree add ${intWt} ${intBranch}); ` +
  `if the path already exists, verify it is a clean checkout of ${intBranch} and reset it if not. ` +
  `Report ok:true only when the integration worktree is ready and clean, with its HEAD sha in \`sha\`.`,
  { model: 'haiku', phase: 'Setup', label: 'integration-worktree', schema: S.ws })
if (!intSetup.ok) throw new Error(`integration worktree setup failed: ${intSetup.detail ?? intSetup.sha}`)
// Git is the source of truth for the branch; state.json is bookkeeping. A relaunch with a
// stale checkpoint would otherwise fork every unit off the old tip — and, if every unit
// short-circuits at setup, write that stale tip back out, poisoning the next wave.
if (!sameSha(intSetup.sha, integrationTip)) {
  log(`integration branch is ahead of the checkpointed tip — reconciled to ${intSetup.sha.slice(0, 7)}`)
  integrationTip = intSetup.sha
}
const intProv = await provision(intWt, 'provision:integration')
if (!intProv.ok) throw new Error(`integration worktree provisioning failed: ${intProv.detail}`)

// Preview setup: detach the primary checkout at the wave-start tip and stand the preview
// up there. Failure never gates the wave — throwing here would gate the arc on its own
// observability.
if (previewStatus === 'pending') {
  const p = plan.preview
  const ps = await run(
    STRICT +
    `Set up the arc's preview mirror: cd to the PRIMARY repository checkout at ${repo} and stay there for ` +
    `every git command. Then, ${previewStopCmd} (the pidfile lives OUTSIDE the repo). ` +
    `Then run \`git checkout --detach ${integrationTip}\` — if git refuses (for example locally-modified ` +
    `files), report ok:false with the exact error; never stash, reset, or force. ` +
    (p.setup ? `Then run, from inside ${repo}: ${p.setup}. ` : '') +
    (p.start ? `Then start the preview from inside ${repo} with ${previewStartCmd(p.start)}. ${previewSweepRetry}` : '') +
    previewHealth() +
    `Report ok plus the checkout's HEAD sha.`,
    { model: 'haiku', phase: 'Preview', label: 'preview-setup', schema: S.ws },
  ).catch(() => null)
  if (ps?.ok && sameSha(ps.sha, integrationTip)) { previewStatus = 'live'; previewSha = integrationTip }
  else {
    previewStatus = 'failed'
    log(`preview setup failed — continuing without a mirror (${ps?.detail ?? ps?.sha ?? 'agent error'})`)
  }
}

const inScope = plan.units.filter((u) => u.inScope)
log(`wave ${serialize().wave}: ${inScope.length} in-scope units, ${C.maxConsults} rescue consults available`)

while (true) {
  inScope.filter(ready).forEach(start)
  for (const u of inScope) {
    if (rec(u.id).status === 'pending' && blockedBy(u)) {
      units.set(u.id, { status: 'blocked' })
      log(`${u.id}: blocked (dependency quarantined)`)
      checkpoint()
    }
  }
  if (inFlight === 0) break
  await nextSettle()
}

if (C.previewRefresh === 'wave') refreshMirror()   // single advance to the final tip
await previewChain                                  // drain pending mirror advances
// Boundary phase — strictly after all merges and mirror advances (invariant 8).
if (C.boundary !== 'off') {
  phase('Boundary')
  await runBoundary().catch((e) => log(`boundary phase failed — continuing (${e?.message ?? e})`))
}
checkpoint()                                        // state.json reflects mirror + boundary
await checkpointChain
return serialize()
