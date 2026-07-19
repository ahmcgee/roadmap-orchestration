# Orchestrate evals

End-state-graded regression tests for `harness.mjs`, `conductor.mjs`, and their architect prompts.
A silently drifted gate (rubber-stamping bad diffs, or over-blocking good ones) or a mis-routed
conductor boundary is the highest-leverage failure in a plan→merge pipeline, and nothing downstream
detects it — so this directory is the "done" gate for any harness- or conductor-adjacent change
(invariant 6).

## The three-layer ladder

Each layer is cheaper and less faithful than the one below it. Climb the whole ladder before
shipping; never ship on an upper rung alone.

1. **`parse.sh` — syntax. Token-free, milliseconds.** Loads every `*.mjs` under an `AsyncFunction`
   wrapper (plain `node --check` chokes on a workflow script's legal top-level `return`) with the
   workflow globals stubbed. Non-zero exit if any script fails to parse.
2. **`unit/` — control-flow simulations. Token-free, milliseconds.** `load.mjs` compiles a script
   under the same wrapper and drives it with scripted fakes (`fakes.mjs`) — canned structured
   outputs keyed on the short, stable `opts.label` (prompts drift with wording edits; labels don't).
   Every fake result is shallow-checked against the call's own schema, so a drifted fake fails
   loudly. `harness.test.mjs` locks harness control flow; `conductor.test.mjs` is the conductor's
   acceptance spec — tier routing, the full early-return reason matrix (the paid fixture only ever
   sees `arc-complete`), persist-before-dispatch ordering, and the nesting-level rule.
   `prompt-hygiene.test.mjs` locks **schema/prompt coherence**, in four properties: every prompt
   driving a capped schema carries the length contract (`TERSE`, or `REPORT` for code-writing
   agents); every top-level capped field has its **budget stated** with a real bound expression, not
   just a generic terseness clause; no prompt points content INTO a capped field without stating that
   field's budget (checked against the call's own schema, so rephrasing cannot dodge it); and a
   *sampling* array whose items are capped also caps its count, while completeness ledgers like
   `debt` are explicitly exempt. A cap the model is never told about is a trap — it overruns,
   exhausts its schema-retries, dies, and `agent()` returns `null` with no error object. Round 1 of
   this test cost three paid runs and was misdiagnosed as network flakiness; round 2 (2026-07-18)
   PASSED while 16 opus calls died, because a generic clause satisfied it and the overflow check
   encoded round 1's exact wording. Both holes are now closed — but note the standing limit: it
   verifies a budget is *stated*, never that the stated budget matches the schema or that the named
   field exists.
   Run: `bash unit/run.sh`. **`unit/` is owned separately by consumers of this skill — if you are
   running an arc, document don't edit. In the skill's own source repo it is yours to extend.**

   > **Drift caveat.** The fakes encode *assumed* platform semantics. They catch control-flow
   > regressions in milliseconds, but cannot tell you whether a prompt still elicits the right
   > judgment, whether a model is still pinned to the tier you think, or whether the platform behaves
   > as the fakes pretend. Never ship on sims alone.
3. **Paid fixtures — prompts + real model behaviour. Budget-consuming, 10–25 min.** Two end-state-graded throwaway
   repos driven by real models: the **harness fixture** (`check.sh`) and the **conductor fixture**
   (`check-conductor.sh`). The only layer that exercises gate judgment, model tiers, and the real
   Workflow runtime. Source of truth; run last.

| You changed… | Run |
|---|---|
| `harness.mjs` | parse + sims + **both** paid fixtures (the conductor drives the harness) |
| `conductor.mjs` only | parse + sims + the **conductor** fixture |
| a prompt/schema in one script | parse + sims + that script's fixture |
| `evals/*` plumbing only | parse + sims + a spot-run of the touched fixture |

Parse and sims are cheap enough to run on **every** edit; the paid fixtures gate the merge.

---

## The harness fixture (single wave)

`setup-fixture.sh <dir>` builds a throwaway repo (a tiny dependency-free Node calculator) with a
complete canned plan pack — no Phase-0 planning runs, so the eval isolates the *execution* machinery.

| Unit | Probes | Expected end state |
|---|---|---|
| `add-multiply` | Happy path: plan → plan-check → implement → verify → review → gate → merge | `merged` |
| `add-divide` | Dependency scheduling (contract edge); contract compliance (RangeError clause) | `merged`, after multiply |
| `impossible-cache` | Unsatisfiable fast-exit: the spec sincerely demands cross-process persistence the frozen contract forbids | `quarantined`, never merged |
| `gate-good` | **Over-blocking probe**: a clean pre-baked branch (`existingBranch`) adopted straight into verify→review→gate | `merged`, low gate friction |
| `gate-bad` | **Rubber-stamp probe**: a pre-baked branch that passes every runnable acceptance command but violates the spec's prose (Math.round vs round-half-away-from-zero; the negative-half case is deliberately untested) | `quarantined`, **or** `merged` with the violation fixed — never merged as-is |
| `gate-convention` | **Conventions probe**: a pre-baked branch whose `simplifyRatio` is correct and passes every runnable check, but reimplements the catalogued `shared.gcd` inline — invisible to the machine checks | `quarantined`, **or** `merged` with the duplication replaced — never merged as-is |

Two paths are probed implicitly. **Provisioning**: the suite requires a gitignored `.env.local` and a
generated config that only exist if the plan's `provision` block ran in each worktree — if it
regresses, every unit reads `blocked`. **The green-tip mirror**: the plan carries an api-kind
`preview` block (no processes, nothing flaky to babysit), so the harness must detach the primary
checkout and advance it merge by merge.

`check.sh` grades the end state deterministically (git facts, files, `state.json`) at **zero model
tokens**: statuses match the table, the planted violation never reaches integration unfixed, dossiers
exist for quarantines, the full suite passes on the integration worktree, the wave-tail boundary phase
ran (`boundary` block + `feedback/{health,explorer}/wave-1.md`), HEAD is detached at the final
suite-green tip with `preview: {status: "live"}`, and spend is within a generous envelope.

**Run:**

0. `bash parse.sh && bash unit/run.sh` — green before you spend a run.
1. `bash setup-fixture.sh /tmp/roadmap-eval`
2. Read `/tmp/roadmap-eval/repo/.roadmap/{plan,state}.json`, then
   `Workflow({scriptPath: "<skill dir>/harness.mjs", args: {plan, state, config: {}}})` and wait
   (~10–25 min at ~16-way concurrency).
3. `bash check.sh /tmp/roadmap-eval` → `ALL CHECKS PASSED`, or FAIL lines.

**Cost:** ~90 agents, ~1.7M subagent tokens observed (2026-07-19: 3 Fable, 27 Opus, 1 Sonnet,
59 Haiku), 10–25 min. See **What a run actually costs** below — the Opus/Haiku bulk is not free.

---

## The conductor fixture (multi-wave)

`setup-fixture.sh --conductor <dir>` builds the same calculator base, but probes the tiered boundary
ladder rather than a single wave. Differences: **three** units (no adopted-branch gate probes), a
planted `stats.js` that reimplements `gcd` inline (health-assessor bait — `conventions.md` already
catalogs `shared.gcd`), a planted **`architect-log.md` seed** (decisions, watch-list, dismissal
criteria — stands in for the Phase-0 handoff journal, and carries **no** `## Wave` header so a grown
section is detectable), `plan.config.conductor = {maxWavesPerRun: 3}`, and a `state.json` `run` block
so the run carries one stable `runId`.

Expected shape: an **autonomous 2-wave run ending `arc-complete`**.

| Unit / signal | Probes | Expected end state |
|---|---|---|
| `add-multiply` | Happy path (wave 1) | `merged` |
| `add-divide` | Contract-edge scheduling (wave 1, after multiply) | `merged` |
| `impossible-cache` | Unsatisfiable → quarantine (`feasible:false` → Fable plan-check) → **tier-3** Fable boundary agent handles it | `quarantined`, never merged |
| `stats.js` inline `gcd` | Health assessor drafts a consolidation fix-unit → tier admits it → wave 2 merges it | integration `stats.js` reuses `shared.gcd` |
| architect-log | Tier-3 engagement appends a `## Wave 1` section beyond the seed | grew |

`check-conductor.sh` probes:

- **(a)** `wave == 2`, `conductor.wavesRun >= 2`, a threaded `run.runId`, and an architect-log
  `## Wave N` section beyond the seed.
- **(b)** an admitted health fix-unit merged **beyond the planted three** — in `state.units`, in
  `plan.json` on disk, with a `specs/<id>.md`, and integration `stats.js` now `require('./shared')`s
  `gcd`. *(rerun-tolerant)*
- **(c)** `impossible-cache` quarantined-never-merged + dossier + **no `fs`/`child_process`
  laundering** in integration `calc.js` + `wavesRun <= 3`; plus the respec **disposition** — exactly
  one of an in-contract respec **merged**, a **re-quarantine** with a fresh-id dossier (no re-run
  loop), or a **journaled defer**. *(respec half rerun-tolerant)*
- **(d)** `conductor.reason == 'arc-complete'`.
- **(e)** `debt.md` carries a `<!-- wave 1 -->` section (continuation boundaries always stamp debt;
  the terminal arc-complete boundary banks nothing — so wave 1 is stamped, wave 2 is not).
- **(f)** the conductor never sets `boundary:'off'`: `feedback/health/wave-2.md` and
  `explorer/wave-2.md` **EXIST**, the final state carries the `boundary` block intact (untriaged
  review evidence for the root), and wave-1's evidence moved into `feedback/triaged/1/`. Probe (f) is
  **not** "no wave-2 files".
- Carried over: integration suite passes, mirror detached at the tip, `preview.status` live, spend
  envelope (WARN if `fable > 6`).

**Run:** as above, but launch the **conductor ONCE** — it loops the waves itself; do *not* launch it
per wave:

```
Workflow({scriptPath: "<skill dir>/conductor.mjs",
          args: {plan, state, config: {}, harnessPath: "<skill dir>/harness.mjs"}})
```

`harnessPath` is **required** — the conductor throws without it. Then
`bash check-conductor.sh /tmp/roadmap-eval-c`.

**Cost:** the larger of the two by some margin — it runs the whole harness once per wave, so it
multiplies. ~155+ agents and ~3M subagent tokens observed on a 3-wave run (2026-07-19). **Budget for
three waves, not the two its expected shape describes.** Tightening `maxWavesPerRun` to 2 to bound
this was tried and reverted the same day: the fixture plants a blocker (`bash test.sh` exits 1
without out-of-band provisioning), so a wave-2 boundary can *correctly* admit a draft that fixes it —
and at a cap of 2 that correct behaviour exhausts the loop, returns `max-waves`, and reds check (d).
An eval that fails on correct behaviour costs more to disentangle than the extra wave costs to run.

**So `max-waves` here is ambiguous by construction**, and worth reading rather than reflexing on: it
means the arc still wanted work when the cap hit. Ask whether the cut-line brake should have bitten
(a real defect) or whether the admitted draft genuinely justified its wave (correct, and the fixture
shape is simply optimistic).

**A mid-arc return is legitimate, not a failure.** Health drafts are model-authored, and one may
require touching a frozen contract — the tier-2 triager then correctly escalates and the conductor
returns `contract-amendment` instead of finishing the arc. That is the ladder working. Act as the root
per SKILL.md: adjudicate, admit the pending drafts (plan.json + specs), bank the returned `debt`, move
the consumed wave's feedback to `triaged/<n>/`, journal **both the adjudication and your dismissals**
in `architect-log.md` (the next triager reads it — undismissed explorer findings get re-promoted and
the arc won't converge), then relaunch. `check-conductor.sh` grades the arc's *final* state:
`boundaries` forensics are arc-cumulative across relaunches, and the final-wave probes key on
`state.wave`, not a hardcoded number. Adds roughly one wave's cost.

**Rerun tolerance.** This is an LLM-based system: a *single* unexpected FAIL warrants one rerun (fresh
dir) before you conclude regression; a repeat is real. Rerun-tolerant probes are the ones that depend
on a model *drafting* work — **(b)** and the respec-disposition half of **(c)**. Everything else —
**(a)**, **(d)**, **(e)**, **(f)**, and the quarantine/dossier/no-laundering/wave-cap half of **(c)** —
is a structural fact about a completed arc and should never flake.

---

## What a run actually costs

The old figures here priced only Fable calls and called Opus/Haiku "free tier". That was wrong and
it misleads: it budgets a coffee for something that consumes a meaningful slice of a week.

Everything runs under the Max subscription, so the unit of cost is not dollars — it is **weekly usage
budget**. Nothing in a fixture run is free:

- **Fable** is included continuously on 20x Max, but may consume at most **50% of the usage budget**,
  and it burns budget faster per call than any other tier. It is the scarce resource.
- **Opus / Sonnet / Haiku** draw on the same weekly budget, just far more slowly per call. A run that
  is "only 3 Fable calls" can still be 1.7M tokens and a real dent.

This is exactly why the skill's economy is shaped the way it is (invariant 2 — frontier never
generates volume): Fable plans, gates and adjudicates; Opus writes; Haiku runs commands. The
orchestrated split is not stylistic, it is what keeps an arc inside a weekly budget. The same logic
applies to the evals themselves — hence the wave cap on the conductor fixture, and the probes below.

**Budget the ladder accordingly.** Tiers 1 and 2 are genuinely free and catch most regressions; run
them on every edit. Tier 3 consumes real budget and — this is the part worth internalising — mostly
proves *non-regression on paths you did not change*. It is pre-merge insurance, not a per-edit gate.

## Targeted probes — covering NEW code without a full fixture

A fixture exercises the pipeline it was built for. It gives **zero** coverage to a path that only
fires under conditions the fixture never creates: a schema death, a lost report, a blocked-then-
unblocked unit, an `arc-stalled` return, or anything behind `designAuthorities` (neither fixture
declares any). Discovering that *after* spending is the expensive way to learn it.

So when a change adds a path the fixtures cannot reach, probe it directly instead: dispatch **one**
agent at the tier the real code uses, with the real prompt and the real schema, against a scratch
directory. Pennies of budget, minutes of wall clock, and it tests the thing you actually changed.

Probes worth keeping for the current surface:

| Probe | Tier | What it proves |
|---|---|---|
| `design:w<N>` prompt + `S.design` against a toy comp dir + a live preview | Opus | The new capped schema validates against real output, and `visionUsed` reports honestly when no screenshot tool is provisioned |
| `commit-probe:<id>` prompt against a worktree with and without commits | Haiku | The report-loss salvage distinguishes "work landed" from "nothing was built" — the judgement that decides quarantine vs merge |
| Any prompt whose schema you just capped | its own tier | The budget you stated is one a real model can actually hold to |

Record what you probed and what it returned; a probe nobody wrote down gets re-bought.

## Interpreting failures

**Harness fixture:**

- `gate-bad RUBBER-STAMPED` → the gate prompt (or its model/effort) lost its teeth.
- `gate-convention RUBBER-STAMPED` → the conventions contract isn't reaching the reviewer/gate
  (`plan.conventions` set? `convClause` still threaded into review + both gates?), or the gate stopped
  treating catalogued-helper duplication as a violation.
- `gate-good` not merged → the gate or reviewer is over-blocking; check `minBlockConfidence`, the review
  taxonomy wording, and the risk tilt.
- `impossible-cache` merged → the unsatisfiable fast-exit or plan-check regressed. An infeasible plan
  (`feasible:false`) must route to the **Fable** plan-check and may never be killed or approved by Opus
  alone — a merge can mean Opus wrongly waved it through instead of escalating. It can also mean **spec
  interrogation** stopped firing (both plan-checks must interrogate the spec itself, not just the plan;
  RATIONALE §4).
- Everything `blocked`/env-quarantined → provisioning broke.
- `add-divide` ran before `add-multiply` merged, or units stuck `pending` → scheduler/DAG.
- Mirror checks fail → the preview setup/refresh path regressed (statuses still passing means the
  no-gating property held and only the mirror mechanics broke).

**Conductor fixture:**

- Stuck at wave 1 → the wave loop isn't advancing: state isn't threading forward (the harness's returned
  state must become the next wave's `prior`), or the boundary produced no continuation and returned early.
- Returns `max-waves` with fresh drafts admitted every wave → **the convergence brake regressed**
  (RATIONALE §7). The tier-2 prompt must bind default-admit to the CUT LINE, and the fixture's
  architect-log seed must carry matching dismissal criteria. If both are intact and it still won't dry,
  the root's recovery is: cut the pending drafts (`inScope:false`), journal binding dismissal criteria,
  relaunch.
- `conductor` block absent → the conductor didn't persist-before-return. **Severe**: this also breaks
  rung-3 crash recovery, which reads that block. Check every `ret()` path and the persist writers.
- **(f)** wave-2 boundary files MISSING → someone reintroduced "predict finality / set `boundary:'off'`
  on the final wave". That is a regression (RATIONALE §8) — single-wave arcs are exactly where drift is
  likeliest.
- **(a)** architect-log missing a wave section → tier-3 didn't fire (was `impossible-cache` actually
  quarantined *and* in scope?), or the `log-append` writer regressed.
- **(b)** no extra merged unit / `stats.js` still inline → rerun once; if it repeats, the health assessor
  stopped drafting, tier routing stopped admitting drafts, or wave 2 didn't merge it.
- **(c)** laundering detected → a respec smuggled cross-process persistence into `calc.js`. The Fable
  boundary agent must respec *within* contract; a contract amendment returns to the root.

## Keeping it honest

- **Don't tune a fixture to make a failing check pass.** Fix the script — or consciously update the
  expectation table **and** the checker together, with a note in DESIGN.md.
- **One unit per property; keep each fixture small enough to stay cheap.** Add new probes in `unit/`
  where they're control flow, and in a paid fixture only where they need a real model.
- The planted `gate-bad` / `gate-convention` defects will go stale against improving models (a future
  reviewer may always catch them pre-gate — the check still passes but the gate goes unprobed). When that
  happens, plant a subtler prose-only violation.
- **Not yet built:** a `contract-stale` unit exercising the `contractMismatch` channel end-to-end (frozen
  surface contradicting live code → mid-loop consult → forced Fable gate → `kind:'contract'` debt). It
  needs a real Fable consult, so it adds cost and nondeterminism the current fixtures deliberately avoid.
