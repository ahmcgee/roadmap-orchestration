# roadmap-orchestration

A **roadmap-orchestrator** with Claude Code and Codex-native drivers. Give it a roadmap
(prose, checklist, tracker export,
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

### Codex / Astra

The separate [`roadmap-orchestrate` skill](plugins/roadmap-orchestrator/skills/roadmap-orchestrate/SKILL.md)
uses Astra and Codex's native subagents. It needs Node, Git and a POSIX shell, and does not call Claude Code or
its dynamic workflows. Astra directs the arc **and directly implements the hardest, highest-risk
units**; independent agents review those changes. Routine implementation can run in parallel in
explicitly assigned worktrees. Deterministic helpers handle checkpoints, recovery and tested merges.

Clone this repository, then symlink the skill into your user skill directory:

```sh
mkdir -p ~/.agents/skills
ln -s /absolute/path/to/roadmap-orchestration/plugins/roadmap-orchestrator/skills/roadmap-orchestrate ~/.agents/skills/roadmap-orchestrate
```

Alternatively, use Codex's skill installer with that repository subdirectory. The native skill is
self-contained. Select Astra in Codex, then invoke:

```text
$roadmap-orchestrate <roadmap files...> up to <milestone>
```

The repository's `.agents/skills` link also makes it discoverable when working in this checkout.
Invocation is explicit. No global model or agent configuration is overwritten.

### Switching drivers

Both drivers share `.roadmap/plan.json`, state, specs, contracts, debt, evidence and Git branches.
Update both installations, stop the current driver **and its workers**, checkpoint its latest work,
and ask the other driver to resume the same arc. It acquires ownership, reconciles Git, adopts
unfinished commits and re-runs incomplete checks; live model sessions are not transferred. Dirty
worktrees are preserved for inspection. See the [handoff protocol](plugins/roadmap-orchestrator/skills/roadmap-orchestrate/references/protocol.md).

Only one driver owns an arc at a time, in the same repository/worktree environment. The Claude
driver still uses Codex for its worker lanes, so it is not an independent capacity pool when Codex
limits are exhausted.

## What it does

The following execution tiers describe the Claude driver. The Codex driver keeps the roadmap
lifecycle and quality gates, with Astra/native-agent roles described in its skill.

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

- **Report a bug or problem** — file a `roadmap:bug` issue at any time, including *between sessions*.
  It's read both at the next wave boundary (during a live arc) and at the next Phase 0 (as candidate
  scope for a fresh arc), then adjudicated (adopt / split / fold / defer / decline) like any candidate
  work — never injected into a unit mid-build.
- **Propose a roadmap unit** — file a `roadmap:unit` proposal (`status:proposed`) to request *new*
  work or an enhancement; the architect adjudicates it (adopt / split / defer / decline) at the next
  Phase 0. (Reporting something *broken* goes to the bug template above.)

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
  skills/roadmap-orchestrate/             # self-contained Codex-native skill
    SKILL.md                             # Astra implements hard work and directs native agents
    scripts/                             # shared protocol + deterministic lifecycle helpers
    references/                          # shared handoff contract and GitHub projection rules
    tests/                               # real-Git tests + native forward fixture
.agents/skills/roadmap-orchestrate        # discovery symlink to that single source copy
DESIGN.md                                # full architecture rationale + verified platform
                                         #   assumptions + empirical findings
PROMPT.md                                # the original design brief
```

## Development

Native-driver checks: `node --test plugins/roadmap-orchestrator/skills/roadmap-orchestrate/tests/*.test.mjs`.
These exercise real Git repositories, interrupted checkpoints and both handoff directions. The native
behavior fixture and its execution instructions are in that skill's `tests/forward-test.md`.

The skill lives only inside the plugin (no duplicate copy). To develop: add this repo as a
local marketplace, install, iterate. A change to `harness.mjs` or `conductor.mjs` is not done
until the three-tier eval ladder passes — `evals/parse.sh` (syntax) → `evals/unit/run.sh`
(zero-token control-flow sims) → the paid fixtures (`evals/check.sh`, `evals/check-conductor.sh`),
which run offline in **file mode**. Issue-mode (real `gh`) behaviour has its own opt-in integration
eval, `evals/check-issues.sh`, which runs a mini-arc against this repo and tears its issues down
afterwards. See `plugins/roadmap-orchestrator/skills/orchestrate/evals/README.md`.
