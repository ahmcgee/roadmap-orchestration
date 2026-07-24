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

## Work tracking with GitHub issues

If the repo has a usable GitHub remote and `gh` is authenticated, the arc runs in **issue
mode** and GitHub issues become the place you watch and steer the work. If not, it falls back
to **file mode** — the original filesystem tracking under `.roadmap/`, unchanged — so the skill
still works in local-only or non-GitHub repos. The mode is detected once, at Phase 0.

In issue mode you get, in your repo's issue tracker:

- **One milestone per arc** with a progress bar, and one **arc tracking issue** (`roadmap:arc`)
  that is the dashboard — plan summary, the unit DAG, a live status table, and the session
  report at the end.
- **One issue per unit** (`roadmap:unit`), labelled with its state at a glance —
  `status:pending → running → merge-ready → merged` (closed when merged), or
  `blocked` / `quarantined` (a quarantined unit stays open with its dossier posted as a comment).
  Units beyond the cut line appear as `status:backlog` issues.
- **Debt as durable issues** (`roadmap:debt`). Tech debt is swept up aggressively — while an arc
  still has planned work running, even minor debt is folded into the next wave as fix-work rather
  than left to pile up. Whatever debt remains when the planned work is done stays as open issues
  and is picked up automatically at the start of the next arc.

You interact with a running (or future) arc through two issue templates the skill installs the
first time it runs here (via a small one-time PR you merge — a GitHub issue template only becomes
active once it's on the default branch):

- **Roadmap feedback** — file a `roadmap:feedback` issue at any time. It's read at the next wave
  boundary and triaged (actioned / dismissed / deferred), never injected into a unit mid-build.
- **Propose a roadmap unit** — file a `roadmap:unit` proposal (`status:proposed`) to expand the
  roadmap yourself; the architect adjudicates it (adopt / split / defer / decline) at the next
  Phase 0.

At session end the arc is delivered as **one pull request** (integration branch → your default
branch) that closes its unit issues on merge — merging it is your sign-off, and `main` never moves
until you do.

Issues are a *projection* of the work: the orchestrator's scheduler always runs on its own
committed `.roadmap/state.json`, and every `gh` write is best-effort — if GitHub is briefly
unreachable the arc is unaffected and the projection reconciles at the next wave boundary. Issue
state never gates the build. (Ordinary non-`roadmap:*` issues in the repo are ignored by the skill.)

## Layout

```
.claude-plugin/marketplace.json          # this marketplace
plugins/roadmap-orchestrator/            # the plugin
  .claude-plugin/plugin.json
  skills/orchestrate/
    SKILL.md                             # goals + invariants for the executing architect
    harness.mjs                          # generic zero-token wave executor (dynamic workflow)
    conductor.mjs                        # multi-wave dispatch + tiered boundary triage
    reference.md                         # data shapes, config knobs, platform rules
    RATIONALE.md                         # why the skill is shaped this way (not loaded at runtime)
    templates/                           # issue-template reference copies (issue mode bootstrap)
    evals/                               # three-tier eval ladder — run before shipping a script
                                         #   change (see its README)
DESIGN.md                                # full architecture rationale + verified platform
                                         #   assumptions + empirical findings
PROMPT.md                                # the original design brief
```

## Development

The skill lives only inside the plugin (no duplicate copy). To develop: add this repo as a
local marketplace, install, iterate. A change to `harness.mjs` or `conductor.mjs` is not done
until the three-tier eval ladder passes — `evals/parse.sh` (syntax) → `evals/unit/run.sh`
(zero-token control-flow sims) → the paid fixtures (`evals/check.sh`, `evals/check-conductor.sh`),
which run offline in **file mode**. Issue-mode (real `gh`) behaviour has its own opt-in integration
eval, `evals/check-issues.sh`, which runs a mini-arc against this repo and tears its issues down
afterwards. See `plugins/roadmap-orchestrator/skills/orchestrate/evals/README.md`.
