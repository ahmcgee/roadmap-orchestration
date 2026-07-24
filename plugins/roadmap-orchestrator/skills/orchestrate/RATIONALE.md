# Roadmap Orchestrator — Rationale

Why the skill is shaped the way it is. **Nothing loads this file at runtime.** It exists so
`SKILL.md` and `reference.md` can be lean: those two are read into the architect's context on
every arc, and every token of justification in them is a token of attention taken from the
instructions that actually drive behaviour. Rationale earns its place in a loaded file only when
it changes a judgment the reader actually makes — otherwise it lives here.

(The repo's `DESIGN.md`, which does not ship with the plugin, remains the long-form design record.
This file is the shipped subset: the reasoning a maintainer needs to change the skill safely.)

---

## 1. Why the architect never writes code

The frontier model's judgment is the scarce resource; its output tokens are the expensive one. The
whole economic contract (`reference.md`, model tiers) falls out of one rule: **frontier never
generates volume.** Plans, contracts, specs, directives, verdicts, reports — never code, never bulk
text. Opus writes everything voluminous; Sonnet extracts and compresses; Haiku runs commands.

The corollary that catches people: a *typed* agent (Explore, Plan, …) spawned without a pinned model
inherits the main-loop model. A recon sweep that should have cost Haiku pennies silently bills at
frontier prices. Hence invariant 1 — every delegation names its model explicitly, no exceptions.

## 2. Why the conductor exists

Before it, the architect woke at every wave boundary. Each wake past the 5-minute prompt-cache TTL is
an **uncached full-history reload** — the single most expensive recurring event in a long arc. The
conductor loops the waves inside one Workflow run and triages boundaries itself, so the root wakes
once per *run*.

That is also why `SKILL.md` and `reference.md` were cut down (v0.6): the conductor attacked the cost
on the *frequency* axis; shrinking the root's context attacks the same cost on the *size* axis. They
multiply.

The conductor was deliberately added as **generic, arc-adjacent tooling** rather than bolted onto one
run — the worked example of invariant 6. A script you rewrite per run is a script whose regressions
nobody catches.

## 3. Invariant 8 — feedback accumulates, never steers

The rule is about **timing, not identity**. What it forbids is triage *reaching a running unit* or
happening *mid-wave*. It does not forbid someone other than the root performing that triage.

That distinction is what licenses the tiered ladder. The tiers stand in for the architect at the
boundary, but they fire only at the same wave tail the architect would have woken at — the boundary
doesn't move, and no touchpoint is added. Because tier 3 fires only on escalation, the net frontier
touchpoints per boundary go *down*, not up.

This is the **bookends principle** applied to runtime evidence: the architect's feedback enters at the
beginning (plan-check) and the end (gate); in between, the unit must be able to check itself. The
preview and the health check widen what the bookends can *see*, not when they happen.

What never delegates, and always early-returns to the root: **contract amendments, contingent
replans, needs-user calls.** The ladder's reach is bounded by the dismissal criteria the architect
writes into `architect-log.md` at Phase 0 — that file is the *only* channel by which the architect's
steering reaches a fresh boundary agent.

Debt is the exception to "feedback is consumed": it is **durable**. Un-fixed items land in
`debt.md` and carry across waves *and arcs*, because an imperfection nobody chose to fix is not an
imperfection that stopped existing.

## 4. Opus-first gates — the economics and their limit

Fable is the metered tier, so Opus grades first everywhere and escalates only on a genuinely hard
call. The **plan-check** and the **exit gate** both work this way.

The rationale has a sharp limit that must not be forgotten when tuning:

> Opus can reliably self-assess **decision hardness and stakes** — "this is a hard trade-off", "this
> is architecturally foundational", "I am stuck". It **cannot** reliably self-detect **hidden
> correctness oversights it doesn't know it made.**

That is the exact reason the gate was once guaranteed-frontier. So the guaranteed Fable pass is
retained precisely where those oversights are most costly — `risk: high` and contract-touching diffs
— plus a deterministic **audit sample** (`gateAuditRate`) as an anti-rubber-stamping check, and the
between-wave **health check** as the systemic backstop for what slips through per-unit.

Opus may approve or redirect, but **may never quarantine**. Kill decisions stay frontier-only. An
infeasible plan (`feasible:false`) must route to Fable and may never be killed *or* waved through by
Opus alone.

**Arc-observed (the plan-check charter refocus).** In one live arc, 11 plan-checks never once fired
on *plan plausibility* — but they approved past **spec-internal contradictions** that the implementer
then had to reconcile ad hoc mid-build. The failure was a charter gap, not a coverage gap. So both
plan-check variants were refocused to interrogate the **spec** as hard as the plan: contradictions
within the spec, clauses contradicting a referenced contract or documented codebase reality, and
stale premises. A spec defect is not the engineer's to absorb.

**Spend direction when tuning.** Extra frontier budget goes to the **planning side** (spec detail,
plan-checks, Phase-0 interrogation), never to more mid-flight touchpoints. Gate non-convergence is
evidence of an under-specified plan, and the fix is a better plan. Frontier *saved* at the Opus-first
gate is simply saved — not redirected into new mid-flight touchpoints.

## 5. Contracts: the fidelity audit and the code cross-check

Two different failure modes, two different guards, and they do not overlap:

- **Plan-vs-source drift.** The plan pack is built from *compressed extractions*, and compression loss
  is silent — a dropped constraint resurfaces later as a quarantine or a wrong contract, never as an
  error now. Guard: the **fidelity audit** (Opus auditors reading the *raw* source against the drafted
  plan). Auditors read uncompressed and report small; the architect judges. No frontier volume spent.
- **Plan-vs-code drift.** A contract can be perfectly faithful to the source and still contradict code
  that already exists. **The fidelity audit is blind to this** — it reads source, not the repo. Guard:
  the **contract-vs-code cross-check** (Haiku/Sonnet diffing each frozen surface against the live
  implementation). *Arc-observed*: a corpus-faithful-but-code-stale freeze sailed through the audit and
  surfaced later as a mid-implementation mismatch and a quarantine.

Never freeze a contradiction silently. Amend the contract to reality, or make the divergence an
explicit migration unit with the contract as the target state.

**Why `contract` vs `contingent` edges are called conservatively:** the errors are asymmetric. A wrong
`contract` call surfaces as a *late integration failure*; a wrong `contingent` call merely costs one
cheap replan. When in doubt, choose `contingent`.

## 6. The conventions contract — proactive, and bounded

`contracts/conventions.md` binds *all* units (unlike an interface contract, which binds two units on
one seam): the shared utilities every unit must reuse rather than reinvent, plus naming, error-handling
and pattern conventions. The harness threads it into every implement/review/gate, so it is *enforced*,
not merely hoped for.

Its reach is bounded and it is important to know where it stops: it binds work against the shared
surface that exists **now**. It therefore **cannot** stop two units built concurrently from
independently adding the same *new* helper — siblings never see each other. That sibling-reinvention
case is caught **reactively**, by the between-wave health check's cross-unit-consistency charter. The
two mechanisms are complements, not redundancy.

## 7. The health assessor is empowered, not advisory

Findings that land in a folder and wait for someone to author a fix unit **die in that folder**. So the
assessor returns a *ready-to-dispatch consolidation fix-unit draft* (id, goal, files, acceptance) for
each finding worth fixing, and those drafts **default into the next wave** unless the architect cuts
them. The architect's judgment enters as a **veto over noise**, not as authoring each fix from scratch.

This does not weaken invariant 8: drafts gate nothing mid-wave, reach no running unit, and are admitted
only at the boundary the architect already owns. They run the identical isolation → gate → merge
pipeline as any unit, so admitting one costs no safety.

**The convergence brake (arc-observed).** A *healthy* assessor drafts something every wave — that is
what a good assessor does. An admit-by-default triage with no brake therefore extends the arc forever;
one live run admitted fresh test-ergonomics drafts on waves 3, 4 and 5 and returned `max-waves`. The
fix is in the tier-2 triager's prompt: **the cut line binds the default.** Once the plan's own units are
merged, a draft must justify a *wave*, not merely be an improvement — refactors without a defect,
ergonomics polish, and marginal coverage on a healthy suite are noise to cut *even though they are
real*. They bank to the debt ledger instead, so nothing is lost, and the triager sets `arcComplete`. An
arc that never dries is a failure mode, not diligence.

## 8. Why the final wave's boundary is never suppressed

It is tempting to have the conductor predict finality and set `boundary: 'off'` on the last wave. It
must not. **Health fix-units are what extend arcs** — so peeking ahead would suppress the health check
on exactly the single-wave arcs where drift is likeliest. Arc-completeness is therefore detected
**post-hoc**: a boundary that yields no new work returns `arc-complete`, and the final wave's untriaged
boundary evidence is handed to the root deliberately, as better-informed integration-review input.

The root may still pass `boundary: 'off'` explicitly on a relaunch it *knows* is final.

## 9. Prompt-authoring rules for the scripts

The per-agent prompts in `harness.mjs` / `conductor.mjs` are terse for a reason, and the reasons differ
by tier:

- **The agent is not the maintainer.** Never explain in a prompt *why the prompt says what it says*.
  "arc-observed:" / "eval-observed:" notes belong in **code comments**, addressed to the next person
  editing the script — not in the prompt string, where they consume the agent's attention without
  changing its behaviour. (Two such parentheticals were removed in v0.6.)
- **Haiku prompts are where length actually hurts.** A mechanical agent given a long prompt will lose
  the load-bearing clause in the middle of it. Observed: repeating the long pidfile path buried the
  `STRICT` preamble's `cd` target. Name a path once, then use pronouns.
- **Fail-loud beats adaptive, for mechanical agents.** Given a bad path, Haiku will operate on whatever
  repo it is standing in and report plausible success. Hence the `STRICT` preamble *and* code-side sha
  assertions — belt and braces. Keep both.
- **Keep the behavioural steers; they are not padding.** These look verbose and are each load-bearing:
  the anti-gestalt instruction in both gates ("grade each acceptance criterion individually — a gestalt
  impression hides exactly the misses you are here to catch"); the mutation-test instruction in the
  reviewer ("introduce a plausible bug, run the tests, confirm at least one fails, then restore"); the
  reviewer's "you did not write this code; assume it contains mistakes"; `NOROADMAP`; `REPORT`.
- **Schema-retry resends payloads verbatim**, so an oversized structured report can kill a unit whose
  work is already committed and done. This is why free-text fields carry `maxLength` caps and why
  code-writing agents are told to **commit before emitting the report** — the commit is the deliverable.
- **A tight schema needs a `notes` pressure-release** — *and every prompt behind a capped schema needs
  the matching terseness clause.* With `additionalProperties: false` and no free-text field, an agent
  with something unusual to say emits extra keys and burns the retry cap. But the valve only works if
  the prompt does not invite the agent to burst it. The conductor's tier-2 triage prompt used to end
  "overflow goes in `notes`" — pointing the agent straight at the one hard-capped field — while
  carrying none of the length discipline the harness's explorer/health prompts carry:

  > Keep every free-text field terse — an oversized report fails validation.

  The two prompts without it both died, at two consecutive boundaries, on
  `/notes: must NOT have more than 600 characters`. **A `maxLength` in a schema is a contract with the
  model, and the prompt is the only place that contract is communicated.** Raising the cap alone just
  moves the cliff; the fix that worked raised it AND reworded.

  **Superseded, 2026-07-18** — this section used to add "the two prompts with that clause have never
  failed." They have since: 16 opus calls died carrying it. The generic clause is necessary and not
  sufficient, so every capped field now states its own budget. What survived the correction is the
  stronger claim, and it survived a real test: deaths occurred **only** on capped schemas (16/62
  capped opus calls vs 0/102 uncapped, p~4e-8), a split that holds when matched on turn length. What
  is NOT established is which field overran — no payloads survive for workflow agents — so treat
  per-field attribution as inference, and note one capped-schema-independent death in the record
  (`plan:`, on the uncapped `S.plan`). Caps are the amplifier, not the whole mechanism.
- **`feasible: false` is the planner's escape valve.** Without it, an agent that correctly refuses to
  build an unsatisfiable spec has no legal output.
- **`agent()` resolves to `null` on a terminal API error — it does not throw.** This is the single
  nastiest platform behaviour to code against, because `.catch()` looks like it covers the failure
  and doesn't. A transient network drop during an eval made `census:w3` resolve `null`, the
  `.catch()` fallback never fired, `predicates()` dereferenced it, and a 3-wave run died at its
  final boundary with a `TypeError` — after ~2.5 hours and 158 successful agents. Hence `runOr()`:
  **every `run()` whose result is dereferenced must funnel through it.** Where a fallback is
  meaningful (the census) it degrades; where inventing one would silently admit or drop work (the
  triage tiers) it returns `triage-degraded` and hands the boundary to the root. A blip must never
  cost an arc.

## 9a. Observability — a silent safety net is its own failure mode

Every degradation path in these scripts (`runOr`, the `.catch(() => null)` writers, the coded
fallbacks) exists to stop a blip from costing an arc. Each one also **destroys the evidence of why it
fired.** That trade is only worth taking if the net *records* what it caught.

It didn't, and the bill came due. The tier-2 triager was dying deterministically on a 600-char `notes`
cap; the fallback dutifully returned `triage-degraded`; and with no cause attached, three separate runs
were attributed — confidently, and wrongly — to "network flakiness". The bug was found only by hand-
reading raw `agent-*.jsonl` transcripts. **Robustness without observability doesn't remove failures, it
removes your knowledge of them.**

Three platform facts make this sharper than it sounds:

1. **A `null` from `agent()` carries no error object.** The platform exposes *nothing* about why a
   subagent died. The scripts therefore cannot self-diagnose; the best they can do is record *which*
   agent, *where*, and point at the transcript. That is exactly what `degrade()` does.
2. **The journal only records successes.** `journal.jsonl` gets one `{"type":"result"}` line per
   *completed* agent — a failed agent leaves no line at all. The designated forensics file is silent
   on precisely the events worth investigating. Our own ledger is the compensating control.
3. **`spend` counts calls, not health.** A run that burned two retries and a salvage looked identical
   to a clean one.

Hence: `degradations` in the returned state, a `log()` line at the moment of every degradation (so a
long run is legible while it runs, not only afterwards), and `.roadmap/skill-feedback.md` written at
every persist point — *not* only on return, because a run that dies never returns and its evidence
would die with it.

`skill-feedback.md` is deliberately **not** `debt.md`. Debt is about the product and is triaged into fix
units by the architect. Skill feedback is about the *orchestrator*, has a different audience (whoever
maintains this skill), and must leave the product repo entirely. Mixing them buries the rarer and more
valuable signal in the commoner one. It is a living document and is **never archived** with the arc — a
defect log you archive is a defect log you have decided not to fix.

## 10. H-7 — the phantom ledger reference (resolved)

An implementer hit a genuine frozen-surface-vs-code mismatch, deviated correctly in code, and left a
`// see debt.md` comment for a ledger entry it *could not write* (units never touch `.roadmap/`). A gate
then quarantined the unit partly on that phantom reference.

Resolved two ways, both of which must be kept:

1. The implement/fix prompts **forbid `.roadmap/` references outright** — deviations are reported only
   through structured output (`NOROADMAP`).
2. The impl schema gained an optional **`contractMismatch`** field (string, ≤300 chars — "which surface,
   how reality differs"). A present `contractMismatch` fires the mid-loop architect consult (consumable,
   budget-respecting), **forces the Fable exit gate** (skipping any audit-only cheapening) with the report
   text and an explicit adjudication clause, and banks a `{kind: 'contract', severity: 'major'}` debt entry
   — which routes the boundary straight back to the root, because the contract amendment is the
   architect's alone.

The Fable gate catching exactly this case — a silent frozen-surface deviation under all-green tests — is
arc-observed value, and is why the mismatch force is unconditional.

## 11. Crash recovery — why a fresh relaunch is not a restart

Two mechanisms make rung 3 of the recovery ladder behave like a resume:

1. The conductor persists the merged `plan.json` and the consumed `state.json` **before every dispatch**,
   so a fresh launch resumes from the last *completed* boundary. Every finished wave is durable, and its
   debt/journal/feedback moves are already on disk.
2. Within the wave that was in flight, the harness's **setup guards short-circuit work already done**: a
   unit branch already merged into the integration branch short-circuits to `merged`; a crashed `running`
   unit auto-adopts its committed branch and re-enters at verify.

So the loss bound is only the in-flight wave's *uncached* agent calls. Nothing is reimplemented; nothing
is destroyed.

Two guards exist because they were each learned the hard way:

- A branch with commits beyond its fork base that the passed state does not mark `running` is **refused,
  not overwritten** (`has-commits` quarantine, branch left intact).
- A **self-referential** `existingBranch` is refused at plan validation: a setup agent following the
  remove-stale-remnants path would delete its own source and recreate it from the wrong base. This
  destroyed finished work once.

Relatedly: the sha assertion after setup must **never trust the same agent that could have recreated the
branch** — arc-observed, a setup agent deleted its own source branch and recreated it from `main`. The
adopt tip is therefore pre-captured read-only, and the resulting worktree sha is asserted against it in
code.

## 12. Why the preview is observability and never a gate

The green-tip mirror rides the *primary checkout* at the latest suite-green integration tip, so the user
watches real states from their own repo and `.roadmap/feedback/user/` is in the tree they are standing in.
Every path is best-effort: setup, refresh, and healthcheck failures log and continue. **No unit outcome may
ever depend on the preview** — gating an arc on its own observability is how an observability feature
becomes an outage.

The `main` ref never moves (detached HEAD) and the merge queue stays in `__integration`, so user git
activity can at worst stale the mirror (one detach-checkout heals it), never derail the queue. This works
because units never touch `.roadmap/`, so the harness's dirty `state.json` checkpoint is identical across
tips and survives each checkout.

Process lifecycle: the preview is started with `setsid`, making the recorded pid a **process-group leader**.
Every stop must kill the **group** (`kill -TERM -- -$(cat …)`) — a single-pid kill strands child listeners
and leaves ports held. This bites at Phase 0, on resume, and at close-out.

## 13. Why `.roadmap/` must be closed out

It is arc-scoped working state, not permanent documentation. Left raw, it sabotages the future: a later run
reads the stale `state.json` and forks worktrees from a **dead integration tip**; retired "frozen" contracts
masquerade as binding; and maintainers inherit expired planning clutter.

The living documents (`constraints.md`, `debt.md`, notes) stay at top level — unresolved debt is a
first-class input to the next arc's Phase 0, not archived clutter. The absence of a top-level `state.json`
is the unambiguous "no arc in flight" marker.

## 14. GitHub issue tracking — a projection, not a second source of truth

Issue mode makes GitHub issues the human-facing and cross-arc-durable face of the work. The shape is
forced by one platform fact and one economic one.

**Forced to be a projection.** Workflow scripts have no network, and issue numbers are
non-deterministic — either would break the two things the scheduler depends on: reading `state.json`
in-memory, and `resumeFromRunId` replaying deterministic prompts. So issues cannot be what the
scheduler reads. They are a Haiku-written *projection* of `state.json`, exactly the green-tip mirror's
relationship: **observability, never a gate.** Every `gh` write is best-effort; a failure is a
`gh-sync` degradation, not an arc failure. This is also what keeps the skill universal — no remote →
`plan.tracking:"files"`, every `gh` clause `''`, behaviour byte-identical to the pre-issues design.
The offline paid fixtures run this path, which is why they stay green and why a `gh` clause must
**never** be emitted unconditionally.

**Idempotent by marker, not by number.** Because numbers can't be threaded deterministically, sync
finds-or-creates by a `<!-- roadmap:unit id=<id> -->` body marker. `unit.issue` is a cache; nothing
load-bearing reads it. A resumed or re-run wave never double-creates. Same discipline as the harness's
wave-N section markers.

**Sync folds into agents that already run.** The 1000-agent-per-run cap is real, so flooding the run
with dedicated sync agents would shorten arc lifetime. Instead the projection rides existing agents:
the setup agent flips `status:running`, the merge agent closes on a clean merge, the dossier-writer
posts the quarantine, and the conductor's existing five persistence writers project debt/feedback/new
units. The one added agent is a single wave-tail reconciliation *sweep* — the backstop that re-derives
every unit's label from the final map and is the one place unit sync records a `gh-sync` degradation.
Net cost in issue mode is a few Haiku calls per wave, no new frontier touchpoints.

**Debt intolerance rides the convergence brake, not a new mechanism.** "Sweep even minor debt into the
next wave" would, taken literally, never terminate — a healthy assessor drafts something every wave
(§7). The reconciliation is that debt *rides* waves that already exist for planned work but **never
creates one**: once the plan's own units are terminal, debt banks to `roadmap:debt` issues and the arc
completes, to be picked up at the next session's Phase 0. That is the existing cut-line brake
generalized from health drafts to all debt — termination preserved, tolerance lowered.

**Two smaller pins.** Issue templates only activate on the *default branch*, so bootstrapping them is
a one-time user-merged PR at Phase 0 (the one pre-close-out touch of `main`, and only the user moves
it — invariant 5 holds). And `skill-feedback.md` stays a file: it is about the *orchestrator*, must
leave the product repo, and the skill can't assume access to its own repo's tracker from inside a
consumer's — so it is never a product-repo issue, the one ledger issues do not absorb.
