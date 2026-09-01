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

User input splits by **nature, not timing**: a `roadmap:bug` reports something *broken*; a
`roadmap:unit` proposal asks for something *new*. That split is what lets `roadmap:bug` be
**dual-consumed** — the boundary census reads it during a live arc, and Phase 0 reads open ones as
candidate scope — so a defect filed *between sessions* has a first-class home instead of masquerading
as a proposal. This does not weaken the never-steers rule (a bug still never reaches a running unit)
nor termination: adopting a bug at **Phase 0** is the architect *setting* scope for a fresh arc, which
is exactly where scope is supposed to be set. It is categorically distinct from the mid-arc tier-2
debt sweep, whose "debt never *creates* a wave" brake (§7/§6.6) is what keeps arcs converging and is
untouched here. Bugs and proposals also share one decomposition mechanic so a large one fans out
cleanly: adopt (1:1) promotes the source issue in place; split (1:N) opens child unit issues and
closes the parent with links — never a dangling duplicate beside its children.

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

**And the brake is now code, not only prompt (0.13.0).** The cut line binding the *default* still
needs a triager to apply it, and an Opus turn can reason its way past a prose brake — observed: 7
drafts admitted at wave 18 and 8 at wave 19, after the architect had already logged PLAN DRAINED.
`admissions: 'closed'` is enforced where units are minted, so neither tier can mint one whatever it
concludes (drafts and promotions bank as debt lines instead), and `tier1MaxDrafts` stops the
mechanical tier admitting a whole batch with no judgment at all. See §19: prompts may *inform* a
brake; they never *are* one.

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
  cost an arc. **0.13.0 split this in two** (§19): `runOr` keeps the cases where a coded fallback is
  an honest answer, and `runReq` covers the results a caller dereferences where any fallback would be
  an invented *verdict about a unit* — it parks the wave instead of quarantining seven units for the
  platform's outage.

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

Hence: a `log()` line at the moment of every degradation (so a long run is legible while it runs, not
only afterwards); the row appended *there and then* to `.roadmap/degradations.jsonl`, because a run
that dies never returns and its evidence would die with it; this run's rows on the return envelope for
the root to read; and a per-kind count summary rewritten to `.roadmap/skill-degradations.md` at every
persist point. What the scripts do **not** write is `skill-feedback.md`.

`skill-feedback.md` is deliberately **not** `debt.md`. Debt is about the product and is triaged into fix
units by the architect. Skill feedback is about the *orchestrator*, has a different audience (whoever
maintains this skill), and must leave the product repo entirely. Mixing them buries the rarer and more
valuable signal in the commoner one. It is a living document and is **never archived** with the arc — a
defect log you archive is a defect log you have decided not to fix.

It is also deliberately **hand-written**. It used to carry a machine-maintained marker region rewritten
whole by an unverified Haiku pass, and that pass ate a hand-written entry. The machine half now lives in
files the scripts own outright — `skill-degradations.md` (the per-kind summary) and the
`degradations.jsonl` / `escalations.jsonl` sidecars — and no prompt in either script can reach
`skill-feedback.md`; a sim asserts it.

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

**The checkpoint writer is a fan-out, not one transcriber.** `state.json` is written by Haiku agents that
echo the document as their own output, and one response caps at ~32k output tokens. The first fix
(a single writer told to stage the parts itself) failed the moment state reached 3–6 parts: ~28
`write-failed` checkpoints across two waves — "cannot complete within token budget" — plus five
schema-retries where the writer gave up in prose. One agent emitting 145 KB is the wrong shape. Now a
payload over `WRITE_CHUNK` is split deterministically on line boundaries (a pure function of the text,
so a resume splits identically) and each part gets its OWN writer, in `parallel`, writing only
`<file>.partK` through a single-quoted here-doc; a single assembler `cat`s the parts in order and
removes them (`rm -f <file>.part*`, so stale parts from an earlier fan-out with a different count go
too) — and it never runs if any part failed, so the previous complete file is what a crash finds,
never a partial. A part that fails is re-run once by a fresh agent before that verdict — a
mis-transcription is per-sample stochastic, not per-part (live: 2 of 16 part writes mis-transcribed,
caught by cksum; a fresh sample of the same part succeeded), so with five parts a checkpoint that
died on any first-try loss died far too often; the assembler is never retried, a bad `cat` is not
stochastic. Below the threshold one writer copies the whole document through the same here-doc.

**Every writer verifies by content hash, not byte count.** The first fan-out checked each part with
`wc -c`. Live, one of five part-writers un-escaped every `\"` and `\\` inside JSON string values
(losing bytes), then padded the tail with lines fabricated from the next record until the count
matched — 32 tool calls of iterating toward the number — and reported ok:true; so did the assembler;
the assembled state.json did not parse. A byte count is a target an agent can steer toward; a CRC is
not. Every writer prompt (single, part, assembler) now runs `cksum < <file>` and must see the exact
`<crc> <bytes>` pair the script computed (POSIX cksum in-script — the workflow sandbox has no crypto;
the sims cross-validate it against coreutils on every run), and is told plainly never to edit, pad,
trim, or rewrite the file to make the numbers match: a mismatch is reported, not repaired. The single
write had no verification at all before this and showed the same de-escaping through a file-write
tool; it now uses the identical here-doc + cksum instruction, which is why the legacy prompt shape was
deliberately dropped.
**Landed in 0.13.0** (§19), because the arc-cumulative arrays were most of what made state large:
`degradations`/`escalations` moved to append-only sidecars, and `state.json` now carries only the
per-unit escalation stop counts the three-strikes brake reads. Still deferred from that batch: delta
checkpoints, if the sidecars alone turn out not to be enough.

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

The green-tip mirror rides **its own worktree** at `worktreeRoot/__preview`, detached at the latest
suite-green integration tip. It used to ride the *primary checkout*, so the user watched real states from
the repo they were standing in — and that is precisely what made the harness's own tracked
`.roadmap/state.json` block the detach, which is what made a Haiku agent told to make the checkout work
anyway delete 163 untracked `.roadmap/` files. The mirror moved rather than the prompt getting another
prohibition (§19: containment, where the failure mode is acting outside the sanctioned set). The user's
checkout is now never a checkout target at all, so they can keep working and switching branches while an
arc runs. Every path is best-effort: setup, refresh, and healthcheck failures log and continue. **No unit
outcome may ever depend on the preview** — gating an arc on its own observability is how an observability
feature becomes an outage.

The `main` ref never moves (the mirror is always detached) and the merge queue stays in `__integration`,
so at worst the mirror goes stale and one detach-checkout heals it; nothing can derail the queue.

Process lifecycle: the preview is started with `setsid`, making the recorded pid a **process-group leader**.
Every stop must kill the **group** (`kill -TERM -- -$(cat …)`) — a single-pid kill strands child listeners
and leaves ports held. This bites at Phase 0, on resume, and at close-out. What a stop may **not** do is go
hunting for the listener: the one-shot sweep's only kill targets are the pidfile's process group and the
literal ports `plan.preview.ports` declares. Asked instead to free "the preview's ports", Haiku swept three
guessed ports and then `ps | grep | kill -9`, killing the workflow itself. An undeclared port is a port the
sweep leaves alone — a missed listener is cheap, and a name-sweep is not.

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

## 15. The debt pathway hardened — banking is the exception, never a verdict downgrade

A real 54-unit arc (2026-07-29) banked ~350 `roadmap:debt` issues. The user's post-hoc grading —
borne out by a branch-verification pass — was that most were PR-review-grade corrections a fix
round would have cleared, and, worse, that per-unit gates had **approved units whose banked residue
later graded as correctness bugs** at the integration review (a phantom UI-flavour bug, executor
floor wedges, a missing owner check, a schema-less tool briefing). In each case the gate had the
finding *in hand* as a debt item and approved anyway: debt classification had become a
verdict-downgrade path, and `severity: minor` systematically under-weighted hygiene whose absence
taxes every later unit.

Four rules close it, each enforced by schema or code rather than prompt alone:

1. **Fix-in-unit is the default.** A finding inside the unit's blast radius (a file the diff
   touches, a test the unit owns) is a revise directive; banking requires a `bankReason` from a
   closed set — `out-of-scope-file | needs-migration-or-ruling | pre-existing-untouched` —
   schema-required on gate debt and reviewer `nonBlocking` entries. "Minor" alone never banks.
2. **The next-change test replaces the severity shortcut.** Gates ask "would leaving this raise
   the cost of the NEXT change to this file?" — if yes it blocks, whatever its severity.
3. **The implementer's confessions get one `debt-fix` round** while its context is loaded — the
   cheapest fixer there is. Only what the sweep re-emits with a bankReason reaches the ledger.
4. **Correctness debt never banks through an approve.** An approve holding a `kind:'correctness'`
   item is coerced to revise inside the existing `maxGateRounds` (the items become directives); at
   the cap the Opus gate escalates and the frontier gate banks at `severity:'major'` with a loud
   `correctness-debt-banked` degradation — bank-with-evidence beats quarantining work the frontier
   gate judged mergeable, and the bound keeps token cost inside the rounds that already existed.

Volume got the same treatment on the projection side: issue mode now mints **one consolidated
`roadmap:debt` issue per unit-residue** (marker `wave=<N> unit=<id>`, resume-stable, mixed labels
take max severity + one facet per kind) instead of one per finding, and a consolidation fix-unit
names the issues it resolves in `closes` so the merge path retires them. Termination is untouched:
every rule operates inside the unit pipeline, and §14's "debt never creates a wave" brake stands.

## 16. The 0.10.0 hardening batch — warm lanes, owed markers, pulled consults, merge fences

One batch, one organizing idea: **spend warmth where it is only re-reading cost, and keep
coldness exactly where it is epistemic** (the method split identified 2026-07-29).

**Warm lanes.** *(Superseded in 0.11.0 — removed entirely. Kept here because the reasoning is what
explains the removal: warm lanes amortized a fixed cold start across a chain of units too small to
absorb it individually. Once units are sized by what can be specified rather than by duration, a
unit absorbs its own cold start and the chain IS the unit, so the mechanism was paying a large
maintenance surface — per-link pinning, demotion, lane quarantine semantics — for a saving that had
collapsed. One dispatch path is the canonical way now.)*

On a strict linear chain, isolation buys zero parallelism — yet each link used to
pay a full cold start, worktree, provision, and re-exploration. The platform constraint that
shaped the design: `agent()` is one-shot, so a literally-continuing implementer cannot exist.
The warm lane is therefore ONE plan call and ONE implement call covering the whole chain
(per-link commits, per-link pinned `unit/<id>` branches), after which every link runs the
byte-identical cold pipeline through runUnit's adoption entry, diffed against its recorded
predecessor tip. Three deliberate conservatisms: per-link plan-checks survive (the spec-defect
bookend must fire before code exists, per link); every gate force rule (risk, mismatch, specGap,
audit sample) is computed per link; and any lane-infrastructure failure **demotes** the remaining
links to ordinary cold dispatch rather than inventing new failure semantics — the lane is an
optimization, never a new way to lose work. The diff base for link i+1 is link i's PINNED tip
(pre-fix), probed read-only, so fix commits on an earlier link never pollute a later link's
review diff; the three-way merge reconciles them at the queue.

**Owed markers.** A skipped boundary job used to vanish (arc-observed: a preview-down wave
silently skipped the design reconcile over five design-cited units and only the root's manual
attention caught it). The fix is a machine-readable debt: due-but-unrun jobs write `owed`
entries that discharge only when the job next succeeds, repeat offenders force the Fable tier,
only Fable may waive (journaled), and a terminal return surfaces the leftovers as the root's
close-out duty. The design job additionally re-folds owed units into its due set, so the debt is
paid, not merely remembered.

**Implementer-pulled consults (`specGap`).** The mid-loop rescue's mechanical triggers fired
zero times in 92 units while every real failure was a silent design decision under a spec that
didn't cover it. The pull channel inverts the direction: the implementer reports the unsettled
decision, a Fable consult adjudicates it even when every test is green (`confirm` costs no fix
round), and an unconsulted gap (budget spent) forces the Fable exit gate — same
missing-signal/high-stakes logic as `mismatchEver`. The same scratchpad-abuse discipline as
`contractMismatch` applies, because an FYI in a trigger field costs a frontier consult.

**Merge fences.** NOROADMAP was advisory; now the merge queue enforces it (refuse → strip commit
preserving content in branch history → `kind:'contract'` debt → root adjudication — the exact
disposition the observed incident got by hand), and `prefixUniqueGlobs` makes numbered-sequence
collisions a refusal instead of a silent CHECK-erasing merge. The prefix check diffs duplicate
sets pre-merge vs merged — a global-uniqueness check refused two whole waves on grandfathered
duplicate pairs the repo had already sealed. Both clauses are '' when their precondition is
absent, keeping fixture prompts byte-identical.

**Preview loudness.** A dead mirror silently no-ops the explorer and the design reconcile for a
whole wave, so setup failure is now a `preview-failed` degradation carrying a porcelain diagnosis
that distinguishes the carried-modification case (local content byte-identical to the target tip
— a stale detach point's residue, safe to re-detach) from real local edits (the operator's, never
the harness's to stash). The owed markers are the boundary-level half of the same fix.

**Cache-aligned preambles — deliberately scoped down.** The feedback asked for byte-identical
prefix-positioned preambles across a wave's prompts. What shipped: drift guards asserting the
cross-script shared constants stay identical, and prefix-aligned preambles on the NEW chain
prompts only. Restructuring every load-bearing prompt's opening for an offline-unverifiable
caching gain, immediately before a single paid validation cycle, risks the gate-teeth wording
for a benefit that cannot be measured this side of the run. Revisit with its own paid cycle.

## 17. The Codex executor — one implementer, and the review spiral named

The largest revision since the conductor. Codex (the OpenAI CLI) became the ONLY implementer;
Claude keeps every judgment surface. Driven by economics (Claude weekly limits are the scarce
resource; an idle OpenAI subscription was the workhorse budget) and by comparative advantage:
Fable/Opus for orchestration, taste and architectural judgment; Codex as an effective, cheap,
instruction-following builder that needs tight scoping and fails at open-ended steering. Rulings,
each deliberate:

- **No dual lane.** An earlier draft kept a Claude implementation lane behind an `executor` flag
  with byte-identity guarantees. Rejected by the maintainer as complexity beyond what is worth
  maintaining. Consequences accepted with it: the offline fixtures are no longer
  Claude-lane regression evidence (they are acceptance evidence for the new design), and codex
  unavailability is a HARD STOP — the per-wave probe or a usage-limit observation halts dispatch,
  parks in-flight units (`status:'pending', parked:true` → re-entry by adoption), and
  early-returns `codex-unavailable`/`codex-usage-limit` to the root. Auth is a human act; the
  orchestrator never routes around a halt with a substitute implementer. (0.13.0 generalized this
  single `codexHalt` flag into a halt record `{codex, env, platform}` with a fixed precedence — see
  §19; the codex semantics above are unchanged.)
- **The review spiral, named.** Three prompt clauses compounded: (1) "an imperfection in a file
  you are already touching is yours to fix" made the eligible-fix set a function of the diff's
  own growth; (2) "over-reporting costs nothing" licensed unbounded findings; (3) findings became
  fix directives with no cap on files touched. Each fix widened the diff, each widening gave the
  next pass more surface. GPT-family models followed the licence most literally, but §15's ~350
  banked items show the same loop taxing Claude arcs. The fix is structural, not hortatory: a
  **pinned scope envelope** computed once per unit (plan files / diff-at-entry / link files) and
  never recomputed from the live diff; `verify.diffFiles` makes growth an objective code-side
  signal (`scope-growth` degradation + a gate adjudication clause); gates report at most
  `maxBlockingFindings` directives in four evidence-quoted categories, overflow banked;
  DEBT_DISCIPLINE inverts to banking-by-default outside the envelope. This knowingly re-creates
  §15's volume symptom and trades it for diff discipline: a banked item costs one triage read; a
  widened diff costs re-review every round and raises regression odds. The tier-2 "debt never
  creates a wave" brake still bounds the ledger.
- **No standalone review stage.** The codex build runs its own implement→test→fix loop; a
  separate adversarial review was a free pass generating directives against a diff the exit gate
  re-reads with authority anyway — one more diff-widening mechanism. The gates absorbed the
  review's hunting clauses (tautological-test check, comp adoption, the four categories).
- **S.impl is the seam.** The steering agent emits the same report shape the pipeline always
  consumed; verify/gates/consults/merge and every trigger (specGap/contractMismatch/debt) are
  untouched and nothing downstream knows who wrote the code. This is what made the swap tractable
  in one batch.
- **Stop-don't-improvise, an intentional asymmetry.** The old Claude implementer was told to
  choose a deviation and keep building (a one-shot agent; stopping wasted the turn). Codex is
  told to STOP (≤1 per dispatch, commit finished work, `stopped-spec-gap`/
  `stopped-contract-mismatch`) because `codex exec resume` makes a stop cheap: the Fable consult
  rules, and the ruling returns into the same session with context intact. P1 pinned that a
  resumed session still honors the original brief's constraints.
- **Resume for fixing, never for judging.** Every judge (plan-check, verify, gates, consults) is
  a fresh agent reading `git diff` cold — coldness is epistemic and survives by construction. The
  one resume-bias mitigation needed: the LAST gate-fix round runs a FRESH codex session
  (anchoring after two failed rounds). `codex exec review` is deliberately unused — review is
  judgment; judgment stays Claude.
- **Judgment moved upstream.** The maintainer's steer: "the biggest lever is the pre-codex-run
  gate" — better judgment up front means less wasted effort and less review noise. Fable now
  plan-checks every med/high unit with an explicit taste charter
  (overengineering, complexity that doesn't earn its keep, structure that taxes the next change,
  missed reuse, closed doors), and a read-only cross-model `codex-spec-review` feeds the check —
  GPT and Claude miss different things, so disagreement there is signal.
- **Steering is mechanical, so it is Haiku.** Launch/poll/kill/disk-verify/copy — no judgment.
  The report's budgets mirror S.impl's caps EXACTLY so read-back is a copy, never a compression
  (a mismatch would reintroduce §9's StructuredOutput death class across the process boundary).
  Codex's own strict-mode output schema (every property required — P1-pinned 400 otherwise) is
  generated by `strictify()` from the same literals.
- **What P1 pinned** (evals/codex-probe.sh; run it before changing invocation shape): strict-mode
  `--output-schema`; the `--json` event vocabulary; no `-a` on exec (approvals never fire); no
  `-C`/`-s` on `exec resume` (cwd + `-c sandbox_mode=` instead); the write-bar;
  trust-level override for untrusted worktree paths; the sleep-free `timeout … tail --pid` poll;
  constraint persistence across resume.
- **P1.7 is environment-dependent, and that was learned the hard way.** Codex's OS sandbox is
  bubblewrap, which needs an unprivileged user namespace. Where the container runtime's seccomp
  profile blocks that syscall, `workspace-write` cannot be built and degrades *silently* to no
  enforcement — probe-observed here: a write to an absolute path outside the worktree succeeded,
  while stderr carried only a handful of recoverable `bwrap: No permissions to create new
  namespace` lines from the `apply_patch` verification helper. The lane therefore defaults to
  `danger-full-access`: an unenforceable guard that still costs retries is worse than an honest
  absence of one. Sibling-worktree containment is an accepted risk in such an environment, not a
  guarantee. Re-run P1.7 in any new environment before assuming otherwise.

## 18. Long-horizon units — what was measured, and what it killed

0.11.0 resized units by what can be *specified* rather than by duration, moved Codex onto a
multi-hour horizon, and replaced the one-stop-per-run cap with an escalation ladder. Two throwaway
probes (since deleted — they had served their purpose) produced the evidence; these are their
findings, kept because every one of them still constrains a future change.

**The checkpointing hedge was rejected on evidence, not on taste.** The starting worry was that
Codex's compaction would degrade brief-carried guardrails to a vague gist, and the proposed fix was
a disk-based checkpoint convention. Two runs migrated 40 legacy modules onto four conventions stated
ONCE in milestone 1 and never restated — three of them pure convention with no behavioural payoff
(a `meta` export, module-prefixed error codes, an accumulating registry file), i.e. exactly what a
compacted context should drop first. Compliance was measured per module by migration position, so
decay would appear as a tail. **Zero decay, both runs** — the second with auto-compaction forced
down to a 40k trigger. What carries the load is per-milestone commits (git is the progress ledger)
plus re-reading the brief file at each milestone boundary, both of which are fresh tool calls rather
than recall. Do not add a checkpoint convention without a decay curve that has an actual tail in it.

**Compaction is not observable from `--json`.** There is no event for it. An early probe reported
"compaction occurred" because a bare `grep -i compact` matched the word *compacted* in our own brief
echoed back in the event stream. The context window is 272k with auto-compaction at ~95%
(`codex debug models`), and `model_auto_compact_token_limit` is an accepted config override — which
is the cheap way to reach the regime deliberately instead of paying for a run long enough to fill
258k naturally. Also note: realistically-shaped units *stream* (read a module, write it, move on),
so they may simply never accumulate enough context to compact.

**The escalation valve fires deep, not just early.** Two gaps were planted, at migration positions 8
and 30. Both produced stops, the second two sessions in, with the reasoning intact ("the spec
explicitly leaves LRU versus oldest-inserted undecidable, so neither was selected"). A valve that
only worked before compaction would not be a valve. Neither run stopped for the deliberately
*buried but settled* condition — evidence that the ladder's cheap `cited` tier is triage, not a
rubber stamp on Codex's judgment.

**A resume brief with no termination condition does not idle — it invents work.** Probe-observed: a
resumed session finished every specified milestone, then continued into self-directed `Audit:`
commits, expanding a spec line asking only that `restore(snapshot(s))` round-trip into a custom
serializer for cyclic references, BigInt and NaN, plus an exported internals hook to test it with.
That is production code, not test bloat. The build brief was protected by its DONE-WHEN; the fix
brief was not, and inherited no stopping rule. `codexFixBrief` now restates DONE-WHEN and explicitly
bars inventing follow-up work. Any new resume path must do the same.

**Test quality was not the failure mode.** The generated suites were sound — exact Result-shape
assertions, negative paths, a table of invalid inputs — under a brief that had *weakened* the
mutation-check clause. The degenerate behaviour to design against is unbounded scope, not slop.

## 19. Couriers, not janitors — the 0.13.0 batch

The workflow script has no filesystem and no shell — `run()` is `agent()`. Every side effect the
orchestrator has (a checkpoint, a checkout, a port freed, a login checked, a merge asserted) is a model
acting on the script's behalf. Through 0.12.0 the harness handed those actions to the cheapest tier as
*goals* — "clean up leftover listeners", "find the issue for this unit", "make the checkout work",
"report ok only if logged in" — and every incident in the 2026-08-21→28 ledger was that tier reaching
for the biggest tool that satisfied the goal: `kill -9` of every node process, `rm -f` over untracked
`.roadmap/`, adopting a fuzzy search hit, inventing a credential requirement. A "never do X" clause
did not help; a prohibition only works if honoured, and a courier that has been given a goal will
rationalise past it.

The rule since 0.13.0, in two halves:

1. **The cheapest tier receives a closed command list, never a goal.** `courierRun` is the one shape:
   the script composes the exact commands (including the judgment — a jq predicate, a regex the prompt
   states, a literal port list), the agent runs exactly those, in order, and returns verbatim
   `{exitCode, stdout}` per command; the script decides. Where the failure mode is *acting outside the
   list* rather than misjudging inside it, containment replaces wording: the preview lives in its own
   worktree so no sanctioned command can reach the operator's checkout. What genuinely needs a model
   — executing test lanes, judging a diff — keeps a model, but never the *choice* of what to run.
2. **Every wave-level brake lives in code.** Through 0.12.0 the harness had one wave-level flag
   (`codexHalt`); host health, platform outages, shared reds, scope precedent and admissions were
   either absent or prose inside a triager prompt that an Opus turn could reason its way past — which
   is how waves 18/19 grew the denominator for twelve hours after PLAN DRAINED. Now: a halt record
   `{codex, env, platform}` that `ready()` consults, `admissions:'closed'` enforced where units are
   minted, a shared-red breaker that emits one finding instead of N unit verdicts, and merged-ness
   decided by git in code at every chokepoint. Prompts may *inform* a brake; they never *are* one.

Corollaries the ledger forced: a model's death is a platform fact, never a unit verdict (park, don't
quarantine); events (degradations, escalations, debt) are appended once at the event, never
re-transcribed with state; nothing is cleared that a writer did not confirm.

**Git questions were asked as judgments.** The recurring defect was never that Haiku is cheap — it was
that "is this unit merged?", "did the merge land?", "has the tip moved?" were put to a model as
questions to *answer*. Every git fact the script acts on now arrives as exit codes from commands the
script itself wrote, and the script judges — at dispatch, inside `quarantine()`, and in the
crash-residue loop. The test is deliberately the **second-parent** one rather than a bare
`merge-base --is-ancestor`, which false-positives on a commit-less branch parked at an old integration
commit (the ledger asked for `is-ancestor`; the ask was wrong). The one exception to the quarantine
refusal is `git revert -m 1`, which keeps the merge commit while removing the code, so that caller
still quarantines explicitly. The wave-start tip reconcile is one-way for the same reason: adopting a
live sha on mere *inequality* is what let a rewound branch orphan the previous wave's merges.

**Events are not state.** Degradations and escalations rode inside `state.json`, arc-cumulative, so
every checkpoint re-transcribed every prior row — a third of a 170–190 KB document by wave 19 — and
each failure appended a row that made the next write likelier to fail. They now append once, at the
event, cksum-verified over the file's **tail**: the script cannot know an append-only file's prior
content, but it knows exactly the bytes it is adding. A sidecar failure is deliberately **not** a
degradation — that would feed the ledger it just failed to write — so it logs and increments
`sidecarLost` instead. The other half of the rule is that nothing is cleared that a writer did not
confirm: debt clears per verified marker and the rest re-banks next boundary, `plan.json` is refused
rather than overwritten when disk holds ids this run never saw, and an escalating return stages its
specs, plan, issues and debt *before* handing back, because a handoff is not an abort.

**Two null wrappers, and one deliberate middle case.** `agent()` resolving to `null` (§9) now has two
answers, and choosing between them is a real decision. `runOr` is for questions where a coded fallback
is an *honest* answer — a dead census is an empty census. `runReq` is for results the caller
dereferences, where any fallback would be an invented *verdict about a unit*: verify, both exit gates,
the plan and plan-check, the merge and its suite. Seven such sites used to dereference a null straight
into `quarantine('pipeline error')`, so one quota outage was recorded as seven unit failures. The
trigger is **structural** — a required result still missing after its salvage — never text-matching,
because a null carries no error object at all; quota/limit text exists only on the throw path, where
it is a fast path and never the sole signal. The commit probe is the one deliberate middle case: a
dead probe returns `unknown` and parks that unit alone rather than halting the wave, since one cheap
probe dying twice is not evidence of an outage and the branch's commits are safe either way. Parking
is only safe because of a wave-scoped `dispatched` set — a park returns the record to `pending`, which
without it re-dispatches inside the same wave forever.

**The host preflight fails loud on a breach and soft on an unknown.** An unrecognised PID 1 halts,
naming the comm, because the observed failure (`sleep` as PID 1, orphans never reaped, the pid cgroup
filling until test lanes died of EAGAIN) looks exactly like every other non-init, and guessing which
non-inits reap is how it stayed invisible for a week. A fact that could not be *read* degrades
`env-unprobed` and halts nothing — an unknown is never a breach. `config.envPreflight: 'off'` is the
documented exit for a healthy box with an unusual init, and the only way past the check.

**Load is recorded, never gated on.** The ledger asked for the flake band to wait on
`loadavg1 < cpuCount/2`. That was wrong on the facts: `runBoundary` runs **after** the scheduler
drains, so the band's co-tenants are its own siblings and the preview, not live gates. The general
form: the wave's own concurrency is what produces the load, so waiting on it is waiting on ourselves.
The brake that does work is a semaphore on the *lanes* (`gateMaxConcurrent`) while unit dispatch stays
unbounded. The numbers are recorded on every verify, once per flake band, and inside the
`verify-blocked` / `codex-timeout` entries, so a wall-clock verdict is auditable after the fact instead
of being a mystery.

**Tier 1 is bounded, not trusted.** Mechanical admission carries no judgment and no cut line, so a
*batch* of drafts is exactly the denominator growth the cut line exists to stop; above
`tier1MaxDrafts` the wave buys an Opus triage instead. None of this weakens termination, and the
checks are worth restating because they are easy to break: `admissions:'closed'` and `tier1MaxDrafts`
only ever *reduce* unit creation; duplicate drafts are dropped, not renamed into extra units (`x` /
`x-2` was one live pair of issues); banked lines are written after the wave's predicates are computed,
so they cannot feed the same boundary they were minted at; and a shared red arrives at triage as a
**finding**, which the cut line brakes, never as debt — §14's "debt never creates a wave" guarantee is
untouched.
