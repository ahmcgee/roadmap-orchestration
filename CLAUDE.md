# roadmap-orchestration

This repo is the **source** of the `roadmap-orchestrator` skill, not a consumer of it.

Prohibitions written *inside* the skill (`plugins/roadmap-orchestrator/skills/orchestrate/`) —
"don't rewrite the scripts", "`unit/` is owned separately, not a place to edit" — address agents
who **installed** the skill from the marketplace and are running an arc with it. They do **not**
bind you here. In this repo, `SKILL.md`, `reference.md`, `harness.mjs`, `conductor.mjs`, and
`evals/**` are all yours to change deliberately.

What still binds you: a script change is not done until the three-tier eval ladder passes —
`evals/parse.sh` → `evals/unit/run.sh` → the paid fixtures (`evals/README.md`).

## GitHub issue tracking — non-obvious traps

Issue mode (`plan.tracking:"issues"`) mirrors the work into GitHub issues. What will bite you:

- **The scheduler never reads `gh`.** Workflow scripts have no network; issues are a Haiku-written
  *projection* of `state.json`, which stays the source of truth. Don't "improve" the scheduler to
  consult issue state — it can't, and it would break `resumeFromRunId`.
- **Every `gh` clause is `''` in file mode**, on purpose: the paid fixtures run offline in file mode,
  so they only stay green because issue-mode prompts are byte-identical to legacy there. The
  prompt-hygiene sims + the fixtures are what enforce this — never emit a `gh` clause unconditionally.
- **Sync is idempotent by the `<!-- roadmap:unit id=<id> -->` body marker, not by issue number.**
  Numbers are non-deterministic; `unit.issue` is a cache only. Don't make anything the scheduler needs
  depend on a number.
- **`gh` writes are best-effort and must no-op cleanly with no remote** (that's why offline fixtures
  pass). A failure records a `gh-sync` degradation and continues; issue state gates nothing.
- **Issue templates only activate on the default branch** — hence the one-time Phase-0 bootstrap PR.
  Committing them to the integration branch does nothing.
- **The debt sweep must never let debt *create* a wave** (conductor tier-2): that guarantee is what
  keeps arcs terminating. Debt rides waves that already exist; leftovers become `roadmap:debt` issues.
- **`roadmap:bug` is dual-consumed** — the same `--label roadmap:bug --state open` list is the wave
  census *and* the Phase-0 candidate-scope read. A bug adopted at **Phase 0** *creating* a wave is
  fine and does not contradict the bullet above: Phase 0 is scope-setting; the "never creates a wave"
  brake is a mid-arc (tier-2) guarantee only. Bugs and proposals share one decomposition mechanic
  (1:1 promote-in-place; 1:N children + close parent with links) — don't leave a dangling
  `status:proposed`/`roadmap:bug` parent beside its children.
- **`skill-feedback.md` is never a product-repo issue** — it's about the orchestrator and must leave
  the product repo.
