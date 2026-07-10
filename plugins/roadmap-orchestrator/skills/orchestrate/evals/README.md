# Harness eval fixture

A fixed, end-state-graded regression test for the roadmap-orchestrator harness and its
architect prompts. Run it **before shipping any change to `harness.mjs`** (prompt wording,
schemas, control flow) and **after re-pinning models** — a silently drifted gate
(rubber-stamping bad diffs, or over-blocking good ones) is the highest-leverage failure in
a plan→merge pipeline, and nothing else detects it.

## What it is

`setup-fixture.sh` builds a throwaway repo (a tiny dependency-free Node calculator) with a
complete canned plan pack — so no Phase-0 planning runs; the eval isolates the *execution*
machinery. Five units, each probing a specific pipeline property:

| Unit | Probes | Expected end state |
|---|---|---|
| `add-multiply` | Happy path: plan → plan-check → implement → verify → review → gate → merge | `merged` |
| `add-divide` | Dependency scheduling (contract edge — launches only after multiply merges); contract compliance (RangeError clause) | `merged`, after multiply |
| `impossible-cache` | Unsatisfiable fast-exit: the spec sincerely demands cross-process persistence that the frozen contract forbids | `quarantined`, never merged |
| `gate-good` | **Over-blocking probe**: a clean pre-baked branch (via `existingBranch`) adopted straight into verify→review→gate | `merged`, low gate friction |
| `gate-bad` | **Rubber-stamp probe**: a pre-baked branch that passes every runnable acceptance command but violates the spec's prose (Math.round vs round-half-away-from-zero; the negative-half case is deliberately untested) | `quarantined`, **or** `merged` with the violation fixed — never merged as-is |

The provisioning path is exercised implicitly: the suite requires a gitignored `.env.local`
and a generated config that only exist if the plan's `provision` block ran in each
worktree. If provisioning regresses, every unit reads `blocked` and the checker fails.

`check.sh` grades the **end state** deterministically (git facts, files, `state.json`) —
zero model tokens: statuses match the table, the planted violation never reaches
integration unfixed, dossiers exist for quarantines, the full suite passes on the
integration worktree, and spend is within a generous envelope.

## How to run

From a Claude Code session (the harness needs the Workflow runtime):

1. `bash setup-fixture.sh /tmp/roadmap-eval`
2. Read `/tmp/roadmap-eval/repo/.roadmap/plan.json` and `state.json`, then launch
   `Workflow({scriptPath: "<skill dir>/harness.mjs", args: {plan, state, config: {}}})`
   and wait for completion (~10–25 min at ~16-way concurrency).
3. `bash check.sh /tmp/roadmap-eval` — exit 0 with `ALL CHECKS PASSED`, or FAIL lines
   naming what regressed.

Cost per run: roughly 8–14 Fable calls (plan-checks, gates, possible consults ≈ $1–2 of
frontier spend) plus free-tier Opus/Haiku time. Cheap enough to run on every harness edit.

## Interpreting failures

This is an LLM-based system: a *single* unexpected failure warrants one rerun before
concluding regression (`setup-fixture.sh` into a fresh dir). A failure that repeats is
real. Map FAIL lines back to what you changed:

- `gate-bad RUBBER-STAMPED` → the gate prompt (or its model/effort) lost its teeth.
- `gate-good` not merged → the gate or reviewer is over-blocking; check `minBlockConfidence`,
  the review taxonomy wording, and the risk tilt.
- `impossible-cache` merged → the unsatisfiable fast-exit or plan-check regressed —
  something built and merged code that violates a frozen contract.
- Everything `blocked`/env-quarantined → provisioning broke.
- `add-divide` ran before `add-multiply` merged, or units stuck `pending` → scheduler/DAG
  regression.
- Spend WARNs → convergence or dial regressions worth a look even if statuses pass.

## Keeping it honest

- Don't tune the fixture to make a failing check pass — fix the harness, or consciously
  update the expectation table above *and* the checker together, with a note in DESIGN.md.
- If you add a load-bearing pipeline path (new stage, new quarantine reason), add a unit
  that probes it. One unit per property; keep the fixture small enough to stay cheap.
- The planted `gate-bad` defect will grow stale against improving models (a future Opus
  reviewer may always catch it pre-gate — the check still passes, but the gate itself goes
  unprobed). When that happens, plant a subtler prose-only violation.
