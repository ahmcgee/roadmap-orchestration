export const meta = {
  name: 'roadmap-wave',
  description: 'Execute one wave of a roadmap plan: per-unit build/gate pipelines and a serial merge queue',
  phases: [
    { title: 'Setup', detail: 'integration + unit worktrees' },
    { title: 'Implement', detail: 'Opus plan + codex build (Haiku steer)' },
    { title: 'Architect', detail: 'plan-check + exit gate (Fable)' },
    { title: 'Opus-gate', detail: 'Opus exit gate; escalates to Fable when hard' },
    { title: 'Verify', detail: 'build/tests (Haiku)' },
    { title: 'Fix', detail: 'codex resume applies findings/directives' },
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
  maxStops: 5,               // escalation-ladder rounds per unit. Generous units mean several
                             //   stops are normal; this is a runaway brake, not a rationing rule.
  // Reporting cap on a single adversarial pass (gate directives per revise round). A cap on
  // REPORTING, never on reading — overflow past it is banked as debt, not dropped. Enforced
  // code-side, never as schema maxItems (a schema rejection burns the retry cap and kills the
  // call — the documented StructuredOutput death class).
  maxBlockingFindings: 6,
  // Fable is the frontier judgment tier (plan-check, exit gate, mid-loop consult, boundary
  // triage). Fable 5's guidance makes `high` the default for real adjudication — and these calls
  // fire only on the hard decisions — so they run there rather than on the floor. `fableEffort`
  // covers the plan-check + consult; the exit gate has its own `gateEffort`, and the audit
  // spot-check `auditEffort` can be dialled below a full gate to keep the 10% sample cheap.
  fableEffort: 'high',
  gateEffort: 'high',
  // Opus reasoning effort, two knobs. `implementEffort` covers the code-authoring pipeline —
  // planning, implementing, and every fix loop (incl. the post-impl debt-fix round);
  // `opusEffort` covers every other Opus call (boundary assessors, review, opus-first
  // plan-check/gate, merge resolution, conductor triage). Opus 5 holds review and coding
  // quality at `medium` at a fraction of the tokens; raise per-arc via plan.config if a
  // workload proves effort-sensitive.
  implementEffort: 'medium',
  opusEffort: 'medium',
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
  auditEffort: 'high',
  boundary: 'on',            // 'on' | 'off' — wave-tail explorer + health assessor inside the
                             //   workflow; 'off' for the arc's final wave (the session
                             //   integration review supersedes it)
  healthCheck: 'each-wave',  // 'each-wave' | 'off' — the health-assessor half of the boundary
  flakeReruns: 3,            // full-suite re-runs hunting intermittents; 0 disables
  /* ---- Codex executor lane (Codex is REQUIRED — there is no Claude implementation lane).
     The implementer is `codex exec`, launched as a background process by a cheap steering
     agent inside the unit worktree; Claude keeps every judgment surface (plan, plan-check,
     verify, gates, consults, merge). All facts these knobs rely on are pinned by
     evals/codex-probe.sh (P1) — read it before changing invocation shape. ---- */
  codexModel: 'gpt-5.6-sol',  // -m <model>; null = omit the flag (fall back to Codex's own config)
  codexEffort: 'high',        // -c model_reasoning_effort= — under-provisioned effort is the
                              //   top documented cause of bad Codex output; xhigh for hard arcs
  codexFixEffort: 'medium',   // resume/fix rounds are narrower work than the build
  codexSandbox: 'danger-full-access',  // DELIBERATE, and measured rather than assumed. Codex's OS
                              //   sandbox is built with bubblewrap, which needs an unprivileged
                              //   user namespace. A devcontainer whose runtime seccomp profile
                              //   blocks that syscall (`unshare --user` -> EPERM, even with
                              //   kernel.unprivileged_userns_clone=1) cannot build one, so
                              //   'workspace-write' degrades SILENTLY to no enforcement at all:
                              //   probe-observed, Codex wrote to an absolute path outside its
                              //   worktree under that setting. It was therefore buying zero
                              //   protection while still costing reliability — every apply_patch
                              //   went through a bwrap verification helper that failed and
                              //   retried. Sibling-worktree containment is accepted as a RISK
                              //   here, not enforced. Set back to 'workspace-write' in any
                              //   environment that permits user namespaces, where it is real.
  codexNetwork: false,        // -c sandbox_workspace_write.network_access=true when true
  codexTimeoutMin: 240,       // build deadline before kill-and-assess. This knob — not the
                              //   Phase-0 sizing prose — is the binding constraint on unit size:
                              //   units are sized by what we can specify, and Codex runs the
                              //   horizon. Per-milestone commits are what make a kill survivable.
  codexFixTimeoutMin: 45,     // resume-round deadline (fix rounds and adjudicated resumes)
  codexSteerModel: 'haiku',   // steering tier; 'sonnet' if Haiku proves unable to drive it (P2)
  codexMaxConcurrent: 4,      // semaphore on concurrent codex processes (one OpenAI account)
  gateMaxConcurrent: 4,       // semaphore on concurrent TEST lanes (verify, gate re-verify, and the
                              //   integrated suite at merge). Unit dispatch is deliberately unbounded —
                              //   the units are cheap to start and mostly wait on codex — but their test
                              //   lanes are not: N full suites on one box is load the orchestrator itself
                              //   creates, and wall-clock budgets are then judged against a host it
                              //   saturated (arc-observed: loads of 28-56 on 16 cores, three false
                              //   env-quarantines in one wave). Throughput-only, like codexMaxConcurrent:
                              //   prompts are unaffected, so resumeFromRunId replay is safe.
  codexProfile: null,         // -p <profile> ($CODEX_HOME/<name>.config.toml) when set
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
// Codex process artifacts live OUTSIDE the repo, same contract as the preview pidfile: brief +
// output schema in, events/last-message/stderr/exit-code/session-id out. Structurally outside
// every worktree's tracked tree, so the NOROADMAP write-bar and the merge fence can never see
// them; kept until close-out (SKILL.md) for post-hoc forensics — a degradation's `what` names
// the directory to read. Layout: ${wtRoot}/__codex/<unit>/<step>/{brief.txt,schema.json,
// events.jsonl,last-message.txt,stderr.log,exit-code,session-id,cwd,done.txt,codex.pid,launched-at}
const codexHome = plan.codex?.home ? `CODEX_HOME=${plan.codex.home} ` : ''
const codexDir = (id, step) => `${wtRoot}/__codex/${id}/${step}`
// Location discipline for mechanical agents: smoke testing showed that given a bad path
// they improvise in their cwd and report plausible success. Fail-loud beats adaptive.
const STRICT = 'Start by `cd` to the exact absolute path named in this task — if the cd fails or the directory ' +
  'is not the described git checkout, report ok/pass as false with the exact error and stop. Never substitute ' +
  'your current working directory, the enclosing project, or any other repository. '
// Report discipline for the code-writing agents: commit first (the commit is the deliverable,
// and it is what makes a killed unit recoverable), then keep the structured report short. The
// platform's schema-retry resends an over-long payload verbatim until the unit dies, so an
// oversized report can waste all the work it describes.
// Every budget here is stated because the cap exists: 2026-07-18 evidence is that opus structured-
// output deaths happened ONLY on capped schemas (16/62 vs 0/102 uncapped), and a cap the model is
// never told is one it cannot respect. Which FIELD overran is unknown — no payloads survive — so
// every capped field names its budget rather than betting on one.
const REPORT = 'Commit your work BEFORE emitting the structured report — the commit is the deliverable. Then keep ' +
  'every free-text field terse and inside its budget: `summary` 2–3 short sentences (max 700 characters); ' +
  '`contractMismatch` one or two sentences (max 300 characters), left empty unless it truly applies; `specGap` ' +
  'likewise one or two sentences (max 300 characters), left empty unless it truly applies; each `debt` ' +
  "entry's `what` and `why` a sentence or two (max 400 characters each); `notes` at most a short paragraph " +
  '(max 2000 characters). An oversized report fails validation and can kill this unit even though the work is done. '
// .roadmap/ belongs to the orchestrator, never to a coding agent. Arc-observed: an
// implementer that respected the write-bar still left a "see debt.md" comment for an
// entry it could not write, and a gate quarantined partly on the phantom reference.
const NOROADMAP = `You cannot create or modify anything under ${repo}/.roadmap/ — that directory is the ` +
  `orchestrator's. Never leave code comments or commit messages referencing debt-ledger or dossier entries: ` +
  `you cannot write those entries, so the reference would be fabricated. Report deviations and deferred ` +
  `imperfections ONLY through your structured output fields. `
// EVERY prompt whose schema carries a maxLength must also carry this. A cap is a contract with the
// model, and the prompt is the only place that contract is communicated — a capped field with no
// matching instruction is a trap: the agent overruns it, burns its schema-retries, and dies
// returning null (arc-observed: the conductor's triage prompt had a 600-char `notes` cap, no
// terseness clause, and an invitation to put overflow THERE — it died at two consecutive
// boundaries). Applied as a const, not remembered per-prompt, so it cannot drift out of a new prompt.
const TERSE = 'Keep every free-text field terse — an oversized report fails schema validation and the work is ' +
  'lost. Free-text fields are for what the structured fields cannot carry, not a transcript of your reasoning. ' +
  'Respect every character budget named below exactly, keep each finding to a sentence or two, and emit no ' +
  'field the schema does not define — an unexpected key is rejected as hard as an over-long one. '
// The banking bar, shared by both exit gates. REWRITTEN for the pinned-scope discipline: the old
// form keyed "must fix" on the LIVE diff ("a file this diff touches"), so the eligible-fix set was
// a function of the diff's own growth — and scope→diff→fixes→scope is the closed loop that IS the
// review spiral (RATIONALE: the spiral, named). Banking is now the DEFAULT outside the unit's
// pinned scope; correctness inside it still blocks at any severity, and the correctness-never-banks
// coercion below is unchanged. This knowingly re-creates the §15 debt-volume symptom and trades it
// for diff discipline: a banked item costs one boundary-triage read; a widened diff costs re-review
// on every later round and raises regression odds. Do not tighten this back toward the live diff.
const DEBT_DISCIPLINE = 'Debt discipline: banking is the DEFAULT for anything outside this unit\'s declared ' +
  'scope; blocking is the default for correctness inside it. A defect in scope that makes the spec\'s ' +
  'behaviour wrong, violates a contract or the conventions contract, or leaves an acceptance criterion ' +
  'untested is a revise directive whatever its severity, and may never be banked. Everything else is debt: ' +
  'record it in `debt` (what, why, severity, kind, bankReason — each `what` and `why` a sentence or two, max ' +
  '400 characters each) with bankReason one of: out-of-scope-file | needs-migration-or-ruling | ' +
  'pre-existing-untouched, and do NOT write a directive for it — a directive that widens the diff beyond ' +
  'this unit\'s scope costs more than the imperfection it removes. Structure, naming, ergonomics and ' +
  'tidiness are debt even in scope, unless leaving one would make the NEXT change to that file materially ' +
  'wrong or unsafe — not merely less pleasant. A correctness-kind item is never bankable — you may not ' +
  'approve while one exists; revise or escalate instead. '
// The pinned scope envelope, stated to every code-writing agent (the Codex brief's Constraints
// block; FIX_SCOPE is the fix-round counterpart). Scope is computed ONCE per unit before the
// first fix round — fresh build: the approved plan's `files`; adopted branch: the diff at entry
// — and NEVER recomputed from the live diff. Pinning is the
// mechanism, not the membership rule: the spiral's first clause defined the eligible-fix set as
// "files you are already touching", i.e. as a function of the diff the fix rounds themselves grow.
// Do not "simplify" this back to the live diff.
// `plan.scopeAllow` (optional globs — evidence dirs, test files, rehearsal transcripts) names files
// the repo's conventions put in EVERY unit's scope: they are stated to the implementer alongside the
// pinned files and never counted as scope growth, so `scope-growth` stays a real signal instead of
// re-adjudicating the unit's own screenshots at every gate. Absent → the clause is '' and the
// SCOPE/FIX_SCOPE text is byte-identical to before (the paid fixtures depend on that). This is an
// exclusion from the growth CHECK, not a widening of the pinned envelope.
const scopeAllow = plan.scopeAllow ?? []
// Minimal glob → RegExp (no Node APIs here): `**/` = zero or more directories, `**` = anything,
// `*` = any run without `/`. Matched against the diff's repo-relative paths.
const globRe = (g) => new RegExp('^' + g.split('**/').map((part) => part.split('**').map((seg) =>
  seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')).join('(?:.*/)?') + '$')
const scopeAllowRes = scopeAllow.map(globRe)
const scopeAllowed = (f) => scopeAllowRes.some((re) => re.test(f))
const scopeAllowClause = scopeAllow.length
  ? `, plus by repo convention any file matching: ${scopeAllow.join(', ')}` : ''
const SCOPE = (files) =>
  `Scope is fixed before you start and does not grow as you work. In scope: ${
    files?.length ? files.join(', ') : "the files this unit's diff already touches"}${scopeAllowClause}, plus any file you must ` +
  `change to make an acceptance criterion pass — name each such extra file in \`notes\` with a one-line ` +
  `reason (\`notes\` is at most a short paragraph, max 2000 characters). Inside that scope, finish the job ` +
  `properly: wrong behaviour, a missing acceptance test, or a test that would still pass if the behaviour ` +
  `were wrong is yours to fix now, not to defer. Outside it, an imperfection is not yours to fix however ` +
  `easy it is and however plainly wrong it looks — record it in \`debt\` (what, why, severity, kind, and a ` +
  `bankReason from: out-of-scope-file | needs-migration-or-ruling | pre-existing-untouched; each \`what\` ` +
  `and \`why\` a sentence or two, max 400 characters each) and leave the code as it stands. Opportunistic ` +
  `refactoring, renaming, reformatting, tidying adjacent code and improving what the spec did not ask for ` +
  `are excluded from this unit: every one widens the diff a reviewer must read, and a wider diff produces ` +
  `more findings, which produce more fixes. If the spec genuinely cannot be satisfied inside this scope, ` +
  `that is a finding, not a licence — say so in \`specGap\` (one or two sentences, max 300 characters) and ` +
  `stop widening. `
// Fix rounds license exactly the named repairs, nothing adjacent — the counterpart of SCOPE for
// directive-driven work, threaded into every prompt that hands findings/directives to a fixer.
const FIX_SCOPE = (files) =>
  `Fix exactly what is listed above and nothing else. The files you may touch are: ${
    files?.length ? files.join(', ') : "this unit's declared scope"}${scopeAllowClause}, plus any file named in the findings or ` +
  `directives you are addressing. Touching anything outside that set is a scope violation, not initiative — ` +
  `if a listed fix truly cannot be made without it, make the minimal necessary change and name the file and ` +
  `the reason in \`notes\` (at most a short paragraph, max 2000 characters). Do not refactor, rename, ` +
  `reformat, tidy or improve anything the findings did not name; do not add tests for behaviour they did ` +
  `not name; do not re-litigate a finding you disagree with — implement it, or say in \`notes\` why it is ` +
  `wrong and leave the code as it is. `
// The bounded finding policy, shared by both exit gates. Replaces the "over-reporting costs
// nothing" coverage doctrine: every finding becomes a fix round, every fix widens the diff the
// next pass re-reads, and that compounding loop — not any single bad finding — is what burned
// whole arcs. Bounds the REPORTING, never the reading.
const FINDING_BAR = (noun) =>
  `Report a ${noun} only when all three hold: this diff introduced the problem, or the spec requires ` +
  `something the diff omits; you can state the evidence in one sentence — for a spec, contract or ` +
  `conventions violation, QUOTE the clause violated; and it falls in one of exactly four categories: ` +
  `(1) incorrect behaviour; (2) a spec, contract or conventions violation; (3) an acceptance criterion left ` +
  `untested, or a test that would still pass if the behaviour were wrong; (4) scope creep — behaviour or ` +
  `files in this diff that the spec did not ask for. Nothing else qualifies: not style, naming or ` +
  `formatting, nothing a linter, formatter or typechecker enforces, no preference without a defect behind ` +
  `it, and never the same defect twice under two headings. Under-reporting a real defect and over-reporting ` +
  `a non-defect are BOTH failures here: every ${noun} becomes a fix round, and every fix widens the diff ` +
  `that must be read again. `
// `contractMismatch` is a TRIGGER, not a notes field: its mere PRESENCE fires the architect consult,
// forces the (metered) Fable exit gate, banks a kind:'contract' debt entry, and bounces the whole run
// back to the root for a contract amendment. The model must be told that, or it uses the field as a
// scratchpad — arc-observed: an implementer wrote "None. FYI: ..." (explicitly stating no contract was
// contradicted) and cost a frontier gate plus a full root round-trip on a non-existent amendment.
// NOTE: deliberately no code-side "is this really a mismatch" guard. Suppressing a genuine
// frozen-surface deviation (the H-7 failure, RATIONALE §10) is far worse than an extra escalation, and
// any string-matching heuristic would eventually swallow a real one. Over-escalation is the safe error.
const MISMATCH_IS_A_TRIGGER =
  'Leave `contractMismatch` EMPTY unless you actually deviated from a frozen contract surface. It is a trigger, ' +
  'not a notes field: merely filling it in escalates to the frontier architect and returns the whole run for a ' +
  'contract amendment. Never write "none" or an FYI there — observations, caveats and things you merely want ' +
  'flagged go in `notes` or `debt`. '
// The pull-channel to the architect (feedback 10a). Evidence for its existence: the mechanical
// rescue triggers fired ZERO times in 92 units, while every real failure was a silent design
// decision under a spec that didn't cover it. The same scratchpad-abuse discipline as
// MISMATCH_IS_A_TRIGGER applies — an FYI here costs a frontier consult.
const GAP_IS_A_TRIGGER =
  'Separately, `specGap` is your pull-channel to the architect: fill it ONLY when you made (or must make) a ' +
  'decision the spec does not settle and reasonable engineers would diverge — one or two sentences stating the ' +
  'decision you took and the alternative. It is a trigger: its mere presence consults the frontier architect, who ' +
  'may redirect the work. Routine judgment calls you are confident in, observations, and deferrals do not belong ' +
  'there — those go in `notes` or `debt`. '
// The arc's DIRECTION — the architect's steering, threaded into JUDGMENT surfaces only.
// architect-log.md already exists and is already seeded at Phase 0, but until now it reached the
// conductor's boundary agents alone: plan-check, the exit gate and the escalation adjudicator saw
// spec + contracts + conventions, which say what must be TRUE and never what the arc is aiming at.
// That left the ladder's `decided` tier picking between defensible options on local reasoning —
// arc-observed (horizon fixture, run 3): a named open decision with two defensible answers and no
// principle available to choose by. Direction is a TIE-BREAKER, strictly subordinate: it steers
// where the spec and the contracts are silent, and it never overrides either. It is deliberately
// absent from every Codex brief — a target state in an implementer's prompt is an invitation to
// build the end state instead of the unit.
const architectLog = plan.architectLog ?? `${repo}/.roadmap/architect-log.md`
const directionClause = plan.direction === false ? '' :
  `The arc's DIRECTION — where this codebase is deliberately heading, and the preferences to break ties ` +
  `by — is the "## Direction" section of ${architectLog}; read it before you rule. It is subordinate to the ` +
  `spec and the frozen contracts: where they settle a question it does not apply, and it never licenses ` +
  `widening scope. Where they are silent and two answers are both defensible, prefer the one the direction ` +
  `leans toward, and say which preference decided it. `
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
    `follow; treat it as a frozen contract alongside the unit's own. Reimplementing a catalogued shared ` +
    `utility inside this unit's own diff is a violation of that contract, not a style preference: it blocks, ` +
    `and it is never bankable as structure. `
  : ''
// Design authorities bind like contracts (SKILL.md Phase 0). Arc-observed: without this, UI units
// built without their comps in the fork base and "comp-conformant" criteria were graded by jsdom
// presence tests — the result was systematic bespoke reimplementation of every designed screen.
// The dominant failure was ADOPTION, not visual drift, and adoption is judgeable from the comp
// SOURCE by a text agent, so this clause carries the per-unit half; the eyes live at the boundary.
// Same idiom as convClause: '' when the unit cites no design, leaving every prompt byte-identical
// on arcs without designAuthorities (the property the sims assert, and what makes the paid
// fixtures valid evidence for changes that ride alongside this one).
const authOf = (cite) => (plan.designAuthorities ?? []).find((a) => a.id === String(cite).split('#')[0])
const designClause = (unit) => unit.design?.length
  ? `This unit's surface is governed by design authorities — binding sections: ${unit.design.join(', ')}; ` +
    `source in-repo at ${[...new Set(unit.design.map((d) => authOf(d)?.path).filter(Boolean))].join(', ')}. ` +
    `A comp binds like a frozen contract: adopt the comp's component and wire it through thin adapters — never ` +
    `rebuild a designed screen from primitives. Partial adoption can be right, but it is a deliberate choice: ` +
    `it must be stated and justified, never left to pass silently. `
  : ''
// GitHub issue projection (issue mode only; reference.md "GitHub issue tracking"). Issues MIRROR the
// work — the scheduler stays on state.json, which the script owns; agents (not the script) run gh.
// Every clause below is a BEST-EFFORT trailing addendum to an agent whose real job is elsewhere, and
// resolves to '' in file mode so every prompt stays byte-identical to the legacy path (the property
// the sims assert and the paid fixtures rely on). Sync is idempotent by a body MARKER, never by a
// threaded issue number (numbers are non-deterministic and would break resumeFromRunId): a stale or
// absent unit.issue cache is harmless. A gh failure is swallowed and reconciled by the wave-tail
// sweep (syncIssues) — no unit or wave outcome may ever depend on issue state.
const issueMode = plan.tracking === 'issues'
const ghRepo = plan.repoSlug ? `--repo ${plan.repoSlug} ` : ''
// Resolve a unit's issue number into $ISS. Prefer the cached number (recorded at Phase 0 — exact and
// immune to GitHub search-index lag on a just-created issue); fall back to the body marker for resume
// or when the cache is absent. Either way the semantics are find-by-id, never thread-a-dependency.
const findIssue = (id, cached) =>
  cached != null
    ? `ISS=${cached}; `
    : `ISS=$(gh issue list ${ghRepo}--search '"roadmap:unit id=${id}" in:body' --state all --limit 1 --json number --jq '.[0].number' 2>/dev/null); `
const GH_BEST_EFFORT = 'Do the following on a BEST-EFFORT basis, only AFTER the work above is finished and its ' +
  'result decided: if any gh command errors (no network, auth, rate limit, missing issue), ignore it and carry ' +
  'on — issue state is observability, never a gate, and a wave-tail sweep reconciles anything missed. '
const ghRunning = (unit) => issueMode
  ? `\n${GH_BEST_EFFORT}If and only if you set up a buildable worktree (you reported state 'ready' or 'adopted'), ` +
    `mark this unit's tracking issue in progress: ${findIssue(unit.id, unit.issue)}` +
    `if $ISS is non-empty, run \`gh issue edit ${ghRepo}"$ISS" --remove-label status:pending --add-label status:running\`. `
  : ''
const ghMerged = (unit) => issueMode
  ? `\n${GH_BEST_EFFORT}If and only if the merge LANDED and the full suite PASSED, close this unit's tracking ` +
    `issue as done: ${findIssue(unit.id, unit.issue)}if $ISS is non-empty, run ` +
    `\`gh issue edit ${ghRepo}"$ISS" --remove-label status:running,status:merge-ready --add-label status:merged\` ` +
    `then \`gh issue close ${ghRepo}"$ISS" --reason completed --comment "Merged into ${intBranch}."\`. ` +
    (unit.closes?.length
      ? `Under the same condition (merge landed, suite passed), also close each issue this unit RESOLVES: ` +
        unit.closes.map((n) =>
          `\`gh issue close ${ghRepo}${n} --reason completed --comment "Resolved by unit ${unit.id} (merged into ${intBranch})."\``).join('; ') +
        ` — skip any already closed. `
      : '')
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
// Escalation ledger. Every ruling on an implementer stop, arc-cumulative: which tier answered it,
// which boundary it crossed, and who ruled. Two consumers beyond forensics — the three-strikes
// rule needs a count that survives a unit re-entering in a LATER wave (the in-pipeline counter
// resets), and escalation-rate-per-unit is the calibration signal that replaced the old
// self-estimated "0.5-2 agent-hours" sizing heuristic. A unit that stopped five times was
// under-specified; one that never stopped could have been sized larger.
const escalationLog = [...(prior.escalations ?? [])]
// Normalized against the schema enums: an out-of-enum kind (the old 'quality' default was one)
// rode into state.json and collapsed unpredictably downstream. 'contract' is legal here — the
// mismatch pathway stamps it directly and the conductor routes on it.
const DEBT_KINDS = ['correctness', 'test', 'structure', 'ergonomics', 'contract']
const DEBT_BANK_REASONS = ['out-of-scope-file', 'needs-migration-or-ruling', 'pre-existing-untouched']
const addDebt = (unitId, sha, items, defaults = {}) => {
  for (const d of items ?? []) {
    if (!d) continue
    const o = typeof d === 'string' ? { what: d } : d
    const kind = [o.kind, defaults.kind].find((k) => DEBT_KINDS.includes(k)) ?? 'structure'
    const bankReason = [o.bankReason, defaults.bankReason].find((r) => DEBT_BANK_REASONS.includes(r))
    debtLog.push({
      unit: unitId, sha, kind,
      severity: o.severity ?? defaults.severity ?? 'minor',
      what: o.what ?? o.summary ?? '', why: o.why ?? '',
      ...(bankReason ? { bankReason } : {}),
    })
  }
}
// Gate coercion helpers: a gate that APPROVES while holding a correctness-kind debt item is the
// verdict-downgrade path the debt discipline forbids — the items become revise directives instead.
const correctnessDebt = (items) => (items ?? []).filter((d) => d && typeof d === 'object' && d.kind === 'correctness')
const asDirectives = (items) => items.map((d) => ({
  what: `Fix now (correctness debt is not bankable): ${d.what}`,
  why: d.why || 'a correctness-kind finding blocks approval; banking it would ship a known bug',
}))
// Skill-defect ledger for THIS wave: every time the ORCHESTRATOR's own machinery misbehaves — an
// agent dies without a report, a schema-retry fires, a salvage rescues a null — record it here
// instead of silently swallowing it. Rides back in the wave state; the root renders it into
// .roadmap/skill-feedback.md. Every safety net below is otherwise SILENT, which is exactly how a
// deterministic schema-cap bug masqueraded as three runs of "network flakiness" (RATIONALE §14).
// Defects in the ORCHESTRATOR only — product imperfections go to `debt`, a different audience.
const degradations = []
const degrade = (o) => {
  degradations.push({ script: 'harness', wave: (prior.wave ?? 0) + 1, ...o })
  log(`DEGRADED [${o.label ?? 'agent'} · ${o.model}] ${o.what}`)
}

/* ------------- host load: recorded, never gated on (wave-scoped) -------- */
// Two closed commands appended to every lane that spends the box's cores. Courier work — the
// lane reports the numbers, nobody judges them. The point is auditability: a unit quarantined for
// breaching a wall-clock budget at load 35 on 16 cores is a scheduling artefact, and without the
// numbers on the record that is indistinguishable from a real defect (arc-observed 2026-08-26).
// Deliberately NOT a gate: the load is largely self-inflicted, so waiting on it would wait on our
// own siblings. (Docs pass: fold onto the shared courier-prompt helper when one lands.)
const LOAD_FACTS =
  'Also report loadavg1 = the first number printed by `cat /proc/loadavg`, and cpuCount = the number printed ' +
  'by `nproc` — run those two commands exactly and report what they print, as numbers. '
// Most recent load pair any lane reported, so a degradation raised where no verify result is in
// hand (a codex wall-clock kill) can still cite the host it happened on.
let lastLoad = null
const noteLoad = (v) => {
  if (typeof v?.loadavg1 === 'number' && typeof v?.cpuCount === 'number')
    lastLoad = { loadavg1: v.loadavg1, cpuCount: v.cpuCount }
}
const loadNote = (v) => {
  const l = (typeof v?.loadavg1 === 'number' && typeof v?.cpuCount === 'number') ? v : lastLoad
  return l ? ` [host load ${l.loadavg1} on ${l.cpuCount} cpu]` : ''
}

/* ------------- shared-red circuit breaker (wave-scoped) ----------------- */
// One pre-existing red outside every unit's diff used to be judged N times independently: N fix
// rounds, N scope-creep patches to the same file on N branches, then quarantines for a failure no
// unit caused (arc-observed 2026-08-25). The breaker collapses that into one signal. A failing
// spec claimed by >= 2 units that appears in NONE of their diffs is not a unit defect — it is one
// shared assertion. It is degraded ONCE, suppressed in every affected unit's fix rounds (the units
// proceed on their remaining failures), and surfaced to the boundary as a FINDING.
//
// A finding, never a debt item, and that distinction is load-bearing: debt must never create a
// wave (that brake is what makes arcs terminate), so a shared red rides the promote/escalation
// path instead, which the cut line already brakes.
const specOwners = new Map()   // failing spec path -> Set(unitId)
const unitDiffs = new Map()    // unitId -> Set(diffFiles), the diff at the time of that verify
const sharedReds = new Map()   // failing spec path -> { spec, units, wave }
const noteFailingSpecs = (unitId, v) => {
  noteLoad(v)
  if (!v || v.pass || v.blocked) return
  unitDiffs.set(unitId, new Set(v.diffFiles ?? []))
  for (const f of v.failingSpecs ?? []) {
    if (!f) continue
    if (!specOwners.has(f)) specOwners.set(f, new Set())
    specOwners.get(f).add(unitId)
  }
  for (const [f, owners] of specOwners) {
    if (sharedReds.has(f) || owners.size < 2) continue
    // If any claimant's own diff touches the spec, it is that unit's business, not a shared red.
    if ([...owners].some((id) => unitDiffs.get(id)?.has(f))) continue
    sharedReds.set(f, { spec: f, units: [...owners], wave: (prior.wave ?? 0) + 1 })
    degrade({ label: `shared-red:${f}`, model: 'haiku', phase: 'Verify', kind: 'shared-red',
      what: `${f} fails for ${owners.size} units (${[...owners].join(', ')}) and appears in none of their ` +
        `diffs — a shared pre-existing red, not a unit defect${loadNote(v)}. Fix rounds for it are suppressed ` +
        `on every affected unit, and it goes to the boundary as ONE finding to adjudicate` })
  }
}
const suppressedSpecs = (v) => (v?.failingSpecs ?? []).filter((f) => sharedReds.has(f))
// True when the breaker has taken over this verify's ENTIRE red: the unit has nothing of its own
// left to fix, so it proceeds to its gates on the work it actually did rather than burning fix
// rounds — or a quarantine — on somebody else's assertion.
const fullySuppressed = (v) =>
  !!v && !v.pass && !v.blocked && (v.failingSpecs?.length ?? 0) > 0 &&
  suppressedSpecs(v).length === v.failingSpecs.length
const sharedRedClause = (v) => {
  const f = suppressedSpecs(v)
  return f.length
    ? ` These failing specs are a SHARED pre-existing red — they fail for several units and no unit's diff ` +
      `touches them: ${f.join(', ')}. They are being adjudicated once at the boundary. Do not attempt to fix ` +
      `them and do not edit them; fix only the remaining failures.`
    : ''
}

/* ------------- gate scope rulings + precedent (wave-scoped) ------------- */
// The breach was always recorded (a `scope-growth` degradation); the gate's approve/revert VERDICT
// on each out-of-scope file never was, so a later gate had nothing to be consistent with and two
// identical breaches in one wave got opposite answers (arc-observed 2026-08-23). Record the
// rulings, then hand a gate the ones its siblings already made.
const scopeRulings = []
const recordScopeRulings = (unitId, g) => {
  for (const r of g?.scopeRulings ?? [])
    if (r?.file && (r.verdict === 'approve' || r.verdict === 'revert'))
      scopeRulings.push({ unit: unitId, file: r.file, verdict: r.verdict })
}
// Deterministically ordered and capped, so the clause is a pure function of the rulings recorded
// so far. It IS order-dependent across concurrent units, which is the one price here: a resume
// whose gate ordering differs sees a different prompt and re-runs the call instead of replaying it
// from the journal — a cache miss, never a wrong answer.
const scopePrecedent = (unitId) => {
  const rows = scopeRulings.filter((r) => r.unit !== unitId)
    .sort((a, b) => (a.unit === b.unit ? a.file.localeCompare(b.file) : a.unit.localeCompare(b.unit)))
    .slice(0, 12)
  return rows.length
    ? ` Precedent — rulings other gates already made on out-of-scope files this wave. Follow them unless you ` +
      `can say what makes this case different: ${rows.map((r) => `${r.file} (${r.unit}) → ${r.verdict}`).join('; ')}.`
    : ''
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
    // A schema-retry firing is itself a signal: one is noise, a pattern means a cap is wrong.
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'schema-retry',
      what: `structured output rejected, retrying — ${String(e?.message ?? e).slice(0, 200)}` })
    return agent(
      prompt + ' IMPORTANT: your previous structured report was REJECTED, so the work may be done but unrecorded. ' +
      'Emit exactly the requested schema and no other keys — an unexpected key is rejected as hard as an ' +
      'over-long one. Cut every free-text field to one sentence; drop optional fields entirely rather than ' +
      'filling them. Do not redo the task: if the commit already exists, report what it did.',
      { ...opts, label: `${opts.label ?? 'agent'}#retry` })
  }
}
// agent() RESOLVES TO null (it does NOT throw) when a subagent dies — a terminal API error, or its
// own schema-retries exhausted. run()'s StructuredOutput retry above only fires on a THROW, so it
// never covers that path. Any result that gets DEREFERENCED must funnel through runOr(), which
// re-runs the shorten-aggressively rescue on a null and then falls back. Wave-level calls
// (integration worktree setup, provisioning) are the fatal ones: a null there is a TypeError that
// kills the whole wave — and, under the conductor, the whole multi-wave run.
// The null carries NO error object — the platform tells us nothing about why. So record what we DO
// know (which agent, where) and point at the transcript; that is the difference between "the network
// is flaky, probably" and "read agent-*.jsonl for label X".
// A dead REPORT is not a dead UNIT. 2026-07-18, twice: a code-writing agent committed its work,
// then its structured report was rejected five times, `run()` rethrew, and the scheduler's catch
// quarantined a unit whose commits were on the branch and correct. The architect re-verified and
// resurrected both by hand. REPORT's commit-first discipline exists precisely so the commit
// survives the report — this sentinel is the other half of that bargain: when a code-writing
// agent's report is lost, ASK THE BRANCH what happened instead of assuming the worst.
const REPORT_LOST = { summary: '(report lost — see degradations)', filesChanged: [], reportLost: true }
const runOr = async (fallback, prompt, opts) => {
  const r = await run(prompt, opts).catch((e) => {
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'threw',
      what: `threw — ${String(e?.message ?? e).slice(0, 200)}` })
    return null
  })
  if (r) return r
  degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'no-report',
    what: 'agent died without a report (agent() returned null — cause not exposed by the platform); ' +
      'salvaging once, then falling back. Read the agent transcript for the real error.' })
  const retried = await run(
    prompt + ' IMPORTANT: your previous report was rejected — most likely a free-text field exceeded ' +
    'its maximum length. Shorten EVERY free-text field aggressively; one sentence each is acceptable. ' +
    'Emit exactly the requested schema and no other fields.',
    { ...opts, label: `${opts.label ?? 'agent'}#salvage` },
  ).catch(() => null)
  if (!retried)
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'salvage-failed',
      what: 'salvage retry also produced no report — degrading to the coded fallback' })
  return retried ?? fallback
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
// wave's debt ledger. Banking is not free-form: `bankReason` is the closed set of legitimate
// grounds for deferring instead of fixing (arc-observed: ~350 banked items in one arc, most of
// them fix-in-unit corrections — "minor" alone is never a reason to bank). The code-writing
// schemas leave it optional (their debt is a confession that triggers a fix round, not a bank
// request); the exit-gate schemas REQUIRE it — an approve is where banking actually happens.
const BANK_REASONS = ['out-of-scope-file', 'needs-migration-or-ruling', 'pre-existing-untouched']
const debtItem = (req) => obj({
  what: { type: 'string', maxLength: 400 }, why: { type: 'string', maxLength: 400 },
  severity: oneOf(['minor', 'major']), kind: oneOf(['correctness', 'test', 'structure', 'ergonomics']),
  bankReason: oneOf(BANK_REASONS),
}, req)
const debtArr = { type: 'array', items: debtItem(['what']) }
const gateDebtArr = { type: 'array', items: debtItem(['what', 'bankReason']) }
const directiveArr = { type: 'array', items: obj({ what: { type: 'string' }, why: { type: 'string' } }, ['what', 'why']) }
// One entry per out-of-scope file the gate adjudicated: the VERDICT, which was previously never
// written down anywhere (only the breach was). Wave-scoped precedent is built from these, so two
// identical breaches in one wave get the same answer. A completeness list bounded by the diff.
const scopeRulingArr = { type: 'array', items: obj({ file: { type: 'string' },
  verdict: oneOf(['approve', 'revert']) }, ['file', 'verdict']) }
// Codex process metadata, attached by the steering agent to its S.impl-shaped report. All
// scalars read mechanically from the artifact dir (exit-code file, events.jsonl greps, git) —
// never recalled from memory; `error` is the one capped prose field (the tail of the error
// grep). `commits` = `git rev-list --count base..HEAD`, the disk truth every downstream
// decision keys on; `doneMarker` = the brief's own DONE file appeared (finished vs ran-dry).
const CODEX_META = obj({
  exitCode: { type: 'number' }, commits: { type: 'number' }, turns: { type: 'number' },
  inputTokens: { type: 'number' }, outputTokens: { type: 'number' },
  timedOut: { type: 'boolean' }, doneMarker: { type: 'boolean' }, limitHit: { type: 'boolean' },
  sessionCaptured: { type: 'boolean' }, error: { type: 'string', maxLength: 300 },
}, ['exitCode', 'commits'])
const EVIDENCE = obj({
  keyFiles: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 } },
  signatures: { type: 'array', maxItems: 15, items: { type: 'string', maxLength: 300 } },
  seams: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 400 } },
})
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
  // Structured/scalar required fields FIRST, the long free-text `approach` LAST (+ the required-array
  // order matches). An Opus agent that emits a long `approach` first tends to bleed the XML tool-call
  // syntax (`</approach><parameter name="files">…`) into the JSON on the transition OUT of the
  // free-text into the next field, dropping every field that follows and burning the structured-output
  // retry cap — same required-first discipline as S.impl (eval-observed on plan:* at the
  // then-default implementEffort 'xhigh': 5 invalid outputs, all missing files/testPlan/feasible
  // that trailed the essay).
  plan: obj({
    feasible: { type: 'boolean' }, files: arr('string'), testPlan: { type: 'string' },
    // Evidence manifest — the plan pass already explored the code; hand that context forward
    // instead of making the implementer re-acquire it (feedback item: the plan should carry
    // context, not just intentions). Optional so pre-0.10 plans and resumes stay valid. The
    // implementer gets it whole (the plan JSON is threaded in); the reviewer gets keyFiles
    // ONLY, as a reading list — its fresh-eyes judgment must stay its own.
    evidence: EVIDENCE,
    approach: { type: 'string' }, notes: { type: 'string' },
  }, ['feasible', 'files', 'testPlan', 'approach']),
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
    // Implementer-pulled consult (10a): a decision the spec does not settle. Presence fires a
    // Fable consult even on an all-green unit (the silent-design-decision class); if the
    // consult budget is spent, it forces the Fable exit gate instead.
    specGap: { type: 'string', maxLength: 300 },
    debt: debtArr, notes: { type: 'string', maxLength: 2000 },
  }, ['summary', 'filesChanged']),
  // The steering agent's report for a codex build/fix step: S.impl plus the process metadata.
  // Downstream (verify/gates/merge/triggers) reads only the S.impl half — S.impl is the seam,
  // and nothing past the steering agent learns who wrote the code.
  get implCodex() {
    return obj({ ...this.impl.properties, codex: CODEX_META }, [...this.impl.required, 'codex'])
  },
  // Opus exit gate: approve as-is, revise (a mechanical fix Opus can specify itself), or
  // escalate to the Fable architect — trigger names the reason frontier judgment is needed.
  opusGate: obj({
    verdict: oneOf(['approve', 'revise', 'escalate']),
    trigger: oneOf(['stuck', 'hard-tradeoff', 'foundational', 'oversight', 'none']),
    directives: directiveArr, debt: gateDebtArr, scopeRulings: scopeRulingArr,
    notes: { type: 'string' },
  }, ['verdict']),
  // Cross-model spec critique (codex-spec-review) — the steering agent's report. `questions`/
  // `risks` are sampling arrays (worst-first, verbatim from the critique); best-effort, gates
  // nothing.
  specReview: obj({
    ok: { type: 'boolean' },
    questions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
    risks: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 300 } },
    notes: { type: 'string', maxLength: 500 },
  }, ['ok', 'questions']),
  // `blocked` = the tooling itself could not run (env/deps/config) — a third outcome,
  // never conflated with a failing assertion. Routed to env-quarantine, not fix rounds.
  verify: obj({
    pass: { type: 'boolean' }, blocked: { type: 'boolean' },
    failures: arr('string'), contractSurfaceTouched: { type: 'boolean' },
    // The diff's name-only file list — the objective input to the code-side scope-growth check
    // (envelope pinning + the scope-creep gate annotation). A completeness list, never capped.
    diffFiles: arr('string'),
    // The failing tests' SPEC FILES (repo-relative paths), one entry per distinct file — courier
    // work, not judgment. Feeds the shared-red circuit breaker, which needs a stable key it can
    // intersect with `diffFiles`; `failures` is verbatim runner output and cannot be keyed on.
    // A completeness list, never capped. Optional: absence only costs the breaker a signal.
    failingSpecs: arr('string'),
    // Host-load facts as read off the box this lane ran on. Recorded, never gated on — the wave's
    // own concurrency is what produces high load, so gating on it would wait on siblings; but a
    // wall-clock verdict ("this unit breached its 100ms budget") is unauditable without it.
    loadavg1: { type: 'number' }, cpuCount: { type: 'number' },
    notes: { type: 'string' },
  }, ['pass', 'blocked', 'failures', 'contractSurfaceTouched', 'diffFiles']),
  // (The standalone adversarial-review stage — and its S.review schema — was removed with the
  // codex executor: the gates carry the hunting clauses. See RATIONALE §17.)
  gate: obj({
    verdict: oneOf(['approve', 'revise', 'quarantine']),
    directives: directiveArr, debt: gateDebtArr,
    scopeRulings: scopeRulingArr,
    notes: { type: 'string' },
  }, ['verdict', 'directives']),
  // 'confirm' exists for the specGap consult (the decision stands as built — no fix round);
  // the stuck-rescue consult never offers it and its prompt is unchanged.
  directive: obj({ action: oneOf(['redirect', 'quarantine', 'confirm']), guidance: { type: 'string' } }, ['action', 'guidance']),
  // The escalation ladder's cheap tier (see the ladder in the unit pipeline). `boundary` is a
  // CLOSED enum on purpose: it is the only thing standing between "Opus triages escalations" and
  // "Opus forwards everything to the frontier", so difficulty must not be expressible as a reason.
  adjudication: obj({
    tier: oneOf(['cited', 'decided', 'escalate']),
    boundary: oneOf(['none', 'contract', 'scope-envelope', 'other-unit', 'plan-of-record', 'mis-specified']),
    guidance: { type: 'string' },
  }, ['tier', 'boundary', 'guidance']),
  dossier: obj({ attempted: { type: 'string' }, evidence: { type: 'string' }, hypothesis: { type: 'string' } },
    ['attempted', 'evidence', 'hypothesis']),
  merge: obj({
    merged: { type: 'boolean' }, suitePass: { type: 'boolean' },
    head: { type: 'string' }, detail: { type: 'string' },
    // Refusal channels, both optional and empty on a clean merge: unit diffs touching the
    // orchestrator's directory (NOROADMAP made mechanical — the merge strips and surfaces),
    // and duplicate numeric prefixes under plan.prefixUniqueGlobs (quarantined, never repaired).
    roadmapPaths: arr('string'), prefixCollision: arr('string'),
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
  // `loads` is the band's per-run load record (one loadavg1 sample taken before each run) plus the
  // box's cpuCount. The band's real co-tenants are its own sibling boundary agents and the preview
  // server — the unit gates have all drained by then — so the flips are not read as caused by the
  // gates; the numbers are here so a triager can tell a flip under saturation from a real sentinel
  // instead of guessing. Recorded, never gated on. Completeness lists, never capped.
  flake: obj({ runs: { type: 'number' }, flips: arr('string'), loads: arr('number'),
    cpuCount: { type: 'number' }, detail: { type: 'string', maxLength: 400 } },
    ['runs', 'flips']),
  // Per-wave design reconcile. The severity split is the atlas2 handoff's own taxonomy, because it
  // is the one that changes what you DO: a bug is a fix unit, an adoption gap is a fix unit that
  // deletes code, and 'irreconcilable' is the signal that a dedicated arc is needed — the finding
  // that arrived a whole arc too late last time. `visionUsed` is REQUIRED and load-bearing: with no
  // screenshot capability provisioned the agent must degrade to comparing DOM against comp source
  // and SAY so, because a fidelity check that silently cannot see is worse than none.
  design: obj({
    findings: { type: 'array', maxItems: 10, items: obj({
      surface: { type: 'string', maxLength: 120 }, comp: { type: 'string', maxLength: 120 },
      severity: oneOf(['bug', 'adoption-gap', 'irreconcilable']),
      what: { type: 'string', maxLength: 400 },
    }, ['surface', 'severity', 'what']) },
    fixUnits: { type: 'array', maxItems: 6, items: obj({
      id: { type: 'string', maxLength: 60 }, goal: { type: 'string', maxLength: 300 },
      files: arr('string'), acceptance: arr('string'),
    }, ['id', 'goal', 'acceptance']) },
    visionUsed: { type: 'boolean' },
    shaObserved: { type: 'string' }, notes: { type: 'string', maxLength: 500 },
  }, ['findings', 'fixUnits', 'visionUsed']),
}

/* --------------------------- live wave state --------------------------- */
const units = new Map(Object.entries(prior.units ?? {}))
for (const u of plan.units) {
  if (!units.has(u.id)) units.set(u.id, { status: u.inScope ? 'pending' : 'deferred' })
}
let integrationTip = prior.integrationTip
let consultsUsed = prior.consultsUsed ?? 0
// Codex hard-stop flag. Set by the per-wave probe (binary/auth gone) or by any step observing a
// usage/rate limit. Once set: no NEW codex dispatch this wave (ready() gates on it), in-flight
// units PARK (status pending + parked:true, re-entering by adoption next wave) — never
// quarantine, never a Claude implementer. The wave state carries it so the conductor
// early-returns to the root, where the human re-auths or waits out the limit window.
let codexHalt = null   // the per-wave probe is the authority; a prior halt never carries forward
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
// Owed boundary jobs — a job that was DUE but did not run (skipped or died) leaves a
// machine-readable marker the next boundary trips over, instead of silently vanishing
// (arc-observed: a preview-down wave skipped the design reconcile over five design-cited
// units and nothing re-queued it — the root had to notice by hand). Seeded from the prior
// wave; discharged when the job next runs successfully; carried with count+1 otherwise.
// The conductor escalates entries owed two boundaries running to the Fable tier.
let owed = (prior.owed ?? []).map((o) => ({ ...o }))

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
// Per-unit round tally ({fix, opusGate, gate}) — makes runaway revision loops measurable
// (the paid fixtures assert ceilings on these). Stamped on the running record like `stage`;
// the terminal stores in start()/runWarmLane carry it onto the final record. No checkpoint
// here — the next stage/status checkpoint carries it, and a slightly-stale tally after a
// crash is acceptable forensics.
const bumpRound = (id, kind) => {
  const r = units.get(id)
  if (r?.status !== 'running') return
  const rounds = { fix: 0, opusGate: 0, gate: 0, ...(r.rounds ?? {}) }
  rounds[kind]++
  units.set(id, { ...r, rounds })
}
const depsOf = (id) => plan.edges.filter((e) => e.to === id).map((e) => e.from)
const ready = (u) => !codexHalt && rec(u.id).status === 'pending' && depsOf(u.id).every((d) => rec(d)?.status === 'merged')
const blockedBy = (u) => depsOf(u.id).some((d) => ['quarantined', 'blocked'].includes(rec(d)?.status))
const serialize = () => ({
  integrationBranch: intBranch, integrationTip, consultsUsed, spend,
  // Run identity ({runId, scriptPath}) set by the architect at launch — carried through so
  // same-session resume is mechanical and crash forensics are one `cat` of state.json.
  ...(prior.run ? { run: prior.run } : {}),
  // The conductor block is the conductor's, but the harness OWNS state.json mid-wave — so without
  // this passthrough every checkpoint strips it, and a crash mid-wave (the common case) leaves the
  // rung-3 recovery signal and the arc-cumulative boundary forensics missing from disk. Arc-observed:
  // three completed waves on disk, `conductor: undefined`. Passthrough only — never authored here.
  ...(prior.conductor ? { conductor: prior.conductor } : {}),
  preview: { sha: previewSha, status: previewStatus },
  // Debt surfaced THIS wave (not accumulated across waves): the architect triages it at the
  // boundary and appends un-promoted items to the living .roadmap/debt.md ledger.
  debt: debtLog,
  escalations: escalationLog,
  // Skill defects — the orchestrator misbehaving, not the product. Arc-cumulative like spend:
  // prior entries carry forward, this wave's append (without the concat, per-wave direct-harness
  // runs erased the arc's degradation history each wave). The conductor renders these into
  // .roadmap/skill-feedback.md and absorbs only the delta past what it dispatched.
  ...(((prior.degradations?.length ?? 0) + degradations.length)
    ? { degradations: [...(prior.degradations ?? []), ...degradations] } : {}),
  ...(owed.length ? { owed } : {}),
  // Shared pre-existing reds the circuit breaker took over this wave. The conductor folds these
  // into the boundary FINDINGS (never into debt — debt must not create a wave) so the triager
  // adjudicates the red once instead of every unit fighting it independently.
  ...(sharedReds.size ? { sharedReds: [...sharedReds.values()] } : {}),
  // This wave's exit-gate rulings on out-of-scope files, so the root can audit consistency and a
  // later gate has precedent to follow. Wave-scoped: rulings are about this wave's diffs.
  ...(scopeRulings.length ? { scopeRulings } : {}),
  ...(boundary ? { boundary } : {}),
  // Codex availability, the conductor's early-return signal: a `halt` here means the wave
  // stopped dispatching (units parked, state resumable) and the ROOT must surface it to the
  // user (re-auth / wait out the limit window / relaunch). Never route around it in-script.
  codex: { probed: (prior.wave ?? 0) + 1, available: !codexHalt, ...(codexHalt ? { halt: codexHalt } : {}) },
  wave: (prior.wave ?? 0) + 1, units: Object.fromEntries(units),
})
const notifySettle = () => { const w = settleWaiters; settleWaiters = []; w.forEach((f) => f()) }
const nextSettle = () => new Promise((r) => settleWaiters.push(r))

// Verbatim-write prompts for a large JSON payload. A single write's content is echoed as agent
// OUTPUT, and one response caps at ~32k output tokens (arc-observed: a 54-unit arc's state killed
// 5 checkpoint agents on that cap, silently). Below WRITE_CHUNK one Haiku writer copies the whole
// document through a single-quoted here-doc; above it, the payload is split deterministically (a
// pure function of the text — resumeFromRunId-safe) and FANNED OUT: one Haiku writer per part, each
// writing only its own `<path>.partK`, then one assembler that `cat`s the parts together and
// removes them (runVerbatim below). EVERY writer verifies its file with `cksum` (content hash +
// length, computed in-script by cksumOf), not a byte count: byte count was gamed live — a part
// writer un-escaped JSON string values, padded the tail with fabricated lines until `wc -c`
// matched, and reported ok:true; the assembled state.json did not parse. The single-write path had
// no verification at all and showed the same de-escaping. Arc-observed before that, twice: a single
// writer told to stage 3–6 parts itself (75–145 KB of output) failed ~28 checkpoints in two waves —
// "cannot complete within token budget" — and gave up in prose on 5 more. One agent emitting 145 KB
// is the wrong shape; one agent per ~24 KB part is not. Mirrored in conductor.mjs — keep the two in
// sync (shared-consts.test.mjs enforces it, cksumOf included).
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

// Crash-safety checkpoint of the whole wave state. Coalesced latest-wins (same idiom as the
// preview mirror below): a burst of status changes collapses to a single Haiku write, since
// only the newest snapshot matters for recovery. The final `await checkpointChain` still
// guarantees the last state lands — the last queued segment observes the final target.
// A failed write is LOUD: it lands in the degradation ledger (arc-observed silent losses hid a
// window where a crash would have dropped the wave), but never blocks the wave — the next
// successful checkpoint heals it.
// Agent-authored report text can carry raw control characters (an explorer's `repro` string
// quoting a \x01 test input, arc-observed). JSON.stringify escapes those correctly as \u0001 —
// but state.json is written by a Haiku agent transcribing the document, and the transcription
// DECODES the escape back into a raw byte, producing a state.json that no JSON parser will read.
// An unresumable arc is a far worse outcome than a lossy repro string, and a control character in
// a human-readable report is never load-bearing — so they are replaced with a printable token
// BEFORE serialization, leaving no escape for a transcriber to get wrong. \t/\n/\r are left
// alone: JSON gives them short escapes that agents reproduce reliably.
const CTRL_UNSAFE = /[\u0000-\u0007\u000b\u000e-\u001f\u007f]/g
const scrubCtrl = (v) => (typeof v === 'string'
  ? v.replace(CTRL_UNSAFE, (c) => `<0x${c.charCodeAt(0).toString(16).padStart(2, '0')}>`)
  : v)
let checkpointTarget = null
let checkpointWritten = null
function checkpoint() {
  checkpointTarget = JSON.stringify(serialize(), (_k, v) => scrubCtrl(v), 2)
  checkpointChain = checkpointChain.then(async () => {
    if (checkpointTarget === checkpointWritten) return   // coalesce: latest already written
    const snap = checkpointTarget
    checkpointWritten = snap
    // The fan-out (part writers in parallel, then the assembler) runs INSIDE this chain segment, so
    // a later checkpoint never races a half-assembled earlier one.
    const r = await runVerbatim(writeVerbatim(`${repo}/.roadmap/state.json`, snap),
      { model: 'haiku', effort: 'low', label: 'checkpoint', phase: 'Setup', schema: S.ok })
    if (!r.ok)
      degrade({ label: 'checkpoint', model: 'haiku', phase: 'Setup', kind: 'write-failed',
        what: `state.json checkpoint did not land (${r.detail}) — on-disk state may trail the run; ` +
          'the next successful checkpoint heals it' })
  }).catch(() => null)
}

// Optional environment provisioning (plan.provision: {copy: [...gitignored files], setup: "cmd"}).
// A fresh worktree has no deps/env; without this, the test gate fails for non-code reasons.
async function provision(where, label) {
  if (!plan.provision) return { ok: true }
  const p = plan.provision
  return runOr(
    { ok: false, detail: 'provisioning agent died (no report) — treat as an environment failure' },
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
    `## Evidence\n${dossier.evidence}\n\n## Hypothesis\n${dossier.hypothesis}\n` +
    (issueMode
      ? `\n${GH_BEST_EFFORT}Then reflect the quarantine on the unit's tracking issue, keeping it OPEN: ` +
        `${findIssue(unit.id, unit.issue)}if $ISS is non-empty, run \`gh issue edit ${ghRepo}"$ISS" ` +
        `--remove-label status:running,status:merge-ready --add-label status:quarantined\` and post the dossier ` +
        `as a comment: \`gh issue comment ${ghRepo}"$ISS" --body-file ${dossierPath}\`. `
      : ''),
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
  // Owed-only mode. The arc's FINAL wave is expected to run with `boundary:'off'`, and an owed
  // explorer/design job used to be deferred there to a boundary that never came — it left the run
  // as a manual chore in the return envelope (arc-observed). So when the boundary is off but the
  // ledger is not empty, this phase still runs, restricted to exactly the jobs that are owed:
  // the debt is paid in the last boundary that exists. Nothing else runs, so a switched-off
  // boundary stays switched off for every job that isn't owed.
  const owedOnly = C.boundary === 'off'
  const isOwed = (job) => owed.some((o) => o.job === job)
  const dueHere = (job, base) => base && (!owedOnly || isOwed(job))
  const doExplore = dueHere('explorer', previewStatus === 'live')
  const doHealth = dueHere('health', C.healthCheck !== 'off')
  // Design-cited units that reached `merged` IN THIS WAVE. The plan is the authority on what is
  // UI work — deliberately NO diff-path heuristic (*.tsx and friends), because a unit that touches
  // a designed surface without citing it is the plan-pack defect Phase 0 hunts, and papering over
  // it here would hide exactly what we want surfaced. Needs the preview: the green-tip mirror is
  // the only place a browsable, integrated surface is guaranteed to exist.
  // Owed design units from a prior skipped/dead reconcile re-enter the due set (still merged,
  // still design-cited) so the debt is paid, not merely remembered.
  const owedDesignIds = new Set(owed.filter((o) => o.job === 'design').flatMap((o) => o.units ?? []))
  const designUnits = plan.units.filter((u) => u.design?.length && rec(u.id)?.status === 'merged' &&
    (owedOnly ? owedDesignIds.has(u.id)
      : (prior.units?.[u.id]?.status !== 'merged' || owedDesignIds.has(u.id))))
  const doDesign = dueHere('design', designUnits.length > 0 && previewStatus === 'live')
  const [expl, hlth, flk, dsgn] = await Promise.all([
    !doExplore ? null : run(
      `You are the wave-${waveN} runtime explorer for a roadmap build. The integrated result is live as a ` +
      `preview — drive it via: ${plan.preview.howToAccess}. It serves integration tip ${explSha}. Your charter ` +
      `is runtime behavior ONLY — the diff, tests, and gates already judged the code: drive flows end to end ` +
      `the way a skeptical user would, poke edge cases, feed hostile/empty/huge inputs, break expected ` +
      `sequences — hunting behavior that is unexpected, counterintuitive, underdocumented, brittle, or ` +
      `misaligned with the specs' intent (specs: ${repo}/.roadmap/specs/). Change nothing: no commits, no file ` +
      `edits, no restarts. At most 10 findings — severity, exact repro, observed vs expected; an empty report ` +
      `is legitimate and better than manufactured findings. Hold \`notes\` to a short paragraph (max 500 ` +
      `characters). ${TERSE}Report shaObserved: ${explSha}.`,
      { model: 'opus', effort: C.opusEffort, phase: 'Boundary', label: `explorer:w${waveN}`, schema: S.explore }
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
      `Hold \`notes\` to a short paragraph (max 500 characters). ` + TERSE,
      { model: 'opus', effort: C.opusEffort, phase: 'Boundary', label: `health:w${waveN}`, schema: S.health }
    ).catch(() => null),
    !(doHealth && C.flakeReruns > 0 && dueHere('flake', true)) ? null : run(
      STRICT +
      `In the integration worktree at ${intWt}: run the project's full test suite ${C.flakeReruns} times in a ` +
      `row (commands: ${brief}). Report runs = how many completed, and in flips the exact name of every test ` +
      `that changed pass/fail between runs (empty when stable). Immediately BEFORE each run, read the first ` +
      `number printed by \`cat /proc/loadavg\` and report those samples in \`loads\`, in run order; also report ` +
      `cpuCount = the number printed by \`nproc\`. A flip is not worth less because the box was busy — the ` +
      `numbers are recorded so a triager can tell a saturated run from a real sentinel, and you must not ` +
      `withhold, wait, or re-run on account of them. Fix nothing. Keep \`detail\` to one sentence (max 400 characters). ${TERSE}`,
      { model: 'haiku', phase: 'Boundary', label: `flake:w${waveN}`, schema: S.flake }
    ).catch(() => null),
    !doDesign ? null : run(
      `You are the wave-${waveN} design-fidelity reconciler for a roadmap build. These units merged this wave ` +
      `against design authorities: ${designUnits.map((u) => `${u.id} (${u.design.join(', ')})`).join('; ')}. ` +
      `FIRST read ${repo}/.roadmap/architect-log.md: the architect may have APPROVED divergences from a comp, or ` +
      `folded a divergence into the comp itself — those are decisions, not drift, and reporting them as findings ` +
      `wastes a wave. Then, for each unit's covered surfaces, drive the live preview (${plan.preview.howToAccess}, ` +
      `serving ${explSha}) and compare what it renders against the comp source under the authority paths ` +
      `(${[...new Set(designUnits.flatMap((u) => u.design.map((d) => authOf(d)?.path)).filter(Boolean))].join(', ')}). ` +
      `If the brief (${brief}) documents a screenshot command, capture each surface and judge it VISUALLY against ` +
      `the comp render, and report visionUsed:true. If no screenshot capability is provisioned, compare the served ` +
      `DOM against the comp source instead and report visionUsed:FALSE — do not imply you saw anything you did ` +
      `not. Classify each finding: "bug" = it renders wrong; "adoption-gap" = the surface reimplements what the ` +
      `comp already provides; "irreconcilable" = the built behaviour and the comp cannot both be right, so a ` +
      `human decision is needed. For each finding worth fixing, return a ready-to-dispatch fix-unit draft (id, ` +
      `goal, files, acceptance criteria as individually checkable clauses). Change nothing — no commits, no ` +
      `edits. An empty report is legitimate. Hold \`notes\` to a short paragraph (max 500 characters). ` +
      `${TERSE}Report shaObserved: ${explSha}.`,
      { model: 'opus', effort: C.opusEffort, phase: 'Boundary', label: `design:w${waveN}`, schema: S.design }
    ).catch(() => null),
  ])
  // Settle the owed ledger BEFORE any early return: a job that was DUE but produced nothing is
  // owed whether it was skipped (precondition down) or died; a successful run discharges its
  // entries; a job not due this wave carries its prior entry untouched. `count` = consecutive
  // boundaries owed — the conductor escalates repeat offenders to the Fable tier.
  const settleOwed = (job, due, ok, why, unitIds) => {
    const prevEntry = owed.find((o) => o.job === job)
    owed = owed.filter((o) => o.job !== job)
    if (ok) return
    if (!due) { if (prevEntry) owed.push(prevEntry); return }
    owed.push({ job, wave: prevEntry?.wave ?? waveN, why, count: (prevEntry?.count ?? 0) + 1,
      ...(unitIds?.length ? { units: unitIds } : {}) })
  }
  const previewWhy = previewStatus === 'failed' ? 'preview failed at setup — fix the primary checkout and relaunch'
    : 'no live preview this wave'
  settleOwed('explorer', dueHere('explorer', previewStatus !== 'none'), !!expl,
    doExplore ? 'explorer agent produced no report' : previewWhy)
  settleOwed('health', doHealth, !!hlth, 'health assessor produced no report')
  settleOwed('flake', dueHere('flake', doHealth && C.flakeReruns > 0), !!flk, 'flake re-runs produced no report')
  settleOwed('design', dueHere('design', designUnits.length > 0), !!dsgn,
    doDesign ? 'design reconcile produced no report' : previewWhy,
    designUnits.map((u) => u.id))
  // Only assign when a job actually ran, so serialize() omits an empty all-null block.
  if (!expl && !hlth && !flk && !dsgn) return
  if (designUnits.length && !dsgn)
    degrade({ label: `design:w${waveN}`, model: 'opus', phase: 'Boundary', kind: 'no-report',
      what: `design reconcile did not report for ${designUnits.map((u) => u.id).join(', ')} ` +
        `(${doDesign ? 'agent produced nothing' : 'no live preview'}) — those surfaces went unchecked this wave. ` +
        `An owed marker re-queues them at the next boundary; they must be reconciled or explicitly waived before close-out.` })
  boundary = { explorer: expl, health: hlth, flake: flk, design: dsgn }
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
    (flk ? (flk.flips.length ? `${flk.runs} runs; flips: ${flk.flips.join(', ')}` : `${flk.runs} runs; stable`) +
      (flk.loads?.length ? ` (loadavg1 per run: ${flk.loads.join(', ')}${flk.cpuCount ? ` on ${flk.cpuCount} cpu` : ''})` : '')
      : 'not run') +
    (flk?.detail ? ` — ${flk.detail}` : '') + '\n',
    { model: 'haiku', effort: 'low', phase: 'Boundary', label: `health-write:w${waveN}`, schema: S.ok }).catch(() => null))
  if (dsgn) writes.push(run(
    `Create the file ${fb}/design/wave-${waveN}.md (creating parent directories as needed) with exactly this ` +
    `content:\n# Wave ${waveN} — design fidelity (sha ${explSha}, ` +
    `${dsgn.visionUsed ? 'screenshots compared visually' : 'NO SCREENSHOT CAPABILITY — DOM vs comp source only'})\n\n` +
    (dsgn.findings.length
      ? dsgn.findings.map((f) => `- **${f.severity}** ${f.surface}${f.comp ? ` vs ${f.comp}` : ''} — ${f.what}`).join('\n')
      : 'No findings.') +
    `\n\n## Fix-unit drafts\n` +
    ((dsgn.fixUnits ?? []).map((u) => `- ${u.id}: ${u.goal}\n  - files: ${(u.files ?? []).join(', ')}\n  - acceptance: ${u.acceptance.join(' · ')}`).join('\n') || 'None.') +
    (dsgn.notes ? `\n\nNotes: ${dsgn.notes}` : '') + '\n',
    { model: 'haiku', effort: 'low', phase: 'Boundary', label: `design-write:w${waveN}`, schema: S.ok }).catch(() => null))
  await Promise.all(writes)
}

// Issue-projection reconciliation sweep (issue mode only): one Haiku pass at the wave tail that
// re-derives every unit issue's status:* label from the final map — catching a missed folded flip, a
// `blocked`, or a transient `merge-ready` the live clauses (setup/merge/dossier) don't cover — and
// refreshes the arc tracking issue's status table. Best-effort, idempotent (find-or-create by
// marker), and the one place UNIT sync records a gh-sync degradation. A single Haiku call, present on
// BOTH dispatch paths because it lives here; a no-op in file mode (keeping that path byte-identical).
async function syncIssues() {
  if (!issueMode) return
  const N = (prior.wave ?? 0) + 1
  const issueOf = new Map(plan.units.map((u) => [u.id, u.issue]))
  const closesOf = new Map(plan.units.filter((u) => u.closes?.length).map((u) => [u.id, u.closes]))
  const rowsOf = (entries) => entries.map(([id, r]) => ({ id, status: r.status, issue: issueOf.get(id) ?? null,
    ...(closesOf.has(id) ? { closes: closesOf.get(id) } : {}) }))
  const allRows = rowsOf([...units])
  // Reconcile LABELS only for units whose status CHANGED this wave. Prior waves' units were already
  // reconciled by the sweep of the wave that moved them, so re-editing all of them every wave only burns
  // GitHub API quota — an O(all-units) burst of redundant `gh issue edit`s that grows every wave and, on
  // a large arc, risks the secondary (abuse) rate limit. The delta still backstops THIS wave's folded
  // clauses (a merged/quarantined unit counts as changed), and the task list still lists ALL units in a
  // single tracking-issue edit, so the dashboard stays whole. gh rate-limit errors are tolerated anyway.
  const changed = rowsOf([...units].filter(([id, r]) => r.status !== (prior.units?.[id]?.status ?? 'pending')))
  const r = await run(
    STRICT +
    `In the git repository at ${repo}, reconcile the GitHub issue projection after wave ${N} of this roadmap ` +
    `build. Best-effort throughout: if a gh command fails (a rate limit included), note it and keep going — never ` +
    `error out; issue state is observability, not a gate. For each CHANGED unit below, resolve its issue number — ` +
    `use its \`issue\` field if non-null, else search by body marker ` +
    `(\`gh issue list ${ghRepo}--search '"roadmap:unit id=<id>" in:body' --state all --limit 1 --json number --jq '.[0].number'\`); ` +
    `if found, make its labels match its status — remove any other \`status:*\` label, add the one that matches, ` +
    `and ensure \`wave:${N}\` on any unit that is running or beyond: pending/running/merge-ready/blocked/` +
    `quarantined stay OPEN; merged → add \`status:merged\` then \`gh issue close ${ghRepo}<n> --reason completed\`; ` +
    `deferred → add \`status:deferred\` then \`gh issue close ${ghRepo}<n> --reason "not planned"\`. For any ` +
    `changed unit whose row carries a \`closes\` array and whose status is merged, also ensure each listed issue ` +
    `number is closed (\`gh issue close ${ghRepo}<n> --reason completed --comment "Resolved by unit <id>."\`) — ` +
    `skip numbers already closed. Skip any unit ` +
    `whose issue is not found, and do NOT touch any unit not listed here — they were reconciled in an earlier ` +
    `wave. Changed units:\n${JSON.stringify(changed)}\n` +
    (plan.trackingIssue
      ? `Then refresh the arc tracking issue #${plan.trackingIssue} from the FULL unit list: rewrite only the ` +
        `region between the \`<!-- roadmap:status -->\` and \`<!-- /roadmap:status -->\` markers in its body with ` +
        `a GitHub task list — one item per unit, \`- [x] #<n> <id> — <status>\` when that unit's issue is closed ` +
        `(merged or deferred) and \`- [ ] #<n> <id> — <status>\` while it is still open — so the tracking issue ` +
        `renders a native progress rollup and each item links to its unit issue. This is one edit of a single ` +
        `issue, not a per-unit call. Skip any unit whose issue number is unknown, and leave the rest of the body ` +
        `intact. Full unit list:\n${JSON.stringify(allRows)}\n`
      : '') +
    `Report ok:true when the sweep completed (even if some individual gh calls failed); put a one-line summary of ` +
    `any failures in detail.`,
    { model: 'haiku', effort: 'low', phase: 'Boundary', label: `issue-sync:w${N}`, schema: S.ok },
  ).catch(() => null)
  if (!r?.ok)
    degrade({ label: `issue-sync:w${N}`, model: 'haiku', phase: 'Boundary', kind: 'gh-sync',
      what: `wave-tail issue reconciliation did not complete cleanly${r?.detail ? ` — ${r.detail}` : ''} ` +
        `(issue projection only; state.json is authoritative and the arc is unaffected)` })
}

// Opus-first plan-check ladder, shared by the per-unit pipeline and the warm-lane per-link
// checks. Returns {verdict: approve|redirect|quarantine, guidance, notes}. The Fable pass fires
// on high risk, claimed-infeasible, always-fable policy, or an Opus escalation.
// Charter note (arc-observed, RATIONALE §4): 11 plan-checks in one arc never fired on plan
// PLAUSIBILITY but approved past spec-internal contradictions the implementer then had to
// reconcile ad hoc. Hence the spec-interrogation clause in both prompts — don't drop it.
async function runPlanCheck(unit, implPlan, spec, { critique = null } = {}) {
  // The pre-dispatch gate is THE highest-leverage judgment point in the codex lane (better
  // judgment up front means less wasted implementation, fewer findings, fewer fix rounds), so
  // Fable takes every med/high-risk unit — only low-risk singles ride Opus-first.
  // `critique` threads the cross-model spec review (codex-spec-review) in as adjudication input.
  const critiqueClause = critique?.questions?.length || critique?.risks?.length
    ? ` A second engineer from a different model family reviewed the spec and this plan read-only before you. ` +
      `Adjudicate each item explicitly — cross-model disagreement here is signal, not noise, and an unanswered ` +
      `genuine question is a spec defect to resolve through your verdict, never something the implementer ` +
      `absorbs mid-build. Questions: ${JSON.stringify(critique.questions ?? [])}. ` +
      `Risks: ${JSON.stringify(critique.risks ?? [])}.`
    : ''
  // The Fable plan-check — the frontier pass. `lead` carries an Opus escalation's assessment
  // so the architect confirms/overturns a concrete concern rather than re-deriving it; '' when
  // reached directly, keeping that prompt byte-identical to before.
  const fablePlanCheck = (lead = '') => {
    spend.planChecks++
    return run(
      `You are the architect of a roadmap build. A capable engineer proposes this implementation plan for unit ` +
      `${unit.id} — read the spec at ${spec} and its contracts yourself, then judge it:\n${JSON.stringify(implPlan)}\n` +
      `You are the only frontier eyes between this spec and code, so interrogate the SPEC as hard as the plan: ` +
      `hunt contradictions within the spec, clauses that contradict ` +
      `a referenced contract or documented codebase reality, and stale premises. ${designClause(unit)}${unit.design?.length ? 'A spec clause that contradicts the comp it cites ranks with a contract contradiction — '+ 'resolve it now. ' : ''}A spec defect is not the ` +
      `engineer's to absorb — resolve it now through your verdict. And judge the plan the way only frontier ` +
      `eyes can — the implementer is an able, literal-minded builder who will execute exactly what is approved, ` +
      `so what you wave through is what the codebase becomes: overengineering and complexity that does not earn ` +
      `its keep, structure that makes the NEXT change harder, missed reuse or a simpler shape for the same ` +
      `outcome, and decisions that quietly close doors the roadmap needs open. A plan can be technically ` +
      `correct and still deserve redirection on those grounds.${critiqueClause} ${directionClause}` +
      `Your verdict controls what happens next — use it precisely: "approve" = proceed to IMPLEMENT this plan ` +
      `as-is; "redirect" = the engineer revises the plan per your guidance, then implements (this includes ` +
      `naming the explicit resolution of a spec contradiction when the right call is clear); "quarantine" = do ` +
      `not implement at all (e.g. the spec is unsatisfiable or self-contradictory within its contracts, or needs ` +
      `redesign above the engineer's pay grade). Approve unless something is meaningfully wrong. If redirecting, ` +
      `say what and why in a few sentences — the engineer needs direction, not instructions.${lead}`,
      { model: 'fable', effort: C.fableEffort, phase: 'Architect', label: `plan-check:${unit.id}`, schema: S.planVerdict })
  }
  if (unit.risk !== 'low' || !implPlan.feasible || C.planCheck === 'always-fable')
    return fablePlanCheck()
  spend.opusPlanChecks++
  const oc = await run(
    `You are an Opus plan-checker standing in for the architect on unit ${unit.id} of a roadmap build — but ` +
    `killing a unit is frontier-only, so you may approve or redirect the plan yourself, never quarantine. Read ` +
    `the spec at ${spec} and the contracts it references, then judge this plan against them:\n` +
    `${JSON.stringify(implPlan)}\n` +
    `This check is the only pre-code eyes on the spec itself, so interrogate the SPEC as hard as the plan: ` +
    `hunt contradictions within the spec, clauses that contradict a referenced contract or documented codebase ` +
    `reality, and stale premises the implementer would otherwise resolve ad hoc mid-build. ${designClause(unit)}${unit.design?.length ? 'A spec clause contradicting the comp it cites ranks with a contract contradiction: '+ 'redirect, or escalate on the "contract" trigger. ' : ''}` +
    `Choose a verdict: "approve" = proceed to IMPLEMENT as-is (approve unless something is meaningfully wrong); ` +
    `"redirect" = the engineer revises per your guidance, then implements (say what and why in a few sentences, ` +
    `not instructions; this includes naming the explicit resolution of a spec contradiction when the right ` +
    `call is clearly within your authority); "escalate" = hand to the frontier architect when the call turns ` +
    `on contract interpretation, a spec contradiction you cannot resolve yourself, architectural foundations, ` +
    `genuine uncertainty, or the unit looks unbuildable. Name the escalation trigger.${critiqueClause} ${directionClause}`,
    { model: 'opus', effort: C.opusEffort, phase: 'Implement', label: `opus-plan-check:${unit.id}`, schema: S.opusPlanVerdict })
  if (oc.verdict === 'escalate') {
    const lead = ` A first-pass Opus plan-check could not clear this itself` +
      `${oc.trigger && oc.trigger !== 'none' ? ` (escalation trigger "${oc.trigger}")` : ''}; use its assessment ` +
      `as a lead to confirm or overturn — not as ground truth: ` +
      `${JSON.stringify({ guidance: oc.guidance, notes: oc.notes })}.`
    return fablePlanCheck(lead)
  }
  // approve/redirect map straight onto the shared verdict handling at the call sites.
  return { verdict: oc.verdict, guidance: oc.guidance, notes: oc.notes }
}

// Cross-model spec critique (best-effort, read-only by INTENT): a short foreground `codex exec`
// interrogates the spec + plan from the OTHER model family's perspective before the plan-check
// adjudicates. GPT and Claude miss different things; the plan-check gets the questions as
// input, never as verdicts. Failure skips with a degradation — this pass gates nothing.
// "Read-only" lives in the brief ("change nothing"), NOT in the sandbox flag: it runs under
// C.codexSandbox exactly like the build lane, because `-s read-only` needs the same bwrap
// namespace that fails in this devcontainer (arc-observed: the critique was skipped for a bwrap
// EPERM while merely reading the spec). The steerer's Haiku is told two more things it
// otherwise improvises wrongly on: the cd target is the unit worktree `w` (the artifact dir is
// scratch, not a git checkout), and an entry the schema cut mid-sentence at its cap is a
// valid entry, not a failure.
const specCritique = async (unit, w, implPlan) => {
  const dir = codexDir(unit.id, 'spec-review')
  const critBrief =
    `Read-only critique task for unit ${unit.id}. Read the spec at ${specOf(unit)}, the contract files it ` +
    `references under ${repo}/.roadmap/contracts/, and this implementation plan:\n${JSON.stringify(implPlan)}\n` +
    `You are a second engineer reviewing before implementation begins. Name what you would have to ASK before ` +
    `building this — decisions the spec and plan leave genuinely unsettled (a question you could answer by ` +
    `reading the code is not one), risks the plan underestimates, and acceptance criteria that are missing or ` +
    `untestable as written. Do not propose an alternative design; do not write code; change nothing. ` +
    `Final message: ONLY a JSON object matching your output schema; every field required (empty arrays/strings ` +
    `where you have nothing); each entry one or two sentences (max 300 characters); \`notes\` at most one or ` +
    `two sentences (max 500 characters).`
  const r = await withCodexSlot(() => runOr({ ok: false, questions: [] },
    STRICT +
    `Run a short Codex critique for unit ${unit.id}. Your cd target is the unit worktree ${w} (a git ` +
    `checkout). ${dir} is a scratch artifact directory, NOT a git checkout — create it with mkdir -p and ` +
    `never cd into it or judge it; Codex is pointed at the worktree by -C. ` +
    `1) \`mkdir -p ${dir}\`; write ${dir}/brief.txt ` +
    `with EXACTLY the content between the <<<BRIEF>>> markers below (excluding the marker lines); write ` +
    `${dir}/schema.json with exactly this one-line JSON: ${CRITIQUE_OUT}\n` +
    `2) Run, blocking: \`timeout 900 ${codexHome}codex exec -C ${w} -s ${C.codexSandbox} ` +
    `${C.codexModel ? `-m ${C.codexModel} ` : ''}-c model_reasoning_effort=low ` +
    `-c projects."${w}".trust_level="trusted" --skip-git-repo-check --output-schema ${dir}/schema.json ` +
    `-o ${dir}/last-message.txt --json - < ${dir}/brief.txt > ${dir}/events.jsonl 2> ${dir}/stderr.log\`\n` +
    `3) Read ONLY \`head -c 4000 ${dir}/last-message.txt\` — never open ${dir}/events.jsonl or any transcript.\n` +
    `4) Report ok:true with \`questions\` (at most 8) and \`risks\` (at most 5) copied VERBATIM from the ` +
    `critique (each already one or two sentences, max 300 characters — never expand them), and \`notes\` one ` +
    `or two sentences (max 500 characters) only if something needs saying. An entry the schema cut off ` +
    `mid-sentence at its 300-character cap is still a valid entry: copy it through as-is and report ok:true ` +
    `— truncation is never a failure. If the command failed or the output is missing/unparseable, report ` +
    `ok:false with a one-sentence \`notes\` saying what happened. ` +
    `${TERSE}\n<<<BRIEF>>>\n${critBrief}\n<<<BRIEF>>>`,
    { model: C.codexSteerModel, effort: 'low', phase: 'Implement', label: `codex-spec-review:${unit.id}`, schema: S.specReview }))
  if (!r.ok)
    degrade({ label: `codex-spec-review:${unit.id}`, model: C.codexSteerModel, phase: 'Implement', kind: 'codex-spec-review',
      what: `cross-model spec critique skipped for ${unit.id} (${String(r.notes ?? 'no report').slice(0, 160)}) — ` +
        `the plan-check runs without it (${dir})` })
  return r.ok ? r : null
}

/* --------------------------- per-unit pipeline -------------------------- */
/* --------------------------- codex executor lane ---------------------------
 * Codex (the OpenAI CLI) is THE implementer — there is no Claude implementation lane. A unit's
 * whole implement→test→fix inner loop is one background `codex exec` in the unit worktree,
 * driven by a cheap steering agent that launches it, polls to completion, disk-verifies, and
 * copies the schema-constrained final message into an S.impl-shaped report. S.impl is the seam:
 * verify, gates, consults, merge and every trigger (specGap/contractMismatch/debt) work
 * untouched, and nothing downstream learns who wrote the code. Fix rounds ride
 * `codex exec resume` (P1-pinned: a resumed session retains the original brief's constraints).
 * Every CLI fact used here is pinned by evals/codex-probe.sh — read it before changing shape.
 */
// OpenAI strict mode (P1-pinned): the --output-schema must list EVERY property as required at
// every level, or the turn 400s with invalid_json_schema and the run dies. Semantically-optional
// fields still appear, as "" / [] / false — the falsy checks downstream already treat them as
// absent. Pure function of the schema literal, so the emitted string is resumeFromRunId-safe.
const strictify = (s) => {
  if (!s || typeof s !== 'object') return s
  const out = { ...s }
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, strictify(v)]))
    out.required = Object.keys(s.properties)
  }
  if (s.items) out.items = strictify(s.items)
  return out
}
// What Codex itself reports (the steering agent adds CODEX_META on top). Mirrors S.impl's caps
// EXACTLY so the steering read-back is a copy, never a compression — a budget mismatch here
// reintroduces the RATIONALE §9 StructuredOutput death class across the process boundary.
const CODEX_OUT = JSON.stringify(strictify(obj({
  status: oneOf(['complete', 'blocked', 'stopped-spec-gap', 'stopped-contract-mismatch']),
  filesChanged: arr('string'), headSha: { type: 'string' },
  summary: { type: 'string', maxLength: 700 },
  contractMismatch: { type: 'string', maxLength: 300 },
  specGap: { type: 'string', maxLength: 300 },
  debt: debtArr, notes: { type: 'string', maxLength: 2000 },
}, [])))
// The shared budget paragraph for every codex brief's FINAL MESSAGE section — byte-for-byte the
// same caps as S.impl/CODEX_OUT.
const CODEX_BUDGETS =
  `Your final message must be ONLY a JSON object matching the output schema you were given; prose outside ` +
  `it is discarded, and every field is required — emit "" / [] / false where you have nothing to say. Take ` +
  `\`filesChanged\` from \`git diff --name-only\` against the base named above and \`headSha\` from ` +
  `\`git rev-parse HEAD\` — read them, do not recall them. Budgets: \`summary\` 2-3 short sentences (max 700 ` +
  `characters); \`contractMismatch\` and \`specGap\` one or two sentences each (max 300 characters); each ` +
  `\`debt\` entry's \`what\` and \`why\` a sentence or two (max 400 characters each), at most 8 debt entries ` +
  `(consolidate related items); \`notes\` at most a short paragraph (max 2000 characters).`
// What the spec critique reports (strict mode, same P1 rule as CODEX_OUT).
const CRITIQUE_OUT = JSON.stringify(strictify(obj({
  questions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
  risks: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 300 } },
  notes: { type: 'string', maxLength: 500 },
}, [])))
// The build brief — Goal / Context / Constraints / Method / Done-when / Escalation / Final
// message (OpenAI's own scoping structure). Artifacts are referenced by path, EXCEPT the scope
// envelope and the escalation contract, which are inlined because they ARE the guardrails: a
// brief Codex only half-reads must still carry them in its context window.
const codexBuildBrief = (unit, w, dir, base, implPlan) =>
  `# GOAL\n` +
  `Implement unit ${unit.id} in the git worktree at ${w} (branch unit/${unit.id}, diff base ${base}) until ` +
  `every check under DONE-WHEN passes, and commit it. You own the whole loop: write it, test it, fix it, ` +
  `commit it. Nobody is watching between now and your final message.\n\n` +
  `# CONTEXT\n` +
  `- The spec at ${specOf(unit)} is authoritative. Read it in full before writing anything.\n` +
  `- Frozen contracts it references live under ${repo}/.roadmap/contracts/ — immutable requirements. ` +
  `${convClause}${designClause(unit)}\n` +
  `- Codebase conventions and build/test commands are documented at ${brief}.\n` +
  `- A senior engineer already planned this unit and an architect approved the plan — start from it instead ` +
  `of re-exploring: ${JSON.stringify(implPlan)}\n` +
  `- Follow the approved approach. If it is actually wrong, that is a STOP (see ESCALATION), not a licence ` +
  `to substitute your own.\n\n` +
  `# CONSTRAINTS\n` +
  `${SCOPE(implPlan.files)}${NOROADMAP}Never run git rebase, git reset --hard, or git push, and never ` +
  `delete a branch. Work only inside ${w}.\n\n` +
  `# METHOD\n` +
  `1. Read the spec and its contracts, then split the unit into ordered MILESTONES — the smallest slices that ` +
  `each leave the branch green and committable. Work one at a time; do not start the next until the current ` +
  `one is committed. 2. For each acceptance criterion that admits a test, write the test ` +
  `FIRST, at the seams the plan's testPlan names — do not invent new seams and do not restructure production ` +
  `code to create one. 3. Implement until it passes. 4. Run the unit-scoped tests and lint/typecheck ` +
  `(commands: ${brief}). 5. Iterate until green — never report done with a failing check. 6. A test that ` +
  `would still pass if the behaviour were wrong is a failed task, not a pass: for each test you add, break ` +
  `the behaviour it claims to test, confirm the test fails, then restore. NEVER write or amend a test to ` +
  `assert behaviour you believe is wrong, and never narrow one to dodge a case that fails — if correct ` +
  `behaviour needs a change you are not allowed to make, that is a STOP (see ESCALATION), not something to ` +
  `encode as intended. A green suite that documents a defect is the worst outcome available to you. 7. Commit at the end of EVERY ` +
  `milestone, not only at the end of the unit, naming the milestone in the message — this run has a deadline ` +
  `and uncommitted work does not survive it.\n` +
  `8. At each milestone boundary, before starting the next, re-read ${dir}/brief.txt and run ` +
  `\`git log --oneline ${base}..HEAD\`. This run is long enough that your own context may be compacted along ` +
  `the way; those two are the authoritative record of your instructions and of what you have actually landed, ` +
  `and re-reading them is a fresh tool call, not a memory. Trust them over your recollection.\n\n` +
  `# DONE-WHEN (each is checked on disk after you exit; your claim is not the check)\n` +
  `- Every acceptance criterion in ${specOf(unit)} demonstrably holds.\n` +
  `- The unit-scoped tests and lint/typecheck exit 0.\n` +
  `- \`git status --porcelain\` is empty and \`git rev-list --count ${base}..HEAD\` is greater than zero — ` +
  `the commit is the deliverable; uncommitted work does not exist.\n` +
  `- \`git diff --name-only ${base}..HEAD\` lists no path under .roadmap/ and stays inside the scope above.\n` +
  `- Only when ALL of the above hold, write the single line \`DONE ${unit.id}\` to ${dir}/done.txt. ` +
  `If you finish without all of them holding, do NOT write it.\n\n` +
  `# ESCALATION — stop, do not improvise\n` +
  `Stop only if you cannot proceed without making a decision that the spec, the contracts, the conventions ` +
  `and the code do not settle AND a competent engineer could reasonably decide the other way. A question you ` +
  `can answer by reading is not a stop — read the spec, the contracts and the code first, every time. There is ` +
  `no cap on stops across this unit: an adjudicator answers and resumes you, so a second genuine decision is a ` +
  `second stop, never a licence to improvise. When you stop: commit everything already ` +
  `finished, set \`status\` to "stopped-spec-gap" (a decision the spec leaves unsettled) or ` +
  `"stopped-contract-mismatch" (a frozen contract contradicts code that exists, or cannot be implemented as ` +
  `written), fill \`specGap\` or \`contractMismatch\` with one or two sentences (max 300 characters: which ` +
  `decision or surface, and the alternative you did not take), and exit. Never amend a contract; never widen ` +
  `scope to route around a contradiction. Otherwise leave BOTH fields as empty strings — each is a trigger ` +
  `that summons the architect, never a notes field; never write "none" or an FYI there.\n\n` +
  `# FINAL MESSAGE\n${CODEX_BUDGETS}\n`
// A fix-round brief. Self-contained enough to work in a FRESH session too (the fresh fallback
// when no resumable session matches this worktree): it names the spec, the scope, and the exact
// repairs. P1-pinned: a resumed session still holds the build brief's constraints, so the scope
// text here is reinforcement, not the sole carrier.
const codexFixBrief = (unit, w, base, envelope, payload) =>
  `Follow-up on unit ${unit.id} in the git worktree at ${w} (branch unit/${unit.id}, diff base ${base}; ` +
  `spec: ${specOf(unit)}).\n\n${payload}\n\n` +
  `${FIX_SCOPE(envelope)}Run the unit-scoped tests and lint/typecheck (commands: ${brief}) until green — ` +
  `never report done with a failing check. ${NOROADMAP}Commit your fixes on the current branch.\n\n` +
  // A resume brief with no termination condition does not idle — it invents work. Probe-observed
  // (codex-horizon-probe.sh): a resumed session finished every specified milestone, then kept
  // going into self-directed "Audit:" commits, expanding a spec line that asked only for
  // `restore(snapshot(s))` to round-trip into a custom serializer for cyclic references, BigInt
  // and NaN, plus an exported internals hook to test it with. The build brief is protected by its
  // DONE-WHEN; every resume needs the same stopping rule restated or it inherits none.
  `# ESCALATION — the same rule as your original brief\n` +
  `A decision the spec, the contracts and the code do not settle is still a STOP, not yours to make — including ` +
  `any decision the spec explicitly names as open, and any point where a frozen contract contradicts what you ` +
  `must build. Never write or amend a test to assert behaviour you believe is wrong. Set \`status\` to ` +
  `"stopped-spec-gap" or "stopped-contract-mismatch", fill the matching field, commit what is finished, and exit; ` +
  `an adjudicator answers and resumes you. Arc-observed: fix rounds silently decided a decision the spec had ` +
  `marked escalate-only, in twelve modules at once, because this brief did not repeat the rule.\n\n` +
  `# DONE-WHEN\n` +
  `The repairs above are made, the checks are green, and your work is committed. Then STOP and report. ` +
  `Do not add requirements the spec does not state, do not harden or refactor beyond the repairs, and do not ` +
  `invent follow-up work — finishing early is correct, and anything past the repairs is scope creep the gate ` +
  `will reject.\n\n` +
  `# FINAL MESSAGE\n${CODEX_BUDGETS}\n`
// The steering prompt: launch codex in the background (the preview-process idiom: setsid +
// pidfile + group kill), poll sleep-free, kill at the deadline, verify the work ON DISK, read
// back only the allowlisted slivers, and emit the S.implCodex report. The full transcript is
// never loaded — that is the entire economic point of the lane.
const steerCodex = ({ unit, w, dir, base, briefText, effort, timeoutMin, resumeDir, outSchema, reportInstr }) => {
  const launch = resumeDir
    ? `if [ -f ${resumeDir}/session-id ] && [ "$(cat ${resumeDir}/cwd)" = "${w}" ]; then use COMMAND R below; ` +
      `otherwise use COMMAND F below.\n` +
      `COMMAND R: cd ${w} && ${codexHome}setsid nohup sh -c 'codex exec resume "$(cat ${resumeDir}/session-id)" ` +
      `-c sandbox_mode="${C.codexSandbox}" ${C.codexModel ? `-m ${C.codexModel} ` : ''}` +
      `-c model_reasoning_effort=${effort} -c projects."${w}".trust_level="trusted" ` +
      `${C.codexNetwork ? '-c sandbox_workspace_write.network_access=true ' : ''}` +
      `${C.codexProfile ? `-p ${C.codexProfile} ` : ''}--skip-git-repo-check ` +
      `--output-schema ${dir}/schema.json -o ${dir}/last-message.txt --json - < ${dir}/brief.txt ` +
      `> ${dir}/events.jsonl 2> ${dir}/stderr.log; echo $? > ${dir}/exit-code' & echo $! > ${dir}/codex.pid\n` +
      `COMMAND F: `
    : `use this launch command:\n`
  // Resume-collision rule (arc-observed: one gate-fix resume died at once with "thread already
  // has a…" because a live codex process still held the session — a transient, not a verdict on
  // the unit). One timed retry of the resume, then a cold session on the same self-contained brief.
  const collisionRule = resumeDir
    ? ` If you launched COMMAND R and ${dir}/exit-code appears within 2 minutes with a non-zero value while ` +
      `\`grep -qi 'thread already' ${dir}/stderr.log\` matches, the session is still held by another live codex ` +
      `process: run \`sleep 60\`, \`rm -f ${dir}/exit-code ${dir}/codex.pid\`, and relaunch COMMAND R once; if it ` +
      `fails the same way again, \`rm -f ${dir}/exit-code ${dir}/codex.pid\` and launch COMMAND F instead. Say ` +
      `in \`notes\` which of these happened.`
    : ''
  const execCmd =
    `${codexHome}setsid nohup sh -c 'codex exec -C ${w} -s ${C.codexSandbox} ` +
    `${C.codexModel ? `-m ${C.codexModel} ` : ''}-c model_reasoning_effort=${effort} ` +
    `-c projects."${w}".trust_level="trusted" ` +
    `${C.codexNetwork ? '-c sandbox_workspace_write.network_access=true ' : ''}` +
    `${C.codexProfile ? `-p ${C.codexProfile} ` : ''}--skip-git-repo-check ` +
    `--output-schema ${dir}/schema.json -o ${dir}/last-message.txt --json - < ${dir}/brief.txt ` +
    `> ${dir}/events.jsonl 2> ${dir}/stderr.log; echo $? > ${dir}/exit-code' & echo $! > ${dir}/codex.pid`
  return STRICT +
    `You are the steering agent for an autonomous Codex CLI run on unit ${unit.id}. You never write product ` +
    `code yourself — you launch the run, wait for it, verify its work on disk, and report. Do exactly this:\n` +
    `1) Create the artifact directory: \`mkdir -p ${dir}\`. Write the file ${dir}/brief.txt with EXACTLY the ` +
    `content between the <<<BRIEF>>> markers at the end of this message (excluding the marker lines; if one ` +
    `write is rejected as too large, write it in consecutive appended parts). Write the file ` +
    `${dir}/schema.json with exactly this one-line JSON: ${outSchema ?? CODEX_OUT}\n` +
    `2) Record launch facts: \`date +%s > ${dir}/launched-at\` and \`printf '%s' "${w}" > ${dir}/cwd\`.\n` +
    `3) Launch Codex in the background — ${launch}${execCmd}${collisionRule}\n` +
    `4) Wait, sleep-free: repeat \`timeout 540 tail --pid=$(cat ${dir}/codex.pid) -f /dev/null\`, each time ` +
    `setting your Bash tool's own timeout to its 600000 ms maximum so the call is not cut short (a 124 exit ` +
    `just means still running). Runs here are long — hours, not minutes — so expect many such waits and never ` +
    `conclude from a 124 that anything is wrong. Repeat until ${dir}/exit-code exists. If \`$(date +%s)\` minus the value in ` +
    `${dir}/launched-at ever exceeds ${timeoutMin * 60}, the run is TIMED OUT: kill the process group with ` +
    `\`kill -TERM -- -$(cat ${dir}/codex.pid)\`, wait ~5 seconds, \`kill -KILL -- -$(cat ${dir}/codex.pid)\`, ` +
    `then treat whatever is on disk as the result.\n` +
    `5) Read back ONLY these — never open ${dir}/events.jsonl whole, never read a Codex transcript, never ` +
    `paste more than these slivers into your context:\n` +
    `   - \`head -c 8000 ${dir}/last-message.txt\` (the schema-constrained final report; may be absent),\n` +
    `   - \`grep -m1 -o '"thread_id":"[^"]*"' ${dir}/events.jsonl\` — write the bare id to ${dir}/session-id,\n` +
    `   - \`grep '"turn.completed"' ${dir}/events.jsonl | tail -1\` (usage: input/output tokens, turn count),\n` +
    `   - \`grep -h -iE 'turn.failed|"type":"error"|usage limit|rate limit|quota|429|thread already' ${dir}/events.jsonl ` +
    `${dir}/stderr.log | tail -5 | cut -c1-300\` (errors; also decides \`limitHit\`),\n` +
    `   - git truth in ${w}: \`git rev-list --count ${base}..HEAD\`, \`git diff --name-only ${base}..HEAD\`, ` +
    `\`git status --porcelain\`, \`git rev-parse HEAD\`, and whether ${dir}/done.txt exists.\n` +
    `6) If \`git status --porcelain\` shows uncommitted changes, commit them yourself with the message ` +
    `"${unit.id}: commit work left uncommitted by codex" and say so in \`notes\` — uncommitted work is ` +
    `invisible to every downstream judge.\n` +
    `7) ${reportInstr ?? (`Emit the structured report: copy \`summary\`/\`contractMismatch\`/\`specGap\`/\`debt\`/\`notes\` ` +
    `through from the final report VERBATIM (never summarize or expand them; empty strings stay empty — ` +
    `each budget already matches your schema: summary max 700 characters, contractMismatch and specGap ` +
    `max 300 characters each, debt entries' what/why max 400 characters each, notes max 2000 characters); ` +
    `if the final report is absent or unparseable, set \`summary\` to one sentence saying so (that absence ` +
    `is data, not a failure to hide). \`filesChanged\` comes from the git diff you ran, NOT from the report. `)}` +
    `Fill \`codex\` with the process facts you observed: exitCode (the integer in ${dir}/exit-code, -1 if ` +
    `absent), commits (the rev-list count), turns/inputTokens/outputTokens from the usage line (0 if ` +
    `absent), timedOut, doneMarker (${dir}/done.txt existed), limitHit (any error sliver mentioned a usage/` +
    `rate limit, quota, or 429), sessionCaptured (${dir}/session-id written non-empty), and \`error\` — the ` +
    `most informative error sliver, one sentence, max 300 characters, empty string if none. ${TERSE}\n` +
    `<<<BRIEF>>>\n${briefText}\n<<<BRIEF>>>`
}
// Counting semaphore on concurrent codex PROCESSES (one OpenAI account behind them all; 16
// concurrent execs would trip its limits immediately). The steering agent's lifetime brackets
// the process's, so gating the steering call gates the process. Timing-only — prompts are
// unaffected, so resumeFromRunId replay is safe.
let codexSlots = 0
const codexQueue = []
const withCodexSlot = async (fn) => {
  while (codexSlots >= C.codexMaxConcurrent) await new Promise((r) => codexQueue.push(r))
  codexSlots++
  try { return await fn() } finally { codexSlots--; codexQueue.shift()?.() }
}
// Counting semaphore on concurrent TEST lanes — the codex semaphore's twin, a different resource.
// Codex runs are gated by one OpenAI account; test lanes are gated by the HOST. Everything that
// spends the box's cores goes through here: the polish-loop verify, every gate re-verify, and the
// integrated suite at merge. Timing-only — no prompt changes, so replay is safe — and it cannot
// deadlock: a slot is always released by the call that took it, and nothing holding one waits on
// another. When a slot is free it returns fn()'s OWN promise rather than a wrapper, so an
// uncontended lane settles on exactly the tick it did before: the checkpoint chain coalesces on
// microtask timing, and an extra tick per merge is an extra state.json fan-out per wave.
let gateSlots = 0
const gateQueue = []
const withGateSlot = (fn) => {
  if (gateSlots >= C.gateMaxConcurrent)
    return new Promise((r) => gateQueue.push(r)).then(() => withGateSlot(fn))
  gateSlots++
  const release = () => { gateSlots--; gateQueue.shift()?.() }
  const p = fn()
  p.then(release, release)   // releases a tick AFTER p settles; never delays p itself
  return p
}
// Degradation + spend bookkeeping shared by build and fix steps. A dead process is not a dead
// unit (the branch is judged on its commits); every entry names the artifact dir to read.
const noteCodexMeta = (unit, r, dir, label) => {
  const m = r?.codex
  if (!m) return
  spend.codexRuns = (spend.codexRuns ?? 0) + 1
  spend.codexInputTokens = (spend.codexInputTokens ?? 0) + (m.inputTokens ?? 0)
  spend.codexOutputTokens = (spend.codexOutputTokens ?? 0) + (m.outputTokens ?? 0)
  if (m.limitHit) {
    codexHalt = codexHalt ?? 'codex-usage-limit'
    degrade({ label, model: 'codex', phase: 'Implement', kind: 'codex-usage-limit',
      what: `codex reported a usage/rate limit on ${unit.id} (${dir}) — halting new codex dispatch for this ` +
        `wave; state is checkpointed and the arc resumes cleanly after the limit window` })
  } else if (m.timedOut) {
    degrade({ label, model: 'codex', phase: 'Implement', kind: 'codex-timeout',
      what: `codex run for ${unit.id} exceeded its deadline and was killed (${dir})${loadNote()} — ` +
        `${m.commits > 0 ? `${m.commits} commit(s) survive and the branch is judged on its merits` : 'no commits survive'}` })
  } else if (m.exitCode !== 0) {
    degrade({ label, model: 'codex', phase: 'Implement', kind: 'codex-exec',
      what: `codex exited ${m.exitCode} on ${unit.id} (${dir}${m.error ? `; ${m.error}` : ''}) — ` +
        `${m.commits > 0 ? `${m.commits} commit(s) survive and the branch is judged on its merits` : 'no commits survive'}` })
  }
  if (m.commits > 0 && r.notes?.includes('left uncommitted by codex'))
    degrade({ label, model: 'codex', phase: 'Implement', kind: 'codex-uncommitted',
      what: `codex left uncommitted work on ${unit.id}; the steering agent committed it (${dir}) — a ` +
        `discipline signal worth watching, not a failure` })
}
// One codex build step = the unit's whole implement→test→fix inner loop. Parks (never
// quarantines) when codex dispatch is halted; retries ONCE fresh when a run dies with no
// commits; past that the normal pipeline (verify → gates) judges whatever is on the branch.
async function buildStep(unit, w, base, implPlan) {
  if (codexHalt) return { parked: true }
  const dir = codexDir(unit.id, 'build')
  const briefText = codexBuildBrief(unit, w, dir, base, implPlan)
  const opts = (label) => ({ model: C.codexSteerModel, effort: 'low', phase: 'Implement', label, schema: S.implCodex })
  let r = await withCodexSlot(() => runOr(REPORT_LOST,
    steerCodex({ unit, w, dir, base, briefText, effort: C.codexEffort, timeoutMin: C.codexTimeoutMin }),
    opts(`codex-build:${unit.id}`)))
  noteCodexMeta(unit, r, dir, `codex-build:${unit.id}`)
  if (!r.reportLost && r.codex && r.codex.exitCode !== 0 && r.codex.commits === 0 && !r.codex.limitHit && !codexHalt) {
    // Dead on arrival with nothing on the branch: one fresh retry, then let the commit-probe/
    // quarantine path in runUnit rule. Never a Claude implementer — there is no Claude lane.
    const dir2 = codexDir(unit.id, 'build-retry')
    r = await withCodexSlot(() => runOr(REPORT_LOST,
      steerCodex({ unit, w, dir: dir2, base, briefText: codexBuildBrief(unit, w, dir2, base, implPlan), effort: C.codexEffort, timeoutMin: C.codexTimeoutMin }),
      opts(`codex-build-retry:${unit.id}`)))
    noteCodexMeta(unit, r, dir2, `codex-build-retry:${unit.id}`)
  }
  return r
}
// One codex fix step: resume the unit's build session in place when it matches this worktree
// (cwd rule — resuming into a different tree edits the wrong checkout), else run fresh with the
// self-contained fix brief. `payload` carries the verbatim repairs (verify failures, gate
// directives, or an architect ruling).
async function fixStep(unit, w, base, envelope, { step, label, fresh = false }, payload) {
  if (codexHalt) return { parked: true }
  const dir = codexDir(unit.id, step)
  const briefText = codexFixBrief(unit, w, base, envelope, payload)
  // `fresh` skips the resume: a session that has already failed a gate twice is anchored on its
  // own approach (the resumed-session-bias finding) — the last attempt starts cold, carrying the
  // full directive set in the self-contained brief instead of the session's history.
  const r = await withCodexSlot(() => runOr(REPORT_LOST,
    steerCodex({ unit, w, dir, base, briefText, effort: C.codexFixEffort, timeoutMin: C.codexFixTimeoutMin,
      resumeDir: fresh ? null : codexDir(unit.id, 'build') }),
    { model: C.codexSteerModel, effort: 'low', phase: 'Fix', label, schema: S.implCodex }))
  noteCodexMeta(unit, r, dir, label)
  return r
}
async function runUnit(unit) {
  setStage(unit.id, 'setup')   // status became 'running' in start() before this call
  const spec = specOf(unit)
  const w = wtOf(unit)
  const base = integrationTip   // diff base: the freshest integrated tip we know
  // unit.existingBranch adopts pre-written work (a hand-authored branch, or an eval
  // fixture): skip plan/implement and run it through the same verify → review → gate.
  const source = unit.existingBranch ?? base
  // Adoption intent — read from the ORIGINAL prior.units, not the live map (start() overwrote
  // the record with {status:'running'} before us). A unit that was 'running' in the last
  // checkpoint crashed mid-flight, so committed work on its branch is its own prior progress.
  const adopt = !!unit.existingBranch ||
    ['running', 'merge-ready'].includes(prior.units?.[unit.id]?.status) ||
    !!prior.units?.[unit.id]?.parked   // parked mid-pipeline (codex halt): its commits are its own progress

  // H-7: implementer-reported deviation from a frozen surface. `mismatch` is consumable
  // (one consult per report, respecting the consult budget); `mismatchEver` sticks — carrying
  // the latest report's text — forces the Fable exit gate and feeds its prompt. Banked into
  // the wave ledger so boundary triage sees it even when the unit merges.
  let mismatch = null
  let mismatchEver = null
  // The pinned scope envelope (see SCOPE): the plan's `files` for a fresh build, the link's
  // planned files for a warm-lane entry, the diff-at-entry for an adopted branch (pinned at the
  // first verify). Computed once, NEVER recomputed from the live diff — pinning is the whole
  // anti-spiral mechanism. `scopeGrew` is the latest verify's files beyond the envelope; it is
  // recorded loudly once and handed to the exit gates to adjudicate (necessary vs creep), never
  // used to license further fixing.
  let envelope = null
  let scopeGrew = []
  // Every file this unit has EVER reached outside its envelope. The re-emit guard used to be set
  // equality, so a unit that added one more file on the next fix round degraded a second time for
  // the same incident (arc-observed: 22 `scope-growth` rows, ~15 real incidents). Superset-aware:
  // only a genuinely new file re-degrades.
  const scopeGrewSeen = new Set()
  // A `blocked` verify is a verdict about the ENVIRONMENT, and the host's load is the fact that
  // most often explains one. Record it beside the quarantine so the verdict is auditable.
  const envBlocked = (label, v) => {
    degrade({ label, model: 'haiku', phase: 'Verify', kind: 'verify-blocked',
      what: `verification tooling could not run for ${unit.id}${loadNote(v)} — quarantined as an environment ` +
        `failure, not a unit defect; fix provisioning, not the spec` })
    return quarantine(unit, 'environment/tooling blocked verification — fix provisioning, not the spec', v)
  }
  // A lost report is a hole in the evidence, not just a hiccup: the unit's `debt` entries and any
  // `contractMismatch` trigger went down with it, so the cheap Opus gate would be adjudicating a
  // diff nobody described. Sticky, and forces the frontier gate — the same compensation
  // mismatchEver makes, for the same reason (missing signal, high stakes).
  let reportLostEver = false
  // 10a pull-channel state: `gap` is consumable (one consult per report), `gapEver` sticks.
  // An unconsulted gap (budget spent) forces the Fable exit gate — an unadjudicated
  // spec-silence decision is exactly the missing-signal/high-stakes case mismatchEver covers.
  let gap = null
  let gapEver = null
  let gapConsulted = false
  // Codex emits the two-character string `""` when it means "nothing to report" (arc-observed) —
  // truthy, so it fires the trigger with an empty payload and banks a bogus major debt entry.
  // A trigger whose content is empty once quote characters are stripped IS an empty trigger.
  const triggerText = (v) => (typeof v === 'string' ? v.replace(/^["'\s]+|["'\s]+$/g, '') : '')
  const noteGap = (r) => {
    if (!triggerText(r?.specGap) || r.reportLost) return
    gap = triggerText(r.specGap)
    gapEver = gap
  }
  const noteMismatch = (r) => {
    if (!triggerText(r?.contractMismatch)) return
    mismatch = triggerText(r.contractMismatch)
    mismatchEver = mismatch
    debtLog.push({ unit: unit.id, sha: base, kind: 'contract', severity: 'major',
      what: `implementer-reported contract mismatch: ${mismatch}`,
      why: 'frozen surface contradicts reality — needs architect adjudication' })
  }
  // No debt-fix sweep in the codex lane: the brief's SCOPE already demands in-scope fixing
  // before the run reports done, and out-of-scope confessions BANK by design (DEBT_DISCIPLINE) —
  // a sweep round would be an invitation to widen the diff, the exact spiral clause it once was.

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

  const ws = await runOr(
    // A dead setup agent must not be read as a green worktree: ok:false routes to quarantine below,
    // where a null would instead have thrown and blamed the unit for an infrastructure failure.
    { ok: false, sha: '', state: 'ready', detail: 'setup agent died without a report' },
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
    `(git worktree add ${w} -b unit/${unit.id} ${source}); report ok:true, state:'ready', sha = HEAD.` +
    ghRunning(unit),
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
    `Plan one unit of a larger roadmap for an implementer who is not you. Read the unit spec at ${spec} and any ` +
    `contract files it references under ${repo}/.roadmap/contracts/ (contracts are frozen — treat them as ` +
    `immutable requirements). Codebase conventions and build/test commands are documented at ${brief}. Explore ` +
    `the code in ${w} as needed. ${designClause(unit)}${unit.design?.length ? 'Confirm each cited design source '+ 'actually exists in this worktree; if one is missing, set feasible:false and name it — building a designed '+ 'screen without its comp is how screens get reinvented. ' : ''}A different engineer will implement this from your plan and CANNOT ` +
    `ask you anything — everything it needs must be in the plan or in the spec; before you finish, ask what an ` +
    `implementer would have to ask you, and answer it here. A question with a look-up-able answer is yours to ` +
    `resolve now; a question that is a genuine unsettled DECISION is a spec defect — set \`feasible\`:false and ` +
    `name it in \`approach\`. Produce the plan — return the required fields with the structured ones FIRST and the ` +
    `free-text last: \`feasible\` (boolean), \`files\` (an array of the file paths the implementer may touch — ` +
    `this list becomes its BINDING scope, so an omission forces the work out of scope; err complete, not broad), ` +
    `\`testPlan\` (the specific seams its tests hook into — as few as possible, one is ideal — and the exact ` +
    `command that runs them), then \`approach\` (your approach) LAST. Emit each as a real ` +
    `JSON field — do not fold files/testPlan into the approach prose. Also return \`evidence\`, the context ` +
    `manifest your exploration already earned — the implementer starts from it instead of re-exploring, and ` +
    `the reviewer gets its file list as a reading list: \`keyFiles\` (at most 20, one line each: path plus a ` +
    `one-phrase why), \`signatures\` (at most 15, each one line: an exact signature/type the work builds ` +
    `against, quoted), \`seams\` (at most 10, each a sentence or two: where the change hooks in, with a short ` +
    `quoted anchor). ${TERSE}If the spec cannot be satisfied ` +
    `within its contracts, do not force it: set \`feasible\`:false and explain the contradiction in ` +
    `\`approach\`. Do not write code yet.`,
    { model: 'opus', effort: C.implementEffort, phase: 'Implement', label: `plan:${unit.id}`, schema: S.plan })

  // Plan-check — Opus-first: every eligible unit still gets a check (wrong approaches die
  // before code exists), but only structural calls (high risk, claimed-infeasible, or the
  // always-fable policy) pay the Fable architect up front. Everything else gets a free Opus
  // plan-check that escalates to Fable only when the call turns frontier.
  if (C.planCheckRisk.includes(unit.risk) || !implPlan.feasible) {
    const critique = await specCritique(unit, w, implPlan)
    const check = await runPlanCheck(unit, implPlan, spec, { critique })
    // An agent that DIED returns null (API error, safeguard refusal, retry exhaustion), and reading
    // `.verdict` off it took the whole unit pipeline down with a TypeError — arc-observed when a
    // plan-check tripped a provider safeguard. A missing verdict is an infrastructure failure, not
    // a plan defect: quarantine with that said plainly rather than blaming the unit.
    if (!check?.verdict)
      return quarantine(unit, 'plan-check produced no verdict (agent died or was refused) — infrastructure, not the plan', check)
    if (check.verdict === 'quarantine') return quarantine(unit, 'plan rejected by architect', check)
    if (check.verdict === 'redirect') {
      // The plan-check is an ADJUDICATION path too — its charter explicitly lets it name the
      // resolution of a spec contradiction, including a decision the spec marked escalate-only.
      // It must therefore write to the same ledger the escalation ladder does. Arc-observed
      // (horizon fixture, run 3): a plan-check legitimately resolved a named open decision, the
      // build brief cited "the architect ruled", twelve modules were pinned to it — and the exit
      // gate, reading an EMPTY escalations ledger, correctly judged the ruling fabricated and
      // demanded an escalation that had already happened. The unit quarantined with its retry
      // budget spent. Two adjudication paths and one ledger is the defect; the gate was right.
      escalationLog.push({ unit: unit.id, stop: 0, tier: 'decided', boundary: 'none',
        by: 'plan-check', gap: `plan-check redirect: ${check.guidance}` })
      // And the ruling lands in the spec for the same reason a tier-1 ladder ruling does: the
      // prompt that carried it does not outlive the session, but every later reader — review,
      // gate, the next unit — reads the spec.
      await run(
        STRICT +
        `Append to the spec file ${spec} — do not modify anything already in it. Add a section titled ` +
        `"## Adjudicated during implementation" if it is not already present, then one bullet recording ` +
        `this ruling verbatim: the architect redirected the plan for unit ${unit.id} with "${check.guidance}". ` +
        `Report ok.`,
        { model: 'haiku', effort: 'low', phase: 'Escalate', label: `spec-append:${unit.id}#plan`, schema: S.ok })
      implPlan = await run(
        `Revise your implementation plan for unit ${unit.id} (spec: ${spec}). Your previous plan:\n` +
        `${JSON.stringify(implPlan)}\nThe architect's direction: ${check.guidance}. ` +
        `Return all four required fields again, structured first: \`feasible\`, \`files\`, \`testPlan\`, then ` +
        `\`approach\` last — and refresh the \`evidence\` manifest (keyFiles one line each, signatures one line ` +
        `each, seams a sentence or two each) where the direction changes it. ${TERSE}`,
        { model: 'opus', effort: C.implementEffort, phase: 'Implement', label: `replan:${unit.id}`, schema: S.plan })
    }
  }
  // Never hand an infeasible plan to an implementer — there is no honest way to execute it.
  if (!implPlan.feasible)
    return quarantine(unit, 'spec unsatisfiable at planning (architect-confirmed) — needs respec, not retry', implPlan)
  envelope = implPlan.files?.length ? [...implPlan.files] : null

  setStage(unit.id, 'implement')
  const impl = await buildStep(unit, w, base, implPlan)
  // Codex dispatch halted (probe failure or usage limit observed mid-wave): PARK, don't judge.
  // The unit re-enters by adoption next wave with whatever commits exist.
  if (impl.parked) return { status: 'pending', parked: true, note: `parked before implement: ${codexHalt}` }
  // The report died. Ask the branch whether the WORK died with it: commits present means the
  // implementer finished and only its report was lost, so the diff must be judged on its merits by
  // the normal verify -> review -> gate path. No commits means nothing was built, and quarantine is
  // still the right answer. Getting this backwards is what cost two units and two hand-rescues.
  if (impl.reportLost) {
    const probe = await runOr({ ok: false, sha: '', detail: 'commit probe agent died' },
      STRICT + `In the worktree at ${w}: report ok:true if \`git rev-list --count ${base}..HEAD\` is greater ` +
      `than zero, else ok:false, and sha = HEAD. Report only; change nothing.`,
      { model: 'haiku', effort: 'low', phase: 'Implement', label: `commit-probe:${unit.id}`, schema: S.ws })
    if (!probe.ok) {
      // Nothing was built, so quarantine is right — but runOr swallowed whatever actually went
      // wrong into the degradation ledger, and a dossier that says only "no commit" sends the next
      // reader hunting. Carry the real cause into the reason.
      const why = degradations.filter((d) => typeof d.label === 'string' &&
        (d.label === `codex-build:${unit.id}` || d.label === `codex-build-retry:${unit.id}`))
        .map((d) => d.what).join(' | ')
      return quarantine(unit,
        `implementer produced neither a report nor a commit — nothing was built${why ? ` (${why})` : ''}`, probe)
    }
    reportLostEver = true
    log(`${unit.id}: implement report lost but ${probe.sha?.slice(0, 7) ?? 'work'} is committed — judging the branch`)
  }
  noteMismatch(impl)
  noteGap(impl)
  // Confessed debt banks directly: the brief's SCOPE already demanded in-scope fixing before
  // reporting done, so what remains is out-of-scope by declaration — ledger, not fix round.
  if (!impl.reportLost) addDebt(unit.id, base, impl.debt)
  } // end fresh-build block — existingBranch and adopted (crash-recovered) branches enter the pipeline here

  // Mechanical polish loop: verify → codex fix, bounded. There is deliberately NO adversarial
  // review stage here: Codex's build already ran its own implement→test→fix loop, and a
  // standalone review was a free pass generating directives against a diff the exit gate
  // re-reads with authority anyway — i.e. one more way to widen the diff (the spiral's third
  // clause). The gates carry the hunting clauses (FINDING_BAR); this loop fixes only what the
  // mechanical verify can prove failing.
  setStage(unit.id, 'polish')
  let verify
  for (let round = 0; round <= C.maxFixRounds; round++) {
    verify = await withGateSlot(() => run(
      STRICT +
      `In the worktree at ${w}: check cheapest-first — lint/typecheck the changed files, then run the tests ` +
      `scoped to this unit plus the acceptance checks listed in ${spec} (commands and conventions: ${brief}). ` +
      `Do NOT run the full project suite — that happens at merge. Report \`diffFiles\` = the exact output ` +
      `lines of \`git diff --name-only ${base}..HEAD\`, and check whether that diff touches any path under ` +
      `.roadmap/ (report that as contractSurfaceTouched — ` +
      `the whole directory is the orchestrator's, not just contracts/). Report failures with the exact ` +
      `verbatim error output, never paraphrased, and \`failingSpecs\` = the repo-relative path of every test ` +
      `FILE that has a failure, one entry per file. ${LOAD_FACTS}If the tooling itself cannot run (missing ` +
      `dependency, broken command, environment failure) — as opposed to an assertion failing — report ` +
      `blocked:true and stop. Do not fix anything.`,
      { model: 'haiku', phase: 'Verify', label: `verify:${unit.id}#${round}`, schema: S.verify }))
    if (verify.blocked) return envBlocked(`verify:${unit.id}#${round}`, verify)
    // Cross-unit aggregation: a red that several units share and none of them caused is taken over
    // by the breaker here, before this unit spends a fix round on it.
    noteFailingSpecs(unit.id, verify)
    // Adopted/existing-branch entry has no plan pass: the envelope is the diff AT ENTRY —
    // pinned from the first verify and never widened after (that distinction is the mechanism).
    if (!envelope && verify.diffFiles?.length) envelope = [...verify.diffFiles]
    else if (envelope && verify.diffFiles) {
      const env = new Set(envelope)
      const grew = verify.diffFiles.filter((f) => !env.has(f) && !scopeAllowed(f))   // scopeAllow: never growth
      if (grew.some((f) => !scopeGrewSeen.has(f)))
        degrade({ label: `verify:${unit.id}#${round}`, model: 'haiku', phase: 'Verify', kind: 'scope-growth',
          what: `unit ${unit.id}'s diff reaches ${grew.length} file(s) outside its pinned scope: ` +
            `${grew.slice(0, 8).join(', ')}${grew.length > 8 ? ', …' : ''} — the exit gate adjudicates each ` +
            `(necessary vs creep); this is a signal, never a licence to fix them` })
      for (const f of grew) scopeGrewSeen.add(f)
      scopeGrew = grew
    }
    // A unit whose entire red belongs to the breaker has nothing of its own left to fix.
    if (verify.pass || fullySuppressed(verify)) break

    // Mid-loop rescue: fired by code over objective signals only, and capped.
    let directive = null
    const stuck = round >= C.maxFixRounds || verify.contractSurfaceTouched || !!mismatch || !!gap
    if (stuck && consultsUsed < C.maxConsults) {
      consultsUsed++
      const dossier = await run(
        `Distill a brief dossier for an architect about unit ${unit.id}, which is stuck. Read the spec at ${spec}; ` +
        `summarize what was attempted (branch unit/${unit.id}, worktree ${w}), the strongest failure evidence, and ` +
        `the most plausible root cause. Verify: ${JSON.stringify(verify)}.` +
        ` Implementer-reported contract mismatch: ${mismatch ?? 'none'}.` +
        ` Implementer-reported spec gap (a decision the spec does not settle): ${gap ?? 'none'}.`,
        { model: 'sonnet', phase: 'Escalate', label: `rescue-dossier:${unit.id}`, schema: S.dossier })
      directive = await run(
        `You are the architect. Unit ${unit.id} is stuck. Dossier: ${JSON.stringify(dossier)} (spec: ${spec} — ` +
        `consult it and the code in ${w} yourself if the dossier is not enough). Decide: redirect with brief ` +
        `guidance, or quarantine for redesign. Do not write code.`,
        { model: 'fable', effort: C.fableEffort, phase: 'Escalate', label: `consult:${unit.id}`, schema: S.directive })
      if (directive.action === 'quarantine') return quarantine(unit, 'architect consult', directive)
      mismatch = null   // consumed — one consult per reported mismatch
      if (gap) { gap = null; gapConsulted = true }   // the dossier carried it; the architect saw it
    }

    bumpRound(unit.id, 'fix')
    const fixed = await fixStep(unit, w, base, envelope, { step: `fix${round}`, label: `codex-fix:${unit.id}#${round}` },
      `Failing checks (verbatim): ${JSON.stringify(verify.failures)}.${sharedRedClause(verify)}` +
      `${directive ? ` Architect direction: ${directive.guidance}` : ''}${designClause(unit)}` +
      ` If a fix forces you to deviate from a frozen contract surface, report it in \`contractMismatch\` ` +
      `(one or two sentences, max 300 characters).`)
    if (fixed.parked) return { status: 'pending', parked: true, note: `parked mid-polish: ${codexHalt}` }
    if (fixed.reportLost) reportLostEver = true
    addDebt(unit.id, base, fixed.debt)
    noteMismatch(fixed)
    noteGap(fixed)
  }
  // Quarantining a unit for a red the breaker owns would be exactly the failure the breaker exists
  // to stop — one shared assertion killing every unit in the wave.
  if (!verify.pass && !fullySuppressed(verify)) return quarantine(unit, 'verification never passed', verify)
  const gateReverify = async (label) => {
    const v = await withGateSlot(() => run(
      STRICT +
      `In ${w}: re-run lint/typecheck on the changed files, the unit-scoped tests, and the acceptance checks ` +
      `from ${spec} (commands: ${brief}). Report failures verbatim, \`failingSpecs\` = the repo-relative path ` +
      `of every test FILE that has a failure, and \`diffFiles\` = the exact output lines ` +
      `of \`git diff --name-only ${base}..HEAD\`. ${LOAD_FACTS}blocked:true if the tooling itself cannot ` +
      `run. Fix nothing.`,
      { model: 'haiku', phase: 'Verify', label, schema: S.verify }))
    noteFailingSpecs(unit.id, v)
    return v
  }

  // Implementer-pulled consult (10a): a specGap on an all-green unit still gets frontier
  // adjudication — the polish loop's rescue only fires on failure signals, and the class this
  // closes is precisely the silent design decision under an all-green suite. One consult per
  // reported gap, riding the same maxConsults budget; an unconsulted gap forces the Fable gate.
  // Units are sized by what we can specify, not by duration, so stops are the release valve and
  // several per unit are normal. Most are nonsense — a decision the spec DOES settle that the
  // implementer failed to read — so Opus triages first and only genuine boundary-crossings reach
  // the frontier. Triage is free by design: charging it to maxConsults would let three misreads
  // starve the rescue channel. Three strikes goes straight to Fable regardless of content —
  // at that point the finding is not the decision, it is that the unit was specified wrong.
  let stops = 0
  while ((gap || mismatch) && stops < C.maxStops) {
    stops++
    // A contract mismatch is tier-2 BY CONSTRUCTION and skips triage: "a frozen contract is wrong
    // or cannot be implemented as written" is the first entry in the boundary enum, and no
    // adjudicator confined to this unit can rule on a surface that binds every other one. Only the
    // architect may amend a contract. Arc-observed (horizon fixture, run 2): with the ladder wired
    // to specGap alone, a unit that stopped with `stopped-contract-mismatch` — naming its own fix
    // in the report — got no ruling at all, went to the gate twice and quarantined as
    // "did not converge". That is the most important stop type, and it was the one that could not
    // reach an architect.
    const isMismatch = !!mismatch
    const reported = isMismatch ? mismatch : gap
    if (isMismatch) mismatch = null
    else gap = null
    let guidance = null                 // set only when a ruling must be applied as a fix round
    const pinned = envelope?.length ? envelope.join(', ') : 'the files this unit already touches'
    const priorStops = escalationLog.filter((e) => e.unit === unit.id).length
    const v = (isMismatch || priorStops >= 2) ? null : await run(
      `You are adjudicating an implementer escalation on unit ${unit.id}. The implementer stopped and reported a ` +
      `decision it says the spec does not settle: "${reported}". Read the spec at ${spec}, the contracts it ` +
      `references, and \`git diff ${base}..HEAD\` in ${w} as needed. Rule with \`tier\`:\n` +
      `- "cited" — the spec, a contract, the conventions or the existing code DOES settle this and the ` +
      `implementer missed it. Most escalations are this. Put the exact location and the answer in \`guidance\`.\n` +
      `- "decided" — a genuine gap, but the decision stays inside this unit's pinned scope (${pinned}) and is ` +
      `recoverable. Put the decision and the reasoning behind it in \`guidance\`.\n` +
      `- "escalate" — the decision leaks past what you can see from this unit alone. Name the boundary and put ` +
      `the question for the architect in \`guidance\`.\n` +
      `\`boundary\` is "none" for cited and decided. For escalate it is exactly one of: "contract" (a frozen ` +
      `contract is wrong or cannot be implemented as written), "scope-envelope" (the pinned scope must widen), ` +
      `"other-unit" (another unit's spec or the dependency order is implicated), "plan-of-record" (the approved ` +
      `implementation plan is itself wrong), "mis-specified" (the unit is wrong in shape — Phase-0 territory). ` +
      `Difficulty is NOT a boundary: a hard decision that stays inside this unit is "decided", not "escalate". ` +
      `${directionClause}Do not write code.`,
      { model: 'opus', effort: 'high', phase: 'Escalate', label: `adjudicate:${unit.id}#${stops}`, schema: S.adjudication })
    if (v && v.tier !== 'escalate') {
      gapConsulted = true
      guidance = v.guidance
      escalationLog.push({ unit: unit.id, stop: stops, tier: v.tier, boundary: v.boundary, by: 'opus', gap: reported })
      // A "decided" ruling settles something the spec did not. It has to land IN the spec: the
      // implementer's own context may compact before the unit ends, and review, the gate and any
      // later reader see the spec, never this resume prompt.
      if (v.tier === 'decided')
        await run(
          STRICT +
          `Append to the spec file ${spec} — do not modify anything already in it. Add a section titled ` +
          `"## Adjudicated during implementation" if it is not already present, then one bullet recording ` +
          `this ruling verbatim: the question was "${reported}"; the ruling is "${v.guidance}". Report ok.`,
          { model: 'haiku', effort: 'low', phase: 'Escalate', label: `spec-append:${unit.id}#${stops}`, schema: S.ok })
    } else if (consultsUsed < C.maxConsults) {
      consultsUsed++
      gapConsulted = true
      const gd = await run(
        `You are the architect on unit ${unit.id}. ` +
        (isMismatch
          ? `The engineer reports that a FROZEN CONTRACT contradicts what this unit must build: "${reported}". ` +
            `You own the contracts and the engineer may not amend one, so this is yours alone. Rule on the ` +
            `CONTRACT, not just this unit: confirm the engineer's reading and direct the lawful implementation ` +
            `under the surface as frozen, redirect with the amendment you are making and what it now requires, ` +
            `or quarantine if the unit cannot exist under it. Weigh that the surface binds every other unit too.\n`
          : `The engineer made a decision the spec does not settle and pulled you in: "${reported}". ` +
            (v ? `A first-line adjudicator escalated it because it crosses a boundary it could not see past: ` +
                 `${v.boundary}. Its reading: ${v.guidance}\n`
               : `This is the third stop on this unit — the earlier ones were adjudicated below you. Weigh whether ` +
                 `the unit itself is specified wrongly, not just this decision.\n`)) +
        `Read the spec at ${spec} and the contracts it references, and \`git diff ${base}..HEAD\` ` +
        `in ${w} as needed. Decide: "confirm" if the decision stands as built; "redirect" with brief guidance if it ` +
        `(or a better alternative) must be steered — the engineer applies your guidance as one fix round; ` +
        `"quarantine" only if the unsettled decision invalidates the unit's premise. Do not write code.`,
        { model: 'fable', effort: C.fableEffort, phase: 'Escalate', label: `gap-consult:${unit.id}#${stops}`, schema: S.directive })
      // Same dead-agent class as the plan-check guard: a null consult must not be dereferenced.
      // Leaving the trigger unconsumed is the conservative outcome — mismatchEver/gapEver still
      // force the frontier gate, so the decision is adjudicated there instead of being lost.
      if (!gd?.action) break
      escalationLog.push({ unit: unit.id, stop: stops, tier: 'escalate',
        boundary: isMismatch ? 'contract' : (v?.boundary ?? 'three-strikes'),
        by: 'fable', action: gd.action, gap: reported })
      if (gd.action === 'quarantine') return quarantine(unit, 'spec-gap consult: the unsettled decision invalidates the unit', gd)
      if (gd.action === 'redirect') guidance = gd.guidance
    } else {
      break   // budget spent: the gap stays unadjudicated, which forces the Fable exit gate below
    }
    if (!guidance) continue   // "confirm" / a citation with nothing to change — no fix round
    const gFix = await fixStep(unit, w, base, envelope, { step: `gap-fix-${stops}`, label: `codex-gap-fix:${unit.id}#${stops}` },
      (isMismatch
        ? `You reported that a frozen contract contradicts this unit, and the architect ruled: ${guidance}\n`
        : `The spec left a decision unsettled; you reported it, and the ruling is: ${guidance}\n`) +
      `Apply that ruling.`)
    if (gFix.parked) return { status: 'pending', parked: true, note: `parked at gap-fix: ${codexHalt}` }
    addDebt(unit.id, base, gFix.debt)
    if (gFix.reportLost) reportLostEver = true
    noteMismatch(gFix)
    // A stop DURING the fix round re-enters the ladder rather than being dropped — the whole
    // point of the release valve is that it can fire more than once on a long unit.
    noteGap(gFix)
    verify = await gateReverify(`gap-verify:${unit.id}#${stops}`)
    if (verify.blocked) return envBlocked(`gap-verify:${unit.id}#${stops}`, verify)
  }

  // Exit gate — Opus-first, escalating to the Fable architect only when the call is
  // genuinely hard. High-risk units, contract-touching diffs, and a deterministic audit
  // sample skip straight to the guaranteed Fable gate: Opus cannot reliably self-detect the
  // subtle oversights that gate exists to catch, so where the stakes are structurally
  // highest, frontier judgment stays mandatory (DESIGN.md decision 4).
  setStage(unit.id, 'gate')
  // Scope growth is adjudicated at the gate, where judgment already lives — annotate-and-decide,
  // not force-frontier (which would fire constantly on legitimately-underestimated file lists).
  // Evaluated per gate CALL, not once: the precedent it carries is this wave's sibling rulings,
  // which accumulate while this unit is in flight.
  const scopeCreepClause = () => scopeGrew.length
    ? ` This diff touches ${scopeGrew.length} file(s) outside the unit's pinned scope: ${scopeGrew.join(', ')}. ` +
      `Adjudicate each explicitly: necessary to satisfy the spec (say so and approve it), or scope creep to ` +
      `be reverted (a revise directive). Do not treat their presence as licence to review them as though ` +
      `they were in scope. Record one entry per file in \`scopeRulings\` ({file, verdict:"approve"|"revert"}) — ` +
      `that record is what makes the next gate's answer consistent with yours.` + scopePrecedent(unit.id)
    : ''
  // Directive-cap enforcement, both gates: a cap on REPORTING, never on reading — overflow past
  // it is banked as debt (the ledger invariant), and the cap runs BEFORE the correctness-debt
  // coercion so a coerced correctness directive is never dropped by it.
  const capDirectives = (g, label) => {
    const over = (g.directives ?? []).slice(C.maxBlockingFindings)
    if (over.length) {
      addDebt(unit.id, base, over.map((d) => ({ what: d.what, why: d.why })), { kind: 'structure' })
      g.directives = g.directives.slice(0, C.maxBlockingFindings)
      log(`${unit.id}: ${label} issued ${over.length} directive(s) past the cap — banked as debt`)
    }
  }
  // mismatchEver: the Fable gate catching exactly this case (silent frozen-surface deviation,
  // all-green tests) is arc-observed value.
  const forceFrontier =
    C.exitGate === 'always-fable' || unit.risk === 'high' ||
    verify.contractSurfaceTouched || auditPick(unit) || mismatchEver || reportLostEver ||
    (gapEver && !gapConsulted)   // an unadjudicated spec-silence decision — same missing-signal logic
  // An audit-only force (the sample fired, nothing structural did) is a spot-check of an
  // Opus-approved unit, not a from-scratch re-gate: it runs at the cheaper auditEffort and
  // reads a diet of the diff. Any structural force keeps the full-read gateEffort path.
  const auditOnly = auditPick(unit) && C.exitGate !== 'always-fable' &&
    unit.risk !== 'high' && !verify.contractSurfaceTouched && !mismatchEver && !reportLostEver &&
    !(gapEver && !gapConsulted)

  // When the Opus-first gate hands off to the Fable gate (escalation or non-convergence),
  // carry its last assessment across so the frontier gate confirms/overturns a concrete lead
  // rather than re-deriving the concern from the spec, contracts, and diff from scratch.
  let opusHandoff = null
  if (!forceFrontier) {
    // Bounded Opus self-gate: a FRESH adversarial Opus (not the implementer) grades the
    // acceptance criteria one by one, then approves, self-revises (free), or escalates.
    for (let g = 0; g < C.maxGateRounds; g++) {
      spend.opusGateRounds++
      bumpRound(unit.id, 'opusGate')
      const og = await runOr({ verdict: 'escalate', trigger: 'stuck', directives: [], debt: [],
        notes: 'opus gate produced no report — degraded to the frontier gate' },
        riskTilt(unit.risk) +
        `You are the exit gate for unit ${unit.id} of a roadmap build, standing in for the architect — but you ` +
        `are Opus, so escalate to the frontier architect the moment the call exceeds a capable engineer's ` +
        `authority rather than guessing. In the worktree at ${w}: read the spec at ${spec} and the contracts it ` +
        `references, then read \`git diff ${base}..HEAD\` in full and whatever surrounding code you need. ` +
        `${convClause}${designClause(unit)}Verification evidence: ${JSON.stringify(verify)}. Grade each of the spec's acceptance criteria ` +
        `individually before any overall verdict — a gestalt impression hides exactly the misses you are here to ` +
        `catch; subtle spec misses, contract edge cases, and tests that would not fail if the behaviour were ` +
        `actually wrong are exactly what to hunt. ${unit.design?.length ? 'For a comp-governed criterion, grade conformance against the comp SOURCE: a jsdom presence test is not fidelity evidence, and a fidelity criterion that cannot be checked as written is debt, not a pass. ' : ''}${FINDING_BAR('revise directive')}${scopeCreepClause()}${directionClause}Then choose a verdict: "approve" only if you would merge this ` +
        `as-is and personally vouch for it; "revise" if there is a concrete, mechanical fix you can specify and it ` +
        `needs no frontier judgment (give at most ${C.maxBlockingFindings} directives, worst first — what and ` +
        `why, not code); "escalate" to the frontier ` +
        `architect if you are stuck, if the right choice is a genuinely hard trade-off where every option carries ` +
        `a substantive drawback, if the increment is architecturally foundational to the wider solution, or if ` +
        `you have found an oversight you are not confident you can resolve. Name the escalation trigger. ` +
        `${DEBT_DISCIPLINE}${TERSE}` +
        `${g > 0 ? ' You gated this unit before; focus on whether your previous directives were properly addressed.' : ''}`,
        { model: 'opus', effort: C.opusEffort, phase: 'Opus-gate', label: `opus-gate:${unit.id}#${g}`, schema: S.opusGate })
      capDirectives(og, 'opus-gate')
      recordScopeRulings(unit.id, og)
      // Approve-with-correctness-debt is the verdict-downgrade path the discipline forbids: the
      // items become revise directives (rounds remaining) or force the frontier gate (round cap).
      // Coercion consumes the EXISTING gate rounds, so token cost stays bounded by maxGateRounds.
      const ogCd = correctnessDebt(og.debt)
      if (og.verdict === 'approve' && ogCd.length) {
        og.debt = og.debt.filter((d) => !ogCd.includes(d))
        og.directives = [...(og.directives ?? []), ...asDirectives(ogCd)]
        if (g < C.maxGateRounds - 1) {
          og.verdict = 'revise'
          log(`${unit.id}: opus-gate approved with correctness debt in hand — coerced to revise`)
        } else {
          og.verdict = 'escalate'
          og.trigger = 'oversight'
          log(`${unit.id}: opus-gate approved with correctness debt at the round cap — escalating to the frontier gate`)
        }
      }
      addDebt(unit.id, base, og.debt)
      opusHandoff = og
      if (og.verdict === 'approve') return { status: 'merge-ready', branch: `unit/${unit.id}`, base }
      if (og.verdict === 'escalate') break
      const ogFix = await fixStep(unit, w, base, envelope,
        { step: `opus-gate-fix${g}`, label: `codex-opus-gate-fix:${unit.id}#${g}`, fresh: g === C.maxGateRounds - 1 },
        `The exit gate reviewed your work and issued these directives:\n${JSON.stringify(og.directives)}`)
      if (ogFix.parked) return { status: 'pending', parked: true, note: `parked at opus-gate-fix: ${codexHalt}` }
      addDebt(unit.id, base, ogFix.debt)   // was silently dropped — a fix round's confessions are debt too
      if (ogFix.reportLost) {
        // forceFrontier was computed before this loop, so flagging alone changes nothing here.
        // Hand the unit to the frontier gate directly: the fix's self-reported evidence is gone and
        // an Opus round approving on the strength of a missing report is the failure we are closing.
        reportLostEver = true
        log(`${unit.id}: opus-gate-fix report lost — escalating to the frontier gate`)
        break
      }
      verify = await gateReverify(`opus-gate-verify:${unit.id}#${g}`)
      if (verify.blocked) return envBlocked(`opus-gate-verify:${unit.id}#${g}`, verify)
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
  const reportLostClause = reportLostEver
    ? ' A code-writing agent on this unit committed work but its structured report was lost, so the usual ' +
      'self-reported summary, debt entries and contract-mismatch signal are ABSENT. Judge the diff itself; ' +
      'do not read the missing report as "nothing to declare".'
    : ''
  const gapClause = gapEver
    ? ` The implementer reported a decision the spec does not settle: "${gapEver}"` +
      `${gapConsulted ? ' (already adjudicated by an architect consult)' : ' (NOT yet adjudicated — the consult budget was spent)'}. ` +
      `Judge that decision explicitly against the spec's intent.`
    : ''
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
    bumpRound(unit.id, 'gate')
    const gate = await run(
      riskTilt(unit.risk) +
      `You are the architect gate for unit ${unit.id} of a roadmap build; nothing merges without your approval. ` +
      `In the worktree at ${w}: read the spec at ${spec} and the contracts it references, then ${diffRead}${convClause}${designClause(unit)}Verification evidence: ` +
      `${JSON.stringify(verify)}. Grade each of the spec's acceptance criteria individually before forming your ` +
      `overall verdict — a gestalt impression hides exactly the misses you are here to catch. Judge the work as ` +
      `if you must personally vouch for it: approve only if you would merge it without further steering. Small ` +
      `oversights — subtle spec misses, contract edge cases, tests that would not fail if the behaviour were ` +
      `actually wrong, the things a capable engineer plausibly overlooks — are exactly your job. ` +
      `${unit.design?.length ? 'For a comp-governed criterion, grade conformance against the comp SOURCE: a jsdom presence test is not fidelity evidence, and a fidelity criterion that cannot be checked as written is debt, not a pass. ' : ''}` +
      `${FINDING_BAR('revise directive')}${scopeCreepClause()}${directionClause}If revising, ` +
      `give at most ${C.maxBlockingFindings} specific directives, worst first: what and why, not code. ` +
      `${DEBT_DISCIPLINE}${TERSE}${mismatchClause}${gapClause}${reportLostClause}` +
      `${g === 0 ? opusContext : ' You gated this unit before; focus on whether your previous directives were properly addressed.'}`,
      { model: 'fable', effort: auditOnly ? C.auditEffort : C.gateEffort, phase: 'Architect', label: `gate:${unit.id}#${g}`, schema: S.gate })
    capDirectives(gate, 'frontier gate')
    recordScopeRulings(unit.id, gate)
    // Same coercion as the Opus gate — but this IS the frontier, so at the round cap the items
    // bank at severity:major with a LOUD degradation instead of quarantining work the frontier
    // gate judged mergeable (banking + evidence beats destroying an approved unit).
    const gCd = correctnessDebt(gate.debt)
    if (gate.verdict === 'approve' && gCd.length) {
      if (g < C.maxGateRounds - 1) {
        gate.verdict = 'revise'
        gate.debt = gate.debt.filter((d) => !gCd.includes(d))
        gate.directives = [...(gate.directives ?? []), ...asDirectives(gCd)]
        log(`${unit.id}: frontier gate approved with correctness debt in hand — coerced to revise`)
      } else {
        for (const d of gCd) d.severity = 'major'
        degrade({ label: `gate:${unit.id}#${g}`, model: 'fable', phase: 'Architect', kind: 'correctness-debt-banked',
          what: `frontier gate approved ${unit.id} at the round cap with ${gCd.length} correctness-kind debt ` +
            `item(s) still banked — banked at severity:major; the boundary triage must treat these as bugs, not hygiene` })
      }
    }
    addDebt(unit.id, base, gate.debt)
    if (gate.verdict === 'approve') return { status: 'merge-ready', branch: `unit/${unit.id}`, base }
    if (gate.verdict === 'quarantine') return quarantine(unit, 'rejected at architect gate', gate)
    const gFix = await fixStep(unit, w, base, envelope,
      { step: `gate-fix${g}`, label: `codex-gate-fix:${unit.id}#${g}`, fresh: g === C.maxGateRounds - 1 },
      `The frontier architect gate reviewed your work and issued these directives:\n${JSON.stringify(gate.directives)}`)
    if (gFix.parked) return { status: 'pending', parked: true, note: `parked at gate-fix: ${codexHalt}` }
    addDebt(unit.id, base, gFix.debt)   // was silently dropped — a fix round's confessions are debt too
    if (gFix.reportLost) reportLostEver = true
    verify = await gateReverify(`gate-verify:${unit.id}#${g}`)
    if (verify.blocked) return envBlocked(`gate-verify:${unit.id}#${g}`, verify)
  }
  return quarantine(unit, 'architect gate did not converge')
}

/* --------------------- serial merge queue + suite gate ------------------ */
async function mergeUnit(unit) {
  // NOROADMAP made mechanical: the merge is the last place a unit diff can smuggle
  // orchestrator-state edits in (arc-observed: a unit edited a frozen contract from its
  // worktree and the queue accepted it — content sound, channel wrong). Refusal is checked
  // by the merge agent, the strip preserves the content in branch history, and the
  // kind:'contract' debt entry routes adjudication to the architect (root return).
  const roadmapCheck =
    `check \`git diff --name-only $(git merge-base HEAD unit/${unit.id})..unit/${unit.id} -- .roadmap/\` — if it ` +
    `lists ANY path, do NOT merge; touch nothing and report merged:false with those exact paths in \`roadmapPaths\`. `
  // Plan-driven prefix-uniqueness guard, '' when unset so the prompt stays byte-identical on
  // plans without numbered sequences (arc-observed: next-free-at-dispatch numbering collided
  // twice in one arc; one collision silently erased a CHECK constraint at merge). The check is
  // a DIFF of duplicate sets, pre-merge tip (HEAD^1 of the --no-ff merge commit) vs merged tree:
  // only a duplicate the merge INTRODUCES refuses. Twice arc-observed: a global-uniqueness check
  // on a repo whose history already held grandfathered duplicate pairs refused every merge in a
  // wave — 8 gate-approved units quarantined, zero merges, ~5h burned.
  const prefixClause = plan.prefixUniqueGlobs?.length
    ? ` Then, if you performed the merge, before the suite: for each of these globs — ${plan.prefixUniqueGlobs.join(', ')} — ` +
      `list the matching filenames in the PRE-MERGE tip (\`git ls-tree -r --name-only HEAD^1 -- '<glob>'\`) and in ` +
      `the MERGED tree (same command with HEAD), extract each filename's leading digit run, and compute the set of ` +
      `digit runs shared by two or more files in each list. Digit runs already duplicated in the pre-merge tip are ` +
      `grandfathered and never refuse. If the merged tree has a duplicated digit run that the pre-merge tip did ` +
      `NOT already have, the merge is REFUSED: undo it with \`git reset --hard ORIG_HEAD\` and report merged:false ` +
      `with every filename of the NEW collision(s) in \`prefixCollision\`.`
    : ''
  const mergePromptText =
    STRICT +
    `In the integration worktree at ${intWt} (branch ${intBranch}): first, if a merge is already in progress ` +
    `(a MERGE_HEAD exists), clear it with \`git merge --abort\`. Then, if unit/${unit.id} is already an ancestor ` +
    `of HEAD (\`git merge-base --is-ancestor unit/${unit.id} HEAD\` succeeds — a crash-replay after this merge ` +
    `already landed), skip the merge but still run the project's full test suite (commands: ${brief}) and report ` +
    `merged:true with the current HEAD sha. Otherwise ${roadmapCheck}Only if it lists nothing, merge branch ` +
    `unit/${unit.id} ` +
    `(git merge --no-ff unit/${unit.id}). If the merge conflicts, abort it (git merge --abort) and report ` +
    `merged:false naming the conflicting paths in detail — do not resolve conflicts yourself. If it merges ` +
    `cleanly, run the project's full test suite (commands: ${brief}) and report the result.${prefixClause} ` +
    `Report the current HEAD sha either way.` + ghMerged(unit)
  let res = await withGateSlot(() => run(mergePromptText, { model: 'haiku', phase: 'Merge', label: `merge:${unit.id}`, schema: S.merge }))

  if (!res.merged && res.roadmapPaths?.length) {
    log(`${unit.id}: unit diff touches orchestrator-owned .roadmap/ (${res.roadmapPaths.join(', ')}) — stripping before merge`)
    const strip = await run(
      STRICT +
      `In the worktree at ${wtOf(unit)} (branch unit/${unit.id}): restore every path under .roadmap/ to its state ` +
      `at the merge base. Run \`BASE=$(git merge-base ${intBranch} HEAD)\`; then \`git checkout "$BASE" -- .roadmap/\` ` +
      `(restores modified and deleted paths), and \`git rm -f\` each path listed by ` +
      `\`git diff --name-only --diff-filter=A "$BASE"..HEAD -- .roadmap/\` (files the branch added; remove any ` +
      `directories left empty). Commit the result with message "strip .roadmap/ — orchestrator-owned; original ` +
      `content preserved in prior commits". Touch nothing outside .roadmap/. Report ok plus the new HEAD sha.`,
      { model: 'haiku', phase: 'Merge', label: `strip-roadmap:${unit.id}`, schema: S.ws },
    ).catch(() => null)
    debtLog.push({ unit: unit.id, sha: res.head, kind: 'contract', severity: 'major',
      what: `unit diff touched orchestrator-owned .roadmap/ paths, stripped before merge: ${res.roadmapPaths.join(', ')}`,
      why: 'units may never write .roadmap/; the stripped content survives in the branch history — adjudicate ' +
        'whether it belongs in a contract amendment (the channel it should have used)' })
    if (!strip?.ok)
      return quarantine(unit, `unit diff touches .roadmap/ (${res.roadmapPaths.join(', ')}) and the strip commit ` +
        `failed — nothing merged; the branch is intact`, res)
    res = await withGateSlot(() => run(mergePromptText, { model: 'haiku', phase: 'Merge', label: `merge:${unit.id}#restrip`, schema: S.merge }))
    if (!res.merged && res.roadmapPaths?.length)
      return quarantine(unit, 'unit diff still touches .roadmap/ after a strip commit — nothing merged', res)
  }
  // Guarded on the CONFIG, not just the report: the schema field exists whether or not the plan
  // sets prefixUniqueGlobs, and a merge agent facing an ordinary conflict has used it as a
  // scratchpad for "the colliding files" (paid-run-observed 2026-08-11: a plain textual conflict
  // quarantined as a prefix collision before the resolver ever ran). Without configured globs
  // there is no prefix policy to violate — the conflict path below owns the outcome.
  if (!res.merged && plan.prefixUniqueGlobs?.length && res.prefixCollision?.length)
    return quarantine(unit, `numbered-prefix collision at merge (${res.prefixCollision.join(', ')}) — pre-allocate ` +
      `explicit numbers in the conventions contract and respec; never renumber silently`, res)

  if (!res.merged) {
    res = await withGateSlot(() => run(
      `In the integration worktree at ${intWt} (branch ${intBranch}): merge branch unit/${unit.id}, resolving ` +
      `conflicts. First ${roadmapCheck}Both sides are intentional work — consult ${specOf(unit)}, the specs of ` +
      `recently merged units ` +
      `under ${repo}/.roadmap/specs/, and the contracts under ${repo}/.roadmap/contracts/ to decide each ` +
      `resolution. Then run the full test suite.${prefixClause} If you are genuinely unsure a resolution is ` +
      `semantically right, ` +
      `abort the merge and report merged:false rather than guessing. Report the HEAD sha and suite result.`,
      { model: 'opus', effort: C.opusEffort, phase: 'Merge', label: `resolve:${unit.id}`, schema: S.merge }))
    if (!res.merged && res.roadmapPaths?.length)
      return quarantine(unit, 'unit diff touches .roadmap/ at conflict resolution — nothing merged', res)
    if (!res.merged && plan.prefixUniqueGlobs?.length && res.prefixCollision?.length)
      return quarantine(unit, `numbered-prefix collision at merge (${res.prefixCollision.join(', ')}) — pre-allocate ` +
        `explicit numbers in the conventions contract and respec; never renumber silently`, res)
    if (!res.merged) return quarantine(unit, 'unresolvable merge conflicts', res)
  }

  if (!res.suitePass) {
    res = await withGateSlot(() => run(
      `The integrated test suite fails after merging unit/${unit.id} into ${intBranch} (worktree ${intWt}). ` +
      `Evidence: ${res.detail}. First check whether the failure predates this merge. If the merge caused it, ` +
      `diagnose and fix on ${intBranch} — this may be a cross-unit interaction; the specs of all units live under ` +
      `${repo}/.roadmap/specs/. Re-run the suite. If you cannot make it pass, revert the merge commit ` +
      `(git revert -m 1 HEAD, keeping the branch intact for later redesign) and report suitePass:false.`,
      { model: 'opus', effort: C.opusEffort, phase: 'Merge', label: `integration-fix:${unit.id}`, schema: S.merge }))
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
    // The terminal result replaces the running record wholesale — carry the round tally over.
    const rounds = units.get(unit.id)?.rounds
    if (result.status === 'merge-ready') {
      // Stamp 'merge-queue' directly (not via setStage — status is 'merge-ready', not 'running');
      // this transient record is overwritten by the terminal result below, so no stale stage survives.
      units.set(unit.id, { ...(rounds ? { rounds } : {}), ...result, stage: 'merge-queue' })
      checkpoint()
      const segment = mergeChain.then(() => mergeUnit(unit)).catch((e) =>
        quarantine(unit, `merge pipeline error: ${e?.message ?? e}`))
      mergeChain = segment.then(() => null, () => null)
      result = await segment
    }
    units.set(unit.id, { ...(rounds ? { rounds } : {}), ...result })
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
  // A design citation naming an authority that does not exist is a plan-pack defect that would
  // otherwise degrade silently into an empty clause — the exact "invisible to the pipeline"
  // failure designAuthorities exists to end. Fail loud, like the unknown-edge check above.
  for (const u of plan.units)
    for (const cite of u.design ?? [])
      if (!authOf(cite))
        throw new Error(`unit ${u.id}: design citation "${cite}" names no authority in plan.designAuthorities ` +
          `(known ids: ${(plan.designAuthorities ?? []).map((a) => a.id).join(', ') || 'none'})`)
  // A self-referential adopt makes the setup agent's remove-stale-remnants path delete its own
  // source — this destroyed finished work once; refuse at validation.
  // `closes` names existing issue numbers the merge path closes — a malformed entry would ride
  // silently into merge/sweep prompts as garbage gh commands. Fail loud, like the checks above.
  for (const u of plan.units)
    if (u.closes !== undefined && (!Array.isArray(u.closes) ||
        u.closes.some((n) => !Number.isInteger(n) || n <= 0)))
      throw new Error(`unit ${u.id}: \`closes\` must be an array of positive integer issue numbers — fix the plan`)
  for (const u of plan.units)
    if (u.existingBranch && u.existingBranch === `unit/${u.id}`)
      throw new Error(`unit ${u.id}: existingBranch is the unit's own branch unit/${u.id} — setup could delete ` +
        `its own source and recreate it from the wrong base. Anchor the commits under a differently-named ref ` +
        `first (e.g. \`git branch adopt/${u.id} $(git rev-parse unit/${u.id})\`) and set existingBranch to that.`)
}

phase('Setup')
const intSetup = await runOr(
  { ok: false, sha: '', detail: 'integration-worktree setup agent died without a report' },
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

// Codex availability probe — every wave, because auth expires between waves (ChatGPT-plan
// OAuth) and the Phase-0 preflight is only as fresh as the arc's start. Failure halts the wave
// BEFORE dispatch: units stay pending, state checkpoints, the conductor early-returns to the
// root, and the human re-auths (`codex login` / `--device-auth`) and relaunches. Auth is a
// human act — the harness never attempts it.
{
  const waveN = (prior.wave ?? 0) + 1
  const cp = await runOr({ ok: false, detail: 'codex probe agent died without a report' },
    STRICT +
    `In the git repository at ${repo}: run \`${codexHome}codex --version\` and \`${codexHome}codex login status\`. ` +
    `Report ok:true ONLY if the codex CLI is present AND the login status says logged in; otherwise ok:false ` +
    `with the exact command output (one or two lines, verbatim) in detail. Read-only — change nothing.`,
    { model: 'haiku', effort: 'low', phase: 'Setup', label: `codex-probe:w${waveN}`, schema: S.ok })
  if (!cp.ok) {
    codexHalt = 'codex-unavailable'
    degrade({ label: `codex-probe:w${waveN}`, model: 'haiku', phase: 'Setup', kind: 'codex-unavailable',
      what: `codex CLI unavailable (${String(cp.detail ?? '').slice(0, 200)}) — wave halted before dispatch; ` +
        `state is checkpointed and resumable. Operator: codex login (or codex login --device-auth headless), ` +
        `then relaunch the arc.` })
  }
}

// Preview setup: detach the primary checkout at the wave-start tip and stand the preview
// up there. Failure never gates the wave — throwing here would gate the arc on its own
// observability.
if (previewStatus === 'pending') {
  const p = plan.preview
  const ps = await run(
    STRICT +
    `Set up the arc's preview mirror: cd to the PRIMARY repository checkout at ${repo} and stay there for ` +
    `every git command. Then, ${previewStopCmd} (the pidfile lives OUTSIDE the repo). ` +
    `Then run \`git status --porcelain -- ':(exclude).roadmap'\` — .roadmap/ is the orchestrator's own working ` +
    `state, EXPECTED to be dirty mid-arc; it carries across detaches and must never block the mirror ` +
    `(eval-observed: gating on it killed the preview on every wave after the first). If that command reports ` +
    `ANY entries — real local edits outside .roadmap/ — do NOT detach: report ok:false, and in ` +
    `\`detail\` give the exact porcelain output plus, for each modified tracked path, whether ` +
    `\`git diff ${integrationTip} -- <path>\` is empty (empty means the local content is byte-identical to the ` +
    `target tip — a carried modification left by a stale detach point; non-empty means real local edits). ` +
    `If it reports nothing, run \`git checkout --detach ${integrationTip}\` — if git refuses, report ok:false ` +
    `with the exact error. Either way never stash, reset, or force. ` +
    (p.setup ? `Then run, from inside ${repo}: ${p.setup}. ` : '') +
    (p.start ? `Then start the preview from inside ${repo} with ${previewStartCmd(p.start)}. ${previewSweepRetry}` : '') +
    previewHealth() +
    `Report ok plus the checkout's HEAD sha.`,
    { model: 'haiku', phase: 'Preview', label: 'preview-setup', schema: S.ws },
  ).catch(() => null)
  if (ps?.ok && sameSha(ps.sha, integrationTip)) { previewStatus = 'live'; previewSha = integrationTip }
  else {
    previewStatus = 'failed'
    // Loud, not a log line: a dead mirror silently no-ops the explorer AND the design reconcile
    // for the whole wave (arc-observed) — the boundary's owed markers re-queue those jobs, and
    // this entry tells the operator exactly what to do with the primary checkout.
    degrade({ label: 'preview-setup', model: 'haiku', phase: 'Preview', kind: 'preview-failed',
      what: `preview mirror never came up (${String(ps?.detail ?? ps?.sha ?? 'agent died without a report').slice(0, 300)}) ` +
        `— the wave runs without runtime observability and the boundary will record owed explorer/design markers. ` +
        `Operator: if the diagnosis shows modified paths byte-identical to the target tip (a carried modification ` +
        `from a stale detach point), a plain \`git checkout --detach ${integrationTip}\` in the primary checkout is ` +
        `safe; real local edits are yours to commit or stash — the harness never will.` })
  }
}

const inScope = plan.units.filter((u) => u.inScope)
log(`wave ${serialize().wave}: ${inScope.length} in-scope units, ${C.maxConsults} rescue consults available`)

// `blocked` is a snapshot of one wave's dependency state, NOT a terminal verdict — but nothing
// ever cleared it: ready() requires 'pending', and the record initializer only fires when a record
// is absent. So a unit blocked behind a quarantine that was later superseded and merged stayed
// blocked forever, invisible to arcSummary and undispatchable. 2026-07-18: four in-scope units
// stranded that way, and the root reset them by hand twice. Re-open at wave start whenever the
// blocking dependency is gone; ready() still holds them until it actually merges.
for (let changed = true; changed;) {
  changed = false
  for (const u of inScope) {
    const st = rec(u.id)?.status
    // `deferred` on an in-scope unit is always stale: it was stamped when the unit was out of
    // scope (or transiently withheld) and the plan has since said otherwise.
    // `running`/`merge-ready` at wave START are crash residue — the script just started, so
    // nothing can actually be running. Without this reset the adopt guard in runUnit
    // (prior.units status running) was unreachable on a relaunch and crashed units stranded
    // exactly like the 'blocked' class this loop already heals: ready() requires 'pending',
    // and nothing ever restored it. Reset re-enters dispatch; setup then auto-adopts any
    // committed branch work (rung-3 recovery as documented, now actually mechanical).
    if (st === 'deferred' || st === 'running' || st === 'merge-ready' || (st === 'blocked' && !blockedBy(u))) {
      units.set(u.id, { status: 'pending' })
      log(`${u.id}: ${st === 'deferred' ? 'in scope again'
        : st === 'blocked' ? 'unblocked (dependency resolved)'
        : `crash residue (was ${st}) — committed work auto-adopts`} — re-entering dispatch`)
      changed = true
    }
  }
}

while (true) {
  for (const u of inScope.filter(ready)) {
    start(u)
  }
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
// Boundary phase — strictly after all merges and mirror advances (invariant 8). Skipped on a
// codex halt: the conductor early-returns this wave to the root regardless, and boundary
// spend against a halted wave buys nothing the relaunch's boundary won't.
// Owed jobs still run when the boundary is off — see runBoundary's owed-only mode. A codex halt
// still skips everything: the conductor early-returns that wave regardless.
if ((C.boundary !== 'off' || owed.length > 0) && !codexHalt) {
  phase('Boundary')
  await runBoundary().catch((e) => log(`boundary phase failed — continuing (${e?.message ?? e})`))
}
// Reconcile the GitHub issue projection from the final unit map (issue mode only; no-op otherwise).
// Best-effort observability — never gates, so a failure only logs/degrades and the wave still returns.
await syncIssues().catch((e) => log(`issue sync failed — continuing (${e?.message ?? e})`))
checkpoint()                                        // state.json reflects mirror + boundary
await checkpointChain
return serialize()
