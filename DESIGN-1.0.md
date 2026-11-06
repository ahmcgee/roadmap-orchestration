# roadmap-orchestrator 1.0 — command-center design

Binding design for **1.0.0-dev.33**, runtime schema **2**. This replaces the earlier milestone-by-milestone draft
with the system implemented in this release. Precise wire shapes and reader ownership are in
[SCHEMAS.md](plugins/roadmap-orchestrator/executor/SCHEMAS.md); operating instructions are in the
[orchestrate skill](plugins/roadmap-orchestrator/skills/orchestrate/SKILL.md) and its lookup reference.
The 0.x design record remains in git history at `v0.20.0`.

## 1. Purpose and authority

Converge a codebase incrementally on a detailed documented target while running unattended for a week or more.
Wall-clock and sound convergence matter more than making an individual unit look fast. Code performs exact work;
models supply judgments and implementations. The owner sets the target world and resolves questions only they can
answer. The root architect curates and decomposes it, changes the plan, and supervises exceptions. The executor owns
workloads, resources, evidence and publication. It never asks a model to do something it can check exactly.

The vision is the root record. The pinned corpus is normative target text. A plan selects the slice this arc advances;
obligations connect target claims to executable evidence. System notes and commit summaries are non-normative memory.
The root may change means and interpret the target within authorization; workers and audits cannot waive obligations.

## 2. Runtime and recovery

One detached executor per single-UID Linux host, supervised by a separate process. Node 24 runs erasable TypeScript
directly, without runtime dependencies or a build step. Claude is the primary backend; Codex remains a supported build
partner through the same process interface. There is no second chat surface: the owner's interactive architect session
is the inquiry/command surface, with a read-only TUI available in another terminal.

Host state lives at `/var/tmp/roadmap/`; arc runtime lives at `<git-common-dir>/roadmap-runtime/<arc>/`. A written temp
file is linked to claim the host lock, with nonce/generation and owner pid/start/boot identity published by handshake.
The executor waits for and verifies that handshake before effects. Dead-owner recovery claims its own exclusive lock
before checking identity and replacing ownership. Ambiguous/missing ownership refuses rather than guessing.

Every side effect is a typed write-ahead intent followed by done/abort. Deterministic objects, file hashes, refs and
postconditions make replay idempotent. The journal and immutable kept inputs are authoritative; snapshots/status are
projections. A torn tail is detected and recorded. Corruption is a refusal, not an excuse to reconstruct events from
plausible state. Unit/job faults park their own scope when isolation permits; shared-state faults remain fatal.

Each workload runs under a runner that owns its child and records launch, stdout/stderr, exit and validated result in
files. Executor death can reattach. Containment emptiness precedes reading terminal files, releasing resources or
advancing a stage. Adapters are pure over quiescent files and can rerun. A builder's final report starts a bounded grace
for descendants to finish; an intermediate wait report does not prematurely certify a build. Results distinguish
success/refusal/malformed/process fault/cancellation from usage availability. Missing usage does not invalidate a
judgment. Session containment cannot prevent deliberate escape; experimental cgroup mode needs a writable delegated
subtree. The host's actual guarantee is reported.

The supervisor restarts with bounded backoff and stops after repeated crashes (three in an hour), raising a persistent
item. First start smokes every routed backend. An established arc's respawn parks a failed backend and lets available
backends proceed. Subscription usage limits require explicit backend resume; recoverable outages/capacity parks can be
probed. Host reboot recovery uses start/resume-arc, not an assumed always-running supervisor. Exit evidence includes
external SIGKILL diagnostics where available: pressure, memory/OOM counters and readable kernel matches; uncertain
cause stays external-unknown.

### 2.1 Unit pipeline and review

The normal path is prepare → conditional pre-build → build → quiesce/evidence/salvage/teardown → lanes → gate →
candidate → ff → snapshot → retire. Repair reproduction precedes building when required. A pre-build stage remains in
the state machine as an annotation boundary; an unmarked unit goes directly to building. Check failures and gate
revisions feed bounded fix rounds. Judgments have fresh contexts, with durable captured input identities. A gate
approval pins the commit, spec, contract/requirement and routing inputs that publication must still honor.

The five recorded roles are build, verifier, packReview, experienceVerdict and campaignAudit. Verifier modes are
pre-build, gate and diagnosis. Experience modes are walkthrough and polish. Role/model prompt modules are explicit and
validated against strict output schemas. Shared testing, persistence, redaction, cluster-proof, UI and performance
method modules are selected mechanically from role, traits, unit kind, markers and lane properties.

Builders ground first and report `grounding:{specWrong,touches}`. A wrong spec raises a blocking root item. Top-level
`tooBig:{estimate,suggestedChildren}|null` proposes decomposition; it does not split the plan. Build reports also carry
summary, blockers, experiments, notes and final; structured decisions come from captured decisions.json. Builders run
targeted development checks; code performs full certification. No worker may weaken a test merely to make a lane green.

Conditional independent review uses:

| Marker | Mechanical evidence |
|---|---|
| M1 | Declared persistent/redacts system traits; actual gate reach and builder touches provide a backstop |
| M2 | An active delivered obligation has absent witness/ids/lane, later cadence or environment-backed proof |
| M3 | Linked obligations edited/disposed/split, or cited pinned rule text changed/retired since review |
| M4 | At least 8 builds or 20 judged build/lanes/gate attempts |

`review:always|never` is the root override. External witness class alone does not trigger M2. Pre-build findings annotate; a failed annotation call does not hold a unit. Each finding becomes a standing item the
gate enforces, so pre-build raises only a concrete defect in a plausible implementation, a spec/contract conflict or a
witness gap admitting a plausible wrong build; sound work gets none.
The gate requires each standing item addressed or rebutted with evidence. Diagnosis produces a kept build note and
moves subsequent mixed-profile builds to Claude. Attempt counts include interrupted and uncharged work and follow
re-entry lineage. At a boundary, 16 builds or 40 judged attempts hard-park with attempt-cap. These thresholds are fixed
code constants, separate from configurable chargeable/revise/candidate/retry/deadline limits. Steer does not reset them. `review:never` suppresses diagnosis and its fallback marker, but not attempt caps.

The gate judges actual reach against intent/nonGoals and acceptance, requirement witnesses, failures and standing
items. Its findings retain severity, evidence, premises, experiments and optional defect classification. It refuses
unsubstantiated re-raising of settled findings. Later rounds retain finding identity, disputes and changed-file premise
checks. Large diffs use bounded inline/attached evidence and cluster coverage, with routing escalation where required.
Executable witness presence and bounded mutation smoke precede gate in applicable arcs. Surviving/inconclusive mutants
are explicit evidence, never silently treated as proof.

Each judgment role (verifier, campaign audit, pack review and experience verdict) gets one repair turn after an
invalid structured answer, resuming its own session/schema/cwd with every refusal reason. A second invalid answer takes
the role's normal failure path; this does not grant another independent judgment.

Certification reds (red, not-certified, witnesses-missing) have an uncharged allowance: with defaults, the first three
return evidence without charge, the fourth charges and resets it; any charge resets it. Chargeable bound defaults to
three. Gate revisions and candidate reds keep their separate bounds. `witness-check --lane-file` runs exact declared
witnesses in the builder checkout: exit 0 only for passing required records, 78 for missing/failing ids. Executable
presence and bounded mutation checks precede judgment, rather than relying on the judge to infer test execution.
Fresh sessions after prior work receive code-built handover (diagnosis, gate/findings, unmet clauses, witnesses,
decisions, report and evidence), bounded to ten recent history items per list.

### 2.2 Scheduling, systems and resources

Waiting is measured per request in memory at each arbiter tick: one total and independent simultaneous reason
totals (CPU pressure, memory pressure, tokens, named resources, publication slot, queue precedence). Completed
reservations persist those totals on the reserve transition. Scheduler admission holds use the same accumulation,
including dependency/contingent/milestone, baseline, review and repair-batch holds, recorded at stage admission.
Status and summary share the completed totals per unit-stage and job-stage; live blockers remain in sched.json.
Old grants without measurements are unmeasured, warned once; crashes discard in-flight timing and exclude downtime.
CPU-window and latest-memory evidence are independent, with a combined pressure wrapper for existing hold callers. Only positive workload CPU (a calibrated request or build/lanes/candidate stage) arms CPU braking; classification survives run/cleanup/replay until release, and pending reserves count. Judgments alone leave first-workload progress available. Memory saturation blocks workloads independently, including the first workload.

Units form a dependency DAG. Dependencies require actual merged/retired lineage state; contingent edges require an
explicit resolve-edge with evidence. Priority, origin and aging order waiters. Repair and deflake work can take precedence;
polish has its own origin. Admission reserves all named resources and CPU atomically before workload startup. CPU
reservations use calibrated observations where available. Host CPU pressure, memory PSI and available RAM participate in
admission backoff. Starvation handling remains code, independent of any agent optimizer.

Every unit requires nonempty known systems. SystemsMap declares path/test membership, shared dependents, contract
consumers and dependency relationships; optional persistent/redacts traits trigger review methods. Systems describe
responsibility and impact, not exclusive write rights. Paths outside unit systems become neutral gate reach input.
Phase 0 reports overlaps as advisories. It also advises possible future-witness vacuity when all declared witness files already exist, and spanning proof when multi-unit delivery lacks a candidate/batch lane covering its systems. These are read-only smells, never admission holds; baseline execution determines actual vacuity. A central protectedPaths definition guards roadmap and same-repo pinned corpus
files during salvage, transient validation and recovery. Evidence patterns cannot hide protected paths or tracked files
of a unit's systems. Unmapped paths select checks conservatively.

Resources have probe/teardown commands and optional pools. Probe exit 0 means free, 10 this label, 11 foreign/unlabelled;
other exits are faults. Pools lease one instance by resource name. Labels identify the workload. Startup refuses every foreign undispositioned residue until cleaned or isolated;
a readable own-arc journal permits recovery of its residues, with the dirty instances withheld meanwhile. Environment declarations can power resources and have lazy up/down plus idle lifetime; plain
probed environments have no executor-managed power lifecycle. Resource teardown and workload quiescence precede release.
New resources for a spike cannot be admitted mid-arc without owner resolution.

Admission rechecks pause, draining mutations, backend/recovery and other readiness constraints before prepare,
reproduce, pre-build, build, lanes, gate and candidate. The post-build quiesce/evidence/salvage/teardown chain and green
ff/snapshot chain finish despite pause/drain, so resources and publication cannot be stranded halfway through.
Reservations are all-or-none, in global order: resource/pool name (instance number), CPU token number, integration-slot.
Over-capacity requests refuse at load/apply; release follows confirmed cleanup. The publication holder keeps the slot
through ff/snapshot. Docs publications outrank units and may preempt a candidate before green; red, preempted and
finding-blocked candidates abandon and release resources before waiting again.

Retryable parks name backend/host/resource/environment targets; operator parks require a root action. Probes coalesce
by target, start immediately and back off 1/2/4/8/16/30 minutes, capped at 30. At six hours, a unit park or residue raises
non-blocking park-escalated while probes continue. Repeating a recovered target within six hours becomes operator
env-blocked. Usage-limit parks dominate retryable backend parks and need explicit backend resume. Backend/recovery
holds retain their cause and do not advance the held stage. Ordering parks emit unparked once every blocker merges.

CPU defaults are judgment 1, build 4, lane build 2 and other lane cadences 4. Explicit values win; after three completed
samples of at least 30 s, use ceil(p90 of the last ten), floor 1, cap at the default. Host admission uses CPU wait ratio,
memory PSI and low available RAM; judgments bypass the pressure brake and one workload always progresses. Pressure
charging/holds distinguish starvation from product reds and are bounded at 30 minutes; not all job paths participate.

A unit-confined throw is settled like recovery, then parks uncharged executor-fault with stack. Only audit/walk/baseline
jobs have analogous job containment. Open shared-state operations or a held publication slot make faults fatal, as do
unsupported job/loop faults; supervisor recovery remains bounded at three crashes/hour.
Managed environments transition down → starting → up → stopping → down. Interrupted/failed transitions settle down
before another up; a failed up/probe yields retryable env-unavailable, never lane red. Idle expiry, pause-all and stop
bring unused environments down; failed down raises env-blocked. Plain environments only probe.

### 2.3 Root commands and revisions

The parser in src/input/cli.ts is the exact surface; the skill reference lists every form. The root uses one input edit
path: inputs export → edit → apply --from DIR --rev N --reason LINE. Export includes current kept inputs and
`export.json:{planRev,specRevs,base}`. For each edited file, in-force bytes must still match the exported base; untouched
files take the latest bytes. All stale files are reported together. A changed existing spec auto-bumps to current rev + 1.
There is no field merge or implicit incorporation of arbitrary authoring-directory edits at restart.

Apply retains frozen-contract/obligation checks, proof judgments, split no-drop text, vision citations, risk floors and
milestone/dependency conservation. Reason authorizes an intentional disposition and is stored with revision provenance.
Contract behavior changes land through gate-reviewed units. Plain ledger edits do not patch product contracts. The C-n
ledger remains exported root text; existing rulings/cites.rulings/debt resolve.ruling fields still refer to it.

Revision payload is kept before activation under the revision fence; queued root applies wait for safe stage boundaries.
Recovery preserves queued/applied receipt provenance and subject closure. Executor revisions use CAS/retry and a
non-blocking revision notice. Root apply itself does not automatically produce that executor notice.

Steer accepts any unfinished unit, cancelling/quiescing active work, saving its pre-steer state and running a directed
round with explicit editing budget. A green result parks for root review unless resume is requested. Optional class
changes are routing revisions. Note keeps a brief for the next build round without cancellation. Witness records an
explicit pass/fail attestation for an external-class obligation at the submitted integration head. Changed evidence or
head refuses; failure reopens the delivering lineage. Resolve-edge, run-only, merge-in, audit and close-admissions handle
readiness and lifecycle. Pause/resume/stop/sweep control execution without rewriting its state by hand.

Needs-user items are durable and have unit/arc/host subjects. Successful actions close the subjects they resolve. Ack
is permitted when options are offered or the item is a pack-review; any supplied choice must be offered. It is not a generic dismissal
for optionless spec/evidence/backend items. Revision notices and waste findings are non-blocking.

### 2.4 Observation and owner check-ins

Full status is a read-only authoritative projection of run/owner/heartbeat, plan/routing, units and invocation/lane
progress, resources/waits, spend, findings, obligation observations/census, timings, milestones, demo and completion.
There is no single-flight status lock. TUI reads the same records with bounded observation; it never controls admission.
Actionable watch wakes the architect on durable work/questions, death or timed check-ins and returns a sequence cursor.

Summary is compact JSON: progress, spend/expectations, milestones, caught, verdicts, captures, needsUser, waste, demo and
completion. Optional plan.expectations arcUsd/perMilestoneUsd are forecasts, never limits. Caught is lane-red count plus
gate-revise count plus unique finding keys, with byLens classification; it is not independent-defect or cross-seat
unique-catch attribution. Milestone spend includes member/re-entry/polish units and walkthrough/polish jobs, not a complete
allocation of all arc costs. Capture projection currently lists suite capture spawns, not all screenshots.

Four evidence-based waste detectors advise on grinding, regressions green at base, low unique-catch lanes and repeated
expensive suites. Replay-safe cause keys prevent duplicate items. They do not change the plan. Meter, stage-outcome,
proc.spawn and lane-reused remain the efficacy feed. Job verdict stage-outcome has job/milestone/verdict/finding counts
instead of a unit attempt/outcome. Codex usage preserves tokens and native prices; missing USD uses a routed-model price
table and flags estimates. Aggregate data cannot reconstruct long-context pricing, so estimates use standard rates.

The canonical brief is the delta across the chain since the last committed ack coverage vector. Its entire canonical
payload hashes to briefId; Markdown renders from those bytes. Coverage includes arc/snapshotCommit/highWater, not a wall
clock. The owner receives slice, decisions/departures, curation, questions/assumptions, debt, census, timings, PR and demo.
A stale ack id refuses. Ack publication uses a write-once pending marker committed by rename and replayed after crashes.
It advances acknowledged coverage and the chain bound, not optionless runtime item resolution. The architect supplies a
short preface, then ends the check-in turn. Owner answers are written immediately to the answer log and applied to inputs
when they affect this arc.

### 2.5 Campaign audit and findings

At reached milestones, on root request and over the final outstanding range, one fresh campaignAudit role reviews
invariants, vacuity, cross-unit interaction and document drift. It reports findings and root requests only. Bounded diff
chunks, kept inputs, partial coverage and abandoned-job backoff make large-range review recoverable. Internal coverage
and finding classifications retain lens names; these do not select multiple seats or configurable rolling audits.

Findings have stable identity, severity P1/P2/P3, evidence and optional obligation/vision attribution. Vacuity evidence
uses a reproduced mutant where required. P1 blocks relevant publication until repair or dismissal. Only the root may
disposition obligations. Root repair units name the finding/obligation they repair; repair publication resolves ownership.
`dismiss F-n --counter-evidence "<line>"` dismisses an active finding, including P1, with non-empty counter-evidence.
A `finding-dismissed` fact records command id, evidence and the root's `{role,routingRev}`; the fold moves it to
ruled/dismissed. Unknown and settled findings refuse; replay of the same command resumes closure/receipt without a
second fact. Finding-subject items close only when every named finding settles; unrelated arc items stay open.
Dismissal suppression uses existing settled-finding refusal: the same key cannot reopen unless a cited blob changes.
Campaign requests with dismisses/counterEvidence are surfaced to the root, never applied automatically. Reproduction
can also dismiss a finding code proves not reproduced.
Close-out may bank substantive remaining P2 debt and release eligible lower findings, with durable facts and explicit
provenance. Gate notes also bank debt. Neither debt nor a note substitutes for a required witness.

### 2.6 Memory and target changes

Salvage messages retain the captured build summary and decisions; candidate messages concatenate round memory, and
repair batches include all members. Preparation reads verified evidence bytes, so recovery recreates the exact same git
object rather than depending on mutable live output. Clean-worktree builds retain their reports too.

Configurable systemNotesDir defaults to docs/systems. Build/gate get sorted paths of existing `<system>.md` notes from
their checkout commit. Notes carry gotchas, seams and rigs; their edits are ordinary gated unit diffs. They never make
normative claims binding. The corpus remains the source of target truth, and owner-confirmed vision changes use normal
committed/re-pinned exported CAS revisions.

### 2.7 Plan, specs and certification lanes

A plan selects exactly one target arm: corpus/pin + Phase-0 record + holistic slice, or architectureDoc with optional
digest/holistic vision. Fresh holistic starts require corpus even though the parser retains an architecture-doc holistic shape. Plan/spec literal schema names retain their original
identifiers; runtime records carry version 2. PlanPaths resolve beside the plan; RepoPaths in the product. Specs require
intent, nonempty nonGoals, stable acceptance/check/decision/fact ids, resources and cites. Optional root-authored design
records, requirement/contract pins and witness items retain executable design checks. Derived entries only declare
sources/outputs and optional regeneration; they grant no write exclusion.

Lanes declare argv/cwd/env, expected exit, cadence, resources and evidence outputs. Explicit inputs filter ls-tree for
reuse; otherwise systems supply the input set. Execution identity, environment, certificate and evidence metadata also
bind reuse. Spec cadences are build/unit/candidate; suite also permits batch; arc witness is build/candidate. Contextual
validation refuses expensive or explicit whole-repo inputs at build/unit cadence. Local expensive checks run on the
candidate tip with attribution. Shared/cross-system checks use batch cadence and milestone selection. Batch suites still
run at batch points without milestones and all run at close-out. Time estimates are not a lane field.

A confirmed repeating red is not diagnostically rerun; a suite lane identical to a spec/arc lane runs once where
execution identity matches. Lanes have explicit wall timeout reds, separate from the six-hour runner backstop.
Repeated reds compare at diffBase: green on base supplies charged regression evidence, red on base uses the base-red
protocol. Fix rounds receive actual failing and passing evidence locations, including original evidence after reuse.
Spec-candidate reds return to their delivering unit. Stochastic k-of-n lanes do not enter flake handling; same-commit
ordinary flakes retain their ledger, bounded forgiveness and automatic deflake units/code edges. Deflake verification
has lane-minute budgets. Known defects hold affected work uncharged until the named fix lineage merges.

Capture lanes lease a declared pool/port and contain stack plus repo capture script together, require declared PNG
states, and pass relevant captures to milestone design/member gates. External-class arc lanes are attested by the root
with head-bound file/URL evidence; there is no output-matching seal. Witness presence requires exact test ids/files and
passing per-test records. Mutation smoke is bounded and classifies survivors explicitly. Completed lane history requires
the writer's final host marker; partial crash artifacts supply no reusable completed evidence.

### 2.8 Vision, corpus and obligations

The confirmed vision has stable V-n clauses (world, purpose, serves, good, non-negotiable, tradeoff, experience), ranked
tradeoffs, withdrawn history and Q-n questions with working assumptions. At least one active world clause is required.
Corpus confirmation hashes the exact pinned vision document. Phase 0 selects active advances including a world clause;
coverage distinguishes the slice from the rest of the horizon.

Corpus guides describe same-repo/other-repo/checkout source and included files. Normative T-n rules have global ids,
one claim per line in rules fences. Equivalent rewording keeps identity; changed meaning retires the id. Pin/regeneration
checks detect drift and reuse. Curation records structural/fact-currency edits, reversible semantic decisions citing the
vision, and ranked P-n questions when the vision is silent. Every recorded owner answer must be applied with exact text.

Obligations bind rule or document anchors, statements, serves, witness/test files, proof judgments, deliverers,
activation and contract/system impact. Existing properties are must-hold; future properties latch when delivered and
observed held. Mapping uses system, not file patterns. A proof binds obligationRev plus testIds/files, so moving a lane
without changing proof identity is a re-witness. Intentional weakening/disposal requires a root reason and revision;
waived/deferred/retired states store those fields. Split parents have children and null witness/proof. A census assigns
each active rule obligation/out-of-slice/untestable/prod-only; specs cannot quietly deliver an out-of-slice rule.

Phase-0 pack review verifies target-to-rule-to-census-to-spec-to-witness agreement and plan quality in a fresh context.
Admission waits for the review to end. Its open blocking unit findings hold their targets and transitive dependents
through effective `after` edges (lineage preparation included); contingent conditions retain their ordinary readiness
checks. Any blocking obligation/census/rule/plan target, or an abandoned review, holds admission arc-wide. Scoped holds
persist after unrelated units start. One arc-subject item names the held units and dependents count or the arc-wide
scope; acknowledgement (even with no options) or a superseding review releases it (K14). Scheduler and status share
one scope calculation; held units name the item in their blocking-item wait, and only arc-wide scope appears in arc
`holds`. Material pack revisions before first admission get delta review. Approved
estate compaction decisions apply as normal validated corpus/obligation/ledger/debt edits, never special runtime writes;
the `estate-compaction` skill owns the record and provenance format.

### 2.9 Git artifacts and clean PRs

Product refs carry product changes and living roadmap docs, not runtime logs/evidence. Raw evidence stays in runtime;
refs/roadmap/<arc> carries only allowlisted records plus a SHA-256 manifest. Candidate-first merge creates a deterministic
candidate on the current integration tip. Publication checks approval/current requirements and exact target tip before
fast-forwarding; if the tip moved, it retries certification rather than publishing a different head. Repair batching
preserves member evidence and attribution. Document publication uses the same exclusive slot and can preempt a candidate
uncharged; no side effect precedes its intent. Snapshot publication/retirement follows the actual published head.

### 2.10 Completion

Running arcs can be paused, parked or draining. Close admissions stops expansion while existing work settles. Completion
requires terminal units, settled milestones and final campaign coverage, required witnesses/batch lanes and close-out
publications. Arc-completed binds plan revision, integration head and high-water; later legitimate revision can reopen
an active completion. Sealed snapshots remain verified historical evidence. No outstanding P1 is quietly released.

### 2.11 Chaining

The owner chooses chain.k; acknowledged briefs define the bound, not elapsed time. Normal chained plans name
previousArc/previousHead and use the previous completed arc's verified head or permitted single-parent between-arc commit.
Corpus/config/vision/debt handling is validated before another start. Stacked PRs target the preceding arc branch;
superseding a prior open PR is explicit. A foreign predecessor is expressed as top-level previousHead plus baseline,
without chain; no preceding schema-2 ref is required. Open abandoned work is manually recorded as Phase-0 debt.

### 2.12 Milestones, experience and demo

A milestone is the smallest usable end-to-end surface, not merely a group of files. It names members, design unit or
supplied references, selected integration lanes, resources, bring-up and journeys. Design references define the interface,
quality floor, error voice and user/client tasks; later milestones extend the same language. Design units precede member
work. Reference text is bounded to 512 KiB. Browser tooling is installed/configured by the environment and handshake-checked.

After units retire and selected lanes run, one experience verdict brings up the product and walks browser/shell journeys.
A break is a defect whose later fix forces rework of dependents: a product action that fails so the journey cannot
complete, a wrong interface contract consumers build on, or a measured violation of a declared floor. Everything else
(copy, visuals, diagnostics, stale docs against a correct interface) deviates and never blocks. A journey's scope is
what its steps and references specify, including documented entry points and their error paths; unrelated setups are
out. Bounded walkthrough/polish rounds run in the same role with independent context; polish keeps a tweak only when
the after is better for the journey on both instances and nothing on it got worse, so a tie drops. Breaks hold
milestone dependents until settled. The demo keeper promotes settled milestones under code ownership; hold prevents
promotion/restart until release. Status/brief show location, promoted head and rough edges.

## Git truth and backend invariants

Merged means second-parent reachability in the integration history, not a branch name or optimistic status. Every unit
diff is `merge-base(integrationTip, branch)..branch`, recomputed after merge-in. Gate approval binds the exact commit,
spec and requirement/contract/routing fingerprint; publication rechecks it. A red candidate tests the pre-merge tip alone:
green there attributes regression to the candidate; base-red holds further merges until repaired. Transient validation
and protected-path/denylist checks still run at publication; approval does not excuse forbidden artifacts.

Backend outages come from structured CLI error results (`turn.failed`/error events), never strings in product command
output. Build/gate context-exceeded is uncharged operator-env work with prompt-size evidence. Codex receives the prompt on stdin,
uses `-C`, `--json`, `-o` and strict output schema, and runs danger-full-access inside the devcontainer. Resume is allowed
only with matching cwd/session; a session collision gets one retry as a new invocation of the same session/deadline after five seconds. These are adapter facts, not alternative
planning authority. Debt never mints a unit while admissions are draining; new work requires a later deliberate slice.

## 3. Routing and cost

Routing layers are builtin → repo-config → plan → unit. Seat values are classes; only class bindings name backend/model/
effort triples. Build has low/med/high, verifier adds escalation, and each arc role has arc. Efficient builds low/med,
frontier builds high and verifies/reviews experience/pack, summit audits. Economy is judgment-only. Default routes eligible
low/med builds to Codex; M2/design/high risk and M4 fallback use Claude. Persistent/redacts traits trigger verifier safety,
not Codex exclusion. Capture-only UI remains eligible. Claude-only routes every seat to Claude. Claude builds get a
frontier advisor. Effective fallback routing revisions preserve actor attribution; a profile switch mid-arc is supported.

No spend cap. Expectations are observations; usage limits are backend availability. Usage meters preserve partial tokens,
known/estimated cost and unavailable reasons. Missing USD can be estimated from the price table without making up native
billing. Reports must distinguish estimated spend and incomplete readings.

## 4. Validation and release

Typecheck and free tests guard typed readers, real-process/git recovery and behavior. Probe checks actual backend CLI
invocation; path-triggered role evals and fixtures run once per merged batch. CLAUDE.md specifies the ladder. Paid eval
coverage reflects current verifier/pre-build/experience/campaign roles; diagnosis-role eval is deferred pending field cases.
No assertion about cgroup-real passing is valid on a read-only cgroup host.

The free unit tier asserts typed readers/folds, exact git/evidence identities and real-process recovery. Crash matrices
use `crashPoint(label[@unit]:n)` to kill at each write-ahead boundary, then assert idempotent replay: no duplicate effect,
no live orphan, no falsely released reservation and no publication of untested heads. The production seam is the same
boundary hook used throughout recovery, not simulated success flags. Role evals grade catches, false blocks, dispositions
and method evidence with plants/controls; listing a plant file is not a catch. M4a's independent adjudicator grades the
retained target/plan/product/witness artifacts and the real-forge canary checks fixture isolation. Paid transcripts do not replace free recovery
assertions, and fake fixtures do not demonstrate week-long behavior.

Supervision uses actionable watch with a fixed 30-minute heartbeat. On each wake the root posts at most three lines,
reads status and the cited evidence, takes a supported lever if needed, then waits. Log every self-initiated intervention
and every arc-wide pause/resume/backend-resume/stop/close-admissions in the append-only external operator log. The root
never patches the plugin or run directory; on supervisor crash-limit it reports stderr/stack evidence to the owner.
Clocks/time zones are spec/testing guidance, not an executor mechanism that rewrites product clocks.

A 0.x `.roadmap/` layout is refused, never converted. This release is the one-off breaking exception to upgrade-in-place: runtime schema 1 is refused before claiming/recovering.
It must finish with the original executor; no adoption/default reader is promised. Subsequent releases return to the
standing upgrade rule. Version metadata changes in lockstep across plugin, executor/lockfile and both marketplace fields.
The previous-release regression names dev.32 and checks loud refusal before host claim.
