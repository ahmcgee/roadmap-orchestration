# roadmap-orchestrator 1.0 — design brief (draft for audit)

Status: draft 10, 2026-10-06. Distilled from 0.20.0 (tag `v0.20.0`: its RATIONALE §1–25, DESIGN.md, PROMPT.md and the Codex-native sibling skill,
all since removed from the tree), `orchestrator-observations.md`, and arc 1's full `.roadmap/` record (`calibration-0.20.0.md` §3.1–3.23,
`skill-feedback-0.16.0.md`, the wave 33–38 audits, the architect log, the hand-written boundary patches);
citations will be folded into RATIONALE 1.0. Draft 3 incorporated the adjudicated cross-model review (gpt-6-astra,
29 findings, all accepted, 11 narrowed) and two owner rulings: no spend cap (review item 6 withdrawn), and the
holistic layer (§2.8).
Draft 4 incorporates the adjudicated second cross-model pass (gpt-6-astra, 28 findings, all accepted) and the
owner's prompt–model coupling, clean-PR and routing-profile rulings.
Draft 5 applies the M1 planning amendments (lock by link, exit.json, evidence out of the ref, growth controls, inbound-only issues, debt lifecycle).
Draft 6 applies the M1 plan amendments (adjudication of the M1 plan review, 2026-09-25): host lock by `link()` with
the owner published by handshake; `exit.json` after workload quiescence, then a pure adapter; raw evidence out of
`refs/roadmap/<arc>`, which carries allowlisted files and a sha256 manifest; `typescript` and `@types/node` as the only
devDependencies; Claude `effort: 'default'` and pinned model ids; actors are roles, never models (owner ruling);
residues keyed per resource; workload membership by `ROADMAP_INV` with the runner excluded; cgroup mode
experimental; Codex judgment triples unsupported; op kinds `mergein.prepare` and `evidence.snapshot` and the
candidate ref. Residue compaction, `gc`, ruling retirement, obligation re-derivation and dismissal lifetime are
recorded for M3; the debt lifecycle and inbound-only issues for M4.
Draft 7 applies the M2 plan amendments (2026-09-30): merged-only dependencies, a legacy serial frontier for
dev.4 arcs, pools of instances with `@cpu`, a durable publication holder, admission-defined safe points,
retryable parks classed by `(stage, outcome)` with probe-derived recovery, `reenter` and `cut` as `apply` edit
classes, and N = 1 fix-round escalation; `steer`, `route`, `limits`, `merge-in` and the `repair` origin move to M3.
Draft 8 applies the M3 plan amendments (2026-09-30): the vision as the root record, which the checkpoint
reconciles against silently and consults on afterwards (owner ruling OR-V, superseding "weakening → needs-user");
the holistic layer on only when the plan names a vision; `route`, `limits`, obligation and vision edits as `apply`
edit classes; the ledger executor-owned after `start`, with `rule` its only writer; one payload-first activation
record per revision under a revision fence; a fourth lens, `vision`, and a required lens set; divergences with
preimages, digests and `reverse <D-n>`; owner-only acts as `request`s; docs publications that preempt; close-out,
active and sealed completion; residue compaction and `gc`; `explore`, `--adversarial`, `contractRequests` and
`owedAfterMerge` withdrawn or deferred. An M3 amendment (2026-10-01) adds `world` clauses, vision open questions,
the plan's `advances` slice and the coverage split (§2.8).
Draft 9 applies the M4a plan amendments (2026-10-03): M4 splits into M4a (the corpus as the target, the vision's
corpus home with verified playback, `phase0 check`, the debt lifecycle, the forge module, `roadmap brief`,
chaining, routing rebinding, skill text, acceptance, and deletion of every pre-dev.6 scaffolding layer) and M4b
(the flow loop); a pinned corpus with `T-n` rules replaces the architecture doc for holistic arcs, with a census
per rule; the vision lives in the corpus and its confirmation is verified; corpus amendments and curation tiers;
issues trusted by forge policy; pack review as an executor job; the frontier and summit classes rebound, retroactively
(§4); chained arcs on stacked branches (§2.11); preview deferred to 1.1; `contractRequests` and `owedAfterMerge`
withdrawn.
Draft 10 applies the M4a plan's revision 3.1 (the run-10 batch, 2026-10-06; amendments A-M4-20 to A-M4-28): code
classifies checkpoint admits against the owner-selected slice (OR-A1, one opportunity per arc with one follow-up,
LR-k); checkpoint evidence is compared per test and a bundle touching a running attempt waits for its boundary;
witness presence and mutation smoke run before the gate in corpus arcs; plan-check takes its shape from the builder's
class; lanes are reused under a recorded identity and certificate, reds rerun only when they may be flaky, known
defects hold their units uncharged, and units take a priority; `resume-arc`, `witness-check`, `inputs export` and
`apply --ruling`; the root agent's supervision and operator log; change-sensitive drift, an immutable checkpoint
manifest, closeout deltas and issue reuse; a Phase-0 spec-census cross-check and delta pack re-review. The new checks
and the admit classes apply to corpus arcs only (LR-h).

## 1. What the system is for

> I produce very detailed target states of systems. They are very long horizon and roadmap-orchestrator will
> often work for a week or more without me needing to check in. I use it to converge incrementally towards
> detailed documented target states.

Every decision below is graded on two questions: does it keep a run going **unattended for a week**, and does
it keep the product **converging on the documented target state**? Per-unit speed is secondary; it matters
only because wall-clock was arc 1's binding constraint (Obs §6).

## 2. The shape of 1.0

One skill, one driver, three parts.

**The executor** — a plain Node process (TypeScript, D1), Linux only, launched detached by `roadmap start`
under a supervisor. Scope: **one executor per single-UID host** (a stated prerequisite). Host state
lives at `/var/tmp/roadmap/`: `host.lock`, claimed by `link()` from a written temp file (never an ownerless lock);
`host.owner.json` beside it (the claim's nonce and
generation, executor pid, start time from `/proc/<pid>/stat`, boot id, run dir), published by handshake: the
supervisor claims the lock, spawns the executor, writes `host.owner.json` atomically, then writes a handshake file
for that generation; the executor blocks on the handshake, re-reads the owner record, verifies that nonce,
generation, pid and start time are its own, and only then performs any effect. The residual-resource index
(§2.2) sits beside them. The run dir is
`$(git rev-parse --git-common-dir)/roadmap-runtime/<arc>/`. Dead-owner takeover first claims
`host.recovery.lock` the same way, verifies the supervisor and executor dead by boot id, pid and start time, then
replaces lock and metadata; missing or mismatched owner metadata refuses with a `needs-user`. No recovery side
effect precedes the recovery lock, and one whose holder is dead → `needs-user`. The executor
owns every subprocess, deadline, resource lock and evidence directory, writes a heartbeat, and records every
side effect write-ahead (§4 State). Nothing code can do exactly is done by a model.

**The supervisor** owns the executor and nothing else: on executor death it takes over exclusively and
restarts it with bounded backoff; after 3 crashes in an hour it persists a `needs-user` and stops. It is not a
judgment surface. A respawn of an established arc never refuses on a failed backend smoke: each failed
backend gets a retryable `backend-park{outage}` and the rest of the arc runs; a first `roadmap start` still refuses. Host-reboot recovery is outside the unattended guarantee; `roadmap start` recovers from disk.

**Backends** — `codex exec` and `claude -p` behind one process interface: prompt on stdin, explicit launch
environment (declared vars, umask 022, cwd — sf18's umask-077 incident), JSON events on stdout. Each invocation
runs under a small **runner** that owns the child, writes stdout/stderr to files in its evidence dir (never pipes)
and hosts the adapter, so the executor can die and reattach. The adapter, never the model, validates the
native terminal result (`codex -o`; the `result` event of `claude -p --output-format stream-json`, whose
tool calls also give the session's reads, `reads.json`). The runner waits for the workload to be
empty (killing at the deadline), writes `exit.json`, and only then runs the adapter, which is pure over files and
so re-runnable, and atomically writes an invocation-bound `result.json`: `outcome: success | refusal | malformed | process-fault | cancelled` (a pause or stop) and, separately, `usage: known |
unavailable{reason}`; missing usage never invalidates a judgment or triggers a rerun. The adapter never runs
before quiescence, for backends, lanes, probes and teardown alike: containment empty is the precondition for
reading terminal files, releasing resources or advancing a stage. Every role resolves to a
supported `{backend, model, effort}` triple through layered routing profiles (§4). Verified 2026-09-25: `claude
-p` with the user's login is subscription-billed (API billing paused 2026-06-15, notice promised). The arc-start
preflight smokes every backend the resolved routing uses — auth, sandbox, a real shell command graded on exit code
*and* output, both Claude profiles and Codex fresh/resume with real schemas — checks for a delegated cgroup v2
subtree (recorded as a fact; cgroup mode stays experimental, §4), and doubles as the health probe for retryable parks.

**The architect** — you, in an interactive Claude Code session; Phase 0 remains the highest-leverage act. After
launch the session is the only inquiry and command surface: `status` (§2.4), the code-rendered architect log, and
a Monitor on the run dir, pid and heartbeat that wakes the session on a new `needs-user` or executor death.
`needs-user` items persist until acknowledged with a receipt; a replacement session finds the run via the host
metadata and rebuilds outstanding questions from disk. There is no second chat surface.
At a check-in the architect reads **`roadmap brief`**: everything since the last ack, across every chained arc
(§2.11), as one canonical payload hashed whole into a `briefId`, with the Markdown rendered from the payload
alone. "Since" is the last committed ack's coverage vector `[{arc, snapshotCommit, highWater}]`; nothing else
defines a delta. It renders divergences and digests, `decisionsSince`, the curation digest and corpus
divergences, debt banked and dispositioned, issue intake, ranked questions with working assumptions, amendments,
chain state, census `% held` and `status.timings` deltas. The architect adds a preface of at most 10 lines in
conversation, never in a file. `brief --ack <briefId>` refuses a stale id, writes a pending marker with the
coverage vector and the rendered non-blocking `divergence-digest` and `convergence-bound` items (blocking items
are never acked by a brief), enqueues one `ack` per item under deterministic command ids, then commits the marker
by rename; a crash between is finished from the marker alone by the next `brief`, `brief --ack` or `start`.

### 2.1 Pipeline per unit (risk-tiered)

Seats below are the `default` profile's (§4); state records the role and `routingRev`, never the model.

```
plan (sol) → plan-check (opus medium; opus xhigh on escalation) → build (luna low/med · opus 5.5 high risk)
  → session-empty → evidence snapshot → classified salvage → teardown → clean worktree at salvage SHA
  → lanes (executor, serial, locked, fast then estate) → [review digest (sol, med/high only)]
  → gate (opus medium · opus xhigh on escalation or triggered)
  → integration slot: candidate (--no-ff) → transient check → suite + journey lanes → ff-only
    → published | abandoned | recovery-required → checkpoint cadence (§2.5)
```

Later stages bind to the salvage SHA; every judgment stage runs in a fresh session (§4). Fix rounds resume the
build session with the failing lanes' evidence dirs. Per-unit counters are cumulative and `monotonic()`:
`attempts` counts every start; `chargeableFailures` counts design-class failures only and bounds the unit.

**Executable checks before the gate (A-M4-22; corpus arcs, LR-h; LR-j: nothing is judged by reading a test).**
After a green spec series that wrote its clean certificate, the lanes stage computes the unit's required witnesses
(the witnesses of the obligations it completes or repairs and its spec's witness items as targets, its declared
must-holds as preservation) and runs each required arc lane once at the salvage SHA in its own checkout, reusing only
observations of a certified series. A required id absent, zero-selected, skipped, malformed or failing is
`witnesses-missing`: a charged fix round listing them, no gate call. Then mutation smoke, for a `med` or `high` unit
whose targets' lanes declare `testPaths` and whose diff touches production paths: the production diff reverted in a
detached worktree (a mutant that never certifies), the targets run, each killed, survived or inconclusive (a binary or
renamed path, or a patch that does not apply, is inconclusive). A survivor is one bounded fix round (`smokeRounds`,
default 1), then the gate decides with the survivors in its `checks`; one execution per (production diff, witness
definitions, environment) is reused, at most `smokeRuns` (default 2) per unit. The implementer runs the same comparator:
its prompt names one `roadmap witness-check --lane-file <f>` command per fast required lane, which runs the lane with
fresh reporter output. A date- or time-zone-dependent unit's spec pins the product's own clock seam (guidance, R39).

**Plan-check shape (A-M4-23).** `planCheck.shape: uniform | by-builder` (absent: `uniform`; a non-holistic arc is always
`uniform`). Under `by-builder` a frontier or summit builder makes no plan-check call (`in-session`): its fresh build
round first assesses in the same session, read-only, answering plan-check's slice `planAssessment {feasible, riskFloor,
visionConflict[], premises, notes}`; a vision conflict opens a P3 finding, an understated floor is malformed, a raised
one re-seats the build (`risk-raised`) or rises in place, and `feasible: false` parks the unit for a spec revision
(`infeasible`); the implementing invocation resumes that session. An efficient builder's plan-check runs the acceptance
shape: its redirect may only add or replace witness items and facts, and cite; witness items enter the spec only
through that patch channel, as the next free `W-n`.

### 2.2 Scheduling

A DAG with resource locks replaces waves. A unit starts when every dependency is merged, its contingent edges are
`resolved{evidence, by}` (only `resolve-edge` resolves), and its stage's resource set is acquirable.
Dependencies are merged-only: dependents of a dead unit are released only by `cut` or by re-entry, whose lineage
head stands in once its preparation succeeds (owner ruling 2026-09-30). Resources are
**named** (clusters, ports, containers, images, volumes, per-worktree state dirs, tool locks, the integration
slot) or **pools** of instances (sf18, §3.3). The built-in pool `@cpu` (`@` never occurs in a declared name) has
`plan.capacity.cpu` instances, default `availableParallelism()`; a declared estate pool `{name, pool:{size}, probe,
teardown}` has instances `<name>#<n>`, bound into every workload of the holder by `RESOURCE_INSTANCE_<NAME>=<n>`
(persisted in `launch.json` and the residue's teardown recipe). `@cpu` costs, all unmeasured: judgment 1, build
`unit.cpu ?? 4`, fast lane 2, estate and suite lanes 4, probe and teardown 0.
Checkpoint-originated units outrank planned units, with aging: a unit that waits while M other units publish
(default 3) is promoted, and promoted units are served oldest first. Repair units (`origin: repair`, §2.8) rank
first: `ORIGIN_RANK = {repair 0, checkpoint 1, planned 2}` (R6). Resources are declared
with teardown, ownership labels and pools, replacing the concurrency knobs, load guard, `laneCleanup`
and census.

- **One scheduler.** One plan schema with additive optional fields and one scheduler; every arc has the semantics
  above. dev.4's serial frontier for legacy arcs (lead ruling 2026-09-30) was upgrade scaffolding, deleted in
  M4a step X0 with every other pre-dev.6 layer (§10).
- **Admission.** The scheduler is the only admitter of stages. Admission boundaries sit before `prepare`,
  `plan-check`, `build`, `lanes`, `gate` and `candidate`; pause, drain and every constraint are re-checked at
  each. Constraints hold per stage: a limited or parked backend blocks the stages that call it (running calls
  finish), a tripped `host` target blocks builds and lanes, `base-red` blocks candidates, and
  `recovery-required`, `log-corrupt`, host-subject and supervisor crash-limit items block all admission. Chains
  (`quiesce → evidence → salvage → teardown` after a build; `ff → snapshot` in a publication) run to completion
  regardless of pause or drain, so a paused unit holds nothing but a residue of its own failed cleanup. On
  restart, recovery rebuilds pending chains from the fold and the scheduler runs them first.
- **Locks.** The reservation unit is a build, a judgment call, a lane or a publication, each taking its whole
  set all-or-none in one global order (named and pool instances ascending, `@cpu#*`, then the integration slot).
  A stage takes its entry reservation before its first journaled op; a wait cancelled by pause or stop journals
  nothing. Hold-and-wait occurs only for a publication holder waiting on a suite lane's set. Waiters on a
  `cleanup-failed` or residue-dirty resource are set aside and never block backfill. A reservation covers probe →
  cleanup → run → cleanup; states `free | reserved | running | cleaning | cleanup-failed`; release only after
  confirmed cleanup. Requests over total capacity are refused at plan load and at `apply` (new pools included).
  Preview's own estate slot is specified with preview in 1.1. Docker/kind resources carry
  `roadmap.owner=<arc>/<unit>/<invocation>`.
- **Residues.** `cleanup-failed` also enters the host residual-resource index, independent of the owner
  pointer, keyed per resource `(arc, unit, inv, resource)`, with its teardown recipe. The residue is durable in
the host index before the local `cleanup-failed` is recorded and before any release; a multi-resource cleanup
that fails partway leaves one residue per failed resource. `start` for any arc refuses until every
  residue is `cleaned` (by `sweep`) or `isolated | transferred` (by a `needs-user` disposition); an
  acknowledgement alone frees nothing. Own-arc residues are the exception: a start or respawn is not refused
  when the arc's log proves ownership (a `resource.transition{fail}` intent, open or done, naming the key), and
  the owned dirty instances are withheld from dispatch until a retry reclaims them (reclaim → teardown →
  `cleaned` disposition → release).
- **Integration slot.** Serial; all else runs in parallel. Each attempt ends `published | abandoned |
  recovery-required`. A publication needing the slot abandons the current candidate (cleaned, released) first,
  waiting only for a critical section under way. A unit's publication is a durable holder
  `publication{unit, attempt}`: it takes the slot at candidate start and keeps it through `ff` and `snapshot`,
  releasing it on any candidate outcome but green, on `ff` `cas-stale | fingerprint-invalid | foreign-move`, and
  after `snapshot`. Before green, pause and stop abandon the candidate; once green, `ff` and `snapshot` are a
  mandatory chain. The other holders are a docs publication `docs{pub}` (§2.6) and a repair batch `batch{finding,
  attempt}` (§2.8). Docs publications outrank unit publications and preempt a candidate before green: cancel
  reason `preempt`, outcome `preempted`, uncharged (A7). Under the slot, and again in recovery's `ff` redo, a P1
  that now blocks a selected obligation abandons the candidate: `finding-blocked`, uncharged, held (G10). A red
  or conflicting candidate releases its suite resources
  before the unit fix is dispatched, then reacquires. `recovery-required` resolves from the operation's
  postcondition.
- **Parks.** Classed by `(stage, outcome)`; the class and its targets are written inside the `stage-outcome`
  fact that parks. `retryable` (backend `process-fault`, `capacity` or `outage`; a lane or candidate `blocked`;
  `cleanup-failed`; salvage `commit-failed`) names probe targets `backend{b} | host | resource{instance}`, one
  per failed instance; when salvage fails, the teardown's failed instances join its targets. Probes run at once,
  then with exponential backoff (cap 30 min). Recovery is established by probes, never by a second unit, and is
  derived, never fanned out: a park recovers when every target has a passing probe after it (a resource target
  also disposed `cleaned`); a host probe records the parks it `covers`, and only those recover. At 6 h a
  retryable park raises a non-blocking `park-escalated` `needs-user` and probing continues at the cap (owner
  ruling 2026-09-30). `operator` parks (`env`: resumed by `resume <unit>`; `design`: an applied spec revision)
  wait for the architect. A stage interrupted by a backend park is held as `hold{backend{b, parkSeq}}`, released
  by a matching passing probe or `resume --backend`; operator pauses are preserved.
- **Usage limits (owner ruling 2026-09-25, unchanged by owner ruling 2026-09-30).** A `usage-limit` CLI error
  event marks that backend `limited` arc-wide: running processes finish, stages needing it park as
  `operator/usage-limit`, others run until they need it, and one `needs-user` is raised. It never auto-retries:
  `resume --backend <name>` re-runs that backend's preflight smoke before unparking. A usage-limit park dominates
  a retryable park on the same backend, and a probe clears only the park epoch it tested. Nothing brakes before
  the limit; limit hits under parallel burn are measured in arc 2.
- **Lane efficiency (A-M4-24; every arc).** A spec series reuses a lane's earlier pass of the same unit when its
  recorded identity (normalised lane rev, environment id, argv[0]'s resolved path and content hash) is today's, its
  series wrote a clean certificate, and the SHA is the same or (a fast lane declaring `inputs`) the diff since touches
  none of them; estate lanes reuse at the same SHA only, and a series that reuses every lane still makes and certifies
  its checkout. Every lane and journey spawn is stamped with the red protocol's revision, and its red class is written
  once before any rerun; a red repeating the unit's previous non-flaky red of the same lane, rev and environment with a
  specific failure signature, with no pass between, is not rerun (`repeat`). Host-suspected failures are shown. A
  suite lane identical to an arc lane (argv, cwd, env, tree) runs once for both. Lane revisions hash the validated,
  normalised definition everywhere.
- **Known defects and priority (A-M4-24; opt-in).** `plan.knownDefects [{id: K-n, match: lane | output{contains},
  fixUnit}]`: a unit matching an active defect records `known-defect` uncharged and waits at `prepare` until the fixer's
  lineage merges (one predicate, `knownDefectActive`; the fixer is never held by its own defect; the combined dependency
  and hold graph is cycle-checked; once the fixer merges a later match charges normally; removing an entry or editing
  its match releases the units it held at once, whose lanes then decide again; a changed fixer alone keeps the hold
  under the new fixer). A unit's `priority: high`
  ranks it before every `normal` waiter, ahead of promotion.

### 2.3 Architect commands

Commands are files in one executor-owned durable queue; clients never write state. Each carries an idempotent id
and the revisions it targets, and gets persisted `accepted | applied | rejected` receipts. **Control** (`pause`,
`stop`, `ack`) apply immediately: the cancellation is recorded, the authorised kill → quiescence → salvage →
cleanup transition runs, then `applied` is receipted; they wait only for a publication critical section under way.
**Mutations** — everything else, including every checkpoint act — apply only at safe points, defined by
admission (§2.2), not by open intents: a mutation applies when every unit in its scope is idle or awaiting
admission, and admission into a scope a pending mutation holds waits (drain). Scopes: `resume` and resource,
pool, capacity and routing edits, obligation, mapping, vision, corpus, Phase-0 and `limits` edits, and `reverse` → the arc;
`resume <u>`, `route`, `steer <u>` and `merge-in <u>` → that unit; spec and unit edits → those units; `sweep`,
`resume --backend`, `resolve-edge`, `run-only`, `rule`, `audit` and `close-admissions` → none. Every revision
commits through the revision fence (§2.6). After its asynchronous parts (smokes) a
mutation is classified again immediately before its commit. Each stage attempt pins the plan in force it was
admitted with; prompt inputs are snapshotted by revision at dispatch.

| Command | What it does | Refuses |
|---|---|---|
| `start` / `status` / `ack <id>` | launch or recover / §2.4 / acknowledge a `needs-user` item | a live owner or undispositioned residue; any `phase0 check` row (§3 Phase 0) / — / unknown id |
| `pause <unit>\|--all`, `resume [<unit>\|--backend <name>]` | park (kill, teardown, commits intact) / unpark at the earliest invalidated stage (§3 Git truth): a retryable park is probed now, an operator-env park re-runs its stage (`unparked`), an operator-design park reopens on an applied revision; `--backend` clears that backend's current park after a passing smoke. M1: `resume <unit>` of a unit parked at plan-check or gate re-opens it at plan-check once the architect has applied (`apply`) a revision of its spec to the next rev, keeping its branch and implementer session | discarding commits; pausing mid-ff; `--backend` when the smoke fails; M1: a parked unit with no revision applied, or parked at any other stage |
| `apply [--expect-rev <n>] [--dry-run]` | (owner ruling 2026-09-29) the edited plan and specs, hashed by the CLI into a manifest, become the plan in force at the next safe point: re-verified, every change classified against the plan in force and what each unit has done, the startup rows re-run over what changed, a newly seated backend smoked, the bytes kept content-addressed, then a `plan-applied{rev}` fact. The plan in force is a fold of the log, never the live files; a respawn runs it, and a `start` whose files differ goes through the same rules. Nothing live is killed: an in-flight unit takes a spec revision at its next stage boundary that allows re-entry and re-enters plan-check on it. `admit`, `patch-spec`, `reenter`, `cut`, `route`, `limits`, `obligation add\|split\|witness` and the vision below are edit classes of `apply` (adding units and edges; revising a unit's spec; `reenters`; `cut`; a unit routing layer; bounds; obligation edits; vision clauses), not separate commands, and so are pool, `capacity`, mapping and `holistic` edits (lead ruling LR-c, A1). M4a adds two, from an architect `apply` only, each a `PlanChange` arm carrying its hashes: `corpus{pinSha256, guideSha256}`, a re-pin (§2.8), which triggers a drift audit, re-gates every approval through the fingerprint's `corpus` and, before first admission, a pack review; and `phase0{sha256, issuesSha256}`, an edit of the Phase-0 record (dispositions, answered questions, intake, capture), which triggers only that pack review. `plan.chain` is fixed at revision 1. A file watcher is rejected (no command path, no expected revision, reads files mid-write). The manifest also hashes the ledger, the obligations file and the vision; the ledger is only compared (A3) | a stale `--expect-rev`; `vision-unconfirmed`; `tree-uncommitted`; a changed target variant (`target-kind-changed`); a changed `plan.chain` (`chain-immutable`); a `phase0` edit promoting debt while `draining`; no `--expect-rev` when a revision since the caller's last `apply` came from a non-architect source (a bundle or the executor; stale files would silently revert its act, A4); a ledger file differing from the ledger in force (A3); removing `holistic`; files changed since hashed; any refused edit (all or nothing, every reason listed): removing a started unit, reordering started units, a dispatched unit's lower risk, resources, spec path or new `after`, or its scope growth without a cited ruling naming exactly the added patterns, a spec edit other than evidence globs at its rev or the next rev, a spec edit of a stopped or finally-parked unit, any edit of an approved or merged unit, a held resource's declaration, suite lanes while a unit is at a candidate, a pool resized or removed while an instance is held, waited on or named by a residue, a request over capacity, the arc, integration branch, baseline or worktree root |
| `run-only <ids>` / `--clear` | dispatch allowlist checked at admission (arc 1's `dispatchOnly`, used W29–34); a command, not an `apply` edit, because it records a runtime fact | ids outside the plan |
| `rule <record.json>` | C-nn plus contract ops (anchor-exact, rev bump, header cites it) and obligation dispositions: the sidecar is validated against old revisions (its `consistency` fresh, G21), then the docs publication (§2.6), then the commit through the revision fence; invalidates citing approvals. The ledger's only writer after `start` (A3): it writes back to the live ledger file only while that file still holds the previous bytes | editing a C-nn (supersede only); missing `docRefs`; `deviates` without ops, or on a rule ref; a rule ref not in the pin; a contract op on a corpus file; anchor ≠ one match at the tip; stale `consistency`; a vision effect; a withdrawn `V-n` cited |
| `patch-spec <unit> <patch.json>` | id-targeted patch with expected revision (§2.7); since the 2026-09-29 ruling, an edit class of `apply` | merged units; stale revision; scope growth without a cited ruling naming exactly the added patterns (the unit is then re-pinned, and the transient check allows exactly those paths) |
| `admit <units+edges.json>` | adds units/edges; since the 2026-09-29 ruling, an edit class of `apply` | no spec or plan-check; unknown endpoint; cycle; duplicate id; a new prerequisite on a merged target, or on a dispatched one without `--force-park` (quiescence and invalidation first); a checkpoint admit while `draining` (a `bundle-request` instead); declared obligations narrower than the impact mapping (prefix-conservative) |
| `resolve-edge <edge> --evidence` | contingent edge → resolved (`edge-resolved`, a runtime fact, so a command) | unknown or resolved edge |
| `reenter` | a new unit with `reenters{unit, enterAt?: plan-check\|build\|verify, reset?{ruling}}`, entering through a durable preparation (§4 Re-entry); a retry resumes it; since the 2026-09-30 lead ruling, an edit class of `apply` | old unit not parked or held, or merged, cut or already superseded; scope outside the lineage's original envelope; risk below its floor; `reset` without a ruling; a cycle in the effective graph (each superseded unit replaced by its head) |
| `cut` | unit `cut{reason, ruling?}`: `inScope:false`; since the 2026-09-30 lead ruling, an edit class of `apply` | a unit in a task or merged; a direct dependent neither cut in the same apply nor dropping its `after` |
| `route` | the unit's routing layer `unit.routing` (§4), a new `routingRev`; an edit class of `apply`. Risk may rise; a moved implementer seat once the build started parks the unit (`routing-changed`, §4). `--adversarial` is withdrawn: a unit routing layer expresses it (A12) | risk below the Phase-0 floor without a ruling; an unsupported triple |
| `limits` | arc (`plan.limits`) or unit (`unit.limits`) bounds, in place of the built-in constants; an edit class of `apply` | lowering a counter below what is spent |
| `obligation add\|split\|witness` | obligation edits (§2.8), edit classes of `apply`, published like a revision (§2.6). `waive`, `defer` and `retire` are not edits: they are a ruling's `obligationDispositions`, applied by `rule` or by a checkpoint bundle | unsupported reporter; a weakening without a ruling in force naming the id; an architect split whose children drop parent text; a withdrawn `V-n` cited |
| vision | clauses `V-n` and open questions `Q-n` (§2.8); an edit class of `apply`, from an architect `apply` only (A14), as is the plan's `holistic.advances` | a vision or `advances` diff from any other source; a reused id; an `advances` naming a withdrawn or unknown clause, or no world clause |
| `reverse <D-n>` | builds a fresh compensating revision from the divergence's preimage, restoring the recorded revisions of exactly the artifacts it touched, and validates it like any revision (§2.8, A10) | a `repair-unit` divergence (a verified repair unit reverses a product effect); a conflicting later revision (with reasons; the architect then uses `apply`); an unknown id |
| `sweep [--resource]` | declared teardown for resources with no live holder, incl. indexed residues | anything a live session holds |
| `gc --repo <path> [--keep K] [--dry-run]` | a CLI act under the host lock, not a queued command: prunes sealed arcs (§2.9) | a busy host; an arc not sealed (§2.10) |
| `merge-in <unit>` | a `merge-tree` plan of the integration head into the unit branch; a clean merge acts (a `mergein.prepare` operation), writes `merged-in`, and the unit re-enters at lanes | a unit in a task; a conflict (rejected with no act) |
| `steer <unit> --brief <f> --budget <min> [--class <efficient\|frontier\|summit>] [--resume]` | alternate implementer-stage entry for a **parked** or `preparing` unit; `--class` enters as a per-unit routing layer (a new `routingRev`), so the steer record names the role: pre-steer state saved, approvals invalidated, `steered`, one uncharged steer round, then normal salvage → lanes → review/gate exit. Non-green parks; green parks unless `--resume` (R11); minutes (lanes excluded) and usage recorded. Unblocked arc 1's launcher and estate | unit not parked or preparing; `budget ≤ 0`; widening the envelope |
| `audit [--lens]` | §2.5 on demand (`audit-requested`). `explore` is deferred (A11, §8) | holistic off |
| `phase0 check --repo (--plan <f> \| --from-ref <arc>)` | a CLI act, not queued: read-only, no host lock, deterministic; the startup rows as JSON, exit 0 or 78, plus `sliceCandidates` (§3 Phase 0). `--from-ref` resolves every input by the digests the arc's ref recorded and omits the live rows (forge, host, tree) | — |
| `corpus pin --repo --baseline <sha> --commit <ref> --out <f>` | a CLI act: reads the guide and rules registry at the baseline, resolves the guide's source at the commit, parses rules blocks, diffs them against the baseline's rules registry and writes the pin (§2.8) | a reused or reappearing `T-n`; a rules block in the vision doc; a source remote that differs from the checkout's `remote.json` |
| `brief [--json] [--ack <briefId>]` | a CLI act: the brief and its ack (§2) | a stale `briefId` |
| `pr --repo --arc` | a CLI act, idempotent, the forge its only record: pushes the arc branch with a lease and opens or re-targets its stacked PR (§2.11) | — (a forge failure is a CLI error) |
| `issues --repo [--out <f>]` | a CLI act: the canonical issue capture (§4 Issue mode), written by atomic rename | `issue-policy-untrusted` |
| `chain status --repo` | a CLI act: the derived chain state (§2.11) | — |
| `close-admissions`, `stop` | latch `draining` (`admissions-closed`, §2.10) / park all, teardown, release the host lock (residues persist); every live call and lane is killed, lens and checkpoint calls included (a killed lens call abandons its audit, which runs again later), except a docs publication's lanes, which run to their end (lead ruling 2026-09-30) | already `draining` / — |

Automatic: salvage (arc 1 did it by hand three times); teardown after any kill; the snapshot (§2.9); residue
compaction at `start` (§2.9).

**M4a rev 3 commands (A-M4-25).** `resume-arc --repo` (a CLI act for a boot hook: restarts the supervisor of the repo's
arc whose owner died, a no-op otherwise); `witness-check --lane-file` (the implementer's witness comparator, §2.1);
`inputs export --repo --arc --out` (read-only: the arc's current inputs, every spec at its current rev, for an edit and
`apply --expect-rev`); `apply --ruling <sidecar>` (repeatable: rulings and the edits that depend on them land as one
revision). `apply` gains the edit classes `unit-priority`, `known-defects` and `plan-check-shape` (none drains), and a
re-entry may widen its lineage's scope envelope on an active ruling naming exactly the added patterns. A spec edit of a
unit whose attempt is running is refused until its stage boundary; one a crash cut short, until the executor records it.

### 2.4 `status`

Agent-facing JSON: are we closer to the target, what holds, what blocks and whose move it is, what was decided
without me, what is burning host or time.

`run` {state (§2.10), since, owner, heartbeatAt, supervisorCrashes} · `target` {cutLine, nextMilestone,
criticalPath, obligation counts} · `nowTrue` / `notYetTrue` from observations on the current head, with
blocking units, reason (code|spec|host|supervision|waiting-dep) and evidence dirs · `waived` / `deferred` with
rulings · `vision` {rev, confirmation, clauses with state, questions, advances, coverage {unservedAdvanced, horizon,
obligationsServingNone, withdrawnCited}} · `needsUser` ranked, with recommendation and options · `decisionsSince` [{C-nn | bundle |
patch | reenter | cut | steer | quarantine | divergence | reverse, oneLine, ruledBy}] · `divergences` (ids no
acknowledged digest covers) · `convergence` · `commands` · `units` {counts, running [{stage, attempt, elapsed,
deadline, resources}], parked/quarantined/preparing [{why, reasonClass, nextProbeAt?, escalateAt?, lineage,
dossier}]} · `findings` · `audit` {coverage per lens in L (watermark and docs edges), uncovered by lens,
generation, checkpointLaneMinutes} · `owed` · `completion` {planRev, head, active, sealed} · `corpus` {pin,
source, rule counts} · `census` {state per `T-n`, `% held`} · `amendments` · `debt` · `issues` {last capture,
intake outcomes} · `chain` {position, K, unacked starts, PRs} · `timings` {per-stage counts, p50 and max over
completed attempts, derived at read time} · `spend`
{Claude tokens by role (by-model totals derived from `routingRev` at render time), usage-unavailable calls,
codexHours} · `host` {load, locks, residues, containment, log {bytes, events, foldMs}, strandedResources —
non-empty is a flag}. `target.nextMilestone` is the future obligation with the fewest unmerged `deliveredBy`
(R13).

The architect log keeps arc 1's four-paragraph shape (what the organisation can now rely on · what is not yet
true · rulings · next target in business terms), rendered from the same state.

### 2.5 Cadence audit (Opus lenses)

Four lenses. Invariants, drift and vacuity all paid off in arc 1 (w33 found two P1s and two P2s seven unit
gates had passed; drift in four of six audits; eight vacuity rows). The fourth, `vision` (A15), asks whether the
product serves the vision, whether anything is faithful to its letter but wrong for it, and where the vision
does not anticipate what happened; it opens P2 or P3 findings citing `V-n`. `holistic.audit.lenses` is the arc's
**required lens set L** (default: all four); coverage, owed audits and completion are measured per lens in L
(H9). Audits run only when the holistic layer is on (§2.8). The lenses report; the checkpoint that follows
them acts (§2.8).

- **Triggers**: every N publications (D3; unit, batch, and rule-with-contract-ops publications); a publication
  leaving a selected future or exempt obligation unwitnessed (R8); drift-only on a revision from a rule, a
  bundle, `reverse`, or an architect spec, obligation, vision or corpus edit (w37 found drift with zero merges), running
  `L ∩ {drift, vision}`, or all of L when that is empty (R15); wall-clock (`wallClockMin`, default 360);
  `audit [--lens]`; **final**: at the final head, every lens in L with an outstanding range (H9). Triggers
  coalesce, one audit runs at a time, and each records its causal generation (§2.8).
- **Immutable inputs**: `audit-started{job, triggers, generation, lenses, integrationSha, planRev,
  ledgerSha256, obligationsSha256, visionSha256, owners, priorFindings, highWater}`, captured under the revision
  fence (§2.6, A19): owners are the branch SHAs of parked or in-flight owners (the w33 P1s were already fixed on
  a blocked branch), prior findings carry dispositions (w35–37 repeated one note thrice). A detached worktree,
  so merges continue.
- **Run**: all arc lanes on the snapshot; the lenses serially, one `@cpu` each, each given the vision first, then
  the obligations with observations, the range diff and owner branch diffs; findings; `audit-ended{covered}`;
  the worktree removed, citing a snapshot. Coverage stops at the audited SHA, and before the checkpoint the cited
  P1s are re-witnessed on the current head. A failed job-lane cleanup leaves a residue owned by `job{…}`,
  probed and reclaimed like any other; the job re-runs the lane. A job whose lane gives no verdict is retried on
  the retryable-park backoff, and at 6 h raises one non-blocking `park-escalated` (lead ruling 2026-09-30).
- **Coverage**: per lens, a contiguous watermark over the integration history; results are observations keyed by
  the audited SHA. A docs-only publication (the executor-rendered `.roadmap/` files, rendered by code from
  in-force records) covers its own edge U→D by construction (`docs-covered`, A17, H8): a lens's watermark
  advances to D only when it already reaches U; otherwise it stays, and the edge is recorded for when the gap
  closes. Outstanding triggers and drift obligations are kept, and its witnesses still run. A rule publication
  carrying contract ops is not docs-only. A vision revision clears every coverage recorded before it: each lens's
  watermark restarts at the arc's base (the head when it turned holistic), so the next audit of each lens covers
  the whole arc under the new vision and no merged range survives the change unaudited (lead ruling 2026-09-30).
- **Mutants are executed, never judged by reading.** A vacuity finding admits a bounded repair unit whose first
  stage, `reproduce`, applies the mutant (`mutant.apply` in a detached worktree) and runs the lane under
  `purpose: mutant`: `reproduced` → plan-check; `not-reproduced` → code dismisses the finding and the unit
  parks; `inapplicable` → re-evaluated at the next audit. Acceptance is the candidate killing the mutant; a
  survivor is `red{mutant}`. Mutant records never certify (G13). No unadmitted implementer runs.
- **Quarantine stays a real-defect signal**: 21 of 24 arc-1 dossiers were design-class; risk predicted it
  (high 30%, med 21%, low 7%). 1.0 stops charging host or supervision faults.
- **Owed**: a skipped audit keeps its triggers owed; at 2N publications or 2 × `wallClockMin` → a non-blocking
  `audit-owed` (OR-Q2/3; an owed explorer went unrun for 27 waves). The final audit and checkpoint run after the
  last merge; the audit stays open until its generation is quiescent.
- **Change-sensitive drift (A-M4-27).** A bundle revision that changes only plan units and their specs drifts
  `specsOnly`: the vision lens alone, over the spec deltas; code lenses keep their watermarks. Within one audit, a
  lens draft whose (repo evidence paths, obligation, cause) equals a finding the audit already opened merges into it,
  its rationale kept (`finding-corroborated`). A vacuity finding's mutant patch is syntax-checked at admission; a
  corrupt patch refuses the draft with git's reason.

### 2.6 Ruling record

`C-nn — <rule>` plus provenance (cited by 83 of 114 arc-1 specs; the provenance lives in the in-tree
`constraints.md`, while the ledger file judgments read carries rule text only, a withdrawn ruling folded to
`C-nn — withdrawn by C-mm`), with a JSON sidecar: `statement`, `kind`,
`ruledBy` (architect | checkpoint), `trigger`, `supersedes [{id, part}]`, `condition?`, **`docRefs` required**,
each a doc ref `{path, anchor, quotedText, relation: consistent|refines|deviates}` or a rule ref `{rule: T-n,
textSha256, relation: consistent|refines}` (never `deviates`: a departure from the corpus is a divergence, §2.8),
`contractRefs`, `contractOps` (required when a doc ref `deviates`; never on a corpus file), `obligations`,
`obligationDispositions [{id, waived|deferred|retired|amended}]` (`amended`: a changed statement, `docRef`, `rule`
or activation; each the architect's, or the checkpoint's citing active `V-n` plus evidence, §2.8), `appliesTo`,
`lifetime`, `status`, and the required `consistency {verdict, judgedRevs {head, ledgerSha256, obligationsSha256,
visionSha256, corpusSha256?, contracts}, by}` (G21). Code checks identity, anchors and quoted text (a rule ref
resolves `{T-n, textSha256}` in the pin), revisions, supersession, amendment
linkage, overlapping anchors, that every cited `V-n` is active, and that `consistency` is fresh against the
revisions in force: the ledger, obligations and vision bytes and the named contracts' blobs (the judged `head` is
provenance only, so a merge that leaves those untouched keeps it fresh; doc refs are re-checked at the tip
regardless; lead ruling 2026-09-30); semantic consistency is the model judgment `consistency` records. Rulings are checked
against the code before landing (plan-check readings overturned three arc-1 drafts).

**Ledger ownership (OR-Q5, A3).** After `start` the ledger is executor-owned and `rule` is its only writer (a
checkpoint ruling reaches it through a bundle's activation). An `apply` whose ledger file differs from the
ledger in force is refused. Write-back to the live ledger file happens only while it still holds the previous
bytes.

**Revisions and activation (A2, G1).** The revisioned set is the plan, the specs, the ledger with its sidecars,
the obligations with their mapping and census, the vision, and in a corpus arc the corpus pin (with the guide
bytes and every pinned file) and the Phase-0 record (with its issue capture); `plan-applied` records each hash. Every revision has one
activation record, payload first, whatever its source: `start | command{id} | bundle{job} | executor{inv}`.
`evaluate(proposal, source)` builds the proposal (`apply` from the files; a bundle from the plan in force plus
its ops; `rule` from ledger plus sidecar; `reverse` from a divergence's preimage; the executor's `spec.patch` from
its patch), takes the revision fence and evaluates again synchronously (a differing result → `stale`). Then
`activate(payload)`: the full evaluated payload is kept content-addressed as `inputs/<sha>.revision.json`
(manifest, changes, sidecars, dispositions, divergences, source, publication plan and referenced bytes); a
`revision.commit` intent names it before any docs `ff`; the docs publication runs, if any; `plan-applied` is
appended from the payload exactly, then its divergence facts; the fence is released. Recovery, with the `ff`
done or no docs step, appends from the payload; otherwise it aborts and re-evaluates the source. It never
reclassifies.

**Revision fence (A19, H2).** One fence (op key `revision`, at most one open `revision.commit`) is held from
final validation, through the docs `ff`, to `plan-applied`. It serialises `apply`, `rule`, `reverse`, bundles
and the executor's `spec.patch`, so two revisions validated against one base cannot both commit. Every capture
of revision-sensitive inputs takes it briefly and synchronously: `judgment-inputs` (plan-check, gate),
`audit-started`, `checkpoint-inputs`, and a bundle's final staleness check. So no reader sees the window
between a docs `ff` and its `plan-applied`, where new contract blobs sit beside an old ledger or plan.

**Publication.** The rendered in-tree `.roadmap/` files (§2.9) and contracts change only through a docs publication, in the
integration slot under the holder `docs{pub}`: `docs.commit` (old and new document blob SHAs, a candidate on the
tip), the transient check, suite lanes, then journey lanes for the obligations the touched documents map to plus
those the revision changed (G12; at close-out, all) under the held-claims brake (§2.8), `ff{docs}` with the exact
expected integration update, the activation above, then `snapshot`. Its lanes run under `job{docs-…}`. Docs
publications outrank unit publications and preempt a candidate before green (A7, §2.2). Ledger entry and
document commit become visible together; recovery reconciles by the postcondition. There is no other document
writer and no pending state. The corpus is not a document the executor writes: the architect curates it in
session and commits it outside the arc (§2.8, §2.11).

### 2.7 Spec record

Arc-1 redirects were appended as prose, so verifier and gate graded different texts (§3.17). The canonical spec
is `spec.json` with stable clause and lane ids and a revision; its full Markdown rendering is non-normative and
is the one text verifier, gate and fixer read. Fields: `lanes [{id, argv[], cwd, env, expectedExit, tier:
fast|estate, resources, evidenceGlobs, until?: {unitMerged}, then?}]` (`argv[0]` resolves at plan load — no
shell strings, so no bare `access.sh`; `until` resolves through `supersedes`, C-126), `acceptance [{id, clause,
failLoudIfUndelivered}]`, `scope`, `resources`, `decisions [R1…]` verbatim for the implementer,
`obligations? [I-nn]`, `repairs? [finding or I-nn]` (required non-empty for `origin: repair`), `facts` (a debt item a
Phase-0 `promote` assigns the unit is named by that disposition alone, §2.9). `contractRequests` and `owedAfterMerge` are
withdrawn (M4a): a contract need is a corpus amendment or a ruling, owed work is debt. `patch-spec` ops (`add |
replace | strike | defer`) target ids with the expected revision, and are also how plan-check redirects apply;
changing a lane or clause invalidates the evidence that graded it.

### 2.8 Holistic layer: vision, obligations and checkpoint authority

**The vision is the root record (OR-V).** A vision record holds clauses `V-n {kind: world | purpose | serves | good |
non-negotiable | tradeoff, text, rank, state: active | withdrawn}` (`rank` required for `tradeoff`, null
otherwise) and the Phase-0 playback confirmation reference `{ref, at}`, verified at `start` and `apply` (below). Ids are never
reused, and a withdrawn clause stays in the file (H16). The vision is revisioned and **owner-only**: only an
architect `apply` changes it; the classifier refuses a vision diff from any other source. New bundles, rulings and
obligations may not cite a withdrawn clause (refused as invalid); existing citations stay and are listed in
`status.vision.coverage.withdrawnCited`. Coverage (advanced clauses unserved, the horizon, obligations serving
none) is reported, not refused. **Readers:** the full vision goes first into every lens and checkpoint prompt, and on conflict the vision
wins; the pack review (§3 Phase 0) reads it too. Plan-check receives it as read-only context and may emit `visionConflict [{clauses, note}]`; each entry
opens a P3 finding (`lens: plan-check`) for the next checkpoint and is never a redirect on its own: a redirect
needs the spec's own grounds (R17). The gate never receives it: it grades spec and contracts, and the pinned
scope holds. **A vision revision** restarts every lens's audit coverage at the arc's base (§2.5), reopens the
quiescence of generations recorded under the old vision, and triggers a drift-only audit (H3, R15).

**Vision home and playback verification (M4a).** The vision doc is a readable document in the corpus, at any
path and format the corpus guide names, holding no rules block. The vision skill compiles it to the record at
`<repo>/.roadmap/vision.json`, read from the working tree like `config.json`; `confirmation.ref` is
`corpus:<path under root>#sha256:<hex>`. At `start` and on every `apply` the executor hashes the **pinned** corpus
file at that path: a mismatch, a missing file or `confirmation: null` refuses `vision-unconfirmed` (for an
`apply`, a rejected receipt reason). At both, `.roadmap/{vision.json, corpus.md, config.json}` in the working tree
must equal their blobs at `HEAD` (`tree-uncommitted`), so every accepted vision is committed history. An
`architecture-doc` arc keeps its vision beside the plan; an adopted dev.6 arc's `vision.md#sha256:` reference is
not verified (scaffolding, §10).

**M3 amendment (2026-10-01): the world, open questions and the slice.** At least one active clause is a **`world`** clause: a prose scene of the target world (who is there, what they do and
experience, why it is better than today), which may reach beyond the current arc; the other kinds are its facets.
The record holds **open questions** `Q-n {text, bears: [V-n], assumption, state: open | closed}`: vision questions
whose answers would change the target world (a design question belongs in a spec or a ruling), each with the
working assumption the arc acts on meanwhile; ids are never reused and a closed question stays as it was. The plan
names **the slice** this arc moves toward, `holistic.advances` (active clauses, at least one `world`; owner-only,
checked at start and on every revision); the other active clauses are **the horizon**. Coverage splits accordingly:
an advanced clause no obligation serves is a gap, a horizon clause is expected. Judges push toward the slice and
never foreclose the horizon; an assumption is provisional, so they prefer the reversible choice where a decision
rests on it, and the checkpoint `request`s an act that would be costly to undo if it proved false. Nobody but the
owner closes a question.

**Holistic on by vision (A5).** The layer runs only when the plan has `holistic` and so a vision; obligations may
be empty. `apply` may add `holistic`, never remove it; adding it runs the baseline job. An arc without it has M2
semantics and no new spend.

**The target: a pinned corpus (M4a).** The plan's target is a closed union, told by the field present:
`architecture-doc` (`architectureDoc`, `architectureDigest?`, and under `holistic` a `vision` beside the plan) or
`corpus` (`corpus`, the pin; `phase0`, the Phase-0 record; `holistic` always, its vision in `.roadmap/vision.json`).
Any other combination is refused at parse. A fresh holistic arc must use the corpus variant
(`holistic-needs-corpus`); `architecture-doc` stays for non-holistic arcs and adopted holistic ones, and `apply`
never changes the variant (`target-kind-changed`). Code reads the variant fields only through accessors
(`targetDocuments`, `visionFile`, `obligationSource`, `rulingRefSource`).
- **Corpus.** A living, readable set of documents the architect writes and curates in session through the corpus
  guide `.roadmap/corpus.md` (agent-facing prose plus one `json roadmap-corpus` block naming the source, include
  patterns and the vision doc). Sources: same-repo, other-repo, or a checkout the CLI owns, cached under the full
  sha256 of the canonical remote with a write-once `remote.json` checked before every fetch. Code never edits it.
- **Rules.** In any included file but the vision doc, a fenced `rules` block holds one `T-<n>: <one-line normative
  claim>` per line; prose outside the blocks is rationale. `T-n` is global across arcs and never reused; a
  rewording keeps the id, a meaning change mints a new one; a removed rule is retired and never returns; a rules
  block in the vision doc is refused (`rules-in-vision`). The registry `{highWater, active, retired}` is a
  `json roadmap-rules` block in the published `invariants.md`, which the next pin diffs against.
- **Pin.** `roadmap corpus pin` resolves the source at a commit and writes `{guideSha256, source, files, rules,
  retired, highWater, vision}`. At `start` and `apply` the executor re-derives it and requires equality
  (`corpus-invalid{pin-drift}`), then keeps the guide bytes, every file and the pin as revision inputs; the snapshot
  closure (§2.9) carries all three. A re-pin is the `apply` edit class `corpus` (§2.3); it is refused while an
  active obligation's `rule` no longer resolves, unless the same `apply` edits that obligation, or while the census
  is incomplete over the new pin. The approval fingerprint binds the whole pin sha.
- **Judges** read the rules index in full and the pinned files on demand from a read-only materialisation of the
  kept bytes. The gate's and the build's view omit the vision doc, and the index carries no vision text.
- **No overlap.** For same-repo, the corpus file set is every pinned file plus every path matching the include
  patterns. A plan contract, a contract op or a unit scope overlapping it is refused at plan load and `apply`
  (`contract-overlaps-corpus`, `scope-overlaps-corpus`), so units never write the corpus and contract ops never
  target it.

**Corpus amendments and curation (M4a).** A checkpoint never edits the corpus. Code records a `corpus-amendment`
for every `target-departed` divergence (citing `T-n`) and every interpretation divergence; the checkpoint proposes
more (`corpusAmendments`), and issue intake may yield one. The next Phase 0 dispositions every amendment
(`applied | rejected | deferred`), read from the previous arc's verified ref. Phase-0 curation runs in three tiers,
each entry naming its source files: structural and fact-currency edits are autonomous and listed in the curation
digest; a semantic conflict the vision resolves is a corpus divergence with a preimage of the files and the
`V-n` it cites, reversible by restoring them; a semantic conflict the vision is silent on is a ranked `P-n`
question with a working assumption (`P-n` global, never reused).

**Delegation envelope.** **Obligations** are owner-approved: every checkable claim extracted from the target (the
pinned corpus's rules, or an `architecture-doc` arc's document; extracted, cross-checked, adjudicated by the
architect) plus the cut line.
**Implementation contracts** — frozen contracts, conventions, specs, routing, limits, the plan graph — the
checkpoint edits autonomously. It may also weaken or amend an obligation (dispose, split-and-drop, re-anchor)
when it cites active `V-n` plus evidence: it reconciles silently against the vision and the owner is consulted
afterwards through divergences and their digest (below). Obs §4.5's hostname ruling, which broke cookie
isolation, is why every such act is recorded with its preimage. Only owner-only acts go to the owner first.

**Owner-only acts (A16, H10)** are a closed set the checkpoint cannot express: irreversible or destructive acts
outside the sandbox, possible cost over $10, and legal ramifications. `BundleOp` has no variant for the vision,
resource declarations, `.roadmap/config.json`, `gc` or ref deletion; for such an act the checkpoint may only
`request{class, summary, evidence}`. Nested effects are converted the same way: an op that would introduce a lane
program whose `argv[0]` the plan in force does not already resolve, a new lane env prerequisite, or a contract-op
path outside the plan's contracts and target documents becomes a `request{class}`. A request applies nothing and
raises a blocking `owner-request`. Stated limit: this governs the checkpoint's revisions; an implementer build
stays bounded by the unit policy (a prompt, §4) and by containment, not by this check.

**Obligation record.** `I-nn {rev, statement, docRef {path, anchor, quotedText} | rule {id: T-n, textSha256}, serves [V-n], witness {lane,
testIds} | null, proofJudgment {verdict, rev} | null, deliveredBy [units], activation: future | must-hold,
parent?, contracts, state: active | split{children} | waived{ruling} | deferred{ruling} | retired{ruling}}`, kept
in one obligations file with the arc lanes, the cut line and the impact mapping. `witness` and `proofJudgment` are
null exactly when the state is `split` (H14). `serves` is non-empty when the arc has a vision. Ids survive
amendments; split children name the parent. One held on the base starts `must-hold`; others name
`deliveredBy`. Evidence refresh never bumps the normative `obligationRevs`. `waived`, `deferred` and `retired`
come only from a ruling's `obligationDispositions`, never from `held`. Each obligation has exactly one of
`docRef` and `rule`: a corpus arc's all use `rule`, an `architecture-doc` arc's all use `docRef`. Extraction is
in-session Phase-0 work (M4a, LR-b); M3 fixtures seed obligations by hand.

**Census (M4a).** A corpus arc's obligations file holds `census [{rule: T-n, state: obligation{I-n} |
out-of-slice | untestable | prod-only}]`: exactly one entry per active pinned rule and none for a retired or
unknown one; an `obligation` entry names an obligation whose `rule` is that `T-n`, and every rule obligation
appears in it. The census is revisioned with the obligations; an incomplete or dangling census refuses `start`
and `apply` (`phase0-invalid`).

**Obligation edits** are `apply` edit classes (§2.3) or bundle ops:

| Edit | Rule |
|---|---|
| added | `rev` 1; `serves` cites active clauses; a `must-hold` one must show held in the revision's docs candidate (G12); a `future` one needs `deliveredBy` |
| split | the parent goes to `split{children}`, its `witness` and `proofJudgment` null; each child names the parent and has its own witness. The architect's children include the parent's text verbatim; a checkpoint split may drop text only citing `V-n`, and code records the dropped text as a `split-dropped` divergence. Under a must-hold parent (latched included) a `future` child needs a `deliveredBy` unit not yet published |
| witness | a fresh `proofJudgment`; a shrunk `testIds` set counts as weakening |
| weakening (removed, statement, `docRef` or `rule` id changed, `must-hold` → `future`, waived, deferred, retired; a `rule` hash refreshed after a rewording with the statement unchanged is an edit, not a weakening) | a ruling in force naming the id in `obligationDispositions`: the architect's, or the checkpoint's citing active `V-n` plus evidence |

**Baseline witness (A6).** Before the first admission under `holistic`, a baseline job witnesses every
obligation. A `must-hold` obligation not held → blocking `obligation-baseline`; a `future` one already held is
refused as a vacuous witness.

**Re-derivation (LR-b).** At Phase 0 the previous arc's published obligations (a JSON block in the baseline
tree's `invariants.md`, R2) are diffed by I-nn against the new file; the startup row `obligation-dropped` refuses
a missing or weakened id that no Phase-0 ruling dispositions. A split parent counts as present. In a corpus arc
the census is diffed too: every active `T-n` of the new pin has its one state, and every obligation's
`{T-n, textSha256}` resolves in it (`phase0-invalid`).

**Witnesses.** Arc lanes have stable ids and revisions and declare a reporter on the lane (R1): `node-test` (the
shipped reporter through `NODE_OPTIONS`, writing to `$ROADMAP_WITNESS_FILE`; a lane that sets `NODE_OPTIONS` is
refused), `go-test-json` (stdout parsed as test2json events), or `jsonl` (a wrapper appends records to
`$ROADMAP_WITNESS_FILE`). Many obligations share one execution per tree. A witness record is `{lane, laneRev,
envId, treeSha, inv, runner, purpose: witness | mutant, records, malformed}`; malformed output makes every
declared test `unwitnessed`. The verdict is pure: every selected test ≥ 1 and passing → `held`; any failing →
`not-held`; passes mixed with skip or zero-selected → `partial`; else `unwitnessed`. An observation derives from a
`purpose: witness` record, keyed `(treeSha, lane, laneRev, envId)`, and is reused only when all four keys and the
record hash match. Discharge is strict: `envId` is the executor's own (`status` reads the one it recorded), and
another environment's observation never discharges (lead ruling 2026-09-30); mutant records carry the patched tree's id and never certify (G13). "This test proves this
statement" is judged at Phase 0, bound to both revisions, re-judged only when either changes. Unit-branch
success never certifies an integrated claim (w38). Checkpoint lane duration is part of Phase-0 feasibility and
`status`.

**Ordering.** Observations (`held | not-held | partial | unwitnessed`) are append-only, keyed by tree SHA and
revisions; current status is the one on the current integration head, never the latest to complete. The
transition table is total, split parents included:

| Obligation | Case | Effect |
|---|---|---|
| `future` | candidate not completing `deliveredBy` | measured, never graded |
| `future` | candidate completing `deliveredBy`, `held` / other | witness validated, then graded: latches `must-hold` on publication / red |
| `must-hold` | `held` on this tree, or validly reused | discharged for that head |
| `must-hold` | `not-held`, `partial`, `unwitnessed`, skip, zero-selected, stale, missing | red for the brake; never discharges |
| split parent | never witnessed directly | discharged when every non-exempt child is; red when any selected child is red; else measured |
| waived, deferred or retired | any | exempt |

A latch is `obligation-latched` after `ff{published}`, before the snapshot; recovery writes any latch missing.

**Impact mapping.** One authoritative mapping, built at Phase 0 and revisioned with the obligations, selects a
candidate's obligations: its declared ones and its `repairs`; those whose contracts, docRefs, witness files or
mapping patterns its changed paths touch; those of its dependency closure; the future obligations it delivers;
and every `must-hold` obligation when a changed path is unmapped. A split parent is selected when any child is,
and selecting a parent selects its children (H14). A revision publication also selects the obligations it added,
split or re-witnessed (G12). `admit` and `patch-spec` validate declared obligations against the mapping
(prefix-conservative where patterns overlap the scope). Obligations neither run nor validly reused are recorded
`not covered`, never passed. The fingerprint's `obligationRevs` covers the selected, non-exempt obligations at
the gated tip.

**Journey lanes** run, owned by no unit, under the same arbiter, locks, watchdog, evidence and red-lane rules: in
every candidate after the suite is green (unit lanes under the unit's stage holder, docs lanes under
`job{docs-…}`, batch lanes under `job{batch-…}`); on every audit snapshot, all of them; in the baseline job and
at close-out. **Held-claims brake (code):** a candidate is green only with the suite green and no selected
obligation's effect red. A brake red takes the red-suite path, witnessing the tip alone: tip green →
`red{brake}`, charged; tip red → `base-red`, unless a known regression applies. Only a disposition ruling
exempts an obligation. **Known regression (R4, G11)** covers background failures only: a failing test in a
reporter-declaring suite lane, or in an unselected obligation's witness, grades green when a P1 records that
`(lane, testId)` and the tip alone fails exactly that set. A selected `must-hold` obligation is never excused.

**Findings and repair.** States `open → owned → fixed-on-branch` (the owner's gate approved, R5) `→ resolved`,
or `ruled`. Findings dedupe by `key = sha256(lens, obligation, cause)`: a key matching an open finding merges into
it; one matching a dismissal is suppressed unless a cited evidence blob changed. Dismissals have arc lifetime.
Lenses open findings; code opens a P1 (`lens: witness`) when a `must-hold` obligation is not held on an audit
snapshot; plan-check opens P3 vision-conflict findings (R17). An active P1 adds `finding-blocked` to every
candidate selecting its obligation, at admission and before `ff`, except the declared repair (`spec.repairs`),
which publishes when its candidate shows every repaired obligation held with integrated evidence. A unit with
`origin: repair` needs non-empty `repairs` and ranks first (R6, §2.2). **Batch repair (R7, G5, H4):** all
approved units repairing one finding publish as one candidate, chained `--no-ff` merges on the candidate ref under
the slot holder `batch{finding, attempt}`; its lanes run under one durable job identity `job{batch-<seq>}`, whose
residues are job-owned; `ff` validates every member's fingerprint and every member retires on that one `ff`. On
red, a fix round per attributable member, else every member parks. A parked owner's P1 escalates at the park
deadline; P1s never bank; while `draining`, a new P1 or P2 raises a blocking `new-finding-draining`. Per finding
`{lens, severity, gateHadPassed, disposition, merged, timeToResolve}` is recorded, so arc 2 measures whether the
checkpoint works.

**Checkpoint authority.** After every completed audit (§2.5), and on every operator-design park, the checkpoint
seat **rules**, steering toward the vision rather than the original plan: amend implementation contracts,
respec, `reenter`, `cut`, `admit`, re-route, set limits, rule, split or dispose obligations, invalidate
approvals. A design park goes to the checkpoint for a respec, re-entry or cut first; a `no-op` raises the park's
`needs-user`, and a second design park on the same lineage raises a blocking `respec-second` (OR-Q1). The
checkpoint writes nothing itself (LR-d): its closed output is `{decision: no-op | bundle, reasons, ops,
rulings, findingDispositions, interpretations [{clauses, situation, reading}], corpusAmendments [{rules,
proposal, why}], issueIntake [{issue, outcome: finding | amendment | acted{on: ops} | none}], cites {vision,
observations, findings}, premises}`, every op citing active `V-n` (non-empty) with evidence, and code activates
it. Where the vision does not anticipate a situation, it takes the most optimistic reading that fits and records
it in `interpretations`. Its inputs, captured under the revision fence as `checkpoint-inputs`, are the vision
first, the revision vector `{plan, spec:<u>, obligations, ledger, vision, corpus, contract:<path>}`, the head,
findings, observations, vision coverage, open vision-conflict findings and the issues captured just before (§4
Issue mode). Brakes in code:

- **Bundles.** A decision is one action bundle, activated as a mutation job scoped to its ops; affected dispatch
  waits meanwhile. In order: validate schema, identity, rulings (their `consistency` included) and cites (active
  `V-n` only, non-empty evidence); an owner-only op, nested ones included → `requested`, blocking
  `owner-request`, nothing applied; while `draining`, an `admit` → `bundle-request`; staleness under the fence
  over every artifact touched **plus the vision sha, always** → `rejected{stale}` and a re-queue; a cited
  observation that differs or is missing on the head → `rejected{evidence}`, a re-witness, then a re-queue or
  resolve; a convergence bound hit → `bundle-request`; an all-or-none `evaluate`, any refusal →
  `rejected{invalid}`, re-evaluated once, then `bundle-request`; no effective change → `no-op`, no revision, its
  interpretation divergences still recorded (idempotent facts keyed `(job, index)`, H12); else the commit through
  the revision fence (§2.6): `plan-applied`, then the divergence facts from the payload. A `bundle-request`
  offers `apply | reject` to the architect.
- **Divergences (A10).** Code records a `divergence` for every checkpoint act that departs from the target
  document, an approved obligation revision, the plan or a contract blob (a `split-dropped` text included), and
  one per interpretation, on a `no-op` too. Each holds immutable preimages `{planRev, specs, obligationsSha256,
  ledgerSha256, contracts [{path, blob}]}` and a compensation hint `restore-revision | repair-unit | none`; there
  is no executable inverse (H13). Divergences are non-blocking. A `divergence-digest` binds an explicit id list:
  every divergence neither covered by an acknowledged digest nor in an open one, raised when none is open;
  acknowledging it covers exactly those ids, and later ones raise the next digest (H11). Reversal: `reverse
  <D-n>` (§2.3) builds and validates a fresh compensating revision at request time, or the architect uses
  `apply`. A published product effect (`repair-unit`) is reversed only by a verified repair unit.
- **Generations.** A checkpoint takes its trigger's generation; an applied bundle's drift audit starts g+1. A
  `no-op` makes its generation quiescent, unless the vision changed since.
- **Convergence bound (OR-Q2/3, A9).** Material ops (cut-and-replace, respec, scope expansion, budget reset,
  re-route, a spec patch changing lanes or acceptance) count per causal identity `(finding or obligation id,
  lineage root)`; a second → `convergence-identity`. Each applied bundle increments an arc counter, cleared by a
  publication or a new discharge; at K (default 3, set by `limits`) → `convergence-bound`. A repair `admit` is not
  material (R10). Brakes act on the checkpoint and never halt units: both items are non-blocking, and while one
  is open every bundle becomes a `bundle-request`. Acknowledging it resets the counter.
- Every act is a ruling record (§2.6) or a revision, shown in `decisionsSince` and the log. Answering the user
  stays root-only.

**Admit classes (A-M4-20; OR-A1, LR-k; corpus arcs).** Code classifies every checkpoint `admit` against the
owner-selected slice `S` (`advances` less the arc's opportunity clauses): **repair** (it restores an obligation or
behaviour that does not hold; its refs are valid: an unheld non-exempt obligation or a captured active finding),
**oversight** (a gap within `S`'s clauses), **opportunity** (it advances clauses outside `S`, honestly cited; they join
`advances` and the brief; the budget is one per arc) or it converts. A clause counts as touched by an admit through
its cites, the obligations its unit delivers, and what it repairs (a mixed finding keeps its out-of-slice clauses);
obligations an impact mapping merely relates never count. A repair whose attributed units (by finding source and lens
range, or an obligation's held-to-not-held window) lie wholly in one opportunity's lineage is that opportunity's
follow-up; an opportunity carries one, and the next converts with a debt item naming it. Ambiguous attribution never
grants a follow-up. Repair and oversight are always admitted; an unrelated admit, an opportunity over budget and an
overrun convert: the op is dropped and recorded as a corpus amendment, unless another op or an issue disposition names
it, which makes the bundle invalid. The classification is persisted in the decision record before any settlement and
never recomputed. A bundle may add to `advances` exactly its opportunities' clauses; nothing else of `advances` moves
but by `apply`. `status` and the brief show admits, opportunities and a drift indicator.

**Checkpoint evidence and inputs (A-M4-21, A-M4-27).** A cited observation on another tree stands when the head's run
of the same lane, at the same lane rev and environment, keeps every cited test's outcome and selection, neither record
malformed nor the cited one empty. Rulings are stamped with the corpus pin they were judged at; model-written ruling
ids are read in numeric form; a split child anchored at an out-of-slice rule moves the census when it serves the
slice, and is refused with the fix otherwise. A bundle touching a unit's running or crash-abandoned attempt is
rejected `busy` (not counted toward the invalid brake) and decided again only after the attempt's boundary. The
checkpoint reads an immutable, content-addressed manifest of its inputs (never `roadmap-inputs`) with every unit's
spec embedded with its occupied item ids and the ledger's next ruling id; after a no-op, a checkpoint whose relevant
inputs are unchanged renders only the deltas (never the final one), and unchanged issues on unchanged grounds keep
their dispositions. Before admitting or approving a repair that reorders a transaction, the checkpoint and plan-check
write its failure matrix (each step × process death).

**Phase 0 (A-M4-28).** The shared Phase-0 rows gain `spec-census-mismatch`: a pack spec's declared obligation whose
rule's census state is not `obligation` for it or its split parent, or an acceptance item naming an out-of-slice rule.
A pack re-review after a required review reads the changed pack files and the previous review's unresolved findings,
giving each a disposition (`resolved`, `still-open`, `withdrawn`); the first review stays full.

### 2.9 Artifacts

The integration branch carries product changes and living docs only: in-tree
`.roadmap/` holds exactly `contracts/`, `constraints.md`, `invariants.md` and `debt.md` (what a later arc's Phase
0 reads, rendered from the ledgers and changed only by publication, §2.6), plus `config.json` (§4), `vision.json`
(§2.8) and `corpus.md` (the corpus guide, §2.8), which the architect commits in the bootstrap or between-arc
commit (§2.11) and which must equal their `HEAD` blobs at every `start` and `apply`. The authoritative run records (below) are
snapshotted one-way to `refs/roadmap/<arc>` (allowlisted files plus a sha256 manifest of them, `schema:
roadmap/1.0`, event high-water mark; the snapshot tree must match its own manifest), so no
PR diff contains them (arc 1's 1,219-file PR); nothing extra enters a candidate, so the tested head is the
published head. Raw evidence (stdout/stderr, lane output) stays out of the ref, which carries only its sha256
manifest; the evidence itself stays in the run dir. An in-tree `.roadmap/` holding anything else is 0.x and
refused.

**The snapshot is the transitive closure of authoritative records (G6, H6).** From facts and intents it
collects every kept input a `plan-applied` or payload names (plan, specs, ledger, sidecars, obligations, vision,
`revision.json`, and the corpus guide, pin and pinned files, the Phase-0 record and its issue capture); every
checkpoint's kept issue capture and every pack review's kept inputs; every spec a `spec.patch` produced; the spec bytes each `dispatch` and `judgment-inputs` fact
names; the `routingProvenance` of every `routingRev` (§4); `start.json`; every witness record a `witnessed` fact
names; every consumed judgment `result.json` and `reads.json`; needs-user records and acks; and evidence
manifests. `verifySnapshot` checks every item's hash against the record naming it, and the ref alone restores a
deleted run dir to the same fold and `status`. A **terminal snapshot** follows `arc-completed`, including when
close-out had nothing to change; recovery republishes it when the ref lags (G8).

| Artifact | Owner | Location | Mutability | Published to |
|---|---|---|---|---|
| Plan (units, edges, routing, limits), specs | executor via revisions (§2.6) | run dir | revisioned | ref |
| Vision (V-n) | architect via `apply` only | `.roadmap/vision.json` (an `architecture-doc` arc: beside the plan), kept in the run dir; the vision doc in the corpus | revisioned; ids never reused | tree, ref |
| Corpus (guide, documents) | architect, in session | `.roadmap/corpus.md`; the guide's source (same-repo, other-repo, checkout) | git commits outside the arc | tree (same-repo) |
| Corpus pin | architect via `corpus pin`; re-pinned via `apply` | beside the plan; kept in the run dir with the guide and files | revisioned | ref |
| Phase-0 record, its issue capture | architect | beside the plan; kept in the run dir | revisioned | ref |
| Pack-review inputs | executor | run dir | write-once | ref |
| Corpus amendments | executor (facts) | run dir | append-only | ref |
| Brief ack log | CLI | `$(git-common-dir)/roadmap/acks/` | write-once | — |
| Contracts, architecture doc | executor via publication | product tree | blob-SHA revisions | tree |
| `config.json` | architect | `.roadmap/` | git commits outside the arc | tree |
| C-nn ledger | executor via `rule` (executor-owned after `start`) | run dir | append-only, supersede | tree (`constraints.md`), ref |
| Obligations (I-nn), census, arc lanes, impact mapping | executor; architect via `apply`, checkpoint via bundles | run dir | revisioned | tree (`invariants.md`, with the rules registry), ref |
| Debt (B-n) | executor; dispositions by the Phase-0 record | run dir | append-only | tree (`debt.md`), ref |
| Observations, witness records, findings, divergences, log, dossiers, `result.json` | executor | run dir | append-only / write-once | ref |
| State, events, queue, `needs-user` | executor | run dir | append-only / write-once | — (high-water mark in ref) |
| Raw evidence | executor | run dir | write-once; `roadmap gc` once the arc is sealed | ref (sha256 manifest only) |
| Host lock and metadata, residual index | executor, supervisor | `/var/tmp/roadmap/` | `link()` claim; append + disposition; compacted at `start` | — |
| `skill-feedback.md` | architect | outside the product repo | hand-written | — |

**Close-out publication (A8).** At completion one docs publication (§2.6) retires rulings, renders the final
`invariants.md`, and runs every arc lane. `complete` requires it, or that it had nothing to change; reuse is keyed
by tree. Being docs-only, it covers its own edge (§2.5).

**Growth across arcs.**

| Control | Rule |
|---|---|
| Ruling retirement | Arc-lifetime and superseded rulings leave the rendered `constraints.md` in the close-out publication; the ref keeps them. |
| Re-derivation | Obligations are re-derived from the target at every Phase 0 and diffed by I-nn, and in a corpus arc by census (§2.8). |
| Dismissal lifetime | Finding dismissals are arc-scoped. |
| Residue compaction at `start` | Run by the supervisor after its claim. A disposed pair is dropped only when no arc's resource fold still holds its instance (H1): `cleanup-failed`, or `cleaning` under a retry or sweep holder, including the window between the `cleaned` disposition and the release. Retention is never derived from open intents alone. Every arc's own-arc keys' log is folded read-only; an arc whose log is unreadable retains all its keys. Written as tmp, `link` of the archive, `rename`; the chain continues. |
| `roadmap gc` | Claims the host lock and prunes only **sealed** arcs (§2.10; A20, H5): the log's last mutation fact is `arc-completed`, no queued or pending command, the completion head is reachable from the integration ref, and `refs/roadmap/<arc>` verifies at its high-water. It deletes only after that verification (G6): raw evidence, then run dirs beyond the last K (via a `.gc-deleting` rename), then host generation files beyond K and archives no longer retained. |
| Event-log compaction | Deferred (LR-e, §8); `status.host.log {bytes, events, foldMs}` reports the growth. |

**Debt across arcs (M4a).** A corpus arc banks debt (its Phase 0 dispositions the ledger). A debt item `B-n` (global, stable) records its origin arc, a closed `bankReason`
(`gate-note`: a gate note on an approved attempt, banked after the approval; `finding-deferred`: a P2 or P3
finding with no obligation that a checkpoint defers), `what`, its unit, a disposition history and a state
`open | promoted | resolved`. One `debtKey` over `{unit, bankReason, normalizedWhat}` dedupes it. Directive
overflow never banks: every directive reaches the fix round. Obligation-affecting items are findings, never debt.
`debt.md` is rendered by code (a human list plus the `json roadmap-debt` block) and published with any docs
publication whose rendering changed, and at close-out. Phase 0 dispositions every open item in the Phase-0 record
(`promote{unit}`, the one link between the item and the unit; `keep{reason}`; `resolve{ruling}`), or `start` refuses
(`debt-undispositioned`); an item kept in each of the two previous arcs needs a `P-n` question bearing on it
(`debt-kept-twice-unasked`). A disposition changes only through a `phase0` `apply` edit; there is no debt
command.

### 2.10 Arc states

`run.state` is the first that holds:

- **`complete`**: every in-scope unit merged, cut or waived by ruling; every non-exempt obligation discharged
  on the current head, split parents per the transition table (§2.8); no blocking `needs-user` unacknowledged
  (non-blocking items do not block); no pending command; no lens in L with an outstanding range, no owed audit,
  and the latest generation quiescent under the current vision; the close-out publication done, or nothing to
  change; no own-arc residue. Then `arc-completed{planRev, head, highWater, units}` and the terminal snapshot
  (§2.9). **Completion (A20)** is **active** while the plan rev and the integration head are unchanged (used by
  resume and `status`); an admitting `apply` or a reopen invalidates it. It is **sealed** (used by `gc`) when its
  verified head is still in the integration history and its own log and queue hold no later work; head equality
  is not required. An arc without the holistic layer completes on M2's predicate and also records
  `arc-completed` and the terminal snapshot, so `gc` can seal it (lead ruling 2026-09-30).
- **`needs-user`**: an unacknowledged blocking `needs-user` item.
- **`blocked`** (a `status` `run.state` since M2): nothing can dispatch while in-scope work remains (parked,
  excluded by `run-only`, behind an unresolved contingent edge, or behind a dead dependency awaiting `cut` or
  re-entry); parked in-scope work is never `complete`.
- **`draining`**: latched by `close-admissions` or plan drain, reopened only by an
  architect `admit`; closure applies at the single minting point to every automatic admission and re-entry path
  (debt, checkpoint admits, repair units): a checkpoint admit becomes a `bundle-request`, the others `needs-user`
  requests.
- **`running`**: otherwise.

### 2.11 Chaining

A session runs arcs back to back toward the vision, each a stacked branch and PR, and stops at a bound the
owner sets (owner rulings OR-Q19/20).

- **K.** `.roadmap/config.json` `chain.k`, asked once at bootstrap and committed with the bootstrap commit. The
  architect may suggest a new K, never write one. A start is acked when no chained start lies between it and the
  latest committed brief ack (the bootstrap arc counts as acked); `chain-invalid{limit}` refuses a start that would
  put more than K unacked starts since that ack, and `k-unset` a chained start with no K.
- **Chain state** has no mutable file. One read-only derivation serves `phase0 check`, `status`, `brief` and
  `chain status`: arcs from the plans in
  `refs/roadmap/*` (each `plan.chain.previousArc`), K from config, acks from the write-once ack log (§2), PRs from
  the forge. `plan.chain {previousArc, previousHead}` is fixed at revision 1 (`chain-immutable`).
- **Stacked arcs.** Arc N+1's integration branch is cut from arc N's `arc-completed` head. The between-arc commit
  (corpus amendments for a same-repo corpus, `.roadmap/{vision.json, corpus.md, config.json}`) is the first commit
  on that head and is arc N+1's baseline, so it shows in PR N+1 (owner-accepted, OR-L7). `chain-invalid{baseline}`
  refuses, in order: `previousHead` not the previous arc's `arc-completed` head in its verified ref; a baseline with
  more than one parent; a parent other than `previousHead`; a commit touching anything but those `.roadmap/` files
  and same-repo corpus paths. So `previousHead..baseline` is exactly one non-merge commit.
  `previous-incomplete` refuses when the previous arc's completion is neither active nor sealed.
- **PRs.** `roadmap pr` pushes the arc branch with an explicit lease (never to `main`) and opens or finds its PR:
  PR 1 targets `main`, PR N+1 targets arc N's branch. The body lists the amendments derived from the arc and states
  that the stack merges with merge commits; `roadmap pr` re-targets a PR whose base merged and flags a squash-merged
  base as needs-rebase in the brief. Nothing merges `main`: the owner merges the stack.
- **One arc per host.** Arc N's executor exits at completion before arc N+1 starts (host lock, §2).
- **Stop.** The session stops at `chain-invalid{limit}` or when the vision is silent: no `sliceCandidates`
  (§3 Phase 0) the architect can justify from active clauses.

## 3. What carries verbatim

Proven in arc 1 or by a named incident; ported as code, not prose.

- **Phase 0**: decomposition, frozen contracts + conventions contract, `scopeAllow`, contract↔code cross-check
  (Codex), design authorities, edge classification, spec requirements (as `spec.json`), self-validation,
  `## Direction`, fidelity audit, C-nn ledger, ≤5 ranked questions, "units build from commits", the plan-pack
  review (never rules) — now also the vision (clauses `V-n`, its playback confirmation reference) and obligation
  extraction (witnesses, `deliveredBy`, proof judgments, impact mapping, cut line), cross-checked in session by a
  second subagent. **M4a:** Phase 0 runs in the architect's session with subagent fan-out: corpus intake and
  curation by tier (§2.8), rules blocks, the census, ranked `P-n` questions, debt and amendment dispositions,
  issue intake (one outcome per captured issue, §4 Issue mode), plan and specs, then `corpus pin` and
  `roadmap phase0 check` until green. `phase0 check` is read-only and deterministic and shares its rows with
  `start`: pin re-derivation and `T-n` discipline, corpus overlap, census, obligation rules resolved, debt
  dispositions and `P-n` allocation, amendment dispositions, intake coverage against the kept capture, vision
  confirmed, issue policy trusted, chain (§2.11), `tree-uncommitted`. It reports `sliceCandidates` (active world
  clauses whose census rules are not all held on the baseline). **Pack review** is the executor job `review-<n>`,
  role `packReview` on seat `arc` (frontier), corpus arcs only: it reads plan, specs, obligations with census, the
  rules index, the Phase-0 record and the vision, from inputs kept before spawn. Before the first admission,
  admission requires a completed review whose inputs hash to the current required-review key, with its blocking
  `pack-review` item acked or absent; an `apply` changing any input requires a new review, which supersedes the
  earlier item. None runs after the first admission. The architect adjudicates each finding.
- **Ledgers**: C-nn, obligations, debt + closed-set `bankReason` (deduped by `debtKey`, §2.9),
  architect log, `escalations.jsonl`, `degradations.jsonl` (host-fact kinds only), quarantine dossiers,
  `skill-feedback.md` never a product-repo issue.
- **Anti-spiral core**: scope envelope pinned once at dispatch and never recomputed — changed only by a ruling;
  scope growth is a signal to the gate, never a licence; `maxBlockingFindings` overflow never banks (every
  directive reaches the fix round); correctness debt never banks through an approve; review is evidence to the gate, never directives to a fixer; FINDING_BAR,
  per-criterion grading, `unread`, the `<pasted_content>` sanitiser, "decision and justification, no reasoning
  field", "nobody will answer".
- **Judgment authority in code**: plan-check interrogates the spec; quarantine authority is a *seat* property
  (Opus-tier may redirect or escalate, never quarantine); closed `boundary` enum; three stops skip the cheap
  adjudicator; a null or refused judgment routes *up*, and a process fault parks rather than rules; the frontier
  gate cap ends in a closing round; later gate rounds re-check prior directives only (sf16); `feasible:false` is
  legal; a `contractMismatch` reaches the frontier only when the git path check corroborates it.
- **Git truth**: merged = second-parent reachability; integration only moves forward; **every diff is
  `merge-base(integrationTip, branch)..branch`, recomputed after any merge-in** (§3.5); worktree case from git
  exit codes; un-adopted commits never destroyed. Approval binds to `{unitCommit, specRev, contractRevs,
  rulingRevs, obligationRevs, corpus?}` (normative only; the architecture doc is a contract; `corpus` is the pin
  sha of a corpus arc; `obligationRevs` covers the
  selected, non-exempt obligations at the gated tip); any change invalidates the
  gate and the unit re-enters at the earliest invalidated stage. A moved tip means a fresh candidate, not a new
  gate.
- **Merge** (candidate-first): in the integration slot a candidate worktree makes a `--no-ff` merge onto the
  current tip, held on the named ref `refs/roadmap-run/<arc>/candidate/<unit>`. The **transient check** (code)
  runs first (G17, H15): a unit (`transientRules: 'm3'` in its dispatch record) may touch only its pinned scope and
  ruling-added paths, and no in-tree `.roadmap/` path (dev.5's rules were deleted with the pre-dev.6 layers in M4a
  step X0, §10); a docs candidate may touch only the rendered `.roadmap/` files and its ops' paths. A denylisted path (declared
  `evidenceGlobs`, worktree state dirs, lane outputs, ignored patterns, `__preview`, `__codex`) refuses the
  candidate as a scope-growth finding, fixed by a normal fix round. Suite and journey lanes run, graded by exit
  code, witness records and the held-claims brake; a suite that mutates the tree is refused; on green,
  integration fast-forwards (the publication critical section). On red integration never moves, suite resources
  are released, and the pre-merge tip is tested alone (an unexplained pre-existing red halts merges,
  `needs-user`; a known regression, background failures only, does not, §2.8); otherwise one fix round under an
  independent gate, then a new candidate; red again parks, branch kept. Conflicts take the same path. An approved
  empty diff is refused at gate. Prefix-collision guard that grandfathers existing ones.
- **Termination**: debt never mints a unit while `draining`, enforced at the single minting point; "no spec, no
  unit"; graph-mutation validation (§2.3); edge hygiene; fixed-point satisfiability; the critical-path brake (a
  lineage quarantined twice with dependents waiting → `needs-user`); the convergence bound (§2.8). Completion
  is §2.10's `complete`.
- **Outage taxonomy**: platform / backend / capacity / usage-limit, classified only from `turn.failed` and CLI
  error events, never from `command_execution` output (§3.1); an arc-wide breaker needs ≥2 distinct units or the
  health probe, except `usage-limit`, arc-wide on one event and operator-resumed (§2.2); a halt is never a
  verdict; `pending+parked` is the landing state from any stage.
- **Codex facts**: prompt on stdin; `-C <worktree>`; `--json`; `-o`; strict schema, every key required; `codex
  exec resume` only when the recorded cwd matches, one retry on a live-session collision; `danger-full-access`
  in the devcontainer.
- **Session integration review** at arc end, confirming the PR diff is product + living docs and reporting the
  transient-refusal count; the escalating agent's `notes` text is what reaches the user.

## 4. What adapts, and how

| Item | Change |
|---|---|
| Routing profiles | `role → seat → model class → {backend,model,effort}` (owner rulings 2026-09-26, arc-1 feedback items 7-9). Seats: build `{low,med,high}`; each judgment role `{low,med,high,escalation}`: a unit's risk is never `escalation`; route-ups and risk triggers move a judgment to it, and a judgment already there that escalates parks (needs-user). Every layer names a **class** per seat, never a model: built-in profile < `.roadmap/config.json` `seats` (committed: set once per repo) < `plan.config` < the per-unit layer `unit.routing` (set by the `route` edit class or `steer --class`). The judgment roles `lens`, `checkpoint` and `packReview` sit on seat `arc`: lens → frontier, checkpoint → summit, packReview → frontier. Every `plan-applied` records `routingProvenance {profile, repoConfig {seats, classes}, planLayer, unitLayers}` for its `routingRev`, so reconstruction never re-reads a live config (G16, H7). Classes `efficient | frontier | summit` bind to triples in one place, the class catalogue in code, per profile (`efficient` → Luna medium under `default`, Sonnet 5.5 medium under `claude-only`; `frontier` → Opus 5.5 medium, `summit` → Opus 5.5 xhigh in both profiles, OR-Q17). There is one catalogue and no routing generations: a catalogue change applies retroactively to every revision, adopted arcs included, and by-model spend for past revisions is attributed to the current bindings (OR-L3). Fable 5.1 stays in the model catalogue, reachable only by a repo rebind; `.roadmap/config.json` `classes` may rebind a class for the repo, and is the only place outside code a model is named (a plan cannot rebind). The resolved triples are hashed into `routingRev`, so a rebind changes it like a seat edit. Only supported triples (a prompt module exists) are selectable. Codex judgment triples are `unsupported` until a read-only Codex judgment profile exists: judgment roles resolve to Claude in both profiles, and a seat that names a Codex model for a judgment role (D2's sol digest) resolves to the Claude low judgment seat until then (owner ruling, 2026-09-25). Claude triples carry an effort, passed as `claude --effort <low|medium|high|xhigh|max>` on judgment and build calls (calls load no user settings, so nothing else sets it; Opus 5.5's own default is `medium`); `frontier` binds `medium`, `summit` `xhigh`, Sonnet 5.5's `efficient` `medium` (Anthropic's starting point for agentic coding). Judgment-seat effort is part of the ruler: nothing changes it at run time. Per-invocation launch instructions (`launch.json`) carry the backend argv, which necessarily names a model; they are launch inputs in the run dir, not state, and are the only executor-written files outside the `state.no-model-ids` scope (event log, state cache, needs-user, receipts, residues, the snapshot ref, `status` output and meter facts). Model ids are pinned: `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `gpt-5.6-luna`, `gpt-5.6-sol`. Sonnet 5.5 holds the implementer class only (build inherits the Opus brief; no judgment prompt); Haiku holds no seat. **`default`**: efficient builds low/med, frontier builds high; frontier plan-checks and gates every risk tier and summit holds both escalation seats (owner ruling 2026-09-26: independence is a clean context, not a different model; the stronger model is spent where a judgment escalates); plus frontier lenses and pack review, summit checkpoint. **`claude-only`** (one config line; no Codex dependency with the built-in bindings; owner ruling 2026-09-29): the same seats, with efficient bound to Sonnet 5.5, so Sonnet builds low/med and frontier builds high; judgment as in `default`; summit holds the checkpoint and consult seats; Opus digest for med/high; frontier lenses and pack review. `route` may set any class at any seat. A routing change mid-unit (lead ruling 2026-09-26): a judgment seat may change freely (every judgment is a fresh session); the implementer's backend or model may not once its build started (its session resumes), so such a unit parks with a needs-user (`routing-changed`) and any other is re-pinned under the new `routingRev`; an effort-only change of a started implementer (same `{backend, model}`) re-pins and resumes the session with the new effort, never `routing-changed` (OR-L3), and adding a role parks nothing; once the architect restores that seat's routing (the plan's layer through `apply`), `resume <unit>` re-pins the parked unit and re-enters it at the stage it parked at, no spec edit. A routing `apply` re-resolves the routing in force at once; a newly seated backend passes its smoke first. Its preflight skips the Codex smoke and asserts no role resolves to Codex. Phase-0 risk is a floor plan-check may raise, never lower; runtime triggers (contract path, mismatch, gap, scope growth) promote in code. |
| Prompt–model coupling | Every prompt is keyed by `(role, modelId)`: one module per pair (`prompts/<role>/<modelId>.ts`) citing the vendor prompting guide it follows and a reviewed date. Model ids are a closed union and each role's table is `Record<ModelId, Prompt>`: a new model fails compilation until every role has its prompt or a dated `inheritsFrom: <modelId>` (reviewed reuse, never implicit). Prompts are pure functions of revisioned inputs; a test asserts prompt fields == schema `required`. Precedent: 0.20's Opus 5.5 patterns. The judgment roles `lens` and `checkpoint` (LR-d) are prompt modules like any other, run in fresh sessions under the judgment profile, metered, recorded as role + `routingRev`, with closed output schemas: lens/Opus is new (four kinds), lens/Fable inherits Opus; checkpoint/Fable is new, checkpoint/Opus inherits Fable; Sonnet and Codex models are unsupported for both. Lens and checkpoint prompts open with the full vision. The checkpoint's system text states that it may weaken or amend citing active `V-n` plus evidence; that where the vision does not anticipate a situation it takes the most optimistic reading that fits and records it in `interpretations`; and that for owner-only acts, nested ones included, it may only `request` (§2.8). M4a (Opus 5.5 guide): `packReview` is a judgment prompt module like the others, ported from the former Phase-0 review template; build modules carry a standing instruction for unattended work (nobody answers mid-task: decide, record the decision in `decisions.json`, keep going); issues reach the checkpoint as `<pasted_content id>` blocks through the existing sanitiser, framed as trusted data it may act on. Fan-out in the skill uses elapsed-time signals: subagents report elapsed time and the architect re-plans a branch over budget. |
| Actors are roles, never models | (owner ruling 2026-09-25) Model ids appear only in routing configuration — the class catalogue and a repo's `.roadmap/config.json` class rebinds; profiles, `plan.config.routing` and per-unit `route` name classes (owner ruling 2026-09-26) — which is revisioned. Every record the executor writes (events, `result.json`, meter facts, ledgers, rulings, dossiers, the architect log, `status`) names the **role** an actor filled plus the `routingRev` in force, never a model id; the model is derivable from the routing revision when needed and `status.spend` is rendered by role (by-model totals are derived at render time). Prompt modules are keyed by model because they are code, not state. Rationale: models change month to month; state, ledgers and rulings must not rot with them. Plan-load validation and the unit test `state.no-model-ids` reject any executor-written record containing a known model id. |
| Independence | A clean context, not a different model (owner, 2026-09-25): every judgment role (plan-check, digest, gate, consult, lenses, checkpoint, pack review) runs in a fresh session under the judgment profile, inputs snapshotted by revision, no implementer transcript. Checked in code at plan load and every judgment dispatch: a judgment invocation refuses `resume` and never reuses an implementer, steer or escalation session. The same model may implement and judge. |
| Claude profiles | **judgment** (read-only; no settings, CLAUDE.md, MCP, skills or auto-memory: a clean context) and **implementer** (write tools in the unit worktree, commit-before-report; the repo's project settings and CLAUDE.md, no MCP, skills or auto-memory); both run `--output-format stream-json`, yield `result.json` and are metered. |
| Verification | The executor runs spec lanes serially, verbatim, under locks, fast before estate, in a clean worktree at the salvage SHA, evidence keyed by invocation. No verifier role; `judgeVerify` provenance is always `spec`. |
| Lanes | Per §2.7; `env` prerequisites probed at plan load (missing → `spec-lane-unrunnable`, park, never a strike — sf16); `evidenceGlobs` snapshotted before teardown and handed to fix rounds (§3.21's cause was in `caller.stderr`). Every lane's gitignored writes are counted into a census the gate's ledger shows (undeclared output of a passing lane shows as `not-declared`); a lane that does not pass also gets its undeclared ignored output captured by default, capped, without build output, default secret excludes or the lane's `evidenceExcludes`, and handed to its fix round (executor/SCHEMAS.md "Lane evidence"). `evidenceGlobs` and `evidenceExcludes` may change at the unit's current spec revision while it is in flight: they are outside the approval fingerprint and read at the next lanes attempt; nothing else in a spec may. |
| Implementer boundaries | Implementers run **fast** lanes only, the stage reserving their declared named resources throughout. **Estate** lanes are executor-only. Before release the occupancy probe runs: an undeclared estate with the unit's label is torn down; unlabelled → park, `needs-user` (§3.15, §3.16, §3.22). |
| Host signatures | Code table (golangci lock, kind boot under load, `EAGAIN`, `ENOSPC`); host sampled at lane start and end (busy: `load1/cpus ≥ 1.0` or MemAvailable < 5%; clear < 0.7). A signature red with contemporaneous busy-host evidence gets one same-SHA rerun once the host is clear (an in-stage wait of at most 30 min, cancellable, holding nothing); the original result is kept. Green then is a pass; red again on a healthy host is a product failure. A signature without host evidence is `blocked`, uncharged. |
| Flakes | An unexpected red lane gets one same-SHA diagnostic rerun before any code change (the host retry, where it applies); both kept; red-then-green reads as red with `flaky: true`, charged as red, so it never approves. |
| Blocks | A retryable park; never quarantines (sf16; log w35). The same unit and target again within 6 h of a recovery → operator park (`env-blocked`); two units on one target within 1 h trip its breaker, which blocks admission of the stages needing it, with one non-blocking `env-blocked` item. |
| Occupancy | Inside the reservation: a probe mirroring the lane's preflight, then declared teardown; decided before any budget is charged (§3.12). Failed teardown → `cleanup-failed` (§2.2, §3.4). |
| Process lifecycle | Every executor subprocess (backend, lane, probe, teardown) runs as a workload under a runner, which is the controller and never a workload member. The runner carries `ROADMAP_ROLE=runner`; the workload carries `ROADMAP_ROLE=workload`, `ROADMAP_OP` and `ROADMAP_INV`. Workload membership is every process whose environment has `ROADMAP_INV=<inv>` or whose session id equals the child's, identified by (pid, start time), excluding the runner; the runner is never signalled by its own kill and exits itself after writing its terminal files. **Session mode** is the containment 1.0 ships with: a `setsid` session and `/proc` scan; kill = stop members → rescan until the set is stable → TERM → KILL → rescan until empty; no next stage while non-empty (w39). Its guarantee is narrowed and stated in `status.host`: a descendant that calls `setsid()` and execs with a cleared environment escapes, caught only by the verification-tree assertion and the occupancy probe. **cgroup mode** (a cgroup v2 leaf per invocation under a delegated subtree, runner in `runner/`, workload in `work/`, entry fail-closed, kill = freeze → TERM → `cgroup.kill` → empty) is experimental: not selectable until a real-kernel gate passes on another host. Kill reasons: `deadline \| stall \| pause \| stop \| recovery \| external-unknown`. A lane runs under the runner's stall watchdog (no member CPU time, no output, no member started or ended for 10 min → `stall`, a red verdict: the fix round reads its output) and a 6 h deadline that only backstops a busy loop; a slow suite that is working is never cut short. |
| Fix rounds | Resume the build session with evidence dirs (a session never moves across seats: a build whose implementer seat a risk raise moved starts fresh on the kept worktree); window from the unit's measured lane series (§3.2, §3.8). A fix round is **stalled** when the verification after it fails a lane that also failed before it, or the gate revises again; after the first stalled round (N = 1), while `chargeableFailures < CHARGEABLE_BOUND`, the next round runs cold on the `build.high` seat (D4), `implementer-escalated` journaled before that round's implementer seat is selected; no escalation when `build.<risk>` already binds `build.high`'s triple; no fresh final round; `harnessStop` never feeds a round. |
| Plan-check | Redirects are internal revisioned patches (§2.7); only the patched spec is graded; may set an estate budget (D8). Reads a detached checkout of the integration tip (its cwd) and of the unit branch when one exists; host facts only from the executor's resolved lane programs or the checkouts. Checks spec coherence and buildability, not the implementation: defects in code already on the unit branch go to the build and gate as notes, never a redirect on their own. A redirect may add cites, never remove one (arc-1 feedback items 3, 12, 21, 26). Under the holistic layer it receives the vision as read-only context, marked non-directive, and its output gains `visionConflict [{clauses, note}]`: each entry becomes a P3 finding for the next checkpoint, never a redirect by itself (R17, §2.8). |
| Gate inputs | Spec rendering, cited contracts and C-nn in full with a one-line index of the rest (read on demand), the target (an `architecture-doc` arc: the architecture doc or its owner-approved digest; a corpus arc: the rules index and the materialised pin without the vision doc, §2.8), merge-base diff, lane ledger, evidence, witness records, digest, scope envelope + growth, Direction, the approving plan-check's notes and the spec's `obligations`; graded against the contract, not a paraphrase (w34). The gate never receives the vision: it grades spec and contracts, and the pinned scope holds (R17). Its `judgment-inputs` capture takes the revision fence (§2.6). "Every spec lane ran verbatim" is a code assertion; `reportLostEver`, `LANE_BAR` go. |
| Round handoff | A judgment's round N+1 on the same unit (plan-check after its applied redirect, gate after its revise) is a fresh session that inherits round N's conclusions, never its session: the prior patch or directives and findings, the premises it relied on (claim + file:line evidence, part of every judgment's output), and the delta since (fix paths; premise files whose blobs changed). It rules each prior item resolved or not, reviews the delta for regressions, re-verifies only changed premises (overturning any with evidence), and raises a new finding on unchanged material only when it affects correctness or stated acceptance (arc-1 feedback items 25, 29). Judges report only what affects correctness or stated acceptance, verify only the premises a decision relies on, and batch reads (items 15, 28c). |
| Unit policy | Every build prompt carries an executor-owned policy that overrides the repository's agent-instruction files: no cloud resources or CLIs, no sudo or system package installs, no killing processes the unit did not start, no network beyond the lanes' needs (arc-1 feedback item 20). The unit policy is a prompt: with containment, it is what bounds an implementer build. The owner-only check (§2.8) governs checkpoint revisions only (H10); code-level enforcement beyond these is backlog (§8). |
| Consults, findings | The consult seat reads evidence, spec, diff and C-nn directly; the Sonnet dossier goes. Findings dedupe by finding+cause with a disposition; a dismissed one is not re-raised without new evidence (sf16, w35–37). |
| Wave-tail roles | → §2.5 + §2.8; an operator-design park goes to the checkpoint for a respec, re-entry or cut first, a second on the same lineage → `respec-second` (OR-Q1); explorer and reconciler are backlog (§8). |
| Re-entry | `reenter` replaces `adopt`. A preparation is the durable stage `prepare`: `worktree.create` (branch `roadmap/<arc>/<new>` at the old tip), `dispatch`, `mergein.prepare` of integration (§3.23), `evidence.snapshot` of the prepared worktree; outcomes `clean-plan-check \| clean-build \| clean-verify \| conflicted`. Budgets, attempts, counters (`chargeableFailures` reset only by a ruled `reset`), risk floor, dispositions and the lineage's original scope envelope **inherit**; approvals and evidence are **invalidated**; sessions do not inherit; the old unit becomes `superseded`. A conflicted preparation keeps `MERGE_HEAD` (the M1 conflict precedent) and enters at a `resolve` round in a fresh session. Replacement edges, cycle-checked at `apply`, activate at the first `prepare` outcome that is not a park. `retire` cites the latest snapshot of the unit's `evidence` or `prepare` stage. Resets need a ruling. |
| Plan-load validation | Every `edge.contract` path exists (sf18); `argv[0]` and env prerequisites resolve for spec lanes and `must-hold` arc lanes (`future` ones at activation); no request over capacity; worktree root not on tmpfs; routing supported, judgment roles on the judgment profile; every obligation not held on the base names `deliveredBy`; every arc lane declares a supported reporter (R1), and a `node-test` lane does not set `NODE_OPTIONS`; the plan target is one closed variant (§2.8); no plan contract or unit scope overlaps a same-repo corpus file set. |
| Measurement | Per lane per invocation `{start, end, exitCode}`, per unit `{dispatchedAt, terminalAt, mergeSha, mergedAt}`, every upper-tier call's tokens keyed by `{role, routingRev}`, every escalation, checkpoint lane duration and per-finding instrumentation (§2.8). Arc 1 recorded almost none of this; defaults are marked unmeasured and re-derived after arc 2. |
| State | The event log is authoritative and write-ahead; its envelope is frozen before M1: every operation has an arc-scoped id, parent command or stage id, invocation ordinal, expected inputs and postconditions; op kinds include `mergein.prepare` (integration merged into the unit branch in its worktree; postcondition `clean-merged | conflicted | completed`) and `evidence.snapshot` (a completion manifest of paths and sha256, required before teardown or retire); a complete durable intent precedes every act; `state.json` is derived (`atomic()`). A truncated final record is discarded; earlier corruption → `needs-user`. Every operation kind (resource states, spawns, commands, publications — the latter by second-parent test or activation postcondition) has a reconstruction rule pinned by a crash-boundary fixture. Deadlines are absolute; attempts monotonic across re-entry; run state reaches git only via `refs/roadmap/<arc>`. |
| Invocation recovery | Per open spawn intent: inspect completed artifacts (a validated `result.json`; else `exit.json`, re-running the adapter) and tree effects → find the live workload by `ROADMAP_INV=<invocation id>` (the runner excluded; a scan by `ROADMAP_OP` also kills stray earlier ordinals) and adopt it through its live runner, or, with the runner dead, terminate it and classify the invocation `lost` → only then decide whether to invoke again. A valid `result.json` with live workload members is not quiescent: kill, then certify. Completed-but-unrecorded work is salvaged and re-verified, never treated as not started. Retries get a new invocation id; the original deadline holds. |
| Issue mode, preview | Inbound only (D6; M4a): `roadmap:bug` / `roadmap:feedback` issues read in code at Phase 0 and checkpoints; the outbound projection is deferred to 1.1. A forge module calls `gh` like `git` (synchronous, with a timeout, a read). Each capture resolves the repo identity `{host, owner, name}` once and passes it to every call. **Trust** is the repository's policy from one GraphQL query: `PRIVATE`, `COLLABORATORS_ONLY` issue creation, or issues disabled (no intake) is trusted; anything else refuses `start` and `roadmap issues` with `issue-policy-untrusted{visibility, policy}` (fixed by restricting issue creation or disabling issues), and at a checkpoint capture raises one blocking `issue-policy-untrusted` needs-user that holds admission arc-wide and the checkpoint uncaptured until acked, then re-queries. There is no confirmation and nothing in config. Comments are kept only from `OWNER`, `MEMBER`, `COLLABORATOR` or a kept issue's author; pull-request entries are dropped and counted. The result is one canonical issue capture (sorted, no clock), kept content-addressed at Phase 0 (named by the Phase-0 record) and before each `checkpoint-inputs`; intake is checked against the kept capture, never a live re-fetch. Issues under a trusted policy are trusted content: rendered as `<pasted_content>` data, acted on like any other evidence. Every captured `IssueId` gets exactly one outcome: `finding`, `amendment`, `acted` or `none`. A capture failure at a checkpoint is non-fatal (`issues: unavailable{reason}`). **Preview** is deferred to 1.1 (§8). |
| Codex-native driver | Dropped; its fingerprint, candidate→suite→ff, `monotonic()`, "never reset a dirty worktree", marker-exact gh sync and plan-pack review (now the `packReview` job, §3) survive. |
| Refusals | Stop reason → `refusal`, routed up. |

**Salvage** classifies staged, unstaged, untracked and ignored content separately and commits an explicit
approved path set (inside the pinned scope; never `.roadmap/`, declared evidence/state or ignored paths) through
a controlled temporary index, so pre-staged content cannot ride along; rejected content is preserved outside the
tree; unmerged entries or a failed commit → park, tree preserved. Verification runs in a clean worktree at the
salvage SHA; a dirty verification tree is never certified under a SHA.

## 5. What drops, and the root cause it leaves behind

- **Dynamic Workflows as host** and its `.mjs` scripts: no shell, no background, a turn budget, position-based
  resume.
- **The courier tier** (launch/watch/report steering, closed command lists, `cd` guards, `STRICT`, `rc=`
  wrappers, `READ_CHUNK`, `RELAY_BAR`, spec-write, merge, dossier, census and `gh` couriers): models did what
  code does exactly; 1,630 courier calls, the largest failure source, none needing judgment (Obs §6).
- **Verifier-as-agent**: a model ran the lanes; §3.13, §3.18–3.20 go with it.
- **Pidfile / exit-code-file / TERM-trap / zombie-preflight apparatus**: processes launched through a model's
  Bash tool. Cgroups (or sessions and the `/proc` scan), runners and operation intents replace it.
- **Waves**, the tier ladder, `maxWavesPerRun`, the 1000-call guard, wave-keyed dirs, `dispatchOnly` as a knob:
  boundaries were the only place a workflow could wake judgment (Obs §4.5).
- **The dual-driver protocol** (tokens, `protocol.json`, AGENTS.md): two drivers. One host lock remains.
- **Text-grep outage detection**, the per-wave refusal probe, `codex-capacity`, `debtPending`: no error object
  or stop reason; waves.
- **The post-publication revert**: merge-then-test. Candidate-first never publishes red.
- **The spend cap**: withdrawn (D5).
- **Invariant 7 "workflows take no mid-run input"**: inverted; its corollary stays in SKILL.md.

## 6. Conflicts found by the distillation, and the ruling

1. **`claude -p` billing** → verified (§2); the preflight keeps probing. 2. **Waves** → dropped; wake only on
   `needs-user`; contingent edges resolve per edge.
3. **Invariant 8** — "feedback never steers" becomes **"feedback accumulates until a checkpoint; checkpoints
   steer"** (§2.8). Findings never reach a running stage; checkpoint acts apply at safe
   points (Obs §5).
4. **Resume vs fresh** → resume within a model, cold across ("defects surfaced one per round" when fresh).
   5. **Cross-family review** → independence is a fresh session, not a different model (§4). 6. **Cheap single
   gate for low risk** → a routing default, not arc evidence: one gate; no critique, digest or frontier gate.
7. **Rebase-before-verify** → merge-in, diff base recomputed. 8. **Locks by name only** → capacity added,
   all-or-none. 9. **Kill authority by model name** → a seat property. 10. **"2 blocks → quarantine"** →
   withdrawn. 11. **Adoption vs re-entry** → `reenter` inherits the lineage envelope.

## 7. Decisions for you (recommendation first)

- **D1 Language.** *TypeScript, `tsc` only, no bundler; `typescript` and `@types/node` are the only
  devDependencies; the runtime stays dependency-free.* Alternative: JSDoc + `tsc --checkJs`.
- **D2 Who implements high-risk units — decided 2026-09-25.** Luna builds low/med, **Opus 5.5 builds high**,
  sol plans and reviews. Since the owner rulings of 2026-09-26 and OR-Q17 (M4a), frontier (Opus 5.5 medium) gates
  every risk tier and summit (Opus 5.5 xhigh) holds the escalation seats. Astra held Phase 0 only (pack review,
  obligation cross-check) until M4a, which moved the pack review to the executor's `packReview` job and the
  cross-check to a second in-session subagent (§3). This is the `default` profile (§4); high-risk units spend the
  weekly limit by design, visibly (D5).
- **D3 Audit cadence N.** *N = 5 publications (unit, batch, and rule-with-contract-ops), plus §2.5's other triggers.*
- **D4 Fix-round escalation.** *Resume within a model; cold across models; no fresh final round; N = 1 (§4 Fix
  rounds).*
- **D5 Claude spend — decided 2026-09-25.** *Meter only; no cap (arc 1: ~3 upper-tier calls per merged unit).*
  Every upper-tier call records `{role, routingRev, unit, attempt, inputTokens, outputTokens}` or `usage:
  unavailable` with its reason (the model is derived from the routing revision); nothing brakes on it.
- **D6 Issue mode in 1.0 — decided 2026-09-25.** *Inbound only: `roadmap:bug` and `roadmap:feedback` are read at
  Phase 0 and checkpoints (M4a), trusted by forge policy (§4 Issue mode).* The outbound projection is deferred to 1.1.
- **D7 Worktree retention.** *Remove a merged unit's worktree only when clean, unowned and its evidence saved;
  keep parked and quarantined worktrees.*
- **D8 Estate budget per unit.** *Plan-check may set an estate-lane budget in minutes; exceeding it is a
  redirect, not a longer window* (the launcher lineage's 90-minute lane lists, §3.8).

## 8. Backlog (deferred, not dropped)

Contract-parallel builds against stubs; `unit.kind` stage library; plan-pack prototype scoring; Fable red-team
of its own decomposition; seam-test unit first; how often plan-check acts on the critique; gate audit sample
yield; cross-model `codex resume`; an in-session `Agent` backend (only if headless billing changes);
cache-aligned preambles; runtime explorer and reconciler as cadence roles; a third backend; mechanical
spec-quality checks; several executors per
host; multi-UID hosts; reboot recovery; a formal ruling language.

Deferred from M3: `explore` (A11); `--adversarial` is withdrawn, not deferred (a unit routing layer expresses
it, A12); the spec's `contractRequests` and `owedAfterMerge` are withdrawn in M4a, not deferred; lens
parallelism (lenses run serially); code-level enforcement of implementer boundaries beyond the unit policy and
containment (H10's stated limit; trigger: an implementer acting outside the sandbox); event-log compaction
(LR-e; trigger: a log over 50 MB or a fold over 2 s); glob-overlap precision in the impact mapping; more witness
reporters and a real-`go` capture; the read-only Codex judgment profile.

Deferred from M4a: preview (1.1; the architect starts the app from the integration branch on request); the flow
series (M4b, derived from M4a arcs' `events.jsonl` in their refs; M4a records nothing new for it beyond the
read-time `status.timings`).

## 9. Eval ladder

1. **parse** — `tsc` on the executor, adapters and prompt tables (a model lacking a role's prompt fails here).
2. **unit** — subprocess fakes: fake `codex exec` / `claude -p` that emit events, exit with a chosen code, hang
   past a deadline, fork a child that calls `setsid()`, or exit 0 having done nothing. Carried in spirit:
   outage-lifecycle, git-truth, codex-lane, exit-code rules, merge fences, evidence manifest, shared-red and
   resource semantics, prompt-hygiene, portable-budgets, phase0-templates. Dropped: persist, launch-pack,
   shared-consts, wave routing, knob pins. **New**, with real processes and git: a crash at every write-ahead
   boundary of every operation kind asserting the exact replay (torn tail, completed and live invocations, racing
   takeover, executor SIGKILL with no session), through the one seam `crashPoint(label)` with the selector
   a trigger that may name a unit (`<label>[@<unit>]:<n>`, the trigger file's optional `unit`), counted per (label, unit), each concurrent crash asserting which unit's op
   it hit and the peer's state; new-session escape; lock order incl. the slot; foreign residues;
   known vs unexplained base red; transient-check refusals; a queued `rule` abandoning a candidate; control vs
   mutation timing; a steer or escalation session never becoming a judge session; re-entry retry; merged-target
   refusal; `usage: unavailable`; routing layers and refusals, `claude-only` resolving no Codex role; pre-staged
   salvage; dirty verification tree; the §3.1 fixture (`Capacity: 2Gi` → no halt); witness records; lane reuse;
   the transition table; unmapped paths; future activation; repair batch; both audit-race orders; stale and
   partial bundles; `no-op`; the convergence bound; arc-state predicates. The upgrade test (an arc the previous
   release started, adopted) runs alone after the parallel suite: its park premise needs a calm host.
3. **targeted probe** — real calls: both Claude profiles and Codex fresh/resume against real schemas (M1 gate);
   since M4a also the `gh` read-only shapes (repo identity, GraphQL policy fields, REST issues with pull-request
   entries, comment author association) and a session resumed with a changed effort, for Claude and Codex.
4. **paid** — per-slice fixtures (§10), once per merged batch, offline in file mode, the M1 fixture also under
   `claude-only`; the issue fixture (D6) is part of `evals/m4a`. A property a model's output cannot be forced to
   show is asserted at the unit tier instead: M3's literal partial-bundle rejection is asserted by the fake fixture
   `evals-m3.fake`, and the paid run asserts stale-whole rejection (A18, G19).

**Delegated adjudication** (M4a acceptance, once; not a ladder rung) — a headless summit-class session role-plays the
synthetic owner and grades the M4a fixture's output against a rubric (readability, rules, collapsed restatements,
contradictions resolved or asked, stale text pruned, slice fit, witnesses that prove their claims). It reads the
vision, the raw and pinned corpus, the extraction, the plan and slice, a product snapshot and the witness evidence,
never the answer key; a transcript scan over tool arguments and results voids the verdict on any key access. The
lead adjudicates each finding; the PR is gated on that adjudication, not the verdict.

**The M4a fixture** (`evals/m4a`) runs a headless root-agent session, launched from a staged plugin copy without
`evals/` or `test/`, in a constrained environment (allowlisted env, empty forge and git config dirs, a fake `gh`
first on PATH, a local bare origin). Code plays the owner for K and slice acceptance; a frontier session answers
other questions only from the answer key's owner answers. Planted corpus defects are checked as postconditions on
the kept pin, census and Phase-0 record, never by file name. A canary snapshots the real forge's refs, issues,
PRs, comments, labels and releases before and after, and a transcript scan over tool arguments and results
fails the run on any answer-key or real-repository access.

**Supervision and run 10 (A-M4-26; OR-A3, OR-A2).** The root agent observes cheaply (status on every wake, at most one
read per 15 quiet minutes between wakes) and wakes only on actionable events (a needs-user item, a terminal state,
changed constraints, a measured stall); it operates only through the sanctioned levers and never patches the plugin or
a run dir. Each intervention (a lever used on its own initiative) is one entry in the operator log
(`roadmap-inputs/skill-feedback.md`, outside the product repo); the fixture counts interventions per lever as an
executor-quality metric. The fixture's turn cap is the session cap; it releases the host claim it leaves, restores a
scrambled tree on any exit, checks the arc's profile, records each arc's terminal seq and post-run activity, and
exports per-invocation cost with explicit unknowns. Run 10 runs once under `--profile claude-only`.

**Acceptance properties**, asserted by each slice as reached: lanes run by the executor verbatim,
graded by exit code and witness records; fix rounds get evidence dirs in continuous context; diffs are
merge-base after merge-in, and re-entry verifies against integration; gates judge in fresh sessions over a pinned
scope; no cleanup path discards branches or salvage; the published head is the tested head; a PR diff contains
product changes and living docs only; a final whole-tree audit and witnesses run after the last merge;
checkpoint acts pass through the same revisioned commands and candidate verification; every side effect is
code-owned.

## 10. Cutover

Hard cutover from 0.x only: 0.x state is refused (§2.9), not converted. Within 1.x an executor update adopts
an arc started on the previous release (arcs run for days, fixes land mid-run): record changes are additive with
read-time defaults, and the executor's `SCHEMAS.md` "Record evolution" holds the rule. `RATIONALE.md` is rewritten from the distillation
reports, keeping the incident record; the sibling skill and AGENTS.md are deleted. Schemas (event envelope,
result, spec, obligations, witness record) are documented before their first slice. Each slice ends at a green
ladder with its own runnable fixture:

- **M1 One serial unit, independently runnable.** Prompt modules per `(role, model)` and both routing profiles
  from the start; one unit through plan-check → build → salvage → lanes → gate → candidate merge, with exact
  recovery, supervisor, host lock, containment, transient check, snapshot ref, the minimal serial resource
  lifecycle (reservation, `cleanup-failed`, residual index), internal revisioned patching (M3's `patch-spec`),
  judgment session freshness, metering, `start`/`status`/`pause`/`resume`/`stop`, durable `needs-user`, a serial
  terminal predicate. Fixture: one redirect, one failed lane and its fix, a merge conflict, a red candidate, a
  crash at every boundary, both backend probes.
- **M2 DAG and resources.** DAG dispatch (legacy arcs kept dev.4's serial frontier until M4a), pools and `@cpu`, aging,
  retryable parks with probes, flake reruns and host signatures, D4 escalation, `reenter` and `cut` through
  `apply`, `resolve-edge`, `run-only`. The legacy-arc defaulting was scaffolding, deleted in M4a step X0. Fixture: no overlapping holders, bounded service for planned work, `cleanup-failed` survival, a
  conflicted re-entry, no duplicate writer after concurrent recovery.
- **M3 Holistic layer and revisioned commands** (lead ruling LR-a: this bullet, BACKLOG "M3", and from M2's
  deferrals `merge-in`, `route`, `limits`, `steer --class` and the `repair` origin; the Codex judgment profile,
  cgroup mode and everything M4a and M4b own are out). The vision record, obligations with the witness protocol and
  impact mapping, journey lanes, the held-claims brake with known regressions, findings, repair units and batch
  repair, mutant reproduction, the four lenses with coverage per required lens, the checkpoint with bundles,
  divergences, owner requests and brakes, arc states with active and sealed completion; the revision fence and
  payload-first activation, docs publications with preemption, close-out; `rule`, `reverse`, `steer`,
  `merge-in`, `audit`, `close-admissions`, and `route`, `limits`, obligation and vision edits through `apply`;
  the growth controls of §2.9 (ruling retirement, obligation re-derivation at Phase 0, dismissal arc lifetime,
  residue compaction at `start`, `roadmap gc`) and the snapshot closure. Version 1.0.0-dev.6 adopts dev.5 arcs:
  such an arc runs without a vision or the holistic layer, spends nothing new and completes on M2's predicate; `apply`
  may opt it in. The dev.5 defaulting (the live-ledger reader `rulingsFromLiveFile`, the legacy manifest reader,
  dev.5 routing reconstruction, dev.5 transient rules and the other read-time defaults BACKLOG listed) was
  scaffolding, deleted in M4a step X0. Fixture (one paid run, `--profile default`, obligations seeded by hand, lead ruling LR-f): the Node
  CLI `ledger`; vision V-1 (purpose: "bookkeepers reconcile a month in one command"), V-2 (non-negotiable:
  "money is never silently mis-rounded"), V-3 (tradeoff, rank 1: "clear errors over permissive input");
  obligations I-1 (future, serves V-1, delivered by `parse` and `report`), I-2 (must-hold, serves V-2), I-3
  (must-hold, "unknown commands exit 2", serves V-3); L = {invariants, vision}, audits every 2 publications,
  K = 1. The story: `parse` merges; `tidy` merges with `Math.round`, regressing I-2 unselected; the first audit
  runs while `report` merges and latches I-1, and code opens P1 F-1, re-witnessed on the new head; an
  architect `apply` makes the first bundle stale whole; its re-evaluation admits a repair citing V-2, which
  records a divergence whose digest the driver acknowledges; `convergence-bound` fires and is acknowledged; the
  repair merges and resolves F-1; a drift-only audit runs the vision lens and the checkpoint no-ops; the final
  audit runs both lenses of L and the checkpoint no-ops; the close-out publication is docs-only and covers its
  own edge; `arc-completed`, then the terminal snapshot. Honest judges may refuse the regression, so the paid
  story is branch-tolerant and records which branch it took: **R (regressed)**, the story above, or **P
  (prevented)**, where plan-check or the gate stops `tidy` upstream and a checkpoint disposes of it (a cut, a
  respec, a repair or replacement unit) with its divergences recorded, or **L (latent)** (paid run 9): `tidy`
  publishes with I-2's witness held on its tree, an audit's lenses find the defect the witness cannot see, and a
  checkpoint admits a repair that merges with I-2 held. Every branch runs to the end, and each must show the stale-whole rejection, the acknowledged digest and `convergence-bound`, every admitted unit
  merged with its obligation held, a drift audit, a final audit, close-out and completion. The literal merged
  regression → P1 → repair path stays asserted by the `evals-m3` fake. Not exercised in the paid run (reported): `rule`,
  `reverse`, `steer`, `merge-in`, reproduction, batch repair, the per-identity bound, `owner-request`,
  `draining`, real `go`, and the literal partial bundle.
- **M4a Convergence on a corpus** (lead ruling LR-a). The pinned corpus as the target with `T-n` rules, the
  census and corpus amendments (§2.8); the vision's corpus home with verified playback; `roadmap phase0 check`;
  the debt lifecycle (§2.9); the forge module with trusted issue intake (§4); the pack review as an executor job;
  `roadmap brief` (§2); chaining (§2.11); routing rebinding (§4); the M4a prompt notes; the full skill text
  (`SKILL.md` with Phase 0 in session, check-in, session end and chaining; `reference.md`; the vision skill);
  acceptance by the paid fixture `evals/m4a` and the delegated adjudication (§9). Out: M4b, preview (1.1), the
  Codex judgment profile, cgroup mode. Version 1.0.0-dev.7 adopts dev.6 arcs only: such an arc runs on with
  `docRef` obligations, no census and an unverified vision, under the new class catalogue, and keeps its target
  variant. That defaulting (the vacuous census, the unverified `vision.md#` reference, checkpoint answers without
  the M4a fields, the dev.6 seat decoder and routing-rev alias, the holistic `architecture-doc` variant) is
  scaffolding, deleted once no dev.6 arc is in flight. Every pre-dev.6 layer (dev.1, dev.3, dev.4 and dev.5,
  including the legacy serial frontier, dev.5 transient rules and dev.5 routing reconstruction) was deleted in M4a
  step X0 with the tests that existed only for it (owner ruling OR-L4); an older in-flight arc finishes on its own
  release.
- **M4b Flow** (seeded from M4a arcs' refs, LR-c). The flow loop, SPC, the flow role, givens, proposals and
  verdicts, the ruler fence, test-set-preserving lane edits, and the two plants.
