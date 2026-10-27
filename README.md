# roadmap-orchestration

A **roadmap-orchestrator** for Claude Code. Give it a detailed target-state document, a cut line and a codebase;
it decomposes the work into independently verifiable units, builds each in an isolated git worktree, and
converges the codebase on the documented target state, unattended, for a week or more at a time.

## Status

**1.0 is in prerelease on `main`** (`1.0.0-dev.23`), and it is what the marketplace installs. Milestones M1 to M4b
and the dev.13 milestone walkthroughs have landed. dev.17 made plan-check a design pass, put lanes on cadences
selected by a systems map, made the gate block only on named defects, and added propagation and deflake units,
costed environments and per-unit fault isolation. The last 0.x release is at tag `v0.20.0`.

## What 1.0 is

- A plain Node executor (TypeScript, run directly by Node 24, no runtime dependencies) that owns every
  process, deadline, lock and git operation, and records every side effect write-ahead so it recovers from disk.
- `codex exec` and `claude -p` as peer backends. Every role resolves through a routing profile; the
  `claude-only` profile needs no `codex` CLI.
- A unit DAG with resource locks instead of waves; candidate-first merges, so the tested head is the published
  head and a PR diff holds product changes plus the living `.roadmap/` docs.
- A holistic layer (obligations, cadence audits, a checkpoint that steers) that keeps the run converging on the
  target rather than on the original plan.
- Milestones: whatever a person or client can use end to end (a web flow, an API, a CLI) is walked as its user would
  walk it before anything is built on top, and each settled milestone promotes a running demo you can try.

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

The skill installs a managed `/usr/local/bin/roadmap` launcher inside the executor container and refreshes
it on each skill session. Developers can then use `roadmap tui` in another terminal. After startup and at
completion, the skill supplies a command pinned to that arc for inspection. The launcher points to the
installed plugin and the current Node executable; no global npm package or copied executor is required.
For manual setup, run `node "<plugin root>/executor/bin/install-roadmap"` (with container administrator
rights if needed), or pass `--bin-dir <directory>` for a writable PATH directory. Unrelated commands are
never overwritten. Keep the plugin installed; refresh the launcher after updates or container rebuilds.

For local testing before pushing: `/plugin marketplace add ./path/to/this/repo`.

## How an arc runs

![Simplified overview: the three parties (you, the architect, the executor) across bootstrap, Phase 0, the run with its unit pipeline, milestone walk and checkpoint, and completion and chaining](docs/flow.svg)

The detailed process, in BPMN notation: [docs/flow-bpmn.svg](docs/flow-bpmn.svg).

Three parties take part. **You** own the target and the vision. The **architect** is Claude in your session,
running the `vision` and `orchestrate` skills: it does the judgment code cannot do. The **executor** is a
detached Node process that owns every process, git operation and lock, and calls models only where a build or a
judgment is needed. Builds run on an efficient model (Sonnet 5.5 under the `claude-only` profile) with an Opus
advisor; Opus judges plan-check and the gate at every risk tier.

**1. Bootstrap, once per repo.** You write the target state: detailed documents of what the product must become,
the corpus. Then you run `/roadmap-orchestrator:orchestrate`. It installs or refreshes the container’s `roadmap` command on PATH. The architect writes the corpus guide, then runs the `vision` skill: it distils your vision in dialogue, one question at a time,
and plays back the decisions it would make on your behalf. You confirm it explicitly, set K (how many arcs may run
past your last acknowledged check-in) and pick the first slice of the vision to build. The architect compiles
`.roadmap/vision.json` and commits `.roadmap/`. It offers a boot hook that brings a dead arc back after a host
restart, and for an arc with milestones it makes sure the walk tools (the bring-up programs, and the Playwright MCP
for browser journeys) are installed in the devcontainer.

**2. Phase 0, each arc.** The architect plans the arc in session. Every normative claim in the corpus becomes one
rule (`T-n`); the corpus is pinned; each rule the slice needs becomes a testable obligation with its witness tests.
Questions the vision cannot settle are ranked (`P-n`), each with the working assumption the arc acts on meanwhile,
so nothing waits on you. Wherever units combine into something someone can use end to end, the plan marks a
milestone with its journeys, and a design unit writes the milestone's design references before its other units
start. The architect maps the repo's systems once, in `.roadmap/config.json`: each system's paths, tests and
dependencies. Every test lane declares the systems it tests and its cadence: `build` (the builder runs it in its
loop), `unit` (after the build), `candidate` (on the merge) or `batch` (end-to-end runs too slow for every merge,
kept off the merge path). Lanes that need costly infrastructure name an environment. Then the plan and one spec per
unit, `roadmap phase0 check` until it is clean, and `roadmap start`. The executor refuses bad inputs (including plan
defects code can catch, such as a witness its lane never runs or a lane naming an unmapped system), smokes each
model backend and takes the host lock.

**3. The run, unattended for days.** A pack review reads the whole plan before any unit is admitted. Units then
run in parallel across the DAG under resource locks, each through plan-check, a build, the lanes, a gate and a
candidate merge.

- **Plan-check is a design pass.** An Opus judge works in a checkout of the tip with a shell and web search, and
  writes a design record: what changes in which systems, the interfaces, the failure modes and the test proving each,
  and which lanes exercise each acceptance clause. Code binds the record: it refuses one whose tests no lane reaches
  before the merge, or whose diff would be too large to review. Instead of approving, plan-check may redirect the
  spec, split the unit into smaller ones, have a cheap model scaffold a new system's skeleton first, or ask for up
  to two throwaway proofs of concept whose lessons, never code, reach the build. A unit whose scope proves too
  narrow is held with a proposed scope growth for the architect to accept or reject.
- **The build** runs in the unit's own git worktree. Code reverts any path it edits outside the scope, and the same path
  reverted on two build rounds running is held as a scope growth too. A build that starts on a fresh session
  after earlier work, such as a re-entry, a steer or a new seat, gets a handover built by code: the park diagnosis, the last
  gate's findings, the clauses still unmet and the last red evidence.
- **The lanes** run the spec's lanes, then the plan's `build`- and `unit`-cadence suite lanes and any the spec
  forces, then the required witnesses and mutation smoke. A lane's pass is reused on any later commit that leaves
  its systems unchanged. When a fix round only touched comments and docs, code and a cheap verifier certify that,
  and the earlier passes carry over. Environments come up on first use and go down when idle; one that fails to
  come up parks the unit until it recovers, never a red lane.
- **The gate** is a fresh Opus judge in its own checkout with a shell, so it can run experiments. A diff too large
  to read whole is reviewed in clusters. It blocks only on a named defect: incorrect behaviour, a contract violation,
  a security or data-loss problem, an unmet requirement, or a test cited as proof that does not prove it. Comment
  and doc findings ride along and never send the unit back. Findings go into a ledger, so a settled finding cannot
  block again unless its file changed, and a re-gate reviews only what changed since the last approval. When nothing
  changed, it approves again without a call.
- **The candidate** merges the unit onto the arc tip in the integration slot and runs the `candidate`-cadence
  suite lanes the systems map selects (every lane for an unmapped path, none for a docs-only diff), then
  fast-forwards the arc branch.

A red lane, a gate revise or a red candidate sends the unit back to its build for a charged fix round. A gate
revises at most twice before the unit goes to the escalation seat, the summit class (Opus at high effort). A red candidate
retries once, and the third charged failure parks the unit. A lane that goes red then green on a rerun of the same
tree is a flake, recorded in the flaky ledger. On a unit's own commit (its lanes, witness check or scaffold dry run),
it is the unit's red: a charged fix round tells the builder the lane is flaky, forgiven only if it is already a standing
tip flake. Only flakes seen on the integration tip are forgiven and mint deflake units to fix the test (a deflake
unit's own flake still counts as red). A deflake's scope is the systems the lane declares, else the systems holding
the flaky test's file, with what they depend on.
No unit may write the corpus, so when neither maps and the fallback would reach it, no unit is minted and you get
a `deflake-unscoped` item asking for the lane's systems or a systems map.
When a requirement or contract changes mid-arc, code mints a propagation unit that re-witnesses the merged code
against the new revision; units linked to the change re-open at plan-check, and none reaches its gate until the
propagation unit merges. A fault confined to one unit parks only that unit and the arc goes on; a crashed executor
is restarted by its supervisor and recovers from its write-ahead log.

**Milestones are walked before anything builds on them.** When a milestone's units are all in, the plan's `batch`
lanes whose systems changed run first; a red one is a break. Then code brings the product up and a walker (a model
with a shell, and a browser for web journeys) uses it along each journey as its user or client would. A finding
that would force rework of what is built on top if fixed later is a break: the journey cannot be completed, an
interface contract is wrong, or a declared floor is violated. A break holds the milestone's dependents until the
checkpoint repairs it and a re-walk passes, for at most three rounds by default. Everything else (copy, visuals
within the design tokens, docs and log text) is a deviation, repaired alongside without holding dependents. Any
unweighed walk finding gets an immediate checkpoint and holds the walk round open for repair and re-walk,
bounded by `walkRounds`; every walk follows merged code. Polish the walker proposes becomes units that code admits, and a polish judge keeps each one only if a walk of before and after
shows it better. Each settled milestone promotes the demo automatically: the supervisor brings the new version up
on stable ports beside the old one and switches over once it is ready. `roadmap status` gives the address, and
`roadmap demo hold|release|down|up` are your controls.

For a human view inside the executor environment, run `roadmap tui`. A single navigation row contains
`1` Dependency map, `2` Activity, `3` Estate and `4` Exceptions; Tab or Left/Right moves between them.
The map and compact Activity remain side by side (stacked at 80 columns). Highlighting a map node brings
all its related activity into Activity, marked `*` in cyan. Running invocations always lead (linked first),
then linked history, other history and queued commands; other activity keeps muted labels. `x` expands
or restores Activity, `g` toggles map context/all activity, and `a` reveals all retained history. Rows distinguish
Agent, Command and Queued work; Arc-wide labels explain work outside individual units. Supporting status
and output are indented beneath their own activity row. Enter opens logs or the selected item's details.
Agent rows identify the recorded model and explicitly label adapters. The header counts active agents and
commands, including arc-wide jobs, and explains when execution is waiting. Confirmed baseline checks
of future requirements say `pre-delivery`; they and successful mutation detections are distinguished from faults; Result retains
the original command outcome. Earlier audit checks of still-future requirements say `pre-delivery`,
which describes the check's timing, even after the arc completes. Witness checks link to units through the recorded obligations.
Milestone labels show membership, progress and checkpoint state; `m` moves between milestones. The map
shows open work by default: merged, cut and superseded units, resolved conditions and settled milestones
are hidden. `c` toggles the full map; the panel counts hidden settled nodes. Open milestone checkpoints stay
visible after their gate passes. Hidden settled prerequisites are satisfied, shown as `✓` in the preview.
On the map and Activity, `r` / `R` jumps to the next / previous running item, wrapping at either end;
the map includes preparing units and milestones with open walkthroughs. A notice explains when none are running.
Walkthroughs and bring-up commands name their recorded milestone. Graph connectors remain neutral; successfully
settled milestones on the full map use the same green check as merged units. A due walkthrough says “walkthrough pending”;
waiting units name their outstanding gate or dependency. The bold amber “Executor stopped” banner and STOPPED badge mean work cannot advance.
Compatibility diagnostics are informational viewer notes under `4 Exceptions & notes`, with a plain-language
explanation and technical details. They never replace the run status or increase exception/fault counts.
Explicit unit replacements show “Replaces” / “Replaced by” on visible nodes, separately from dependency paths.
`c` reveals settled versions; selecting either highlights their combined activity, with each row
retaining its actual unit. Related documents links between versions. Redirected prerequisites name both
the declared unit and its replacement. The selection preview shows the retained specification revision;
revising a specification in place does not create another node.

For a persistent scripted replacement example (real stages and Git, no model calls), run
`node test/fixtures/tui-lineage-demo.ts` from `plugins/roadmap-orchestrator/executor/`, then run the printed
`tui` launcher. This stages a superseded unit, its merged replacement, a downstream dependency and a
milestone that follows the replacement. It is a stopped snapshot with retained activity, not a live executor.

Estate leads with Vision, Arc scope (the selected vision clauses), the execution plan and recorded intent, then sorts documents
alphabetically. Collections (vision clauses/questions, constraints/rulings, obligations, corpus rules and
debt) show counts and start collapsed. Space expands/collapses a selected collection; Enter opens its
document or a child entry. Numbered entries sort naturally (V-2 before V-10). `/` and `n` search hidden
entries too and expand the parents of a matched entry. `w` controls inactive entries; collection counts
reflect that setting. Cross-links remain available independently of the hierarchy. Absent vision and slice records explicitly say
“Not recorded for this run”; recorded intent remains separate. Debt includes inherited items, recorded
Phase-0 dispositions and newly banked items, plus the published debt document at the captured integration
commit. Individual debt items link to recorded units and rulings; `w` reveals promoted/resolved debt and
other inactive entries. Missing debt records are distinguished from an empty recorded ledger.

`/` finds without hiding content: Enter jumps to a match, `n` advances, and `N` goes back, wrapping at either
end. Activity searches all retained invocations; transcripts search the loaded page, with Page Up/Down
available for older/newer pages. Esc clears the search without moving your position, then returns to the
previous location. `?` explains the available controls. Unit details link specifications, implementation
plans, planning inputs and results. Readable structured records, Markdown and prompt sections are the
default; `r` toggles raw data in details and logs, and `b` opens the original input from a repair turn when retained.

The viewer refreshes automatically and makes no runtime writes. `roadmap tui --repo <path> --arc <id>` pins
a retained run. Revision hashes and captured commits identify the documents shown; unapplied edits are
excluded. The header shows the signed-in Claude account's five-hour and weekly usage, reset countdowns
and freshness, using a read-only request every five minutes with cached fallback. Closing the viewer
leaves the executor running.

The architect waits on `roadmap watch --actionable`, which wakes it only on key events (a new needs-user item, a
merge, a park, the run held, blocked or draining, the run ending, your answer) and a 30-minute heartbeat. It never
runs a backend or touches the executor's state; it acts only through the executor's commands. A parked unit gets a
revised spec (`apply`, then `resume`), a re-entry under a new id naming the failure it fixes, or a `steer`. A
usage limit parks that backend arc-wide until `resume --backend`. An `apply` that touches a unit mid-stage is
queued and lands at the stage boundary; if it can no longer apply there, the architect gets an item and redoes
the edit. To edit something the executor changed (a spec it patched, a unit it minted), the architect runs
`roadmap inputs export`, syncs the export over the inputs, edits them and applies with `--base <export>/export.json`.
With the executor down, `roadmap start --base` takes the same base. You can answer an open question at any time with `roadmap answer <P-n> --text "…"`, and it applies at
once.

**The checkpoint steers toward the vision.** Lens audits run every five publications, on a wall-clock timer after a
new publication, after a semantic plan change, when a publication leaves an active future obligation unwitnessed, and once more when
no work remains. Waiving, deferring, retiring or latching an obligation removes its unwitnessed trigger during the
same run. Ordinary audits need an outstanding range in a selected lens; an explicit request or semantic drift
can audit an unchanged head, and final audits cover only outstanding lenses. Four model lenses look for broken
invariants, drift from the target, vacuous tests and anything that fails the vision. A lost lens call gets at most two
reissues across restarts, then its audit is abandoned.

With milestones, the steering checkpoint runs every two retired milestones by default
(`holistic.checkpoint.everyMilestones`), after the boundary milestone's walk ends, weighing the accumulated audit and
walk findings. Any unweighed walk finding, at any severity, gets an immediate checkpoint, which also weighs all
active audit findings. A vision edit reopens this immediate trigger for open findings weighed only under the old
vision, even after a decision or skip. Walk checkpoints do not count toward or reset the milestone interval. A design park, a new
unweighed audit P1 and the final audit at close-out also get immediate checkpoints. Without milestones, audits keep
triggering checkpoints when they find something new. Every non-park trigger skips the call when a decided checkpoint
already captured the same head, plan revision, vision and active finding set, so a milestone boundary does not repeat an unchanged walk capture. Status shows the milestones remaining
to the next steering checkpoint. It may admit a unit (a repair, an oversight within the slice, or one opportunity per
arc that advances a clause outside it), respec, re-enter or cut a unit, or amend an obligation, each act citing the vision clauses it serves. Code validates the bundle and applies
it, so its acts go straight back into the run without waiting for anyone. Every departure from the target is
recorded as a divergence, which the architect reviews and can `reverse`. An act only you may approve becomes an
`owner-request`; you are always asked first about anything irreversible, anything costing over $10, or anything with
legal ramifications. What the checkpoint learns about the corpus becomes an amendment for the next Phase 0. Findings
too small to matter are released, not banked as debt: code releases any P3 not fixed in the same decision, and
brakes stop test nitpicks from spawning unit after unit once the milestones have passed, so the arc's tail
converges.

**The flow loop tunes how the arc runs, never what it measures.** It borrows from the Theory of Constraints (where
to act) and statistical process control (when to act). Code does the diagnosis; a model only proposes.

- **Time every station.** Each merged unit's lead time is cut into stations: the service time of each stage
  (plan-check, proof of concept, scaffold, build, lanes, gate, …) and the wait in front of it, the integration slot
  (candidate, suite lanes, arc lanes, fast-forward), and time held. Code also measures cpu wait for every process
  tree it launches.
- **Chart lead time.** Lead times go on a control chart (XmR, log scale) whose limits come from earlier arcs on the
  same host, or else from this arc's first five merges. Only a special cause starts a run: a merge or a still-running
  unit above the upper limit, or a worsening trend. Ordinary variation starts nothing. A constraint shift, a closed
  verdict, a unit held for host pressure and every 10 merges start one too, with a two-hour cooldown that
  `roadmap flow request` can bypass once per window.
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

**4. Completion and chaining.** When no work remains, code settles the arc: bundle requests still unanswered are
declined and become amendments, open P2s are banked as debt and P3s are released. A close-out publication then runs
every arc lane and every `batch` lane fresh; a red one blocks it. An arc is complete when every unit is merged or
cut, every milestone's walks are done, no audit or checkpoint is owed, every obligation holds on the head and the
checkpoint has nothing left to change. A milestone that settles without passing raises a blocking item instead.
`roadmap pr` pushes the arc branch and opens its PR, stacked on the previous arc's. The architect checks in with
`roadmap brief`, a short preface and numbered questions, each with the assumption it acts on if you have no view. It
does not wait for your answers: it chains into the next arc's Phase 0 with a slice chosen from the census and any
notes left in `roadmap-inputs/_next/`, up to K arcs past your last acknowledged brief. It stops at K, when the vision
has nothing left to advance, or when you tell it to. Acknowledging a brief frees the K budget; you can recalibrate
the vision between arcs; and you merge the stacked PRs in order, first into `main`, each with a merge commit. CI
failures or review comments on a PR become fix units in the arc, never hand edits.

## Layout

```
.claude-plugin/marketplace.json     # this marketplace
plugins/roadmap-orchestrator/
  .claude-plugin/plugin.json
  executor/                         # the 1.0 executor (TypeScript on Node 24)
  skills/orchestrate/               # SKILL.md, reference.md (every command), RATIONALE-1.0.md
  skills/vision/                    # SKILL.md: distil and calibrate the arc's vision in dialogue
docs/flow.svg                       # how an arc runs: simplified overview
docs/flow-bpmn.svg                  # how an arc runs: the detailed process in BPMN
DESIGN-1.0.md                       # binding 1.0 design brief
```

## Development

From `plugins/roadmap-orchestrator/executor/`: `npm run typecheck` → `npm test` → `node evals/probe.ts` (real
CLIs) → the role evals in `evals/roles/` that the batch's changes trigger → the paid fixtures (`evals/m1/`, and
`evals/m5/`, the UI end to end, when milestones, walks, design units or the demo changed), once per merged batch.
See `CLAUDE.md`.
