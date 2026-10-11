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

Then, in the repo you want to build in, run:

```
/roadmap-orchestrator:orchestrate
```

The first run bootstraps the repo and distils the vision with you (it runs the `vision` skill itself). Run
`/roadmap-orchestrator:vision` on its own later, between arcs, to recalibrate the vision.

For local testing before pushing: `/plugin marketplace add ./path/to/this/repo`.

## How an arc runs

![Swimlane flowchart: what you do, what the architect (Claude in your session) does, and what the executor runs unattended, across bootstrap, Phase 0, the run and completion](docs/flow.svg)

Three parties take part. **You** own the target and the vision. The **architect** is Claude in your session,
running the `vision` and `orchestrate` skills: it does the judgment code cannot do. The **executor** is a
detached Node process that owns every process, git operation and lock, and calls models (marked `model` in the
diagram) only where a judgment is needed.

**1. Bootstrap, once per repo.** You write the target state: detailed documents of what the product must become,
the corpus. Then you run `/roadmap-orchestrator:orchestrate`. The architect checks the repo's issue policy and
writes the corpus guide, then runs the `vision` skill: it distils your vision in dialogue, one question at a time,
and plays back the decisions it would make on your behalf. You confirm it explicitly, set K (how many arcs may run
past your last acknowledged check-in) and pick the first slice of the vision to build. The architect compiles
`.roadmap/vision.json` and commits `.roadmap/`.

**2. Phase 0, each arc.** The architect plans the arc in session, fanning the reading out to subagents. Every
normative claim in the corpus becomes one rule (`T-n`); the corpus is pinned; each rule the slice needs becomes a
testable obligation with its witness tests. Questions the vision cannot settle are ranked (`P-n`), each with the
working assumption the arc acts on meanwhile, so nothing waits on you. Then the plan and one spec per unit,
`roadmap phase0 check` until it is clean, and `roadmap start`. The executor refuses bad inputs, smokes each model
backend and takes the host lock.

**3. The run, unattended for days.** A pack review reads the whole plan before any unit is admitted. Units then
run in parallel across the DAG under resource locks: plan-check, a build in the unit's own git worktree, the
lanes (tests, required witnesses, mutation smoke), a fresh-context gate, and publication to the arc branch. A red
lane or gate sends the unit back to its build for a fix round. Every few merges the checkpoint audits the arc
against the vision, admits repair or opportunity units and records each divergence; the flow loop names the
bottleneck and proposes at most one change to how the arc runs. A crashed executor is restarted by its
supervisor and recovers from its write-ahead log.

The architect waits on `roadmap watch --actionable`, which wakes it only on key events (a new needs-user item, a
merge, a park, completion, your answer) and a 30-minute heartbeat. It adjudicates what the executor hands over
(parked units, pack-review findings, checkpoint bundle requests, flow proposals) and steers only through the
executor's commands: `apply` a revised plan, re-enter or `steer` a unit, `reverse` a divergence, `pause`, `stop`.
You can answer an open question at any time with `roadmap answer <P-n> --text "…"`, and it applies at once. You
are always asked first about anything irreversible, anything costing over $10, or anything with legal
ramifications.

**4. Completion and chaining.** An arc is complete when every unit is merged, every obligation holds on the head
and the checkpoint has nothing left to change. `roadmap pr` pushes the arc branch and opens its PR, stacked on the
previous arc's. The architect checks in with `roadmap brief`, a short preface and numbered questions, each with
the assumption it acts on if you have no view. It does not wait for your answers: it chains into the next arc's
Phase 0 with a slice chosen from the census, up to K arcs past your last acknowledged brief. It stops at K, when
the vision has nothing left to advance, or when you tell it to. Acknowledging a brief frees the K budget; you can
recalibrate the vision between arcs; and you merge the stacked PRs in order, first into `main`, each with a merge
commit.

## Layout

```
.claude-plugin/marketplace.json     # this marketplace
plugins/roadmap-orchestrator/
  .claude-plugin/plugin.json
  executor/                         # the 1.0 executor (TypeScript on Node 24)
  skills/orchestrate/               # SKILL.md (M1 stub), RATIONALE-1.0.md, templates/
  skills/vision/                    # SKILL.md: distil and calibrate the arc's vision in dialogue
docs/flow.svg                       # how an arc runs: who does what
DESIGN-1.0.md                       # binding 1.0 design brief
```

## Development

From `plugins/roadmap-orchestrator/executor/`: `npm run typecheck` → `npm test` → `node evals/probe.ts` (real
CLIs) → the paid fixture in `evals/m1/`, once per merged batch. See `CLAUDE.md`.
