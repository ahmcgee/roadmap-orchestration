# roadmap-orchestration

A **roadmap-orchestrator** for Claude Code. Give it a detailed target-state document, a cut line and a codebase;
it decomposes the work into independently verifiable units, builds each in an isolated git worktree, and
converges the codebase on the documented target state, unattended, for a week or more at a time.

## Status

**1.0 is being rebuilt on the `v1` branch.** 0.20.0 remains on `main` (tag `v0.20.0`) and is what the
marketplace installs until 1.0 merges. On `v1` the skill is a stub; the executor is under construction,
milestone M1 (one serial unit).

## What 1.0 is

- A plain Node executor (TypeScript, run directly by Node 24, no runtime dependencies) that owns every
  process, deadline, lock and git operation, and records every side effect write-ahead so it recovers from disk.
- `codex exec` and `claude -p` as peer backends. Every role resolves through a routing profile; the
  `claude-only` profile needs no `codex` CLI.
- A unit DAG with resource locks instead of waves; candidate-first merges, so the tested head is the published
  head and a PR diff holds product changes only.
- A holistic layer (obligations, cadence audits, a checkpoint that steers) that keeps the run converging on the
  target rather than on the original plan.

The binding design is [`DESIGN-1.0.md`](DESIGN-1.0.md). The 0.x design record is in git history at tag `v0.20.0`.

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

## Layout

```
.claude-plugin/marketplace.json     # this marketplace
plugins/roadmap-orchestrator/
  .claude-plugin/plugin.json
  executor/                         # the 1.0 executor (TypeScript on Node 24)
  skills/orchestrate/               # SKILL.md (M1 stub), RATIONALE-1.0.md, templates/
DESIGN-1.0.md                       # binding 1.0 design brief
```

## Development

From `plugins/roadmap-orchestrator/executor/`: `npm run typecheck` → `npm test` → `node evals/probe.ts` (real
CLIs) → the paid fixture in `evals/m1/`, once per merged batch. See `CLAUDE.md`.
