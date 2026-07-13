# roadmap-orchestration

This repo is the **source** of the `roadmap-orchestrator` skill, not a consumer of it.

Prohibitions written *inside* the skill (`plugins/roadmap-orchestrator/skills/orchestrate/`) —
"don't rewrite the scripts", "`unit/` is owned separately, not a place to edit" — address agents
who **installed** the skill from the marketplace and are running an arc with it. They do **not**
bind you here. In this repo, `SKILL.md`, `reference.md`, `harness.mjs`, `conductor.mjs`, and
`evals/**` are all yours to change deliberately.

What still binds you: a script change is not done until the three-tier eval ladder passes —
`evals/parse.sh` → `evals/unit/run.sh` → the paid fixtures (`evals/README.md`).
