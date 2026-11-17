# How an arc runs: the detailed reference

The [README](../README.md#how-an-arc-runs) gives the eight stages in a few lines each. This page is the full
account of each stage and the rules that apply across them. Use it to look something up, not to read end to end.

- [Who does what](#who-does-what)
- Stages: [1 Plan](#1-plan-bootstrap-and-phase-0) · [2 Start and review](#2-start-and-review) ·
  [3 Build and certify](#3-build-and-certify) · [4 Publish](#4-publish-the-tested-head) ·
  [5 Judge](#5-judge-the-experience-and-campaign) · [6 Supervise](#6-supervise-from-the-command-center) ·
  [7 Endgame](#7-finish-by-hand-the-endgame) · [8 Close out](#8-close-out-and-check-in)
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
- A unit whose interrupted attempt cannot be read back at a start parks `executor-fault` with an item; the arc starts
  without it.
- Restarts retain the arc's recorded routing profile. A conflicting `start --profile` refuses; change profiles
  through a routing apply.

## 3. Build and certify

**Admission and pre-build.** Ready units get isolated worktrees and atomic resource/CPU reservations. A conditional
independent pre-build review annotates risky traits, non-local proof or changed meaning.

**Build.** Builders ground their specs first, implement, run targeted checks and report evidence.

**What a build is given beyond the spec.**

- Every required witness lane with the ids the unit must make pass on it: a build-cadence lane with its
  `roadmap witness-check` command, a later cadence with its own command line (the lanes stage runs it at the salvage
  commit), and a lane that needs an environment or reserved resources by name only (the executor's to run).
- The mutants of the vacuity findings the spec repairs: per finding, the lane, the test ids that must fail with the
  patch applied (every test the lane reports when the obligation's witness is on another lane) and the patch. The
  gate is given the same list.
- A fix round quotes each failing lane's failure line (the one its failure signature reads) and the last stderr lines
  (stdout when stderr has none), at most 20 lines and 4 KiB per lane, beside the evidence dirs. A candidate fix round
  recomputes them from the candidate's red lanes.
- A resolve round is told the merge-in: the integration tip, the branch's commit before it, the conflicted paths, and
  which of them the unit's gate approval covered, with the `git diff` that must show only integration's changes there.
  The next gate is shown every line the approved diff added on those paths that the resolved head no longer holds, as
  evidence to judge. It never blocks or charges by itself.

**A round's proof of its checks.** A fix round's required checks, and the lanes a round after a merge-in re-runs,
are proven in the final report's `checks`: one row per lane, with the commit HEAD was at and the exit code. A report
missing a row, or with a row at another commit or with another exit than the lane expects, goes back to its builder
once, uncharged, as a new invocation of the same attempt (the same continuation a resolve round that leaves clauses
unmet gets, so one continuation carries both). The next report is read as it is, since the lanes stage runs the lanes
anyway. A continue of an interrupted fix round owes the same proof, and its resumed session is given the round's
required checks again.

**After a merge-in into a kept worktree** (a resolve round, or the first build on a clean merge-in no build has built
on), the executor removes the worktree's ignored build output before the round (`bin`, `obj`, `dist`, `build`,
`target` and `__pycache__` dirs at any depth; never `node_modules` or `.venv`). The round is told what was removed and
re-runs the plan's build-cadence suite lanes, proven in `checks`. A continue never cleans, and a re-entry's fresh
worktree has nothing to clean.

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
- A judgment ends once its latest result is schema-valid and its output has stayed quiet for 30 seconds: a session
  left lingering after its verdict is ended and the verdict stands. Output still arriving (a background subagent at
  work) keeps it running, so an interim result is never taken for the verdict. Builds end on their `final: true`
  report instead.
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

**Pushes to `origin`.** Every successful integration fast-forward (unit, repair batch, docs revision, endgame landing or close-out)
asks for a background push to `origin` with user credentials. `origin`'s integration branch is the CI ref: what CI is
testing or has tested, and the PR head. It advances only once the previous pushed head has settled, so a new push
never cancels a pipeline still running on the last one.

- A pushed head settles at the first of: an external witness recorded at it (`roadmap witness`), `ci.settleMin`
  minutes after the push (plan field, default 120; 0 pushes every publication at once), or `roadmap push` (the root
  advances the CI ref now, for instance after cancelling a pipeline by hand).
- Until then the wanted head waits; a later fast-forward replaces it (one pending head). Waiting writes no fact; status
  shows `pushes` (`ciHead`, `pending`, `settleBy`). A head still waiting when the executor exits is pushed by the
  next startup, and at the arc's end by `roadmap pr`.
- Pushes use an explicit lease and require the remote tip to be an ancestor. `main` is never pushed.
- Startup recomputes the settle rule from the log and retries the current head after a crash; an up-to-date remote
  is a no-op.
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

**Campaign audits.** Fresh campaign audits run at milestones, on request and at the final boundary, judging
invariants, vacuity, interactions and document drift together.

- Each audit reads only what no completed audit covered under the vision in force: from its coverage watermark to the
  integration head, so each published commit is read once. The lens works in a checkout of the head and reads earlier
  code there for context. The whole range from the arc's base is read by the first audit, after a vision change, and
  on `roadmap audit --whole`. An audit with nothing new to read asks no lens.
- An audit abandoned by a failure is retried after six hours, or at once for a new request. One abandoned because its
  backend parked (a usage limit) is due again as soon as `roadmap resume --backend` clears the park.
- Each root request an audit raises is one blocking `owner-request` item. A later audit asking the same thing (the
  same finding to dismiss, or the same summary) raises nothing new, whether the first item is open or answered. A
  final audit raises no request about a finding below the endgame's required line (not P1, over no obligation): the
  close-out settles those.

- Audits report findings and root requests. The architect changes the plan and alone authorizes obligation
  dispositions.
- Audit dismissal requests await the root. `dismiss F-n --counter-evidence "<line>"` records its evidence-backed
  decision, including for P1 findings.

**Repairers of one finding.** The scheduler holds each approved direct repairer of a finding at its candidate until
all of them wait there, so they publish as one batch. Two direct repairers joined through `after` (directly or through
units still open) could never meet there: the dependency waits for the dependent, and the dependent waits for its
merge. The classifier refuses such a revision (`co-repairer-after`, naming the finding and the path). A plan adopted
from an earlier release that holds such a pair raises one blocking `plan-defect` item.

## 6. Supervise from the command center

**Watching.** The architect watches actionable events and reads `status --summary` for progress, spend versus
expectations, milestone verdicts, caught counts and waste.

- Watch includes a fixed 30-minute heartbeat; each wake gets at most three chat lines.
- One actionable watch holds the arc's lease: start or switch versions with `watch --actionable --replace`, end with
  `watch --stop`, and confirm supervision is live in status.
- Every transition and heartbeat repeats all open blocking items in `openBlocking`; act on each item on every wake.
- Interventions and every arc-wide control go in the external operator log.
- Once the body ends, the architect works the findings through the `roadmap endgame` commands
  ([section 7](#7-finish-by-hand-the-endgame)).
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
- The drain follows the change. Plan-wide edits (routing, limits, resources, the suite, the holistic layer) drain the
  arc, but three drain nothing because they are read from the plan in force at each use:
  - an obligation edit that changes only `deliveredBy`;
  - a `ci` edit (`ci.settleMin`, read at each CI ref decision);
  - a `capacity` edit. An increase grants at once. After a decrease, units already holding tokens above the new size
    keep them until they finish, and nothing new is granted until the tokens held fall below the new size. This
    covers both `capacity.cpu` and `capacity.fastSuites`, the cap on lanes-stage suite lanes running at once. Without
    `fastSuites` the cap is one per 12 GiB of host memory, at least one, and the executor logs the derived value at
    startup.
- `roadmap withdraw <command-id>` takes back a pending mutation, such as a queued apply, before it starts applying.
  The mutation is rejected `withdrawn by <id>`, its drain is released at once, and no dropped-apply item is raised.
  A control command, a command that is already terminal, and one whose apply has begun cannot be withdrawn.

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
- External witnesses are explicit root attestations with commit-bound file/URL evidence. No output matching
  substitutes for proof. `roadmap witness <I-n> --result pass|fail --evidence <file|url> [--at <sha>]` attests the
  commit CI tested: `--at`, by default the CI ref (the last pushed head). Any commit the integration branch contains
  is accepted, and the verdict binds to that commit's lane inputs, so it holds on later heads whose declared `inputs`
  or `systems` match. A pass latches a future obligation once every deliverer's published merge is in that commit. A
  fail reopens each delivering unit (its lineage head) with a brief listing the publications between the
  obligation's last pass (or the arc start) and the attested commit: the suspects.

## 7. Finish by hand: the endgame

The body of an arc ends when every planned unit is retired, cut or superseded and every milestone has had its
checkpoint. What remains then was raised by findings: repairs, polish, deflakes, obligations not held. Sending each of
those through a unit of its own (build, lanes, gate, candidate) costs more than most of the fixes. So in the endgame
the executor raises no new unit. The architect finishes the findings by hand on one endgame branch, and the executor
tests and lands it.

**When an arc is in the endgame.** A unit is finding-raised when it was added after the arc's first plan revision and
either its origin is not `planned` (repair, polish, deflake) or its spec repairs something. A unit the arc started
with is planned work whatever it repairs. A milestone has had its checkpoint when a walk of it ended as a round
(`reported` or `bring-up-failed`) or it was abandoned, and the audit it triggered completed.

- The phase is computed each tick from the plan in force and the log, never stored. A revision that adds a planned
  unit returns the arc to the body, and the episode is left with cause `planned-unit`. The next entry is a new episode.
- The classifier refuses an `origin` edit of a unit already planned, because origin decides the phase.
- Only a holistic arc has an endgame. Without the holistic layer there are no findings and the phase stays the body.
- Unit id `endgame` is reserved.

**Settling.** The first step is automatic.

- No deflake unit is minted and no polish unit is admitted. A refused polish proposal becomes an optional worklist
  entry.
- A finding-raised unit that was in the plan when the episode entered and has not been dispatched is held at
  admission (`admission-hold:endgame`). `roadmap resume <unit>` releases it to run as a unit, which is how the
  architect hands a large repair back to the executor.
- Dispatched units finish normally, and parked units stay parked. A unit admitted during the episode, by the
  architect's apply or a checkpoint's, runs.
- Once no unit runs, outstanding walks run, then the final audit. In the endgame the final audit does not wait for
  active P1s to clear, because they are worklist entries now. This settling audit completes the worklist.
- While the episode is open, landings and repair merges arm no audit: the final audit runs again at closing, or when
  the root asks with `roadmap audit`. Completion then lists `audit-at-closing` instead of outstanding coverage, and the
  exit checklist's audit line says it runs once the worklist is empty and the branch landed. A typical endgame audits
  twice: once while settling and once at closing, plus once per further closing a P1 sends back to open.

**The worklist** is derived from the log and the plan, never stored.

- Required: active P1 findings, active findings over an obligation, non-exempt obligations observed not held on the
  integration head, and finding-raised units not yet retired, cut or superseded.
- Optional: every other active finding (the close-out settlement banks or releases them) and the polish proposals
  refused since the episode entered.

**Open.** Once the episode has settled (nothing running, no walk or audit due) with a non-empty required worklist,
the executor creates branch `roadmap/<arc>/endgame` and worktree `<worktreeRoot>/<arc>/endgame` at the integration
tip. It writes the handover `<runDir>/endgame/handover-<episode>.md` and raises one non-blocking `endgame` item with
the handover as its evidence. An earlier episode's branch and worktree are kept. With an empty required worklist the
episode opens only when an earlier episode, reversed by a planned unit, landed commits no review covered: it raises no
item and goes straight to closing, which runs that review. Otherwise it never opens, and the arc closes out as it
always did.

- The handover lists the branch, its base and worktree; each worklist entry with its evidence paths; each remaining
  unit's spec path and rev, branch tip, dirty paths and last decided outcome; the audited range; and the environments
  up.
- Past 10 required entries, the item's recommendation names the remaining units and suggests taking the largest back
  into the executor with `resume <unit>` or a repair unit by apply. It is advice; nothing enforces it.

**Commands.** Every endgame command is rejected while no episode is open.

| Command | Does |
|---|---|
| `roadmap endgame fix --closes <ids> [--commit <sha>] --note "<line>"` | Records one fix: the findings (`F-n`), obligations (`I-n`) and units it closes. The commit defaults to the endgame branch's head and must be on that branch after the episode's base. A named finding reads `fixed-on-branch` until a landing holds the commit, then resolves. A named unit is cut (`closed by endgame fix <command>`); a unit that may not be cut rejects the whole command. |
| `roadmap endgame land` | Asks for a landing of the endgame branch's head. |
| `roadmap endgame run <lane>[,<lane>...]` | Runs suite or arc lanes at the endgame branch's head. A later landing of that head reuses what they observed. |
| `roadmap endgame checkpoint <milestone>` | Makes one more walk round of an already walked milestone due at the integration head, whatever `walkRounds` allows. |
| `roadmap endgame review` | Asks for the review of the episode's range now. |
| `roadmap resume <unit>` | Releases a unit the endgame holds at admission. |
| `roadmap audit [--whole]` | A campaign audit now, as in the body; the only way to audit while the step is open. |

`land`, `run` and `review` are requests. The scheduler serves them in log order as jobs `endgame-<n>`, one at a time,
and a job a restart cut short resumes as itself. A checkpoint is not a job: it only makes a walk round due.

**Landing.** The architect commits on the endgame branch, never on the integration branch. The executor owns the
integration ref and stops the arc on any move it did not make, and audit coverage counts only its own publications.

- The endgame head must strictly descend from the integration head, checked before and after the slot wait. If units
  published meanwhile, merge the integration branch into the endgame branch first.
- The candidate is the head itself, with no merge. It runs the suite lanes its diff on the tip selects and the arc
  lanes of every active non-exempt obligation (never a deferred lane), graded as a batch with the episode's fixes as
  its repairs. When that is not clean, the tip alone runs for comparison.
- Green fast-forwards and pushes like any publication. Red moves nothing: the job's end names the red lanes and
  obligations and whether the tip alone is red too.
- A landing with nothing to land, or whose tip moved, is refused. A foreign move of the integration ref also raises a
  blocking `foreign-ref-move` item.

**Review.** No gate saw the hand-made work, so it gets one independent review: a fresh verifier session at its high
seat, never the architect's session. It reads a range ending at the integration head and starting at the episode's
base, or at the earliest landing no review covered when an earlier, reversed episode left one, so every landed endgame
commit gets a review. It also reads the recorded fixes and the publications in the range (unit and batch publications marked already gated). Its findings open with
lens `endgame-review`. The closing step runs it by itself. No review is owed when the endgame branch has no commits of
its own. While the verifier's backend is parked none starts, and a review with no verdict takes the retryable-park
backoff.

**Closing and the exit.** The step is closing once the required worklist is empty and the endgame branch is landed
(its tip is an ancestor of the integration head). The arc leaves the endgame complete when all of these hold:

- the required worklist is empty;
- the endgame branch is landed;
- a review covers the range up to a head holding the endgame tip;
- the final audit covers the integration head (it runs at closing over what the landings added since its watermark);
- the obligations hold at the final tip, with the batch witness run for every batch arc lane whose obligation is
  unobserved on the head's tree.

A P1 the review or the final audit opens is a required entry, so the step returns to open. Only P1s do that; P2 and
P3 findings go to the close-out settlement. There is no round limit: the loop ends when a review and an audit find no
P1. Until then completion reports `endgame-open`. Then the existing settlement and close-out run, and the episode is
left `complete` after `arc-completed`.

## 8. Close out and check in

Close-out follows the endgame, or the body directly when no episode opened. Final audit, witnesses, batch lanes,
document publication and snapshots settle before completion.

A revision publishes rendered documents only where they differ from the integration tip, and never `constraints.md`
alone: a ruling-only revision takes effect at once through the ledger in force but makes no docs commit (each one
would be a CI-ref push). Its `constraints.md` rendering lands with the next publication that changes another
document, or with the close-out, which re-renders every document against the tip. The architect
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
- The lanes stage's witness check reuses a certified observation only when it holds every test id the unit requires
  on that lane: obligation targets, repairs, its spec's witness items and the must-holds it keeps. One that lacks any
  of them runs the lane again, so a lane whose `inputs` leave out a new test file never charges a missing witness.
- A red lanes-stage suite lane runs again on the unit's diff base alone. That base verdict is kept for the run, so
  units red on the same lanes over the same base share it. A kept base red stands for every unit. A kept base pass is
  never trusted against a confirmed red, meaning one whose diagnostic rerun was red too or that repeats the unit's
  earlier red. For a confirmed red the base runs again with nothing reused and no test-only run, and a lane that flakes
  on the base counts as failed there. Its `lane-base-compared` fact says `fresh`.

**Arc lanes at batch cadence.** An arc lane that is slow or runs against a shared estate can take cadence `batch`.
Like an external lane it is deferred: it leaves a unit's required witnesses and the candidate's and a docs
publication's brakes, so a unit delivering its obligation merges without running it. The baseline, cadence audits and
the close-out still run it.

- The batch witness, a job `witness-<n>`, runs it on the integration head once `holistic.batchEvery` publications
  (default 5) have landed since it last ran, and at the endgame's closing step for every batch arc lane whose
  obligation is unobserved on the head's tree. A job cut short resumes as itself.
- Green records the observation and latches a future obligation whose deliverers have all merged into that head.
- Red bisects over the published heads since the lane last ran, each probe the lane alone in its own checkout. When
  the culprit publication belongs to a retired deliverer's lineage, that unit reopens with the range as its brief.
  Otherwise code opens a P1 over the obligation naming the culprit. Nothing is charged either way.
- Phase 0 advises `consider-batch` for a candidate-cadence arc lane that names resources.

## Attempt limits and diagnosis

| Threshold | Effect |
|---|---|
| 8 builds or 20 judged build/lanes/gate attempts, counting interrupted and uncharged work (diagnosis source `attempts:8-builds-or-20-judged`) | A diagnosis before the next build. It supplies a note and moves remaining mixed-profile builds to Claude. |
| A lanes red that repeats the unit's earlier confirmed red of the same lane with the same failure signature (source `repeat-red:<lane>:<failure>`) | A diagnosis before the fix build. It supplies a note and moves no build. |
| A diagnosis whose cause is `base` or `environment` | Parks the unit `diagnosed-external`: uncharged, an operator environment park with a blocking item. |
| A build round ended by its window deadline, not ruled starved by host pressure | Outcome `window-spent`, uncharged. The round's work is salvaged, verified and gated like a report. |
| 16 builds / 40 stages (fixed) | Raises an attempt-cap item for the architect. |
| Certification reds | Three uncharged reds before the fourth charges (defaults); witnesses-missing counts in that allowance. |
| Gate revisions, candidate reds | Separate bounds. |
| Gate revisions at the escalation seat | Once the revise rounds are spent, a revise routes the gate up to the escalation seat. A revise there with a blocking finding no builder was given (a new finding, or one the route-up round raised) gets one uncharged fix round; a second one, or one that only raises findings a builder already had, parks the unit. |
| `flaky`, `deflake-held`, `environment-divergence`, `known-defect`, `base-red` lanes outcomes | Uncharged, outside the certification allowance. |

**Diagnosis.** Each source diagnoses a unit once. The diagnosis is a step of its own just before the build that finds
it due, a steer round included. It is given the failing lanes' quoted lines, the base comparison, the environment's
state (tripped breakers, retryable parks, suspected hosts), the plan's known defects and the lane's flaky keys, and it
answers a cause with evidence and a brief.

- A `unit` or `unknown` cause lets the build follow, with the brief as its note. Only the attempts source moves builds
  to the Claude fallback, so an early diagnosis on a repeated red changes no routing.
- A `base` or `environment` cause parks the unit `diagnosed-external`, since another fix round would only repeat the
  red. The item carries the cause, its evidence and the brief. Once the base or estate is fixed, `roadmap resume
  <unit>` restores the lanes decision, and the fix round runs with the brief as its note. The source is spent, so it
  is not diagnosed again. `rerun` does not apply after this park. Under a steer entry the build runs instead of
  parking.
- `window-spent` applies to every round kind (fresh, fix, resume, resolve, steer), so a steer round whose budget runs
  out keeps its uncommitted work and its brief instead of parking as a backend fault.

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
- Delivery follows lineage. An obligation whose `deliveredBy` names a re-entered unit is delivered by the unit that
  re-enters it, so `deliveredBy` never needs editing after a re-entry. The re-entry is required to make its witnesses
  pass, may name the obligation in a witness item, and latches it on publication; the latch names the re-entry.
- A unit that repairs an obligation other units deliver, once all of them are merged, cannot make its mutation smoke
  kill that witness, because reverting the unit leaves their work in place. The apply flags such a repair as an
  advisory. If every surviving witness is a repair of this kind, the lanes stage parks the unit as an uncharged
  `plan-defect`: drop the repair from the spec, or cut the unit.

## Flakes, environments and residue

- A same-commit red→green run is flaky. Unit-tree flakes need repair, while eligible tip flakes can be forgiven and
  mint deflake units (in the body only: the endgame mints none). Stochastic k-of-n lanes follow their declared rule instead.
- An open deflake unit shields the lane it owns. A unit not yet started that runs the lane waits at its first
  admission. A unit already running whose lanes stage is red on that lane records `deflake-held`, is not charged, and
  waits at `prepare` until the deflake merges, parks or is cut. Prepare then merges the integration tip in and the
  lanes run again. If the lane is still red, the unit is charged as usual. A unit of the deflake's own lineage is
  never shielded.
- When every red lane passed in the builder's own reported check at the same head, the lanes record
  `environment-divergence`: the lanes' clean checkout and the builder's worktree differ. The unit gets an uncharged
  fix round told to reproduce the red in a fresh checkout of that head.
- A lane does not start while the environment or resource it names is unhealthy, meaning it has a tripped breaker or
  a retryable park on it whose probe has not passed. The lane waits and holds nothing until the probe clears it. It
  does not come up against the broken target and park a second unit.
- A lane can hold a pool whole with `exclusive: [<pool>]`, naming a declared pool among its own resources. Lanes
  that only read the pool take one instance each, so the pool's size caps them. A lane that mutates it takes every
  instance, so it waits for every reader and every other mutator and then runs alone on the pool. A lower-ranked reader
  never overtakes a waiting mutator. Probes and teardowns run for each instance held. Phase 0 advises
  `shared-estate-mutation` when the lanes of two or more live units name a pool, one of them on a system with the
  `persistent` trait, and none holds it whole.
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
