---
name: orchestrate
description: Execute a slice of a product roadmap autonomously — decompose it into independently verifiable units, build each in an isolated git worktree via a multi-agent workflow with architect gates, integrate serially, and deliver one merge-ready branch. Use when the user provides a roadmap / target architecture (any format) and asks to build up to a milestone or cut line.
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
2. **Frontier never generates volume.** You, and every `fable` agent, produce plans, contracts,
   specs, directives, verdicts, reports — never code, never bulk text. Opus writes code and
   fixes; Sonnet extracts and compresses; Haiku runs commands.
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
   land in `.roadmap/feedback/` and wait for the next judgment boundary. Nothing in that
   directory may interrupt, reroute, or message an in-flight unit. This is about *timing*, not
   *identity*: the conductor's tiers triage on your behalf, but only at the same wave tail you
   would have woken at. **Root-only, always** (a tier early-returns instead): contract
   amendments, contingent replans, needs-user calls. Deferred technical debt is *durable*, not
   consumed — un-fixed items land in the living `.roadmap/debt.md` and carry forward.

## Phase 0 — Plan (interactive; the highest-leverage act in the system)

Inputs: the roadmap in whatever form it arrives, the user's cut line ("build up to …"), and the
repo you're standing in.

**First, check for an existing `.roadmap/`.** A top-level `state.json` means an arc is in flight
— resume it or ask the user; never plan over it (its stale `integrationTip` would silently fork
new worktrees from a dead base). `archive/` and the living documents (`constraints.md`,
`debt.md`, notes) are prior knowledge: constraints carry forward, unresolved debt is candidate
scope you weigh against the cut line, archived contracts may seed new ones but are *not* binding.
A fresh arc starts only from a closed-out `.roadmap/`.

Delegate the bulk reading, keep the thinking: a Sonnet agent normalizes the roadmap into
candidate items, stated dependencies, and ambiguities; Opus agents (models pinned) produce a
codebase brief — module map, build/test commands, conventions, test-suite strength, hot files.
Read their outputs, then decide:

- **Decompose** into units that are independently *verifiable* — each builds, its tests pass, and
  "done" is a crisp, runnable check; roughly 0.5–2 focused agent-hours. Cut along interfaces, not
  features. Minimize file overlap between units that could run concurrently. If "done" isn't
  checkable, the unit is too big or under-specified.
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
- **Cross-check contracts against code before freezing.** Where a frozen surface already exists
  in code (skip only if every frozen surface is greenfield), have a **Haiku** agent (Sonnet where
  signatures are subtle) list the surfaces each drafted contract freezes — endpoints, CLI verbs,
  exported signatures, schemas — and diff each against the live implementation, reporting per
  surface *matches* / *differs* (how, at file:line) / *absent*. Adjudicate every `differs` before
  freezing: amend the contract to reality, or make the divergence an explicit migration unit with
  the contract as the target state. Never freeze a contradiction silently — the fidelity audit
  below reads *source*, not the repo, so it cannot catch this.
- **Classify every dependency edge**: `contract` (the dependent needs only the interface, which
  you just wrote — fully front-loadable) or `contingent` (the dependent's *design* needs the
  dependency's actual results — forces a wave boundary and a replan by you). Be conservative: a
  wrong `contract` call surfaces as a late integration failure; a wrong `contingent` call merely
  costs one cheap replan.
- **Write specs** that state goal, constraints, contract references, and acceptance criteria —
  not step-by-step instructions. The implementer is capable; over-specification degrades its work
  exactly the way it would degrade yours. Acceptance criteria are the one place to be exacting:
  each an individually checkable clause ("X returns Y under Z"), because the exit gate grades
  them one by one and vague criteria grade noisily. Resolve spec-internal contradictions at
  authoring time — the plan-check interrogates the spec itself, and what it finds late surfaces
  as a redirect or a quarantine.
- **Plan each unit's self-validation as part of the unit.** Think ahead to everything the unit
  needs not just to *do* the work but to *evaluate its own output* — runnable acceptance checks,
  the provisioned environment to run them in, the commands in the brief, runtime evidence for
  behavior-sensitive work. Your feedback enters at the beginning (plan-check) and the end (gate);
  in between, the unit must check itself. A unit that cannot self-validate isn't ready to
  dispatch — that's a spec defect, not an execution risk.
- **Plan the arc's preview.** Decide how the integrated result is exercised — dev server, built
  CLI, or, for a library-only arc, driving the public API/REPL (`kind: api`, almost always
  possible) — and fill the plan's `preview` block. The harness keeps the primary checkout riding
  the latest suite-green integration tip, so the user watches real states from their own repo and
  each wave's explorer hunts what tests and diffs can't show. While provisioning: have Haiku
  create `.roadmap/feedback/{explorer,user,triaged}/` and write `feedback/user/TEMPLATE.md` — a
  light pro forma (*What I did — steps/command/URL · What I observed · What I expected · How much
  it matters — blocker/major/minor/idea · Where — area/page/unit*) — committed with the plan pack.
  Kill any stale `worktreeRoot/__preview.pid` left by a dead arc: the whole process **group**
  (`kill -TERM -- -$(cat …)`), since a single-pid kill strands its child listeners.
- **Seed `.roadmap/architect-log.md`** — your handoff brief to the boundary ladder: the decisions
  you made and *why*, a watch-list for the arc, and explicit **dismissal criteria** (what counts
  as noise a lower tier may drop without you). Opus drafts it from your Phase-0 reasoning; it
  commits with the plan pack. The conductor's fresh boundary agents inherit your steering *only*
  through this file, so what isn't written here doesn't reach them.
- **Assign risk tiers** (`low`/`med`/`high`) and plan a small set of cross-unit acceptance tests
  targeting the *seams* between units. You plan them; schedule an early unit to write them; the
  merge gate runs them.
- **Resolve the cut line** into an explicit in-scope set (ancestor-closed under the DAG), and jot
  next-session notes for what falls beyond it while the context is hot.

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
audit verifies plan-against-*source*, never plan-against-*repo*.

**Record cross-cutting constraints** in `.roadmap/constraints.md` — design decisions and
constraints from the source that aren't interface contracts (performance budgets, technology
choices, compliance rules, explicit non-goals). Each spec cites the constraints that bind it.

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

Persist everything under `.roadmap/` (shapes in `reference.md`), then **stop and talk to the
user**: present the decomposition, contracts, cut-line interpretation, and your questions —
batched, once. Discipline the questions: only ask what you couldn't resolve yourself, rank by
impact × uncertainty, cap around five, and attach your recommended answer to each so the user can
mostly confirm. Also tell them two things concretely: where the preview will be reachable
(`preview.howToAccess`, plus the fact that their checkout will ride the integration tip detached
during waves — don't switch branches), and the absolute path of `.roadmap/feedback/user/` — they
can copy `TEMPLATE.md` there at any time; notes are batched into your next triage, never injected
mid-run. Get approval before dispatch. If invoked with `--dry-run`, stop here; the plan pack is
itself a deliverable.

## Phase 1…n — Execute waves

Read `.roadmap/plan.json` and `.roadmap/state.json`, then launch the **conductor** in the
background and stay quiet — it notifies you when the whole run finishes, not each wave.

```
Workflow({ scriptPath: "<this skill's directory>/conductor.mjs",
           args: { plan, state, config,
                   harnessPath: "<this skill's directory>/harness.mjs" } })
```

`harnessPath` is not optional — the conductor dispatches each wave via that child script and
cannot resolve it otherwise. Record the returned `runId` and `scriptPath` into `state.json`'s
optional `run` field at launch: that `runId` identifies the whole multi-wave run, so a
same-session `resumeFromRunId` replays every completed wave and crash forensics are one `cat`
away.

**Do not** pass `config: { boundary: 'off' }` to end the arc — arc-completeness is detected
post-hoc, and the final wave's untriaged boundary evidence is handed to you deliberately as
integration-review input. (You may pass it on a relaunch you *know* is final.)

Between waves the conductor triages each boundary through a tiered ladder — script, then Opus,
then Fable — escalating only as far as the boundary demands, and returning to you only for the
calls that are yours. The ladder's routing table, config knobs, and the per-unit pipeline the
harness runs are in `reference.md`. What you need at the keyboard is what comes back.

**Fallback — per-wave harness dispatch.** You can still launch `harness.mjs` directly per wave
(`args: { plan, state, config }`, no `harnessPath`) and triage every boundary yourself; setting
`boundaryTriage: 'root'` gets the same effect without leaving the conductor. If you take the
fallback path you inherit the conductor's duties back — in particular withholding contingent
dependents (`reference.md`), which the harness's scheduler does not do for you.

### When the conductor returns

Judgment returns to you with `status: 'conductor-return'`, a `reason`, and the returned state.
**On every wake, first read two things**: `.roadmap/architect-log.md` (the ladder's journal — what
the boundary agents decided in your stead, and why) and the returned state's `boundary`/`debt`
residue. That residue is **intact** on a terminal boundary; on a continuation boundary the
conductor already banked debt to `.roadmap/debt.md` and cleared it. Then act on the `reason`:

- **`arc-complete`** — the boundary yielded no further work; the arc is at its cut line. Go to
  **Session end**. The final wave's boundary evidence rode back untriaged, deliberately.
- **`contract-amendment`** — a frozen-surface mismatch the ladder may not resolve. Amend the
  contract to reality, or spec the divergence as an explicit migration unit, then relaunch.
- **`contingent-replan`** — a contingent edge crossed, or withheld dependents are the only work
  left. Read the learnings, revise the downstream specs, relaunch.
- **`needs-user`** — a call only the user can make; the question is in the escalating agent's
  `notes`. Get the answer, fold it in, relaunch.
- **`max-waves` / `agent-budget`** — the run hit its wave cap or its pre-dispatch budget guard
  with work remaining. State is already persisted and consumed; relaunch fresh (a new run resets
  the per-run agent counter) with nothing to triage.
- **`boundary-degraded`** — the boundary phase was enabled but produced nothing (every job
  failed). Spawn the explorer/health agents yourself, triage their output, then relaunch.
- **`triage-degraded`** — the boundary evidence is good but the triage agent itself died (a
  terminal API error). Nothing was admitted or dropped. Triage this boundary by hand, as for
  `boundary-degraded`, then relaunch.
- **`root-triage`** — you set `boundaryTriage: 'root'`, so every boundary returns to you.

**Nothing to replan?** Just relaunch the conductor. Keep your own turns terse — on a relaunch wake
you are a dispatcher, not a narrator. "preview at X; 6 feedback items: 4 actioned, 2 dismissed" is
plenty.

### On the wakes where you do triage

That is `root-triage`, `boundary-degraded`, and the final wave's evidence at Session end. The
harness has already *run* the boundary jobs (Opus runtime explorer against the live preview, Opus
health assessor against the integration tip, Haiku full-suite flake re-runs); their results are in
the returned state's `boundary` block and in `feedback/{explorer,health}/wave-<n>.md`. If that
block is **absent**, every job failed or the phase was off — only then spawn the agents yourself.

- **Quarantines**: read the dossiers in `.roadmap/quarantine/` — the *reason* routes the action.
  Environment/tooling-blocked → fix provisioning or the brief and re-run as-is.
  Unsatisfiable-spec → respec or amend the contract. Everything else → redesign: split the unit,
  revise its spec, raise its budget, or mark it for the user. A redesigned unit re-enters as a
  *new* spec; never re-run one under the spec that failed.
- **Triage the boundary block, the `.roadmap/feedback/` user notes, and the wave's `debt` array
  together** — once, at this boundary. Fold items into revised specs; cut fix units into the next
  wave; treat contract-contradicting feedback as a contract amendment (yours alone); or dismiss
  with a stated reason. **The health assessor's consolidation fix-unit drafts are the default
  action, not a suggestion**: admit them unless you see a reason to cut. Your judgment enters as a
  *veto over noise*, not as authoring each from scratch — that is what keeps cross-unit drift from
  dying unactioned in a folder. They run the identical isolation → gate → merge pipeline as any
  unit, so admitting one costs no safety.
- **Debt you choose not to fix this wave doesn't vanish** — have Haiku append it to the living
  `.roadmap/debt.md` ledger; annotate an entry resolved when a fix unit lands. Sonnet-compress the
  batch first if it's large; findings at a superseded sha are discounted, not re-litigated. Have
  Haiku move consumed feedback to `feedback/triaged/<wave>/`. Triage silently — contact the user
  **only** for a critical call you genuinely cannot make.

### When the skill itself misbehaves — `.roadmap/skill-feedback.md`

The scripts' safety nets are *silent by design*: a dead agent degrades to a coded fallback so a blip
never costs an arc. That silence is dangerous — it once let a deterministic bug masquerade as three
runs of "network flakiness" — so every degradation is now **recorded, not swallowed**. Read it.

Every return carries a **`degradations`** array (also in the state, and rendered to
`.roadmap/skill-feedback.md` at every persist point, so it survives a run that dies): each entry is
`{script, wave, phase, label, model, kind, what}`, where `kind` is `schema-retry` (a report was
rejected and retried), `no-report` (the agent died and `agent()` returned `null` — **the platform
does not expose why**), `salvage-failed`, or `threw`.

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
- **Carry it upstream.** `.roadmap/skill-feedback.md` is a **living document** — it is about the
  *orchestrator*, not the product, so it never goes in `debt.md` and is **never archived with the
  arc**. Report it at Session end and tell the user to take it to the skill's own repository. This
  is the only channel by which the skill learns from its own failures.

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
   within the in-flight wave, the harness's setup guards short-circuit work already done (a merged
   unit branch short-circuits to `merged`; a crashed `running` unit auto-adopts its committed
   branch and re-enters at verify — its `stage` field and `git log unit/<id>` show how far it got).
   The loss bound is only the in-flight wave's uncached agent calls.

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
   Opus fixers as directives.
2. **Report** plainly: merged / quarantined (with dossier pointers) / deferred beyond the cut
   line; feedback actioned / dismissed / pending (pending goes into next-session notes); the debt
   ledger's state; gate spend broken down by Opus-gate vs escalated Fable gate, and consult spend;
   the conductor's ladder breakdown from the final state's `conductor` block plus
   `spend.boundaryTriages` / `spend.boundaryFables`; **any `.roadmap/skill-feedback.md` entries, and
   which stage's judgment they cost you**; notes for the next session. Partial completion with
   honest dossiers is a good outcome — a silent one is not.
3. **Ask the user** before fast-forwarding `main` to the integration branch.
4. **Close out the arc.** `.roadmap/` is arc-scoped working state, not permanent documentation —
   left raw, a later run reads the stale `state.json` and forks worktrees from a dead integration
   tip, and retired "frozen" contracts masquerade as binding. After `main` advances: stop the
   preview process (kill the whole **group** recorded in `worktreeRoot/__preview.pid`) and
   re-attach the primary checkout to `main`; archive the arc (plan, brief, specs, contracts, state,
   `architect-log.md`, dossiers, feedback — triaged and pending alike — report) into
   `.roadmap/archive/<date>-<cutline>/` in one commit; keep the living documents
   (`constraints.md`, `debt.md`, `skill-feedback.md`, notes) at top level — unresolved debt is a
   first-class input to the next arc's Phase 0, and `skill-feedback.md` belongs to the *skill*, not
   this arc, so archiving it would bury the only record of how the orchestrator failed;
   remove unit worktrees and merged `unit/*` branches (keep quarantined
   branches — their dossiers point at them); delete the integration branch once merged. The absence
   of a top-level `state.json` is the unambiguous "no arc in flight" marker the next run keys on.
