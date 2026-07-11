# Roadmap Orchestrator — Design Document

A Claude Code skill that takes (1) an unstructured roadmap + target architecture, (2) a
session cut line, and (3) an existing codebase, and executes the roadmap slice as one
orchestrated arc: decompose → per-unit isolated build/test/review → serial integration →
merge-ready result. Optimization target: **minimize frontier-tier (Fable) output tokens**,
treating Opus/Sonnet/Haiku as free at the margin.

> **Implementation:** `plugins/roadmap-orchestrator/skills/orchestrate/` — `SKILL.md`
> (goals + invariants for the executing architect), `harness.mjs` (the generic zero-token
> wave executor), `reference.md` (data shapes, config knobs, platform rules), `evals/`
> (the regression fixture). Distributed via this repo's plugin marketplace
> (`.claude-plugin/marketplace.json`); invoke as `/roadmap-orchestrator:orchestrate`. The
> skill is deliberately less prescriptive than this document: it pins the invariants and
> the code, and leaves every judgment call to the frontier model running it.

---

## 0. Verdict on the strawman

Your architecture is directionally right. Where I differ:

| # | Strawman claim | Verdict |
|---|---|---|
| 1 | "The root is code, not a living frontier agent" | **Agree, and it's better than you think**: the dynamic-workflow script *is* deterministic zero-token code that can spawn agents. The harness loop doesn't need to be authored — it can literally be the workflow script. But there is an irreducible thin frontier presence: the main Claude Code loop between waves. Don't fight it; it's the only place human input can enter. Minimize its turns, don't eliminate it. |
| 2 | "Frontier authors the harness" | **Disagree.** The harness is written **once, as part of the skill** — generic, parameterized by a plan pack. Having the frontier re-author orchestration code per run is both a token spend and a reliability bug farm. The frontier authors *plan data* (DAG, contracts, unit specs), never orchestration code. This is the single biggest economy in the design. |
| 3 | One parameterized workflow template per unit | **Agree.** Realized as a plain function inside one workflow script, not as separate workflows (see §2 on nesting). |
| 4 | Cheap review/fix, demand-gated escalation to frontier | **Revised twice.** *First:* per-unit frontier judgment was made **guaranteed** — Opus reliably gets a unit ~90% there but leaves small oversights it doesn't know it left, so demand-gating (asking Opus "are you confident?") missed exactly them; every unit got a **Fable architect exit gate** plus a plan-check. *Then, for Fable economy:* the exit gate became **Opus-first with a retained frontier safety net**. Opus grades its own work and escalates to the Fable gate only on a call it *can* reliably self-assess — it's stuck, a genuinely hard trade-off, or the increment is architecturally foundational — NOT on hidden-oversight confidence. The guaranteed Fable pass is kept exactly where undetected oversights are most costly (`risk: high`, contract-touching diffs) plus a deterministic audit sample against systematic rubber-stamping; hidden oversights that slip a low/med unit are caught systemically by the between-wave health check (§6.6), not per-unit. Mid-loop *rescue* for stuck units still fires by **plain code over objective signals** (fix-round counts, test results, paths touched) — never by asking a cheap model "do you need help?". *Then, extending the same posture to the plan-check:* it too became **Opus-first** — a fresh Opus checks every plan and escalates to Fable only on uncertainty, a foundational/contract concern, or apparent infeasibility, with the guaranteed Fable pass retained for `risk: high` and claimed-infeasible plans (and Opus may never quarantine — kill decisions stay frontier-only). Cheap, pre-code, still high value; the tier that pays just moved. §6. |
| 5 | Guaranteed frontier pass at the post-integration gate | **Half agree.** Per-merge frontier is O(N) — it violates your own constraint. The per-merge gate is code + tests (free). The *guaranteed* frontier acts are O(1) per session: the plan pack up front and one integration review at the end. And the real fix for cross-unit semantic incompatibility is to **prevent it at plan time with frozen interface contracts**, not just detect it at merge time. §7. |
| 6 | Bounded give-up / quarantine | **Agree.** §8. |
| 7 | Structured state, parse-once | **Agree.** §10. |
| 8 | Independent-vs-contingent regime detection | **Agree, but make it per-edge, not per-roadmap.** A roadmap isn't in one regime; each dependency edge is either *contract-satisfiable* (the dependent only needs the interface, which the frontier can author now) or *output-contingent* (designing the dependent needs the dependency's actual results/learnings). Contract-satisfiable edges front-load fully; output-contingent edges force wave boundaries with a frontier replan. §3. |

One addition the strawman missed entirely: **within the free tier, don't be stingy.** The
only scarce resources are frontier output tokens and wall clock. Use **Opus** (the
strongest free model) for implementation, review, and conflict resolution — not Sonnet or
Haiku. Every point of quality in the free tier lowers the escalation rate, and escalation
rate is exactly what the frontier bill scales with. Haiku is for mechanical execution;
Sonnet for extraction/compression; Opus for everything requiring judgment short of
frontier.

---

## 1. Platform ground truth vs. assumptions

Most of your "substrate beliefs" are verifiable facts about the current dynamic-workflow
runtime. Separating what is **known** from what remains **assumed**:

### Known (from runtime documentation — no verification needed)

| Fact | Design consequence |
|---|---|
| Workflow scripts are plain JS, run in an isolated runtime; primitives `agent()`, `pipeline()`, `parallel()`, `phase()`, `log()`, `workflow()`, plus `args` (input) and `budget` (token accounting). Intermediate results live in script variables. | The zero-token harness is real. Coordination, DAG scheduling, status tracking, retry counting all cost 0 model tokens. |
| **Scripts have no filesystem or Node API access**, and `Date.now()`/`Math.random()` throw (determinism for resume). | The script cannot itself run git, read state files, or poll disk. Every I/O side effect is either (a) passed in via `args`, (b) done by a Haiku agent, or (c) done by the main loop between runs. This reshapes the "tracking costs zero tokens" claim: tracking *logic* is free; tracking *persistence* costs a few Haiku calls — which cost zero **frontier** tokens, which is the actual objective. |
| **Nesting exists but is one level deep**: `workflow()` runs a child workflow inline, sharing the parent's concurrency cap, agent counter, and budget; a grandchild throws. | Your question (a) is answered: true nesting exists, depth 1. The design doesn't need it — per-unit pipelines are functions inside one script — but it's available if a unit ever needs an independently-authored sub-workflow. |
| **Ceilings**: concurrency = min(16, cores−2) per workflow; ≤1000 agents per run lifetime; ≤4096 items per `pipeline()`/`parallel()` call. | Your question (b), mostly answered. At ~8–15 agent calls per unit, one run supports ~60+ units — agent count will essentially never bind. Concurrency=16 means wall clock, not tokens, is the throughput limiter. |
| **Resume**: `resumeFromRunId` replays the longest unchanged prefix of `agent()` calls from a journal (`journal.jsonl`); same-session only. | Intra-session crash recovery is nearly free *if the script is a deterministic function of its args* — keyed by stable unit IDs, no timestamps in prompts. Cross-session resume must come from file-based state, not the journal. §9. |
| **No mid-run human input.** Confirmed. | All human judgment must be front-loaded into the plan phase (interactive) or deferred to between-wave checkpoints. The skill must aggressively surface ambiguities *before* dispatch. |
| `agent()` accepts `schema` (JSON Schema; output validated at the tool layer with automatic retry on mismatch), `model`, `effort`, `isolation: 'worktree'`, `agentType`. | Schema-bound handoffs are a platform primitive — no parsing code, no malformed-JSON handling in the harness. |
| **Agents inherit the main-loop model by default** — i.e., Fable. This applies in *both* loops: workflow `agent()` calls, and main-loop `Agent`-tool delegations — including named agent types (Explore, Plan, general-purpose) whose definitions don't pin a model. | ⚠️ **The single most dangerous economic gotcha.** A workflow that omits `model:` on its `agent()` calls runs *every* leaf on the frontier at frontier prices — and a bare Explore recon sweep (the most read-heavy, fan-out-heavy stage in the pipeline) silently does the same. Skill rule: **no delegation, in either loop, without an explicit `model` parameter**; the skill should self-lint for this. Reserve inheritance for the handful of deliberate frontier acts, which should say `model: 'fable'` explicitly anyway so intent is auditable. |
| `isolation: 'worktree'` creates a **fresh worktree per agent call** (auto-cleaned if unchanged). | Unsuitable for a unit's multi-stage pipeline (implement → verify → review → fix must share one working copy). Unit worktrees are hand-rolled: a Haiku agent runs `git worktree add`, and every subsequent stage agent is told the path. §5. |
| `budget` global: hard output-token ceiling shared across main loop + workflows; `agent()` throws once exhausted. | A free enforcement mechanism for "this run may not exceed X tokens" — note it counts *all* output tokens, not frontier-only, so it's a safety rail, not the frontier meter. |

### Still assumed — verify before building

| Assumption | How to verify | Fallback if false |
|---|---|---|
| **A1 — verified 2026-07-10**: workflow agents have full Bash/git/file access, including paths outside the repo (`/tmp`). | Smoke test passed: Haiku agents ran `git worktree add`, committed, and merged across `/tmp` paths. | (not needed) |
| **A2**: No wall-clock ceiling that bites at multi-hour runs (undocumented). Your question (b), the remaining unknown. | Empirical: a long-running dummy workflow (agents sleeping/working for hours). | Size waves conservatively (e.g., ≤3–4h of estimated work), checkpoint per unit to files, resume via `resumeFromRunId` (same session) or state-file wave restart (new session). The design below assumes waves regardless, so this fallback is already built in. |
| **A3 — verified 2026-07-10**: hand-created worktrees are shared cleanly across sequential agents; `--no-ff` merges into a separate integration worktree work. | Smoke test passed end-to-end (agent 1 creates, agent 2 commits, agent 3 verifies + runs a script, agent 4 merges), confirmed against ground truth by direct git inspection. | (not needed) |
| **A4**: Roadmap slices exceeding one run's budget are the exception, not the rule. Your question (c). | Measured during pilot. | Waves + file-checkpointing (§9) handle it either way; the only cost of being wrong is more wave boundaries → more (cheap) main-loop turns and, in the contingent regime, more frontier replans. |
| **A5 — verified 2026-07-10**: explicit `model` overrides land on typed agents (Explore + `model: 'haiku'` ran on Haiku 4.5; in-workflow pins verified too: haiku/sonnet agents each reported their pinned model). Bonus finding: a *bare* Explore ran on **Opus 4.8**, not Fable — in this environment its definition pins a model rather than inheriting. | Probed both variants directly; agents reported the model line from their own system prompts. | The pin-everything rule stands regardless: "definition, else inherit" means the safe default depends on per-environment agent definitions that can change under you. |

### Empirical findings from the smoke tests (2026-07-10) — both hardened into the harness

- **`args` can arrive in the workflow script JSON-stringified.** Destructuring then yields
  `undefined` fields, prompts read `cd undefined`, and everything downstream inherits a
  nonsense location. The harness now parses `args` defensively (`typeof args === 'string'
  ? JSON.parse(args) : args`).
- **Mechanical agents improvise around bad locations and report plausible success.** Given
  the `undefined` path and a loosely-worded prompt, Haiku agents operated on the repo they
  were standing in: created branches, committed, merged — all green, all in the wrong
  repository, with a stray HEAD sha as the only tell. With a fail-loud location preamble,
  the same agent instead reported `ok:false` with the exact error. Two countermeasures,
  both now in the harness and both required: strict cd-first/never-substitute preambles on
  every mechanical prompt, and **zero-token code-side assertions** — the script compares
  each reported worktree HEAD against the expected fork sha before any work proceeds.
  The general lesson for the whole design: **verify *where*, not just *whether*** —
  outcome checks must bind agent reports to expected shas and paths in plain code.

---

## 2. Architecture overview: frontier as architect, code as orchestrator

```
┌────────────────────────────────────────────────────────────────────────┐
│ MAIN LOOP (Claude Code / Fable) — the *slow* heartbeat, metered        │
│   Phase 0: intake, clarify with user (interactive), author Plan Pack   │
│   Between waves: read state.json, replan contingent units, launch next │
│   Session end: final integration review, report, hand-off notes        │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ Workflow({scriptPath: skill's generic harness, args: {planPack, state}})
               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ WORKFLOW SCRIPT (plain JS) — the *fast* zero-token loop                 │
│   • computes ready set from DAG + statuses (pure code)                  │
│   • per ready unit: runUnit(unitSpec)  — pipelined, concurrent          │
│   • serial merge queue onto integration branch (code-sequenced)         │
│   • escalation predicate (code over structured signals)                 │
│   • per-unit checkpoint: Haiku agent writes .roadmap/state.json         │
│   • returns final wave state to main loop                               │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ agent(..., {model: 'opus'|'sonnet'|'haiku', schema})
               ▼
        leaf agents: implement / verify / review / fix / git / compress
        + per-unit Fable architect touchpoints (plan-check, exit gate) — directives, never code
```

**Guaranteed frontier acts:**

1. **Plan Pack authoring** (front, O(1) + small O(U)): decomposition, DAG, frozen
   contracts, per-unit spec skeletons, cross-unit acceptance-test plan, risk tiers, cut
   line. This is where frontier judgment buys the most — everything downstream is cheap
   *because* this is good.
2. **Per-unit architect touchpoints** (O(U), small constants): a **plan-check** before
   implementation and an **exit gate** before merge-ready, both on every unit by default —
   read the plan/diff and evidence, emit directives, never code. §5–6.
3. **Wave replans** (middle, only at output-contingent edges): read a Sonnet-compressed
   checkpoint dossier, revise downstream specs. Zero of these in a fully
   contract-satisfiable roadmap.
4. **Session integration review** (back, O(1)): cross-unit coherence over the integrated
   result — the one judgment no per-unit pass can make.

Everything else frontier-tier is **conditional** (mid-loop rescue consults, §6) and
capped. The economic invariant, stated precisely: it was never really "frontier must be
O(1)" — it's that **frontier must never generate volume**. Reading is 5× cheaper than
writing, and judgment-per-unit is a small constant; what breaks the bank is
frontier-authored code, fixes, and boilerplate. Those stay on Opus at every dial setting.

---

## 3. Decomposition & dependency model

### Intake (split cheap-extract from frontier-judge)

1. **Sonnet normalizer** (free, high volume): ingests the roadmap in whatever form —
   prose, checklist, tracker export, RFC — and emits a candidate structure against a fixed
   schema: candidate work items, stated dependencies, milestones, ambiguities, direct
   quotes anchoring each item to the source. It does *reading*, not deciding.
2. **Codebase recon** (free — Opus, model pinned explicitly): produces a codebase brief —
   module map, test infrastructure, build/test commands, conventions, hot files. Never a
   bare Explore-type agent: typed agents inherit the session model (Fable) unless
   overridden (§1, A5), and recon is the widest fan-out, most read-heavy stage in the
   pipeline — the worst possible place to inherit frontier pricing by accident.
3. **Fable decomposition** (guaranteed, metered): consumes both artifacts (compressed,
   never raw sources unless something is genuinely ambiguous) and authors the Plan Pack.
   Frontier *reads* the cheap extractions and *writes* the judgment: unit boundaries, the
   DAG, contracts, cut line. This split cuts frontier output (and input) substantially vs.
   having Fable chew the raw roadmap itself.
4. **Fidelity audit** (free tier, proportionate, capped): the plan pack is authored from
   *compressed* extractions, and compression loss is silent — with large or multifaceted
   source material, a dropped constraint resurfaces weeks later as a quarantine or a
   wrong contract, never as an error at plan time. Once the plan is drafted, a fan-out of
   Opus auditors — roughly one per source document or per ~40k tokens, capped at ~8,
   skipped only when the source is small enough for the architect to have read whole —
   re-reads the *raw* source against the drafted plan pack and reports, with citations:
   omissions, contradictions, and design constraints or decisions of pertinence left
   unrecorded. The frontier adjudicates each finding (amend the plan / record in
   `constraints.md` / dismiss with a stated reason). Same economics as the exit gate,
   applied to the plan itself: free tier reads uncompressed volume, frontier judges small.
5. **Interactive gate — the last human touchpoint before autonomy.** Because workflows
   take no mid-run input, the intake pass must surface every material ambiguity as
   questions *now*: unclear milestone boundaries, contradictory roadmap statements,
   contracts the user might dispute, audit findings you couldn't adjudicate alone, units
   that look too risky to automate. This is a feature of the economics too: a question
   answered here is an escalation (or a quarantine) avoided later.

### Unit definition and cut heuristics

A **unit** is the smallest chunk that is independently *verifiable*: it compiles, its tests
pass, and it has a crisp done-definition — typically 0.5–2 focused agent-hours. Cut
heuristics, in priority order:

1. **Cut along interfaces, not features.** A unit should sit behind (or implement one side
   of) a contract. If a candidate unit would require touching both sides of an interface,
   either merge the sides into one unit or freeze the interface as a contract first.
2. **Minimize file-overlap between concurrent units.** Predicted files-touched is part of
   each unit spec; two units with overlapping hot files get an ordering edge even if
   semantically independent — textual merge conflicts are the dominant *practical*
   coupling.
3. **Testability defines the boundary.** If "done" can't be expressed as runnable checks,
   the unit is either too big (split) or under-specified (frontier writes the missing
   acceptance criteria, or asks the user).
4. **Risk-tier at plan time.** Each unit gets `risk ∈ {low, med, high}` — high for
   security-sensitive code, subtle concurrency, schema migrations, load-bearing shared
   modules. Risk tier feeds the escalation predicate (§6).

### The DAG: two edge types, per-edge regime

- **Edge types:** `semantic` (B uses A's functionality) and `file-overlap` (B touches A's
  files). Both constrain scheduling; only semantic edges constrain *design*.
- **Per-edge mode:** each semantic edge is classified at plan time:
  - **`contract`** (contract-satisfiable): B needs only A's *interface*. The frontier
    authors that interface now, freezes it in `contracts/`, and B can be fully specified —
    and even implemented — before A merges. Default scheduling: B starts after A merges
    (simple, safe); an optimization flag allows B to build in parallel against the
    contract with stubs, accepting slightly higher integration-gate risk.
  - **`contingent`** (output-contingent): B's *design* needs A's results — measurements,
    discovered constraints, "did approach X pan out". These edges cannot be front-loaded.
    They partition the in-scope DAG into **waves**: everything before the edge runs in
    wave k, then the frontier replans, then wave k+1.
- **Regime detection** is therefore just arithmetic on the classified DAG: zero contingent
  edges inside the cut line → single-wave, fully front-loaded, cheapest shape; otherwise
  the wave count and the frontier replan bill are read directly off the graph. The
  classification itself is frontier judgment (it's exactly the "can I write this interface
  now?" question), done once during planning. The classifier should be conservative:
  misclassifying contingent→contract produces integration failures late; contract→contingent
  merely costs one extra (cheap-ish) replan.
- **File-overlap edges** are computed mechanically after specs exist (predicted file lists
  intersected — pure code) and only impose merge-queue ordering, not design ordering.

### Cut line

The user's "end the session here" is resolved at plan time into an explicit `inScope` set
(ancestor-closed under the DAG). Units beyond the cut line are recorded in the plan but
never instantiated. The frontier also writes a short "notes for the next session" stub per
out-of-scope frontier unit — nearly free while context is hot, valuable later.

---

## 4. Model-tier allocation map & cost shape

| Component | Tier | Rationale (one line) |
|---|---|---|
| Roadmap normalization / extraction | Sonnet | High-volume reading into a schema; no judgment. |
| Codebase recon brief | Opus, explicitly pinned (never bare Explore — §1, A5) | Read-heavy; quality matters for plan accuracy; free *only if the model is named*. |
| Plan-pack fidelity audit (fan-out ∝ source size, capped ~8) | Opus, explicitly pinned | Uncompressed re-read of large source material against the drafted plan; frontier only adjudicates the findings. |
| **Plan Pack: decomposition, DAG, contracts, spec skeletons, risk tiers, cross-unit test plan** | **Fable** | The highest-leverage judgment in the system; O(1) + small O(U) skeletons. |
| Spec expansion (skeleton → full brief: file lists, scaffolding notes) | Sonnet | Boilerplate volume; frontier writes only the judgment-bearing skeleton. |
| Harness: scheduling, ready-set, retries, merge sequencing, predicate evaluation, status | **Code** | Zero tokens; ships with the skill. |
| Worktree/branch setup, git mechanics, test execution, state checkpoint writes | Haiku | Mechanical; needs hands, not brains. |
| Implementation + test writing | **Opus** | Highest-volume generation; strongest free tier minimizes escalation rate. |
| Verification (run tests/lint/build, structure the results) | Haiku | Execute + report. |
| Review (fresh-context, adversarial, against spec + contract) | Opus | Free noise filter so the architect gate reads a polished candidate. |
| Fix generation (incl. applying gate directives) | Opus | High output volume; never frontier. |
| **Architect plan-check** (every unit by default, pre-implementation) | **Opus-first; Fable on escalation / high-risk / infeasible** | Kills wrong approaches before code exists; Opus checks the plan and escalates to Fable (~0.3–0.8k out) only when the call is structural. |
| **Architect exit gate** (guaranteed, every unit) | **Fable** | Reads the *actual diff* + evidence, writes directives (~1–2.5k out); the per-unit steering pass. |
| Dossier compression (logs/transcripts bound for frontier) | Sonnet | Frontier never reads raw logs — but the gate reads the real diff uncompressed (§5). |
| **Mid-loop rescue consult** (conditional, capped) | **Fable, effort low** | For units stuck before reaching the gate; directive only. |
| Merge-conflict resolution | Opus | Contextual judgment, free; uncertainty routes to the predicate. |
| Integration bisect (revert-and-retest search) | Code + Haiku | Pure mechanism. |
| Green-tip mirror advance / preview refresh | Code + Haiku | Pure mechanism; ~1 call per merge (§7.5). |
| Preview exploration (per wave, architect-spawned) | Opus, explicitly pinned | Adversarial runtime driving of the integrated result; findings are evidence, never directives. |
| **Wave replan** (contingent edges only) + feedback-batch triage | **Fable** | Genuine contingent judgment; count is read off the DAG; triage rides the same boundary (§7.5). |
| **Session integration review** | **Fable** | The one guaranteed backstop for cross-unit semantics; O(1). |
| Status/report regeneration (`ROADMAP-STATUS.md`) | Haiku | Rendering. |

### Frontier output-token cost shape (U in-scope units, W contingent wave boundaries, E fired rescues)

```
F(U) ≈ A                    intake judgment + interactive clarification      ~6–15k
     + B·U                  spec skeletons, B ≈ 0.5–1.5k/unit
     + P·(U_high + esc)     Fable plan-checks: high-risk + infeasible units + Opus escalations (Opus-first checks the rest free), P ≈ 0.3–0.8k
     + R·U                  exit gates, R ≈ 1–2.5k/unit incl. delta re-checks
     + C·W                  wave replans, C ≈ 2–5k; W = 0 in the pure-contract regime
     + D·E                  mid-loop rescue consults, D ≈ 0.5–1.5k; E hard-capped
     + G                    session integration review, ~2–4k
     + M                    main-loop dispatch turns, ~1–3k per wave (keep terse by design)
```

Worked example, U=12, single wave, two rescues fired: ≈ 10k + 12k + 6k + 22k + 0 +
2k + 3k + 3k ≈ **~58k frontier output tokens (~$2.90 at Fable's $50/M)**, plus gate
*input* — each gate reads the real diff, 5–30k tokens at $10/M ≈ $0.05–0.30/unit —
landing around **$4–6 per 12-unit arc**. The per-unit frontier term is now guaranteed
rather than conditional (roughly double the demand-gated design's bill), but the property
that keeps it 1–2 orders of magnitude below frontier-driven implementation is unchanged:
**Fable never generates volume.** It reads much (input is 5× cheaper than output),
decides briefly, and every O(volume) term — code, tests, fixes, reviews, logs, retries —
stays on the free tier. The naive alternative, frontier implementing 12 units across
separate human-driven sessions, is plausibly 500k–1M+ frontier output tokens.

Two caveats on "free": the subscription tier is bounded by **rate limits and wall clock**
(16 concurrent agents), so free tokens are not free time — this is why the merge queue is
serial but unit pipelines overlap. And Fable's *input* tokens are metered too; the
Sonnet-compression layer keeps that term small for logs and transcripts — the one
deliberate exception is the exit gate, which reads real diffs, because summaries drop
exactly the oversights the gate exists to catch.

---

## 5. Per-unit workflow template

A function inside the single harness script — not a separate workflow. Parameterized
entirely by the unit spec.

```js
// All model choices explicit — nothing may inherit Fable by accident.
async function runUnit(unit, state, config) {
  // (1) SETUP — Haiku, mechanical. Hand-rolled shared worktree (built-in
  // isolation:'worktree' is fresh-per-agent-call, wrong granularity here).
  const ws = await agent(
    `git worktree add ${unit.worktreePath} -b unit/${unit.id} ${state.integrationTip};
     confirm clean status; report the absolute path.`,
    { model: 'haiku', phase: 'Setup', schema: WORKSPACE });

  // (2) PLAN → ARCHITECT PLAN-CHECK — catch wrong-approach before any code exists.
  let plan = await agent(planPrompt(unit, ws),
    { model: 'opus', effort: 'high', phase: 'Implement', schema: PLAN });
  if (config.planCheckRisk.includes(unit.risk)) {          // default: every risk tier
    const check = await agent(planCheckPrompt(unit, plan),
      { model: 'fable', effort: 'low', phase: 'Architect', schema: PLAN_VERDICT });
    if (check.verdict === 'redirect')
      plan = await agent(revisePlanPrompt(unit, plan, check.guidance),
        { model: 'opus', effort: 'high', phase: 'Implement', schema: PLAN });
    else if (check.verdict === 'quarantine')
      return quarantine(unit, ws, check);
  }

  // (3) IMPLEMENT — Opus, against the approved plan + frozen contracts.
  let impl = await agent(implementPrompt(unit, ws, plan), {
    model: 'opus', effort: 'high', phase: 'Implement', schema: IMPL_RESULT });

  // (4) VERIFY → REVIEW → FIX loop, bounded. The free Opus review filters noise so
  // the metered architect gate below reads a polished candidate, not a first draft.
  let verify, review;
  for (let round = 0; round <= config.maxFixRounds /* K=2 */; round++) {
    verify = await agent(verifyPrompt(unit, ws),              // run tests/lint/build
      { model: 'haiku', phase: 'Verify', schema: VERIFY_RESULT });
    review = await agent(reviewPrompt(unit, ws, verify),      // fresh context, adversarial
      { model: 'opus', effort: 'high', phase: 'Review', schema: REVIEW_RESULT });
    if (verify.pass && review.blocking.length === 0) break;

    // (E) MID-LOOP RESCUE — conditional; pure code over objective signals. §6.
    let directive = null;
    if (shouldRescue(unit, round, verify) && state.consultsUsed < config.maxConsults) {
      state.consultsUsed++;
      const dossier = await agent(compressPrompt(unit, verify, review, impl),
        { model: 'sonnet', phase: 'Escalate', schema: DOSSIER });
      directive = await agent(consultPrompt(unit, dossier),   // decision, not code
        { model: 'fable', effort: 'low', phase: 'Escalate', schema: DIRECTIVE });
      if (directive.action === 'quarantine') return quarantine(unit, ws, directive);
    }
    impl = await agent(fixPrompt(unit, ws, verify, review, directive),
      { model: 'opus', effort: 'high', phase: 'Fix', schema: IMPL_RESULT });
  }
  if (!verify.pass) return quarantine(unit, ws, verify);

  // (5) ARCHITECT EXIT GATE — guaranteed, every unit. Fable reads the ACTUAL diff
  // (not a summary: the small oversights this gate exists to catch live in the diff
  // details), plus spec, contract, and verify evidence. Emits directives, never code.
  // Re-check rounds read only the delta diff since the previous gate pass.
  for (let g = 0; g < config.maxGateRounds /* G=2 */; g++) {
    const gate = await agent(gatePrompt(unit, ws, verify, review, g),
      { model: 'fable', effort: config.gateEffort, phase: 'Architect', schema: GATE_VERDICT });
    if (gate.verdict === 'approve')
      return { unitId: unit.id, status: 'merge-ready', branch: `unit/${unit.id}` };
    if (gate.verdict === 'quarantine') break;
    await agent(fixPrompt(unit, ws, verify, review, gate),    // Opus applies the directives
      { model: 'opus', effort: 'high', phase: 'Fix', schema: IMPL_RESULT });
    verify = await agent(verifyPrompt(unit, ws),
      { model: 'haiku', phase: 'Verify', schema: VERIFY_RESULT });
  }

  // (Q) BOUNDED GIVE-UP — never loop forever.
  return quarantine(unit, ws, { reason: 'gate-not-converged' });
}
```

Top-level shape — event-driven scheduler, merge queue serialized by an in-script promise
chain, checkpoint after every status change:

```js
export const meta = { name: 'roadmap-wave', description: 'Execute one wave of the roadmap plan',
  phases: [{title:'Setup'},{title:'Implement'},{title:'Architect'},{title:'Verify'},{title:'Review'},
           {title:'Fix'},{title:'Escalate'},{title:'Merge'},{title:'Quarantine'}] };

const { plan, state, config } = args;               // main loop passes persisted state in
let mergeChain = Promise.resolve();                  // serial merge queue
const done = new Map(Object.entries(state.units));

async function launchReady() {
  for (const u of readyUnits(plan, done)) {          // pure code: DAG + statuses + overlap edges
    markRunning(done, u);
    runUnit(u, state, config).then(res => {
      done.set(u.id, res);
      if (res.status === 'merge-ready')
        mergeChain = mergeChain.then(() => mergeUnit(u, res, state, config));  // §7
      checkpoint(done);                              // Haiku writes .roadmap/state.json + commits
      return launchReady();                          // unblock dependents immediately
    });
  }
}
await launchReady();
await allSettled(done); await mergeChain;
return serializeState(done, state);                  // main loop persists the wave result
```

Notes:

- **Fresh reviewer context is deliberate.** The reviewer sees spec + contract + diff, not
  the implementer's transcript — it can't inherit the implementer's rationalizations. And
  the Opus review is not redundant with the Fable gate: it's the free noise filter that
  lets the gate spend its metered attention on a candidate that already builds, passes
  tests, and has no obvious defects.
- **Gate economics ride on input, not output.** The gate reads the real diff (5–30k input
  tokens at $10/M ⇒ $0.05–0.30/unit) and writes short directives (~1–2k output).
  Summarizing the diff for a **forced** gate (high-risk, contract-touching, `always-fable`)
  is a false economy — the oversights it exists to catch are exactly what summaries drop, so
  those keep the full-diff read at `gateEffort`. An **audit-only** gate (fired solely by the
  `gateAuditRate` sample) is the deliberate exception: its job is anti-rubber-stamp sampling,
  not exhaustive re-grading, so it reads `git diff --stat` + spec + prior verify/review
  evidence first at the cheaper `auditEffort`, expanding to full diffs only where a violation
  would be consequential and the moment anything looks off. Re-check rounds read only the
  delta diff.
- **Resume-friendliness:** all prompts are deterministic functions of the plan pack
  (stable unit IDs, no timestamps), so `resumeFromRunId` replays completed units from the
  journal at zero cost after a mid-run failure.
- Genuinely structurally-different units (e.g., "write a design doc", "run a migration
  against staging") get a `unit.kind` that selects a different stage list from a small
  library in the skill — still code-selected, never frontier-authored per run.

---

## 6. Verification & escalation ladder (the spend dial)

Operating experience says Opus gets a unit ~90% there and leaves small oversights that need
frontier re-steering. That first justified a **guaranteed** per-unit Fable gate; it now
justifies an **Opus-first gate with a retained frontier safety net** (rung 4) — the same
insight, spent more carefully. The ladder, cheapest rung first; each rung exists to make the
next rung's attention cheaper:

1. **Machine checks** (free, Haiku-executed): build, tests, lint, contract-surface diff.
2. **Opus review** (free): adversarial, fresh-context; filters the noise so frontier
   attention lands on a polished candidate.
3. **Opus fix rounds** (free): bounded at K.
4. **Exit gate — Opus-first, escalate to Fable** (rungs 4a/4b):
   - **4a. Opus exit gate** (free, every non-forced unit): a fresh adversarial Opus grades
     the acceptance criteria and either approves, self-revises (a mechanical fix it can
     specify, bounded at G), or **escalates**. It escalates only on a call Opus can honestly
     self-assess: *stuck*, *hard trade-off* (every option carries a substantive drawback),
     or *architecturally foundational*. It cannot self-assess hidden correctness oversights —
     so it is not asked to.
   - **4b. Fable architect gate** (metered): reads the actual diff + spec + evidence; emits
     `{approve | directives | quarantine}`, bounded at G. Reached by Opus escalation, by Opus
     non-convergence, or unconditionally when `forceFrontier` holds — `exitGate:
     'always-fable'`, `risk: high`, a contract-touching diff, or the deterministic
     `gateAuditRate` audit sample. This is where the guaranteed frontier pass is *retained*,
     concentrated on the units whose undetected oversights cost the most; the rest are
     backstopped systemically at the between-wave health check (§6.6), not per-unit.
   Their sibling, the **plan-check** (same architect, before implementation, default every
   unit), catches wrong-approach before Opus writes code — one cheap redirect at plan time
   saves a full fix cycle at the gate, and quality up front is what keeps the gate convergent
   at all. It stays guaranteed: cheap, pre-code, and Opus cannot check its own approach as
   impartially as it can grade a finished diff.
5. **Mid-loop rescue consult** (metered, conditional, capped): for units that get *stuck*
   before ever reaching the gate. The predicate is pure code over objective signals only:

   ```js
   function shouldRescue(unit, round, verify) {
     return (!verify.pass && round >= config.maxFixRounds)   // fixes exhausted, still red
         || verify.contractSurfaceTouched;                    // git diff ∩ contracts/ ≠ ∅
   }
   ```

   The reviewer-confidence triggers a purely demand-gated design would need are gone — the
   guaranteed gate subsumes them. What remains is objective and code-checkable; no model is
   ever asked "do you need help?".
6. **Quarantine** (free): defer to wave replan / session report — the redesign path.

### The spend dial, reframed

With the gate guaranteed, the dial no longer controls *whether* frontier looks at a unit —
it controls **how much frontier attention each unit gets**, all as auditable numeric
config:

```
{ maxFixRounds: K = 2,            // free polish before metered attention
  maxGateRounds: G = 2,            // gate directive→fix→re-check cycles before quarantine
  planCheckRisk: ['low','med','high'],  // which tiers get *any* plan-check — default every unit
  planCheck: 'opus-first',         // 'opus-first' (Opus checks, escalates) | 'always-fable'
  exitGate: 'opus-first',          // 'opus-first' (Opus grades, escalates) | 'always-fable'
  gateAuditRate: 0.10,             // fraction of Opus-approved units still Fable-audited
  gateEffort: 'medium',            // effort on forced Fable gate calls ('high' for risk:high)
  auditEffort: 'low',              // effort on audit-only Fable gates (diff-stat-first)
  maxConsults: E = ⌈U/4⌉ }         // mid-loop rescue budget
```

`planCheck`/`exitGate: 'opus-first'` with a low `gateAuditRate` spends the least frontier;
`planCheck`/`exitGate: 'always-fable'` restores the guaranteed-check/guaranteed-gate design.
Turning the rest down (G=1, plan-check high-risk only, gateEffort low) approaches the old
demand-gated design's cost; turning it up (gateEffort high, larger G) buys more scrutiny.
But note where extra budget actually pays off: mid-development steering has proven
unnecessary when the plan is right, and no amount of gate depth rescues a bad plan — so
marginal frontier spend goes to the *planning* side (spec detail, plan-checks, phase-0
interrogation), not to more mid-flight touchpoints.

The invariant that survives at every setting: **frontier decides; Opus writes.** Gate and
consult outputs are schema-bound directives (`{action, guidance, contractAmendment?}`),
never code; the same separation governs the integration review and wave replans. Contract
amendments remain the one dangerous output — recorded in state and replayed to the session
integration review, since an amended contract can invalidate assumptions of already-merged
units. Compression policy: logs and transcripts bound for frontier are Sonnet-compressed;
the diff under judgment is not (§5).

**Guaranteed vs conditional frontier:** guaranteed = plan pack, the Fable plan-check for
high-risk and claimed-infeasible plans (Opus-first plan-check for the rest), the Fable exit
gate for `forceFrontier` units (`risk: high`, contract-touching, audit sample) + wave replans
(count fixed by the DAG) + session integration review. Conditional = the Fable plan-check on
Opus escalation, the Fable exit gate for low/med units (only on Opus escalation or
non-convergence), mid-loop rescues, and integration-failure consults (§7, same cap pool).
Nothing else may run on Fable — in particular the between-wave health check and debt
assessment (§6.6) are **Opus**, not frontier.

### Feedback topology: bookends, not babysitting

The steering model generalizes to a named principle: the orchestrator is a source of
feedback **at the beginning (plan-check) and the end (exit gate) — never the sole source
of feedback throughout**. What makes the middle safe to leave alone is planned
self-sufficiency: each unit is dispatched with everything it needs to *evaluate its own
output*, not just produce it — runnable acceptance checks, a provisioned environment, the
brief's commands, runtime-evidence requirements. Planning a unit's self-validation is part
of planning the unit; a unit that can't check itself is a spec defect, not an execution
risk. The known trap in self-checking is **decorative tests** — green checks from tests
that would not fail if the behaviour were actually wrong (tautological assertions, mocks
that mock away the subject) — so the reviewer is explicitly charged with applying the
would-this-fail test to every new test, empirically when unsure (plant a bug, confirm red,
restore), and the gate treats such tests as its business. A green check is evidence only
if the check could fail.

**Widening the bookends' evidence, not adding touchpoints.** Bookends-not-babysitting
constrains *when* frontier feedback happens, never *what evidence* it may read. The
continuous preview and the accumulated feedback batch (§7.5) add zero touchpoints:
evidence flows in continuously — an Opus explorer exercising the integrated runtime each
wave, the user dropping notes whenever they like — but judgment over it happens only at
boundaries that already exist (wave replan, session integration review), exactly as
quarantine dossiers already do. Steering — feedback flowing *into* in-flight units
mid-run — remains rejected: no path exists from a finding to a running unit, and no new
frontier touchpoint may be created to read the batch sooner.

### 6.6 Systemic quality: the debt ledger and the between-wave health check

Two quality failures are invisible to a per-unit pipeline, and both compound. First, agents
consciously leave "minor" issues behind — a shortcut, a thin test, a known-suboptimal
structure — and nothing recorded them: the reviewer's non-blocking and pre-existing findings
were computed and thrown away. Second, a *less visible* debt accumulates across waves — tests
turn slow or brittle (intermittently failing), files bloat, duplication creeps in, dev steps
that should be automated stay manual — and each round inherits the drag. A unit tasked with a
narrow requirement has neither the remit nor the vantage to fix either; the root architect
does, and must, or the build slows to a crawl while every individual gate stays green.

Two mechanisms, both riding the existing bookends (no new frontier touchpoints, no mid-run
steering):

- **Debt ledger** (`.roadmap/debt.md`, living). Producers already forming quality opinions —
  the implementer, the reviewer (its `nonBlocking`/`preExisting`), both exit gates, and the
  health assessor below — emit structured `debt` items instead of discarding them. The
  harness returns the wave's items in state; the architect triages them at the boundary
  (promote to a fix unit, or append to the ledger). Unlike feedback, debt is **durable**: it
  carries across waves and arcs and is read at Phase 0 as candidate scope, so a later
  dynamic wave mops it up. This is the same "evidence accrues, judgment at boundaries"
  discipline as feedback, with a forward-carrying store instead of a consumed one.
- **Between-wave health check** (Opus, architect-spawned, `healthCheck: 'each-wave'`). The
  code/test/structure counterpart to the runtime explorer: it reads the integration tip for
  test brittleness and coverage gaps, structural drift (oversized files, misplacement),
  **cross-unit consistency** (units that independently reinvented a helper or diverged on the
  pattern for the same task — the drift the isolate-and-parallel design manufactures and no
  per-unit gate can see, since siblings never observe each other), and ergonomics
  (un-automated steps). Intermittent failures — the sharpest form of brittleness, and the one
  a single run hides — are caught mechanically: Haiku re-runs the full suite `flakeReruns`
  times and any pass↔fail flip is a brittleness item. The assessor is **empowered, not merely
  advisory**: for each finding worth fixing it drafts a ready-to-dispatch consolidation
  fix-unit spec, and those drafts **default into the next wave** at triage unless the
  architect cuts them — the counter to findings dying unactioned in a folder. This does not
  breach the no-mid-run-steering rule: the drafts gate nothing mid-wave and reach no running
  unit; they are admitted only at the boundary the architect already owns, and run the same
  isolation → gate → merge pipeline as any unit. It is **Opus, not Fable** — assessment and
  drafting are voluminous reading/writing, not frontier judgment; the *decision* about what to
  admit stays the architect's at the boundary, now expressed as a veto over noise rather than
  authoring each fix from scratch.

These are also what makes the Opus-first exit gate (rung 4) affordable: cheaper per-unit
gating is backstopped by a systemic pass that catches the accumulating and the intermittent —
the failure modes a per-unit frontier gate was never well-placed to see anyway.

---

## 7. Integration strategy

Three layers, ordered by cost-effectiveness:

**Layer 1 — Prevention (plan-time, frontier, O(1)-ish).** The plan pack freezes shared
interfaces in `contracts/` (types, API signatures, schemas, error/ownership conventions)
before any unit starts. Units treat contracts as immutable; any diff touching
`contracts/` auto-fires the predicate. Interface contracts bind units *pairwise on a seam*;
a single **standing conventions contract** (`contracts/conventions.md`, `plan.conventions`)
binds *all* units at once — a shared-utility catalog they must reuse and the naming/error/
pattern conventions they must follow — and the harness threads it into every unit's
implement/review/gate so it is enforced, not merely documented. Its reach is proactive and
therefore bounded: it binds against the shared surface that exists *now*, so it cannot stop
two concurrently-built units from independently adding the same new helper. That
sibling-reinvention residual is exactly what the between-wave cross-unit consistency check
(§6.6) exists to catch — prevention where prevention is possible, detection for the rest. The plan also specifies a small **cross-unit
acceptance-test plan** targeting the seams between units — Fable writes the *plan* (which
interactions to exercise, ~1–2k tokens), a Sonnet/Opus unit (scheduled first, cheap)
writes the actual tests. This converts "cross-unit semantic incompatibility" from an
invisible failure into a failing test at layer 2 — which is the entire game, because the
strawman is right that no unit-level agent can see it.

**Layer 2 — Serial merge queue + post-merge gate (code + free tier, per merge).**
Merge-ready branches integrate one at a time onto an **integration branch** (never
directly onto main — the session's output is one reviewed branch; main advances once, at
the end, after the final gate):

1. Haiku rebases `unit/X` onto the integration tip.
2. Textual conflicts → Opus resolver with both sides + both specs + the contract; the
   resolver emits a confidence signal into the same escalation predicate.
3. Haiku runs the full suite (unit + cross-unit acceptance tests) on the integrated
   result.
4. Green → advance tip, checkpoint. Red → **mechanical bisect first** (code logic: retest
   without the new unit to distinguish "new unit broke integration" from flake/stale-base;
   revert-candidate search across recent merges if needed — all Haiku executions), then an
   Opus diagnosis+fix attempt with both units' specs in context, then — only if that fails —
   a Fable consult from the shared cap, then quarantine of the offending unit (its branch
   survives; the queue continues).

Ordering: topological (semantic edges) → file-overlap edges → smallest-diff-first among
remaining ties (merges the cheap conflicts while the base is freshest; conflict
probability grows with accumulated drift, so don't let big diffs stew).

**Layer 3 — Session integration review (frontier, O(1), guaranteed).** After the wave's
queue drains: Fable reads a Sonnet-compressed integration dossier — per-unit diff
summaries, contract deltas + any mid-run amendments, test-suite deltas, quarantine list —
and judges *jointly-broken-though-locally-valid* risks: semantic drift between units,
contract amendments that undercut earlier merges, missing seam coverage. Output: a short
verdict + directives handed to Opus fixers (or folded into the next wave's plan). Because
every unit already passed an architect gate, this review no longer re-litigates unit
quality — it is purely cross-unit (seams, amendments, joint behavior), which keeps it O(1)
and small as U grows. This is where the *integration*-level guaranteed frontier pass lives
— once per session, not once per merge.

---

## 7.5. Continuous preview & accumulated feedback

The gate's named residual (§12, risk 3) is that it judges artifacts, not behavior. This
layer attacks the residual directly, with three parts — none of them a new frontier
touchpoint.

**The green-tip mirror (code + Haiku, ~1 call per merge).** When the plan pack carries a
`preview` block (planned at Phase 0 like `provision`: kind server/cli/api, start/refresh
recipe, `howToAccess`, healthcheck — the self-validating-units ethic scaled up: units
check themselves, the *arc* is demonstrable while it integrates), the harness detaches
the **primary checkout** at the integration tip and advances it after each suite-green
merge on a coalescing, latest-wins chain the merge queue never waits for. The user
watches from their own repo and provisioned environment; the preview only ever shows
real, suite-green states — never mid-merge trees, conflict markers, or reverted
half-states, which is precisely the noise a naive "watch the integration branch" design
would inject into the feedback batch. `main` never moves (detached HEAD, invariant 5
intact), and the merge plumbing stays in its own worktree: user git activity can at worst
stale the mirror (one detach-checkout heals it), never derail the queue. The mirror is
**observability, never a gate** — any preview failure logs, marks `preview.status:
"failed"`, and the wave continues; no unit outcome may depend on it.

**Per-wave adversarial exploration (Opus, free tier).** Between waves — after the queue
drains, when judgment returns to the architect anyway — the architect spawns one pinned
Opus explorer against the preview. Its charter is exclusively *runtime behavior*: the
diff, tests, and gates already judged the code, so it re-reviews nothing; it drives the
integrated thing the way a skeptical user would — flows end to end, edge cases, hostile
inputs, broken sequences — hunting behavior that is unexpected, counterintuitive,
underdocumented, brittle, or misaligned with the specs' intent. Findings are capped
(~10), carry severity + exact repro + observed-vs-expected + the sha observed, and are
persisted by a Haiku verbatim-writer to `.roadmap/feedback/explorer/`. Per-merge
exploration was considered and rejected: N explorations of overlapping partial
integrations produce duplicate findings, and duplicates are metered frontier *input* at
triage — the one cost this design protects.

**The feedback batch (triage rides existing boundaries).** Explorer findings and user
notes (`.roadmap/feedback/user/` — auto-created at Phase 0 with a pro forma template,
announced at dispatch, writable at any time) are never actioned on arrival. At the next
wave replan the architect triages the batch — fold into revised specs, cut fix units into
the next wave, treat contract-contradicting feedback as a contract-amendment decision
(recorded, re-examined at the integration review), or dismiss with a stated reason —
exactly the path quarantine dossiers already travel. Consumed items move to
`feedback/triaged/<wave>/`; large batches are Sonnet-compressed first; findings observed
at a superseded sha are discounted. Feedback still pending at session end feeds the
integration review and the report, then archives with the arc. Economics: the mirror is
one Haiku call per merge; exploration is Opus (free tier); triage is frontier but rides
an already-guaranteed boundary — ~0.5–2k output tokens folded into the §4 `C·W` term, no
new term in the cost shape.

---

## 8. Failure & quarantine handling

- **Runaway prevention is structural**: every loop in the system is bounded by plan-time
  constants — K fix rounds per unit, E consults per run, one integration fix attempt per
  merge failure, the platform's own 1000-agent ceiling as the outermost backstop. There is
  no unbounded "retry until green" anywhere.
- **Quarantine is a first-class terminal state, not an error**: branch + worktree
  preserved; a Sonnet dossier (what was attempted, what failed, best hypothesis, exact
  repro) written to `.roadmap/quarantine/<unit>.md`; dependents handled per edge mode —
  contingent dependents block; contract dependents may proceed against the frozen contract
  with a `builtAgainstQuarantined` flag that the integration review is told about.
- **Partial-arc completion is the normal success mode**: the session report states plainly
  — merged: N, quarantined: M (with dossiers), deferred beyond cut line: P. An integration
  branch with 10 of 12 units merged and 2 well-documented quarantines is a good outcome,
  and better than 12 of 12 with a forced-through incoherent merge.
- **Re-entry**: quarantined units are inputs to the next frontier planning act (next
  wave's replan, or the next session's plan pack). Frontier options: split the unit,
  revise its contract, respec, raise its consult budget, or mark it human-required. It
  re-enters as a *new* unit spec — never re-looped under its failed spec, which is what
  distinguishes re-design from retry.

---

## 9. Cross-run execution: waves, checkpointing, resume

Two nested persistence mechanisms with different lifetimes:

- **Intra-run (same session):** the workflow journal. Deterministic script + stable unit
  IDs ⇒ `resumeFromRunId` replays completed `agent()` calls free after a crash or a
  deliberate stop. Same-session only — an optimization, never the source of truth.
- **Cross-run/session (durable):** `.roadmap/state.json`, updated by a Haiku checkpoint
  agent after every unit status change and committed on an orchestration branch. Any
  future session reconstructs the entire arc from the repo alone.

**Wave protocol** (one main-loop turn per boundary, deliberately terse):

```
read .roadmap/{plan.json,state.json}
  → if contingent boundary crossed or quarantines exist: Fable replan (revise specs / respec quarantined / stop)
  → else: pure dispatch, no frontier judgment
  → Workflow({scriptPath: harness, args: {plan, state, config}})   // background
  → on completion notification: persist returned state, regenerate status doc (Haiku), loop or finish
```

Wave sizing: the ready frontier of the DAG, capped by config (default ~12–16 units — one
concurrency-generation) and by A2's wall-clock caution. If a run dies un-resumably, the
next wave recomputes the ready set from file state — units already merged to the
integration branch are simply done; an in-flight unit's worktree is reset and the unit
re-runs (idempotent by construction: branch-per-unit, serial integration).

**"End the session here" across waves:** the cut line lives in the plan, so the scheduler
can never launch beyond it regardless of how many waves execute. The final wave's
completion triggers the session-end sequence: integration review → report → (with user
confirmation) fast-forward main.

---

## 10. State & schema

Everything under `.roadmap/` (committed; the plan *is* a reviewable artifact):

```
.roadmap/
  plan.json            # the DAG (below)
  contracts/*.md       # frozen interfaces — diffs against these are predicate triggers
  specs/<unit>.md      # frontier skeleton + sonnet expansion
  state.json           # single mutable file (below)
  quarantine/<unit>.md # dossiers
  feedback/            # runtime evidence awaiting batch triage (§7.5)
    explorer/*.md      #   per-wave exploration findings
    user/*.md          #   user notes, droppable any time (TEMPLATE.md pro forma)
    triaged/<wave>/    #   consumed items — never re-triaged
  ROADMAP-STATUS.md    # regenerated view, never hand-edited, never re-parsed by a model
```

```jsonc
// plan.json — written once per frontier planning act, append-only revisions
{ "version": 3, "cutLine": "milestone-2",
  "units": [{
     "id": "auth-token-rotation", "kind": "code", "title": "...",
     "specPath": "specs/auth-token-rotation.md", "risk": "high",
     "filesTouched": ["src/auth/*.ts"], "acceptance": ["cmd: npm test -- auth"],
     "inScope": true
  }],
  "edges": [{ "from": "auth-core", "to": "auth-token-rotation",
              "type": "semantic", "mode": "contract",
              "contract": "contracts/token-provider.md" }],
  "config": { "maxFixRounds": 2, "maxGateRounds": 2, "planCheckRisk": ["med","high"],
              "gateEffort": "medium", "maxConsults": 3, "waveCap": 14 } }
// planCheckRisk defaults to all tiers — omit tiers only to trade plan quality for speed

// state.json — the only mutable state; every field machine-written
{ "integrationBranch": "roadmap/session-2026-07-10", "integrationTip": "<sha>",
  "consultsUsed": 2, "wave": 1,
  "units": { "auth-core": { "status": "merged", "branch": "unit/auth-core",
                            "rounds": 1, "escalations": 0, "mergedAt": "<sha>" },
             "auth-token-rotation": { "status": "quarantined",
                                      "dossier": "quarantine/auth-token-rotation.md" } } }
// status ∈ pending | running | merge-ready | merged | quarantined | blocked | deferred
```

**Schema-bound handoffs** (every `agent()` call uses `schema:`; the platform validates and
retries, so the harness never parses prose):

- `IMPL_RESULT`: `{filesChanged[], testsAdded[], notes, openQuestions[]}`
- `VERIFY_RESULT`: `{pass, failures[{check, output}], contractSurfaceTouched}`
- `REVIEW_RESULT`: `{blocking[{summary, file, line, category, confidence}], nonBlocking[], specConformance}`
- `MERGE_RESULT`: `{merged, conflicts[], resolverConfidence, suiteResult}`
- `PLAN` / `PLAN_VERDICT`: Opus implementation plan; architect's `{verdict, guidance}`
- `GATE_VERDICT`: `{verdict: approve|revise|quarantine, directives[{summary, file, guidance, severity}]}`
- `DIRECTIVE` (frontier consult): `{action, guidance, contractAmendment?}`
- `DOSSIER`: `{context, attempted, evidence, hypothesis}`

The parse-once principle holds throughout: prose is read by a model exactly once (intake);
every subsequent decision runs over these structures in plain code.

**Lifecycle.** `.roadmap/` is arc-scoped working state with two exceptions
(`constraints.md` and the decision notes are *living documents* that survive arcs). At
session close-out the arc's artifacts are archived to `.roadmap/archive/<arc>/`, merged
unit branches and worktrees are pruned, and the integration branch is deleted after `main`
advances. Contracts retire with their arc — post-merge, the code and its tests are the
source of truth, and a later arc freezes fresh contracts rather than inheriting zombies.
The presence of a top-level `state.json` is the mechanical "arc in flight" marker: the
skill resumes (or asks) rather than planning over it, which is what prevents the nastiest
failure — a new arc silently forking worktrees from a dead `integrationTip`.

---

## 11. Skill interface

```
/roadmap-orchestrate <roadmap files/paths/URLs...> --until "<milestone or unit description>"
                     [--config k=v ...] [--dry-run] [--resume]
```

- **Phase 0 is conversational** — the only interactive window. The skill instructs the
  main loop to: run intake, present the decomposition + DAG + cut-line interpretation +
  contract list for approval, ask its batched clarifying questions, then go autonomous.
  `--dry-run` stops here, leaving `.roadmap/` as a reviewable plan artifact.
- **Progress**: the live `/workflows` view (phases map to Setup/Implement/Verify/…);
  `ROADMAP-STATUS.md` regenerated by Haiku at each checkpoint for a durable glanceable
  view; completion/quarantine push notifications from the main loop between waves.
- **Session end deliverable**: the integration branch (main untouched until confirmed), the
  session report (merged / quarantined / deferred, consult spend, integration-review
  findings), and next-session notes. `--resume` in a later session rebuilds from
  `.roadmap/` state and continues past the previous cut line.

---

## 12. Risks & where it breaks at scale — and what to prototype first

Ranked by how much of the design's value each can destroy:

1. **Decomposition quality is the whole ballgame.** Bad cut points → overlapping units →
   conflict storms → escalation storms → the economics collapse into quarantine-everything
   or consult-everything. Everything downstream amplifies plan quality, good or bad.
   *De-risk first, and cheaply:* run only the intake + plan phase on 2–3 real roadmaps for
   real codebases and score the plans mechanically — file-overlap between concurrent
   units, spec completeness, contract plausibility — before building any execution
   machinery.
2. **Gate convergence is a function of plan quality — measure the coupling.** Operating
   experience settles the steering model: post-hoc gating suffices and mid-development
   steering is unnecessary *when the up-front plan is good*. That makes gate convergence a
   downstream indicator of risk #1 rather than an independent unknown: a unit needing more
   than G gate rounds is evidence its spec or plan was under-specified, not that the gate
   shape is wrong. The tuning loop this implies is "improve the plan pack," never "add
   steering touchpoints." *Prototype second:* 5 units end-to-end, measuring gate rounds to
   approval against spec quality, and post-merge re-steering incidents on gated units.
3. **What the gate can't see from a diff.** The guaranteed per-unit Fable gate removes the
   old correlated-blind-spot problem (an uncorrelated judge now reads every unit), but a
   gate judges *artifacts*, not *behavior* — runtime characteristics, UX feel, and
   emergent interactions don't live in a diff. Mitigations: the verify stage attaches
   runtime evidence to the gate dossier (test output; for user-facing units, a scripted
   run or screenshot), and genuinely behavior-sensitive units get `risk: high`, which
   raises gate effort and makes runtime evidence mandatory in the dossier. The continuous
   preview (§7.5) attacks the residual directly: an Opus explorer exercises the
   *integrated* runtime each wave and the human can watch mid-stream, with findings
   entering the architect's evidence at the next boundary — the residual shrinks from
   "runtime behavior is invisible until session end" to "runtime behavior is judged one
   boundary late."
4. **The test suite is the integration gate's ground truth.** A weak suite makes layer 2
   vacuous and pushes everything onto the O(1) frontier review, which cannot carry it.
   Mitigation: plan pack must assess suite strength during recon and budget test-writing
   units first when it's thin. If the codebase has no meaningful tests, say so at phase 0
   and shrink the cut line.
5. **Stale-base conflict growth.** Within a wave, all worktrees fork from the wave-start
   tip; the last units to merge rebase across everything before them (~O(N²) pairwise
   conflict exposure). Mitigations: small units, overlap-aware ordering, waveCap, and
   merging promptly as units finish rather than batching at wave end (the pipelined
   `mergeChain` above does this).
6. **Wall clock, not tokens** (concurrency 16, serial merge queue, flaky tests retrying at
   the gate). Flake detection (Haiku retry-once-and-compare) is cheap insurance; A2's
   ceiling unknown is absorbed by waves.
7. **Contract drift** — an implementer "improving" a frozen interface mid-unit. The
   mechanical `contracts/`-path trigger catches the honest case; the dishonest case
   (semantic drift without touching the contract file) is risk #3 again, caught only at
   the gate or the final review.
8. **Ambiguity discovered mid-run** with no human available (the platform's no-mid-run-input
   constraint). The design converts these into quarantines rather than guesses — correct
   but wasteful if frequent; the fix is a better phase-0 interrogation, which is a prompt
   問題, not an architecture problem.
9. **Preview process lifecycle.** A crashed harness leaks a running dev server. Mitigated
   by the pidfile convention (`worktreeRoot/__preview.pid`) and kill checks at Phase 0,
   resume, and close-out; the residual — ports, containers, or side processes a `stop`
   command doesn't cover — is owned by whoever writes the preview recipe at Phase 0.
10. **Explorer/gate duplication.** Findings that restate what gates already judged burn
    metered triage input. Mitigated by the explorer's runtime-only charter (it is told
    the diff and tests were already judged), the findings cap, and cheap dismissal at
    triage.
11. **Feedback vs frozen contracts.** A user note may demand what a contract forbids.
    That is a contract-amendment decision for the architect at triage — recorded in
    state, re-examined at the integration review (invariant 4) — never something the
    explorer or a fix unit acts on directly.
12. **Mirror divergence.** The user is invited into the primary checkout, so their git
    activity will occasionally collide with the mirror. By construction it breaks only
    the mirror — a refused detach-checkout (user-dirtied tracked file) logs and leaves
    the mirror stale; one clean checkout heals it — and never the merge queue, which
    lives in its own worktree.

**Prototype order:** (1) plan-only on real roadmaps → (2) 5-unit end-to-end for gate convergence → (3)
merge-queue + gate under deliberately-conflicting units → (4) checkpoint/resume kill
tests. Each step invalidates or tunes the design before the next layer is built.

---

## The single most important open question

**Can the frontier planning pass, working cold from an arbitrary unstructured roadmap and
an unfamiliar codebase, consistently produce specs and plans good enough to keep the exit
gate convergent — without the interactive iteration that produced the existing operating
experience?**

The steering model is settled: post-hoc gating suffices, mid-development steering is
unnecessary, and quality up-front planning is what makes both of those true. Which
concentrates the entire system's risk in one act — the plan pack. The evidence that "good
planning defeats the need for mid-flight steering" comes from sessions where a human
(with a frontier model) iterated the plan interactively; the skill must reproduce that
plan quality from cold inputs, with only the phase-0 question window for human contact.
If it can, everything downstream is mechanical and the economics hold. If it can't, the
fix is still not mid-flight steering — it's a heavier planning phase (a Fable red-team
pass over its own decomposition, plan-pack self-review, more aggressive phase-0
interrogation), which stays read-heavy and O(U)-cheap. Conveniently, this makes the first
prototype the decisive one: generate plan packs for 2–3 real roadmaps and judge whether
those specs would have kept past units' gates convergent — no execution machinery needs to
exist to answer the question that determines whether it's worth building.
