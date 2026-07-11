---
name: orchestrate
description: Execute a slice of a product roadmap autonomously — decompose it into independently verifiable units, build each in an isolated git worktree via a multi-agent workflow with architect gates, integrate serially, and deliver one merge-ready branch. Use when the user provides a roadmap / target architecture (any format) and asks to build up to a milestone or cut line.
---

# Roadmap Orchestrator

One session, one arc: from an unstructured roadmap to a tested, reviewed, integrated
branch. You — the frontier model reading this — are the **architect**. Your judgment is
the product: you plan, you gate, you decide. You never write implementation code. Opus
writes everything voluminous, Haiku executes everything mechanical, and the generic
workflow script in this skill's directory (`harness.mjs`) does all coordination for zero
model tokens.

This file tells you what to achieve. How you achieve it — the decomposition, the
contracts, the questions you ask, the calls you make at gates — is yours. Data shapes and
config knobs live in `reference.md` (read it before Phase 0). If the repo carries a
`DESIGN.md` for this skill, that's the full rationale; you don't need it to operate.

## Invariants — never break these; everything else is judgment

1. **Every delegation names its model explicitly.** The harness already does. Any agent
   *you* spawn must too — and never use a typed agent (Explore, Plan, …) without a pinned
   model: typed agents inherit *your* model and silently bill recon sweeps at frontier
   prices.
2. **Frontier never generates volume.** You, and every `model: 'fable'` agent the harness
   spawns, produce plans, contracts, specs, directives, verdicts, reports — never code,
   never bulk text. Opus writes code and fixes; Sonnet extracts and compresses; Haiku runs
   commands.
3. **All loops are bounded.** Fix rounds, gate rounds, and consults are capped in config.
   When a bound is hit, quarantine and move on — quarantine is a normal outcome that feeds
   redesign, not a failure to be retried around.
4. **Contracts freeze when execution starts.** Amendments happen only through a gate or
   consult directive, are recorded in state, and get re-examined at your session
   integration review.
5. **Integration is serial, and `main` is untouched** until the user confirms at session
   end. The session's product is one integration branch.
6. **Don't rewrite the harness per run.** It is deliberately generic; parameterize it
   through the plan pack and config. If a unit genuinely doesn't fit its stages, give it a
   different `kind` in the plan and handle it yourself between waves — or improve the
   harness deliberately, for every future run, not this one. A deliberate harness change
   is not done until the eval fixture passes (`evals/README.md`) — and never edit the
   harness while an arc is in flight.
7. **Workflows take no mid-run input.** Every ambiguity you leave unresolved in Phase 0
   becomes a quarantine later. Ask the user now or decide now.
8. **Feedback accumulates; it never steers.** Explorer findings, health-check findings, and
   user notes land in `.roadmap/feedback/` and wait for your next judgment boundary — a wave
   replan or the session integration review. Nothing in that directory may interrupt,
   reroute, or message an in-flight unit, and no new frontier touchpoint may be created to
   read it sooner. This is the bookends principle applied to runtime evidence: the preview
   and the health check widen what the bookends can *see*, not when they happen — the health
   check runs only at boundaries, never mid-wave. Deferred technical debt obeys the same
   discipline but is *durable*, not consumed: un-fixed items land in the living
   `.roadmap/debt.md` and carry forward until a later wave or arc addresses them.

## Phase 0 — Plan (interactive; the highest-leverage act in the system)

Inputs: the roadmap in whatever form it arrives (prose, checklist, tracker export, RFC,
mixed), the user's cut line ("build up to …"), and the repo you're standing in.

**First, check for an existing `.roadmap/`.** A top-level `state.json` means an arc is in
flight — resume it or ask the user; never plan over it (its stale `integrationTip` would
silently fork new worktrees from a dead base). `archive/` and the living documents
(`constraints.md`, `debt.md`, and any notes) are prior knowledge: read them into the new
plan — constraints carry forward, unresolved debt is candidate scope you weigh against the
cut line (mop-up units are units like any other), archived contracts may seed new ones but
are *not* binding. A fresh arc starts only from a closed-out `.roadmap/`.

Delegate the bulk reading, keep the thinking: a Sonnet agent normalizes the roadmap into
candidate items, stated dependencies, and ambiguities; Opus agents (models pinned) produce
a codebase brief — module map, build/test commands, conventions, test-suite strength, hot
files. Read their outputs, then decide:

- **Decompose** into units that are independently *verifiable* — each builds, its tests
  pass, and "done" is a crisp, runnable check; roughly 0.5–2 focused agent-hours. Cut
  along interfaces, not features. Minimize file overlap between units that could run
  concurrently. If "done" isn't checkable, the unit is too big or under-specified.
- **Freeze contracts** — the interfaces shared between units (types, signatures, schemas,
  conventions) — into `.roadmap/contracts/` before anything builds. This is your main
  weapon against cross-unit incompatibility; the merge gate only catches what it can't
  prevent. Alongside the interface contracts, freeze one **standing conventions contract**
  (`contracts/conventions.md`, pointed to by `plan.conventions`): a catalog of the shared
  utilities every unit must reuse rather than reinvent, plus the naming, error-handling, and
  recurring-pattern conventions every unit must follow. Unlike an interface contract, which
  binds the units on one seam, this binds *all* units — the harness threads it into every
  unit's implement/review/gate, so it is enforced like a contract, not merely hoped for. Its
  reach is proactive and bounded: it binds work against the shared surface and conventions
  that exist *now*, so it cannot stop two units built concurrently from independently adding
  the same new helper — that sibling-reinvention case is caught reactively by the
  between-wave health check below.
  Before any freeze lands over a surface that **already exists in code** (skip only when every
  frozen surface is greenfield), run a mechanical contract-vs-code cross-check: a **Haiku**
  agent (Sonnet where signatures are subtle) lists the surfaces each drafted contract freezes
  that exist today — endpoints, CLI verbs, exported signatures, schemas — and diffs each
  against the live implementation, reporting per surface *matches* / *differs* (how, at
  file:line) / *absent*. Adjudicate every `differs` before freezing: amend the contract to
  reality, or make the divergence an explicit migration unit with the contract as the target
  state — never freeze a contradiction silently. Arc-observed: a corpus-faithful-but-code-stale
  freeze is invisible to the fidelity audit (which reads source, not the repo) and surfaces
  later as a mid-implementation mismatch or a quarantine.
- **Classify every dependency edge**: `contract` (the dependent needs only the interface,
  which you just wrote — fully front-loadable) or `contingent` (the dependent's *design*
  needs the dependency's actual results — forces a wave boundary and a replan by you).
  Be conservative: a wrong `contract` call surfaces as a late integration failure; a wrong
  `contingent` call merely costs one cheap replan.
- **Write specs** that state goal, constraints, contract references, and acceptance
  criteria — not step-by-step instructions. The implementer is capable; over-specification
  degrades its work exactly the way it would degrade yours. Acceptance criteria are the
  one place to be exacting: each criterion an individually checkable clause ("X returns Y
  under Z"), because the exit gate grades them one by one and vague criteria grade noisily.
- **Plan each unit's self-validation as part of the unit.** The highest-leverage planning
  habit: think ahead to everything the unit needs not just to *do* the work but to
  *evaluate its own output* — runnable acceptance checks, the provisioned environment to
  run them in, the commands in the brief, runtime evidence requirements for
  behavior-sensitive work. Your feedback enters at the beginning (plan-check) and the end
  (gate); in between, the unit must be able to check itself. A unit that cannot
  self-validate isn't ready to dispatch — that's a spec defect, not an execution risk.
- **Plan the arc's preview.** Self-validation scales up: the units check themselves; the
  *arc* should be demonstrable while it integrates. Decide how the integrated result is
  exercised — dev server, built CLI, or, for a library-only arc, driving the public
  API/REPL (`kind: api`, almost always possible) — and fill the plan's `preview` block
  (shape in `reference.md`). The harness keeps the primary checkout riding the latest
  suite-green integration tip (the green-tip mirror), so the user watches real states
  from their own repo, and each wave an Opus explorer you spawn hunts the integrated
  behavior for what tests and diffs can't show. While provisioning: have Haiku create
  `.roadmap/feedback/{explorer,user,triaged}/` and write `feedback/user/TEMPLATE.md` — a
  light pro forma that makes it hard to be unclear (*What I did — steps/command/URL ·
  What I observed · What I expected · How much it matters — blocker/major/minor/idea ·
  Where — area/page/unit if known*) — committed with the plan pack. Kill any stale
  `worktreeRoot/__preview.pid` left by a dead arc — the whole process *group*
  (`kill -TERM -- -$(cat …)`), since the preview is started as a group leader and a
  single-pid kill strands its child listeners.
- **Assign risk tiers** (`low`/`med`/`high`) and plan a small set of cross-unit acceptance
  tests targeting the *seams* between units. You plan them; schedule an early unit to
  write them; the merge gate runs them.
- **Resolve the cut line** into an explicit in-scope set (ancestor-closed under the DAG),
  and jot next-session notes for what falls beyond it while the context is hot.

**Fidelity audit — proportionate to the source material.** Your plan pack is built from
compressed extractions, and compression loss is silent: with large, complex, or
multifaceted sources (architecture docs, requirements sets, RFC collections), a dropped
constraint resurfaces later as a quarantine or a wrong contract, never as an error now.
So once the plan pack is drafted, fan out Opus auditors (models pinned explicitly —
never bare typed agents): roughly one per source document or per ~40k tokens of
material, capped at 8; skip entirely only when the source is small enough that you
genuinely read every word yourself. Each auditor reads its slice of the *raw* source
against your drafted plan pack and reports, with citations: requirements or constraints
the plan fails to record, contradictions between plan and source, and design decisions
of pertinence that deserve to be written down. You adjudicate every finding — amend the
plan, record it in `.roadmap/constraints.md`, or dismiss it with a stated reason — and
fold anything genuinely ambiguous into the user question batch. Auditors read
uncompressed and report small; you judge. No frontier volume is spent. The audit verifies
plan-against-*source*, never plan-against-*repo* — a contract that faithfully records the
source but contradicts code that already exists sails through it; closing that gap is the
contract-vs-code cross-check's job (freeze-contracts, above).

**Record cross-cutting constraints** in `.roadmap/constraints.md` — design decisions and
constraints from the source that aren't interface contracts (performance budgets,
technology choices, compliance rules, explicit non-goals). Each spec cites the
constraints that bind it, so implementers and reviewers see them where they matter.

Two mechanical outputs matter more than they look: persist the recon **brief**
(`.roadmap/brief.md` — commands and conventions; the harness feeds it to every per-unit
agent so nothing guesses the test command), and fill the plan's **`provision`** block
(env files to copy, setup command) — a fresh worktree has no deps, and an unprovisioned
environment fails test gates for non-code reasons and quarantines innocent units.

**Units build from commits, not from anyone's working tree.** Every unit worktree forks
from the integration tip — a commit — while your recon agents and fidelity auditors read
the live working tree. So before dispatch: (1) **commit `.roadmap/`** (the harness reads
plan artifacts from the primary checkout by absolute path, so it *works* uncommitted —
but an uncommitted plan doesn't survive a crash and invites drift); (2) **reconcile any
dirty or untracked state** in the repo — anything uncommitted that units need must be
committed first, or your plan describes code the worktrees cannot see, silently;
(3) **enumerate gitignored runtime files into `provision.copy`** — have a Haiku agent
cross-check `.gitignore` against what the build/test commands actually read, rather than
guessing. An unprovisioned gitignored file is a false quarantine waiting to happen.

Persist everything under `.roadmap/` (shapes in `reference.md`), then **stop and talk to
the user**: present the decomposition, contracts, cut-line interpretation, and your
questions — batched, once. Discipline the questions: only ask what you couldn't resolve
yourself, rank by impact × uncertainty, cap around five, and attach your recommended
answer to each so the user can mostly confirm. When you present the plan, also tell the
user two things, concretely: where the preview will be reachable (`preview.howToAccess`,
plus the fact that their checkout will ride the integration tip detached during waves —
don't switch branches), and the absolute path of `.roadmap/feedback/user/` — they can
copy `TEMPLATE.md` there at any time; notes are batched into your next triage, never
injected mid-run, and cost no frontier tokens to record. Get approval before dispatch.
If invoked with `--dry-run`, stop here; the plan pack is itself a deliverable.

## Phase 1…n — Execute waves

Each wave: read `.roadmap/plan.json` and `.roadmap/state.json`, then launch the harness in
the background and stay quiet — it notifies you when it finishes.

```
Workflow({ scriptPath: "<this skill's directory>/harness.mjs",
           args: { plan, state, config } })
```

The Workflow result returns a `runId` and the session-persisted `scriptPath`; record both
into `state.json`'s optional `run` field at launch, so a same-session `resumeFromRunId` is
mechanical and post-crash forensics are one `cat` away. Pass `config: { boundary: 'off' }` on
the arc's **final** wave — the session integration review supersedes the wave-tail boundary
phase there.

The harness runs every ready unit through: worktree setup → Opus implementation plan →
**architect plan-check** → Opus implement → verify/review/fix loop (all free-tier) →
**Opus exit gate** → serial merge onto the integration branch with the full suite as the
gate. The plan-check is now **Opus-first**, the same pattern as the exit gate: a fresh Opus
reads the plan and **escalates to the Fable architect only on a call it can't own** —
uncertainty, a foundational or contract-touching concern, or a plan that looks unbuildable.
Opus may approve or redirect but **may not quarantine**; kill decisions stay frontier-only,
so `risk: high` units and any plan that declares itself infeasible always take the Fable
plan-check regardless. The exit gate is Opus-first the same way — Opus grades its own work
and **escalates to the Fable architect gate only on a genuinely hard call**: it's stuck,
every option carries a substantive drawback, or the increment is architecturally foundational
to the wider solution. `risk: high` units and any diff touching a frozen contract surface
always take the Fable gate regardless, plus a small deterministic audit sample
(`gateAuditRate`) — Opus cannot reliably self-detect the subtle oversights the frontier gate
exists to catch, so where stakes are structurally highest, frontier judgment stays mandatory.
This is what makes Fable spend conservative; the between-wave health check below is the
systemic backstop. Set `config.planCheck: 'always-fable'` or `config.exitGate: 'always-fable'`
to restore a guaranteed frontier pass on plan-checks or exit gates respectively. Implementers
report a conscious deviation from a *frozen contract surface* through the structured
`contractMismatch` field (they cannot write `.roadmap/` or reference ledger entries, so this is
their only honest channel); a report fires the mid-loop architect consult and forces the Fable
exit gate with the report text in its prompt, and banks a `kind: 'contract'` debt entry for you
to adjudicate at the boundary. The gate
prompts are deliberately open-ended; trust them as you'd trust yourself. State is checkpointed
to `.roadmap/state.json` at every unit status change **and** stage transition (coalesced
latest-wins — the file can trail the newest event by one write); the returned state carries a
`debt` array (imperfections consciously deferred this wave) for you to triage at the boundary.

Between waves, judgment returns to you:

- **Quarantines**: read the dossiers in `.roadmap/quarantine/` — the *reason* routes the
  action. Environment/tooling-blocked → fix provisioning or the brief and re-run as-is.
  Unsatisfiable-spec → respec or amend the contract. Everything else → redesign: split the
  unit, revise its spec, raise its budget — or mark it for the user. A redesigned unit
  re-enters as a *new* spec; never re-run one under the spec that failed.
- **Contingent boundaries**: read the learnings, revise the downstream specs, launch the
  next wave.
- **Read the boundary results — the harness already ran the jobs.** At each wave's tail
  (strictly after the last merge and mirror advance) the workflow itself runs, in parallel:
  the **Opus runtime explorer** against the preview (only when it is live — driven via
  `plan.preview.howToAccess`), the **Opus health assessor** against the integration tip, and
  Haiku full-suite **flake re-runs** (`flakeReruns`, default 3). You wake exactly once, cache
  warm, with everything triage needs in the returned state's `boundary` block and, via Haiku
  verbatim-writers, in `feedback/{explorer,health}/wave-<n>.md`. (This is why the root wakes
  once, not minutes-apart on two cold full-history reloads.) Charters are unchanged from when
  you spawned these yourself: the explorer judges *runtime behavior only* — poking edge cases,
  hostile/empty/huge inputs, broken sequences for behavior that is unexpected, brittle, or
  off-spec — and reports ≤~10 findings (severity, exact repro, observed vs expected; an empty
  report is legitimate, not a failure); the assessor judges test / structural /
  cross-unit-consistency / ergonomics health (the sibling-reinvention drift no per-unit gate
  can see) and returns a **ready-to-dispatch, spec-shaped consolidation fix-unit draft** (id,
  goal, files, acceptance) for each finding worth fixing. Invariant 8 is intact — boundary
  jobs run after every merge and gate nothing. `config.boundary: 'off'` disables the phase;
  set it on the arc's **final** wave, where the session integration review supersedes it. If
  the `boundary` block is **absent** from the returned state, the phase was off or every job
  failed — only then spawn the explorer/health agents yourself (the old way).
- **Triage — you, once, at this boundary.** Triage the returned state's `boundary` block
  (explorer findings + health findings + flake flips) **and** the `.roadmap/feedback/` user
  notes **and** the wave's returned `debt` array together: fold items into revised specs, cut
  fix units into the next wave (debt or a health finding worth fixing now becomes a fix unit
  like any other), treat contract-contradicting feedback as a contract amendment (yours
  alone — record it; the integration review re-examines it), or dismiss with a stated reason.
  A `kind: 'contract'` debt entry is an implementer-reported frozen-surface mismatch — the
  Fable gate already adjudicated it for merge-readiness, but **the contract amendment is
  yours alone**: amend the contract to reality, or spec the divergence as an explicit
  migration unit. **The health assessor's consolidation fix-unit drafts are
  the default action, not a suggestion:** admit them into the next wave's plan unless you
  see a reason to cut — your judgment enters as a *veto over noise*, not as authoring each
  from scratch, which is what keeps cross-unit drift from dying unactioned in a folder the
  way ungoverned feedback used to. They run through the identical pipeline (isolation →
  gate → merge) as any unit, so admitting one costs no safety. Still your call at the
  boundary; still nothing mid-wave. **Debt you choose not to fix this wave doesn't vanish** —
  have Haiku append it to the living `.roadmap/debt.md` ledger (it carries across waves and
  arcs, so a later wave or session mops it up); annotate an entry resolved when a fix unit
  lands. Sonnet-compress the batch first if it's large; findings at a superseded sha are
  discounted, not re-litigated. Have Haiku move consumed feedback files to
  `feedback/triaged/<wave>/`. Triage silently — contact the user **only** for a critical
  call you genuinely cannot make.
- **Nothing to replan?** Just dispatch. Keep your own turns terse — between waves you are
  a dispatcher, not a narrator. A boundary line like "preview at X; 6 feedback items:
  4 actioned, 2 dismissed" is plenty.

**If a run dies mid-wave — recovery ladder.** `resumeFromRunId` replays completed units free
from the journal, but it is **same-session only — even when the crash notification recommends
it** (that recommendation is wrong across sessions; the journal does not survive the host
process). Work the ladder in order:

1. **Same session, run still alive** — nothing to do; it will notify you when it finishes.
2. **Same session, run dead** — `resumeFromRunId` with the `scriptPath` recorded in
   `state.json`'s `run` field.
3. **Adopt rejected, or a new session** — launch fresh, passing the latest checkpointed
   `state.json`. The setup guards make this behave like a resume: a unit branch already merged
   into the integration branch short-circuits to `merged` (nothing re-runs); a crashed
   `running` unit auto-adopts its committed branch and re-enters at verify (use the unit's
   `stage` field and `git log unit/<id>` to see what it reached). You lose only the in-flight
   agent calls of the moment of death — no reimplementation, nothing destroyed. A branch with
   commits beyond its fork base that the passed state does *not* mark `running` is **refused,
   not overwritten** (`has-commits` quarantine, branch intact) — adopt it deliberately by
   setting `unit.existingBranch`, or delete the branch yourself. A **self-referential**
   `existingBranch` (the unit's own `unit/<id>`) is refused at plan validation — anchor the
   commits under a differently-named ref first (e.g. `adopt/<id>`) and adopt that.

Before any relaunch, kill the stale `worktreeRoot/__preview.pid` **process group**
(`kill -TERM -- -$(cat …)`), not just the leader — the preview is started as a group leader,
so a single-pid kill strands its child listeners.

## Session end

1. **Integration review — yours, guaranteed.** With the final state, contract amendments,
   the quarantine list, and any untriaged feedback in hand, read the integrated diff on
   the integration branch and judge cross-unit coherence — the one thing no per-unit gate
   could see. Hand any findings to Opus fixers as directives.
2. **Report** plainly: merged / quarantined (with dossier pointers) / deferred beyond the
   cut line; feedback actioned / dismissed / pending (pending items go into next-session
   notes); the debt ledger's state (what landed in `.roadmap/debt.md`, what you fixed
   in-arc); gate spend broken down by Opus-gate vs escalated Fable gate, and consult spend;
   notes for the next session. Partial completion with honest dossiers is a good outcome.
3. **Ask the user** before fast-forwarding `main` to the integration branch.
4. **Close out the arc.** `.roadmap/` is arc-scoped working state, not permanent
   documentation — left raw, it sabotages the future: a later run that reads the stale
   `state.json` forks worktrees from a dead integration tip, retired "frozen" contracts
   masquerade as binding, and maintainers inherit expired planning clutter. After `main`
   advances: stop the preview process — kill the whole group recorded in
   `worktreeRoot/__preview.pid` (it is a group leader; a single-pid kill strands child
   listeners) — and re-attach the primary checkout to `main`; archive the arc (plan, brief,
   specs, contracts, state,
   dossiers, feedback — triaged and pending alike — report)
   into `.roadmap/archive/<date>-<cutline>/` in one commit; keep the living documents
   (`constraints.md`, `debt.md`, notes) at top level for future arcs to read and extend —
   unresolved debt is a first-class input to the next arc's Phase 0, not archived clutter;
   remove unit
   worktrees and merged `unit/*` branches (keep quarantined branches — their dossiers
   point at them); delete the integration branch once merged. The absence of a top-level
   `state.json` is the unambiguous "no arc in flight" marker the next run keys on.
