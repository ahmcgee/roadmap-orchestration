# roadmap-orchestration

A **roadmap-orchestrator** for Claude Code. Give it a detailed target-state document, a cut line and a codebase;
it decomposes the work into independently verifiable units, builds each in an isolated git worktree, and
converges the codebase on the documented target state, unattended, for a week or more at a time.

## Status

**1.0 is in prerelease on `main`** (`1.0.0-dev.14`), and it is what the marketplace installs. Milestones M1 to M4b
and the dev.13 milestone walkthroughs have landed. The last 0.x release is at tag `v0.20.0`.

## What 1.0 is

- A plain Node executor (TypeScript, run directly by Node 24, no runtime dependencies) that owns every
  process, deadline, lock and git operation, and records every side effect write-ahead so it recovers from disk.
- `codex exec` and `claude -p` as peer backends. Every role resolves through a routing profile; the
  `claude-only` profile needs no `codex` CLI.
- A unit DAG with resource locks instead of waves; candidate-first merges, so the tested head is the published
  head and a PR diff holds product changes only.
- A holistic layer (obligations, cadence audits, a checkpoint that steers) that keeps the run converging on the
  target rather than on the original plan.
- Milestones: whatever a person or client can use end to end (a web flow, an API, a CLI) is walked as its user would
  walk it before anything is built on top, and a passing walk promotes a demo you can try.

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
working assumption the arc acts on meanwhile, so nothing waits on you. Wherever units combine into something
someone can use end to end, the plan marks a milestone with its journeys, and a design unit writes the milestone's
design references before its other units start. Then the plan and one spec per unit, `roadmap phase0 check` until it
is clean, and `roadmap start`. The executor refuses bad inputs (including plan defects code can catch, such as a
witness its lane never runs), smokes each model backend and takes the host lock.

**3. The run, unattended for days.** A pack review reads the whole plan before any unit is admitted. Units then
run in parallel across the DAG under resource locks: plan-check, a build in the unit's own git worktree, the
lanes (the plan's fast suite lanes, required witnesses, mutation smoke), a fresh-context gate, and publication to
the arc branch. The gate runs in its own checkout with a shell, so it can run experiments; a diff too large to read
whole is reviewed in clusters on the strongest seat. A red lane or gate sends the unit back to its build for a fix
round. A unit whose scope proves too narrow is held at plan-check with a proposed scope growth for the architect to
accept or reject. A crashed executor is restarted by its supervisor and recovers from its write-ahead log.

**Milestones are walked before anything builds on them.** When a milestone's units are all in, code brings the
product up and a walker (a model with a shell, and a browser for web journeys) uses it along each journey as its user
or client would. A finding that would force rework of what is built on top if fixed later is a break: the journey
cannot be completed, an interface contract is wrong, or a declared floor is violated. A break holds the milestone's
dependents until the checkpoint repairs it and a re-walk passes. Everything else (copy, visuals within the design
tokens, docs and log text) is a deviation, repaired alongside without holding anything. Polish the walker proposes
becomes units that code admits, and a polish judge keeps each one only if a walk of before and after shows it
better. A passed milestone promotes the demo: a stable copy on fixed ports that is swapped for a new version only
once that version is up, which you pick up when you choose with `roadmap demo up`.

The architect waits on `roadmap watch --actionable`, which wakes it only on key events (a new needs-user item, a
merge, a park, completion, your answer) and a 30-minute heartbeat. It never runs a backend or touches the
executor's state; it acts only through the executor's commands. A parked unit gets a revised spec (`apply`, then
`resume`), a re-entry under a new id, or a `steer`. You can answer an open question at any time with
`roadmap answer <P-n> --text "…"`, and it applies at once.

**The checkpoint steers toward the vision.** Lens audits run every N merges, on a wall-clock timer and after a
plan change: four model lenses look for broken invariants, drift from the target, vacuous tests and anything that
fails the vision. After every audit, and on a park that is a design problem, the checkpoint rules. It may admit a
unit (a repair, an oversight within the slice, or one opportunity per arc that advances a clause outside it),
respec, re-enter or cut a unit, or amend an obligation, each act citing the vision clauses it serves. Code
validates the bundle and applies it, so its acts go straight back into the run without waiting for anyone. Every
departure from the target is recorded as a divergence, which the architect reviews and can `reverse`. An act only
you may approve becomes an `owner-request`; you are always asked first about anything irreversible, anything
costing over $10, or anything with legal ramifications. What the checkpoint learns about the corpus becomes an
amendment for the next Phase 0. Findings too small to matter are released, not banked as debt: code releases any
P3 not fixed in the same decision, and brakes stop test nitpicks from spawning unit after unit once the milestones
have passed, so the arc's tail converges.

**The flow loop tunes how the arc runs, never what it measures.** It borrows from the Theory of Constraints (where
to act) and statistical process control (when to act). Code does the diagnosis; a model only proposes.

- **Time every station.** Each merged unit's lead time is cut into stations: the service time of each stage
  (plan-check, build, lanes, gate, …) and the wait in front of it, the integration slot (candidate, suite lanes, arc
  lanes, fast-forward), and time held. Code also measures cpu wait for every process tree it launches.
- **Chart lead time.** Lead times go on a control chart (XmR, log scale) whose limits come from earlier arcs on the
  same host, or else from this arc's first five merges. Only a special cause starts a run: a merge or a still-running
  unit above the upper limit, or a worsening trend. Ordinary variation starts nothing. A constraint shift, a closed
  verdict and every 10 merges start one too, with a two-hour cooldown.
- **Name the constraint.** Over the last ten merges, the constraint is the station with the largest mean wait in
  front of it when that wait is at least 10 % of lead time, else the station with the largest mean service time.
  When the host's cpu is saturated (work running at under half speed), the constraint is `host:cpu` ahead of both
  rules, because a starved cpu inflates every station.
- **Propose one lever.** A model in the flow role reads the measurements, may dispute code's constraint with a
  reason, and proposes at most one change aimed at it: concurrency, a resource pool, a suite lane's test-runner
  flags, sequencing, or the build seat's model class. Code drops a proposal that aims elsewhere, uses a lever you
  declared a given, repeats a rejected one, or (at `host:cpu`) would add load. The architect accepts or rejects
  the rest.
- **Prove, apply, judge.** A suite-lane change is proved first: both argvs run on the same commit and must select
  and pass exactly the same tests. The change then applies, and a verdict compares the next five samples against
  the five before: improved, no effect, or worse. Guards (lead, rework, first-run reds) override, so a breach is
  worse; a worse verdict comes back to the architect to revert.

Tests, witnesses, arc lanes, judgment seats, lenses and the vision are the ruler and are never levers. Advice only
you can act on, like more cores, reaches you at the next check-in.

**4. Completion and chaining.** An arc is complete when every unit is merged, every milestone has passed its walk,
every obligation holds on the head and the checkpoint has nothing left to change. `roadmap pr` pushes the arc branch and opens its PR, stacked on the
previous arc's. The architect checks in with `roadmap brief`, a short preface and numbered questions, each with
the assumption it acts on if you have no view. It does not wait for your answers: it chains into the next arc's
Phase 0 with a slice chosen from the census and any notes left in `roadmap-inputs/_next/`, up to K arcs past your last acknowledged brief. It stops at K, when
the vision has nothing left to advance, or when you tell it to. Acknowledging a brief frees the K budget; you can
recalibrate the vision between arcs; and you merge the stacked PRs in order, first into `main`, each with a merge
commit.

## Layout

```
.claude-plugin/marketplace.json     # this marketplace
plugins/roadmap-orchestrator/
  .claude-plugin/plugin.json
  executor/                         # the 1.0 executor (TypeScript on Node 24)
  skills/orchestrate/               # SKILL.md, reference.md (every command), RATIONALE-1.0.md, templates/
  skills/vision/                    # SKILL.md: distil and calibrate the arc's vision in dialogue
docs/flow.svg                       # how an arc runs: who does what
DESIGN-1.0.md                       # binding 1.0 design brief
```

## Development

From `plugins/roadmap-orchestrator/executor/`: `npm run typecheck` → `npm test` → `node evals/probe.ts` (real
CLIs) → the role evals in `evals/roles/` that the batch's changes trigger → the paid fixtures (`evals/m1/`, and
`evals/m5/`, the UI end to end, when milestones, walks, design units or the demo changed), once per merged batch.
See `CLAUDE.md`.
