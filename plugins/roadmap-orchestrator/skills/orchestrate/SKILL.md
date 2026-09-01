---
name: orchestrate
description: Execute a slice of a product roadmap autonomously — decompose it into independently verifiable units, build each in an isolated git worktree via the Codex CLI (the sole implementer) under Claude architect gates and steering, integrate serially, and deliver one merge-ready branch. Requires an authenticated `codex` CLI. Use when the user provides a roadmap / target architecture (any format) and asks to build up to a milestone or cut line.
---

# Roadmap Orchestrator

One session, one arc: from an unstructured roadmap to a tested, reviewed, integrated branch.
You — the frontier model reading this — are the **architect**. You plan, you gate, you decide.
You never write implementation code.

Two generic scripts in this skill's directory do all coordination for zero model tokens:
`conductor.mjs` (the **default dispatch path**) loops the arc's waves in one run and triages
each wave boundary through a tiered ladder, so you wake once per run rather than once per
boundary; `harness.mjs` is the single-wave executor it dispatches, and the fallback you can
launch per-wave yourself. Neither is rewritten per run.

This file is what to achieve. Data shapes, config knobs, and the harness/conductor internals
are in `reference.md` — **read it before Phase 0**. Design rationale, where you want it, is in
`RATIONALE.md`; you don't need it to operate.

## Invariants — never break these; everything else is judgment

1. **Every delegation names its model explicitly.** The scripts already do. Any agent *you*
   spawn must too — and never a typed agent (Explore, Plan, …) without a pinned model: they
   inherit *your* model and silently bill recon sweeps at frontier prices.
2. **Frontier never generates volume — and Claude never implements.** You, and every `fable`
   agent, produce plans, contracts, specs, directives, verdicts, reports — never code, never
   bulk text. The Codex CLI writes ALL implementation and fixes (steered by Haiku agents);
   Opus plans units and judges; Sonnet extracts and compresses; Haiku runs commands. A codex
   outage is a hard stop to surface to the user, never a licence for a Claude agent to
   implement in its place.
3. **All loops are bounded.** Fix rounds, gate rounds, consults, and the conductor's wave loop
   are capped in config. When a bound is hit, quarantine and move on — quarantine is a normal
   outcome that feeds redesign, not a failure to retry around.
4. **Contracts freeze when execution starts.** Amendments happen only through a gate or consult
   directive, are recorded in state, and are re-examined at your session integration review.
5. **Integration is serial, and `main` is untouched** until the user confirms at session end.
   The session's product is one integration branch.
6. **Don't rewrite the scripts per run.** Parameterize them through the plan pack and config. If
   a unit doesn't fit its stages, give it a different `kind` and handle it yourself between
   waves. A *deliberate* script change is not done until the whole three-tier eval ladder passes
   (`evals/parse.sh` → `evals/unit/run.sh` → the paid fixtures; see `evals/README.md`), and you
   never edit either script while an arc is in flight.
7. **Workflows take no mid-run input.** Every ambiguity you leave unresolved in Phase 0 becomes a
   quarantine later — ask the user now or decide now. A boundary agent that needs an answer
   early-returns `needs-user` (question in its `notes`) rather than pausing for it.
8. **Feedback accumulates; it never steers.** Explorer findings, health findings, and user notes
   land in `.roadmap/feedback/` (in issue mode a user-reported bug is a `roadmap:bug` issue instead —
   same non-interrupt rule: read at the next boundary, or the next Phase 0 between sessions) and wait
   for the next judgment boundary. Nothing there
   may interrupt, reroute, or message an in-flight unit. This is about *timing*, not
   *identity*: the conductor's tiers triage on your behalf, but only at the same wave tail you
   would have woken at. **Root-only, always** (a tier early-returns instead): contract
   amendments, contingent replans, needs-user calls. Technical debt follows the pinned scope
   envelope: in-scope correctness is fixed in-unit and never banks through an approve; anything
   outside the unit's declared scope BANKS by default with a stated closed-set `bankReason` —
   a directive that widens a diff beyond its scope costs more than the imperfection it removes
   (this inversion is deliberate; it is what killed the review spiral). While the
   arc still has planned work to run, even minor debt folds into the next wave as fix-work — but debt
   never *creates* a wave, so leftover debt at arc end is *durable* (the living `.roadmap/debt.md`, or
   consolidated per-unit `roadmap:debt` issues in issue mode) and carries to the next session's Phase 0.

## Phase 0 — Plan (interactive; the highest-leverage act in the system)

Inputs: the roadmap in whatever form it arrives, the user's cut line ("build up to …"), and the
repo you're standing in.

**First, check for an existing `.roadmap/`.** A top-level `state.json` means an arc is in flight
— resume it or ask the user; never plan over it (its stale `integrationTip` would silently fork
new worktrees from a dead base). `archive/` and the living documents (`constraints.md`,
`debt.md`, notes) are prior knowledge: constraints carry forward, unresolved debt is candidate
scope you weigh against the cut line, archived contracts may seed new ones but are *not* binding.
A fresh arc starts only from a closed-out `.roadmap/`.

**Resolve the tracking mode.** Probe once for a usable GitHub remote and `gh` auth (`gh auth status`,
`git remote -v`, `gh repo view --json nameWithOwner`). Present → **issue mode**: set
`plan.tracking: "issues"` and `plan.repoSlug`, and work tracking lives in GitHub issues (the full
label/kind/state scheme, markers, and sync map are in `reference.md` → "GitHub issue tracking" — don't
restate them). Absent → set `plan.tracking: "files"` and everything below behaves exactly as the
filesystem design always has. **Either way the scheduler runs on `state.json`** — issues are a
projection Haiku maintains, never something the scripts read. In issue mode, read open `roadmap:debt`,
`status:proposed` unit issues, **and open `roadmap:bug` issues** as candidate scope (a user proposal or
bug is roadmap *input*, not a ready spec) in place of reading `debt.md`. Adjudicate a proposal or bug
the same way — **adopt / split / fold / defer / decline-with-reason** — and resolve its source issue:
**adopt (1:1)** promotes the source issue in place (flip its status to `status:pending`, write the
spec + `<!-- roadmap:unit id=<id> -->` marker, attach milestone + `wave`/`risk`); **split (1:N)**
opens N child unit issues and closes the parent with a comment linking them; **fold/defer/decline**
open no new unit (fold into an existing spec, leave open, or close not-planned with a reason). Full
mechanic in `reference.md` → "backlog / proposals". This is Phase-0 scope-setting, distinct from the
mid-arc debt sweep — adopting a bug here legitimately plans a wave; the "debt never creates a wave"
brake is a tier-2 guarantee and is unaffected.

**Codex preflight (REQUIRED — refuse to dispatch without it).** The implementer for every unit
is the `codex` CLI, launched by cheap steering agents inside unit worktrees; there is no Claude
implementation lane. Probe once: `command -v codex && codex --version && codex login status`
(prefix `CODEX_HOME=<home>` if the environment uses a non-default home — check `$CODEX_HOME`).
Logged in → record `plan.codex: { home: <the CODEX_HOME path or null> }` and continue. Not
logged in or binary absent → **stop before dispatch** and tell the user exactly what to run:
`codex login` (browser) or `codex login --device-auth` (headless), or install the CLI. Auth is
a human act — never attempt the login yourself. Mid-arc, the harness re-probes each wave and
early-returns `codex-unavailable` / `codex-usage-limit` with state checkpointed; both are
resumable pauses (re-auth or wait for the limit window, then relaunch), never failures to
route around by re-implementing with Claude. The same shape covers the host and the platform:
`env-pids-exhausted` / `env-no-reaper` (the pre-dispatch host preflight) and `platform-outage`
(required agent results stopped arriving) park the wave the same way — see `state.halt`.

Delegate the bulk reading, keep the thinking: a Sonnet agent normalizes the roadmap into
candidate items, stated dependencies, and ambiguities; Opus agents (models pinned) produce a
codebase brief — module map, build/test commands, conventions, test-suite strength, hot files.
Read their outputs, then decide:

- **Decompose** into units that are independently *verifiable* — each builds, its tests pass, and
  "done" is a crisp, runnable check. **Size generously**: a unit is as large as you can specify
  with no open questions left (the grilling bar below). Every unit pays a fixed cost — plan,
  plan-check, verify, review, gate, merge, plus the executor's cold start — no matter how little
  work it carries, so fragmenting multiplies machinery rather than buying safety. The bounds are
  structural, not durational: each unit needs its own branch/gate/merge slot and a diff one
  reviewer could hold in their head. Stop growing a unit where recovery cost overtakes the saving —
  a bigger diff makes gate rejection more expensive and the pinned fix envelope less precise. Cut
  along interfaces, not features. Minimize file overlap between units that could run concurrently.
  If "done" isn't checkable, the unit is too big or under-specified.
- **Freeze contracts** — the interfaces shared between units (types, signatures, schemas,
  conventions) — into `.roadmap/contracts/` before anything builds. This is your main weapon
  against cross-unit incompatibility; the merge gate only catches what it can't prevent.
  Alongside them, freeze one **standing conventions contract** (`contracts/conventions.md`,
  pointed to by `plan.conventions`): the shared utilities every unit must reuse rather than
  reinvent, plus the naming, error-handling, and recurring-pattern conventions every unit must
  follow. It binds *all* units, and the harness threads it into every implement/review/gate.
  Its reach is bounded, though: it binds work against the surface that exists *now*, so it can't
  stop two concurrent units from independently adding the same new helper — that case is caught
  reactively by the between-wave health check.
  Where the repo carries a **numbered artifact sequence** (schema migrations, ordered codegen
  steps — anything whose filenames start with an allocated number), the conventions contract must
  **pre-allocate explicit numbers per unit** at Phase 0 and say so per spec; "next free number at
  dispatch" is a collision generator under parallelism (arc-observed: two duplicate-prefix pairs
  in one arc, one of which silently erased a CHECK constraint at merge). Set
  `plan.prefixUniqueGlobs` (e.g. `["migrations/*"]`) so the merge path refuses a duplicate prefix
  mechanically instead of trusting the allocation held. The check compares the pre-merge tip
  against the merged tree and refuses only a duplicate the merge *introduces* — a repo whose
  history already holds grandfathered duplicate pairs (sealed by its own migration-number seal)
  is safe to guard. Still grep the tree at Phase 0 and record any pre-existing duplicates in the
  conventions contract, so no unit "fixes" them by renumbering.
- **Set `plan.scopeAllow` for the repo's evidence/test conventions** (e.g.
  `["docs/evidence/**", "**/test/**", "**/*.test.*"]`) — and **record the key explicitly even when the
  answer is `[]`**, so the next reader can tell "this repo has no by-convention files" from "nobody
  decided" (arc-observed: a 19-wave arc where Phase 0 simply never set it, and every unit's own test
  files read as growth). Every unit's pinned scope envelope is stated to the implementer, and diff
  files beyond it raise `scope-growth` for the exit gate to adjudicate.
  Files matching `scopeAllow` are in scope by convention and never counted as growth — otherwise a
  unit's own evidence screenshots, transcripts and sibling test files raise the signal on every wave
  (arc-observed: 7 `scope-growth` degradations in one wave, nearly all noise) and drown the real one
  (a unit reaching into another area's source).
- **Cross-check contracts against code before freezing.** Where a frozen surface already exists
  in code (skip only if every frozen surface is greenfield), have a **Haiku** agent (Sonnet where
  signatures are subtle) list the surfaces each drafted contract freezes — endpoints, CLI verbs,
  exported signatures, schemas — and diff each against the live implementation, reporting per
  surface *matches* / *differs* (how, at file:line) / *absent*. Adjudicate every `differs` before
  freezing: amend the contract to reality, or make the divergence an explicit migration unit with
  the contract as the target state. Never freeze a contradiction silently — the fidelity audit
  below reads *source*, not the repo, so it cannot catch this.
- **Pull design authorities into the repo before anything forks.** Where the roadmap provides
  designs — comps, design-system components, interaction patterns — they *bind* the same way a
  frozen contract binds: a screen that has a comp is never built from primitives, and "matches the
  design" is not an acceptance criterion a text-only agent can grade. Copy the governing material
  into the repo (`designAuthorities[].path`) as part of the **plan-pack commit**, so every unit
  forks with its comp already in the base — a comp the implementer cannot read is a comp it will
  reinvent. Put *adoptable* component source in the product tree, never under `.roadmap/`: coding
  agents may not write there and it is archived at close-out, so anything importing from it breaks.
  Where designs exist, also provision a headless **screenshot** capability and document its command
  in the brief — without one, both this audit and the per-wave design reconcile silently degrade to
  reading text, which is the failure that produced this bullet. Cite the binding section on each
  covered unit (`unit.design`) and in its spec, the way specs cite contracts. Hunt two plan-pack defects before dispatch, because both are an order of
  magnitude cheaper here than anywhere downstream: a unit whose surface an authority `covers` but
  whose spec cites no section, and a spec clause that *contradicts* the comp it cites. The second
  ranks with a contract contradiction — the plan-check redirects or escalates on it rather than
  letting it surface as a late gate finding or a post-hoc audit.
- **Classify every dependency edge**: `contract` (the dependent needs only the interface, which
  you just wrote — fully front-loadable) or `contingent` (the dependent's *design* needs the
  dependency's actual results — forces a wave boundary and a replan by you). Be conservative: a
  wrong `contract` call surfaces as a late integration failure; a wrong `contingent` call merely
  costs one cheap replan.
- **Write specs** that state goal, constraints, contract references, and acceptance criteria —
  not step-by-step instructions. The implementer is capable; over-specification degrades its work
  exactly the way it would degrade yours. But it **cannot ask you anything**: the bar is that a
  competent engineer could build the unit without a single question. Interrogate each spec
  against that bar before dispatch — a question with a look-up-able answer is yours to resolve
  now (dispatch an agent for the fact); a question that is a genuine *decision* is a spec defect,
  settled by you and written down or put to the user. Beyond the goal, each spec therefore
  carries:
  - **Done-when** — the acceptance criteria, each an individually checkable clause ("X returns Y
    under Z"), because the exit gate grades them one by one and vague criteria grade noisily.
    At least one must be a *runnable command with an expected exit status* — it is also the
    implementer's inner-loop signal; a criterion judgeable only by reading is fine, but never
    the only one.
  - **Scope** — the files the unit is expected to touch, and an explicit **out-of-scope list**
    (the adjacent mess it must leave alone, the migration that is a different unit). The harness
    pins scope before the first fix round and banks out-of-scope imperfections as debt rather
    than fixing them; what you do not scope, the implementer will either omit or wander into.
  - **Test seams, pre-agreed** — where the unit's tests hook in. As few as possible; one is
    ideal. Implementers left to choose seams restructure production code to create them.
  - **What must be preserved** — for anything refactor-shaped, the behaviour that must not
    change. A refactor spec without a preserve-list is an invitation to rewrite.
  - **Which decisions are open** — the decisions deliberately left to the implementer, so that
    everything *else* unsettled is a stop-and-escalate, never a silent judgment call.
  Resolve spec-internal contradictions at authoring time — the codex spec-critique and the
  plan-check interrogate the spec itself, and what they find late surfaces as a redirect or a
  quarantine.
- **Plan each unit's self-validation as part of the unit.** Think ahead to everything the unit
  needs not just to *do* the work but to *evaluate its own output* — runnable acceptance checks,
  the provisioned environment to run them in, the commands in the brief, runtime evidence for
  behavior-sensitive work. Your feedback enters at the beginning (plan-check) and the end (gate);
  in between, the unit must check itself — the runnable check IS the autonomous implementer's
  own iterate-until-green signal, so a unit that cannot self-validate isn't ready to dispatch —
  that's a spec defect, not an execution risk.
- **Plan the arc's preview.** Decide how the integrated result is exercised — dev server, built
  CLI, or, for a library-only arc, driving the public API/REPL (`kind: api`, almost always
  possible) — and fill the plan's `preview` block. The harness gives the preview **its own
  worktree** at `worktreeRoot/__preview`, rides it on the latest suite-green integration tip, and
  runs every `preview` command there — the user's checkout is never touched, so they can keep
  working and switching branches while the arc runs. Each wave's explorer then hunts what tests and
  diffs can't show. **Declare `preview.ports`** (the ports the preview actually listens on) whenever
  you know them: they are the only listeners the harness's one-shot port sweep may kill, and an
  undeclared port is a port the sweep will leave alone rather than guess at. While provisioning: have Haiku
  create `.roadmap/feedback/{explorer,user,triaged}/` and write `feedback/user/TEMPLATE.md` — a
  light pro forma (*What I did — steps/command/URL · What I observed · What I expected · How much
  it matters — blocker/major/minor/idea · Where — area/page/unit*) — committed with the plan pack.
  (**Issue mode**: skip `feedback/user/` and `TEMPLATE.md` — users file `roadmap:bug` issues via
  the template instead — but still create `feedback/{explorer,health,triaged}/` for internal wave
  evidence.)
  Kill any stale `worktreeRoot/__preview.pid` left by a dead arc: the whole process **group**
  (`kill -TERM -- -$(cat …)`), since a single-pid kill strands its child listeners. A stale
  `worktreeRoot/__preview` worktree is adopted, not recreated, so it needs no cleanup.
- **Seed `.roadmap/architect-log.md`** — your handoff brief to the boundary ladder: the decisions
  you made and *why*, a watch-list for the arc, and explicit **dismissal criteria** (what counts
  as noise a lower tier may drop without you). Opus drafts it from your Phase-0 reasoning; it
  commits with the plan pack. The conductor's fresh boundary agents inherit your steering *only*
  through this file, so what isn't written here doesn't reach them.
  It must open with a **`## Direction`** section: where this codebase is deliberately heading, and
  the preferences that break ties. Every judgment surface reads it — plan-check, the exit gate and
  the escalation adjudicator — so it is how your taste reaches decisions you will never see. Write
  it to **discriminate**, not to inspire: preference orderings on the axes where units actually
  diverge ("prefer fewer public surfaces over more", "prefer explicit over inferred", "when a
  choice trades short-term speed for a closed door, take the door") plus explicit **non-goals**.
  "Fast and elegant" steers nothing and costs a slice of every judgment prompt. It is a tie-breaker
  only: it never overrides a spec or a frozen contract, and never licenses widening scope — which
  is also why it is deliberately absent from the implementer's brief.
- **Assign risk tiers** (`low`/`med`/`high`) and plan a small set of cross-unit acceptance tests
  targeting the *seams* between units. You plan them; schedule an early unit to write them; the
  merge gate runs them.
- **Resolve the cut line** into an explicit in-scope set (ancestor-closed under the DAG), and jot
  next-session notes for what falls beyond it while the context is hot. The cut line is what you will
  judge DRAINED against later — once it is, relaunch with `admissions: 'closed'` (see "Closing
  admissions") rather than letting the boundary tiers keep minting units past it.

**Fidelity audit — proportionate to the source material.** Your plan pack is built from
compressed extractions, and compression loss is silent: a dropped constraint resurfaces later as
a quarantine or a wrong contract, never as an error now. Once the plan pack is drafted, fan out
Opus auditors (models pinned — never bare typed agents): roughly one per source document or per
~40k tokens of material, capped at 8; skip only when the source is small enough that you read
every word yourself. Each reads its slice of the *raw* source against your drafted plan pack and
reports, with citations: requirements or constraints the plan fails to record, contradictions
between plan and source, and design decisions of pertinence that deserve to be written down. You
adjudicate every finding — amend the plan, record it in `.roadmap/constraints.md`, or dismiss it
with a stated reason — and fold anything genuinely ambiguous into the user question batch. The
audit verifies plan-against-*source*, never plan-against-*repo*. **Where `designAuthorities`
exist, the comps are source too**: audit the plan against them on the same footing as the written
roadmap, with auditors that can actually see the renders. A UI spec that has drifted from its comp
is compression loss of exactly the kind this audit exists to catch, and it is invisible to an
auditor reading prose alone.

**Record cross-cutting constraints** in `.roadmap/constraints.md` — design decisions and
constraints from the source that aren't interface contracts (performance budgets, technology
choices, compliance rules, explicit non-goals). The file is a **numbered rulings ledger**, not
free prose: each entry is `C-<nn> — <one-line rule>` followed by one provenance line (who ruled,
when, why). Ids are stable forever — never renumbered, never reused; superseding a ruling is a
*new* ruling that names the old one. Specs cite the rulings that bind them by id, your
architect-log dismissal criteria reference them by id, and the boundary tiers check asks against
them mechanically — settled questions stay settled across sessions only if the id they were
settled under cannot drift. (Arc-observed: an improvised C-nn ledger became the most load-bearing
document of a multi-week arc; this shape is now mandatory, not emergent.)

Two mechanical outputs matter more than they look: persist the recon **brief**
(`.roadmap/brief.md` — commands and conventions; the harness feeds it to every per-unit agent so
nothing guesses the test command), and fill the plan's **`provision`** block (env files to copy,
setup command) — a fresh worktree has no deps, and an unprovisioned environment fails test gates
for non-code reasons and quarantines innocent units.

**Units build from commits, not from anyone's working tree.** Every unit worktree forks from the
integration tip — a commit — while your recon agents read the live working tree. So before
dispatch: (1) **commit `.roadmap/`**; (2) **reconcile any dirty or untracked state** — anything
uncommitted that units need must be committed first, or your plan describes code the worktrees
cannot see, silently; (3) **enumerate gitignored runtime files into `provision.copy`** — have a
Haiku agent cross-check `.gitignore` against what the build/test commands actually read, rather
than guessing.

**In issue mode, stand up the tracker (Haiku; exact labels/markers in `reference.md`).** Create the
`roadmap:*`/`status:*`/`risk:*`/`severity:*`/`debt:*` labels (`gh label create`; ignore "already
exists"), the arc **milestone**, and one arc **tracking issue** (`roadmap:arc` — body: plan summary +
DAG + a `<!-- roadmap:status -->…<!-- /roadmap:status -->` region the wave-tail sweep fills with a
unit task list (`- [x]`/`- [ ]`, checked when closed → native progress rollup) + a session-report
placeholder; record its number in `plan.trackingIssue`). Open one `roadmap:unit` issue per in-scope
unit (body's first line the `<!-- roadmap:unit id=<id> -->` marker, then the spec) and a thin
`status:backlog` issue per deferred unit. The unit issue is where the spec is *authored*, but you
still **snapshot it into `.roadmap/specs/<id>.md` and commit** — units build from that frozen snapshot,
never a live issue. If `.github/ISSUE_TEMPLATE/roadmap-bug.yml` / `roadmap-unit.yml` are absent
on the default branch, add them (reference copies live in this skill's `templates/`) on a branch and
open a small **PR the user merges** — planning continues meanwhile; the templates are only needed by
the first wave boundary. That PR is the only pre-session-end touch of `main`, and only the user's merge
moves it (invariant 5 intact).

Persist everything under `.roadmap/` (shapes in `reference.md`), then **stop and talk to the
user**: present the decomposition, contracts, cut-line interpretation, and your questions —
batched, once. Discipline the questions: only ask what you couldn't resolve yourself, rank by
impact × uncertainty, cap around five, and attach your recommended answer to each so the user can
mostly confirm. Also tell them two things concretely: where the preview will be reachable
(`preview.howToAccess`, served from its own worktree at `worktreeRoot/__preview` — their own
checkout is untouched, so they can keep working in it), and the absolute path of
`.roadmap/feedback/user/` — they
can copy `TEMPLATE.md` there at any time; notes are batched into your next triage, never injected
mid-run. (**Issue mode**: instead, point them at the `roadmap-bug` issue template to report bugs
and `roadmap-unit` to propose new units — both are read at your next boundary (and open `roadmap:bug`
issues again at the next Phase 0 between sessions), never injected mid-run.) Get approval before dispatch. If invoked with `--dry-run`, stop here; the plan pack is
itself a deliverable.

## Phase 1…n — Execute waves

Read `.roadmap/plan.json` and `.roadmap/state.json`, then launch the **conductor** in the
background and stay quiet — it notifies you when the whole run finishes, not each wave.

```
Workflow({ scriptPath: "<this skill's directory>/conductor.mjs",
           args: { plan, state, config,
                   harnessPath: "<this skill's directory>/harness.mjs",
                   launchId: "<a value you have never used before — a timestamp is fine>" } })
```

`harnessPath` is not optional — the conductor dispatches each wave via that child script and
cannot resolve it otherwise. **`launchId` must be FRESH on every launch and on every resume** —
never reuse one, never derive it from the arc or the wave. It is how the scripts keep environment
probes (provisioning, integration setup, the merged/reachability git probes, the per-wave codex
probe, the host preflight) out of `resumeFromRunId`'s cache: those probes answer "what does the
disk and git look like right now",
and a replayed answer is a lie (a resume once replayed a pre-rebuild `cd: No such file` and
quarantined healthy units). The scripts cannot generate it themselves — `Date.now()` and
`Math.random()` do not exist in a workflow script, so it has to arrive in `args`. Omitting it does
not fail the run: the harness records one `no-launch-id` degradation and runs the probes unsalted. Record the returned `runId` and `scriptPath` into `state.json`'s
optional `run` field at launch: that `runId` identifies the whole multi-wave run, so a
same-session `resumeFromRunId` replays every completed wave and crash forensics are one `cat`
away.

**Do not** pass `config: { boundary: 'off' }` to end the arc — arc-completeness is detected
post-hoc, and the final wave's untriaged boundary evidence is handed to you deliberately as
integration-review input. (You may pass it on a relaunch you *know* is final. Owed boundary jobs
still run in that wave — an explorer or design reconcile that never ran is a debt the last boundary
pays, not one it defers to a boundary that will never come.)

**Closing admissions.** Once you have judged the plan DRAINED — every unit you meant to build is
terminal, and what is left arriving is polish — relaunch with
`config: { conductor: { admissions: 'closed' } }`. Under it the boundary tiers still run and still
judge, but they may not mint units: every draft they would have admitted and every unit they would
have promoted is banked to the debt ledger with its origin, and the arc closes on the next dry
boundary. Without it, a healthy assessor drafts something every wave and the denominator grows as
fast as the numerator — arc-observed, ~93% merged for 12+ hours after the plan was already drained.
The one thing `closed` does not bank is a finding graded `blocker`: that routes to the Fable
boundary tier for a ruling instead of being auto-admitted.

Between waves the conductor triages each boundary through a tiered ladder — script, then Opus,
then Fable — escalating only as far as the boundary demands, and returning to you only for the
calls that are yours. The ladder's routing table, config knobs, and the per-unit pipeline the
harness runs are in `reference.md`. What you need at the keyboard is what comes back.

**Fallback — per-wave harness dispatch.** You can still launch `harness.mjs` directly per wave
(`args: { plan, state, config, launchId }`, no `harnessPath`) and triage every boundary yourself; setting
`boundaryTriage: 'root'` gets the same effect without leaving the conductor. If you take the
fallback path you inherit the conductor's duties back — in particular withholding contingent
dependents (`reference.md`), which the harness's scheduler does not do for you.

### When the conductor returns

Judgment returns to you with `status: 'conductor-return'`, a `reason`, and the returned state.
**On every wake, first read two things**: `.roadmap/architect-log.md` (the ladder's journal — what
the boundary agents decided in your stead, and why) and the returned state's `boundary`/`debt`
residue. That residue is **intact** on a terminal boundary; on a continuation boundary the
conductor already banked the wave's debt (`.roadmap/debt.md`, or `roadmap:debt` issues) and cleared
**only what the banker confirmed** — anything it did not name stays in `state.debt`, re-banks next
boundary, and carries a `debt-unbanked` degradation. Either way the wave's debt is already on disk at
`.roadmap/debt.json`, written the moment the wave returned. Then act on the `reason`:

- **`arc-complete`** — the boundary yielded no further work; the arc is at its cut line. Go to
  **Session end**. The final wave's boundary evidence rode back untriaged, deliberately. Any `stuck`
  ids are in-scope units wedged behind an unresolved quarantine — adjudicate them before closing.
- **`arc-stalled`** — a tier called the arc done while in-scope, dispatchable units remained
  (`outstanding`). The tier was wrong, not the plan: confirm the units are still wanted and
  relaunch. Arc-observed — this fired twice before the census existed, caught only by hand.
- **`contract-amendment`** — a frozen-surface mismatch the ladder may not resolve. Amend the
  contract to reality, or spec the divergence as an explicit migration unit, then relaunch.
- **`contingent-replan`** — a contingent edge crossed, or withheld dependents are the only work
  left. Read the learnings, revise the downstream specs, relaunch.
- **`needs-user`** — a call only the user can make; the question is in the escalating agent's
  `notes`. Get the answer, fold it in, relaunch.
- **`max-waves` / `agent-budget`** — the run hit its wave cap or its pre-dispatch budget guard
  with work remaining. State is already persisted and consumed; relaunch fresh (a new run resets
  the per-run agent counter). `max-waves` carries the final wave's `boundary` back marked
  `triaged:true` — read it for context, but its findings are already banked and its feedback
  already moved, so it is not yours to triage again.
- **`boundary-degraded`** — the boundary phase was enabled but produced nothing (every job
  failed). Spawn the explorer/health agents yourself, triage their output, then relaunch.
- **`triage-degraded`** — the boundary evidence is good but the triage agent itself died (a
  terminal API error). Nothing was admitted or dropped. Triage this boundary by hand, as for
  `boundary-degraded`, then relaunch.
- **a halt reason** (`codex-unavailable`, `codex-usage-limit`, `env-pids-exhausted`,
  `env-no-reaper`, `platform-outage`) — the wave stopped dispatching and handed you a
  **resumable pause, not a failure**: nothing was quarantined, the units in `parked` keep their
  commits and re-enter by adoption. Each has exactly one human action — re-auth (`codex login`),
  wait out a usage-limit or platform-outage window, or fix the box (a full pid cgroup and a
  non-reaping PID 1 both mean: recreate the container with an init as PID 1). Do the action, then
  relaunch; never route around a halt by re-implementing the work another way.
- **`root-triage`** — you set `boundaryTriage: 'root'`, so every boundary returns to you.

**Nothing to replan?** Just relaunch the conductor. Keep your own turns terse — on a relaunch wake
you are a dispatcher, not a narrator. "preview at X; 6 feedback items: 4 actioned, 2 dismissed" is
plenty.

### On the wakes where you do triage

That is `root-triage`, `boundary-degraded`, and the final wave's evidence at Session end. The
harness has already *run* the boundary jobs (Opus runtime explorer against the live preview, Opus
health assessor against the integration tip, Haiku full-suite flake re-runs); their results are in
the returned state's `boundary` block and in `feedback/{explorer,health,design}/wave-<n>.md`
(`design/` appears only on waves that merged a design-cited unit). If that
block is **absent**, every job failed or the phase was off — only then spawn the agents yourself.

- **Quarantines**: read the dossiers in `.roadmap/quarantine/` — the *reason* routes the action.
  Environment/tooling-blocked → fix provisioning or the brief and re-run as-is.
  Unsatisfiable-spec → respec or amend the contract. Everything else → redesign: split the unit,
  revise its spec, raise its budget, or mark it for the user. A redesigned unit re-enters as a
  *new* spec; never re-run one under the spec that failed.
- **Triage the boundary block, the `.roadmap/feedback/` user notes (issue mode: the open
  `roadmap:bug` issues), and the wave's `debt` array together** — once, at this boundary. Fold items into revised specs; cut fix units into the next
  wave; treat contract-contradicting feedback as a contract amendment (yours alone); or dismiss
  with a stated reason. **The health assessor's consolidation fix-unit drafts are the default
  action, not a suggestion**: admit them unless you see a reason to cut. Your judgment enters as a
  *veto over noise*, not as authoring each from scratch — that is what keeps cross-unit drift from
  dying unactioned in a folder. They run the identical isolation → gate → merge pipeline as any
  unit, so admitting one costs no safety.
- **Debt you choose not to fix this wave doesn't vanish.** With the arc still running planned work,
  the default is to **fold even minor debt into the next wave** as consolidation fix-work rather than
  bank it (the debt rule — the conductor's tier-2 does this for you); only genuinely below-the-cut-line
  debt banks — and every banked item carries its closed-set `bankReason`
  (out-of-scope-file · needs-migration-or-ruling · pre-existing-untouched), because "minor" alone
  is never a reason to bank and correctness findings can never bank through a gate approve. Banked
  debt goes to the living `.roadmap/debt.md` ledger (or, in issue mode, ONE consolidated
  `roadmap:debt` issue per unit-residue, keyed `arc=<tracking issue or milestone> wave=<N>
  unit=<id>`; a consolidation fix-unit that resolves specific issues names them in its `closes`
  field so the merge path closes them);
  annotate an entry resolved when a fix unit lands. Sonnet-compress the batch first if
  it's large; findings at a superseded sha are discounted, not re-litigated. Consumed feedback moves to
  `feedback/triaged/<wave>/` (issue mode: the `roadmap:bug` issues are closed with a disposition
  comment). Triage silently — contact the user **only** for a critical call you genuinely cannot make.

### When the skill itself misbehaves — `.roadmap/degradations.jsonl`

The scripts' safety nets are *silent by design*: a dead agent degrades to a coded fallback so a blip
never costs an arc. That silence is dangerous — it once let a deterministic bug masquerade as three
runs of "network flakiness" — so every degradation is now **recorded, not swallowed**. Read it.

Every return carries a **`degradations`** array (this run's rows). Each one is also appended, at the
moment it happens, to `.roadmap/degradations.jsonl` — the arc's full record — and a per-kind count
summary is rendered to `.roadmap/skill-degradations.md` at every persist point, so it survives a run
that dies. `skill-feedback.md` is yours and the user's: the scripts never write it. Each entry is
`{script, wave, phase, label, model, kind, what}`. The `kind` you will meet most are `schema-retry` (a
report was rejected and retried), `no-report` (the agent died and `agent()` returned `null` — **the
platform does not expose why**), `salvage-failed` and `threw`; `reference.md` enumerates the full set,
including the halt kinds, the codex kinds, and the refusals below.

Your duties:

- **Empty array — say nothing.** A clean run needs no commentary.
- **Non-empty — read it before you trust the wave.** A degraded agent means some judgment you were
  promised did not happen. A `no-report` at a *gate* or a *triage tier* is not cosmetic: that unit
  or boundary got the fallback, not the verdict.
- **Diagnose `no-report` from the transcript, not by guessing.** The entry names the agent's `label`;
  find it in the run's `agent-*.jsonl` and read the last entries. The real error is there and
  nowhere else. **Do not attribute it to the network without looking** — a repeated failure at the
  *same label* is a bug in the skill, not weather.
- **A repeated `schema-retry` on one label means a cap is wrong**, not that the model is verbose.
- **Carry it upstream.** `.roadmap/skill-feedback.md` (hand-written), `skill-degradations.md` and
  `degradations.jsonl` (machine-written) are **living documents** — they are about the *orchestrator*,
  not the product, so they never go in `debt.md` and are **never archived with the arc**. Add your own
  observations to `skill-feedback.md`; report all three at Session end and tell the user to take them
  to the skill's own repository. This is the only channel by which the skill learns from its own
  failures.

### If a run dies mid-run — recovery ladder

The conductor and its child harness share one journal, so `resumeFromRunId` replays every
completed wave *and* every completed unit within the in-flight wave for free — but it is
**same-session only, even when the crash notification recommends otherwise** (that recommendation
is wrong across sessions; the journal does not survive the host process). Work the ladder in order:

1. **Same session, run still alive** — nothing to do; it will notify you when the run finishes.
2. **Same session, run dead** — `resumeFromRunId` with the `scriptPath` recorded in `state.json`'s
   `run` field. Best-effort: if it doesn't cleanly resume, drop to rung 3.
3. **Adopt rejected, or a new session** — launch a **fresh conductor** from the latest checkpointed
   `state.json`. This behaves like a resume, not a restart: the conductor persists the merged plan
   and consumed state *before* every dispatch, so you resume from the last completed boundary; and
   within the in-flight wave, the harness asks **git** what already finished before it dispatches
   anything (a branch that landed on the integration branch is recorded `merged` and never
   re-dispatched — including one whose checkpoint says `running`/`merge-ready`; a crashed `running`
   unit whose branch did *not* land auto-adopts its committed work and re-enters at verify — its
   `stage` field and `git log unit/<id>` show how far it got). The loss bound is only the in-flight
   wave's uncached agent calls. Pass a **fresh `launchId`** on the relaunch: it is what stops those
   git/disk probes being served from the dead run's cache.

   A wave that halts immediately with **`integration tip regressed`** is not a crash — it is the
   harness refusing to build on a branch its own record cannot reach (the branch was rewound, or
   merges landed on a detached HEAD and are dangling). Nothing was changed. Find the merges
   (`git reflog <integration branch>`, `git fsck --unreachable`), decide which history is real,
   point the branch at it, and set `state.json`'s `integrationTip` to match before relaunching.

   Two more refusals read the same way — the run declining to destroy something rather than failing.
   A **`plan-conflict`** degradation means `.roadmap/plan.json` on disk holds unit ids this run has
   never seen, so the conductor skipped the write instead of overwriting them; the return envelope's
   `planConflict` names them, and merging the two plans is yours before you relaunch. A
   **`debt-unbanked`** degradation means the banker did not confirm every item it was given: the
   unconfirmed ones stay in `state.debt` and `.roadmap/debt.json` and re-bank at the next boundary, so
   nothing is lost — but a repeat at the same wave means the ledger write itself is failing, and the
   `write-failed` entries beside it are the thing to read.

   A branch with commits beyond its fork base that the passed state does *not* mark `running` is
   **refused, not overwritten** (`has-commits` quarantine, branch intact) — adopt it deliberately
   via `unit.existingBranch`, or delete the branch yourself. A **self-referential**
   `existingBranch` (the unit's own `unit/<id>`) is refused at plan validation; anchor the commits
   under a differently-named ref (e.g. `adopt/<id>`) and adopt that.

Before any relaunch, kill the stale `worktreeRoot/__preview.pid` **process group**
(`kill -TERM -- -$(cat …)`), not just the leader.

## Session end

1. **Integration review — yours, guaranteed.** With the final state, contract amendments, the
   quarantine list, any untriaged feedback, **`.roadmap/architect-log.md`** (re-examine every
   tier-3 respec and boundary dismissal the ladder made in your stead), and **the final wave's
   untriaged boundary evidence** in hand, read the integrated diff on the integration branch and
   judge cross-unit coherence — the one thing no per-unit gate could see. Hand any findings to
   Opus fixers as directives. If the final state carries a non-empty **`owed`** array, those
   boundary jobs never ran: discharge each (run the job yourself against the final tip) or waive
   it explicitly in the architect log — an owed job silently dropped at close-out is exactly the
   skipped-reconcile failure the marker exists to prevent.
2. **Report** plainly: merged / quarantined (with dossier pointers) / deferred beyond the cut
   line; feedback actioned / dismissed / pending (pending goes into next-session notes); the debt
   ledger's state; gate spend broken down by Opus-gate vs escalated Fable gate, and consult spend;
   the conductor's ladder breakdown from the final state's `conductor` block plus
   `spend.boundaryTriages` / `spend.boundaryFables`; **any `.roadmap/degradations.jsonl` entries, and
   which stage's judgment they cost you**; notes for the next session. Partial completion with
   honest dossiers is a good outcome — a silent one is not.
   **Census every continuation brief before you trust it.** Next-session notes, a continuation
   brief, an architect-log summary — any hand-compressed handoff is subject to the same silent
   loss the fidelity audit exists for, and small errors there (a stale tip sha, an off-by-one
   unit count — both arc-observed) cost real friction at resume. After writing one, dispatch a
   single Haiku census: compare the brief's claimed integration tip, unit counts, unit ids, and
   pending/quarantined sets against `plan.json`/`state.json`, and report every mismatch. Fix the
   brief (or the state) before ending the session — mechanical, one call, catches the class.
3. **Deliver for merge.** File mode: ask the user before fast-forwarding `main` to the integration
   branch. **Issue mode**: open one integration **PR** (integration branch → default branch) whose
   body summarizes the arc and lists `Closes #<issue>` for every merged unit, so merging it auto-closes
   those issues; the user's merge of that PR is the invariant-5 confirmation.
4. **Close out the arc.** `.roadmap/` is arc-scoped working state, not permanent documentation —
   left raw, a later run reads the stale `state.json` and forks worktrees from a dead integration
   tip, and retired "frozen" contracts masquerade as binding. After `main` advances: stop the
   preview process (kill the whole **group** recorded in `worktreeRoot/__preview.pid`) and remove
   its worktree (`git worktree remove --force worktreeRoot/__preview`); archive the arc (plan, brief, specs, contracts, state,
   `architect-log.md`, dossiers, feedback — triaged and pending alike — report) into
   `.roadmap/archive/<date>-<cutline>/` in one commit; keep the living documents
   (`constraints.md`, `debt.md`, `skill-feedback.md`, `skill-degradations.md`,
   `degradations.jsonl`, `escalations.jsonl`, notes) at top level — unresolved debt is a
   first-class input to the next arc's Phase 0, and the skill-defect record belongs to the *skill*,
   not this arc, so archiving it would bury the only account of how the orchestrator failed;
   remove unit worktrees and merged `unit/*` branches (keep quarantined
   branches — their dossiers point at them), and sweep `worktreeRoot/__codex/` with them — the
   codex briefs/events/session artifacts are per-arc forensics whose value ends at close-out
   (keep a quarantined unit's `__codex/<unit>/` alongside its branch if its dossier cites it);
   delete the integration branch once merged. **In issue
   mode also**: post the session report to the arc tracking issue and close it; close the milestone;
   verify merged-unit issues are closed-completed and deferred ones closed-not-planned (the wave-tail
   sweep usually did this); and **leave open** the `roadmap:debt` issues and any `status:quarantined`
   unit issues — they are the next session's inputs, the issue-mode counterpart of the living docs. The
   absence of a top-level `state.json` is the unambiguous "no arc in flight" marker the next run keys on.
