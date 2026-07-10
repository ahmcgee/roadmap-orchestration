export const meta = {
  name: 'roadmap-wave',
  description: 'Execute one wave of a roadmap plan: per-unit build/gate pipelines and a serial merge queue',
  phases: [
    { title: 'Setup', detail: 'integration + unit worktrees' },
    { title: 'Implement', detail: 'plan + code (Opus)' },
    { title: 'Architect', detail: 'plan-check + exit gate (Fable)' },
    { title: 'Verify', detail: 'build/tests (Haiku)' },
    { title: 'Review', detail: 'adversarial review (Opus)' },
    { title: 'Fix', detail: 'apply findings/directives (Opus)' },
    { title: 'Escalate', detail: 'rescue consults (Fable, capped)' },
    { title: 'Merge', detail: 'serial queue + integrated suite gate' },
    { title: 'Quarantine', detail: 'dossiers for redesign' },
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
  ...(plan.config ?? {}),
  ...(overrides ?? {}),
}
const repo = plan.repoPath          // absolute path to the repository
const wtRoot = plan.worktreeRoot    // absolute path OUTSIDE the repository
const intBranch = prior.integrationBranch
const intWt = `${wtRoot}/__integration`
const specOf = (u) => `${repo}/.roadmap/specs/${u.id}.md`
const wtOf = (u) => `${wtRoot}/${u.id}`
// Location discipline for mechanical agents: smoke testing showed that given a bad path
// they improvise in their cwd and report plausible success. Fail-loud beats adaptive.
const STRICT = 'Start by `cd` to the exact absolute path named in this task — if the cd fails or the directory ' +
  'is not the described git checkout, report ok/pass as false with the exact error and stop. Never substitute ' +
  'your current working directory, the enclosing project, or any other repository. '
const sameSha = (a, b) => !!a && !!b && (a.trim().startsWith(b.trim()) || b.trim().startsWith(a.trim()))
const brief = plan.briefPath ?? `${repo}/.roadmap/brief.md`   // Phase-0 codebase brief: commands + conventions
// Per-tier spend tally, returned in the wave state so the session report can show
// where frontier attention actually went (and the dial can be tuned on evidence).
const spend = { fable: 0, opus: 0, sonnet: 0, haiku: 0, planChecks: 0, gateRounds: 0 }
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
      'report matching the requested schema — put any commentary in its `notes` field and add no other fields.',
      { ...opts, label: `${opts.label ?? 'agent'}#retry` })
  }
}
// Verdict-threshold tilt by plan-time risk tier — makes `risk` bind at review/gate time.
const riskTilt = (r) =>
  r === 'high' ? 'This unit is high-risk: a missed defect ships — when in doubt, demand revision rather than approve. '
  : r === 'low' ? 'This unit is low-risk: block only on clear correctness or contract violations; do not gold-plate. '
  : ''

/* ------------------------------- schemas ------------------------------- */
const obj = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })
const arr = (t) => ({ type: 'array', items: { type: t } })
const oneOf = (vals) => ({ type: 'string', enum: vals })
const S = {
  ok: obj({ ok: { type: 'boolean' }, detail: { type: 'string' } }, ['ok']),
  ws: obj({ ok: { type: 'boolean' }, sha: { type: 'string' }, detail: { type: 'string' } }, ['ok', 'sha']),
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
  impl: obj({ summary: { type: 'string' }, filesChanged: arr('string'), notes: { type: 'string' } },
    ['summary', 'filesChanged']),
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
    directives: { type: 'array', items: obj({ what: { type: 'string' }, why: { type: 'string' } }, ['what', 'why']) },
    notes: { type: 'string' },
  }, ['verdict', 'directives']),
  directive: obj({ action: oneOf(['redirect', 'quarantine']), guidance: { type: 'string' } }, ['action', 'guidance']),
  dossier: obj({ attempted: { type: 'string' }, evidence: { type: 'string' }, hypothesis: { type: 'string' } },
    ['attempted', 'evidence', 'hypothesis']),
  merge: obj({
    merged: { type: 'boolean' }, suitePass: { type: 'boolean' },
    head: { type: 'string' }, detail: { type: 'string' },
  }, ['merged', 'suitePass', 'head', 'detail']),
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

const rec = (id) => units.get(id)
const depsOf = (id) => plan.edges.filter((e) => e.to === id).map((e) => e.from)
const ready = (u) => rec(u.id).status === 'pending' && depsOf(u.id).every((d) => rec(d)?.status === 'merged')
const blockedBy = (u) => depsOf(u.id).some((d) => ['quarantined', 'blocked'].includes(rec(d)?.status))
const serialize = () => ({
  integrationBranch: intBranch, integrationTip, consultsUsed, spend,
  wave: (prior.wave ?? 0) + 1, units: Object.fromEntries(units),
})
const notifySettle = () => { const w = settleWaiters; settleWaiters = []; w.forEach((f) => f()) }
const nextSettle = () => new Promise((r) => settleWaiters.push(r))

function checkpoint() {
  const snapshot = JSON.stringify(serialize(), null, 2)
  checkpointChain = checkpointChain.then(() =>
    run(`Overwrite the file ${repo}/.roadmap/state.json with exactly this JSON and nothing else:\n${snapshot}`,
      { model: 'haiku', effort: 'low', label: 'checkpoint', phase: 'Setup', schema: S.ok })
      .catch(() => null))
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

/* --------------------------- per-unit pipeline -------------------------- */
async function runUnit(unit) {
  const spec = specOf(unit)
  const w = wtOf(unit)
  const base = integrationTip // diff base: the freshest integrated tip we know
  // unit.existingBranch adopts pre-written work (a hand-authored branch, or an eval
  // fixture): skip plan/implement and run it through the same verify → review → gate.
  const source = unit.existingBranch ?? base

  const ws = await run(
    STRICT +
    `In the git repository at ${repo}: create branch unit/${unit.id} at ${source} with a worktree at ${w} ` +
    `(git worktree add ${w} -b unit/${unit.id} ${source}). If the branch or path already exists from an earlier ` +
    `attempt, remove and recreate them cleanly. Report ok:true only when the worktree is ready and clean, and ` +
    `put the worktree's HEAD sha in \`sha\`.`,
    { model: 'haiku', phase: 'Setup', label: `setup:${unit.id}`, schema: S.ws })
  // Trust but verify in code: a worktree in the wrong repo or off the wrong base never proceeds.
  if (!ws.ok || (!unit.existingBranch && !sameSha(ws.sha, base)))
    return quarantine(unit, `workspace setup failed or wrong base (got ${ws.sha || 'nothing'}, expected ${source})`, ws)
  const prov = await provision(w, `provision:${unit.id}`)
  if (!prov.ok)
    return quarantine(unit, `environment provisioning failed — fix tooling/provision config, not the spec: ${prov.detail}`, prov)

  if (!unit.existingBranch) {
  // Plan first, then the architect plan-check — wrong approaches die before code exists.
  let implPlan = await run(
    `You will implement one unit of a larger roadmap, but first: plan. Read the unit spec at ${spec} and any ` +
    `contract files it references under ${repo}/.roadmap/contracts/ (contracts are frozen — treat them as ` +
    `immutable requirements). Codebase conventions and build/test commands are documented at ${brief}. Explore ` +
    `the code in ${w} as needed. Produce an implementation plan: your approach, the files you expect to touch, ` +
    `and how you will test it. If the spec cannot be satisfied within its contracts, do not force it: set ` +
    `feasible:false and explain the contradiction in \`approach\`. Do not write code yet.`,
    { model: 'opus', effort: 'high', phase: 'Implement', label: `plan:${unit.id}`, schema: S.plan })

  // A claimed-unsatisfiable plan is always architect-checked, whatever the risk tier.
  if (C.planCheckRisk.includes(unit.risk) || !implPlan.feasible) {
    spend.planChecks++
    const check = await run(
      `You are the architect of a roadmap build. A capable engineer proposes this implementation plan for unit ` +
      `${unit.id} — read the spec at ${spec} and its contracts yourself, then judge it:\n${JSON.stringify(implPlan)}\n` +
      `Your verdict controls what happens next — use it precisely: "approve" = proceed to IMPLEMENT this plan ` +
      `as-is; "redirect" = the engineer revises the plan per your guidance, then implements; "quarantine" = do ` +
      `not implement at all (e.g. the spec is unsatisfiable within its contracts, or needs redesign above the ` +
      `engineer's pay grade). Approve unless something is meaningfully wrong. If redirecting, say what and why ` +
      `in a few sentences — the engineer needs direction, not instructions.`,
      { model: 'fable', effort: 'low', phase: 'Architect', label: `plan-check:${unit.id}`, schema: S.planVerdict })
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

  await run(
    `Implement unit ${unit.id} in the worktree at ${w}, following this plan:\n${JSON.stringify(implPlan)}\n` +
    `The spec at ${spec} and its contracts under ${repo}/.roadmap/contracts/ are the requirements; contracts are ` +
    `frozen. Conventions and commands are documented at ${brief}. Before writing new code, search the codebase ` +
    `for existing implementations or symbols to reuse — do not duplicate what already exists. Write the code ` +
    `and the tests the spec's acceptance criteria call for. Work only inside ${w}. Commit your work on the ` +
    `current branch with clear messages.`,
    { model: 'opus', effort: 'high', phase: 'Implement', label: `impl:${unit.id}`, schema: S.impl })
  } // end !unit.existingBranch — adopted branches enter the pipeline here

  // Free-tier polish loop: verify → adversarial review → fix, bounded.
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
      `spec at ${spec} and its contracts. You did not write this code; assume it contains mistakes. Report a ` +
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
    const stuck = (!verify.pass && round >= C.maxFixRounds) || verify.contractSurfaceTouched
    if (stuck && consultsUsed < C.maxConsults) {
      consultsUsed++
      const dossier = await run(
        `Distill a brief dossier for an architect about unit ${unit.id}, which is stuck. Read the spec at ${spec}; ` +
        `summarize what was attempted (branch unit/${unit.id}, worktree ${w}), the strongest failure evidence, and ` +
        `the most plausible root cause. Verify: ${JSON.stringify(verify)}. Review: ${JSON.stringify(review)}`,
        { model: 'sonnet', phase: 'Escalate', label: `rescue-dossier:${unit.id}`, schema: S.dossier })
      directive = await run(
        `You are the architect. Unit ${unit.id} is stuck. Dossier: ${JSON.stringify(dossier)} (spec: ${spec} — ` +
        `consult it and the code in ${w} yourself if the dossier is not enough). Decide: redirect with brief ` +
        `guidance, or quarantine for redesign. Do not write code.`,
        { model: 'fable', effort: 'low', phase: 'Escalate', label: `consult:${unit.id}`, schema: S.directive })
      if (directive.action === 'quarantine') return quarantine(unit, 'architect consult', directive)
    }

    await run(
      `Fix unit ${unit.id} in ${w}. Spec: ${spec}. Failing checks (verbatim): ${JSON.stringify(verify.failures)}. ` +
      `Blocking review findings: ${JSON.stringify(blockers)}.` +
      `${directive ? ` Architect direction: ${directive.guidance}` : ''} Commit your fixes.`,
      { model: 'opus', effort: 'high', phase: 'Fix', label: `fix:${unit.id}#${round}`, schema: S.impl })
  }
  if (!verify.pass) return quarantine(unit, 'verification never passed', verify)

  // Architect exit gate — the guaranteed frontier pass. Reads the real diff.
  for (let g = 0; g < C.maxGateRounds; g++) {
    spend.gateRounds++
    const gate = await run(
      riskTilt(unit.risk) +
      `You are the architect gate for unit ${unit.id} of a roadmap build; nothing merges without your approval. ` +
      `In the worktree at ${w}: read the spec at ${spec} and the contracts it references, then read ` +
      `\`git diff ${base}..HEAD\` in full and whatever surrounding code you need. Verification evidence: ` +
      `${JSON.stringify(verify)}. Grade each of the spec's acceptance criteria individually before forming your ` +
      `overall verdict — a gestalt impression hides exactly the misses you are here to catch. Judge the work as ` +
      `if you must personally vouch for it: approve only if you would merge it without further steering. Small ` +
      `oversights — subtle spec misses, contract edge cases, tests that would not fail if the behaviour were ` +
      `actually wrong, the things a capable engineer plausibly overlooks — are exactly your job. If revising, ` +
      `give specific directives: what and why, not code.` +
      `${g > 0 ? ' You gated this unit before; focus on whether your previous directives were properly addressed.' : ''}`,
      { model: 'fable', effort: C.gateEffort, phase: 'Architect', label: `gate:${unit.id}#${g}`, schema: S.gate })
    if (gate.verdict === 'approve') return { status: 'merge-ready', branch: `unit/${unit.id}`, base }
    if (gate.verdict === 'quarantine') return quarantine(unit, 'rejected at architect gate', gate)
    await run(
      `Address the architect's directives on unit ${unit.id} in ${w} (spec: ${spec}):\n` +
      `${JSON.stringify(gate.directives)}\nCommit your changes.`,
      { model: 'opus', effort: 'high', phase: 'Fix', label: `gate-fix:${unit.id}#${g}`, schema: S.impl })
    verify = await run(
      STRICT +
      `In ${w}: re-run lint/typecheck on the changed files, the unit-scoped tests, and the acceptance checks ` +
      `from ${spec} (commands: ${brief}). Report failures verbatim. blocked:true if the tooling itself cannot ` +
      `run. Fix nothing.`,
      { model: 'haiku', phase: 'Verify', label: `gate-verify:${unit.id}#${g}`, schema: S.verify })
    if (verify.blocked)
      return quarantine(unit, 'environment/tooling blocked verification — fix provisioning, not the spec', verify)
  }
  return quarantine(unit, 'architect gate did not converge')
}

/* --------------------- serial merge queue + suite gate ------------------ */
async function mergeUnit(unit) {
  let res = await run(
    STRICT +
    `In the integration worktree at ${intWt} (branch ${intBranch}): merge branch unit/${unit.id} ` +
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
  return { status: 'merged', branch: `unit/${unit.id}`, mergedAt: res.head }
}

/* ------------------------------- scheduler ------------------------------ */
function start(unit) {
  inFlight++
  units.set(unit.id, { status: 'running' })
  ;(async () => {
    let result = await runUnit(unit)
      .catch((e) => quarantine(unit, `pipeline error: ${e?.message ?? e}`).catch(() =>
        ({ status: 'quarantined', reason: `pipeline error: ${e?.message ?? e}` })))
    if (result.status === 'merge-ready') {
      units.set(unit.id, result)
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
const intProv = await provision(intWt, 'provision:integration')
if (!intProv.ok) throw new Error(`integration worktree provisioning failed: ${intProv.detail}`)

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

await checkpointChain
return serialize()
