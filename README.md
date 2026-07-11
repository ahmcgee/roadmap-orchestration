# roadmap-orchestration

A Claude Code **plugin marketplace** carrying one plugin: **roadmap-orchestrator** — an
autonomous roadmap-execution skill. Give it a roadmap (prose, checklist, tracker export,
RFC — any format), a cut line ("build up to milestone X"), and a codebase; it decomposes
the slice into independently verifiable units, builds each in an isolated git worktree via
a multi-agent workflow, and delivers one tested, reviewed, merge-ready integration branch.

## Install

```
/plugin marketplace add ahmcgee/roadmap-orchestration
/plugin install roadmap-orchestrator@roadmap-orchestration
```

Then, in the repo you want to build in:

```
/roadmap-orchestrator:orchestrate <roadmap files...> --until "<milestone>"
```

For local testing before pushing: `/plugin marketplace add ./path/to/this/repo`.

## What it does

- **Phase 0 (interactive):** decomposes the roadmap into a unit DAG, freezes interface
  contracts, writes specs with gradeable acceptance criteria, audits its own plan against
  the raw source material (capped Opus fan-out), and asks you a small, ranked batch of
  questions — the only human touchpoint before autonomy.
- **Execution waves (autonomous):** a zero-token workflow harness runs each unit through
  worktree setup → plan → **Opus-first plan-check** (Fable on escalation, and guaranteed for
  high-risk or infeasible plans) → implement → verify/review/fix →
  **Opus-first exit gate** (escalates to the Fable architect only on genuinely hard or
  foundational calls; high-risk and contract-touching units always take the Fable gate),
  then a serial merge queue with the full test suite as the gate. Between waves the
  architect runs a codebase-health check (test brittleness, structural drift, ergonomics)
  and triages deferred tech debt into a living ledger. Failures quarantine with dossiers;
  nothing loops forever.
- **Session end:** a cross-unit integration review, a spend report, your confirmation
  before `main` moves, and arc close-out (state archived, living constraint + debt docs
  carried forward).

The economics: the frontier model plans, gates, and judges — it never generates volume.
Implementation, review, and fixes run on Opus; mechanics on Haiku; coordination is plain
code. A ~12-unit arc costs on the order of tens of thousands of frontier output tokens,
not the hundreds of thousands a frontier-driven build would.

## Layout

```
.claude-plugin/marketplace.json          # this marketplace
plugins/roadmap-orchestrator/            # the plugin
  .claude-plugin/plugin.json
  skills/orchestrate/
    SKILL.md                             # goals + invariants for the executing architect
    harness.mjs                          # generic zero-token wave executor (dynamic workflow)
    reference.md                         # data shapes, config knobs, platform rules
    evals/                               # end-state-graded regression fixture — run before
                                         #   shipping any harness change (see its README)
DESIGN.md                                # full architecture rationale + verified platform
                                         #   assumptions + empirical findings
PROMPT.md                                # the original design brief
```

## Development

The skill lives only inside the plugin (no duplicate copy). To develop: add this repo as a
local marketplace, install, iterate; before shipping any change to `harness.mjs` (prompts,
schemas, control flow), run the eval fixture per `plugins/roadmap-orchestrator/skills/orchestrate/evals/README.md`
— a green baseline exists and regressions in the architect gates are exactly what it
catches.
