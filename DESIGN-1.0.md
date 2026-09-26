# roadmap-orchestrator 1.0 — design brief (draft for audit)

Status: draft 6, 2026-09-25. Distilled from 0.20.0 (tag `v0.20.0`: its RATIONALE §1–25, DESIGN.md, PROMPT.md and the Codex-native sibling skill,
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
judgment surface. Host-reboot recovery is outside the unattended guarantee; `roadmap start` recovers from disk.

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

### 2.1 Pipeline per unit (risk-tiered)

Seats below are the `default` profile's (§4); state records the role and `routingRev`, never the model.

```
plan (sol) → plan-check (opus; fable on escalation) → build (luna low/med · opus 5.5 high)
  → session-empty → evidence snapshot → classified salvage → teardown → clean worktree at salvage SHA
  → lanes (executor, serial, locked, fast then estate) → [review digest (sol, med/high only)]
  → gate (opus · fable on escalation or triggered)
  → integration slot: candidate (--no-ff) → transient check → suite + journey lanes → ff-only
    → published | abandoned | recovery-required → checkpoint cadence (§2.5)
```

Later stages bind to the salvage SHA; every judgment stage runs in a fresh session (§4). Fix rounds resume the
build session with the failing lanes' evidence dirs. Per-unit counters are cumulative and `monotonic()`:
`attempts` counts every start; `chargeableFailures` counts design-class failures only and bounds the unit.

### 2.2 Scheduling

A DAG with resource locks replaces waves. A unit starts when every dependency is merged, its contingent edges are
`resolved{evidence, by}` (only `resolve-edge` resolves), and its stage's resource set is acquirable. Resources are
**named** (clusters, ports, containers, images, volumes, per-worktree state dirs, tool locks, the integration
slot) or **capacity** (CPU and estate slots); builds, preview and lanes take capacity (sf18, §3.3).
Checkpoint-originated units outrank planned units, with aging: a planned unit outranked for more than M merges
(default 3) regains top priority. Audit P2 fixes carry a priority so they don't starve. Resources are declared
with teardown, ownership labels and capacity classes, replacing the concurrency knobs, load guard, `laneCleanup`
and census.

- **Locks.** A stage acquires its whole set all-or-none in one global order. A reservation covers probe →
  cleanup → run → cleanup; states `free | reserved | running | cleaning | cleanup-failed`; release only after
  confirmed cleanup. Requests over total capacity are refused at plan load. Preview has its own estate slot,
  never the sole one. Docker/kind resources carry `roadmap.owner=<arc>/<unit>/<invocation>`.
- **Residues.** `cleanup-failed` also enters the host residual-resource index, independent of the owner
  pointer, keyed per resource `(arc, unit, inv, resource)`, with its teardown recipe. The residue is durable in
the host index before the local `cleanup-failed` is recorded and before any release; a multi-resource cleanup
that fails partway leaves one residue per failed resource. `start` for any arc refuses until every
  residue is `cleaned` (by `sweep`) or `isolated | transferred` (by a `needs-user` disposition); an
  acknowledgement alone frees nothing.
- **Integration slot.** Serial; all else runs in parallel. Each attempt ends `published | abandoned |
  recovery-required`. A publication needing the slot abandons the current candidate (cleaned, released) first,
  waiting only for a critical section under way. A red or conflicting candidate releases its suite resources
  before the unit fix is dispatched, then reacquires. `recovery-required` resolves from the operation's
  postcondition.
- **Parks.** `retryable` (capacity, backend outage, host signature) persists a next probe with exponential
  backoff (cap 30 min) and an escalation deadline (6 h → `needs-user`); the health probe, not a second unit,
  establishes recovery. `operator` (auth, `needs-user`) waits for the architect.
- **Usage limits (owner ruling 2026-09-25).** A `usage-limit` CLI error event marks that backend `limited`
  arc-wide: running processes finish, stages needing it park as `operator/usage-limit`, others run until they
  need it, and one `needs-user` is raised. It never auto-retries: `resume --backend <name>` re-runs that
  backend's preflight smoke before unparking. Nothing brakes before the limit.

### 2.3 Architect commands

Commands are files in one executor-owned durable queue; clients never write state. Each carries an idempotent id
and the revisions it targets, and gets persisted `accepted | applied | rejected` receipts. **Control** (`pause`,
`stop`, `ack`) apply immediately: the cancellation is recorded, the authorised kill → quiescence → salvage →
cleanup transition runs, then `applied` is receipted; they wait only for a publication critical section under way.
**Mutations** — everything else, including every checkpoint act — apply only at safe points: stage boundaries,
before next-stage dispatch and before merge publication. Prompt inputs are snapshotted by revision at dispatch.

| Command | What it does | Refuses |
|---|---|---|
| `start` / `status` / `ack <id>` | launch or recover / §2.4 / acknowledge a `needs-user` item | a live owner or undispositioned residue / — / unknown id |
| `pause <unit>\|--all`, `resume [<unit>\|--backend <name>]` | park (kill, teardown, commits intact) / unpark at the earliest invalidated stage (§3 Git truth); `--backend` clears a `usage-limit` park after a passing smoke. M1: `resume <unit>` of a unit parked at plan-check or gate re-opens it at plan-check once the architect has edited its spec to the next revision (the in-place stand-in for `patch-spec`), keeping its branch and implementer session | discarding commits; pausing mid-ff; `--backend` when the smoke fails; M1: a parked unit whose spec is unedited, or parked at any other stage |
| `run-only <ids>` | dispatch allowlist (arc 1's `dispatchOnly`, used W29–34) | ids outside the plan |
| `rule <record.json>` | C-nn plus contract ops (anchor-exact, rev bump, header cites it), validated against old revisions, published together (§2.6); invalidates citing approvals | editing a C-nn (supersede only); missing `docRefs`; `deviates` without ops; anchor ≠ one match; stale base; an obligation effect from the checkpoint |
| `patch-spec <unit> <patch.json>` | id-targeted patch with expected revision (§2.7) | merged units; stale revision; scope growth without a cited C-nn |
| `admit <units+edges.json>` | adds units/edges | no spec or plan-check; unknown endpoint; cycle; duplicate id; a new prerequisite on a merged target, or on a dispatched one without `--force-park` (quiescence and invalidation first); non-architect admits while `draining`; obligations narrower than the impact mapping |
| `resolve-edge <edge> --evidence` | contingent edge → resolved | unknown or resolved edge |
| `reenter <old> --as <new> [--enter-at build\|verify] [--patch]` | re-entry through a durable preparation (§4 Re-entry); a retry resumes it | old unit running; budget or scope reset without a ruling |
| `cut <unit> --reason [--ruling]` | `inScope:false`; each descendant gets `cut \| replan \| needs-user` | merged dependents needing it; a running unit |
| `route <unit> …` / `--risk` / `--adversarial` | per-unit routing layer (§4) | risk below the Phase-0 floor without a ruling; an unsupported triple |
| `limits …` | per-unit or arc bounds and windows | lowering a counter below what is spent |
| `sweep [--resource]` | declared teardown for resources with no live holder, incl. indexed residues | anything a live session holds |
| `gc` | deletes raw evidence of completed arcs; prunes run dirs beyond the last K (§2.9; implemented in M3) | a live or incomplete arc |
| `merge-in <unit>` | integration head into the unit branch (a `mergein.prepare` operation) | unit running; conflict → abort, report |
| `steer <unit> --brief <f> --budget <min> --model <m> [--resume]` | alternate implementer-stage entry for a **parked** or `preparing` unit; `--model` enters as a per-unit routing layer (a new `routingRev`), so the steer record names the role: pre-steer state saved, approvals invalidated, normal salvage → lanes → review/gate exit; parked unless `--resume`; minutes (lanes excluded) and usage recorded, fix budget uncharged. Unblocked arc 1's launcher and estate | unit not parked; no budget; widening the envelope |
| `audit [--lens]` / `explore <q> [--at sha]` | §2.5 on demand / read-only recon to `feedback/` | lenses acting directly / any write |
| `obligation add\|split\|waive\|defer\|witness` | edits obligations (§2.8), published like a `rule`; architect only, except `split` | unsupported reporter; `waive`/`defer` without a ruling; children dropping parent text |
| `debt resolve <id> --ruling` / `promote <id>` | ledger ops | promote while `draining` |
| `close-admissions`, `stop` | latch `draining` (§2.10) / park all, teardown, release the host lock (residues persist) | — |

Automatic: salvage (arc 1 did it by hand three times); teardown after any kill; the snapshot (§2.9).

### 2.4 `status`

Agent-facing JSON: are we closer to the target, what holds, what blocks and whose move it is, what was decided
without me, what is burning host or time.

`run` {state (§2.10), since, owner, heartbeatAt, supervisorCrashes} · `target` {cutLine, nextMilestone,
criticalPath, obligation counts} · `nowTrue` / `notYetTrue` from observations on the current head, with
blocking units, reason (code|spec|host|supervision|waiting-dep) and evidence dirs · `waived` / `deferred` with
rulings · `needsUser` ranked, with recommendation and options · `decisionsSince` [{C-nn | bundle | patch |
reenter | cut | steer | quarantine, oneLine, ruledBy}] · `convergence` · `commands` · `units` {counts, running
[{stage, attempt, elapsed, deadline, resources}], parked/quarantined/preparing [{why, reasonClass, nextProbeAt?,
escalateAt?, lineage, dossier}]} · `findings` · `audit` {coveredTo, uncovered by lens, generation,
checkpointLaneMinutes} · `owed` · `debt` · `spend` {Claude tokens by role (by-model totals derived from `routingRev` at render time),
usage-unavailable calls, codexHours} · `host` {load, locks, residues, containment, strandedResources — non-empty is a flag}.

The architect log keeps arc 1's four-paragraph shape (what the organisation can now rely on · what is not yet
true · rulings · next target in business terms), rendered from the same state.

### 2.5 Cadence audit (Opus lenses)

Three lenses — invariants, drift, vacuity — all paid off
in arc 1 (w33 found two P1s and two P2s seven unit gates had passed; drift in four of six audits; eight vacuity
rows). The lenses report; the Fable checkpoint that follows them acts (§2.8).

- **Triggers**: every N merges (D3); a merge leaving a touched obligation unwitnessed; drift-only whenever
  rulings or patches land (w37 found drift with zero merges); wall-clock when merges cannot advance; on demand.
  Overlapping triggers coalesce; each audit records its causal generation (§2.8).
- **Immutable inputs**: integration SHA, ledger/spec/ruling revisions, branch SHAs of parked or in-flight
  owners (the w33 P1s were already fixed on a blocked branch), prior findings with dispositions (w35–37 repeated
  one note thrice), event high-water mark; a detached worktree, so merges continue.
  Completion discharges only its covered range and lens; results are observations keyed by the audited SHA.
- **Mutants are executed, never judged by reading.** A vacuity finding admits a bounded repair unit whose first
  executor-verified obligation is reproducing it (the old test permits the mutant) before the repair is graded;
  acceptance is the new test killing it. No unadmitted implementer runs.
- **Quarantine stays a real-defect signal**: 21 of 24 arc-1 dossiers were design-class; risk predicted it
  (high 30%, med 21%, low 7%). 1.0 stops charging host or supervision faults.
- **Owed**: skipping is recorded; owed for 2N merges or past its deadline → `needs-user` (an owed explorer went
  unrun for 27 waves). The final audit and checkpoint run after the last merge; the audit stays open until
  its generation is quiescent.

### 2.6 Ruling record

`C-nn — <rule>` plus provenance (cited by 83 of 114 arc-1 specs; the provenance lives in the in-tree
`constraints.md`, while the ledger file judgments read carries rule text only, a withdrawn ruling folded to
`C-nn — withdrawn by C-mm`), with a JSON sidecar: `statement`, `kind`,
`ruledBy` (architect | checkpoint), `trigger`, `supersedes [{id, part}]`, `condition?`, **`docRefs [{path,
anchor, quotedText, relation: consistent|refines|deviates}]` required**, `contractRefs`, `contractOps` (required
when a ref `deviates`), `obligations`, `obligationDispositions [{id, waived|deferred}]` (architect only),
`appliesTo`, `lifetime`, `status`. Code checks identity, anchors and quoted text, revisions, supersession,
amendment linkage and overlapping anchors; semantic consistency is a model judgment stored with the revisions
it judged. Rulings are checked against the code before landing
(plan-check readings overturned three arc-1 drafts).

**Publication.** In-tree `.roadmap/` (§2.9) and contracts change only through this operation, in the
integration slot: old and new document blob SHAs, a rule candidate on the tip, journey lanes for the
obligations the touched documents map to (§2.8) under the held-claims brake, the exact expected integration
update, and one recoverable activation record making ledger entry and document commit visible together;
recovery reconciles by its postcondition. There is no other document writer and no pending state.

### 2.7 Spec record

Arc-1 redirects were appended as prose, so verifier and gate graded different texts (§3.17). The canonical spec
is `spec.json` with stable clause and lane ids and a revision; its full Markdown rendering is non-normative and
is the one text verifier, gate and fixer read. Fields: `lanes [{id, argv[], cwd, env, expectedExit, tier:
fast|estate, resources, evidenceGlobs, until?: {unitMerged}, then?}]` (`argv[0]` resolves at plan load — no
shell strings, so no bare `access.sh`; `until` resolves through `supersedes`, C-126), `acceptance [{id, clause,
failLoudIfUndelivered}]`, `scope`, `resources`, `decisions [R1…]` verbatim for the implementer,
`contractRequests` (routed to `rule`), `obligations [I-nn]`, `repairs? [finding or I-nn]`, `facts`,
`owedAfterMerge`. `patch-spec` ops (`add | replace | strike | defer`) target ids with the expected revision, and are
also how plan-check redirects apply; changing a lane or clause invalidates the evidence that graded it.

### 2.8 Holistic layer: obligations and checkpoint authority

**Delegation envelope.** **Obligations** are owner-approved: every checkable claim extracted from the
target-state document (extracted, cross-checked, adjudicated by the architect) plus the cut line.
**Implementation contracts** — frozen contracts, conventions, specs, routing, the plan graph — the checkpoint
edits autonomously. Any act whose effect is that an obligation is no longer required (weaken, retire,
split-and-drop, re-anchor) becomes a `needs-user` request instead (Obs §4.5's hostname ruling broke cookie
isolation).

**Obligation record.** `I-nn {statement, docRef {path, anchor, quotedText}, witness {laneId, testIds,
reporter}, proofJudgment {verdict, rev}, deliveredBy [units], activation: future | must-hold, parent?, rev}`.
Ids survive amendments; split children reference the parent, required until every child is discharged. One
held on the base starts `must-hold`; others name `deliveredBy`. Evidence refresh never bumps the normative
`obligationRevs`. `waived` and `deferred` are architect rulings, never `held`.

**Witnesses.** Arc lanes have stable ids and revisions; many obligations share one execution per tree. Each
run emits per test id `{claimId, testId, runner, selected: n, outcome: pass|fail|skip|zero-selected,
treeSha, laneRev, invocationId}` through a supported reporter: `go test -json`, a Node JSON reporter, or a shell
wrapper for scripted journeys. No record or a malformed one → `unwitnessed`. An observation is reused only when tree
SHA, lane revision and environment identity match. "This test proves this statement" is judged at Phase 0,
bound to both revisions, re-judged only when either changes. Unit-branch success never certifies an integrated
claim (w38). Checkpoint lane duration is part of Phase-0 feasibility and `status`.

**Ordering.** Observations (`held | not-held | partial | unwitnessed`) are append-only, keyed by tree SHA and
revisions; current status is the one on the current integration head, never the latest to complete.

| Obligation | Observation on the evaluated tree | Effect |
|---|---|---|
| `future` | any | measured, never graded |
| `future`, candidate completing `deliveredBy` | `held` / other | witness validated, then graded: latches `must-hold` / red |
| `must-hold` | `held` on the current head, or validly reused | discharged for that head |
| `must-hold` | `not-held`, `partial`, `unwitnessed`, skip, zero-selected, stale, missing | red for the brake; never discharges |

**Impact mapping.** One authoritative mapping, built at Phase 0 and revisioned with the obligations, selects a
candidate's obligations: declared ones, those whose contracts, docRefs or witness files it touches, and those
of its dependency closure; an unmapped changed path selects every `must-hold` obligation. `admit` and
`patch-spec` validate declared obligations against it. Obligations neither run nor validly reused are recorded
`not covered`, never passed.

**Journey lanes** run (owned by no unit, same locks and evidence rules): in every candidate (unit or
rule) for its selected obligations, and on every checkpoint snapshot for all. **Held-claims brake (code):** a
selected `must-hold` obligation red makes the candidate red, same repair path as a red suite; only an architect
waiver overrides it.

**Findings and repair.** States `open | owned | fixed-on-branch | resolved | ruled`. A P1 in the first three
blocks merges of every unit selecting its obligation, except the declared repair (`spec.repairs`), which may
publish when its candidate shows that obligation held with integrated evidence. A multi-unit repair publishes
as one candidate holding every repair branch, or via a ruled intermediate state; a base red matching the
recorded regression does not halt merges. A parked owner's P1 escalates at the park deadline; P1s never bank;
while `draining`, a new P1/P2 is a durable `needs-user`. Per finding `{lens, severity, gateHadPassed,
disposition, merged, timeToResolve}` is recorded, so arc 2 measures whether the checkpoint works.

**Checkpoint authority.** After the lenses (§2.5) the checkpoint seat **rules**, steering
toward the vision rather than the original plan: amend implementation contracts, respec, `reenter`, `cut`,
`admit`, re-route, re-pin scope, invalidate approvals, split obligations. Brakes in code:

- **Bundles.** A decision is one action bundle: ops, an expected revision vector over every artifact touched, its
  evidence base (integration SHA + observations), one all-or-none activation record; affected dispatch waits
  meanwhile. Staleness rejects and re-evaluates the whole bundle; a cited observation that differs on the current
  head drops it and re-evaluates the finding. No effective change → `no-op`, no revisions. Reversal is a
  compensating bundle; published effects are reversed by a verified repair unit.
- **Generations.** Each checkpoint records the audit or ruling that triggered it; a `no-op` makes its
  generation quiescent.
- **Convergence bound.** Material changes (cut-and-replace, respec, scope expansion, budget reset, re-route, a
  spec patch changing lanes or acceptance) count per causal identity `(obligation or finding id, lineage
  root)`; a second → `needs-user`. Each applied bundle increments an arc counter cleared by a merge or a newly
  held obligation; at K (default 3) one durable `needs-user`. Otherwise only architect acts reset them.
- Every act is a ruling record (§2.6) with docRefs and a mutation, shown in `decisionsSince` and the log.
  While `draining` the checkpoint requests instead of admitting. Answering the user stays root-only.

### 2.9 Artifacts

The integration branch carries product changes and living docs only: in-tree
`.roadmap/` holds exactly `contracts/`, `constraints.md`, `invariants.md`, `debt.md` (what a later arc's Phase 0
reads, rendered from the ledgers) and `config.json` (§4), changed only by publication (§2.6; `debt.md`
at each checkpoint). Plan, specs, ledgers, observations, log, dossiers and `result.json` are
snapshotted one-way to `refs/roadmap/<arc>` (allowlisted files plus a sha256 manifest of them, `schema:
roadmap/1.0`, event high-water mark; the snapshot tree must match its own manifest), so no
PR diff contains them (arc 1's 1,219-file PR); nothing extra enters a candidate, so the tested head is the
published head. Raw evidence (stdout/stderr, lane output) stays out of the ref, which carries only its sha256
manifest; the evidence itself stays in the run dir. An in-tree `.roadmap/` holding anything else is 0.x and
refused.

| Artifact | Owner | Location | Mutability | Published to |
|---|---|---|---|---|
| Plan (units, edges, routing), specs | executor via commands | run dir | revisioned | ref |
| Contracts, architecture doc, `config.json` | executor via publication | product tree | blob-SHA revisions | tree |
| C-nn ledger | executor via `rule` | run dir | append-only, supersede | tree (`constraints.md`), ref |
| Obligations (I-nn), impact mapping | executor; architect via commands, checkpoint `split` | run dir | revisioned | tree (`invariants.md`), ref |
| Debt | executor | run dir | append-only | tree (`debt.md`), ref |
| Observations, log, dossiers, `result.json` | executor | run dir | append-only / write-once | ref |
| State, events, queue, `needs-user` | executor | run dir | append-only / write-once | — (high-water mark in ref) |
| Raw evidence | executor | run dir | write-once; `roadmap gc` after completion | ref (sha256 manifest only) |
| Host lock and metadata, residual index | executor, supervisor | `/var/tmp/roadmap/` | `link()` claim; append + disposition | — |
| `skill-feedback.md` | architect | outside the product repo | hand-written | — |

**Growth across arcs.** Four controls: arc-lifetime and superseded
rulings leave the rendered `constraints.md` at close-out, kept in the ref (implemented in M3); obligations are
re-derived from the target document at every Phase 0 and diffed (implemented in M3); `roadmap gc` deletes raw
evidence of completed arcs and prunes run dirs beyond the last K (implemented in M3); finding dismissals have arc
lifetime (implemented in M3). The residual-resource index is compacted at `start` (implemented in M3).

**Debt across arcs** (implemented in M4). Each debt item has a stable id, its origin arc and a status. Phase 0 must disposition every
open item (`promote | keep(reason) | resolve(ruling)`), or the arc refuses to start; an item kept across two arcs
surfaces as a ranked Phase-0 question. Obligation-affecting items are findings, never debt.

### 2.10 Arc states

`run.state` is the first that holds:

- **`complete`**: every in-scope unit merged or dispositioned (cut, or waived by ruling); every obligation
  discharged on the current head or waived; no unacknowledged blocking `needs-user`; no pending commands; no
  uncovered audit range; the final generation quiescent.
- **`needs-user`**: an unacknowledged blocking `needs-user` item.
- **`blocked`**: nothing can dispatch while in-scope work remains (parked, excluded by `run-only`, or behind an
  unresolved contingent edge); parked in-scope work is never `complete`.
- **`draining`**: latched by `close-admissions` or plan drain, reopened only by an
  architect `admit`; closure applies at the single minting point to every automatic admission and re-entry path
  (debt, checkpoint admits, repair units), which become `needs-user` requests.
- **`running`**: otherwise.

## 3. What carries verbatim

Proven in arc 1 or by a named incident; ported as code, not prose.

- **Phase 0**: decomposition, frozen contracts + conventions contract, `scopeAllow`, contract↔code cross-check
  (Codex), design authorities, edge classification, spec requirements (as `spec.json`), self-validation,
  `## Direction`, fidelity audit, C-nn ledger, ≤5 ranked questions, "units build from commits", the cross-model
  plan-pack review (Astra, never rules) — now also obligation extraction (witnesses, `deliveredBy`, proof
  judgments, impact mapping, cut line).
- **Ledgers**: C-nn, obligations, debt + closed-set `bankReason` (deduped by `(unit, kind, hash(what))`),
  architect log, `escalations.jsonl`, `degradations.jsonl` (host-fact kinds only), quarantine dossiers,
  `skill-feedback.md` never a product-repo issue.
- **Anti-spiral core**: scope envelope pinned once at dispatch and never recomputed — changed only by a ruling;
  scope growth is a signal to the gate, never a licence; `maxBlockingFindings` overflow banks; correctness debt
  never banks through an approve; review is evidence to the gate, never directives to a fixer; FINDING_BAR,
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
  rulingRevs, obligationRevs}` (normative only; the architecture doc is a contract); any change invalidates the
  gate and the unit re-enters at the earliest invalidated stage. A moved tip means a fresh candidate, not a new
  gate.
- **Merge** (candidate-first): in the integration slot a candidate worktree makes a `--no-ff` merge onto the
  current tip, held on the named ref `refs/roadmap-run/<arc>/candidate/<unit>`. The **transient check** (code) runs first: the merge-base diff may touch only pinned scope and
  ruling-added paths, never in-tree `.roadmap/` outside publication; a denylisted path (declared `evidenceGlobs`,
  worktree state dirs, lane outputs, ignored patterns, `__preview`, `__codex`) refuses the candidate as a
  scope-growth finding, fixed by a normal fix round. Suite and journey lanes run, graded by exit code, witness
  records and the held-claims brake; a suite that mutates the tree is refused; on green, integration fast-forwards
  (the publication critical section). On red integration never moves, suite resources are released, and the
  pre-merge tip is tested alone (an unexplained pre-existing red halts merges, `needs-user`; a known regression
  under repair does not); otherwise one fix round under an independent gate, then a new candidate; red again
  parks, branch kept. Conflicts take the same path. An approved empty diff is refused at gate. Prefix-collision
  guard that grandfathers existing ones.
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
| Routing profiles | `role → seat → model class → {backend,model,effort}` (owner rulings 2026-09-26, arc-1 feedback items 7-9). Seats: build `{low,med,high}`; each judgment role `{low,med,high,escalation}`: a unit's risk is never `escalation`; route-ups and risk triggers move a judgment to it, and a judgment already there that escalates parks (needs-user). Every layer names a **class** per seat, never a model: built-in profile < `.roadmap/config.json` `seats` (committed: set once per repo) < `plan.config` < per-unit `route`. Classes `efficient | frontier | summit` bind to triples in one place, the class catalogue in code (`efficient` → Luna medium, `frontier` → Opus 5.5, `summit` → Fable 5.1); `.roadmap/config.json` `classes` may rebind a class for the repo, and is the only place outside code a model is named (a plan cannot rebind). The resolved triples are hashed into `routingRev`, so a rebind changes it like a seat edit. Only supported triples (a prompt module exists) are selectable. Codex judgment triples are `unsupported` until a read-only Codex judgment profile exists: judgment roles resolve to Claude in both profiles, and a seat that names a Codex model for a judgment role (D2's sol digest) resolves to the Claude low judgment seat until then (owner ruling, 2026-09-25). Claude triples carry `effort: 'default'` (no effort flag). Per-invocation launch instructions (`launch.json`) carry the backend argv, which necessarily names a model; they are launch inputs in the run dir, not state, and are the only executor-written files outside the `state.no-model-ids` scope (event log, state cache, needs-user, receipts, residues, the snapshot ref, `status` output and meter facts). Model ids are pinned: `claude-opus-5-5`, `claude-fable-5-1`, `gpt-5.6-luna`, `gpt-5.6-sol`. Sonnet 5 is never supported; Haiku holds no seat. **`default`**: efficient builds low/med, frontier builds high; frontier plan-checks and gates every risk tier and summit holds both escalation seats (owner ruling 2026-09-26: independence is a clean context, not a different model; the stronger model is spent where a judgment escalates); plus Opus lenses, Fable checkpoint, Astra Phase-0 cross-check. **`claude-only`** (one config line; no Codex dependency with the built-in bindings): frontier builds every tier; judgment as in `default`; Fable holds the checkpoint and consult seats; Opus digest for med/high; Opus lenses; Opus Phase-0 cross-check. `route` may set any class at any seat. A routing change mid-unit (lead ruling 2026-09-26): a judgment seat may change freely (every judgment is a fresh session); the implementer's may not once its build started (its session resumes), so such a unit parks with a needs-user (`routing-changed`) and any other is re-pinned under the new `routingRev`; once the architect restores that seat's routing, `resume <unit>` re-pins the parked unit and re-enters it at the stage it parked at, no spec edit. Its preflight skips the Codex smoke and asserts no role resolves to Codex. Phase-0 risk is a floor plan-check may raise, never lower; runtime triggers (contract path, mismatch, gap, scope growth) promote in code. |
| Prompt–model coupling | Every prompt is keyed by `(role, modelId)`: one module per pair (`prompts/<role>/<modelId>.ts`) citing the vendor prompting guide it follows and a reviewed date. Model ids are a closed union and each role's table is `Record<ModelId, Prompt>`: a new model fails compilation until every role has its prompt or a dated `inheritsFrom: <modelId>` (reviewed reuse, never implicit). Prompts are pure functions of revisioned inputs; a test asserts prompt fields == schema `required`. Precedent: 0.20's Opus 5.5 patterns. |
| Actors are roles, never models | (owner ruling 2026-09-25) Model ids appear only in routing configuration — the class catalogue and a repo's `.roadmap/config.json` class rebinds; profiles, `plan.config.routing` and per-unit `route` name classes (owner ruling 2026-09-26) — which is revisioned. Every record the executor writes (events, `result.json`, meter facts, ledgers, rulings, dossiers, the architect log, `status`) names the **role** an actor filled plus the `routingRev` in force, never a model id; the model is derivable from the routing revision when needed and `status.spend` is rendered by role (by-model totals are derived at render time). Prompt modules are keyed by model because they are code, not state. Rationale: models change month to month; state, ledgers and rulings must not rot with them. Plan-load validation and the unit test `state.no-model-ids` reject any executor-written record containing a known model id. |
| Independence | A clean context, not a different model (owner, 2026-09-25): every judgment role (plan-check, digest, gate, consult, lenses, checkpoint) runs in a fresh session under the judgment profile, inputs snapshotted by revision, no implementer transcript. Checked in code at plan load and every judgment dispatch: a judgment invocation refuses `resume` and never reuses an implementer, steer or escalation session. The same model may implement and judge. |
| Claude profiles | **judgment** (read-only; no settings, CLAUDE.md, MCP, skills or auto-memory: a clean context) and **implementer** (write tools in the unit worktree, commit-before-report; the repo's project settings and CLAUDE.md, no MCP, skills or auto-memory); both run `--output-format stream-json`, yield `result.json` and are metered. |
| Verification | The executor runs spec lanes serially, verbatim, under locks, fast before estate, in a clean worktree at the salvage SHA, evidence keyed by invocation. No verifier role; `judgeVerify` provenance is always `spec`. |
| Lanes | Per §2.7; `env` prerequisites probed at plan load (missing → `spec-lane-unrunnable`, park, never a strike — sf16); `evidenceGlobs` snapshotted before teardown and handed to fix rounds (§3.21's cause was in `caller.stderr`). |
| Implementer boundaries | Implementers run **fast** lanes only, the stage reserving their declared named resources throughout. **Estate** lanes are executor-only. Before release the occupancy probe runs: an undeclared estate with the unit's label is torn down; unlabelled → park, `needs-user` (§3.15, §3.16, §3.22). |
| Host signatures | Code table (golangci lock, kind boot under load, EAGAIN). Red becomes `blocked` only with the signature **and** contemporaneous host evidence; the original result is kept. One same-SHA retry once clear; red again on a healthy host is a product failure; uncertain → `unknown`, uncharged. |
| Flakes | An unexpected red lane gets one same-SHA diagnostic rerun before any code change (the host retry, where it applies); both kept; red-then-green is a flake and never approves. |
| Blocks | A retryable park; never quarantines (sf16; log w35). Repeats on a unit, blocks on two units in a window, or the deadline → `env-*` → `needs-user`. |
| Occupancy | Inside the reservation: a probe mirroring the lane's preflight, then declared teardown; decided before any budget is charged (§3.12). Failed teardown → `cleanup-failed` (§2.2, §3.4). |
| Process lifecycle | Every executor subprocess (backend, lane, probe, teardown) runs as a workload under a runner, which is the controller and never a workload member. The runner carries `ROADMAP_ROLE=runner`; the workload carries `ROADMAP_ROLE=workload`, `ROADMAP_OP` and `ROADMAP_INV`. Workload membership is every process whose environment has `ROADMAP_INV=<inv>` or whose session id equals the child's, identified by (pid, start time), excluding the runner; the runner is never signalled by its own kill and exits itself after writing its terminal files. **Session mode** is the containment 1.0 ships with: a `setsid` session and `/proc` scan; kill = stop members → rescan until the set is stable → TERM → KILL → rescan until empty; no next stage while non-empty (w39). Its guarantee is narrowed and stated in `status.host`: a descendant that calls `setsid()` and execs with a cleared environment escapes, caught only by the verification-tree assertion and the occupancy probe. **cgroup mode** (a cgroup v2 leaf per invocation under a delegated subtree, runner in `runner/`, workload in `work/`, entry fail-closed, kill = freeze → TERM → `cgroup.kill` → empty) is experimental: not selectable until a real-kernel gate passes on another host. Kill reasons: `deadline \| pause \| stop \| recovery \| external-unknown`. |
| Fix rounds | Resume the build session with evidence dirs (a session never moves across seats: a build whose implementer seat a risk raise moved starts fresh on the kept worktree); window from the unit's measured lane series (§3.2, §3.8); after N stalled rounds the strong implementer, cold (D4); no fresh final round; `harnessStop` never feeds a round. |
| Plan-check | Redirects are internal revisioned patches (§2.7); only the patched spec is graded; may set an estate budget (D8). Reads a detached checkout of the integration tip (its cwd) and of the unit branch when one exists; host facts only from the executor's resolved lane programs or the checkouts. Checks spec coherence and buildability, not the implementation: defects in code already on the unit branch go to the build and gate as notes, never a redirect on their own. A redirect may add cites, never remove one (arc-1 feedback items 3, 12, 21, 26). |
| Gate inputs | Spec rendering, cited contracts and C-nn in full with a one-line index of the rest (read on demand), architecture doc or its owner-approved digest, merge-base diff, lane ledger, evidence, witness records, digest, scope envelope + growth, Direction, the approving plan-check's notes; graded against the contract, not a paraphrase (w34). "Every spec lane ran verbatim" is a code assertion; `reportLostEver`, `LANE_BAR` go. |
| Round handoff | A judgment's round N+1 on the same unit (plan-check after its applied redirect, gate after its revise) is a fresh session that inherits round N's conclusions, never its session: the prior patch or directives and findings, the premises it relied on (claim + file:line evidence, part of every judgment's output), and the delta since (fix paths; premise files whose blobs changed). It rules each prior item resolved or not, reviews the delta for regressions, re-verifies only changed premises (overturning any with evidence), and raises a new finding on unchanged material only when it affects correctness or stated acceptance (arc-1 feedback items 25, 29). Judges report only what affects correctness or stated acceptance, verify only the premises a decision relies on, and batch reads (items 15, 28c). |
| Unit policy | Every build prompt carries an executor-owned policy that overrides the repository's agent-instruction files: no cloud resources or CLIs, no sudo or system package installs, no killing processes the unit did not start, no network beyond the lanes' needs (arc-1 feedback item 20). |
| Consults, findings | The consult seat reads evidence, spec, diff and C-nn directly; the Sonnet dossier goes. Findings dedupe by finding+cause with a disposition; a dismissed one is not re-raised without new evidence (sf16, w35–37). |
| Wave-tail roles | → §2.5 + §2.8; a design-class quarantine gets a per-unit respec by the checkpoint seat, a second → `needs-user`; explorer and reconciler on demand. |
| Re-entry | `reenter` replaces `adopt`. A preparation has a durable identity; budgets, attempts, risk floor, dispositions and the lineage's original scope envelope **inherit**; approvals and evidence are **invalidated**; sessions do not inherit. Integration is merged into the prepared branch (§3.23); on conflict the index is aborted, the branch kept, and the preparation becomes a `preparing` plan unit resolved through the implementer stage (or `steer`). Replacement edges activate, cycle-checked, only after preparation succeeds. Resets need a ruling. |
| Plan-load validation | Every `edge.contract` path exists (sf18); `argv[0]` and env prerequisites resolve for spec lanes and `must-hold` arc lanes (`future` ones at activation); no request over capacity; worktree root not on tmpfs; routing supported, judgment roles on the judgment profile; every obligation not held on the base names `deliveredBy`; every witness has a supported reporter. |
| Measurement | Per lane per invocation `{start, end, exitCode}`, per unit `{dispatchedAt, terminalAt, mergeSha, mergedAt}`, every upper-tier call's tokens keyed by `{role, routingRev}`, every escalation, checkpoint lane duration and per-finding instrumentation (§2.8). Arc 1 recorded almost none of this; defaults are marked unmeasured and re-derived after arc 2. |
| State | The event log is authoritative and write-ahead; its envelope is frozen before M1: every operation has an arc-scoped id, parent command or stage id, invocation ordinal, expected inputs and postconditions; op kinds include `mergein.prepare` (integration merged into the unit branch in its worktree; postcondition `clean-merged | conflicted | completed`) and `evidence.snapshot` (a completion manifest of paths and sha256, required before teardown or retire); a complete durable intent precedes every act; `state.json` is derived (`atomic()`). A truncated final record is discarded; earlier corruption → `needs-user`. Every operation kind (resource states, spawns, commands, publications — the latter by second-parent test or activation postcondition) has a reconstruction rule pinned by a crash-boundary fixture. Deadlines are absolute; attempts monotonic across re-entry; run state reaches git only via `refs/roadmap/<arc>`. |
| Invocation recovery | Per open spawn intent: inspect completed artifacts (a validated `result.json`; else `exit.json`, re-running the adapter) and tree effects → find the live workload by `ROADMAP_INV=<invocation id>` (the runner excluded; a scan by `ROADMAP_OP` also kills stray earlier ordinals) and adopt it through its live runner, or, with the runner dead, terminate it and classify the invocation `lost` → only then decide whether to invoke again. A valid `result.json` with live workload members is not quiescent: kill, then certify. Completed-but-unrecorded work is salvaged and re-verified, never treated as not started. Retries get a new invocation id; the original deadline holds. |
| Issue mode, preview | Inbound only (D6; implemented in M4): `roadmap:bug` / `roadmap:feedback` issues read in code at Phase 0 and checkpoints; the outbound projection is deferred to 1.1. Preview's process and slot owned by the executor. |
| Codex-native driver | Dropped; its fingerprint, candidate→suite→ff, `monotonic()`, "never reset a dirty worktree", marker-exact gh sync and Astra review survive. |
| Refusals | Stop reason → `refusal`, routed up; `unit.adversarial` pins to the frontier. |

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
  sol plans and reviews, Opus gates low/med, Fable gates high. Astra is confined to Phase 0 (pack review,
  obligation cross-check), each finding adjudicated by the architect; it holds no seat that can build or
  reject. This is the `default` profile (§4); high-risk units spend the weekly limit by design, visibly (D5).
- **D3 Audit cadence N.** *N = 5 merges, plus §2.5's other triggers.*
- **D4 Fix-round escalation.** *Resume within a model; cold across models; no fresh final round.*
- **D5 Claude spend — decided 2026-09-25.** *Meter only; no cap (arc 1: ~3 upper-tier calls per merged unit).*
  Every upper-tier call records `{role, routingRev, unit, attempt, inputTokens, outputTokens}` or `usage:
  unavailable` with its reason (the model is derived from the routing revision); nothing brakes on it.
- **D6 Issue mode in 1.0 — decided 2026-09-25.** *Inbound only: `roadmap:bug` and `roadmap:feedback` are read at
  Phase 0 and checkpoints (implemented in M4).* The outbound projection is deferred to 1.1.
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
host; multi-UID hosts; reboot recovery; more witness reporters; a formal ruling language.

## 9. Eval ladder

1. **parse** — `tsc` on the executor, adapters and prompt tables (a model lacking a role's prompt fails here).
2. **unit** — subprocess fakes: fake `codex exec` / `claude -p` that emit events, exit with a chosen code, hang
   past a deadline, fork a child that calls `setsid()`, or exit 0 having done nothing. Carried in spirit:
   outage-lifecycle, git-truth, codex-lane, exit-code rules, merge fences, evidence manifest, shared-red and
   resource semantics, prompt-hygiene, portable-budgets, phase0-templates. Dropped: persist, launch-pack,
   shared-consts, wave routing, knob pins. **New**, with real processes and git: a crash at every write-ahead
   boundary of every operation kind asserting the exact replay (torn tail, completed and live invocations, racing
   takeover, executor SIGKILL with no session); new-session escape; lock order incl. the slot; foreign residues;
   known vs unexplained base red; transient-check refusals; a queued `rule` abandoning a candidate; control vs
   mutation timing; a steer or escalation session never becoming a judge session; re-entry retry; merged-target
   refusal; `usage: unavailable`; routing layers and refusals, `claude-only` resolving no Codex role; pre-staged
   salvage; dirty verification tree; the §3.1 fixture (`Capacity: 2Gi` → no halt); witness records; lane reuse;
   the transition table; unmapped paths; future activation; repair batch; both audit-race orders; stale and
   partial bundles; `no-op`; the convergence bound; arc-state predicates.
3. **targeted probe** — real calls: both Claude profiles and Codex fresh/resume against real schemas (M1 gate).
4. **paid** — per-slice fixtures (§10), once per merged batch, offline in file mode, the M1 fixture also under
   `claude-only`; the issue fixture (D6).

**Acceptance properties**, asserted by each slice as reached: lanes run by the executor verbatim,
graded by exit code and witness records; fix rounds get evidence dirs in continuous context; diffs are
merge-base after merge-in, and re-entry verifies against integration; gates judge in fresh sessions over a pinned
scope; no cleanup path discards branches or salvage; the published head is the tested head; a PR diff contains
product changes and living docs only; a final whole-tree audit and witnesses run after the last merge;
checkpoint acts pass through the same revisioned commands and candidate verification; every side effect is
code-owned.

## 10. Cutover

Hard cutover: 0.x state is refused (§2.9), not converted. `RATIONALE.md` is rewritten from the distillation
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
- **M2 DAG and resources.** DAG dispatch, capacity scheduling, aging, retryable parks, `reenter`, graph
  commands. Fixture: no overlapping holders, bounded service for planned work, `cleanup-failed` survival, a
  conflicted re-entry, no duplicate writer after concurrent recovery.
- **M3 Holistic layer and revisioned commands.** Obligations, witness protocol, impact mapping, journey lanes,
  held-claims brake, lenses, the checkpoint with bundles and brakes, findings, arc states,
  `rule`/`patch-spec`/`steer`; the growth controls of §2.9 (ruling retirement from `constraints.md`, obligation
  re-derivation at Phase 0, dismissal arc lifetime, residue-index compaction at `start`, `roadmap gc`). Fixture
  (obligations seeded by hand): an initially absent multi-unit journey
  whose foundation merges first, a regression and its repair, a stale audit race, a rejected partial bundle,
  the convergence bound firing, final quiescence.
- **M4 Skill text and acceptance.** SKILL.md (Phase 0 with obligation extraction, which is in-session work;
  check-in; session end), reference.md, inbound issue intake (outbound projection in 1.1), the debt lifecycle
(§2.9: stable ids, Phase-0 disposition or refuse, the two-arc question), preview. Extraction runs on a real target document
  and is adjudicated before the full acceptance fixture.
