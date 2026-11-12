# roadmap-orchestrator

A Claude Code plugin that builds toward a written target, unattended, for a week or more at a time.

You describe where the codebase should end up and how far to go this time. The orchestrator breaks that into
independently verifiable units, builds each one in an isolated git worktree, and merges a unit only when the exact
commit has passed its tests and an independent review.

> **Status: 1.0 prerelease, on `main`.** The current version is in
> [`plugin.json`](plugins/roadmap-orchestrator/.claude-plugin/plugin.json). Arcs started on `1.0.0-dev.32` or earlier
> are refused, not adopted; finish them with their original executor. The last 0.x release is tag `v0.20.0`.

## Quick start

You need Claude Code, Node 24 and git on Linux. The executor normally runs in a devcontainer.

```
/plugin marketplace add ahmcgee/roadmap-orchestration
/plugin install roadmap-orchestrator@roadmap-orchestration
```

Then, in the repo you want to build in:

```
/roadmap-orchestrator:orchestrate
```

The first run sets the repo up and works out the vision with you. After that it plans, starts the run and gives you
a link to the web console.

| Command | Use it to |
|---|---|
| `/roadmap-orchestrator:orchestrate` | Start or continue an arc. |
| `/roadmap-orchestrator:vision` | Recalibrate the vision between arcs. |
| `/roadmap-orchestrator:estate-compaction` | Prune the rules, obligations and debt that arcs accumulate. |

## How an arc runs

An **arc** is one run: a slice of the target, taken from plan to pull request.

![Three lanes: the owner confirms the vision, answers questions and acknowledges the brief; the architect plans, supervises and closes out; the executor reviews, builds, publishes and judges](docs/flow.svg)

Three parties are involved:

- **Owner** (you) confirms the vision, answers the questions only you can, and sets how many arcs may run before
  the next check-in.
- **Architect** is the Claude agent in your conversation. It writes the plan, supervises the run and reports back.
- **Executor** is a detached Node process. It owns every process, resource, git operation and piece of evidence,
  and recovers from crashes.

The stages:

1. **Plan.** The architect turns the target into numbered rules, picks a slice, and writes a plan of units. Each
   unit states its intent, its non-goals and the tests that will prove it.
2. **Review.** A fresh reviewer checks the plan against the target before any work is admitted.
3. **Build and certify.** Each ready unit is built in its own worktree. The executor then runs the full checks, and
   a fresh reviewer (the gate) judges the diff against the unit's intent. Failures feed fix rounds.
4. **Publish.** An approved unit is tested again on top of the current integration branch. Only that exact green
   commit is fast-forwarded and pushed. `main` is never pushed.
5. **Judge.** When a milestone's units have merged, a reviewer walks the product as a user would. Whole-campaign
   audits look for broken invariants, hollow tests and drift from the documents.
6. **Supervise.** Throughout, the architect watches for events that need a decision, revises the plan through
   versioned edits, and brings you only the questions that are yours.
7. **Close out.** The architect prepares a stacked pull request and presents a brief and a demo. The next arc
   starts only within the bound you set.

Go deeper:

- [How an arc runs: the detailed reference](docs/how-an-arc-runs.md) covers every stage, park, limit and recovery rule.
- [Detailed process diagram](docs/flow-bpmn.svg) shows the same flow in BPMN.

## Watching a run

- **Web console** at `http://localhost:4747`: read-only views of the dependency graph, timeline, activity, effort,
  resources and decisions waiting for you.
- **Terminal UI**: `roadmap tui --repo <path> --arc <id>` in a second terminal.
- **The architect**: ask it in the conversation.

The console has **no authentication** and binds to all interfaces by default. On an exposed host, bind it to
loopback first. [Console, TUI and launcher guide](docs/console.md) has the setting.

## Good to know

- **Spend is forecast, never capped.** Hitting a usage limit parks that backend until you resume it.
- **Two routing profiles.** `default` mixes eligible Codex builds with Claude judgments. `claude-only` needs no
  Codex CLI.
- **Runs survive crashes.** Every side effect is written ahead and replayed; a supervisor restarts the executor.
- **Updating mid-arc.** Run `roadmap stop --drain`, wait for the run to end, update the plugin, then `roadmap start`.

## Words you will meet

| Term | Meaning |
|---|---|
| Arc | One run over a slice of the target, ending in a pull request and a brief. |
| Unit | One independently verifiable piece of work, built in its own worktree. |
| Pack | The architect's inputs for an arc: plan, specs, obligations and witnesses. Kept outside the product tree. |
| Lane | A named check the executor runs, such as a test suite, lint or typecheck. |
| Witness | An executable test that proves a target obligation is met. |
| Gate | The fresh, independent review of a unit's diff before it can be published. |
| Park | A unit or backend set aside for a decision while the rest of the arc carries on. |
| Milestone | A usable end-to-end experience, judged by walking through it. |
| Estate | What arcs accumulate over time: rules, obligations, ledger entries and debt. |

## Documentation

| Read | For |
|---|---|
| [docs/how-an-arc-runs.md](docs/how-an-arc-runs.md) | Each stage in detail, and the rules across them |
| [docs/console.md](docs/console.md) | Web console, TUI and the `roadmap` launcher |
| [Operating reference](plugins/roadmap-orchestrator/skills/orchestrate/reference.md) | Every command and input format |
| [DESIGN-1.0.md](DESIGN-1.0.md) | The binding design |
| [SCHEMAS.md](plugins/roadmap-orchestrator/executor/SCHEMAS.md) | Exact record and wire contracts |
| [RATIONALE-1.0.md](plugins/roadmap-orchestrator/skills/orchestrate/RATIONALE-1.0.md) | Why it is built this way |

## Repository layout

```
.claude-plugin/marketplace.json     # this marketplace
plugins/roadmap-orchestrator/
  .claude-plugin/plugin.json
  executor/                         # the executor: TypeScript run directly by Node 24, no runtime dependencies
  skills/orchestrate/               # runs an arc
  skills/vision/                    # distils and calibrates the vision with you
  skills/estate-compaction/         # prunes the accumulated estate with you
docs/                               # guides and diagrams
DESIGN-1.0.md                       # binding 1.0 design brief
```

## Development

To try a local checkout: `/plugin marketplace add ./path/to/this/repo`.

Checks run from `plugins/roadmap-orchestrator/executor/`, in order. Run only the rungs a change triggers;
[`CLAUDE.md`](CLAUDE.md) says which.

| Rung | Command | Cost |
|---|---|---|
| 1 | `npm run typecheck` | Free |
| 2 | `npm test` | Free |
| 3 | `node evals/probe.ts` | Real CLIs, pennies |
| 3.5 | Role evals in `evals/roles/` | Paid, path-triggered |
| 4 | Paid fixtures `evals/m1/` and `evals/m5/` | Paid, once per merged batch |

[`evals/README.md`](plugins/roadmap-orchestrator/executor/evals/README.md) describes the harness.

## Licence

Copyright (C) 2026 Aaron McGee

roadmap-orchestrator is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser
General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your
option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [`COPYING.LESSER`](COPYING.LESSER)
(the GNU Lesser General Public License) and [`COPYING`](COPYING) (the GNU General Public License it supplements); both
are also shipped inside the plugin at `plugins/roadmap-orchestrator/`.

Third-party material keeps its own licence: the web console's bundled libraries and fonts are listed in
`plugins/roadmap-orchestrator/executor/web/THIRD-PARTY-NOTICES.txt`, and files that carry their own licence notice
(for example under `executor/web-src/components/ui/` and the eval fixtures) remain under it.
