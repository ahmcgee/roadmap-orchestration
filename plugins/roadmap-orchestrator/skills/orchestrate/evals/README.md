# Orchestrate evals

End-state-graded regression tests for the roadmap-orchestrator scripts (`harness.mjs`,
`conductor.mjs`) and their architect prompts. A silently drifted gate (rubber-stamping bad
diffs, or over-blocking good ones) or a mis-routed conductor boundary is the highest-leverage
failure in a plan→merge pipeline, and nothing downstream detects it — so this directory is the
"done" gate for any harness- or conductor-adjacent change (invariant 6).

## The three-layer quality ladder

Each layer is strictly cheaper and strictly less faithful than the one below it. Climb the
whole ladder before shipping; never ship on an upper rung alone.

1. **`parse.sh` — syntax (token-free, milliseconds).** Loads every `*.mjs` in the skill dir
   under an `AsyncFunction` wrapper (plain `node --check` chokes on a workflow script's legal
   top-level `return`) with the workflow globals stubbed as params. Prints `parse OK <file>`
   per script; non-zero exit if any fails. Catches a syntax slip before you spend anything.
2. **`unit/` — control-flow simulations (`node --test`, zero tokens, milliseconds).**
   Generalizes the parse trick into a runnable simulation: `load.mjs` compiles a script under
   the same `AsyncFunction` wrapper and drives it with **scripted fakes** (`fakes.mjs`) —
   canned structured outputs keyed on the short, stable `opts.label` (prompts drift with
   wording edits; labels don't). Every fake result is shallow-checked against the call's own
   schema, so a fake that drifts from a script's schema fails loudly. `harness.test.mjs`
   (~17 cases) locks harness control flow — plan-validation throws, contract-edge scheduling,
   blocked→env-quarantine, adopt-tip mismatch, already-merged short-circuit, serial merge
   queue, audit determinism, debt banking, contractMismatch consult + forced Fable gate,
   boundary block on/off/all-failed rules, spend seeding, checkpoint coalescing, stringified
   args, tip reconciliation, preview-never-gates, StructuredOutput retry. `conductor.test.mjs`
   (~20 cases) is the conductor's acceptance spec — table-driven tier routing, draft→plan-unit
   conversion, persist-before-dispatch ordering, maxWavesPerRun / agent-budget returns, the
   full early-return reason matrix (the paid fixture only ever sees `arc-complete` — every
   other reason's shape lives here, token-free), never-writes-to-`contracts/`, architect-log
   append on tier-3 only, debt stamped every boundary and never re-banked, feedback→triaged
   moves, state threaded verbatim, respec never reuses a failed id, the conductor block
   checkpointed at every boundary, and exactly one `workflow()` nesting level.
   Run: `bash unit/run.sh` (or `cd unit && node --test`). `unit/` is owned separately — this
   README only documents it; do not treat it as a place to edit.
   > **Drift caveat.** The fakes encode *assumed* platform semantics. The sims catch
   > control-flow regressions in milliseconds, but they cannot tell you whether a prompt still
   > elicits the right judgment, whether a model is still pinned to the tier you think, or
   > whether the platform behaves as the fakes pretend. The paid fixtures below remain the
   > source of truth for prompts / models / platform behavior. Never ship on sims alone.
3. **Paid fixtures — prompts + real model behavior (`$`, 10–25 min).** Two end-state-graded
   throwaway repos driven by real models: the **harness fixture** (`check.sh`) and the
   **conductor fixture** (`check-conductor.sh`). These are the only layer that exercises gate
   judgment, model tiers, and the actual Workflow runtime. Source of truth; run last.

### Which layers must I run?

| You changed… | Run |
|---|---|
| `harness.mjs` | parse + sims + **both** paid fixtures (the conductor drives the harness, so a harness change can regress either) |
| `conductor.mjs` only | parse + sims + the **conductor** paid fixture |
| a prompt/schema in one script | parse + sims + that script's paid fixture |
| `evals/*` plumbing only | parse + sims + a spot-run of the touched fixture |

The `unit/` sims and `parse.sh` are cheap enough to run on **every** edit; the paid fixtures
gate the merge.

---

## The harness fixture (single wave)

`setup-fixture.sh <dir>` builds a throwaway repo (a tiny dependency-free Node calculator) with
a complete canned plan pack — so no Phase-0 planning runs; the eval isolates the *execution*
machinery. Six units, each probing a specific pipeline property:

| Unit | Probes | Expected end state |
|---|---|---|
| `add-multiply` | Happy path: plan → plan-check → implement → verify → review → gate → merge | `merged` |
| `add-divide` | Dependency scheduling (contract edge — launches only after multiply merges); contract compliance (RangeError clause) | `merged`, after multiply |
| `impossible-cache` | Unsatisfiable fast-exit: the spec sincerely demands cross-process persistence that the frozen contract forbids | `quarantined`, never merged |
| `gate-good` | **Over-blocking probe**: a clean pre-baked branch (via `existingBranch`) adopted straight into verify→review→gate | `merged`, low gate friction |
| `gate-bad` | **Rubber-stamp probe**: a pre-baked branch that passes every runnable acceptance command but violates the spec's prose (Math.round vs round-half-away-from-zero; the negative-half case is deliberately untested) | `quarantined`, **or** `merged` with the violation fixed — never merged as-is |
| `gate-convention` | **Conventions-enforcement probe**: a pre-baked branch whose `simplifyRatio` is functionally correct and passes every runnable check, but reimplements the catalogued `shared.gcd` inline — a `conventions.md` violation invisible to the machine checks | `quarantined`, **or** `merged` with the duplication replaced by `shared.gcd` — never merged as-is |

The provisioning path is exercised implicitly: the suite requires a gitignored `.env.local`
and a generated config that only exist if the plan's `provision` block ran in each worktree.
If provisioning regresses, every unit reads `blocked` and the checker fails.

The **green-tip mirror** is probed the same way: the fixture plan carries an api-kind
`preview` block (no processes — nothing flaky to babysit), so the harness must detach the
fixture repo's primary checkout and advance it merge by merge. `check.sh` asserts HEAD
detached at the final suite-green tip, `state.json` reporting `preview: {status: "live", sha:
<that tip>}`, and — load-bearing — that every unit status still matches the table (the preview
is observability; it may never alter an outcome).

`check.sh` grades the **end state** deterministically (git facts, files, `state.json`) — zero
model tokens: statuses match, the planted violation never reaches integration unfixed,
dossiers exist for quarantines, the full suite passes on the integration worktree, the
wave-tail **boundary phase** ran (`boundary` block + `feedback/{health,explorer}/wave-1.md`),
and spend is within a generous envelope.

### How to run (harness fixture)

From a Claude Code session (the harness needs the Workflow runtime):

0. `bash parse.sh` and `bash unit/run.sh` — token-free gates; green before you spend a run.
1. `bash setup-fixture.sh /tmp/roadmap-eval`
2. Read `/tmp/roadmap-eval/repo/.roadmap/plan.json` and `state.json`, then launch
   `Workflow({scriptPath: "<skill dir>/harness.mjs", args: {plan, state, config: {}}})` and
   wait (~10–25 min at ~16-way concurrency).
3. `bash check.sh /tmp/roadmap-eval` — exit 0 with `ALL CHECKS PASSED`, or FAIL lines.

Cost: roughly 3–10 Fable calls (plan-checks are mostly Opus now, so Fable is escalated
plan-checks + forced/audit gates + possible consults ≈ $0.50–1.50) plus free-tier Opus/Haiku.

---

## The conductor fixture (multi-wave)

`setup-fixture.sh --conductor <dir>` builds the same calculator base, but for the conductor's
tiered boundary ladder rather than the harness's single wave. Differences from the default
fixture: **three** units (no adopted-branch gate probes), a planted `stats.js` that
reimplements `gcd` inline (a health-assessor bait — `conventions.md` already catalogs
`shared.gcd`), a planted **`architect-log.md` seed** (decisions, watch-list, dismissal
criteria — stands in for the Phase-0 handoff journal, and carries **no** `## Wave` header so a
grown wave section is detectable), `plan.config.conductor = {maxWavesPerRun: 3}`, and a
`state.json` `run` block so the multi-wave run carries one stable `runId`.

The expected shape is an **autonomous 2-wave run ending `arc-complete`**:

| Unit / signal | Probes | Expected end state |
|---|---|---|
| `add-multiply` | Happy path (wave 1) | `merged` |
| `add-divide` | Contract-edge scheduling (wave 1, after multiply) | `merged` |
| `impossible-cache` | Unsatisfiable → deterministic quarantine (`feasible:false` → Fable plan-check) → **tier-3** Fable boundary agent respecs/handles it | `quarantined`, never merged |
| `stats.js` inline `gcd` | Wave-tail **health assessor** drafts a consolidation fix-unit → tier admits it → wave 2 merges it | integration `stats.js` reuses `shared.gcd` |
| architect-log | Tier-3 engagement appends a `## Wave 1` section beyond the seed | grew |

`check-conductor.sh` probes (same idioms as `check.sh`):

- **(a)** `wave == 2`, `conductor.wavesRun >= 2`, a present/threaded `run.runId`, and an
  architect-log `## Wave N` section beyond the seed.
- **(b)** an admitted health fix-unit merged **beyond the planted three** — present in
  `state.units`, in `plan.json` on disk, with a `specs/<id>.md`, and integration `stats.js`
  now `require('./shared')`s `gcd`. *(rerun-tolerant — model-drafted)*
- **(c)** `impossible-cache` quarantined-never-merged + dossier + **no `fs`/`child_process`
  laundering** in integration `calc.js` + `wavesRun <= 3`; plus the respec **disposition** —
  exactly one of three acceptable outcomes passes: an in-contract respec **merged**, a
  **re-quarantine** with a fresh-id dossier (no re-run loop), or a **journaled defer**.
  *(respec half rerun-tolerant)*
- **(d)** `conductor.reason == 'arc-complete'`.
- **(e)** `debt.md` carries a `<!-- wave 1 -->` section (continuation boundaries stamp debt
  every time, even "no new entries"; the terminal arc-complete boundary banks nothing — so
  wave 1 is stamped, wave 2 is not).
- **(f)** per **ruling 1** the conductor never sets `boundary:'off'`: `feedback/health/wave-2.md`
  (and `explorer/wave-2.md`, preview live) EXIST, the final state carries the `boundary` block
  intact (untriaged review evidence for the root), and wave-1's evidence was moved into
  `feedback/triaged/1/`. Probe (f) is **not** "no wave-2 files".
- Carried-over sanity: integration suite passes, mirror detached at the tip, `preview.status`
  live, spend envelope (WARN if `fable > 6`).

### How to run (conductor fixture)

0. `bash parse.sh` and `bash unit/run.sh` — green first.
1. `bash setup-fixture.sh --conductor /tmp/roadmap-eval-c`
2. Read `/tmp/roadmap-eval-c/repo/.roadmap/plan.json` and `state.json`, then launch the
   **conductor** ONCE (it loops the waves itself — do **not** launch it per wave):
   `Workflow({scriptPath: "<skill dir>/conductor.mjs", args: {plan, state, config: {},
   harnessPath: "<skill dir>/harness.mjs"}})` and wait. `harnessPath` is **required** — the
   conductor throws without it.
3. `bash check-conductor.sh /tmp/roadmap-eval-c` — exit 0 with `ALL CHECKS PASSED`, or FAILs.

**Legitimate mid-arc return (arc-observed, first live run).** Health drafts are
model-authored, and one may require touching a frozen contract (e.g. a
reconcile-validation draft that must extend the conventions catalog) — the tier-2 triager
then correctly escalates and the conductor returns `contract-amendment` instead of
finishing the arc. That is the ladder working, not a failure. Act as the root per
SKILL.md: adjudicate (amend the contract or respec), admit the pending drafts (plan.json +
specs), bank the returned `debt`, move the consumed wave's feedback to `triaged/<n>/`
(use the `wave-<n>-{explorer,health}.md` naming — the two sources share a basename),
journal the adjudication AND your dismissals in `architect-log.md` (the next triager reads
it — undismissed explorer findings get re-promoted and the arc won't converge), then
relaunch the conductor with the updated plan and the consumed state. `check-conductor.sh`
grades the **arc's final state**: the `boundaries` forensics are arc-cumulative across
relaunches (seeded like `spend`), so in-run continuation evidence survives, and the
final-wave probes key on `state.wave`, not a hardcoded wave number.

Cost: ≈ 2–4 Fable calls (`impossible-cache` Fable plan-check + the tier-3 boundary Fable +
escalated plan-checks/forced gates) ≈ **$0.3–0.9** of frontier spend, plus free-tier
Opus/Haiku; a mid-arc adjudication + relaunch adds roughly one wave's worth. Both paid
fixtures together stay ≤ ~$2.5.

### Rerun tolerance

This is an LLM-based system; a *single* unexpected FAIL warrants one rerun (fresh dir) before
concluding regression, a repeat is real. Which probes are which:

- **Rerun-tolerant** (depend on a model *drafting* work): probe **(b)** (the health assessor
  must draft the consolidation fix-unit) and the **respec-disposition half of (c)** (the Fable
  boundary agent chooses merge / re-quarantine / defer).
- **Deterministic** (a structural fact about a completed arc): probes **(a)**, **(d)**,
  **(e)**, **(f)**, and the quarantine/dossier/no-laundering/wave-cap half of **(c)**.

---

## Interpreting failures

Map FAIL lines back to what you changed.

**Harness fixture:**

- `gate-bad RUBBER-STAMPED` → the gate prompt (or its model/effort) lost its teeth.
- `gate-convention RUBBER-STAMPED` → the standing conventions contract isn't reaching the
  reviewer/gate (`plan.conventions` set? `convClause` still threaded into review + both gate
  prompts?), or the gate stopped treating catalogued-helper duplication as a violation.
- `gate-good` not merged → the gate or reviewer is over-blocking; check `minBlockConfidence`,
  the review taxonomy wording, and the risk tilt.
- `impossible-cache` merged → the unsatisfiable fast-exit or plan-check regressed. With the
  Opus-first plan-check, an infeasible plan (`feasible:false`) must route to the **Fable**
  plan-check and may never be killed or approved by Opus alone — a merge can mean Opus wrongly
  waved the plan through instead of escalating. Note the **plan-check charter refocus** (both
  plan-check prompts now interrogate the SPEC itself — internal contradictions,
  spec-vs-contract-vs-codebase conflicts, stale premises — and redirect with the resolution
  when clear, or quarantine/escalate when not): a regression here can also mean that spec
  interrogation stopped firing.
- Everything `blocked`/env-quarantined → provisioning broke.
- `add-divide` ran before `add-multiply` merged, or units stuck `pending` → scheduler/DAG.
- Mirror checks fail → the preview setup/refresh path regressed (statuses still passing means
  the no-gating property held and only the mirror mechanics broke).
- Spend WARNs → convergence or dial regressions worth a look even if statuses pass.

**Conductor fixture:**

- `(a) wave >= 2` fails, stuck at 1 → the wave loop isn't advancing: state isn't threading
  forward (the harness's returned state must be passed as the next wave's `prior`), or the
  boundary produced no continuation and returned early. Check the ladder routing and the
  state-threading between waves.
- The run returns `max-waves` with fresh assessor drafts admitted every wave (arc-observed,
  first live run: waves 3–5 each admitted new test-ergonomics drafts) → the convergence
  brake regressed. The tier-2 triager prompt binds the default-admit to the CUT LINE (once
  planned work is merged, a draft must justify a wave — polish/refactor/marginal-coverage
  drafts are cut, banked as debt, and `arcComplete` set), and the fixture's architect-log
  seed carries matching dismissal criteria. If both are intact and it still won't dry, the
  root's recovery is: cut the pending drafts (`inScope:false`), journal binding dismissal
  criteria, relaunch — the next boundary should return `arc-complete`.
- `conductor` block absent (`(a)` wavesRun / `(d)` reason read `absent`) → the conductor
  didn't persist-before-return. **Severe**: this also breaks rung-3 crash recovery, which
  reads the persisted `conductor` block. Check every `ret()` path and the persist writers.
- `(f)` wave-2 boundary files **MISSING** → someone reintroduced a "predict finality / set
  `boundary:'off'` on the final wave" behavior. That is a regression against **ruling 1** —
  the conductor must never suppress the final wave's health check (single-wave arcs are
  exactly where drift is likeliest, and health fix-units are what reveal an arc isn't final).
- `(a)` architect-log missing a wave section → tier-3 routing didn't fire (was
  `impossible-cache` actually quarantined and in scope?), or the `log-append` writer regressed.
- `(b)` no extra merged unit / `stats.js` still inline → rerun once; if it repeats, the health
  assessor stopped drafting the consolidation, tier routing stopped admitting drafts, or wave 2
  didn't merge it.
- `(c)` laundering detected → a respec smuggled cross-process persistence into `calc.js`
  (`fs`/`child_process`) — the Fable boundary agent must respec *within* contract, never amend
  a frozen contract (that returns to the root).

## Keeping it honest

- Don't tune a fixture to make a failing check pass — fix the script, or consciously update
  the expectation table **and** the checker together, with a note in DESIGN.md. For the
  conductor, that means the expectation table above, `check-conductor.sh`, and the DESIGN.md
  §9.1 note move as one.
- One unit/probe per property; keep each fixture small enough to stay cheap. If you add a
  load-bearing path (new stage, new quarantine reason, new conductor return), add a probe for
  it — cheaply in `unit/` where it's control flow, in the paid fixture only where it needs a
  real model.
- The planted `gate-bad`/`gate-convention` defects will grow stale against improving models
  (a future reviewer may always catch them pre-gate — the check still passes but the gate goes
  unprobed). When that happens, plant a subtler prose-only violation.
- **Future work:** a `contract-stale` unit exercising the `contractMismatch` channel
  end-to-end (frozen surface contradicting live code → mid-loop consult → forced Fable gate →
  `kind: 'contract'` debt) is not yet built — it needs a real Fable consult, so it adds cost
  and nondeterminism the current fixtures deliberately avoid.
