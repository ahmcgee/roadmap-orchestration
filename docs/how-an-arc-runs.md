# How an arc runs: the detailed reference

The [README](../README.md#how-an-arc-runs) gives the seven stages in a few lines each. This page is the full
account of each stage and the rules that apply across them. Use it to look something up, not to read end to end.

- [Who does what](#who-does-what)
- Stages: [1 Plan](#1-plan-bootstrap-and-phase-0) · [2 Start and review](#2-start-and-review) ·
  [3 Build and certify](#3-build-and-certify) · [4 Publish](#4-publish-the-tested-head) ·
  [5 Judge](#5-judge-the-experience-and-campaign) · [6 Supervise](#6-supervise-from-the-command-center) ·
  [7 Close out](#7-close-out-and-check-in)
- Rules: [owner questions](#owner-questions) · [lanes and reuse](#lanes-and-reuse) ·
  [attempt limits](#attempt-limits-and-diagnosis) · [re-entry and lineage](#re-entry-and-lineage) ·
  [flakes, environments and residue](#flakes-environments-and-residue) ·
  [systems and memory](#systems-and-memory) · [the other skills](#the-other-skills)

Diagrams: [simplified](flow.svg) and [detailed BPMN](flow-bpmn.svg). Every command is listed in the
[operating reference](../plugins/roadmap-orchestrator/skills/orchestrate/reference.md); the binding design is
[`DESIGN-1.0.md`](../DESIGN-1.0.md).

## Who does what

| Role | Is | Does |
|---|---|---|
| **Owner** | You | Confirms the vision, resolves questions only they can answer, and sets how far the architect may chain arcs beyond the last acknowledged brief. |
| **Architect** (the "root") | The root agent in your Claude Code conversation | Authors and revises the plan, supervises the run, and brings the owner a brief. |
| **Executor** | A detached Node process | Owns every workload, resource, evidence directory and integration ref. |

## 1. Plan (bootstrap and Phase 0)

The architect curates the target corpus into stable T-n rules, compiles the confirmed vision, selects a useful
slice and writes the pack outside the product tree: plan, specs, obligations, witnesses, census and Phase-0 record.

- Every unit names systems; every spec states intent and non-goals.
- Existing behavior is must-hold. Future behavior names its delivering units.
- Milestones define usable end-to-end experiences with design references, bring-up, journeys and selected
  integration lanes.
- Approved compaction carries source-backed K-n curation. Debt resolutions link B-n and K-n in the plain C-n ledger.

Phase 0 checks typed inputs, committed target bytes, proof reachability and readiness. System overlap, possible
future-witness vacuity, spanning proof and design ordering advise judgment.

**Witness files a lane would never run.** Phase 0 and every apply refuse a witness file its lane would never run:

- one outside the lane's `testPaths`, or
- one left out of an explicit file list anywhere in its argv (past wrapper layers, a shell's `-c` script included).

A spec witness item's file is the test file its testId leads with. A lane an apply adds must declare `testPaths`.
A builder that finds a witness file its lane never runs reports it as a spec error, which parks the unit for the
root, uncharged.

## 2. Start and review

- Startup validates the pack, claims the host and smokes its routed backends.
- A fresh pack review checks the pack against the target and census and must end before admission.
- Blocking unit findings hold the named units and their transitive dependents. Other blocking targets hold the arc.
- The architect fixes the pack for a superseding review or acknowledges the item, including when it offers no options.
- The supervisor restarts crashed executors. Runners keep workloads and terminal evidence durable across recovery.
- Restarts retain the arc's recorded routing profile. A conflicting `start --profile` refuses; change profiles
  through a routing apply.

## 3. Build and certify

**Admission and pre-build.** Ready units get isolated worktrees and atomic resource/CPU reservations. A conditional
independent pre-build review annotates risky traits, non-local proof or changed meaning.

**Build.** Builders ground their specs first, implement, run targeted checks and report evidence.

**Parks during build.**

| Park | How it re-opens |
|---|---|
| Judgment park, or build `spec-wrong` park | The architect applies a spec revision and runs `resume <unit>`: pre-build on the new rev, with branch, worktree and implementer session kept. |
| Park at the chargeable bound | Re-entered with `reenters.reset`, as its item says. A revision keeps the count. |
| Other build design parks | Re-entry under a new unit id. |

**Walkthrough MCP servers.**

- Every Claude build gets the configured `walkthrough.mcp` servers.
- A declared server unavailable at init raises a non-blocking `walkthrough-mcp` notice, once per server/error
  signature. A later connected build or acting walk explicitly settles its named notices.
- Bring-ups list the unit's member/design milestones and the origin milestones of findings its spec `repairs`
  cites, once each in plan order; empty is valid.
- Without the config, builds get no servers and no new refusal. Bootstrap still refuses browser journeys without it.
- Codex builds have no MCP path. Acting judges keep their own rules.

**Certification.** The executor quiesces workloads, captures evidence, salvages changes and tears resources down
before running full lanes and witnesses. Verification checkouts keep stable paths and ignored caches between series.

**Gate.** A fresh gate judges the diff, actual reach against intent/non-goals, and evidence-backed responses to
standing findings.

- Failed checks and gate revisions feed fix rounds with original evidence and base comparisons.
- An acceptance clause that every gate round of the lineage holds unmet (a blocking `requirement-unmet` finding
  naming its id), from the second round on, goes to the architect once as a non-blocking split proposal while the
  unit goes on.

**A lanes red caused outside the tree.** A lanes red the architect traces to the estate it runs against, or to
infrastructure, is waived with:

```
roadmap rerun <unit>/lanes#<n>/<lane> --cause estate|infra --evidence "<line>"
```

- The lanes run again at the same commit in a fresh checkout, every lane on its own argv, with no build.
- The red's charge stands. The rerun charges nothing and counts as one judged stage, once per lane per head.
- Green goes on to the gate. A red rerun parks `rerun-red` for the architect, and `resume <unit>` restores the
  waived decision (a waived bound park stands).

**A spec lane red on its diff base** raises an arc notice with a known-defect apply fragment; the root names its fix
unit. That lane gets no further fix round: the gate continues, while candidate publication waits for the notice to
be resolved.

**Judgments.**

- Every judgment begins in a fresh named session. One invalid answer may be repaired in that same session, schema
  and checkout.
- Verifier directives accompany only a revise decision, including in annotation modes.
- Backend schemas use plain object roots and encode supported field constraints; property descriptions state
  remaining semantic rules.
- Walk and comparison evidence entries are exact saved file paths; explanations belong in report text.
- Free real-output replays and schema/parser parity checks guard the contract before paid probes.

## 4. Publish the tested head

An approved unit plans a candidate on the current integration tip and atomically takes the publication slot plus
the first scheduled lane's resources (spec first, otherwise the selected suite).

- A moved tip reselects the entry; unused entry resources are cleaned and released.
- Candidate lanes retain unit attribution. Only a green exact head is fast-forwarded.
- Candidate reds durably name their cause, grading records (RUN or REUSED) and original evidence. A bounded park
  retains that diagnosis.

**Candidate reds.**

| Situation | What happens |
|---|---|
| Red on the tip alone too | Parks `base-red` and holds merges. Once the estate or base is fixed, the architect acks the item and `resume <unit>` re-runs the candidate uncharged. When the red is the unit's own (its candidate run left state that broke the tip too): `steer <unit> --brief <file> --budget <min> --resume`, then ack. |
| Only red lanes are declared static checks (`kind: static`: lint, typecheck) | One uncharged fix round of its own. A second is read as any candidate red. |

**Pushes to `origin`.** Every successful integration fast-forward (unit, repair batch, docs revision or close-out)
queues a background push to `origin` with user credentials.

- Pushes use an explicit lease and require the remote tip to be an ancestor. `main` is never pushed.
- Startup retries the current head after a crash; an up-to-date remote is a no-op.
- Snapshots and retirement continue during network work, bounded by `PUSH_TIMEOUT_MS` (five minutes per attempt).
- `push-failed` and `push-diverged` are non-blocking arc notices, once per failure episode. Later
  publication/startup retries; divergence only probes until ancestry is safe (or the notice is acked by id). A later
  successful push explicitly settles the named notices.
- No `origin` records one quiet fact.
- The root no longer pushes arc branches by hand for CI. `roadmap pr` still prepares the stacked PR, and its push is
  a no-op when already current.

**Spikes.** A spike answers a declared question and retires its gated report without merging.

**Where checks run.** Cheap local checks run early; expensive local checks run on candidates, with scarce
shared/cross-system checks at batch/milestone boundaries.

## 5. Judge the experience and campaign

**Milestones.** Once a milestone's live members merge, its selected lanes run and one experience role walks its
journeys and judges polish comparisons.

- A milestone's members are its units, every unit re-entering one of them, and every unit carrying a cut one forward
  (`carries`). Superseded and cut members are withdrawn from its counts and readiness.
- A revision that leaves a milestone no live member is refused: carry the work forward with `carries`, re-point the
  milestone or remove it. One adopted that way from an earlier release is a blocking item; the executor never marks
  it reached.

**Breaks and deviations.** Breaks hold downstream work; deviations can be repaired alongside it.

- A **break** requires a failed product action, an interface repair that reworks dependents, or a measured declared
  floor violation.
- Copy, visuals, diagnostics and stale docs against a correct interface **deviate**.
- Sanctioned choices are not findings.

**Campaign audits.** Fresh whole-range campaign audits run at milestones, on request and at the final boundary,
judging invariants, vacuity, interactions and document drift together.

- Audits report findings and root requests. The architect changes the plan and alone authorizes obligation
  dispositions.
- Audit dismissal requests await the root. `dismiss F-n --counter-evidence "<line>"` records its evidence-backed
  decision, including for P1 findings.

## 6. Supervise from the command center

**Watching.** The architect watches actionable events and reads `status --summary` for progress, spend versus
expectations, milestone verdicts, caught counts and waste.

- Watch includes a fixed 30-minute heartbeat; each wake gets at most three chat lines.
- One actionable watch holds the arc's lease: start or switch versions with `watch --actionable --replace`, end with
  `watch --stop`, and confirm supervision is live in status.
- Every transition and heartbeat repeats all open blocking items in `openBlocking`; act on each item on every wake.
- Interventions and every arc-wide control go in the external operator log.
- The root never patches the plugin or run directory.

**Updating the plugin mid-arc.** Use `roadmap stop --drain [--within <min>]`, wait for the run to end, then update
and `roadmap start`.

- Drain admits no new tasks or stages. Running stages/jobs record their normal outcomes, and required
  build-to-teardown and ff-to-snapshot chains finish before cleanup and stop.
- The optional deadline escalates to abort; a later plain `stop` escalates immediately. Plain `stop` keeps its
  immediate abort behavior.
- A crash retains the drain and deadline. Status shows both.

**Changing inputs.** Export the current pack, edit it, then:

```
roadmap apply --from <dir> --rev <N> --reason "<line>"
```

- Edited files must still match their exported base. Untouched files take current bytes, and edited specs advance
  automatically.
- An apply that touches running work queues to its stage boundary. A suite-lane edit waits behind a running lanes
  attempt (a lanes red's fix round still reads the series as it ran) and is refused only while a candidate is under
  way.

**Reaching a unit.**

| To | Use |
|---|---|
| Redirect an unfinished unit | `steer`: cancels it into a directed round. |
| Inform its next build without interruption | `note`. |
| Reach a Claude build while it runs | `SendMessage` to the exact session name `status` shows (`units[].running.session`, `<arc>-<unit>-<seq>-<ordinal>`, gone once the build ends). The build reads it between tool calls and lists it in its report's `messages`. |
| Reach a Codex build, or one not yet running | `note`, then `pause` and `resume`: the resumed session reads the note. |

A successful send is not proof of delivery, a name whose build has ended fails as unreachable, and only builds in
the same container are reachable.

**Closing items.**

- Unit/host actions close their notices.
- Resolve an audit's arc requests with the apply that answers them: add `--resolves nu-ID[,nu-ID...]`.
- Unit requests require that unit's change/re-entry. Grouped findings require every named repair.
- No-op/stale applies close nothing; the receipt lists actual closures.
- Other arc items accept named `ack <id>` after review. Supplied ack choices must be offered.
- A passing later baseline settles baseline items; a superseding review settles pack-review items.
- Finding requests close when their findings settle or a root apply supplies all named repairs.
- Dismissal suppresses the same finding on unchanged code.
- External witnesses are explicit root attestations with head-bound file/URL evidence. No output matching
  substitutes for proof.

## 7. Close out and check in

Final audit, witnesses, batch lanes, document publication and snapshots settle before completion. The architect
prepares the stacked PR, presents `brief` and the demo/rough edges, then acknowledges the exact brief only after the
owner does. Another arc starts only within the chain bound and while the vision calls for work.

---

## Owner questions

The architect records owner answers with `roadmap answer P-n --text "<answer>"` and applies answers affecting this
arc immediately. Open questions retain working assumptions; chaining within the acknowledged bound need not wait for
every answer.

## Lanes and reuse

- Each lane series runs earlier reds first, then cadence order, stopping at the first red.
- Explicit `timeoutMin` yields a timeout red; without it the six-hour runner backstop applies.
- Eligible certified passes reuse only when their execution/environment identity and input hashes match.
- A lane with `testArgv` runs only the changed leaf tests inside its own cwd (a changed test elsewhere runs its
  whole argv). A red targeted run is confirmed by the lane's own argv, whose verdict counts: a runner that finds no
  test files never charges the unit.
- Exact witness ids can be checked with `witness-check --lane-file` before requesting certification.

## Attempt limits and diagnosis

| Threshold | Effect |
|---|---|
| 8 builds or 20 judged build/lanes/gate attempts (counting interrupted and uncharged work) | Diagnosis begins. It supplies a note and moves remaining mixed-profile builds to Claude. |
| 16 builds / 40 stages (fixed) | Raises an attempt-cap item for the architect. |
| Certification reds | Three uncharged reds before the fourth charges (defaults); witnesses-missing counts in that allowance. |
| Gate revisions, candidate reds | Separate bounds. |

- Spend expectations are forecasts, never caps.
- Usage limits park a backend until explicit resume.
- Non-blocking waste findings advise the architect; they do not rewrite the plan.

## Re-entry and lineage

- Re-entry keeps lineage counters. `reenters.reset` with a reason clears chargeable failures while lifetime attempts
  and other counters remain.
- The 16/40 caps count the whole lineage: `status` (`units[].lineageAttempts`), the chargeable-bound and base-red
  items, and every re-entry's apply receipt and dry run show its builds and judged stages against them.
- To continue a long lineage's work fresh, cut its head and add a unit with `carries: {unit, tip}` (a commit of the
  cut unit's branch). Status points each at the other, and the carrier counts toward the cut unit's milestones.
- A re-entry must repair the recorded cause, such as a surviving mutant or dirty lane outputs.
- Fresh build sessions with earlier lineage receive a handover of diagnosis, findings, unmet clauses, witness
  failures, decisions and original evidence.

## Flakes, environments and residue

- A same-commit red→green run is flaky. Unit-tree flakes need repair, while eligible tip flakes can be forgiven and
  mint deflake units. Stochastic k-of-n lanes follow their declared rule instead.
- Ordering parks wake when their named blockers merge.
- Managed environments start lazily, stay up while used and stop when idle. Failed up/probe parks retryably rather
  than counting as a red test.
- CPU reservations calibrate from completed runs. Judgments and one workload can progress under the host-pressure
  brake.
- Startup refuses foreign residues until cleaned or isolated, allowing proven own-arc residues to recover.
- Checkout permission residue parks only its unit. Restore ownership or remove the checkout, then
  `roadmap resume <unit>` reconciles its unfinished cleanup in-process; no executor restart is needed.

## Systems and memory

- System responsibility is not a file fence: paths beyond declared systems become gate input.
- Protected roadmap and pinned corpus paths remain guarded.
- `docs/systems/<system>.md` (configurable) is non-normative build memory, edited through ordinary gated diffs.
  Normative claims stay in the corpus.
- Commit bodies retain captured summaries and structured decisions, making later work and crash recovery
  intelligible.

## The other skills

- **`vision`** owns target dialogue and confirmation.
- **`estate-compaction`** records owner-approved reductions of rules, obligations, root ledger text and debt for the
  next Phase 0. Approved records wait outside product in `roadmap-inputs/compaction.md` and apply through normal
  validated input edits.
- PR review/CI fixes likewise become root-authored units, preserving the same gates and evidence.
