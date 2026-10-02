# Executor schemas and contracts (frozen in M1 step 1a; M2 additions in M2 step 0a; M3 additions in M3 step 0a)

The specification every later step compiles against, current as of 1.0.0-dev.6 (M3). M2's records and scheduling
interfaces are in place below and summarised in "M2: scheduling, resources, parks"; M3's are in "M3: the holistic
layer" at the end, whose later "Choices made in M3 …" sections state the rule where an earlier section is
superseded. Each schema names the TypeScript type and the
validator that implement it; if you change one, change the other in the same commit. Owner: the lead.
Other steps request changes rather than edit.

## Conventions

| Rule | Where |
|---|---|
| Every executor-written file and log line carries `v: 1`, the one constant `SCHEMA_VERSION` | `src/core/version.ts` |
| Serialisation is canonical JSON: keys sorted, no whitespace, finite numbers, no `undefined` | `canonicalJson` in `src/core/json.ts` |
| Every reader takes `unknown`, returns the typed value or throws `SchemaError{field, value}`; field paths look like `plan.units[0].risk` | `src/core/validate.ts` |
| Readers reject unknown fields. Optional fields are absent, never `undefined`; nullable fields are explicit `null` | `Fields.end()` |
| Sets written by the executor are arrays sorted ascending and unique; input sets (plan, spec) are unique in any order | `sortedBy`, `assertUnique` |
| Branded ids and values have one checking constructor each (`InvalidIdError` for ids) | `src/core/ids.ts`, `src/core/values.ts` |

## Record evolution (owner ruling, 2026-09-26)

Arcs run for days to a week and executor fixes land mid-run, so an executor update adopts an arc started on
the previous release and carries it on; it never forces a new arc and never refuses the previous release's
runtime state (event log, state cache, invocation files, needs-user, commands and receipts, host files) or run
inputs (plan, specs, ledger).

- A record change is additive. A field the previous release did not write gets a safe default at the read
  boundary, so the fold and the pipeline only ever see the new shape; the defaulting logs one warning per
  process per defaulted kind (`warnDefaulted`, on the executor's stderr, the supervisor's `supervisor.<token>.err`).
  Since M3 (G14) a record whose line is hashed or chained is read byte-preserving: the reader validates its
  canonical raw bytes with the new fields absent and returns it as written, and a helper in
  `src/core/upgrade.ts` normalises it where it is read, so a default never enters a hash, a chain or a comparison. An unknown value (say, a hash the old record never took)
  is typed as unknown, never filled with a fake.
- The defaulting code lives in one module marked as temporary scaffolding for arcs started on the previous
  release, and is deleted (with its BACKLOG entry) once none is in flight. It never rewrites a file.
- `SCHEMA_VERSION` is bumped only for a change that cannot be defaulted, and then the readers accept both
  versions for as long as an arc on the older one may be in flight.
- `test/serial/upgrade.test.ts` is the guard: it starts the M1 fixture on `PREVIOUS_RELEASE` (extracted with `git
  archive`), stops it mid-arc, and finishes it on HEAD. Move `PREVIOUS_RELEASE` at each release.
- Exception: arcs started before 1.0.0-dev.1 (a95355e, schema version 1 with the older dispatch, meter and
  spec shapes) are not adopted; they are adapted by hand. Hard cutover applies to 0.x layouts only.
- Defaults in force (src/core/upgrade.ts): `launch.json` without `stallMs` (1.0.0-dev.1) reads as null; an arc
  with no `plan-applied` fact (1.0.0-dev.3 and earlier) reads its plan file until its first start on this release
  records it as revision 1 (`earlierReleaseBaseline`: a unit with log state missing from plan.json refuses the
  start; a dispatched unit whose spec file changed since is recorded as that release ran it, at its rev as an
  `evidence` edit, at rev + 1 as a pending `revision`, at any other rev refused); until that revision a re-pin
  names the unit's spec, as 1.0.0-dev.3's fold took it; a spec such an arc dispatched but never kept is read from
  its file by a stage (kept when it still hashes to the recorded spec, warned either way), while the classifier
  refuses an edit it cannot compare with the recorded spec; a command `result.json` with verdict `process-fault` whose
  exit cause is `cancel` (1.0.0-dev.3 and earlier) reads as `cancelled{cancel.json's reason}`, and a re-run
  adapter keeps its bytes.
- A 1.0.0-dev.3 supervisor that respawns this release's executor passes no `--respawn`: the respawn degrades to a
  start, so edits made since are applied or refused (`plan-change-refused`, exit 78) rather than ignored.

**1.0.0-dev.4 → 1.0.0-dev.5 (M2).** `SCHEMA_VERSION` stays 1 and the plan literal stays `roadmap/plan-m1` (LR-1).
Every change is additive; the defaults live in `src/core/upgrade.ts` and each warns once per process:

| Record | Change | Read-time default for dev.4 state |
|---|---|---|
| `plan-applied` | `+ scheduling?: 'dag'` (rev 1 only, and only in a log with no `dispatch` fact) | absent on rev 1 → a legacy arc (`isLegacy`): dev.4's serial frontier (`legacyNext`, a port of `nextUnit` + `dispatchBlock`/`settledForAfter`, G4), no `@cpu` requests, a declared `cpu` stays a named resource, no over-capacity row for its existing requests; warn once |
| `plan.json` | optional `capacity`, resource `pool`, unit `origin`, `cpu`, `contingent`, `reenters`, `cut` | absent (`contingent` reads `[]`) |
| `LaneDef` | `+ cpu?` | absent → the tier's cost (`CPU_COST`) |
| `stage-outcome` | `+ park?`, `+ cause?`; stage `prepare` | `park` absent on a park → operator, `design` for the chargeable bound and the design outcomes (refusal, escalate, infeasible, risk-lowered, scope-widened, redirect, revise, malformed, empty-diff, red), `env` otherwise (`legacyParkRecord`); `cause` absent → an operator hold (pause, stop, or a dev.4 usage-limit hold) |
| New facts | `unparked`, `probe`, `judgment-inputs`, `edge-resolved`, `run-only`, `implementer-escalated` | none |
| `rerouted` | kept readable, no longer the resume's record | read as `unparked` (`rerouteAsUnpark`); warn once |
| `backend-park` | `+ class outage`; `inv` nullable (null exactly for `outage`) | none |
| `Holder` | `+ retry{unit, stage, attempt}`, `+ publication{unit, attempt}` | none |
| `resource.transition.resources` | `ResourceUnit[]` (lock order below) | a plain name is a named resource |
| `ResidueKey.resource`, teardown/probe `SpawnSubject.resource`, `fail` residues | `ResourceInstance` | a plain name is a named resource |
| `PlanChange` | `+ unit-cut`, `+ unit-reentered`; `PLAN_FIELDS + capacity`; pool edits are `resource` edits | none |
| `CommandBody` | `+ resolve-edge`, `+ run-only` | none |
| `NeedsUserReason` | `+ park-escalated`, `+ env-blocked` (both raised non-blocking) | none |
| `UnitState` (fold) | `status + cut, superseded`; `+ park, lastRecovery, buildTier, lineage, supersededBy` | derived: `park` from the parking fact, `buildTier` = the dispatch floor |
| `DerivedState` (`state.json`) | `+ backendParks, scheduling, resources, runOnly, resolvedEdges` | derived |
| Lane dir | `+ host.json`, `<lane>.rerun/` (M2 steps 0b, 4) | absent → null (lasting, no warning) |

**1.0.0-dev.5 → 1.0.0-dev.6 (M3).** `SCHEMA_VERSION` stays 1; the plan and spec literals stay `roadmap/plan-m1` and
`roadmap/spec-m1`. Every change is additive and byte-preserving (G14): nothing is rewritten, and each default
below is a helper in `src/core/upgrade.ts` (warned once per process) or a lasting absent-means-none encoding (no
warning). `PREVIOUS_RELEASE` for this update is be76132 (1.0.0-dev.5). A dev.5 arc runs with no vision and no
holistic layer, spends nothing new, and completes as in M2.

| Record | Change | Read-time default for dev.5 state |
|---|---|---|
| `plan.json` | `+ holistic?{vision, obligations?, audit?{every?, lenses?, wallClockMin?}}`, `+ limits?`; unit `+ routing?`, `+ limits?`; origin `+ repair` | absent: holistic off, the built-in bounds, no unit layer (lasting) |
| `spec.json` | `+ obligations?`, `+ repairs?` (non-empty when present) | absent: none (`specObligations`, `specRepairs`; lasting) |
| `plan-applied` | `+ source?, payloadSha256?, rulingsSha256?, obligationsSha256?, visionSha256?, publication?, routingProvenance?` | `source` from `command` (`revisionSourceOf`); no `rulingsSha256`: the ledger is read live (`rulingsFromLiveFile`) until the first M3 revision records it; no provenance: rebuilt (`routingProvenanceOf`, H7) |
| `apply` body (G15) | `manifest` gains `rulings{ledgerSha256, sidecars}, obligations, vision` (`RevisionManifest`) | a `PlanManifest`: the ledger live, no obligations or vision (`applyInputsOf`); bytes and `commandSha256` never rewritten |
| `DispatchRecord` (H15) | `+ transientRules?: 'm3'`, `+ bounds?: Bounds` | `transientRules` absent: dev.5's transient rules for the lineage attempt (`transientRulesOf`); `bounds` absent: `DEFAULT_BOUNDS` (`boundsOfRecord`, lasting) |
| `ApprovalFingerprint` | `+ obligationRevs?` (non-empty when present) | absent: none (`obligationRevsOf`); a fingerprint selecting no obligation is byte-identical to a dev.5 one (lasting, no warning) |
| Routing (G16, H7) | roles `+ lens, checkpoint` (seat `arc`); per-unit layers; `routingProvenance` per `plan-applied` | a non-holistic arc hashes the M2 table (unit roles only), so every dev.5 `routingRev` is unchanged; a dev.5 revision's provenance is rebuilt from its plan layer, start.json's profile and the repo config in force at it |
| `ResidueKey` / holder (G4) | `unit` or `job` (exactly one); holder `+ job{job}`; `ResidueState.holder` stage or job | a dev.5 key names its unit (it is a unit-owned residue as written) |
| `Holder`, `Parent`, `SpawnSubject`, `MeterSubject` | `+ docs{pub}, batch{finding, attempt}, job{job}`; `+ job{job}`; `+ arc-backend, journey, mutant`; `+ job{job, role, tier}` | none |
| Op kinds | `+ docs.commit, mutant.apply, revision.commit`; `integration.ff` `+ subject?` (docs or batch, then no `fingerprint`); `candidate.merge` `+ batch?` | `subject` absent: a unit `ff` (the dev.5 shape) |
| `stage-outcome` | stage `+ reproduce`; candidate `+ preempted, finding-blocked` | none |
| Cancel and kill reasons | `+ preempt` (lanes only: `LANE_INTERRUPT_REASONS`) | none |
| New facts, `CommandBody`, `NeedsUserReason`, `Role` | "M3: the holistic layer" | none |
| `UnitState` (fold) | `+ bounds` | derived from the latest dispatch record |
| `DerivedState` (`state.json`) | `+ holistic` (`HolisticFold`) | derived |
| `residues.jsonl` | `+ compacted` head, archives (A5a) | none: an uncompacted index has no head |

## Owner rulings on model ids (DESIGN-1.0.md §4, Routing profiles)

1. `launch.json` is the only executor-written file allowed to contain a model id, and only inside `argv`.
   Its `terminal` names `{role, routingRev}` and the backend, never the model or triple.
2. The `state.no-model-ids` test scope is: the event log, the state cache, needs-user files, receipts,
   residues, the snapshot ref, `status` output and meter facts. Startup rejections shown in `status`
   therefore name the seat (`role`, `tier`), routing layer and model class, never the model.

Model ids appear only in the model and class catalogues (`src/routing/models.ts`, `src/routing/classes.ts`) and
in a repo's class rebinds (`.roadmap/config.json` `routing.classes`). Built-in profiles, `routing.seats`,
`plan.routing` and per-unit route layers name model classes (owner ruling, arc-1 feedback item 9).

## Input contract

**CLI** (`src/input/cli.ts`: `parseCommand(argv): Command`, `parseStartArgs(argv): StartArgs`). Options are
`--name value` or `--name` switches, each at most once; anything else is a `CliError`.

| Form | `Command` |
|---|---|
| `--version` | `{command:'version'}` |
| `start --repo <path> --plan <plan.json> [--profile default\|claude-only] [--wait <ms>]` | `{command:'start', args:{repo, plan, profile, waitMs}}`; `profile: null` when absent, so `selectProfile` lets `.roadmap/config.json` choose (explicit flag > config > `default`); `waitMs: null` when absent (`START_WAIT_MS`, 240 s; step 14b) |
| `status`, `watch`, `stop` `[--repo <p> --arc <a>]` | `{command, run: RunLocator}` |
| `pause (<unit> \| --all)` | `{target: {type:'unit',unit} \| {type:'all'}}` |
| `ack <needs-user-id> [--choice <option>]` | `{id, choice \| null}` |
| `resume [<unit> \| --backend claude\|codex]` | `{target: all \| unit \| backend}` |
| `sweep [--resource <name>]` | `{resource \| null}` |
| `apply [--expect-rev <n>] [--dry-run]` | `{expectRev: PlanRev \| null, dryRun}`: `--expect-rev` is a positive integer |
| `resolve-edge <edge> --evidence <text>`, `run-only (<unit>... \| --clear)` (M2) | `{edge, evidence}`, `{units \| null}` |
| `rule <record.json>` (M3) | `{record}`; the CLI queues `rule{path (absolute), sha256}` of the file's bytes |
| `reverse <D-n>` (M3) | `{divergence: DivergenceId}` |
| `steer <unit> --brief <f> --budget <min> [--class efficient\|frontier\|summit] [--resume]` (M3) | `{unit, brief, budgetMin (positive), class \| null, resume}`; queued with the brief hashed like a rule |
| `merge-in <unit>` (M3) | `{unit}` |
| `audit [--lens <k>[,<k>…]]` (M3) | `{lenses: LensKind[] (ascending, unique) \| null}` |
| `close-admissions` (M3) | `{}` |
| `gc --repo <path> [--keep <K>] [--dry-run]` (M3) | `{repo, keep \| null, dryRun}`: a host action with no run locator, not a queued command (step A5b) |

`RunLocator = {type:'host'}` (the host lock claim's `runDir`) `| {type:'explicit', repo, arc}` (`--repo` and
`--arc` together). Paths are returned as given; the caller resolves them against its cwd.

**Run dir** = `runDir(gitCommonDir, arc)` = `<absolute git common dir>/roadmap-runtime/<arc>`. The caller runs
`git rev-parse --path-format=absolute --git-common-dir`; `cli.ts` makes no git call.

**`plan.json`** (`PlanM1`, `parsePlan(unknown)` in `src/input/plan.ts`). All fields required unless marked.

| Field | Type | Notes |
|---|---|---|
| `schema` | `'roadmap/plan-m1'` | |
| `arc` | `ArcId` | |
| `integrationBranch` | `BranchName` | ref `refs/heads/<name>` |
| `baseline` | `Sha` | ancestor of the integration tip (startup row) |
| `worktreeRoot` | `AbsPath` | not tmpfs, writable (startup row) |
| `contracts` | `RepoPath[]` | product-tree paths |
| `rulings` | `PlanPath` | the C-nn ledger (format below) |
| `architectureDoc` | `RepoPath` | |
| `architectureDigest?` | `RepoPath` | the owner-approved digest of the architecture doc (section index + normative sentences with line anchors); when present, judgments embed it and read the whole doc from their checkout on demand |
| `direction` | non-empty string | the Direction text |
| `routing?` | `RoutingLayer` | the `plan` routing layer: a class per seat; a triple or a `classes` key is refused (a plan cannot rebind a class) |
| `capacity?` (M2) | `{cpu?: positive}` | the `@cpu` pool's size; absent: `availableParallelism()` |
| `suite.lanes` | `LaneDef[]` | executor-only suite lanes |
| `resources` | `ResourceDecl[]` | `{name, probe: ToolCommand, teardown: ToolCommand, pool?: {size: positive}}`; `integration-slot` is built in and may not be declared. A pool (M2) has instances `<name>#1..size`; a request by name takes one; each workload of the holder gets `RESOURCE_INSTANCE_<NAME>=<n>` (upper case, `-` → `_`), persisted in `launch.json` `env` and the residue's teardown recipe |
| `units` | `PlanUnit[]` (non-empty) | a unit entering the plan (a fresh arc's rev 1, a unit a revision adds) may not take an `id` of the form `batch-<digits>`, `jobs` or `mutants` (`reservedUnitIdReason`: a `plan-change-refused` reason, not a schema rule, so an adopted arc's units keep their ids; M3: a repair batch's candidate ref `refs/roadmap-run/<arc>/candidate/<batch-n>` shares the units' candidate ref namespace, and `<runDir>/evidence/<unit>/` sits beside `evidence/jobs/` and `evidence/mutants/`). `{id: UnitId, spec: PlanPath, risk: RiskTier, scope: RepoPattern[] (non-empty), resources: ResourceName[], after?: UnitId[]}`; `after` (parsed as `[]` when absent) names units earlier in plan order, never the unit itself, each once: the unit is not dispatched while any of them is neither merged nor parked with its needs-user acknowledged (arc-1 feedback item 17; since M2, merged only, D1, except in a legacy arc). M2 optional fields: `origin?: planned\|checkpoint`, `cpu?: positive` (build `@cpu` tokens, default 4), `contingent?: [{id: EdgeId, condition}]` (read as `[]`; ids unique across the plan), `reenters?: {unit (earlier in plan order, not itself), enterAt?: plan-check\|build\|verify, reset?: {ruling: RulingId}}`, `cut?: {reason, ruling?: RulingId}` |
| `holistic?` (M3, A5) | `{vision: PlanPath, advances: V-n[] (ascending, non-empty), obligations?: PlanPath, audit?: {every?: positive, lenses?: LensKind[] (ascending, non-empty), wallClockMin?: positive}}` | present exactly when the arc runs the holistic layer; `vision` names a `roadmap/vision-m3` file, `advances` the slice of it this arc moves toward (active clauses of the vision, at least one `world`; checked at startup and on every classified revision, `advancesReasons`; owner-only: only an `apply` changes it, `PlanChange` `advances`; the other active clauses are the horizon), `obligations` a `roadmap/obligations-m3` file (absent: none); `audit.every` N (default 5, D3), `audit.lenses` the required lens set L (default all four, H9, `lensSetOf`), `wallClockMin` (default 360). An apply may add it, never remove it |
| `limits?` (M3) | `{chargeable?, redirects?, reviseRounds?, candidateReds?, retries?, judgmentDeadlineMin?, freshBuildMin?, editAllowanceMin?, convergenceK?}`, all positive | the units' bounds over the built-in ones (`DEFAULT_BOUNDS`: 3, 2, 2, 1, 1, 45, 180, 60) and the arc's convergence K (default 3); a unit's own `limits` (same fields but `convergenceK`) override them (`boundsOf(plan, unit)`). Unit M3 fields: `routing?: RoutingLayer` (the unit layer, `route` and `steer --class`), `limits?`, and `origin: repair` (needs a spec with non-empty `repairs`) |

`ToolCommand = {argv, cwd: RepoPath, env: LaneEnv}`, run from the repo root. Probe exit contract
(`PROBE_EXIT`): `0` free, `10` occupied under this unit's own label, `11` unlabelled or foreign; any other exit
is a probe process fault. A probe and a teardown get the unit's owner label `<arc>/<unit>` in `RESOURCE_OWNER`
(step 10), and so does an implementer call (a build runs the unit's tooling); a judgment call and a smoke do
not (they hold no resource). A residue records the teardown resolved with it. `parsePlan` checks shape and in-file uniqueness only; references that need the
filesystem, git or specs are startup rows.

**Rulings ledger** (`src/spec/rulings.ts`): one ruling per line, `C-<n> — <rule>`, rule text only; provenance
lives in the in-tree `constraints.md`. A superseded or withdrawn ruling folds to `C-<n> — withdrawn by C-<m>`,
where `C-<m>` is in the same ledger. Blank lines and `#` headings are skipped; any other line, or an id listed
twice, is refused. A withdrawn ruling is never embedded in full: prompts show its fold line in the index.

## Startup rejection table

`src/preflight/startup.ts`: `StartupRejection` (one member per row), `exitCodeFor(rejection)`,
`StartupCheck<K>{kind, check(StartupContext) → rejections[]}`. Each refuses before any pipeline intent and is
shown in `status`: a refused start (exit 78) writes `status.rejection.json` in the run dir (`RejectionFile
{v, at, rejections}`, reader `rejectionFile`; step 13b), removed by the next start that passes. Order of evaluation (lead ruling, 1a; 14c): the pure and host rows run first, before the journal
is opened; `backend-smoke` runs last, after host takeover, journal open, `executor-started` and recovery (which
closes a smoke spawn a crashed start left open, like any other spawn), and its spawns are journaled as
`proc.spawn{purpose: smoke}` so a refused start still leaves an audit trail. `runChecks` is every row but the
smoke; `smokeCheck` is the smoke. "Before any intent" therefore
means before any *pipeline* intent.

| `kind` | Row | Fields | Exit |
|---|---|---|---|
| `legacy-roadmap-dir` | in-tree `.roadmap/` beyond `contracts/`, `constraints.md`, `invariants.md`, `debt.md`, `config.json` | `path, unexpected[]` | 78 |
| `worktree-root-unusable` | `worktreeRoot` on tmpfs or not writable | `path, problem: tmpfs\|not-writable, detail` | 78 |
| `spec-lane-unrunnable` | lane `argv[0]` unresolvable, env prerequisite missing, estate lane for the implementer; resource variant (lead ruling, 13b): a declared resource's probe or teardown `argv[0]` unresolvable or env prerequisite missing | `unit\|null, lane, problem` \| `resource, command: probe\|teardown, problem` | 78 |
| `unsupported-routing` | a seat's class binds an unsupported triple (every Codex judgment triple) | `role, tier` (a seat), `layer` (that chose the class), `class, unit\|null, why: codex-judgment\|no-prompt` | 78 |
| `undispositioned-residue` | a host residue neither `cleaned` nor `isolated\|transferred` | `residues: ResidueKey[]` | 78 |
| `host-busy` | live host owner, or live recovery-lock holder | `holder: owner\|recovery, arc, generation, pid` | **75** |
| `previous-arc-unreconciled` | previous claim's arc has unreconcilable invocations (R18); durable needs-user | `arc, invocations[]` | 78 |
| `backend-smoke` | smoke missing or failed for a backend the resolved profile uses | `profile, backend, problem: missing\|failed, detail` | 78 |
| `plan-invalid` | schema invalid (plan, spec or rulings ledger; a `--plan` file that does not exist), unknown spec path, `integrationBranch` naming no local branch (a full ref or remote-tracking name is told to use the short local name), a branch at `roadmap` or `roadmap/<arc>` or an `integrationBranch` inside `roadmap/<arc>/` (git could not create the unit branches; the arc's own `roadmap/<arc>/<unit>` branches are not conflicts), baseline not an ancestor, unknown resource request, a spec cite naming no plan contract or no ledger ruling | `problem: schema{field,detail} \| unknown-spec-path \| unknown-integration-branch{ref, detail} \| unit-branch-conflict{ref, detail} \| baseline-not-ancestor \| unknown-resource \| unknown-cite{unit, cite}` | 78 |
| `recovery-holder-dead` | recovery lock held by a dead process; needs-user | `pid` | 78 |
| `owner-mismatch` | missing or mismatched owner metadata at takeover; needs-user | `detail` | 78 |
| `log-corrupt` | an invalid complete log line; host-level needs-user | `file, offset, detail` | 78 |
| `containment-mode-changed` | detected mode differs from the arc's recorded `containment-mode` fact | `recorded, detected` | 78 |
| `plan-change-refused` | a `start` whose plan.json or specs differ from the plan in force with a change the apply rules refuse ("Plan in force"); checked last in `runChecks`, once the journal is open. A respawn runs the plan in force and never asks | `reasons: string[]` (non-empty, every reason) | 78 |

A start checks the files (groups 1 and 2 read plan.json and its spec files); a supervisor's `--respawn` after a
crash, once one of its generations was ready, checks the plan in force and its kept specs instead
(`StartupContext.specOf`). A supervisor whose generations all crashed before readiness passes no `--respawn`:
its next generation is a start that reads the files, so an edit a crashed start had not put in force yet is
classified, not dropped.

## Ids (`src/core/ids.ts`)

| Type | Form | Derivation |
|---|---|---|
| `ArcId`, `UnitId`, `ResourceName` | slug: `[a-z0-9]`, inner `-`, 1-64 chars | `INTEGRATION_SLOT = 'integration-slot'` |
| `OpId` | `<arc>/<seq>`, seq = event-log seq of the op's first intent | `opId(arc, seq)`, `parseOpId` |
| `InvocationId` | `<op>#<ordinal>`, ordinal 1 = first intent, +1 per retry | `invocationId(op, n)`, `parseInvocationId`, `invocationDirName` → `<seq>-<ordinal>` |
| `SpecRev` | integer ≥ 1 (a branded number) | |
| `PlanRev` | integer ≥ 1 (a branded number) | the plan in force's revision: 1 for the first plan, +1 per `plan-applied` |
| `Sha` | 40 lowercase hex | |
| `Sha256Hex` | 64 lowercase hex | |
| `RoutingRev` | 16 lowercase hex | step 5: first 16 hex of sha256 over the canonical resolved `RoutingTable` (triples, after class binding: a class rebind changes it like a seat edit) |
| `SeatRev` | 16 lowercase hex | first 16 hex of sha256 over one seat's canonical resolved triple (`implementerSeatRev`) |
| `CommandId` | `cmd-<16 lowercase hex>` | minted by the CLI |
| `NeedsUserId` | `nu-<seq>` \| `sup-<generation>-<n>` \| `host-<slug>` | `needsUserIdForOp(op)`, `supervisorNeedsUserId`, `hostNeedsUserId` |
| `JudgmentSessionId`, `ImplementerSessionId` | lowercase uuid; **distinct brands** | resume APIs take only `ImplementerSessionId` |
| `LaneId`, `ClauseId` | letter then `[A-Za-z0-9_.-]`, ≤ 64 | |
| `RulingId` | `C-<digits>` | |
| `OpKey` | printable ASCII, no whitespace, ≤ 256 | groups ops that must not overlap |
| `PoolInstance` (M2) | `<pool>#<n>`, n ≥ 1 | `poolInstance(pool, n)`: instance n of a declared pool |
| `CpuToken` (M2) | `@cpu#<n>`, n ≥ 1 | `cpuToken(n)`; `@` never occurs in a slug, so `@cpu` (`CPU_POOL`) never collides with a declared name |
| `ResourceInstance` (M2) | `ResourceName \| PoolInstance` | what a probe, teardown or residue names |
| `ResourceUnit` (M2) | `ResourceInstance \| CpuToken` | what a `resource.transition` moves; `parseResourceUnit` → `named{name} \| instance{pool, n} \| cpu{n}`; `compareResourceUnits` is lock order |
| `EdgeId` (M2) | slug | a contingent edge's id, unique across the plan |

Values (`src/core/values.ts`): `AbsPath` (absolute, normalised), `RepoPath` (repo-relative, `.` = root, no
`.`/`..` segments), `PlanPath` (relative to the plan file's directory), `RepoPattern` (relative glob, no `..`),
`RefName` (`refs/...`, git check-ref-format), `BranchName`, `IsoTime` (`toISOString()` form), `GitDate`
(`<unix> <+HHMM>`), `BootId` (uuid), `Nonce` (32 hex).

## Event log (`events.jsonl`, `src/core/events.ts`)

**Line** = `serializeEvent(e)` = canonical JSON of `Envelope & LogRecord` + `\n`. `parseEventLine(line)` takes the
line without its `\n` and throws unless it is valid **and** byte-identical to its canonical form.

**Envelope** `{v:1, seq, prev, at, arc}`: `seq` from 1, contiguous; `prev` = `prevHash(previous line bytes)` =
sha256 over the previous line's exact bytes including its `\n`, `null` exactly on seq 1; `at` IsoTime; every op
in the line belongs to `arc`.

| Record (`type`) | Fields | Type |
|---|---|---|
| `intent` | `op, kind, key: OpKey, parent: Parent, ordinal, deadlineAt: IsoTime\|null, expect: OpExpect[kind], post: OpPost[kind]` | `IntentOf<K>`, `IntentRecord` |
| `done` | `op, kind, outcome: OpOutcome[kind], recoveredBy: null\|reconciled\|redone\|adopted` | `DoneOf<K>`, `DoneRecord` |
| `abort` | `op, reason: {code: precondition\|recovery\|cancelled, detail}` | `AbortRecord` |
| `fact` | `fact: Fact` | `FactRecord` |

`Parent = stage{unit, stage, attempt} | command{command} | op{op} | arc` (M3 adds `job{job}`).

| Fact `kind` | Fields |
|---|---|
| `tail-discarded` | `offset, length, sha256` (fragment file `events.torn.<offset>.<sha256[0:8]>`) |
| `containment-mode` | `mode: session\|cgroup` |
| `meter` | `inv, routingRev, subject: MeterSubject, usage: TokenUsage`; a seat subject's `(role, tier)` is the seat (`tier` is `low\|med\|high`, or `escalation` for a judgment role), so `(role, tier, routingRev)` names one seat and a by-model view is exact (lead ruling, 13b) |
| `usage-unavailable` | `inv, routingRev, subject: MeterSubject, reason: no-result\|absent\|malformed` |
| `dispatch` | `record: DispatchRecord` |
| `stage-outcome` | `unit, stage, attempt, outcome, class, chargeable, park?, cause?`: one per `(unit, stage, attempt)`; see below |
| `backend-park` | `backend, class: usage-limit\|capacity\|outage, inv\|null`: a failed invocation whose backend reported a usage-limit or capacity error parks that backend arc-wide (lead ruling, 11b); `outage` (M2, A18, `inv` null exactly then) is a failed smoke on a supervisor respawn. The fact's seq is the park's epoch (F12): see "M2: backend parks" |
| `needs-user-acked` | `id, command, choice\|null`: at most one per id, any id form; the file twin is `<id>.ack.json` (step 13) |
| `paused` | `command, target: unit{unit}\|all`: the durable pause marker the driver consults (step 13) |
| `stop-requested` | `command`: the durable stop marker (step 13) |
| `executor-started` | `generation`: written at every start once the journal is open; clears the stop marker (a stop ends one run, not the arc). Pause markers and holds persist until `resume` (lead ruling, 13b) |
| `plan-applied` | `rev: PlanRev, command: CommandId\|null, planSha256, specs: {unit: sha256}, changes: PlanChange[], scheduling?: 'dag'` (M2: only on rev 1, only in a log with no `dispatch` fact; absent on rev 1 = a legacy arc): a new plan in force ("Plan in force"): revision `rev` (1 for the first plan the arc ran, then one more each), the manifest of plan.json's and every unit's spec bytes (kept as `inputs/<sha256>.plan.json` and `.spec.json`), the apply that wrote it (null for a `start`) and what changed. An apply's postcondition, written once and last |
| `reopened` | `unit, command\|null, specRev, specSha256`: a unit re-opened on an applied revision of its spec (`specRev` = the unit's recorded spec rev + 1, hashing to `specSha256`, its `pendingRevision`): by `resume <unit>` of a unit parked at `plan-check` or `gate` (`command` the resume), or by the driver at an in-flight unit's next stage boundary that allows re-entry (`command` the apply that recorded the revision, null for a start). The unit starts over at plan-check as a new attempt: `decided` and `interrupted` null, `stage` plan-check, `status` active; counters, `routedUp`, `promotion`, `approval`, the branch, worktree and implementer session are kept; `redirectBase` = `counters.redirects` |
| `rerouted` | (written through 1.0.0-dev.4; read as `unparked` since M2) `unit, command`: `resume <unit>` re-entered a unit parked `routing-changed` (its latest decided outcome) once the routing in force resolves its implementer seat to the pinned `implementerSeatRev`, or no build has started; the command re-pinned it first (a `dispatch` fact under the rev in force, when that differs from the pinned one). `decided` and `interrupted` return to what they were before the park, so the unit re-runs the stage it parked at as a new, uncharged attempt; `stage` is that stage, `status` active; nothing else changes |
| `resumed` | `command, target: all\|unit{unit}\|backend{backend}`: `unit` clears that unit's pause and hold (refused by the fold while `pause --all` holds); `all` clears every pause and hold; `backend` clears that backend's park (refused unless parked) and the holds of units no pause covers. A cleared hold moves no counter: the next stage start is a new, uncharged attempt (step 13) |
| `approval` | `unit, attempt, fingerprint: ApprovalFingerprint`: the gate at `attempt` approved; recorded before its stage-outcome, read by the candidate and ff stages (step 12) |
| `unparked` (M2) | `unit, command`: `resume <unit>` of a unit parked operator-env; `decided` and `interrupted` return to what they were before the park, so the unit re-runs the parked stage as a new, uncharged attempt |
| `probe` (M2) | `target: ProbeTarget, covers: number[] (park seqs, and for a resource target the fail seq of its own-arc residue; ascending, non-empty), result: pass\|fail, nextProbeAt: IsoTime\|null` (null exactly on a pass): see "M2: parks" |
| `judgment-inputs` (M2) | `unit, stage: plan-check\|gate, attempt, tip: Sha, head: Sha\|null (the unit commit; null exactly for a plan-check), specRev, specSha256, planRev, routingRev, fingerprint?: ApprovalFingerprint` (M3 Checkpoint A: a gate's captured approval fingerprint, `unitCommit` = `head`; never on a plan-check; absent on a dev.5 fact): written before its spawn (F1); since M3 Checkpoint A under the fence BEFORE the attempt's entry reservation. One per started `(unit, stage, attempt)`: a later one replaces it only while no op or outcome started that attempt (its `@cpu` wait was cancelled). A recovered call is consumed against it (`gateRead` with `fingerprint`; absent: `fingerprintAt` at `tip`, warned) |
| `edge-resolved` (M2) | `edge: EdgeId, command, evidence` (non-empty text): `resolve-edge`; once per edge |
| `run-only` (M2) | `command, units: UnitId[] (ascending, non-empty)\|null`: the admission allowlist; null clears it |
| `implementer-escalated` (M2) | `unit, attempt, from: RiskTier (below high), to: high, stalled`: the fix round at build `attempt` runs cold on `build.high` because the round at build attempt `stalled` (< `attempt`) stalled (A11, G1); journaled before that round's implementer seat is chosen, only while `chargeableFailures < CHARGEABLE_BOUND` |

**`stage-outcome`** records one stage attempt's outcome as the transition table
(`src/pipeline/transitions.ts`, `outcomeFact`) decided it. `outcome` is one of `STAGE_OUTCOME_KINDS[stage]`
(every stage but `retire`, which is terminal). `chargeable` marks a design-class failure (the plan's C rows).
`class` is what the decision did to the unit: `advance` (on to another stage) \| `redirect` \| `revise` \|
`candidate-red` (a bounded round within its bound) \| `retry` (the stage's one uncharged retry; only at
`plan-check, build, lanes, gate`) \| `route-up` (re-dispatched on the role's `escalation` seat; only at `plan-check,
gate`) \| `trigger` (a risk trigger: the next judgment dispatch sits on the `escalation` seat) \| `hold` (exactly the
`interrupted` outcome, never chargeable: a pause or stop cancel, or the stage's backend parked on a usage
limit; the unit waits at its stage and a resume re-runs it as a new attempt, a build as a `continue` of the
interrupted session; lead ruling, 11b) \| `park` \|
`stop` \| `retire`. The attempt number of a stage start is the unit's `attempts` count plus one (numbered
across the unit's stages). M2: `park?: ParkRecord` only with class `park` (the chargeable bound's is operator
`design`), written by `outcomeFact` from the table's park class (retryable targets stated by the stage);
`cause?: HoldCause = backend{backend, parkSeq}` only with class `hold`, when a backend park interrupted the stage
(G5). Stage `prepare` (a re-entered unit's first stage) reports `clean-plan-check | clean-build | clean-verify |
conflicted`, all `advance`: on to plan-check, a fresh build, lanes, or a `resolve` build.

The fold derives each unit's `UnitState` from these facts through `afterStageOutcome` (`src/core/state.ts`),
the same function the transition table uses, so a decision's counters are the log's:
`{unit, stage, risk, status: active|held|park-pending|stop-pending|retired, counters: {attempts,
chargeableFailures, redirects, reviseRounds, candidateReds, retries: {plan-check, build, lanes, gate}},
routedUp: JudgmentStage[], promotion, decided, interrupted, approval, open, spec: {rev, sha256}|null, reopened: {command|null,
specRev}|null, pendingRevision: {rev, sha256, command|null}|null, redirectBase}`. `decided` is the unit's latest stage-outcome fact
whose class is not `hold` (null before one, and after a `reopened` fact): the unit driver (`src/pipeline/unit.ts`) reads the next stage from
it (`decidedBy` in `transitions.ts`), and a held stage re-runs what it decided. `interrupted` is the unit's
latest `hold` fact while no later outcome has decided (else null): a held build re-runs as a `continue` round
of that attempt's last invocation, resuming its session in the worktree as left (`src/pipeline/rounds.ts`). `approval` is the latest
`approval` fact's `{attempt, fingerprint}`, or null. `attempts` counts distinct `(stage, attempt)` pairs named by a
stage-parented intent or a stage-outcome fact. `open` is the latest such pair (highest attempt) while no stage-outcome fact records it, else null:
an attempt a crash cut short (step 14b: the driver consumes its completed backend call rather than dispatching
again), or a retire, which records none. `risk` is the `riskFloor` of the unit's latest `dispatch` fact:
a plan-check that raises the risk re-pins the dispatch. `promotion` is set by a `trigger` and cleared by the
next judgment-stage outcome other than a `retry`. `status` follows the latest outcome's class. `spec` is the
unit's spec in force as the log last recorded it: its first `dispatch` fact's `{specRev, specSha256}` (a re-pin
keeps it; in a log 1.0.0-dev.3 wrote, before the arc's first `plan-applied` fact, a re-pin's), a done `spec.patch`'s `{newRev, newSha256}`, a `reopened` fact's, or an evidence-only `plan-applied`
edit's; the stages load exactly those bytes. `pendingRevision` is an applied revision (rev + 1) waiting for the
unit to re-open on it; a `reopened` fact clears it. `reopened` is the latest `reopened` fact's `{command, specRev}`. `redirectBase` is `counters.redirects` at the latest reopen (0 before one):
the plan-check redirect bound (`MAX_REDIRECTS` = 2, `src/pipeline/transitions.ts`) counts only the redirects since
the architect's latest spec revision, `redirects - redirectBase`; plan-check and executor patches bump the rev too,
but only a reopen resets the count.

M2 adds to `UnitState`: `status` `cut` (a `unit-cut` change) and `superseded` (a `unit-reentered` change);
`park: {seq, at, park: ParkRecord, passed: ProbeTarget[]}|null` while `park-pending` (`seq`/`at` of the parking
fact; `park` as recorded or the pre-M2 default; `passed` the retryable targets a covering pass has cleared);
`lastRecovery: {at, targets}|null`; `buildTier: RiskTier|null` (`max(risk, escalated)`: the dispatch floor, `high`
after `implementer-escalated`, never lowered); `lineage: {reenters, root, prepared}|null` on a re-entering unit
(`prepared` once its `prepare` stage recorded an outcome other than a park); `supersededBy: UnitId|null`. A
re-entering unit starts at `prepare` with its predecessor's counters (`chargeableFailures` reset only with
`reset`), attempt numbering (`attempts` continues from the predecessor's) and risk floor; the predecessor is
`superseded`.

**Append** (step 2). One serialised writer; `writeSync` loop until the full length is written; `fsync`; no act
until fsync returns for the full line.

**Fold invariants** (violation = refuse): contiguous seq; chain intact; ≤ 1 open intent per key; done/abort
match an open intent; ordinal strictly increasing per key; a retry (same op, next ordinal) inherits
`deadlineAt`, `key` and `parent`; counters `monotonic()`; one `stage-outcome` per `(unit, stage, attempt)`;
the chargeable outcome that reaches `CHARGEABLE_BOUND` (3) has class `park`; a later `dispatch` of a unit keeps
its `scope` and does not lower its `riskFloor`; a `reopened` fact names a unit that is `park-pending` with its
`decided` stage `plan-check` or `gate`, or `active` with a pending revision, at `specRev` = its recorded `spec.rev` +
1 (the pending revision's rev and hash when one is pending); a `plan-applied` fact has the next `rev`, one fact per
command, an `undispatched` spec edit only of a unit with no `dispatch` fact and any other only of one with, an
`evidence` edit at the unit's rev, a `revision` at rev + 1, a `withdrawn` only of a pending revision (naming the
unit's recorded spec); a `rerouted` fact names a unit
that is `park-pending` with its `decided` outcome `routing-changed`. M2: a `resource.transition` intent names no
unit another open transition holds, and its done is a legal edge from each unit's state (`afterEdge`; the table
is the fold's, `JournalView.resources()`); `scheduling` only on rev 1 of a log with no `dispatch`; `unit-cut` of a
unit not retired, cut or superseded; `unit-reentered` of a parked or held unit, as an id new to the log and
listed in the fact's manifest; a re-entering unit's first dispatch does not lower its lineage's floor; no
dispatch or stage outcome of a cut or superseded unit; `prepare` only for a re-entering unit; a hold's `cause`
names a `backend-park` fact of that backend; `unparked` only of an operator-env park; a `probe` covers only park
seqs (each a unit park the target belongs to, or a park of that backend) and, for a resource target, the seq of a
`resource.transition{fail}` whose residues name its instance, and a unit park it covers is retryable; a `fail`
transition is held by a stage; `implementer-escalated` from the unit's current build tier, below the chargeable bound; one
`judgment-inputs` per `(unit, stage, attempt)`; one `edge-resolved` per edge. `state.json` is a derived cache, never read for a
decision. Attempts, chargeable failures, stage advancement and meter totals are derived from done records and
facts keyed by op/inv, so they cannot be lost or double-counted.

**Tail rule**. Verify the valid prefix first. Only a terminal suffix lacking `\n`, or an all-NUL suffix, is
discardable: save to `events.torn.<off>.<sha8>` (fsync) → truncate (fsync) → `tail-discarded` fact. A saved
fragment with no matching fact is re-recorded at the next start. Any invalid complete line → refuse
(`log-corrupt`), host-level needs-user, exit 78.

**Durability rule**. Every create or rename is file fsync + parent-dir fsync (`fsx.durable()`).

## Op kinds (`OP_KINDS`, `OP_SCHEMAS`)

`proc.spawn` purposes: `backend | lane | teardown | probe | smoke` (M3 subjects add `arc-backend | journey | mutant`).
`proc.kill` reasons: `deadline | stall | pause | stop | recovery | external-unknown | preempt` (`preempt`: M3, lanes only).

| Kind | `expect` (`OpExpect`) | `post` (`OpPost`) | done `outcome` (`OpOutcome`) |
|---|---|---|---|
| `worktree.create` | `path, checkout: branch{branch, at, createBranch} \| detached{at}` | `null` | `created{head}` |
| `worktree.remove` | `path, evidence: OpId` (done `evidence.snapshot`) | `null` | `removed` |
| `resource.transition` | `holder, resources: ResourceUnit[]` (lock order), `edge` | `null` | `transitioned` |
| `proc.spawn` | `subject: SpawnSubject, launchSha256` | `null` | `result{resultSha256, summary}` \| `lost{treeEffects}` |
| `proc.kill` | `inv, scope: invocation\|op, reason` | `null` | `quiesced` |
| `evidence.snapshot` | `source, globs, dest`; `globs` may be empty: a verification checkout whose series never ran is removed citing a complete manifest of zero files (lead ruling 14c). A snapshot of named files (dirty paths, a lane's ignored capture) passes each as its exact glob, metacharacters wrapped in one-character classes (`a[1].log` → `a[[]1[]].log`; `literalPattern`, `src/git/evidence.ts`): node's globSync has no escape character | `{manifest}` | `captured{manifestSha256, files}` |
| `salvage.commit` | see git table | `{new}` | `committed` |
| `mergein.prepare` | see git table | `clean-merged{new}` \| `conflicted` | `clean-merged` \| `conflicted` \| `completed{head}` |
| `spec.patch` | `path, oldSha256, expectRev, patch: SpecPatch`; `path` is the unit's spec file, `oldSha256` its spec in force | `{newSha256, newRev = expectRev+1}` | `patched` |
| `candidate.merge` | see git table | `{new}` | `merged` |
| `integration.ff` | see git table | `null` | `published` \| `unpublished{tip}` \| `recovery-required{observed}` |
| `snapshot.publish` | see git table | `{new}` | `published` |
| `needsuser.raise` | `id, path, blocking` | `{sha256}` | `raised` |
| `command.apply` | `command, commandSha256` | `null` | `applied{receiptSha256}` \| `rejected{reason}` |

`SpawnSubject`: `backend{role, tier, routingRev, unit, attempt}` \| `lane{unit, lane, set: spec\|suite, at: Sha}` \|
`teardown|probe{unit\|null, resource: ResourceInstance}` \| `smoke{check, target: backend{backend, role, tier, routingRev} \| command}`
(M3 adds `arc-backend`, `journey`, `mutant`: "M3: the holistic layer").
`(role, tier)` is a seat (`build.escalation` is refused), which the usage fact copies.
The invocation is `op#ordinal`; its launch.json is written after the intent is durable and must hash to
`launchSha256`.

`Holder = stage{unit, stage, attempt} | sweep{command} | retry{unit, stage, attempt} | publication{unit, attempt}`
(M2 adds the last two: a probe reclaiming its unit's own residue, keyed by the stage attempt whose cleanup failed;
the publication transaction, A2; M3 adds `docs{pub}`, `batch{finding, attempt}`, `job{job}`). `ResourceEdge`: `reserve` (free→reserved), `run`
(reserved→running), `clean{from: reserved|running}` (→cleaning), `release` (cleaning→free), `fail{residues:
[{resource: ResourceInstance, teardown: InvocationId}]}` (cleaning→cleanup-failed; one residue per transitioned resource,
appended to the host index before this intent's done), `reclaim` (cleanup-failed→cleaning, sweep and retry holders only
(`RECLAIM_HOLDERS`; M3 adds `job`):
a sweep or a probe taking back this arc's own resource to re-run its residue's teardown; step 13). Lock order
(`compareResourceUnits`): named resources and pool instances ascending by name (a pool's instances numerically),
then `@cpu#*` numerically, then `integration-slot`; over plain names it is M1's order. Op keys per holder:
`resources:<unit>/<stage>/<attempt>`, `resources:<command>`, `resources:retry/<unit>/<stage>/<attempt>`,
`resources:publication/<unit>/<attempt>`.

## Git intents

`CommitInputs<P> = {tree, parents: P, author, committer: {name, email, date: GitDate}, message, gpgsign: false}`
(the commit is made with `-c commit.gpgsign=false`). The parent tuple type fixes the count; the validator
checks the relationship.

| Kind | Recorded inputs (`expect`) | Expected id (`post`) | Postcondition |
|---|---|---|---|
| `salvage.commit` | `worktree, branch, old, approvedSetSha256, rejectedManifestSha256, commit` (parents `[old]`) | `new` | ref = new; real index tree = new; status clean except ignored |
| `mergein.prepare` | `worktree, branch, old, integrationTip T, merge: clean{commit (parents [old, T])} \| conflicted{conflicts}` | `clean-merged{new}` \| `conflicted` | clean-merged: HEAD = new; conflicted: HEAD = old, MERGE_HEAD = T; completed: implementer commit with parents `[old, T]` |
| `candidate.merge` | `ref = refs/roadmap-run/<arc>/candidate/<unit>`, `old\|null, T, unitCommit, worktree, commit` (parents `[T, unitCommit]`, tree from `merge-tree --write-tree`) | `new` | ref = new; candidate worktree detached at new |
| `integration.ff` | `ref = refs/heads/<int>`, `old = T, new = candidate, fingerprint` | | ref = new; new^1 = T; new^2 = approved unitCommit |

M3 adds `docs.commit` and `mutant.apply`, a repair batch's `candidate.merge` (`+ batch`, on
`refs/roadmap-run/<arc>/candidate/<batch-n>`: no unit entering the plan may take the id `batch-<n>`, so the two never share a ref in a new arc)
and a docs or batch `integration.ff` (`subject`, no fingerprint): "M3: the holistic layer", Op kinds.
| `snapshot.publish` | `ref = refs/roadmap/<arc>`, `old\|null, highWater, manifestSha256, commit` (parents `[old]` or `[]`) | `new` | ref = new; tree matches its own manifest |

Candidate validation adds the prefix-collision guard (a new path whose case-folded form equals, or is a
directory prefix of, an existing path refuses the candidate; collisions present at T are grandfathered).

## File mutations

| Kind | Record | Done when |
|---|---|---|
| `spec.patch` | `{path, oldSha256, newSha256, expectRev, newRev}` + the patch; the old spec is read from `inputs/<oldSha256>.spec.json` (or the file while it still hashes to it), the new one kept as `inputs/<newSha256>.spec.json`, and the file rewritten only while it still holds the old spec (an architect's edit not applied yet is left alone) | the new spec is kept; recovery: kept new → done, old kept or still the file → redo, neither → park |
| `needsuser.raise` | write-once, `{id, path, blocking, sha256}`; the bytes are staged at `needs-user/.staged/<id>.json` inside the intent body (before the intent is durable) and the act renames them into place | file hash matches; absent → redo the rename |
| `command.apply` | `{command, commandSha256}` | an **operation-bound `applied` receipt** naming the op and its verified postconditions exists (`accepted` is not done); an `apply`'s effect is done once its `plan-applied` fact exists |

## Runner files (`src/core/records.ts`)

Invocation dir `<runDir>/inv/<seq>-<ordinal>/`. Every file is bound by `{v, arc, op, inv}` (`inv` must be an
invocation of `op`, `op` of `arc`) and written by `fsx.durable()`. Workload stdout and stderr go to files
`stdout` and `stderr` there, never pipes.

| File | Type / reader | Writer, when | Fields |
|---|---|---|---|
| `launch.json` | `LaunchFile` / `launchFile` | executor, after the spawn intent is durable, before the act | `argv` (argv[0] non-empty; a later argument may be empty), `cwd, env` (declared; no `ROADMAP_*`), `stdinPath\|null, deadlineAt, stallMs\|null` (the runner's stall watchdog: no progress, meaning no member CPU time, no output growth and no member started or ended, for `stallMs` → kill, cause `stall`; lanes carry `LANE_STALL_MS`, every other launch null; absent in a 1.0.0-dev.1 launch.json, read as null), `graceMs` (≥ `MIN_GRACE_MS` = 1000: the backstop fires at deadline + 2·grace and the runner polls every 500 ms), `containment, test: {crash}\|null, terminal` |
| `runner.json` | `RunnerFile` / `runnerFile` | runner, before spawning (`child: null`); rewritten after | `runner{pid, start, bootId}, child{pid, start, sid}\|null` |
| `cancel.json` | `CancelFile` / `cancelFile` | executor, before signalling the workload | `reason: pause\|stop\|recovery\|preempt, at` (`preempt`: M3, a lane only) |
| `exit.json` | `ExitFile` / `exitFile` | runner, after workload quiescence | `child: exited{code}\|signalled{signal}\|spawn-failed{error}, cause: exited\|deadline\|stall\|cancel\|recovery-kill, endedAt ≤ quiescedAt` |
| `result.json` | `ResultFile` / `resultFile` | executor (the adapter, pure over the files above), after the runner has exited with `exit.json` present; re-run at recovery whenever `exit.json` exists without it (lead ruling, 1a: the runner never runs the adapter, so it needs no backend schema) | union below |
| `runner.log` | none (plain text, not a record) | the runner's own stdout and stderr, opened by the executor when it starts the runner (`RUNNER_LOG`, `src/runner/launch.ts`) | free text; empty on a clean run |

`terminal` = `backend{purpose: backend|smoke, role, routingRev, schemaPath, outputPath, session}` \|
`command{purpose: lane|teardown|probe|smoke, expectedExit}`. Sessions: a judgment role takes only
`{backend:'claude', mode:'fresh', id: JudgmentSessionId}`; `build` takes `claude{fresh|resume, id}` \|
`codex{fresh}` (Codex mints its thread id) \| `codex{resume, id}`, ids `ImplementerSessionId`.

`result.json` = `backend{role, routingRev, session, outcome, usage, backendErrors[]}` \| `command{purpose,
exitCode|null, expectedExit, verdict: pass|fail|stall|process-fault|cancelled}`, `reason: pause|stop` (a command's
also `preempt`, M3) beside `cancelled` only (`exitCode: null` ⇒ not `pass` or `fail`; cause `stall` ⇒ `stall`, whatever the exit: a lane
that hung is red, a verdict on the tree; cause `cancel` ⇒ `cancelled{reason}` from cancel.json, the same
interruption a backend call records as outcome `cancelled{reason}`; `classifyCommand(exit, cancel, expectedExit)`).
`outcome = success{value} | refusal{stopReason} | malformed{detail} | process-fault{detail} |
cancelled{reason: pause|stop}`; `usage = known{tokens: TokenUsage} | unavailable{reason}` with `TokenUsage =
{inputTokens, outputTokens, cacheReadTokens|null, cacheWriteTokens|null, turns|null, costUsd|null}` (`turns`
and `costUsd` are the CLI's own `num_turns` and `total_cost_usd`, list price: Claude reports both, Codex
neither); `backendErrors[].class = usage-limit | capacity | platform | backend`, classified only from
`turn.failed` / CLI error events. A judgment result's `session` is its assigned id; an implementer's may be
`null` (died before reporting one).

**Precedence** (`classifyTerminal(exit, cancel, output, schemaValid): TerminalOutcome`, pure; `cancel` is
cancel.json or null):

1. cause `cancel` → `cancelled{reason}` (cancel.json's `pause | stop`; any other cancel.json is a loud error),
   whatever the output: an interruption, not a failure of the call;
2. cause `deadline | stall | recovery-kill`, a signal, or a failed spawn → `process-fault`, whatever the output;
3. non-zero exit with schema-valid output → `malformed`; non-zero exit without it → `process-fault`;
4. exit 0 without schema-valid output → `malformed`;
5. exit 0 with schema-valid output → `success{value}`.

`verdictOf` (`src/pipeline/dispatch.ts`) reads a backend call's interruption from `outcome: cancelled` alone.

**`reads.json`** (`ReadsFile` / `readsFile`, written by the adapter beside `result.json` for every Claude call,
write-once by the same rule and before it): `{v, arc, op, inv, reads: ToolRead[]}`, `ToolRead =
Read{path} | Grep{pattern, path|null} | Glob{pattern, path|null}`, the session's read-only tool calls in call
order, from the tool_use blocks of its stream-json stdout (`path: null`: the session's cwd). A call whose
required argument is not a string is left out (the CLI refuses it unrun). Audit only: the approval fingerprint
does not bind it.

**Claude stdout** is `--output-format stream-json --verbose` JSONL (`src/backends/argv.ts`): the reader takes
the last `type: "result"` event, the object `--output-format json` prints alone. Both CLIs' JSONL is read by
`jsonLines` (`src/backends/jsonl.ts`): complete lines only, so the unterminated fragment a killed workload
leaves is dropped and the events before it are kept; a malformed complete line is malformed output.

`refusal` is the adapter's reading of a backend stop reason (step 4). Commands: `classifyCommand(exit,
expectedExit)`, same rule 1, then `exitCode === expectedExit` → `pass`, else `fail`.

## Approval fingerprint and dispatch record

`ApprovalFingerprint = {unitCommit, specRev, contractRevs: [{path, blob}] (ascending path; the spec's cited
contracts, the architecture doc and its digest when the plan names one, at the gated tip), rulingRevs: [{id, rev}]
(ascending id; the spec's cited rulings that are active, each at its effective revision, M3 Checkpoint A), obligationRevs?: [{id: ObligationId, rev}] (M3: ascending
id; the selected, non-exempt obligations at the gated tip; absent exactly when there are none, non-empty when
present, so a fingerprint with none is byte-identical to a dev.5 one; `obligationRevsOf`)}`. Recorded with the
approval as an `approval` fact. Recomputed at the tip being published onto before `integration.ff`; any mismatch
re-gates. A cited ruling that is withdrawn leaves the set, which changes the fingerprint; M1's ledger has no other
supersede, so there every active ruling is at rev 1. M3 (Checkpoint A): a ruling's rev is `effectiveRulingRevs` over
the sidecars in force (1 plus, per partial superseder, its own rev plus 1 once it is no longer active), and the
approval records the fingerprint captured with the gate's `judgment-inputs`, never one taken when the call is read. An uncited contract is outside the
fingerprint (binding the documents a judgment actually read is backlog).

`DispatchRecord = {unit, specRev, specSha256, scope: RepoPattern[] (sorted), riskFloor, routingRev,
implementerSeatRev: SeatRev, at, transientRules?: 'm3', bounds?: Bounds}` (M3: `transientRules` on every dispatch
since 1.0.0-dev.6, a re-pin copying it, absent on a dev.5 dispatch, whose lineage attempt keeps dev.5's transient
rules, H15; `bounds` the unit's `boundsOf` in force since this pin, absent meaning `DEFAULT_BOUNDS`; the fold's
`UnitState.bounds` is the latest pin's), recorded once per dispatch as a `dispatch` fact; `specRev` and `specSha256` are
the spec revision the dispatching plan-check read and the sha256 of the file's bytes (a risk re-pin records the
revision its plan-check read). A redirect cannot widen `scope` or lower `riskFloor`.
`implementerSeatRev` hashes the triple at `build.<riskFloor>` under `routingRev`. A routing change mid-unit (lead
ruling, arc-1 feedback item 7): when the rev in force differs from the pinned one, the unit is re-pinned (a new
fact under the new rev, scope and floor unchanged) if no build has started for it or its implementer seat hashes
the same; otherwise the dispatching stage records outcome `routing-changed` (at `plan-check`, `build` or `gate`),
which parks the unit uncharged with needs-user reason `routing-changed` naming the seat, never a model.
A risk raise re-pins under the rev in force and may move the implementer seat of a unit whose build already
ran (a re-opened unit): a session cannot move across models or backends, so a build round whose
`implementerSeatRev` differs from that of the dispatch fact its unit's latest session was spawned under (the
spawn's `routingRev` and `tier`) starts a fresh session on the kept branch and worktree, its round's inputs
(a fix round's directives, RESPEC_DIRECTIVE) followed by NO_SESSION_NOTE.
`resume <unit>` of such a park re-pins the record under the rev in force by the same rule (no spec edit) and
re-enters the unit at the stage it parked at (`rerouted`); while the seat is still moved it is rejected with
"restore the routing of build.<tier> or re-enter the unit under a new id".

## `spec.json` M1 subset and `SpecPatch`

`SpecM1 = {schema:'roadmap/spec-m1', unit, rev: SpecRev, lanes, acceptance (non-empty), scope (non-empty),
resources, decisions, facts, cites: {contracts: RepoPath[], rulings: RulingId[]}, obligations?: ObligationId[],
repairs?: (FindingId | ObligationId)[]}` (M3, A13: both unique and non-empty when present, absent meaning none,
`specObligations`/`specRepairs`; `contractRequests` and `owedAfterMerge` are M4's); item ids unique across all
sections. `cites` is required (may be empty; a spec without it is refused, no conversion): the plan contracts and
ledger rulings every prompt of the unit embeds in full; the rest reach prompts as a one-line index (contract: path
and first Markdown heading; ruling: id and first sentence, or its fold line) to read on demand. Each cite must
name a plan contract and a ledger ruling (startup row `plan-invalid` `unknown-cite`).

| Item | Fields |
|---|---|
| `LaneDef` | `id: LaneId, argv[], cwd: RepoPath, env: {set: {NAME: value}, pass: [NAME]}, expectedExit, tier: fast\|estate, resources[], evidenceGlobs[], evidenceExcludes[]` (`evidenceExcludes` optional, read as `[]` when absent) |
| `AcceptanceDef` | `id: ClauseId, clause, failLoudIfUndelivered` |
| `NoteDef` (decisions, facts) | `id: ClauseId, text` |

Every stored item adds `state: active | struck | deferred`; ids are never deleted or reused.
`SpecPatch = {expectRev, by: {role:'planCheck', routingRev, inv} | {role:'executor', inv}, ops (non-empty)}`; `by`
is a plan-check redirect's judgment invocation, or the executor appending the build invocation `inv`'s
`decisions.json` to the decisions section after the evidence snapshot (lead ruling, step 12; not while an applied
revision of the spec is pending: the unit re-opens on it, and its next build writes its decisions again); ops `add{section, item} |
replace{section, item} | strike{id} | defer{id} | cite{contracts, rulings}`, sections `lanes | acceptance |
decisions | facts`. `cite` adds to `cites` (at least one entry; a repeated cite is already there) and nothing
removes one; a plan-check redirect citing no plan contract or no ledger ruling is `malformed`. Scope and resources
are not patchable in M1.

**Lane evidence** (`src/pipeline/lanes.ts`, `src/git/ignored.ts`). Each lane of a series has a dir `<series
root>/<lane id>/`: `output` (its stdout and stderr), `tree` (its declared `evidenceGlobs` in the checkout, when it
declares any), `ignored` (below) and `ignored.json`. After the lane's snapshots the executor lists the checkout's
untracked ignored files one by one (`git ls-files --others --ignored --exclude-standard`) and keeps those whose
ctime is at or after the lane's start: the files the lane wrote. When the lane did not pass (`fail`, `stall`,
`process-fault`, `cancelled`, lost) the ones its `tree` did not capture are selected, in path order, skipping non-regular
files, paths under a build-output dir at any depth (`bin obj dist build target node_modules .venv __pycache__`),
paths matching the default secret excludes (`**/*.key **/*.pem **/*.p12 **/*.pfx **/*kubeconfig* **/.*kubeconfig*
**/.kube/** **/id_rsa* **/id_ed25519* **/.env **/.env.*`, a leading `**` crossing dot dirs) or the lane's
`evidenceExcludes`, names with no exact glob, and files over 2 MiB; files are then taken while the lane stays
within 25 MiB and 1000 files (one that does not fit is skipped, later ones still tried) and snapshotted into
`ignored`, which a fix round reads when it holds any file. Excludes never filter declared `evidenceGlobs`. Every
lane that ran gets `ignored.json` (`IgnoredCensus` / `ignoredCensus`, `src/core/records.ts`), written once and
durably before the stage outcome: `{v, written: {files, bytes}, captured: {files, bytes}, uncaptured: [{dir,
files, bytes, reason}]}`; `captured` counts the declared and the default capture; `dir` is the directory at most
two segments deep (`a/b/`), `(root)` for top-level files; `reason` is `not-declared` (the lane passed: nothing
captures a passing lane's undeclared ignored output) \| `build-output` \| `excluded` \| `over-file-cap` \|
`over-lane-cap` \| `not-regular` \| `unglobbable` (a backslash or a brace group in the name); the 20 largest
groups by files are kept and the rest fold into one `(other)` group per reason. The ledger entry reads it as
`ignored: IgnoredCensus | null`: null when the file is absent (a lane an older executor ran, or a crash before
the write). Null is a lasting state, not an upgrade default, so it logs no warning. The gate's ledger and a fix
round's directives render it as one clause, omitted for a lane that wrote no ignored file. The snapshot ref
carries only the manifests, never the files.

**Judgment outputs** (`src/prompts/schemas.ts`): plan-check `{decision, reasons, patch, risk, notes, premises}`,
gate `{decision, findings, directives, reasons, premises}`, `premises: [{claim, evidence: [{path, line}]}]` (the
premises the decision relies on, the next round's handoff). A plan-check's `notes` go to the architect on escalate
or infeasible; on approve they are facts for the build and the gate, which receive the approving plan-check's
notes. A plan-check after its own applied redirect gets `priorRound {patch, reasons, premises, patchedRev,
changedPremiseFiles}`; a gate after its own revise gets `priorRound {directives, findings, premises, fixPaths,
changedPremiseFiles}`. Changed premise files compare blobs between the commits the prior round read (a plan-check's
checkouts from its `worktree.create` intents; a gate's verification checkout from its launch cwd) and the current
ones; a premise path that names no repository file counts as changed.

**Plan-check checkouts**: each plan-check attempt reads detached checkouts at
`<worktreeRoot>/<arc>/<unit>.plan-check-<attempt>` (the integration tip, its cwd) and, when the unit branch
exists and differs from the tip, `...-branch` (passed with `--add-dir`, as is the rulings ledger's directory). They
are `worktree.create` ops of the attempt, removed (each citing a snapshot of its dirty paths, normally zero files)
when the attempt's call is read, live or after recovery, and by the next plan-check attempt or retire when a crash
left one.

**Architect spec edits** are `roadmap apply` edits ("Plan in force"): the architect edits a unit's `spec.json`
in place, keeps the schema and every id (items are struck or deferred, never deleted or reused; scope and
resources unchanged once dispatched), and runs `roadmap apply`. Before its first dispatch a spec may change
freely. A dispatched unit takes a lane's `evidenceGlobs` and `evidenceExcludes` at its current rev at once (they
are outside the approval fingerprint, and the next lanes attempt reads them), or a revision at its recorded
rev + 1 (`UnitState.spec.rev`), which is pending until the unit re-opens on it: an in-flight unit at its next
stage boundary that allows re-entry, a unit parked at `plan-check` or `gate` by `resume <unit>`. Anything else
is rejected, naming the rule. A park at any other stage is not re-openable in M1; its needs-user names the
re-entry instead (a new unit id whose branch the architect creates at the parked unit's tip).

## Plan in force (owner ruling 2026-09-29: `apply`; DESIGN's `admit` and `patch-spec` are its edit classes)

The plan and specs the executor runs are not the files but a fold of the log (`src/input/inforce.ts`): the
latest `plan-applied` fact names the revision and the manifest `PlanManifest = {planSha256, specs: {unit:
sha256}}`, whose bytes are kept content-addressed in the run dir (`inputs/<sha256>.plan.json`,
`inputs/<sha256>.spec.json`). A unit's spec in force is its recorded spec once dispatched (`UnitState.spec`),
else the manifest's; the stages load those bytes, never the live file (whose path they still name for the
architect). The executor's contexts read `plan()` and `routing()` (the plan in force resolved under the start's
profile and repo config) from the log at each call. `roadmap apply` and a `start` whose files differ are the only
ways a revision comes into force; an unapplied edit is ignored, also by a respawn.

`roadmap apply [--expect-rev n] [--dry-run]` hashes the plan file the arc started with (`start.json`) and every
unit's spec into the command's manifest. The effect (`src/commands/apply.ts`, a mutation, so once its scope has drained
(A12, "Executor, status, recovery"); nothing live is killed): the plan in force's `rev` must equal `expectRev`
when given (`stale: …`); the files are re-read and must hash to the manifest (`the files changed since …`); every
change is classified against the plan in force and the log (`src/input/classify.ts`); the startup rows re-run
(`applyRows`: `plan-invalid` and `spec-lane-unrunnable` over the units whose entry or spec changed, all units when a
resource was changed or removed or the contracts or rulings changed; `unsupported-routing` when the routing
changed); a backend the new routing seats that the routing in force did not passes its smoke. Then the bytes are
kept (`plan.apply.after-inputs`) and `plan-applied{rev + 1, command}` written, the postcondition: a re-run after a
crash finds it (`planAppliedBy`) and applies nothing twice. All or nothing: the rejected receipt's `reason` is
`apply rejected (<n> reason[s]): (1) …; (2) …`, every reason of the first step that found any (a startup row as its
canonical JSON). Applied: `verified` = `plan rev <n> in force`, then each change as canonical JSON; files that are
the plan in force already are applied with nothing to apply and no fact. `--dry-run` evaluates the same, read-only
over the log as `status` reads it, and prints `{dryRun: true, kind: accepted, rev, nextRev, changes, smoke:
[backend]}` \| `{dryRun, kind: unchanged, rev}` \| `{dryRun, kind: rejected, reasons}`; it runs no smoke (`smoke`
lists what an apply would smoke) and resolves lanes against the caller's environment.

The rules (`PlanChange` names what each accepted change is):

| Edit | Rule | `PlanChange` |
|---|---|---|
| Add a unit | now; its id never planned before (`plannedUnits`) | `unit-added` |
| Remove a unit | only if it never started (no stage start, no dispatch) | `unit-removed` |
| Unit order | the started units stay first, in their order | `order` (of the others) |
| An undispatched unit | any plan field and its spec, now | `unit-changed`, `spec{edit: undispatched}` |
| A dispatched unit's plan entry | `spec` path, `risk`, `scope`, `resources` and a new `after`: refused; dropping an `after`: now | `unit-changed` |
| A dispatched unit's spec | lane `evidenceGlobs`/`evidenceExcludes` only, at its rev: in force at once; rev + 1 with scope and resources unchanged: pending until it re-opens (in flight: at its next boundary whose next stage is plan-check, lanes, gate or a fresh or fix build, via `reopened`; parked at plan-check or gate: by `resume <unit>`); the recorded spec again: a pending revision withdrawn; anything else, and any edit of a merged, approved or publishing, stopped, or otherwise parked unit: refused. A revision at or below a recorded rev that the executor's own `spec.patch` set (the implementer's decisions appended at evidence, which can land while the revision is unapplied, A12) is refused naming that revision, where its bytes are kept, and the rev to set on top of it (lead ruling: no auto-rebase) | `spec{edit: evidence \| revision \| withdrawn, specRev, specSha256}` |
| Routing | re-resolved; unsupported seats refused; a newly seated backend smoked; a moved implementer seat then parks its unit `routing-changed` at its next dispatch (the mid-unit routing ruling) | `routing{routingRev}` |
| Resource declaration | add: now; change or remove: refused while the resource is held (not free, or a transition open) or an undisposed residue names it | `resource{resource, edit: added \| changed \| removed}` |
| Suite lanes | now (the next candidate runs them); refused while a candidate op is open or a unit is active past a candidate attempt | `suite` |
| `contracts`, `rulings`, `architectureDoc`, `architectureDigest`, `direction` | now | `plan-field{field}` |
| `arc`, `integrationBranch`, `baseline`, `worktreeRoot` | always refused | |

A spec edit of a unit with an attempt a crash cut short (`UnitState.open`) is refused until the executor has
recorded that attempt. What the log names is also what the executor publishes and cites: the snapshot's
`specs/<unit>.json` and a park's evidence are the kept specs in force. The rulings ledger is not in the manifest:
it is read from its file (append-only by convention), and the gate's fingerprint binds the ruling revisions it
read.

A start (`runChecks`, last): no plan in force yet records the files as revision 1 (`command: null`, no changes; an
arc started before plan revisions warns first and records its spec edits since dispatch, or refuses, per "Record
evolution"); files that differ are classified as above
(no rows: the start ran them all; no smoke of its own: the start's smoke runs) and applied with `command: null`, or
refuse the start (`plan-change-refused`). A supervisor's respawn (`--respawn`, once a generation was ready) runs
the plan in force.

## Routing types (`src/routing/types.ts`)

`ModelId = 'claude-opus-5-5' | 'claude-fable-5-1' | 'claude-sonnet-5-5' | 'gpt-5.6-luna' | 'gpt-5.6-sol'` (closed). `Backend = claude |
codex`. `Triple = {backend:'claude', model: ClaudeModelId, effort: low|medium|high|xhigh|max} | {backend:'codex', model:
CodexModelId, effort: low|medium|high|xhigh}`; a Claude triple's effort is passed as `claude --effort <e>` on
judgment and build calls. `Role = planCheck | build | gate | lens | checkpoint` (M3 adds the arc roles last, so
seat order is unchanged; `UnitRole` the first three, `ArcRole` the last two, `JudgmentRole = planCheck | gate`,
`FreshRole = JudgmentRole | ArcRole`, the roles whose call runs a fresh judgment session); `RiskTier = low | med |
high` (a unit's risk); `JudgmentSeat = RiskTier | escalation`; seats: build has `RiskTier`, planCheck and gate have
`JudgmentSeat`, lens and checkpoint the one seat `arc` (`SeatRef = {role, tier}`, `build.escalation` and `gate.arc`
unrepresentable; `UnitSeatRef` and `ArcSeatRef` split it, and a unit's backend subject and seat meter name only a
`UnitSeatRef`). Built-in arc seats: `lens.arc` → frontier, `checkpoint.arc` → summit. They are in force only in a
holistic arc (G20): `RoutingStack.holistic?: true` (`planStack(profile, config, plan)` sets it from
`plan.holistic`; `arcStack` never does), `ResolvedRouting.holistic`, `seatsInForce(resolved)` (every seat when
holistic, else the unit roles' seats), which `unsupportedSeats` and the smoke's seat choice iterate, and
`routingRevOf(table, holistic)`, which hashes the unit roles alone when not holistic (the M2 table, so every
dev.5 `routingRev` is unchanged). `ModelClass = efficient | frontier |
summit`; the class catalogue binds per profile: `efficient` → codex gpt-5.6-luna medium (`default`) or
claude-sonnet-5-5 medium (`claude-only`), `frontier` → claude-opus-5-5 high, `summit` → claude-fable-5-1 high. `SeatTable<V>` = a value per seat; `RoutingTable = SeatTable<Triple>`; `ClassTable =
SeatTable<ModelClass>` (the built-in seats, shared by both profiles); `RoutingLayer` = a class at any subset of seats (a named role needs
≥ 1 seat; a triple is refused); `ClassBindings` = a triple for any subset of classes (repo config only; a
binding's effort must be one `models.ts` lists for its model: Claude low|medium|high|xhigh|max, Codex low|medium|high); `RoutingLayerName = builtin | repo-config | plan
| unit` (lowest to highest precedence); `ProfileName = default | claude-only`. `.roadmap/config.json` = `{routing?:
{profile?, seats?: RoutingLayer, classes?: ClassBindings}}`, unknown keys refused. `resolveRouting` →
`{table, classes, sources, bindings: {[C]: builtin|repo-config}, rev}`. `PromptTable<P> = {[R in Role]: {[M in ModelId]: prompt{prompt} |
inherits{from, reviewed} | unsupported{reason}}}`; step 5 fills `PROMPTS` and the profiles.

## Host files (`/var/tmp/roadmap/`)

| File | Type / reader | Content |
|---|---|---|
| `host.lock` | `HostLockClaim` | `{v, nonce, generation, bootId, supervisor{pid,start}, arc, runDir, repo}`; claimed by `link(tmp, host.lock)` (fresh) or `rename` (takeover, renewal), always under `host.recovery.lock` (uniform claim path, lead ruling 14a). One claim per executor: a supervisor renews its claim (new nonce, next generation) before each restart |
| `host.generation` | `lastGeneration` (`src/host/lock.ts`) | the last generation issued, as `<positive integer>\n`; `durableWrite` before any claim carrying it is published. Monotonic per host dir: a fresh claim issues last + 1, a takeover or renewal max(claim, last) + 1, so a generation (and its write-once `handshake.<generation>`) never repeats |
| `host.owner.json` | `HostOwner` | `{v, nonce, generation, executor{pid,start}\|null}`; atomic publish: `executor: null` inside the claim's critical section, the spawned executor before the handshake |
| `host.recovery.lock` | `RecoveryLockClaim` | `{v, nonce, bootId, holder{pid,start}, at}`; claimed by `link()` |
| `handshake.<generation>` | `HandshakeFile` | `{v, nonce, generation}` |
| `supervisor.ready.<generation>` / `supervisor.failed.<generation>` | `ReadinessFile` | `{v, generation, state: ready, at}` / `{…, state: failed, reason}`; write-once. Ready = the executor's first heartbeat of that generation (it passed its startup checks), or an intentional stop/complete before one. Failed = it ended before that: `reason` is its refused exit line (canonical `ExitReason` JSON, carrying `exitCode`) or prose for a crash (step 14a) |
| `supervisor.state.json` | `SupervisorState` | `{v, generation, crashes: IsoTime[] ascending, heartbeatStaleMs}`: the rolling crash window (pruned to the last hour) and the stale threshold in force (300000 unless `--heartbeat-stale-ms`) |
| `exit.reason.json` | `ExecutorExitReason` | `{v, generation, reason: stop\|complete\|refused}` |
| `supervisor.<token>.out` / `.err` | JSON lines (`supervisorLine`, `src/supervisor.ts`) / text | the supervisor's stdio, named by `roadmap start`: `{kind: claimed, generation}` per claim, or the refused exit line |
| `executor.<generation>.out` / `.err` | exit line / text | the executor's stdio: its `ExitReason` line at an intentional exit; stderr of a crash (the crash-limit needs-user cites these) |
| `residues.jsonl` | `ResidueLine` = `ChainEnvelope & ResidueRecord` | envelope `{v, seq, prev, at}` (no `arc`), same chain and tail rules as the event log (`parseChainLine`); since M3 a compacted index starts with a `compacted` head (A5a) |
| `residues.archive.<prevSeq>.<sha8>.jsonl` (M3) | the index file a compaction replaced, byte for byte | named by its last line's seq and the first 8 hex of that line's hash (`residueArchiveName`) |
| `residues.jsonl.compact` (M3) | `COMPACT_TMP` | a compaction's new index before its rename; a stray one is removed by the next compaction |

`ResidueRecord = residue{key, teardown: {argv, cwd, env}, label} | disposition{key, cleaned, by{arc, inv}} |
disposition{key, isolated|transferred, by{arc, needsUser}}`; `ResidueKey = {arc, inv, resource} & (unit | job)` (per
resource; M3: exactly one of `unit` and `job`, G4). Run dir: `heartbeat.json` (`Heartbeat {v, generation, at}`), every 10 s, stale at 5 min; `start.json`
(`RunStart {v, generation, at, repo, planFile, profile}` with the resolved profile, rewritten by every start that
passes, read by `status` for the repo and plan file, and to rebuild the routing of a dev.5 revision not yet adopted); `status.rejection.json` (`RejectionFile`, above).

## Commands, receipts, needs-user

| File (run dir) | Type | Content |
|---|---|---|
| `commands/incoming/<id>.json` | `CommandFile` | `{v, id, arc, at, body}`; `body = pause{target} \| stop \| ack{needsUser, choice\|null} \| resume{target} \| sweep{resource\|null} \| apply{expectRev: PlanRev\|null, manifest: ApplyManifest} \| resolve-edge{edge: EdgeId, evidence} \| run-only{units: UnitId[] (ascending, non-empty)\|null}` (the last two M2) \| M3: `rule{path, sha256}` \| `reverse{divergence}` \| `steer{unit, brief{path, sha256}, budgetMin, class\|null, resume}` \| `merge-in{unit}` \| `audit{lenses\|null}` \| `close-admissions` (see "M3: commands") |
| `commands/receipts/<id>.<state>.json` | `Receipt` | `accepted{at}` \| `applied{at, op, verified[] (non-empty)}` \| `rejected{at, reason}`; write-once each, by temp + `link` |
| `needs-user/<id>.json` | `NeedsUserRecord` | `{v, id, arc, raisedAt, blocking, subject: unit{unit}\|arc\|host, reason, summary, recommendation, options[{id, label}], evidence[]}`; write-once. `NeedsUserContent` (`records.ts`) is the record without `v, id, arc, raisedAt`: what stages produce |
| `needs-user/<id>.ack.json` | `NeedsUserAck` | `{v, id, command, choice\|null, at}`; write-once, by temp + `link` |

Control commands (`CONTROL_COMMANDS = pause, stop, ack`) apply immediately, waiting only for an
`integration.ff` critical section. Mutations (`resume`, `sweep`, `apply`, `resolve-edge`, `run-only`, and M3's `rule`,
`reverse`, `steer`, `merge-in`, `audit`, `close-admissions`) apply once
their scope has drained (A12): every unit in the command's `CommandScope` has a task that is `idle` or
`awaiting-admission` (none in a stage or a chain), and no earlier pending mutation overlaps it; while a mutation
is pending, admission into its scope waits (`drain`). An open stage-parented intent no longer defines the safe
point. `NeedsUserReason` is a closed list in `records.ts`; add members by request.

Step 13 (`src/commands/{queue,apply}.ts`, `src/needsuser.ts`): the CLI mints `cmd-<12 hex ms clock><4 random
hex>`, so id order is submission order, and writes the incoming file by temp + `link` (atomic, write-once;
`fsx.exclusivePublish`, as the executor writes receipts and ack files, so a reader never sees one empty).
The executor polls every 1 s; a command without a terminal receipt is pending and gets `accepted` on first
sight. Each command is one `command.apply` op (key `command:<id>`, parent `command{command}`); every effect
checks its postcondition first, so recovery applies only the remainder. Effects: `pause` → `paused` fact;
`stop` → `stop-requested` fact; `ack` → `<id>.ack.json` then `needs-user-acked` (rejected: unknown id,
acknowledged by another command, a choice the item does not offer); `resume` → `resumed` fact (`backend`: that
backend's smoke alone first; a failed smoke is `rejected{smoke-failed: …}`; `<unit>` under `pause --all` is
rejected); `resume <unit>` of a parked unit (paused too: the same resume also clears the pause, and when the
park cannot re-open yet it clears the pause alone, its receipt naming why the unit stays parked): parked at `plan-check` or `gate` with a revision
of its spec applied (`pendingRevision`) → the park's open needs-user acknowledged by this command, then
`reopened` on that revision (see "Architect spec edits"); parked `routing-changed` (any stage) with the implementer seat as pinned under the
rev in force, or no build started → re-pinned (`dispatch` fact, when the rev differs), the park's open
needs-user acknowledged, then `rerouted`; no revision applied, a still-moved implementer seat, any other park, a
stopped or a merged unit → `rejected` with the reason; `apply` → "Plan in force"; `sweep` → per undispositioned residue, reserve (or `reclaim` this arc's own cleanup-failed
resource) under the sweep holder, the recorded teardown, release, `cleaned` disposition; a failed teardown
leaves the resource cleaning under the sweep and the residue undisposed, the receipt's `verified` says so, and
the next sweep re-drives it first.

Step 13b (`src/executor.ts`): `raiseNeedsUser(journal, runDir, content, parent)` parents each raise by what it
answers for: the stage attempt whose outcome parked or stopped a unit (`{stage, unit, stage, attempt}` of the
unit's `decided` fact; a backend park's by the held attempt), the op a recovery parked (`{op}`), or the arc.
`raisedFor(view, parent)` finds it, so the executor raises each item once however often it re-reads the arc.

## Executor, status, recovery (step 13b; the scheduler since M2 step 7b)

`runExecutor(args) → ExitReason = complete{units} | stop{cause: command|unit, needsUser} | refused{rejections,
exitCode: 78|75}`; any other end is a thrown error, a crash, which the supervisor counts and which writes no
exit reason. The executor prints the reason as one canonical JSON line on its stdout. Sequence: the handshake
(step 14a) → `runChecks` → (refused: `status.rejection.json` for exit 78, `exit.reason.json {refused}`) →
`start.json`, heartbeat, `executor-started` → the control-only phase when started `--control-only` → `recover` →
the outcome of every stage attempt whose backend call recovery closed is recorded (the adopted-build rule below,
at startup, so a paused unit needs one `resume`; lead ruling 14c) → `smokeCheck` (refused as above, after
readiness; on a `--respawn` a failed backend is parked `outage` instead, A18) → `schedule`
(`src/schedule/scheduler.ts`), which returns `complete` or `stop`. One arbiter serves every reservation of the
run and one prober every probe; the contexts read `plan()` and `routing()` (the plan in force) from the log at each call.

**The scheduler** (M2 "Scheduler model"). One non-reentrant loop, every `POLL_MS` (1 s) or sooner when a task or
job wakes it; it never awaits long work, it only starts tasks and jobs and reads their ends. Each iteration:
1. control commands, synchronously as facts; the kills a pause or stop asks for (`proc.kill{pause|stop}` of each
   live invocation, once, after its runner wrote runner.json) start as tracked jobs;
2. one job per pending mutation whose scope has drained (above); a command with a running job, or whose
   `command.apply` a crashed executor left open (recovery's), is never started again;
3. the due probe jobs (`prober.due`), at most one per target, none on a target a running `resume` probes;
4. the due needs-user items (a halted unit's park or stop, once per deciding attempt; the park schedule's
   escalations and breakers); with nothing running and no mutation pending, the run ends `complete` when every
   unit is merged, cut, superseded or parked operator (a retryable park is still probed, so it is not settled),
   no own-arc residue is left (`JournalView.residues()`: it is probed until reclaimed, `arcSettled`) and no
   blocking needs-user is open (M3: a holistic arc runs its jobs here and ends by the completion predicate, `arc-completed`
   and the terminal snapshot; see "Choices made in M3 B7");
5. waiting tasks admitted, and a task started for every ready unit without one (`ready`, src/schedule/ready.ts);
6. the arbiter re-evaluated (also woken by every release), then `sched.json` rewritten when it changed.

A task runs its unit's stage loop (`runUnit`, `src/pipeline/unit.ts`) with its own abort signal; at most one task
per unit. `TaskState` (memory only): `idle`, `awaiting-admission` (at an admission boundary), `in-stage`,
`in-chain`. Admission boundaries sit before `prepare`, `plan-check`, `build`, `lanes`, `gate` and `candidate`; there
`admit` (A17) is re-checked for every task: a pause, a stop, or a unit no longer active (cut, superseded,
re-opened) ends the task holding nothing; any other constraint (a drain, a parked backend, a tripped breaker,
run-only, base-red, a blocking item holding every admission, or an open blocking item about the unit) keeps it
waiting. Each stage then takes its entry reservation from the arbiter before its first journaled op (F6); a wait
cancelled by pause or stop journals nothing. Chains (`quiesce → evidence → salvage → teardown` after a build,
`ff → snapshot` in a green publication) are never gated: they run to completion under pause, drain and stop.
A DAG arc's unit is ready when active, every `after` dependency merged (D1, followed to its lineage head once
that prepared, F15), every contingent edge resolved, and its next stage admitted; a legacy arc offers only its
serial frontier (`legacyNext`). Before the first iteration a task is started for every unit whose next stage is a
chain stage, and for every merged unit (its retire is re-runnable), whatever pause says (G2).

Pause and stop are per unit or arc-wide markers in the log. `pause <u>` aborts u's task and kills u's live
backend and lane invocations (recorded `interrupted`, a hold); `pause --all` does so for every unit; paused units
are not admitted. Stop (the `stop` command, or a unit whose outcome stops the arc) aborts every task, kills every
live backend, lane and smoke invocation (a probe's too), lets teardowns, reclaims and chains finish, then
`recoverReservations` and the run ends `stop`. Control commands keep applying meanwhile. Blocking items include
the file-only `sup-<gen>-<n>` and `host-<kind>-<n>` (host-level; `ack` answers them like any other, the ack fact
taking any id form); a host item, `recovery-required`, `log-corrupt` and `supervisor-crash-limit` hold every
admission, `base-red` holds candidates, and an item about a unit holds that unit only. The executor never
releases the host: its supervisor does, after it exited.

**`sched.json`** (run dir, `SCHED_FILE`, derived, non-authoritative: never read for a decision; a restart
rebuilds everything in it in memory): `{v, arc, pid, tasks[{unit, state: TaskState}], queue[{unit, stage,
attempt, publication, request{named, pools, cpu, publication}, envBlocked}], jobQueue[{holder: docs{pub} |
batch{finding, attempt} | job{job}, request, envBlocked}] (M3 B7), drains[{command, scope}]}`, written by the executor
`pid` (atomically, only when it changed): every unit with a task, the arbiter's unit waiters in the order it serves
them, its job waiters (served before every unit, in arrival order; a 1.0.0-dev.5 executor's file has no `jobQueue`,
read as empty), and the pending mutations' scopes. `status` reads it only while that `pid` is the run's live
executor.

## Supervisor and handshake (step 14a)

`roadmap start` → `launchSupervisor` (`src/supervisor.ts`): spawns `node src/entry/supervisor.ts <hostDir> --repo
--plan [--profile] [--heartbeat-stale-ms]` detached (setsid) with `ROADMAP_ROLE=supervisor`, then waits at most
`--wait <ms>` (default `START_WAIT_MS`, 240 s, past the smoke's 180 s deadline; lead ruling 14b) for the supervisor's first stdout line
and for that generation's readiness marker only. It prints one line
and exits: `{kind: ready, generation, supervisor}` 0; the refused exit line, with its code (78/75); `{kind:
failed|timeout, …}` 70. The supervisor: claim (`claimHost`, `reconcilePreviousArc`; a 78 refusal writes
`status.rejection.json` and a durable `host-<kind>-<n>` needs-user in its run dir) → per executor: spawn `node
src/entry/executor.ts <hostDir> --generation --nonce --repo --plan [--profile] [--control-only] [--respawn]` (the
claim in argv; `ROADMAP_ROLE` removed; every executor after one of the supervisor's generations was ready is a
`--respawn`, which runs the plan in force; before that, each is a start) → `host.owner.json` names it → `handshake.<generation>` → watch (readiness; heartbeat
checked every 10 s, stale after `heartbeatStaleMs` → SIGKILL, a crash). An exit with `exit.reason.json` of its
generation is intentional: release, readiness marker, exit with the executor's code. Otherwise a crash: window
in `supervisor.state.json`; backoff 2 s, 10 s, `renewClaim`, respawn; the third in an hour writes
`needs-user/sup-<gen>-<n>.json` (blocking, host subject, reason `supervisor-crash-limit`, evidence the executors'
stderr), releases and exits. A supervisor starting with the window at the limit runs its first executor
`--control-only`. The executor waits for its handshake (`awaitHandshake`, 30 s, abandoned when host.lock is no
longer its claim with a live supervisor) and verifies owner record and host.lock; on any mismatch it exits 78
having written nothing. Crash points `sup.after-claim`, `sup.after-spawn`, `sup.after-owner-publish`,
`sup.after-handshake`.

`recover(ctx) → {recovered, parked}` (`src/recover/recover.ts`): passes in the order proc.kill, proc.spawn → git
(`worktree.create`, `worktree.remove`, `evidence.snapshot`, `salvage.commit`, `mergein.prepare`, `candidate.merge`,
`integration.ff`, `snapshot.publish`) → resources (`recoverReservations`) → files (`spec.patch`, `needsuser.raise`,
`command.apply`). Dispositions: `done` → done `reconciled`; `redo` → the op's act and verify, done `redone`;
`abort` → needs-user + abort; `recovery-required` (ff) → needs-user + done `recovery-required{observed}`; `park`
→ intent left open + needs-user. Each needs-user: blocking, reason `recovery-required`, parent `{op}`, raised before
the op is closed (step 14b), after finishing any raise a crash left open (it holds the one `needs-user` key). A
second pass must only re-park what the first parked and append nothing (`RecoveryNotIdempotentError` otherwise).
Crash points `recover.before-op` / `recover.after-op`; a crash anywhere in recovery is finished by the next start
to the same fixed point (matrix row "crash during recovery"). Runs in the executor under its supervisor's host
claim, before any dispatch.

Adopted-build rule (lead ruling 14a/14b, `src/pipeline/unit.ts`): when the fold's `open` attempt is a plan-check,
build or gate whose backend call recovery closed with a result (adopted, reconciled or redone), the driver records
that attempt's outcome from the result (`planCheckRead`, `buildRead`, `gateRead`, the same code the live stage
runs after its call) and never dispatches the call again. A build call lost with tree effects is consumed too, as
`build:lost-tree-effects`; any other lost call, or none, re-runs the stage as a new attempt. The executor records
these outcomes at startup, right after recovery (lead ruling 14c).

Lost backend calls (lead ruling 14c, the plan's recovery table: neither exit.json nor result → `lost{treeEffects}`,
usage `unavailable{no-result}`): `callBackend` retries a lost call once, uncharged, as the op's next ordinal with
the same `deadlineAt`, except an implementer call with tree effects (its workload started). Build outcomes:
`lost-tree-effects` → quiesce, uncharged (what the workload left is salvaged, then the lanes and the gate judge
it); `lost` (lost again after the retry) → park, reason `build-lost`. A lost judgment call after its retry is
`process-fault` (park); a lost lane is `blocked` (the lanes stage's one uncharged retry). A build call a crash
left lost without tree effects is not consumed: its stage re-runs as the next attempt, under the lost call's
`deadlineAt` (as the live retry), not a fresh deadline. `reconcilePreviousArc(previous)` is the `reconcilePrevious` hook (step
14a, R18): read only unless an open spawn of that arc has a live runner or workload; then, under the recovery lock,
its journal is opened and open kills, then the surviving spawns, go through the existing reconcilers (adopt or
settle, never dispatch). Unreconciled: a corrupt log, a survivor whose launch.json is not its intent's, or a
survivor left after the pass.

`status(runDir, arc, hostDir) → Status` (`src/status.ts`, `roadmap status [--repo --arc]`, JSON only): `arc`;
`run{state: running|draining|held|parked|blocked|complete|refused|no-owner, owner, heartbeatAt}`; `units[…]` (the plan in
force's units, below); `edges`; `runOnly: UnitId[]|null`; `legacy: bool` (`scheduling() = legacy`); `plan{rev,
planSha256}|null` (the plan in force; an arc with none yet reads its plan file, warned); `routing{profile, rev,
seats: ClassTable, sources, bindings}|null` (since M3 B9: the plan in force under its revision's routing provenance;
classes only, no model id); `needsUser[{id, reason, blocking}]` (unacknowledged, the log's items
and the file-only `sup-*`/`host-*` ones, ascending id; step 14b); `commands{pending[{id, type}], receipts[]}` (the
last 10 terminal receipts); `spend{byRole, byModel{models, unresolvedRevs}, byJob, bySmoke}` (every total: `calls, input,
output, cacheRead, cacheWrite, turns, costUsd, unavailable`; `bySmoke` per backend and revision, in no role or
model total); `host{…, log}` (below); `parkedBackends`; `rejection`; and the M3 keys (`holistic`, `target`, `nowTrue`,
`notYetTrue`, `waived`, `deferred`, `vision`, `divergences`, `decisionsSince`, `convergence`, `findings`, `audit`,
`owed`, `completion`: "Choices made in M3 B9"). The log is read with `readJournal`
(`src/core/log.ts`: fold without lock, repair, fact or cache write; an unterminated tail is left out); what only
the scheduler knows comes from `sched.json` while its writer is the live owner. `byModel` is the only place a model
id appears: seat totals (`meterOf(...).bySeat`) looked up in each revision's table, resolved from the routing
provenance each plan revision recorded (M3 B9 item 2).

A unit line: `{unit, stage, status, attempts, chargeableFailures, risk, seat{role, tier}|null}` (`status` is the
fold's `UnitStatus`, or `held-after:<ids>` while `after` units it waits on are not merged), and since M2:
- `state`, the first that holds: `merged | cut | superseded` (its status); `parked` (park-pending); `blocked`
  (stop-pending, an open blocking needs-user about it, or an `after` dependency parked, stopped or cut: D1);
  `held` (an interrupted stage, or admission waits on a pause); `running | preparing` (its task is in a stage or
  chain; `preparing` for a re-entry's `prepare`; without `sched.json`, an open attempt under a live executor);
  `waiting` (its task waits in the arbiter's queue, or it waits on dependencies or contingent edges; a legacy
  arc's later units wait on the serial frontier); `awaiting-admission` (its next stage is not admitted now);
  `ready` (it may start);
- `waitingFor{deps, edges, resources: ResourceRequest|null, envBlocked, admission: AdmissionConstraint[],
  drainFor: CommandId[]}|null`;
- `holds`: every resource unit held or in transition by one of its holders (stage, publication, retry);
- `priority{origin, waitStartSeq, bypassMerges, promoted}|null` (`rankOf`, active units only);
- `park{class, kind? (operator), targets, outstanding, nextProbeAt (null: due now), escalateAt|null}|null`;
- `lineage{reenters, root, prepared}|null`, `supersededBy|null`, `buildTier` (a tier, never a model);
- `running{stage, attempt, elapsed (ms since the attempt's first op, or null), deadline (the earliest of its open
  ops'), resources (= holds)}|null`, set exactly when `state` is `running` or `preparing`.

`edges`: `after{unit, on, effective (effectiveDependency), met}` and `contingent{unit, edge, condition, resolved}`
per unit of the plan in force. `host`: `containment{mode, guarantee}`; `resources[{resource, state, holder|null,
pending}]` (every unit not free or with a transition open); `pools{<pool>: {size, used, dirty}}` (`@cpu` and each
declared pool); `queue` (`sched.json`'s, empty without a live executor); `probes[{target, parks (the seqs a probe
now covers: park seqs and a residue's fail seq), nextProbeAt (null: due now), lastResult|null, tripped}]` (every
target with a current retryable park or an own-arc residue, `probeTargets`); `backends[{backend, parkSeq, class}]`.

`run.state`: without a live executor, `refused` (the latest start was refused), `complete` (every unit merged, cut,
superseded or parked operator, no own-arc residue left, and no blocking needs-user open; a holistic arc: its
`arc-completed` active, M3 B9 item 8) or `no-owner`. With one, the first that holds (`running` reads `draining` while
admissions are closed):
`running` (a unit runs, prepares, is ready, waits in the arbiter's queue, or waits only on a drain), `held` (a unit
is held or waits on a pause), `parked` (a blocking needs-user is open), `blocked` (work remains that nothing can
move: parks or own-arc residues being probed, run-only, an unresolved edge, a dead dependency, a tripped breaker), else `running`.

`roadmap watch` streams `needs-user`, `ack` and `owner` events and `{event: units, run: <run.state>, units:
{<unit>: <compact state>}}` on change (`running:build#3`, `waiting:deps=u1`, `waiting:resources`,
`awaiting-admission:drain`, `held:paused`, `parked:retryable`, `merged`, …).

## Cross-module interfaces (`src/core/interfaces.ts`)

| Interface | Shape | Implemented in |
|---|---|---|
| `Journal` | `begin(NewIntent<K>) → Durable{op, inv, seq}` (allocates `op = <arc>/<seq>`, ordinal 1, then calls `body(op, inv)`); `retry(op, kind, body(inv))` (next ordinal; inherits key, parent, deadlineAt); `done`, `abort`, `fact` → durable seq; `view: JournalView` | step 2 |
| `JournalView` | `arc, highWater(), openIntents(), latestIntent(op), doneOf(op), opsOf(kind), usageRecorded(inv), unit(id) → UnitState, dispatchOf(unit) → DispatchRecord\|null, dispatchesOf(unit) → DispatchRecord[] (every dispatch fact, log order), parkedBackends(), needsUser() → [{id, blocking, ack}], ackOf(id), control() → {stop, pausedAll, pausedUnits}, containmentMode(), planApplied() → the latest plan-applied fact\|null, planAppliedBy(command), plannedUnits()`; M2: `backendParks() → [{backend, seq, class}]`, `resources() → Map<ResourceUnit, {status, pending}>` (the incremental table), `probes()` (the latest probe per target), `residues() → ResidueState[]` (below, "Residue probing"), `judgmentInputs(unit, stage, attempt)`, `edgeResolved(edge)`, `runOnly()`, `scheduling() → dag\|legacy\|null`, `decidedSeq(unit) → number\|null` (the seq of `unit(id).decided`), `publications() → [{unit, seq}]` (each `integration.ff{published}` with its done seq, log order), `addedSeq(unit) → number\|null` (the first `plan-applied` naming it); the last three feed rank (F17) | step 2 (`opsOf`: 10; `unit`, `dispatchOf`, `parkedBackends`: 11b; `needsUser`, `ackOf`, `control`, `containmentMode`: 13; `planApplied`, `planAppliedBy`, `plannedUnits`: apply) |
| `Containment` | `mode, launch(launch, invDir), members(WorkloadRef), kill(WorkloadRef, reason, graceMs), empty(WorkloadRef)` | 3a, 3b |
| `RunnerFiles` | `invDir, inv, read(name) → file\|null, write(name, file)`; `RunnerFileMap` keys the five files | 3a |
| `Adapter` | `(AdapterInput{launch, exit, stdoutPath, stderrPath}) → ResultFile`; pure over files | 4 |
| `GitOp<K, Request>` | `GitSteps<K, Request>` (`kind, prepare(request) → IntentBody<K>, act(intent), verify(intent) → OpOutcome[K]`, exported by each git module) + `reconcile`, assembled in `src/recover/ops.ts` (14b: no git ↔ recover import cycle) | 8a, 8b |
| `Reservation<S, H>` (`src/resources/reserve.ts`) | typed handle, `S = reserved\|running\|cleaning`, `H = StageHolder\|SweepHolder`; `reserve(ctx, holder, request: ResourceRequest, parent) → Reservation \| Refused{busy}` (M2: a request, `requestOf` from declared names) (no op on refusal), `probe → clear \| parked{needsUser}`, `run`, `cleanup → released \| cleanup-failed{failed, released}` (stage) `\| left-cleaning{failed, released}` (sweep), `cancel(live inv, pause\|stop)`; the table is derived from the journal (`resourceTable`) | 10 |
| `Reconciler<K>` | `(IntentOf<K>, JournalView) → Disposition` limited to `AllowedDisposition[K]`: `done \| redo \| park \| abort \| adopt \| lost \| recovery-required` | 3c, 7, 8a, 8b, 9, 10, 13 |

`AllowedDisposition`: `proc.spawn` done/adopt/lost; `proc.kill` done/redo; `worktree.*`, `salvage.commit`,
`mergein.prepare`, `spec.patch` done/redo/park; `evidence.snapshot`, `resource.transition`, `needsuser.raise`,
`command.apply` done/redo; `candidate.merge`, `snapshot.publish` done/redo/abort; `integration.ff`
done/redo/recovery-required; M3: `docs.commit`, `mutant.apply` done/redo/abort, `revision.commit` done/abort.

M3 adds to `JournalView`: `nextFindingId()`, `nextDivergenceId()`, `nextJobId(kind)`, `integrationHead()` (the latest
published `integration.ff`'s `new`, any subject), `lastWorkSeq()` and `holistic() → HolisticFold` ("M3: the fold").

## Choices made in 1a

Where the plan left a shape open. Each is the simplest shape that keeps illegal states unrepresentable.

1. **`launch.json` terminal names `backend`, not `triple`.** The plan's table lists `triple`; the owner ruling
   allows a model id only inside `argv`. The triple is derivable from `{role, routingRev}` and the unit's risk.
2. **`purpose` lives inside `terminal`**, not beside it: `backend{purpose: backend|smoke}` and
   `command{purpose: lane|teardown|probe|smoke}`, so a purpose/terminal mismatch is unrepresentable.
3. **OpId seq = event-log seq of the op's first intent**; retries keep the op and bump the ordinal, so
   `ROADMAP_OP` finds every ordinal. The journal allocates it (`Journal.begin`), no separate counter.
4. **`done` and `abort` carry `op`; `done` also carries `kind`** so its outcome is validated without the fold.
   `recoveredBy` is `null | reconciled | redone | adopted`; `lost` and `recovery-required` are outcomes closed
   with `recoveredBy: 'reconciled'`; `park` leaves the intent open.
5. **`post` is `null` for kinds whose kind + `expect` fix the postcondition** (worktree, resource, proc,
   integration.ff, command.apply). Git kinds put the expected new id in `post.new`.
6. **Non-zero exit without schema-valid output → `process-fault`** (the plan states only the schema-valid case;
   parking beats an uncharged resume for a CLI that failed outright). `classifyTerminal` never yields
   `refusal`; the adapter does, from a stop reason.
7. **`exit.json.child` adds `spawn-failed{error}`** (cause `exited`), a process fault.
8. **`cancel.json.reason` is `pause | stop | recovery`**: deadline kills are the runner's own; cause
   `recovery-kill` in `exit.json` is a cancel with reason `recovery`.
9. **Usage split**: `meter` facts carry known token usage; `usage-unavailable` facts carry the reason. One fact
   per inv either way, written before the spawn's done. `subject: MeterSubject = seat{role, tier, unit,
   attempt} | smoke{backend}`: a unit call names its seat (`tier` is the seat within the role, `escalation` only
   for a judgment role, so `(role, tier, routingRev)` names one seat and a by-model view is exact; 13b); a start-up smoke is charged to its backend,
   never to a seat, so seat spend is the units' own (arc-1 feedback item 24d).
10. **`dispatch` fact** holds the `DispatchRecord`, so the pin is in the WAL.
11. **`plan.json` gains `resources: ResourceDecl[]`** (probe + teardown per named resource) and the probe exit
    contract `0/10/11`: the startup row "resource request unknown" and the reservation cycle need declarations
    the plan's M1 shape omitted.
12. **Run-input paths in `plan.json` (`rulings`, unit `spec`) are relative to the plan file's directory**;
    product paths (`contracts`, `architectureDoc`, `architectureDigest`) are repo-relative.
13. **Lane `env` = `{set, pass}`**: literal values, plus host variables that must exist (missing →
    `spec-lane-unrunnable`).
14. **Spec items carry `state`**; strike and defer never delete, so ids are never reused. Scope and resources
    are not patchable in M1. `SpecPatch.by` is a plan-check redirect or, from step 12, the executor appending
    an implementer's decisions.
15. **Id forms**: slugs for arc, unit and resource ids (safe in refs and file names); `cmd-<16 hex>`;
    `NeedsUserId` prefixes `nu-`, `sup-`, `host-`; `RoutingRev` = 16 hex content hash; session ids are uuids.
16. **Fingerprint and dispatch sets are sorted arrays**, not maps, so canonical bytes compare equal.
17. **Resource transitions move a set in lock order**; a partial cleanup is two ops (`release` for the cleaned
    subset, `fail` with one residue per failed resource).
18. **Host startup refusals beyond the table** (`recovery-holder-dead`, `owner-mismatch`, `log-corrupt`,
    `containment-mode-changed`) are members of `StartupRejection` so `status` explains them the same way.
19. **`RunLocator`**: run commands default to the host lock claim; `--repo` + `--arc` reach a run with no live
    owner.
20. **Readiness, handshake, `exit.reason.json` and `supervisor.state.json` live in the host dir** beside the lock
    they belong to; `heartbeat.json` lives in the run dir the architect's Monitor watches.

## M2: scheduling, resources, parks (frozen in M2 step 0a)

The records are in place above; this section fixes their semantics and the scheduler's interfaces
(`src/schedule/types.ts`, `src/schedule/graph.ts`), which later steps implement. DESIGN-1.0.md §2.2 is the prose.

**Resources.** `ResourceUnit = ResourceName | PoolInstance | CpuToken` (Ids). Holders reserve all-or-none in lock
order. `CPU_COST`: judgment 1, build `unit.cpu ?? 4`, fast lane 2, estate lane 4 (`LaneDef.cpu` overrides), probe
and teardown 0; the `@cpu` pool has `plan.capacity.cpu ?? availableParallelism()` tokens; a legacy arc requests
none. Entry reservations (`EntryReservation`, F6), taken before a stage's first journaled op: plan-check and gate
`@cpu`×1; build the unit's resources and its `@cpu`; lanes the first lane's set; candidate the publication
(`integration-slot`, held by `publication{unit, attempt}` through `ff` and `snapshot` once green, A2); prepare none.
`Acquire(request: ResourceRequest{named, pools, cpu, publication}, holder, rank, signal) → granted{units} |
cancelled` (a cancelled wait journals nothing). Plan-load refusal for a new arc or a new pool:
`plan-invalid{over-capacity{unit|null, lane|null, resource, requested, total}}`. Reclaim order under a `retry`
holder (F2): `reclaim` → teardown → on pass the residue's `cleaned` disposition in the host index → `release`.

**Parks (A7).** A park's class is fixed per table row (`ParkClass` in `src/pipeline/transitions.ts`,
`parkClassOf`): retryable rows are plan-check/build/gate `process-fault`, build `lost`, every `cleanup-failed`,
lanes `blocked` (after its retry), candidate `blocked`, salvage `commit-failed`; operator `env` rows are
`routing-changed`, `occupied`, salvage `unmerged`, candidate `base-red`; every other park is operator `design`
(the chargeable bound, a refusal or escalation at the top seat, a bounded round or retry run out, `empty-diff`,
a red candidate). `ParkRecord = retryable{targets: ProbeTarget[] (sorted by probeTargetKey, unique, non-empty)} |
operator{kind: env|design}`, written inside the parking fact (F9). `ProbeTarget = backend{backend} | host |
resource{instance: ResourceInstance}` (one per failed instance, F10; `probeTargetKey`: `backend:<b>`, `host`,
`resource:<i>`). A park at seq P recovers when every target has a `probe{result: pass}` whose `covers` includes P;
the fold then restores `decided`/`interrupted` to their pre-park values (the parked stage re-runs) and records
`lastRecovery`. A pass covering a park that is no longer current changes nothing (stale); a cover of a seq that
parked nothing (other than a resource target's residue fail seq, below), of an operator park, or of a park that
does not target the probed target is refused. A host
probe's `covers` are the parks it ran each local check for, fixed when it starts (G7). The resource target's
pass is written only after its reclaim order completed. `unparked` re-runs an operator-env park; a design park
needs `reopened` or a re-entry.

**Residue probing (lead ruling 2026-09-30).** Residue repair is keyed to the residue, not to a park: a failed
cleanup that no stage outcome parks (recovery's cleanup of a killed holder, whose attempt gets no outcome) is
probed all the same. The fold keeps `ResidueState = {key: ResidueKey, holder: stage{unit, stage, attempt}, fail:
OpId, failSeq, at}` per instance (M3: `holder` a stage or job holder; a job reclaims its own, "Choices made in M3 A4"
item 8): set by a done `fail` (its op, seq and done time; the key is this arc's, the
holder's unit, the residue's teardown and instance), dropped by the instance's next `release` (so a residue
disposed but not yet released stays until the reclaim order ends). `residueTargets` are those whose instance is
`cleanup-failed` or `cleaning` under a `retry` holder (a sweep's is its command's). Each is a `resource{instance}`
probe target whether or not a park names it; its job covers the residue's `failSeq` beside any park seqs, so a
unit park on the same instance shares the one job, the same backoff and the same `probe` fact. The job reclaims
under `retryHolderOf`: the `retry` holder already cleaning the instance, else `retry{holder.unit, holder.stage,
holder.attempt}` from the residue (the frozen holder shape expresses it; nothing is added). A residue no current
retryable park is outstanding on escalates `PARK_ESCALATE_MS` after `at`: one non-blocking `park-escalated`, subject
`arc`, parented `op{fail}`. A residue parks no unit, so it counts toward no breaker trip (its instance is withheld
from every reservation until reclaimed). The run does not end `complete` while any residue is left, and `status`
shows each under `host.probes`. An adopted dev.4 arc's cleanup-failed resources are residues like any other.

**Park schedule (step 3 implements).** `PROBE_BACKOFF_MIN = [0, 1, 2, 4, 8, 16, 30]` then 30 repeatedly (each
failed probe's `nextProbeAt`); `PARK_ESCALATE_MS` 6 h → a non-blocking `park-escalated` needs-user, probing continues
(D2); `PARK_REPEAT_MS` 6 h: the same unit parking on the same target within it of a recovery parks operator
(`env-blocked`); breaker: `BREAKER_UNITS` (2) distinct units parked on one target within `BREAKER_WINDOW_MS` (1 h)
trip it (derived), blocking admission of the stages that need it, with one non-blocking `env-blocked` item.
`Prober = {due(view, now) → ProbeJob[], run(job, signal) → pass|fail}`, `ProbeJob = {target, covers}`, at most one
job per target at a time.

**Backend parks (F12).** Per backend the fold keeps the latest `backend-park` fact's seq (its epoch) and a class:
`usage-limit` if the current or the new park is one (it dominates until `resume --backend`, D4), else the new
park's (`capacity`, `outage`: `RETRYABLE_BACKEND_PARKS`). A `probe{target: backend{b}, result: pass}` clears the
park only when it covers exactly the current seq and the class is retryable. `resumed{backend}` clears whatever
park is current. Either releases the holds with `cause: backend{b, parkSeq ≤ the cleared seq}` of units no pause
covers; `resume --backend` also releases cause-less holds of unpaused units (a hold recorded before M2).

**Graph (F15, D1).** `effectiveGraph(units)` maps each unit no other re-enters to its `after` dependencies with
every superseded unit replaced by its lineage head (`lineageHead`, transitively; two re-entries of one unit
throw); `findCycle` returns a cycle as its units, first repeated last. The classifier refuses an apply whose
effective graph has a cycle (`top after old` plus `new after top, reenters old` is one). At run time
`effectiveDependency(view, dep)` moves an edge to the successor only once the successor's `prepare` recorded an
outcome (`lineage.prepared`); until then the edge waits on the superseded unit, which never merges. A legacy
arc does not use the graph: `legacyNext(view, units)` is its frontier.

**Priority (F17).** `Rank = {unit, origin, waitStartSeq, bypassMerges, promoted, planIndex}`; `promoted` when
`bypassMerges >= PROMOTION_BYPASS` (3). `compareRank`: promoted first by `waitStartSeq` alone; the rest by
`ORIGIN_RANK` (repair 0, checkpoint 1, planned 2; M3 added `repair`), then `waitStartSeq`; plan index last, so the order is total.

**Admission (A12, A17).** `ADMISSION_STAGES = prepare, plan-check, build, lanes, gate, candidate`; chains
(`BUILD_CHAIN` quiesce → evidence → salvage → teardown, `PUBLICATION_CHAIN` ff → snapshot) run to completion
under pause and drain. `TaskState = idle | awaiting-admission | in-stage | in-chain` (memory only).
`Admit(input: AdmitInput{view, plan, unit, stage, blocking, drains, tripped}) → admit | wait{constraints}` with
`AdmissionConstraint = paused{arc|unit} | drain{command} | run-only | backend-parked{backend, class} |
breaker{target} | base-red | blocking-item{id, reason}` (M3 adds `finding-blocked{finding, obligation}`). `CommandScope = arc | units{units} | none`;
`ScopeOf(body, view, plan)`: `resume` (all), resource, pool, capacity and routing edits → arc; `resume <u>` →
{u}; spec and unit edits → those units; `sweep`, `resume --backend`, `resolve-edge`, `run-only` → none.

**Crash selector (G8).** The seam stays `crashPoint(label, unit?)`. A trigger file is `{label, occurrence, unit?}`;
with `unit` only the calls passing that unit count (the plan's `<label>@<unit>:<n>`), without it every call of
the label counts, as in M1. A call site passes the unit whose op reaches it (`parentUnit`, `recordUnit` in
`src/core/events.ts`): a journal append its record's (an intent's stage parent, followed through op parents; a
done's or abort's op's; a fact's own `unit`, a usage fact's invocation's op's); a spawn, launch or kill its spawn's; a
resource transition, retry or residue its holder's; a git, spec or needs-user op its intent's stage parent;
`unit.after-stage` its unit. Process- and arc-level labels (runner, supervisor, host, recovery, probe, command,
plan apply, log open, `kill.after-cancel`) pass none. The concurrent crash matrix crashes by unit
(`test/concurrent-matrix.test.ts`).

## M3: the holistic layer (frozen in M3 step 0a)

The records and signatures of both M3 batches (plan `/claude-state/plans/m3-holistic.md`, revision 2.1). The types
and readers are in `src/core/{ids,records,events,state,interfaces,upgrade}.ts`, `src/holistic/{types,table}.ts`,
`src/input/{plan,cli}.ts`, `src/routing/{types,profiles,layers}.ts`, `src/prompts/{inputs,schemas,index}.ts` and
`src/schedule/types.ts`; the behaviour is the later steps' (A1–A5b, B1–B11). DESIGN-1.0.md §2.3–§2.10 (draft 8) is
the prose.

**Ids** (`src/core/ids.ts`). `VisionClauseId` `V-<n>`, `QuestionId` `Q-<n>` (a vision open question), `ObligationId` `I-<n>`, `FindingId` `F-<n>`,
`DivergenceId` `D-<n>`, `JobId` `<audit|ckpt|docs|batch|baseline>-<n>` (`jobId(kind, n)`, `parseJobId`,
`jobIdOfKind(kind)` for a field that names one kind), `LaneRev` and `EnvId` (16 lowercase hex). A numbered id's `n`
is 1 for the first of its kind in the arc and one more each: findings and divergences by the order their facts
open them (`nextFindingId`, `nextDivergenceId`), jobs per kind by the highest the log named (`nextJobId`; a job is
named by a `job` parent or holder, a docs `pub`, a batch candidate, a `witnessed{for: job}` or its opening fact).
Ids are never reused; a withdrawn clause and a closed question keep their ids (H16).

**Vision** (`roadmap/vision-m3`, `plan.holistic.vision`; `parseVision`). `{schema, rev: positive, confirmation:
{ref, at}|null, clauses: [{id: V-n, kind: world|purpose|serves|good|non-negotiable|tradeoff, text, rank:
positive|null (exactly for a tradeoff), state: active|withdrawn}], questions: [{id: Q-n, text, bears: V-n[]
(ascending, non-empty), assumption (non-empty), state: open|closed}]}`, clause and question ids unique, at least one
active `world` clause. A `world` clause is a prose scene of the target world (who is there, what they do and
experience, why it is better than today) and may describe a horizon beyond this arc; the other kinds are its facets.
A question is a vision open question (its answer would change the target world; a design question belongs in a spec
or a ruling): an open one bears on active clauses of the file, a closed one on clauses of the file; `assumption` is the
working assumption the arc acts on meanwhile. The skill authors a readable `vision.md` and compiles it to this
record; `confirmation.ref` is `vision.md#sha256:<hex>` (path relative to the plan, sha256 of the confirmed
vision.md's bytes), stored as an unverified string: the executor never reads vision.md. Owner-only: only an
architect `apply` (source `command`) changes it (A14); an edit keeps every clause and question id, a withdrawn clause
withdrawn and a closed question closed, each as it was (`visionEditReasons`). A new bundle, ruling or obligation may
not cite a withdrawn clause (A1 refuses it); existing citations stay and are reported. Coverage
(`visionCoverage(vision, advances, obligations, citers)`) is `VisionCoverage{unservedAdvanced (active clauses in
advances no non-exempt obligation serves: a gap), horizon (active clauses outside advances: expected, never a gap),
obligationsServingNone, withdrawnCited[{clause, citedBy}]}`.

**Obligations** (`roadmap/obligations-m3`, `plan.holistic.obligations`; `parseObligations`). `{schema, cutLine,
lanes: ArcLaneDef[], obligations: ObligationDef[], mapping: {paths: [{pattern: RepoPattern, obligations: I-n[]
(ascending, non-empty)}]}}`. `ArcLaneDef = LaneDef & {reporter: node-test|go-test-json|jsonl}` (R1, R3; a node-test
lane may not set or pass `NODE_OPTIONS`); `laneRevOf(lane)` = first 16 hex of sha256 over its canonical definition.
`ObligationDef = {id, rev (normative; evidence refreshes never bump it), statement, docRef{path, anchor, quotedText},
serves: V-n[] (ascending; non-empty in an arc with a vision, checked by A1), witness{lane, testIds (unique,
non-empty)}|null, proofJudgment{verdict: proves|insufficient, obligationRev, laneRev, witness{lane, testIds}}|null, deliveredBy: UnitId[]
(non-empty for a future one), activation: future|must-hold, parent?, contracts: RepoPath[], state: active |
split{children} | waived{ruling} | deferred{ruling} | retired{ruling}}`. The reader checks: ids unique; `witness`
and `proofJudgment` null exactly on a split parent (H14); a split parent's children exist and name it as `parent`,
and a `parent` is a split parent listing the child; a witness lane is one of the file's lanes; mapping ids exist. A
stale proof judgment (its `obligationRev` or `laneRev` no longer the obligation's or the lane's, or its `witness` not
exactly the obligation's; M3 Checkpoint A) is the classifier's to refuse (A1), not the reader's. `isExempt`: waived, deferred or retired.

**The transition table** (`src/holistic/table.ts`, `obligationEffect(case) → measured | latch | red | discharged |
exempt`, total; test `table.total`): exempt → exempt; future not completing its `deliveredBy` → measured; future
completing, held → latch (on publication), otherwise red; must-hold held on the tree or validly reused →
discharged, otherwise red; a split parent (never witnessed directly) → red when any selected child is red,
discharged when every non-exempt child is discharged (all exempt: discharged), else measured. The caller passes
the effective activation (a latched future obligation is must-hold). `brakes(effects)`: any `red`.

**Impact selection** (signature frozen for A1's `src/holistic/impact.ts`, read by A3's fingerprint and B2's
candidate): `SelectObligations(ImpactInput{obligations, units[{unit, declared, repairs}], closure, changedPaths,
revised}) → ObligationId[]` (ascending, split closure applied both ways, H14; `revised`: a revision publication's
added, split or re-witnessed obligations, G12).

**Witness records** (`witness.json` in the lane execution's evidence dir, `witnessDir` in src/git/snapshot.ts, see "Choices made in M3 B2"; `witnessRecord`). `{v, lane, laneRev, envId,
treeSha, inv, runner: Reporter, purpose: witness|mutant, records: [{testId, selected: nat, outcome:
pass|fail|skip|zero-selected}] (ascending by testId), malformed}`; malformed ⇒ no records (every declared test
unwitnessed). `ObservationVerdict = held | not-held | partial | unwitnessed`; `ObservationKey = {treeSha, lane,
laneRev, envId}` (`observationKeyText`); `VerdictOf(record, witness) → ObservationVerdict` is B1's (pure,
`verdictOf` in src/holistic/observe.ts; the witness protocol is "Choices made in M3 B1").

**Ruling sidecars** (`roadmap/ruling-m3`, `parseRulingSidecar`; `rule <record.json>` and a bundle's `rulings`).
`{schema, id: C-n, statement, kind: constraint|decision|deviation|disposition, ruledBy: architect|checkpoint{job},
trigger, supersedes: [{id, part|null}], condition|null, docRefs: [{path, anchor, quotedText, relation:
consistent|refines|deviates}] (non-empty), contractRefs (ascending), contractOps: [{path, anchor, oldText, newText}],
obligations (ascending), obligationDispositions: [{id, disposition: waived|deferred|retired|amended}] (ascending by
id), cites: V-n[] (ascending), evidence: string[], appliesTo: arc|units{units}, lifetime: arc|standing, status:
active|superseded|withdrawn, consistency}` with **`consistency` required (G21)**: `{verdict: consistent|inconsistent,
judgedRevs: {head, ledgerSha256, obligationsSha256|null, visionSha256|null, contracts: [{path, blob}]}, by:
judgment{role: FreshRole, routingRev}|architect}`. The reader requires contract ops for a `deviates` ref, and cites
and evidence for a checkpoint's ruling; staleness of `judgedRevs` is A1's check at commit. `head` is provenance only
(lead ruling 2026-09-30): a judgment is stale when the ledger, obligations, vision or a judged contract's blob
moved, never merely because a unit merged; docRefs are re-checked at the tip regardless.

**Revisions** (G1, A2, A19). A revision's inputs are the plan, the specs, the ledger with its sidecars, the
obligations and the vision: `RevisionManifest = PlanManifest & {rulings: {ledgerSha256, sidecars: {C-n: sha256}},
obligations: sha256|null, vision: sha256|null}` (kept as `inputs/<sha256>.rulings.md`, `.ruling.json`,
`.obligations.json`, `.vision.json` beside the plan and spec bytes). An `apply` body's `manifest` is an
`ApplyManifest = PlanManifest | RevisionManifest` (`isRevisionManifest`; a dev.5 command's is read by
`applyInputsOf`). The evaluated payload, `RevisionPayload = {v, source, base, rev = base + 1, manifest, changes,
dispositions: [{obligation, disposition, ruling}], divergences: DivergenceDraft[], publication: {renders:
[{path, sha256}] (the executor-rendered `.roadmap/` files), contractOps}|null, routingProvenance}`
(`parseRevisionPayload`), is kept as `inputs/<sha256>.revision.json`, then a `revision.commit{source, base, rev,
payloadSha256, docs}` intent (key `revision`, `REVISION_FENCE_KEY`: at most one open) names it before any docs
`ff`; `plan-applied` is appended from it exactly, then its divergences in order, then the intent's done
`applied`. Recovery: the docs `ff` done or no docs step → append from the payload; else abort (and re-evaluate the
source). `RevisionSource = start | command{command} | bundle{job: ckpt-n} | executor{inv}`. The fence (A19) is that
key: `judgment-inputs`, `audit-started`, `checkpoint-inputs` and a bundle's staleness check are captured only while
no `revision.commit` is open. `base` is 0 for an arc's first revision (its first start records rev 1 through the
same activation record; step A2).

**`plan-applied` (M3 fields, all optional)**: `source` (with `command`: a `command` source names the fact's command,
any other source has `command: null`), `payloadSha256`, `rulingsSha256`, `obligationsSha256` (only with a vision),
`visionSha256` (present exactly while the arc is holistic, A5), `publication{pub: docs-n, head}`, `routingProvenance
= {profile, repoConfig: {seats, classes}, planLayer, unitLayers: {unit: layer} (ascending)}` (H7; every M3 revision
records it). New `PlanChange`s: `obligation{id, edit: added|split|witness|disposed|restored|edited}` (`restored`:
an exempt obligation active again; `edited`: its serves, contracts or deliveredBy changed, or future → must-hold; both
added in step A2), `mapping`, `vision{rev}`, `limits{unit|null}`, `holistic`, `advances` (`holistic.advances` changed); `routing{routingRev, unit?}` (with
`unit`: that unit's layer changed, and the rev is its routing's).

**Facts** (`HolisticFact`, `src/core/events.ts`; one of each round-trips in `test/m3-schemas.test.ts`):

| Fact `kind` | Fields |
|---|---|
| `witnessed` | `lane, laneRev, envId, treeSha, inv, recordsSha256, purpose: witness\|mutant, for: candidate{unit, attempt} \| job{job} \| mutant{finding, of}`; `purpose: mutant` exactly with `for: mutant` (G13: never certifies). Batch lanes are `job{batch-n}` (H4) |
| `obligation-latched` | `obligation, unit, treeSha`: after `ff{published}`, before the snapshot; once per obligation |
| `finding-opened` | `id, key (findingKey = sha256 of canonical {lens, obligation, cause}), lens: LensKind\|witness\|plan-check, severity: P1\|P2\|P3, obligation\|null, visionClauses (ascending), claim, evidence: [{path, blob\|null}], mutant: {patchSha256, lane}\|null (vacuity only), source: job{job} \| stage{unit, stage: plan-check, attempt}, gateHadPassed`. Plan-check (R17) opens only P3 findings citing clauses, from its attempt (the only `stage` source); a `witness` finding is a P1 over its obligation; a `vision` finding is P2 or P3 |
| `finding-transition` | `id, to: open \| owned{unit} \| fixed-on-branch{unit} \| resolved \| ruled{disposition: dismissed\|deferred\|accepted, by: checkpoint{job} \| ruling{ruling} \| code{reason: not-reproduced}}` |
| `audit-started` | `job (audit-n), triggers: [cadence \| unwitnessed{obligation} \| drift{planRev} \| wall-clock \| requested{command} \| final] (non-empty), generation, lenses (ascending, a subset of L), integrationSha, planRev, ledgerSha256\|null, obligationsSha256\|null, visionSha256, owners: [{unit, head}] (ascending), priorFindings, highWater` |
| `audit-ended` | `job, covered: [{lens, from, to}] (ascending by lens), findings, suppressed, outcome: completed\|abandoned` |
| `docs-covered` | `pub, from: U, to: D` (A17, H8) |
| `checkpoint-inputs` | `job (ckpt-n), trigger: audit{job} \| park{unit, seq}, generation, vector: {plan, specs: {unit: rev}, obligationsSha256\|null, ledgerSha256\|null, visionSha256, contracts: [{path, blob}]}, headSha, visionSha256 (= the vector's), findings, observations: ObservationKey[]` |
| `bundle-decided` | `job, outcome: no-op \| rejected{reason: stale\|evidence\|invalid, detail} \| requested{needsUser}`; an applied bundle is its `plan-applied{source: bundle{job}}` instead |
| `divergence` | `id, index (its place among its job's divergences), job, type: target-departed\|obligation-departed\|plan-departed\|contract-departed\|split-dropped\|interpretation, from, what, cites: V-n[] (non-empty), evidence (non-empty), preimage: {planRev, specs: {unit: rev}, obligationsSha256\|null, ledgerSha256\|null, contracts}, compensation: {hint, kind: restore-revision\|repair-unit\|none}` (H13: no executable inverse) |
| `divergence-digest` | `needsUser, ids: D-n[] (ascending, non-empty)` (H11) |
| `steered` | `unit, command, brief (sha256), budgetMin, resume` |
| `merged-in` | `unit, command, integrationTip, head` |
| `audit-requested` | `command, lenses \| null` |
| `admissions-closed` | `command` |
| `docs-published` | `pub, source: close-out, commit` |
| `arc-completed` | `planRev, head, highWater (< its own seq), units (merged, ascending)` |

**Op kinds** (M3): `docs.commit{ref = refs/roadmap-run/<arc>/docs/<pub>, old|null, pub: docs-n, integrationTip,
worktree, commit (parents [integrationTip])}`, post `{new}`, done `committed`; `mutant.apply{worktree, at, finding,
patchSha256}`, post null, done `applied{tree}` (the patched tree's real id) `| inapplicable{detail}`;
`revision.commit{source, base, rev = base + 1, payloadSha256, docs}`, post null, done `applied`. Git kinds:
`docs.commit`, `mutant.apply`. `integration.ff`: a unit `ff` is `{ref, old, new, fingerprint}` (the dev.5 shape,
no subject); a docs or batch `ff` is `{ref, old, new, subject: docs{pub} | batch{job}}` and has no fingerprint. `candidate.merge` `+ batch?{job: batch-n, members: [{unit, unitCommit,
fingerprint}] (≥ 2, each unit once), chain: [{commit, parents: [previous merge, next member]}] (one per member after
the first)}`: `unitCommit` is the first member's, `commit` merges it onto the tip, and `post.new` is the last
chain commit. Keys: `revision` for `revision.commit`.

**Holders, parents, subjects, residues.** `Holder += docs{pub}` (a docs publication's slot, A7), `batch{finding,
attempt}` (a repair batch's slot, G5, H4), `job{job}` (a job's lanes); keys `resources:docs/<pub>`,
`resources:batch/<finding>/<attempt>`, `resources:job/<job>`; `holderUnit(holder)` (null for sweep, docs, batch,
job). `RECLAIM_HOLDERS += job`; `RESIDUE_HOLDERS = stage, job` (a failed cleanup under either records residues).
`Parent += job{job}`. `SpawnSubject += arc-backend{role, tier: arc, routingRev, job, attempt}` (a lens or checkpoint
call), `journey{lane, laneRev, at, owner: unit{unit}|job{job}}`, `mutant{finding, lane, laneRev, tree}`; the unit
`backend` subject names a `UnitSeatRef`. `MeterSubject += job{job, attempt, role, tier: arc}`; `seat` names a
`UnitSeatRef`. `ResidueKey = {arc, inv, resource} & (unit | job)` (exactly one; `residueOwner(key) → unit{unit} |
job{job}`, G4); `ResidueState.holder` is the stage or job holder.

**Stage outcomes and the transition table** (`src/pipeline/transitions.ts`). Stage `reproduce` (a vacuity repair's
first stage, an admission stage): `reproduced` → plan-check; `not-reproduced` and `inapplicable` → park operator
design, reason `not-reproduced`; `blocked` → park retryable `lane-blocked`; `interrupted` → hold; `cleanup-failed` →
park retryable `residue`. Candidate `preempted` (A7) and `finding-blocked` (G10) → candidate again, uncharged
(admission holds it while the P1 blocks: `AdmissionConstraint finding-blocked{finding, obligation}`). The bounds
are the unit's: `UnitState.bounds` (its latest dispatch record's `bounds`, else `DEFAULT_BOUNDS`) replaces the
constants in the table (`Bounded.bound` names the field) and in the fold's chargeable invariant; `MAX_*` and
`CHARGEABLE_BOUND` remain as the built-in values. `ORIGIN_RANK = {repair: 0, checkpoint: 1, planned: 2}` (R6).

**Commands** (M3 bodies; scopes per the plan's table, `commandScope` in `src/input/classify.ts`): `rule{path,
sha256}` (none), `reverse{divergence}` (arc), `steer{unit, brief{path, sha256}, budgetMin, class|null, resume}` ({u}),
`merge-in{unit}` ({u}), `audit{lenses|null}` (none), `close-admissions` (none). Each runs since the step that
implemented it: `reverse` A2, `steer` and `merge-in` A3, `rule` A4, `audit` and `close-admissions` B7
(`src/commands/{audit,admissions}.ts`). `gc` runs since A5b (`src/commands/gc.ts`).

**Needs-user reasons** (M3). Blocking: `obligation-baseline`, `finding-p1-escalated`, `new-finding-draining`,
`steered`, `not-reproduced`, `owner-request`, `respec-second`. Non-blocking (`NON_BLOCKING_M3_REASONS`):
`bundle-request`, `convergence-bound`, `convergence-identity`, `audit-owed`, `divergence-digest`.

**Prompts** (`src/prompts/`). Since B4: lens/Opus a module, lens/Fable inherits it; checkpoint/Fable a module,
checkpoint/Opus inherits it; Sonnet and Codex are `unsupported` for both, so a holistic plan seating either role on
one is refused `unsupported-routing{role: lens|checkpoint, tier: arc, why: no-prompt}` at startup. Inputs (vision first, A14): `LensInputs = {vision: VisionInput{rev, clauses, questions, advances} (`visionInputOf`;
`advances` from the plan at the revision the inputs were captured at),
lens, obligations: ObligationView[] ({obligation, exempt, observation{key, verdict}|null}), range{from, to, diff},
owners[{unit, head, diff}], priorFindings: FindingView[], contracts, rulings, index, architecture, checkout}`;
`CheckpointInputs = {vision, trigger, head, plan (rendered), findings, obligations, coverage: VisionCoverage,
divergences[{id, type, what}], contracts, rulings, index, architecture, direction}`. Outputs (strict; every key
required): `LensOutput = {findings: [{severity: P1|P2|P3, obligation|null, visionClauses, claim, cause, evidence:
[{path, line}], mutant: {patch, lane}|null}], reasons, premises}`; `CheckpointOutput = {decision: no-op|bundle,
reasons, ops: BundleOp[] (empty exactly on a no-op), rulings: string[] (sidecars as JSON text; none on a no-op),
findingDispositions[{finding, disposition, reason}], interpretations[{clauses, situation, reading}], cites{vision,
observations, findings}, premises}`, `BundleOp = (admit{unit{id, risk, scope, after, origin: checkpoint|repair},
spec (spec.json text)} | patch-spec{unit, patch} | reenter{unit, reenters, enterAt|null, reset|null} | cut{unit,
reason} | route{unit, seats[{role, tier, class}]} | limits{unit|null, limits[{field, value}]} |
obligation-split{obligation, children[{id, statement, docRef, witness, activation, deliveredBy}]} |
obligation-dispose{obligation, disposition, ruling} | invalidate-approval{unit} | rule{ruling} | request{class:
OwnerOnlyClass, summary}) & {cites: V-n[] (non-empty, unique), evidence (non-empty)}`; `OwnerOnlyClass = destructive
| cost | legal | vision | resource | config | gc | ref-deletion | lane-program | env-prerequisite | contract-path`
(A16: no op touches the vision, resource declarations, `.roadmap/config.json`, `gc` or ref deletion). **B4 added**
(frozen here in 0a, landed with the modules, because every key of a strict schema is required and the modules,
fakes and output change together): plan-check output `visionConflict: [{clauses: V-n[] (non-empty), note}]` (each opens a P3
`plan-check` finding, R17); `PlanCheckInputs.vision: VisionInput | null` (read-only context, marked non-directive);
`GateInputs.obligations: ObligationView[]` (the selected obligations); the gate never receives the vision.

**The fold** (`src/core/state.ts`, `JournalView.holistic() → HolisticFold`, `state.json` `holistic`):
`{on (the plan in force records a vision), witnessed, latched, findings: FindingState[] ({...opened, state, owner,
openedSeq, last}), audits: [{started, ended|null}], auditRequests, docsCovered, docsPublished, checkpoints: [{inputs,
decided: applied{planRev} | BundleOutcome | null}], divergences, digests, steered, mergedIn, draining: {command,
seq}|null, completion: {…arc-completed, seq, active}|null}`, each entry with the seq of its fact. Coverage
watermarks, observations, generations, convergence counters and the digests to raise are pure derivations over it
(B1, B5, B6). Invariants (refused as `log-corrupt` at open, never appended): a finding opens as `nextFindingId`, and
not with the key of a finding that is still open, owned or fixed-on-branch (it merges instead); a move follows
`FINDING_MOVES` (open → owned | ruled; owned → fixed-on-branch | open | ruled; fixed-on-branch → resolved | owned |
open | ruled); one audit runs at a time, audits and checkpoints open as the next job of their kind, an audit ends
once, covering only lenses it ran and naming known findings; a checkpoint decides once (`bundle-decided`, or its
bundle's `plan-applied`); a divergence is the next `D-n`, of a checkpoint job, once per `(job, index)`; a digest
binds recorded ids no earlier digest bound; `admissions-closed` only while not draining (an architect apply that
adds a unit reopens, §2.10); a `plan-applied` keeps the vision once the arc is holistic (A5); an obligation latches
once; `arc-completed` names the plan in force and a high-water before its own seq; a batch `ff` names a batch
candidate. A batch `ff{published}` records a publication for every member and retires them (R7, H4).
`completion.active` (A20): the plan rev and `integrationHead()` are those it recorded and no `reopened` followed.
`lastWorkSeq()`: the latest record that is work, meaning any fact but `executor-started`, `containment-mode`,
`tail-discarded`, `arc-completed`, `docs-published`, `probe`, `backend-park` and usage facts, or an intent with a
stage, job or command parent, or a `revision.commit`. `gc` (A5b) seals an arc whose completion follows its last
work, whose queue is empty, whose head is in integration history and whose ref verifies (H5).

**Choices made in M3 0a** (where the plan left a shape open or could not be frozen as written):

1. **`obligationRevs` is absent exactly when empty**, not defaulted to `[]` after raw validation: a fingerprint
   selecting no obligation is byte-identical to a dev.5 one, so every existing comparison (`sameFingerprint`,
   canonical equality) holds unchanged and no default is warned. `obligationRevsOf` reads it.
2. **`ResidueKey` carries `unit` or `job`**, not an `owner` field: a dev.5 key is a unit-owned key as written
   (byte-preserving); `residueOwner` is the plan's `owner` view.
3. **A unit `ff` keeps its dev.5 shape**; only docs and batch `ff`s carry `subject` (and no fingerprint).
4. **A divergence's kind is its `type`**: the fact's own `kind` is its discriminator.
5. **Bounds reach the fold through the dispatch record** (`bounds?`, pinned per dispatch like the risk floor): A3
   owns neither `transitions.ts` nor `state.ts`, so 0a threads `UnitState.bounds` into the table and the chargeable
   invariant, and A3 writes `bounds` (and `transientRules: 'm3'`) at every dispatch.
6. **The arc seats are hashed only in a holistic arc** (`routingRevOf(table, holistic)`), so every dev.5 routing rev
   is reproduced by dev.6 code and nothing is re-pinned on upgrade; `planStack` sets `holistic` from the plan.
7. **`preempt` is a lane-only interrupt reason** (`LANE_INTERRUPT_REASONS`): a backend call is never preempted.
8. **`reproduce inapplicable` parks with reason `not-reproduced`** (design): the frozen reason list has no other fit.
9. **`amended`** is an obligation disposition beside `waived | deferred | retired`: a statement, docRef or
   activation change is weakening and needs a ruling naming it.
10. **Rev 1's unstated fact shapes** (`steered`, `merged-in`, `audit-requested`, `admissions-closed`) and
    `arc-completed.units` (the merged units) are fixed as in the table above.
11. **`gc` takes `--repo`**: run dirs live under a repo's git common dir.
12. **The checkpoint output carries sidecars and a new unit's spec as JSON text** (`rulings`, `admit.spec`),
    validated by their own readers at activation, so the strict output schema stays finite.

**Choices made in M3 A1** (anchors, contract ops, ruling validation, the obligation classifier, impact selection;
src/docs/contracts.ts, src/spec/rulings.ts, src/holistic/{obligations,impact,rederive}.ts):

1. **Anchors** (`anchorSection`): `#<slug>` names the one Markdown ATX heading, outside fenced code blocks, whose
   GitHub-style slug (`headingSlug`) is `<slug>`; its section runs to the next heading of the same or a higher level.
   Any other anchor is literal text that occurs on exactly one line; its section runs from that line to the next
   heading. No match, or more than one, is refused. A docRef's `quotedText` must lie in its anchor's section at the tip.
2. **Contract ops** (`applyContractOps`, `validateRuling`): only on the plan's contracts and architecture doc, and
   only on a path the ruling's `contractRefs` lists. `oldText` occurs exactly once in its anchor's section; two ops of
   one ruling on one document whose sections overlap (a heading nested under another's section included) are refused,
   since their order would matter. Every edited document's first line cites the ruling (`<!-- revised by C-3, C-7 -->`,
   added or extended). All or none: every reason is listed.
3. **What a consistency judgment covers** (`consistencyRevs`): the ledger, obligations and vision bytes in force and
   the head blob of every path in `contractRefs` or a contract op, ascending. It is stale when any of those differs
   from what is in force at commit; `judgedRevs.head` is provenance only (lead ruling 2026-09-30).
4. **The split text rule** (`classifyObligations`): every sentence of the parent's statement (split after `.`, `;`,
   `!` or `?` and white space) occurs verbatim in some child's statement. The architect's split drops none; a
   checkpoint's drops text only citing active clauses, and the dropped sentences go to its `split-dropped` divergence.
   A split may not weaken: under a must-hold parent (a latched one included), a `future` child names at least one
   `deliveredBy` unit not yet published, else the split is refused (such a child could never latch; paid m3 run 7).
5. **Weakening needs a ruling** (`weakeningsOf`, `dispositionRuling`): removing an obligation is `retired` (removing
   one already retired is free); a statement or docRef change, must-hold → future, or a test id dropped from its
   witness is `amended`; a move to `waived`, `deferred` or `retired` needs that state's own ruling. Each needs a ruling
   in force whose `obligationDispositions` names the id with that disposition. Re-derivation at Phase 0 (`rederive`)
   applies the same test to the baseline tree's published `invariants.md` block (A2 item 9).
6. **A file a witness lane runs** (`selectObligations`): an argv entry of the lane joined to its `cwd` and normalised
   (posix), compared with the changed path. A changed path also selects through the obligation's contracts, its
   docRef's document and every mapping pattern it matches (`matchesPattern`, src/core/values.ts: a glob, or a
   directory prefix); a path no pattern matches selects every must-hold obligation.

**Choices made in M3 A2** (the revisioned-input core):

1. **Two frozen shapes extended additively**: `OBLIGATION_EDITS += restored, edited` (A1's classifier reports them);
   `revision.commit.base` and `RevisionPayload.base` admit 0 (`RevisionBase = PlanRev | 0`), so an arc's first
   revision (a start's rev 1) has a payload and an activation record like every other.
2. **Sidecars live beside the ledger** in `<ledger>.d/C-<n>.json` (`sidecarDir`); `InputFiles` carries the ledger,
   the sidecars, and the obligations and vision files `plan.holistic` names. The inputs in force beyond plan and
   specs are the latest `plan-applied`'s payload manifest's (`revisionInForce`); a dev.5 revision (no payload) has
   the live ledger and nothing else.
3. **The apply core** (`src/commands/apply.ts`): `evaluateRevision(ctx, proposal, proposer)` → `RevisionDraft`
   (the payload without its source) or reasons, synchronous; `commitUnderFence` holds the fence
   (`src/core/fence.ts` `holdFence`), evaluates again and requires the same draft, keeps the bytes and commits
   (`src/recover/revision.ts` `commitRevision`: payload, `revision.commit`, the docs publication through a
   `DocsPublisher`, `plan-applied`, divergences). `Proposer = apply | rule | reverse | start | executor |
   bundle{cites}` decides what may change: the ledger and sidecars only by `rule` or a bundle; the vision only by
   `apply`. `captureUnderFence(journal, capture)` is the brief synchronous capture for readers (H2).
4. **The publication plan**: `.roadmap/constraints.md` rendered when the ledger or sidecars change,
   `.roadmap/invariants.md` when the obligations do, each only when its rendering changes (bytes kept as
   `inputs/<sha>.render`), plus the contract ops of sidecars new in the revision. A start's changed files that need
   a publication are refused (apply them); an arc's first start publishes nothing. The executor's `DocsPublisher` is
   `src/pipeline/publish.ts` since A4 (`DOCS_NOT_YET` remains only for test contexts that publish no docs).
5. **Which publication carried a revision** is read from the log: the docs `integration.ff` begun after its
   `revision.commit` (`docsStateOf`). Recovery runs `revision.commit` after the git ops and before the command ops;
   an abort raises no needs-user (its source re-evaluates).
6. **Stale base (A4)** is the in-force revision's source: without `--expect-rev`, an apply is refused when it is a
   bundle's or the executor's (a `rule` or `reverse` is an architect command).
7. **Edit-class readings**: `route` sets any class at any seat (DESIGN §4), unsupported unit-role seats refused;
   `limits` refuses only a bound the edit changes to below what a unit spent; scope growth needs the unit's spec to
   cite an active ruling with a sidecar applying to the unit whose statement names exactly the added patterns (in
   backticks); a spec's `obligations` must cover every non-exempt obligation a mapping pattern that may overlap its
   scope names (literal prefixes), and a `repair` unit's spec names its repairs; `holistic.audit` is fixed once in
   force; a changed arc lane re-witnesses the obligations it witnesses (`witness`).
8. **`reverse <D-n>`** restores the plan, the specs its preimage names and the obligations where the act changed
   them; a ledger or contract preimage is refused (supersede by `rule`); a later revision that changed a touched
   artifact again refuses it. A dispatched unit's restored spec is the next rev of its recorded one.
9. **`obligation-dropped`** is reported as `plan-change-refused` (one `obligation-dropped: …` reason per id) at an
   arc's first start (`obligationDropped`).

**Choices made in M3 A3** (per-unit routing, limits in force, `steer`, `merge-in`, fenced captures):

1. **A unit's routing** is the arc's stack with the unit's layer on top (`provenanceStack(provenance, holistic,
   unit)`, src/routing/layers.ts): `StageContext.routing(unit | null)` and `CommandContext.routing(unit | null)`
   resolve it, in the executor from the `routingProvenance` of the revision in force (a dev.5 revision's rebuilt,
   `routingProvenanceOf`), never a live config. A unit without a layer has the arc's routingRev. Admission reads each
   unit's table (`admitter((unit) => table)`); `status` does too since B9.
2. **Every dispatch record since dev.6** carries `transientRules: 'm3'` and `bounds: boundsOf(plan, unit)`
   (`firstPin`); a re-pin copies both unless the plan in force changed the bounds. The dispatch check re-pins when
   the unit's routingRev, its bounds, its scope (a ruled growth: the fold admits a scope containing the previous one
   when a `unit-changed` revision of the unit followed the previous pin) or its planned risk (raised) changed; a moved
   implementer seat after a build started parks `routing-changed`. Windows: fresh build `freshBuildMin`,
   fix/resume/resolve `editAllowanceMin` (+ the lane series), judgment `judgmentDeadlineMin`, steer `budgetMin`.
3. **Entries outside the table** (`UnitState.entry`, `EntryPoint`, src/core/state.ts): `steered` (a parked unit, or a
   re-entry whose `prepare` decided and did not start) sets `{kind: steer}`; `merged-in` (an active, held or parked
   dispatched unit) sets `{kind: merge-in}`. The entry's stage (`ENTRY_STAGE`: build, lanes) runs next (`nextStage`);
   its first outcome that is not a hold clears it. Both void the approval and clear the park; a held unit stays held.
   `UnitState.steering {seq, resume}` marks the steer pass until it parks, stops, retires or its gate advances.
4. **The steer pass's exits** (`steerExit`, src/pipeline/transitions.ts): lanes `red`/`not-certified` and gate
   `revise` park `steered`; gate `approve` parks `steered` unless `resume`; each operator `env`, uncharged, so
   `resume <u>` re-runs the parked stage with the pass over. `decidedBy` reads such a park back as `steered` (a park
   where the table's rule goes on, or an env park of the gate's bounded revise).
5. **The steer round** is a fresh implementer session (`STEER_DIRECTIVE` and the brief, kept as
   `inputs/<sha256>.brief.md`), re-pinned whatever its seat (`steerDispatch`); its report is read as a fresh build's.
   `--class c` commits a revision setting the unit's layer `build.<build tier>` = c (proposer `apply`, source the
   command). Since A4 its plan bytes are written durably back to the live plan file only while that file hashes to
   the plan in force before the revision (the `plan-applied` preceding it in the log): `spec.patch`'s write-back
   rule. A run again after a crash (`planAppliedBy`) writes back the same way; a file the architect changed since is
   left alone and the receipt's `verified` says so. Stale base (A2 choice 6) treats a `command` revision as
   architect-owned, so a later `apply` of the unchanged file keeps the layer.
6. **`merge-in`** plans with the op's own prepare (`merge-tree`); a conflict, or a branch already containing the tip,
   is rejected before any intent. Its `mergein.prepare` op is parented by the command.
7. **Fenced captures (H2)**: plan-check and gate read their inputs, render their prompt and write `judgment-inputs` in
   one `captureUnderFence`; plan-check's checkouts are made after it, at the captured commits. The executor's spec
   patches (a redirect, the decisions) hold the fence (`holdFence`). A judgment's library reads the ledger in force
   (kept bytes; a dev.5 revision's live file).
8. **The gate's obligations**: `selectObligations` over the obligations in force, the unit's declared ones and
   repairs (a finding repair: its finding's obligation), its `after` closure's declared ones and its diff's paths;
   their observations are the tip's since B2 ("Choices made in M3 B2" item 6). The fingerprint's `obligationRevs` are the selected non-exempt ones.
9. **The risk floor** (DESIGN §2.3 `route`): a unit's risk below its Phase-0 floor (its risk in the first revision
   that planned it) is refused unless its spec cites an active ruling whose sidecar applies to it; a dispatched unit's
   risk may rise (re-pinned at dispatch).

**Choices made in M3 A4** (the docs publication, `rule`, preemption, eligibility, the transient check, job-owned
residues, the snapshot closure):

1. **The docs publication** (`src/pipeline/publish.ts`, `docsPublisher`) runs inside its revision's commit: the slot
   under `docs{pub}` (`pub` = `nextJobId('docs')`), the files (each render's kept bytes; each document the revision's
   new sidecars' contract ops edit at the tip T, applied in id order), `docs.commit` on `refs/roadmap-run/<arc>/docs/<pub>`
   (parents [T]; its checkout `<worktreeRoot>/<arc>/<pub>.checkout`), the transient check, the lanes, `ff{subject:
   docs{pub}}` T → the commit. `DocsOutcome.published` gains `settle` (src/recover/revision.ts): `commitRevision` runs
   it after `plan-applied` and the commit's done, so the slot is held through the activation; `settle` is
   `finishDocs`: a docs-only publication's `docs-covered{pub, T → D}` (no contract op: A17), the snapshot (parent
   `job{pub}`), the slot's release, each only where missing. A refusal before the ff releases the slot and aborts the
   revision. The new rulings are validated again at T under the slot (`validateRuling`, `rulingContextAt`), so a
   ruling judged against inputs no longer in force at T is refused as stale (G21; the judged head is provenance
   only, "Ruling sidecars" above).
2. **Selection (G12).** The rendered `.roadmap/` files are not changed paths of a docs candidate: they are executor
   renderings of in-force records, and as unmapped paths they would select every must-hold obligation. A docs
   candidate selects through its contract ops' paths only (`changedPaths`; an unmapped contract path still selects
   every must-hold, as for a unit) plus the revision's added, split and re-witnessed obligations (`revised`), split
   closure applied, read against the revision's own obligations. Green: every suite lane passes and no selected
   obligation's effect is `red` (latched: none; completing: none).
3. **A job's lanes** are a journey series (`runJourneySeries`, src/pipeline/lanes.ts): "Choices made in M3 B2" item 1,
   with Checkpoint A's AY for their evidence dirs and checkout integrity. A job's suite lane is spawned `journey{…,
   owner: job{job}}` too (the frozen `lane` subject names a unit), its `laneRev` `suiteLaneRev` (16 hex of sha256 over
   its canonical definition). `ROADMAP_WITNESS_FILE` is the one `ROADMAP_*` variable a launch.json may declare (src/core/records.ts).
4. **Preemption (A7).** The arbiter serves `acquireFirst` waiters (a docs slot, a job's lanes) before every unit
   waiter, in arrival order; a refused one's `onBlocked` runs after the evaluation. A docs publication refused the slot
   preempts its holder when that is a unit candidate with no recorded outcome (`preemptCandidate`,
   src/pipeline/integrate.ts); a candidate past green (its ff and snapshot chain) is waited for. The preempted
   candidate's lanes see `preempt` as their cancel reason (`LaneCancel`, src/pipeline/redlane.ts); every lane of the
   attempt that is running or starts later is killed `proc.kill{reason: preempt}`; the stage records `preempted`
   (uncharged) and releases the slot. `sched.json`'s queue lists unit waiters only (B7 adds `jobQueue`).
5. **Eligibility (G10)** is `findingBlocking` (src/pipeline/integrate.ts), read from the fold's findings: an active
   (open, owned or fixed-on-branch) P1 over an obligation of the approval's `obligationRevs` that the unit's spec does
   not repair (a finding repair repairs its obligation). Checked before a candidate records green (→
   `finding-blocked`), immediately before a unit `ff` intent (the frozen ff vocabulary has no `finding-blocked`: →
   `cas-stale`, whose fresh candidate records it), and by recovery before redoing a unit CAS (`unitRedo`). The
   known-regression exception (G11) is B2's (below).
6. **`rule <record.json>`** (src/commands/rule.ts): the record hashes as the CLI recorded, parses, and passes
   `validateRuling` at the tip; the proposal is the revision in force with `ledgerAfter` and `sidecarsAfter` (a
   superseded sidecar re-serialised with its new status), proposer `rule`, committed through `commitUnderFence`. Then
   the live ledger and each changed sidecar file take the revision's bytes only while they hold the previous
   revision's (a new sidecar: while absent); a file changed since is left alone and reported.
7. **The transient check (G17, H15)**: `candidateRequest` builds `TransientRules` from the unit's latest dispatch
   record (`unitTransientRules`): `m3` refuses any in-tree `.roadmap/` path (`roadmap-dir`) and any path no pattern of
   the pinned scope matches (`out-of-scope`; `matchesPattern`, src/core/values.ts, as salvage matches); a dispatch without `transientRules` keeps dev.5's
   rules (ROADMAP_ALLOWLIST, no scope check) for its lineage attempt; run-state, evidence and executor-file rules
   apply under both. A docs publication's diff may hold only the files it writes, matched exactly
   (`docsTransientViolations`, rule `not-docs`).
8. **Job-owned residues (G4, H4)**: a job holder reserves through a request but never takes `integration-slot`; a
   docs holder takes the slot alone. A job's teardowns, probes and lanes carry the owner label `<arc>/job/<job>`
   (`jobOwnerLabel`). A failed cleanup under a job holder records residues keyed `{arc, inv, resource, job}`, which
   the job's own holder reclaims in a unit retry's order (reclaim → recorded teardown → `cleaned` → release), through
   the residue's probe or recovery. Recovery treats a dead job like a dead stage (its spawns parented by `job{job}`
   settled, clean, teardowns, release or fail); an instance a job holds `cleaning` with an own-arc residue on it is a
   reclaim in progress and resumes the reclaim order. A docs holder found holding the slot is finished
   (`finishDocs`) when its docs `ff` published, else abandoned (`abandonDocs`: its checkout removed, the slot
   released; the revision was aborted and its source re-evaluates).
9. **The snapshot (G6, H6)** is the transitive closure of the records its first `highWater` log lines name, not an
   allowlist (`snapshotRequestOf({view, runDir, identity, message})`, `collectSnapshot`). Content-addressed inputs sit
   at `inputs/<sha>.<ext>` (everything a `plan-applied` or kept payload names, the payload's renders, `spec.patch`
   outputs, the specs `dispatch`, `judgment-inputs` and `reopened` name, `steered` briefs); `start.json` (named by the
   latest `executor-started`, its generation matching); every done backend or arc-backend spawn's `result.json`
   (`reads.json` where written); each `witnessed` fact's record (a job's, a candidate's or a mutant's run) as
   `witness/<seq>-<ord>.json`; needs-user records and acks; evidence manifests; a 1.0.0-dev.5 revision's routing
   provenance `routing-provenance/<rev>.json` (H7; persisted at adoption, not rebuilt: AY finding 12 below). `manifest.json` entries carry `namedBy: log | event{seq} | item{path}`;
   `verifySnapshot` recomputes the closure from the tree's own events and payloads and requires exactly that set, each
   file hashing as listed and as its naming record states. A run dir holds start.json before any snapshot. A
   manifest without `namedBy` (1.0.0-dev.5) verifies by that release's allowlist, warned (scaffolding). Not yet in the
   closure: commands and their receipts, and a dev.5 revision's live ledger (never kept).

**Choices made in M3 Checkpoint A** (fix step AX: judgments and approvals; findings 1, 4, 5, 9 of the batch-A review):

1. **One acquisition order: the fence, then `@cpu`.** Plan-check and gate capture their inputs and write
   `judgment-inputs` under the fence first, and only then take their `@cpu`×1 entry (`enterJudgment`); a revision
   holds the fence through its docs publication, whose lanes wait for `@cpu`, so the old order (`@cpu`, then the
   fence) deadlocked at capacity. A task already cancelled captures nothing. A capture whose `@cpu` wait is then
   cancelled leaves its `judgment-inputs` for an attempt that never started: the fold lets the next capture for that
   `(unit, stage, attempt)` replace it, and still refuses a second one for a started attempt. Plan-check's pin
   (`pinDispatch`) now also precedes its reservation, so a cancelled wait can leave a unit pinned with no attempt
   (`started()` already counts a pinned unit as started). A routing change or an empty diff records its outcome with
   no reservation to release.
2. **The approval records the captured fingerprint.** The gate computes `fingerprintAt(T)` inside its capture and
   writes it as `judgment-inputs.fingerprint` (additive; a gate spawned by 1.0.0-dev.5 has none and is fingerprinted
   at its recorded tip when read, warned `judgment-inputs.fingerprint`: scaffolding). `gateRead` takes that
   fingerprint and records it as the `approval` (the unit branch must still be at its `unitCommit`); ff's re-check
   compares it with the fingerprint of the inputs then in force, so a ruling withdrawn while the gate ran re-gates.
3. **Effective ruling revisions.** `rulingRevs[].rev` = `effectiveRulingRevs(sidecars in force)` (src/spec/rulings.ts),
   default 1: each ruling that partially supersedes it adds its own effective rev, plus 1 once it is no longer active.
   It only rises as the ledger grows, so an approval citing a ruling a later ruling partially supersedes re-gates. A
   dev.5 ledger has no sidecars: every rev stays 1 and dev.5 fingerprints read unchanged.
4. **A proof judgment binds the complete witness definition.** `ProofJudgment` gains `witness{lane, testIds}` (a copy
   of the obligation's witness it judged, M3-only shape, required); the classifier refuses a proof whose `witness` is
   not exactly the obligation's (canonical JSON), besides its `obligationRev` and `laneRev`. A grown or changed test
   set therefore needs a fresh proof even when neither revision moved.

**Choices made in M3 Checkpoint A** (fix step AY: findings 2, 3, 6, 7, 8, 10, 11, 12 of the batch-A review; these
supersede the A4 items they name):

- **A job lane's evidence (finding 2; A4 item 3).** Each lane execution keeps its evidence in its own dir,
  `<runDir>/evidence/jobs/<job>/<kind>-<lane>-<seq>-<ordinal>/` (`jobLaneDir`, src/git/snapshot.ts; `kind` is `suite`
  or `arc`, the suffix the invocation's dir name), made once the spawn's intent names the invocation: a suite lane and
  an arc lane of one id, or two invocations, never share an evidence dest. An arc lane's reporter writes `witness.lines`
  there and its `witness.json` is written there, which the snapshot finds from the `witnessed` fact's `lane` and `inv` (always an arc lane).
  B2 extends this to a unit candidate's journey lanes and moves the job series into src/pipeline/lanes.ts (below).
- **A job's checkout integrity (finding 3).** After a job's lanes, the detached checkout must still be the commit:
  tracked or unignored changes (`dirtyPaths`, as a candidate suite) are snapshotted to `<job root>/_dirty-<checkout>` (B2: a job may run several series) before the
  checkout's removal (which then cites that snapshot), and a HEAD other than the commit is recorded. `JobSeries`
  carries `checkout: {dirty, movedTo, evidence} | null` (null: no lane ran). A docs publication refuses either,
  after the series' end and before the suite verdicts.
- **`rule`'s obligation dispositions (finding 6; A4 item 6).** The proposal also carries the obligations file with
  the ruling's `waived`, `deferred` and `retired` dispositions applied (`state: {type, ruling: <its id>}`, the file's
  JSON edited in place); the classifier checks it like any obligation edit, and the publication renders
  `invariants.md` when the rendering changes. `amended` is no state: it authorizes a later `apply`'s amendment while
  the ruling is in force. The write-back covers the obligations file (beside the plan, `plan.holistic.obligations`)
  with the same compare-and-write as the ledger and sidecars.
- **Startup and a committed command (finding 7).** `settlePlan` (src/preflight/checks.ts, exported) leaves the files
  for the next start while a `command.apply` is open whose command a `plan-applied` names: its revision is in force,
  its write-back may be unfinished, and recovery re-runs the command, which finishes it. The open command op is the
  durable pending-write-back phase; no new record.
- **A rule on a 1.0.0-dev.5 revision (finding 8; scaffolding).** Before committing a rule whose previous revision
  has no payload, `rule` keeps the live ledger's hash it evaluated against at
  `<runDir>/commands/rule-preimages/<command>.json` (`{ledgerSha256}`; such a revision has no sidecars or obligations
  in force). A run again after a crash past the fact compares the live files with it; a missing one is a bug. Delete
  with the other dev.5 scaffolding.
- **`reverse` resolves the recorded preimage (findings 10, 11).** A preimage spec `{u: rev}` is the latest spec of
  unit `u` at that spec rev the log named before the act's `plan-applied` (a `plan-applied` manifest, `dispatch`,
  `reopened`, `judgment-inputs`, a done `spec.patch`); obligations are read by the preimage's `obligationsSha256`, not
  the plan manifest's. A restored dispatched unit's spec is the next rev of its recorded one (replacing any pending
  revision). Restored obligations are a fresh revision: each obligation both files hold takes the rev in force, plus
  one when its statement, docRef or activation changes back, and its preimage proof judgment (which judged exactly the
  restored statement and witness) is bound to that rev, every other proof field kept as the preimage has it. The
  classifier (`classifyObligations`) validates the result, dispositions and proof freshness included.
- **dev.5 routing provenance (finding 12; A4 item 9; scaffolding).** `routing-provenance/<rev>.json` is no longer
  rebuilt at snapshot time. The first start of this release on an arc with dev.5 revisions (adoption, `runChecks`
  after `settlePlan`, `adoptLegacyProvenance`) persists, write-once, `<runDir>/routing-provenance/<rev>.json` for each
  dev.5 `plan-applied`: `{kind: reconstructed, provenance, matched}` when the provenance rebuilt from the revision's
  kept plan, start.json's profile and the adopting start's repo config resolves every routing rev the log recorded
  while that revision was in force (its backend spawns, its dispatches, its own `routing` change; `matched` lists
  them), else `{kind: unreconstructable, reason}` (reported on stderr). The snapshot carries these bytes (the run-dir
  path mirrored), and a missing one fails the snapshot loudly. The executor's live routing of a dev.5 revision in force
  resolves from this record since B7 ("Choices made in M3 B7" item 10).

**Choices made in M3 A5a** (residue-index compaction; src/host/compact.ts, src/host/residues.ts):

1. **When**: the supervisor runs `compactResidues` once per start, after its claim and before its first executor, so
   nothing else writes the index meanwhile. A corrupt index is left alone (the executor's startup row refuses it
   `log-corrupt`); what was compacted is reported on the supervisor's stderr.
2. **What may go** (H1): a disposed pair (a residue and its disposition) whose instance no longer is held in the
   resource fold of the key's arc nor of the disposing arc (`by.arc`), each read read-only from its run dir: not
   `cleanup-failed`, not held by a reclaiming holder (`RECLAIM_HOLDERS`). An arc whose log is absent or corrupt keeps
   every pair it is part of; an undisposed residue is always kept. Keys are compared as canonical JSON, so a job-owned
   key (`{arc, inv, resource, job}`) and a unit-owned one never merge.
3. **Threshold**: nothing is rewritten below `COMPACT_THRESHOLD` (64) droppable pairs.
4. **The rewrite**: write `residues.jsonl.compact` (`COMPACT_TMP`): a head `{type: compacted, archive, prevSeq,
   prevHash}` continuing the current file's chain (seq `prevSeq + 1`, `prev` = `prevHash`, the hash of its last line),
   then the kept lines re-chained with their records and times unchanged, verified as a read would; `link` the current
   index to `residues.archive.<prevSeq>.<prevHash[0:8]>.jsonl` (the old file, byte for byte); `rename` the tmp over the
   index. A head is only ever the first line, and each archive chains back through its own head. Crash recovery: a
   stray tmp is removed; an archive already linked to the unchanged index is continued from, one the index has since
   moved past is unlinked first. Crash labels `residue.compact.after-tmp`, `.after-link`, `.after-rename` (matrix row
   RESIDUE_COMPACT).

**Choices made in M3 A5b** (`roadmap gc`; src/commands/gc.ts):

1. **A host act, not a queued command**: `gc --repo <path> [--keep K] [--dry-run]` claims the host (naming the repo's
   arc with the newest log, which that gc never deletes), acts and releases. Refused (`GcRefusal`): a `HostRefusal`
   (`host-busy`, …), `executor-died{arc, generation}` (the host's last executor died holding it: that arc's next start
   recovers it), `snapshot-mismatch{arcs: [{arc, detail}]}`, `no-arcs{runtime}`. Output: one canonical JSON line,
   `GcReport = {dryRun, keep, generation (gc's own claim's; dry: the next), arcs: [{arc, action: evidence | run-dir} |
   {arc, action: kept, reason}], deleted: AbsPath[] (deletion order)}`, or `{refused: GcRefusal}` with exit 75 for
   `host-busy`, else 78. `--dry-run` is refused the same way, then reads without claiming. K defaults to
   `DEFAULT_KEEP` (3).
2. **Sealed** (`sealingOf`, A20, H5): the arc's `arc-completed` follows its `lastWorkSeq`, no command is pending, the
   completion head is in the integration branch's history, and `refs/roadmap/<arc>` verifies at a high-water at or past
   the completion with its `events.jsonl` the live log's prefix. Every arc is read and verified before anything is
   deleted: one mismatch refuses the whole gc.
3. **Retention**: sealed arcs, newest completion first; the first K (and the claim's arc) keep their run dir and lose
   only raw evidence (each evidence snapshot's `files/`, every `witness.lines` under `evidence/` (a job lane's, a candidate journey's, a mutant's; `witness.json` stays), each invocation's `stdout`,
   `stderr` and `runner.log`, the implementers' `work/`); the rest lose the run dir (renamed `<arc>.gc-deleting`, then
   removed; a leftover is removed first; crash label `gc.run-dir.after-rename`), which the snapshot ref restores. Arcs
   not sealed are kept whole. Host generation files beyond the last K before gc's own claim are pruned, except any
   generation an open (unacknowledged) needs-user item of the repo's arcs cites as evidence. Residue archives: the
   chain is walked from the index's `compacted` head through each archive's head; the first K on it stay, and every
   other archive goes except one hard-linked to the live index (a crashed compaction's, which the next continues).

**Choices made in M3 B1** (the witness protocol; src/holistic/{witness,observe}.ts, reporters/node-witness.mjs):

1. **The witness line** (canonical for `node-test` and `jsonl`): `{"testId": <non-empty string>, "selected": <nat>,
   "outcome": "pass" | "fail" | "skip" | "zero-selected"}`, `selected` 0 exactly for `zero-selected`. Lines with one id
   aggregate into one record: `selected` sums, the outcome is the worst (fail > skip > pass > zero-selected). A missing
   witness file, a line that does not parse, a torn last line or an unknown test2json action makes the record
   `malformed` (no records).
2. **Test ids**: node's is the test's name path from its outermost suite joined with `" > "` (suites are not
   recorded; skip and todo are `skip`); go's is test2json's `Test` (`TestX/sub` for a subtest), read from the lane's
   stdout, a test that started and never ended counting as `fail`; a `jsonl` wrapper writes the lines itself.
3. **The run**: `witnessEnv(reporter, file)` adds to the lane's env `ROADMAP_WITNESS_FILE` (node-test, jsonl) and,
   for node-test, `NODE_OPTIONS` loading the spec reporter to stdout and the shipped `reporters/node-witness.mjs` with
   destination **stderr** (a file destination is fsynced at exit, which fails with EINVAL on /dev/null; the reporter
   writes nothing to its stream, appending each line to the file with O_APPEND and unsetting the variable so a nested
   `node --test` records nothing). The file is `witness.lines` in the execution's own dir. Afterwards
   `collectWitness` → `witnessRecordOf` → `writeWitnessRecord`, which keeps `witness.json` write-once in the same dir
   (the counted run's; `witnessDir`) and returns the sha256 of its bytes, the `witnessed` fact's `recordsSha256`.
4. **`envId`** (`envIdOf`): the first 16 hex of sha256 over canonical `{host: {platform, arch, node (process.version)},
   pass: {NAME: value | null}}`, the lane's pass-through variables (absent ones null). What the lane sets is in its
   `laneRev`; a pool instance's binding is not identity.
5. **Verdicts** (`verdictOf`) over the witness's test ids, a missing id counting as zero-selected: malformed →
   unwitnessed; any fail → not-held; all pass → held; a pass mixed with skip or zero-selected → partial; else
   unwitnessed. An observation is reused only when all four keys match and the kept file still hashes to the fact's
   `recordsSha256`; a mutant record never is one (G13).

**Choices made in M3 B2** (journey lanes, the held-claims brake, latching, the baseline job, the repair batch):

1. **One journey series** (`runJourneySeries`, src/pipeline/lanes.ts) runs every arc lane and a job's suite lanes, for a
   unit candidate (its candidate stage holder, spawns `journey{owner: unit}`, `witnessed{for: candidate{unit, attempt}}`)
   or a job (`job{job}`, `acquireFirst`): the red-lane protocol, the checkout's integrity (AY; the dirty paths go to
   `<series root>/_dirty-<checkout>`), and each execution's own dir: a job's `jobLaneDir`, a candidate's
   `candidateLaneDir` = `<runDir>/evidence/<unit>/<attempt>-candidate/journey/<kind>-<lane>-<seq>-<ordinal>/` (its runs
   on the candidate and on the tip alone share the parent). `witness.lines` and `witness.json` live there; `witnessDir`
   (src/git/snapshot.ts) finds a record from its `witnessed` fact (a mutant's since B3: `mutantLaneDir`). Only the
   run whose verdict counts is `witnessed` (a diagnostic or voided rerun is kept, never named). `publish.ts`'s
   `runJobLanes` is gone.
2. **Lane reuse (§9)**: a witness lane whose observation on the tree exists (all four keys, the record's hash) is not
   run again (`reuse`); the baseline job always runs afresh.
3. **The brake** (src/pipeline/integrate.ts `heldClaims`, `gradeTree`, `brakeVerdict`): after a green suite, the arc lanes
   of the selected non-exempt obligations run on the candidate. Clean = checkout intact, no selected effect `red`, every
   declared repair held (its witness `held` on the candidate, whatever its activation; a split parent's, every non-exempt
   child's; not the effect, which for a held future child is `latch` or `measured`), and no lane failure left. A failing
   test of a future (not latched) or exempt obligation is never graded; one of an unselected must-hold obligation over
   which an active P1 is open is a background failure; any other failing test (or a red lane with none) is unexplained.
   Not clean → the same lanes on the tip alone: a blocking failure (a brake red, a repair not held, an unexplained lane,
   a changed checkout) the tip reproduces → `base-red`, else `red`
   (charged; `candidateBrakeFix` names the red obligations in the fix round). A repaired obligation's red is never the
   base's. Background failures only: the tip failing exactly those tests per lane → green (known regression); failing
   none → `red`; else `base-red`.
4. **G11's suite-lane half is unreachable**: the frozen plan's suite lanes carry no `reporter`, so the known-regression
   exception applies to arc-lane witnesses only.
5. **Latching** (`latchPublished`): after a unit's `ff{published}` (and a batch's), before the snapshot, each future
   obligation the publication completes and that holds on its tree (the observation store, this host's envId) latches,
   `unit` the first publishing unit in its `deliveredBy`; a restart re-reading the published ff writes what is missing.
   Crash label `latch.after-fact` (matrix row LATCH).
6. **The gate's obligation views** (`observedViews`) carry the observation on the integration tip's tree (the candidate
   does not exist yet), null when none is there.
7. **The baseline job** (src/pipeline/baseline.ts): `baselineDue` names `baseline-<n>` while a holistic arc with
   obligations lacks a witness of every arc lane on the tip by it, or has a problem not raised; `runBaseline` resumes the
   same job (its leftover checkout removed, only missing lanes run). Problems (a must-hold not held, a future already
   held: vacuous) raise one blocking `obligation-baseline` parented by the job. The scheduler (B7) calls it before
   admitting any unit.
8. **The repair batch** (`publishBatch`): the slot under `batch{finding, attempt}` through `acquireFirst` with the job as
   the reserve's parent (`AcquireFirst`'s 5th parameter, required exactly for a batch holder); one durable `batch-<n>` per
   finding until it publishes, each attempt reusing it; the chain on `refs/roadmap-run/<arc>/candidate/<batch-n>` (the
   frozen candidate ref shape; a unit entering the plan may not take the id `batch-<n>`, which would share it), each chain merge re-made from `merge-tree`
   of its parents with `commit`'s identity and message. The claims are the union of each member's selection. Red →
   `red{attributable}`: members whose own selection holds a red obligation, none when anything else is red. Before the ff
   every member's fingerprint at the tip (`stale{invalid}`) and eligibility (`finding-blocked`). A batch ff's provenance
   is a first-parent chain of ≥ 2 two-parent merges back to T. Its CAS is never redone by recovery (done unpublished;
   the batch runs again); a batch holder whose ff published is left holding the slot for `finishBatch` (latches,
   snapshot, release), any other is abandoned (`abandonBatch`). Crash label `batch.after-candidate` (matrix row
   BATCH_PUBLICATION). The scheduler (B7) decides when to batch, finishes a held published batch at start, and records
   the members' outcomes of a red batch.

**Choices made in M3 B3** (the findings store, P1 blocking, repair and vacuity reproduction):

1. **The store** is the log (`finding-opened`, `finding-transition`); src/holistic/findings.ts decides what is written.
   `openFinding(journal, draft) → {opened|merged, id} | {suppressed, by}` (the one store: audits, code, plan-check, the
   checkpoint; `FindingDraft` is the fact without id and key, plus `cause`): a key matching an active finding merges (nothing written); one matching a finding ruled
   `dismissed` is suppressed unless the draft cites, with a different non-null blob, a path the dismissal cited
   (`evidenceChanged`); a resolved, deferred or accepted key opens anew. A dismissal lasts the arc's lifetime: it is read
   from the arc's own log only, never carried into the next arc. A vacuity finding's patch is kept first (`keepMutantPatch`) as
   `inputs/<patchSha256>.patch` (`MUTANT_PATCH_INPUT`, src/git/mutant.ts), which the snapshot closure carries (named by
   the `finding-opened`). Code's witness P1 has one stable cause per obligation (`witnessFindingDraft`: `witness not held`, citing its `serves`); plan-check's
   vision conflict is `visionConflictDraft` (cause `<unit>: <note>`).
2. **Ownership (R5)** is derived and written by `syncRepairs` (src/pipeline/reproduce.ts, over `ownershipMoves`): the
   first unit in plan order whose spec names the finding (`repairs` F-n) and is neither published nor cut or superseded
   owns it (a planned repair owns it before it starts); its standing approval (its latest decision leads to candidate,
   ff or snapshot) makes it `fixed-on-branch`, a voided one takes it back to `owned`; its publication after the finding
   opened resolves it. A `witness` P1 is also resolved by any unit publishing after it opened whose repairs name its
   obligation (`I-n`, or a finding over it): the brake proved it held with integrated evidence. No live repairer: `open`.
   Moves always follow `FINDING_MOVES` (a resolution from `open` writes owned → fixed-on-branch → resolved). The unit
   driver calls it before and after every stage, `finishBatch` before the batch snapshot; the executor calls it
   after recovery (B7 item 10).
3. **Ruling**: `ruleFinding` refuses a non-active finding and a P1 deferred or accepted by anything but a ruling
   ("P1s never bank"); a checkpoint may dismiss a P1. Code dismisses (`by: code{not-reproduced}`) a finding whose mutant
   a unit's latest `reproduce` killed (derived from the decided outcome and the attempt's last mutant spawn, so a crash
   between the outcome and the dismissal loses nothing).
4. **Blocking (G10)**: `p1Blocking(findings, selected, repaired)` is the one rule; admission (`admitter`, candidate
   stage, constraint `finding-blocked`), the candidate before green and the ff before its intent (integrate.ts
   `findingBlocking`) and recovery's ff redo all read it at that moment, so a P1 opened mid-candidate blocks the ff.
5. **What admission reads from a spec** (`SpecFacts{reproduces, repairs}`, src/schedule/ready.ts; `specFacts(ctx)` reads
   the specs in force, only while some finding is active): `nextStage(u, reproduces)`, `upcoming(u, reproduces)`,
   `admitter(routing, specOf)` and `ReadyInput.spec`. `reproduces`: the spec repairs an active vacuity finding with a
   mutant; such a unit's first stage (and its first stage after a re-open) is `reproduce`, which pins the dispatch record
   as plan-check does. The host breaker holds `reproduce` as it holds lanes.
6. **`mutant.apply`** (src/git/mutant.ts, src/recover/mutant.ts): the outcome is a pure function of `at` and the patch
   (`patchedTree`, a private index: `applied{tree}` or `inapplicable{detail}`); the act makes the detached worktree and
   applies the patch to its index and files; verify requires exactly that state. Recovery: exactly the state → done; a
   listed worktree in any other state is removed and the act redone; content git does not list → abort. The worktree
   (`<unit>.mutant-<attempt>-<finding>`) is removed by the stage citing the lane's output snapshot (or a snapshot of
   nothing when no lane ran); a later attempt removes a leftover first. Crash labels `mutant.act-start`,
   `mutant.after-worktree`, `mutant.act-end`, `mutant.after-done` (matrix row MUTANT_APPLY).
7. **A mutant run** is one run of the finding's lane (no red-lane rerun: its verdict comes from the witness records, not
   the exit) spawned `mutant{finding, lane, laneRev, tree}` under the attempt's stage holder with the lane's own
   reservation; its record (`purpose: mutant`, `treeSha` the patched tree) and evidence are in
   `<runDir>/evidence/mutants/<finding>/<lane>-<inv>/` (`mutantLaneDir`, `witnessDir`), named by `witnessed{for:
   mutant{finding, of: <the unpatched commit>}}`. The verdict reads the finding's obligation's witness when it is on that
   lane, else every test the run reports.
8. **`reproduce` outcomes**: every target's witness `held` on the patched tip → `reproduced`; `not-held` →
   `not-reproduced` (the finding dismissed by code); `partial`, `unwitnessed`, a patch that does not apply or a lane no
   longer in force → `inapplicable`; a lost runner or process fault → `blocked`; an occupied lane resource → `blocked`
   (the frozen outcome set has no `occupied`). Both parks carry a specific needs-user naming the finding.
9. **Acceptance** (`mutantAcceptance`, from integrate.ts `candidate` after a green brake): each mutant the unit repairs
   runs on the candidate commit; `not-held` kills it; anything else is a survivor → `red` (charged), and the fix round
   (`mutantFix`) names the finding, the lane and the patch text. A patch that does not apply to the candidate is not a
   survivor (the repair rewrote what it mutated; the next vacuity audit re-evaluates).
10. **Needs-user items** are derived (`findingItemsDue`) and raised once each by `raiseFindingItems` (the scheduler's
    tick, B7): `finding-p1-escalated` (blocking, subject arc) per park of an owner of an active P1, PARK_ESCALATE_MS
    after the park, parented by the park's stage attempt; `new-finding-draining` (blocking, subject arc) per job that
    opened a P1 or P2 after `admissions-closed`, once that audit ended, parented by the job.
11. **Instrumentation**: `findingMetrics(events, findings)` → `{id, lens, severity, gateHadPassed, disposition (the
    ruling's, else null), merged (resolved), timeToResolveMs (opening to resolution or ruling; null while active)}`.
12. **Batches**: `batchable(findings, repairUnits(ctx))` lists each active finding two or more approved units repair
    directly: what B7 hands to `publishBatch`.
13. **Plan-check** reads its answer against the spec rev its `judgment-inputs` captured (an evidence-only edit in the
    capture → `@cpu` window keeps the rev, and a redirect patches the spec in force at it; any other mismatch fails
    loud); each `visionConflict` opens a P3 `plan-check` finding (a re-read merges); a conflict citing a clause that is
    not an active clause of the vision in force (or with no vision) is `malformed`.

**Choices made in M3 B4** (the arc roles' prompts; src/prompts/{lens,checkpoint}/, src/prompts/index.ts):

1. **One lens module for the four lenses**: the standing rules in the system prompt, the lens's own brief in the
   message's `<lens_brief>`, whose first line is the one marker `lens: <kind>` (what the fake backend keys on).
2. **`MAX_LENS_FINDINGS` (8)** is stated in the prompt as the reporting bound, worst first; the reader does not
   enforce it (an anti-spiral bound on reporting, never on reading).
3. **Routing**: lens/Opus and checkpoint/Fable are modules; lens/Fable and checkpoint/Opus inherit them (reviewed
   2026-09-30); Sonnet and Codex are unsupported for both ("Prompts" above).

**Choices made in M3 B5** (the cadence audit, coverage, the arc roles' call; src/holistic/{audit,cadence,coverage}.ts,
src/pipeline/dispatch.ts `callArcRole`):

1. **Coverage (H3, lead ruling 2026-09-30).** A lens's watermark starts at the arc's base (the integration head at the
   revision that turned the arc holistic: its docs publication's head when it published, else the head its
   `revision.commit` found) and follows, from wherever it stands, each range an audit covered for that lens and each
   docs-only edge (`docs-covered{U→D}`, applied only once the watermark reaches U, kept until then; A17, H8). A vision
   revision clears every coverage recorded before it (audits started under an older vision, docs edges before it), so
   the next audit of each lens at X covers everything up to X from the base, exactly as a first audit would: no merged
   range survives a vision change unaudited, at no extra call. The integration history is read from the published
   `integration.ff`s (a docs one at its intent's seq, a unit's or batch's at its done's seq, `publications()`).
2. **Triggers** are events after the last completed audit's start (or the latest vision revision): `cadence` (N counted
   publications: unit, batch, and a revision's docs publication carrying contract ops; never a docs-only one),
   `unwitnessed` (R8: a publication's selected future-not-latched or exempt obligations with no observation on its tree
   or verdict `unwitnessed`, recomputed with `selected` over the ff's old..new), `drift` (a revision from a bundle, or
   whose ledger/sidecars, a non-evidence spec, obligations, mapping, vision, `holistic` or `advances` changed; never an executor's or
   an arc's first), `wall-clock` (`wallClockMin` since the latest audit start or unit publication, while a plan unit is
   not retired, cut or superseded), `requested` (its lenses ∩ L, or L), `final` (no work left and some lens in L
   outstanding: those lenses only). drift runs L ∩ {drift, vision} (or L); every other trigger runs L. An audit records
   every owed trigger (coalesced).
3. **Due:** no audit running, and a trigger is fresh (its event after the latest audit start), the wall-clock trigger
   fired, `final` holds after a completed audit (or before any), or `wallClockMin` passed since the latest start with
   triggers owed. So an abandoned audit is not retried at once for the same triggers; with no work left the retry is the
   final trigger alone. A due audit is skipped, writing nothing, while the lens seat's backend is parked or the arc is
   paused or stopped.
4. **Owed (OR-Q2/3):** owed for 2N counted publications or 2 × `wallClockMin` since the last completed audit started
   (or the vision revision): one non-blocking `audit-owed` per episode, parented by that audit's job (`{type: arc}`
   before one) and found again by parent and reason (a `job{audit-n}` parent for an audit not yet started would name,
   and so bump, the next audit id).
5. **Time:** `Clock(seq)` is minutes since the fact at seq; `processClock` times a fact from when this process first saw
   it (older facts from the process start), so a restart delays a wall-clock trigger, never fires one early.
6. **Generation:** a bundle revision's drift audit takes its checkpoint's generation + 1; any other audit one more than
   the highest generation any audit or checkpoint recorded.
7. **The run:** capture (cadence recomputed inside `captureUnderFence`; `highWater` the log just before it); the arc
   lanes as a journey series under `job{audit-n}` (observations reused); code opens a P1 (`lens: witness`, cause
   `witness not held`) for each must-hold or latched obligation `not-held` on the audited tree; the lenses serially, the
   vision first, each `@cpu`×1 under the job holder through `acquireFirst`, in a detached checkout `<job>.lenses`,
   reading the recorded vision, obligations and ledger by their kept bytes, every plan contract at the audited SHA in
   full, owner branch diffs from `diffBase`. A lens call is `arc-backend{role: lens, tier: arc, routingRev, job,
   attempt}`, `attempt` its place in the run order; a resumed job consumes a recorded call (`recordedArcCall`) and asks
   again only for a lost one. A lens's refusal, malformed report or fault abandons the audit after the rest; a usage
   limit or capacity parks the backend (`verdictOf` with a job parent; the usage-limit item parented by the spawn op)
   and stops it. The lens checkout is removed (citing an evidence snapshot) before `audit-ended`, so a crash never
   strands it. `covered` lists only lenses that reported with a non-empty range, from their watermark at the capture to
   the audited SHA. Crash labels `audit.after-started`, `audit.after-lens`, `audit.before-ended`, `audit.after-ended`
   (matrix row AUDIT_JOB).
8. **Race:** `rewitnessP1s` re-runs, on the head when it moved past the audited SHA, the lanes of the active P1s over an
   obligation the audit named, under the same job. `runAudit` calls it at its end; the checkpoint (B6) calls it again
   before its capture.
9. **Findings from audits** go through B3's store (`openFinding`, src/holistic/findings.ts; see "Choices made in M3 B3"
   item 1); the ids it opened or merged and the suppressed count are `audit-ended{findings, suppressed}`.
   `gateHadPassed`: a unit had published before the audit started. A vision-lens P1 is recorded P2; unknown obligation
   and clause ids are dropped; a vacuity mutant is kept content-addressed (`.patch`) only on a known lane.
10. **Smoke and argv:** the claude-judgment role is any `FreshRole`, so a probe can call `lens.arc` or `checkpoint.arc`.

**Choices made in M3 B6** (the checkpoint job and its bundles; src/holistic/{checkpoint,bundle,convergence,divergence}.ts):

1. **One fence hold per activation, staleness first.** `activate` holds the revision fence from its first check through
   the commit, and builds the proposal (the revision in force plus the ops) inside it, so no revision lands between the
   build and the commit. The order is staleness, validation, owner-only, draining, evidence, convergence, then the apply
   core: staleness comes first so a bundle decided on moved inputs is re-evaluated, never counted invalid. It composes
   the apply core's parts (`evaluateRevision`, `keepRevision`, `commitRevision`) rather than calling `commitUnderFence`,
   because a bundle's payload carries the divergences code computes from its ops (beyond the core's `split-dropped`)
   and its staleness check must sit in the same hold. A docs publication refused at the tip is `rejected{stale}`.
2. **Staleness per artifact touched, the vision always (H3).** The plan: its bytes at the captured rev against the
   plan in force (a revision that left the plan alone does not stale a plan op). A patched or re-entered unit: its
   spec rev. A split or disposition: the obligations' bytes. A `rule` op: the ledger's bytes and the blob of every
   contract its ruling names or edits, at the captured head against the tip. A finding a disposition names that left
   the active states since the capture is stale too.
3. **Rulings are stamped by the executor** (lead ruling: the model echoes no revisions): `ruledBy: checkpoint{the
   deciding job}`, `consistency: {verdict: consistent, judgedRevs: {the captured head, ledger, obligations and vision,
   each judged contract's blob at the captured head}, by: judgment{checkpoint, the call's routingRev}}`. Each lands
   through exactly one `rule` op and is validated at the tip with the earlier ones landed; a contract op outside the
   plan's contracts and architecture doc is left to the owner-only check (H10), not reported invalid.
4. **Split children** are written by the executor at rev 1, serving the parent's clauses plus the op's cites, with the
   parent's contracts and `parent`, and a proof judgment `{proves, obligationRev 1, the witness lane's laneRev, the
   witness}`: the checkpoint that named the witness is the judgment.
5. **`invalidate-approval` is refused as invalid**: no 1.0.0-dev.6 record voids a gate approval (carry-forward).
6. **Divergences per op**: admit, reenter, cut, route, limits → `plan-departed` (preimage: the plan rev); patch-spec
   → `plan-departed` (preimage: the unit's spec rev); obligation-split and obligation-dispose → `obligation-departed`
   (preimage: the obligations' bytes); a landing ruling's `deviates` doc refs → `target-departed` and its contract ops
   → `contract-departed` (preimage: the ledger and the contracts' blobs; the hint supersedes by `rule`). A ruling that
   departs from nothing, a request and invalidate-approval record none. Compensation `restore-revision` for all of
   these; an interpretation's is `none`. Evidence: the op's; an interpretation's the decision's cited findings and
   observations, else its reasons.
7. **The digest** item is raised first (parent `{type: arc}`, its summary's first line listing the ids) and its
   `divergence-digest` fact second; a crash between them is finished by reading the ids back from that line.
8. **Convergence.** Material: every op but `request` and a repair `admit` (R10). Identities: each finding or
   obligation id the op is about (its own obligation, and each `F-n`/`I-n` of the arc its evidence names) × the
   lineage root of its unit (`arc` for an arc-level op). The identity bound: a bundle with a material op on an identity
   an applied bundle changed since the latest acknowledged `convergence-identity` is itself requested, raising that
   item. The arc counter: applied bundles since the latest unit publication, latch or acknowledged `convergence-bound`;
   the bundle that reaches K applies and raises `convergence-bound` once per counter episode. While any brake item is
   open every bundle is a `bundle-request`. All three items are non-blocking, parented by the job.
9. **Due and re-queue.** A trigger (`audit{job}` for a completed audit; `park{unit, seq}` for an operator-design park,
   `seq` the park's) is due while it has no job, or its latest job was rejected (stale or evidence: always; invalid:
   the next is the last, since a trigger's second invalid decision, a failed call included, is a non-blocking
   `bundle-request` with no options), or its latest job's `bundle-request` was acknowledged `apply`. That next job
   enacts the requested bundle: it captures as ever, makes no call, activates the requester's output against the
   requester's captured inputs with draining and the brakes skipped. Parks are served before audits. A park
   checkpoint's generation is the latest recorded (1 before any).
10. **Evidence.** After `rejected{evidence}`, the lanes of the observations it cited are re-witnessed on the head under
    the rejected job before the trigger's next capture (a crash in between repeats it, reusing what ran).
11. **Interrupted calls.** A call cancelled or failed with a backend-park class leaves the job running; a later run asks
    again as the next attempt (the meter's attempt), skipped while the seat's backend is parked or the arc paused.
12. **OR-Q1.** `designParkRoute(ctx, unit)` is the scheduler's (B7) answer for a design park: `checkpoint` (hold its
    item back), `respecified{planRev}` (re-open it), `park-item` (raise its own item: the checkpoint decided a no-op or
    an unacknowledged request), `respec-second` (a second design park on a lineage the checkpoint respecified: the
    blocking item is raised by the checkpoint job, parented by the park's deciding attempt, so the park's own item is
    not raised as well).
13. **The admit template** (B4 carry-forward) is part of the rendered `plan` input: the spec in force of the plan's
    first unit, pretty JSON. No prompt module changed.
14. **Quiescence** (`quiescentGenerations(view, visionSha256)`): a generation with a checkpoint, captured under the vision
    in force, that decided `no-op`, or whose request (`bundle-request` or `owner-request`) the owner answered without
    `apply` (paid M3 run 5): a declined or acknowledged request ends that trigger's decision, nothing applied, the
    findings it concerned as they are, and the trigger is not due again. An unanswered request holds the generation open
    on its open item; one answered `apply` is enacted by the trigger's next job (item 9).
15. **Spec obligations of a bundle-authored spec** (lead ruling, paid M3 run 5): the spec of an `admit`, a `reenter` and a
    `patch-spec` is completed by code before the apply core classifies it: `obligations` = declared ∪ every non-exempt
    obligation (in the bundle's resulting obligations) of a mapping pattern that may overlap the unit's plan or spec scope
    (the classifier's prefix-conservative `mayOverlap`), ascending; left absent when that is empty. The model never
    reproduces the mapping. The classifier still refuses a narrower declaration in an architect's spec (DESIGN §2.3).

**Choices made in M3 B9** (`status`, `watch`, the meter; src/{status,watch,meter}.ts):

1. **The meter charges a job's call to its arc seat.** `MeterSubject.job` counts in `byRole` and `bySeat` (`lens.arc`,
   `checkpoint.arc`) like a unit's call, and per job in `byJob` (`{job, role, routingRev}` + totals), never in `byUnit`.
   `status.spend.byJob` shows it.
2. **By-model totals come from recorded provenance only.** Each `plan-applied`'s table is resolved from its own
   `routingProvenance`, or a 1.0.0-dev.5 revision's from its adoption record (`routing-provenance/<rev>.json`,
   `reconstructed`), for the arc and each unit layer. A revision with neither (a dev.5 arc no start of this release has
   adopted, or one adopted as `unreconstructable`) leaves its routing revs in `unresolvedRevs`; the live repo config is
   never read for history. `routing` and admission read the provenance in force per unit (`provenanceStack`); only a dev.5
   revision not yet adopted is rebuilt from the live config, warned (scaffolding, as `src/executor.ts` does).
3. **`nowTrue` / `notYetTrue`** list every non-exempt obligation in id order with its verdict on the integration head's
   tree (the live branch tip): completion's strict rule (`dischargingObservation`, src/schedule/scheduler.ts): the
   observation there of its witness lane at the lane's current rev in the environment the executor recorded for the lane
   (`recordedLaneEnv`), else `not-covered`; another environment's observation is never shown held. A split
   parent's verdict is its non-exempt children's (held when all hold, else the worst of not-held, partial, unwitnessed,
   not-covered). `activation` is the effective one (latched → must-hold). `blockingUnits`: a pending future obligation's
   unmerged `deliveredBy` (lineage heads); otherwise the owners of its active findings. `reason` is the first of
   supervision, host, waiting-dep, code over those units' states (`ObligationReason`), `spec` when there are none.
   `evidence` is the witness record's evidence dir.
4. **`target.nextMilestone`** (R13): among non-exempt, non-split, not latched future obligations with an unmerged
   `deliveredBy`, the fewest unmerged (ties: lowest id). **`criticalPath`**: the longest chain of unsettled units over
   effective `after` edges (ties: plan order).
5. **`decisionsSince`** runs from the latest acknowledgement of a `divergence-digest` (the whole arc before one), in log
   order: a revision's new sidecars (`ruling`, the arc's first revision excepted), a bundle's revision (`bundle`), a
   `reverse` command's revision (read from its command file; a run dir restored from a snapshot has none, and the
   revision then shows only by its changes), each `unit-cut` (`cut`), `unit-reentered` (`reenter`) and non-evidence spec
   change (`patch`), every done `spec.patch` op (`patch`, ruled by plan-check or the executor), `steered` and `divergence`
   facts. `ruledBy`: `architect{command|null}` (null: a start's files), `checkpoint{job}`, `judgment{planCheck}`,
   `executor`. `quarantine` has no 1.0 record and is not emitted.
6. **`divergences`** are B6's `uncoveredDivergences`, each with the open digest binding it (`digest`, else null).
   **`convergence`** is B6's `brakesOf` over the committed bundle revisions (`{k, counter, since, open}`); the identity
   bound needs each bundle's ops (the checkpoint's recorded call, read through a `StageContext`), so status does not
   render the changed identities.
7. **`audit`**: per lens in L, `coveredTo` (B5's watermark), `outstanding`, `pendingDocs`; `uncovered` the outstanding
   lenses' ranges to the head; `generation` the highest any audit or checkpoint recorded; `checkpointLaneMinutes` the
   wall-clock minutes of journey spawns owned by a `ckpt-n` job, intent to done (a running one's to now). **`owed`**: the
   open `audit-owed` items (the executor's cadence decides them; status does not re-derive triggers).
8. **`run.state`** gains `draining` (a live executor that would be `running`, with admissions closed). A holistic arc is
   `complete` only while its `arc-completed` is active (A20); an arc without the layer completes as in M2.
   **`completion`** `{planRev, head, active, sealed, notSealed, unmet}`: `sealed` is A5b's `sealingOf` (its reason or
   mismatch detail in `notSealed`); `unmet` names the §2.10 clauses that fail now: since B7's follow-up it is the
   scheduler's `completionBlockers` itself (one rule; see "Choices made in M3 B7" item 1).
9. **`host.log`** `{bytes, events, foldMs, compactionDue}`: the size of `events.jsonl`, the events folded, the fold's
   wall time in ms, and whether either compaction trigger (50 MB, 2 s) is reached. Two status reads differ only by
   `foldMs`.
10. **`commands.pending`** is `pendingCommandIds` (A5b); the receipts are listed from the receipts dir.
11. **`watch`** is unchanged in code: every raised item, blocking or not, is a `needs-user` line, so the M3 kinds wake
    the Monitor as any other (test `watch.m3-kinds`).

**Choices made in M3 B7** (the scheduler joins the holistic layer; src/schedule/scheduler.ts, src/executor.ts,
src/needsuser.ts, src/commands/{audit,admissions}.ts):

1. **`complete`** (every arc, B7 follow-up lead ruling) is `completionBlockers(h, {blocking, pending})` empty, a closed list
   in this order: `units-open` (holistic: a unit neither merged, cut nor superseded, a parked unit is never complete,
   §2.10; without the layer: a unit M2 does not settle, an operator park settling), `blocking-items`, `pending-commands`,
   `residues`, `baseline-owed`, `audit-pending` (running or due), `coverage-outstanding` (a lens of L, `coverageOf` at the
   head), `audit-owed` (the cadence owes a trigger), `checkpoint-pending`, `generation-not-quiescent` (the latest
   generation any audit or checkpoint recorded, under the vision in force; none recorded: vacuous), `close-out` (item 2),
   `obligations-not-discharged` (a non-exempt obligation, split parents through their children, not observed held on
   the head: §2.8's strict reuse rule, its lane's observation on the head's tree at the lane's revision in the executor's
   environment; another environment's does not discharge). The executor reads its own environment (`laneEnvId`);
   `status` reads the one the executor recorded (`recordedLaneEnv`: the lane's latest `witnessed` fact at its current
   revision), never its own process's. Without the layer the holistic clauses
   and the close-out are vacuous. The scheduler evaluates it only with nothing running and no mutation pending; `status`'s
   `completion.unmet` is the same function over a read-only view of the arc (`readOnlyContexts`: every writing or
   process-running member throws), so there is one rule.
2. **The close-out publication (A8)** is `publishCloseOut` (src/pipeline/publish.ts): its renderings are
   `constraints.md` in `close-out` mode and `invariants.md` (latched obligations must-hold) from the inputs in force; the
   files differing from the head are published like a revision's docs (slot `docs{pub}`, `docs.commit`, transient check,
   the suite and every arc lane, the brake over every non-exempt obligation, `ff{docs}`), then `finishDocs`:
   `docs-covered{pub, T → D}` (always docs-only), `docs-published{pub, source: close-out, commit}`, the snapshot, the
   release. With nothing to change it runs every arc lane on the head alone under `job{docs-n}` (reusing observations:
   when all are observed it writes nothing and names no job) and publishes nothing. It is done while the head is the
   latest close-out's commit, or has nothing to change. An arc without the layer has no close-out (its in-tree documents
   are not the executor's renderings: a 1.0.0-dev.5 fixture's hand-written `constraints.md` stays as it is). The scheduler starts it only when every other clause holds and no
   obligation is observed not held on the head. `finishDocs` tells a close-out from a revision's publication by the plan in
   force not naming its pub (a close-out never runs inside a revision). A refused close-out raises a blocking `base-red`
   (subject arc) parented by `job{pub}`: its lanes were red on the head plus renderings only; acknowledging it runs the
   next close-out. Crash labels `closeout.after-ff`, `closeout.before-published`.
3. **Completion (A20, G8).** Every arc, holistic or not (so `gc` can seal any completed arc), writes
   `arc-completed{planRev, head, highWater, units (merged, ascending)}` once while
   an active completion does not already record the plan rev and head, then the terminal snapshot (`snapshot.publish`,
   parent `{type: arc}`); the run ends `complete`. At every start, a completion no done arc-parented snapshot covers
   (its `highWater` below the fact's seq) gets its terminal snapshot first (crash label `complete.after-fact`). A restart
   of a completed arc ends `complete` at once, writing nothing. An arc with no `plan-applied` (started before
   1.0.0-dev.3) completes without the fact, warned (scaffolding).
4. **The holistic jobs** run on three tracks, one job each at a time: `holistic` (the baseline while owed, else the
   checkpoint while due or running, else the audit while due or running), `batch`, `closeout`. A run that waits on a
   condition a command changes (a skip for a parked backend or a paused arc, an interrupted call, nothing due) is asked
   again after `HOLISTIC_RETRY_MS` (5 × POLL_MS). A run whose lane gave no verdict (a baseline or audit `incomplete`, a
   batch's or close-out's `no-verdict`, an occupied batch lane aside, which raises its item) is retried on the
   retryable-park backoff (`noVerdictDelayMs` over `PROBE_BACKOFF_MIN`: 1, 2, 4, 8, 16, then every 30 minutes); once
   the episode (consecutive such runs of the track) is `PARK_ESCALATE_MS` (6 h) old, one non-blocking `park-escalated`
   item parented by the job (`escalateNoVerdict`, raised once per job, D2); progress ends the episode. The park machinery
   itself is unit-bound (park facts, probes), so this is its smallest equivalent: the episode is in memory (a restart
   starts a new one). The audit's clock is `processClock` of the scheduler's start. At most once per POLL_MS the loop
   raises the findings' items (`raiseFindingItems`) and an owed audit's (`raiseAuditOwed` over the cadence).
5. **The baseline hold (A6).** While the baseline is owed (`baselineOwed`), running, or its blocking `obligation-baseline`
   is unacknowledged, no unit is admitted to any stage (chains run on). `baselineOwed` guards B2's `baselineDue`, which
   reads the tip now: a baseline job that witnessed every arc lane on a tree the tip has since left is done.
6. **Design parks (OR-Q1)** raise their own item through `raiseResult`'s route (`designParkRoute`): `checkpoint` and
   `respec-second` raise none; `park-item` raises it; `respecified` re-opens a judgment-stage park on its pending revision
   (`reopened{command: null}`, the pending revision's command), raises none for a unit a planned unit re-enters, and
   raises the item otherwise (a respec the unit cannot re-open on). `raiseHalted` re-reads the route every iteration.
   B6 raises `respec-second` only inside `runCheckpoint`, so a second design park whose item is unraised makes the
   checkpoint job run (it raises it and decides nothing).
7. **Repair batches (R7).** For an active finding at least two active, unpublished units repair directly (`F-n`), the
   approved ones waiting at their candidate are held there while any other of them is not; once all wait (none
   finding-blocked, no item of the finding's batches open) they are one `publishBatch`. `settleBatch` records the
   outcome: published → the members' retire runs in a task each (unit.ts: a retired unit's step is its retire); `red` →
   each attributable member records a candidate `red` at an attempt that ran nothing itself, and its fix round
   (`memberBatchCandidate`, `batchMemberFix`, src/pipeline/integrate.ts) names the red obligations of its own selection
   on the batch candidate with the batch job's evidence; `refused{transient-violation, unit}` → that member's
   `transient-violation`; a red nothing attributes, any other refusal, `base-red`, `foreign-move` or an occupied lane →
   one blocking item (the outcome's, or `candidate-red`, subject arc) parented by the attempt's slot reservation, and the
   finding's members wait for its acknowledgement (`batchSuspended`); `stale{invalid}` → those members leave batching
   (in memory, until their approval changes) and take their own candidate, whose ff re-gates them; `finding-blocked`
   and other `no-verdict`s retry. A crash-cut published batch is finished at the scheduler's start (`finishBatch`).
8. **Pause and stop.** A pause kills the paused unit's backend, lane, journey and mutant invocations. A stop (control
   applies at once, §2.3; B7 follow-up lead ruling) kills backend, lane, smoke, journey, mutant and arc-backend (lens and
   checkpoint) invocations: a killed lens call abandons its audit, which runs again later (the spend accepted). A docs
   publication's lanes (`job{docs-n}`: a revision's or the close-out's) are never killed: a critical section, run to its
   end like a publication chain.
9. **`sched.json`** gains `jobQueue` (the arbiter's first-served waiters, `waitingFirst`, src/schedule/arbiter.ts).
10. **Routing provenance (lead ruling).** The executor's contexts resolve a 1.0.0-dev.5 revision from its adoption record
    (`readLegacyProvenance`, persisted by `runChecks`); an `unreconstructable` one resolves from this start's repo config
    as dev.5 did, warned on stderr (scaffolding). After recovery the executor writes the findings' moves
    (`syncRepairs`).
11. **Needs-user items.** An M3 reason's blocking flag is fixed (`m3Blocking`: every M3 reason but
    `NON_BLOCKING_M3_REASONS` blocks); a raise that disagrees throws. A blocking M3 item blocks `complete`; only
    `obligation-baseline` also holds admission (item 5).
12. **Commands.** `audit` refuses an arc without the layer and a lens outside L, and writes `audit-requested` once per
    command; `close-admissions` refuses while draining (by another command) and writes `admissions-closed` once. The
    in-tree document paths are `CONSTRAINTS_DOC` (src/docs/constraints.ts) and `INVARIANTS_DOC` (src/docs/invariants.ts).

**Choices made in M3: the vision redesign** (2026-10-01; DESIGN-1.0.md §2.8 amendment; hard cutover, since no arc
ran the holistic layer before it: no defaulting and no `SCHEMA_VERSION` bump):
1. **World clauses and open questions** are in the record above. A closed question's `bears` need only name clauses of
   the file (it stays as it was, like a withdrawn clause), so withdrawing a clause never forces an edit of a closed
   question; an open question bearing on a withdrawn clause is a schema error.
2. **The slice.** `holistic.advances` is checked wherever plan and vision meet: `revisionInputRows` at a start
   (`plan-invalid{schema, field: plan.holistic.advances}`, one row per reason) and the classifier on every revision,
   whatever it changed (an apply that withdraws an advanced clause without moving the slice is refused). It is
   owner-only like the vision: a changed slice from any proposer but `apply` is refused; an applied one is `advances`
   (arc-scoped, a drift trigger).
3. **Where advances is read.** Plan-check reads the plan of the revision in force (`visionInput`); a lens the plan at
   its `audit-started.planRev`, and a checkpoint the plan at its capture's rev (`payloadAtRev`, src/input/inforce.ts),
   so the slice always matches the vision the inputs recorded; status the plan in force.
4. **Rendering** (`visionText`): world clauses first, then the others in file order; `This arc advances: …`, `Horizon
   (active, beyond this arc): …`, then the open questions with the clauses they bear on and their working assumptions
   (closed ones omitted). `coverageText` reports advanced-unserved and horizon on separate lines. The lens, checkpoint
   and plan-check preambles say: world clauses are the target world and the rest its facets; push toward the slice and
   never foreclose a horizon clause (a choice that does conflicts with the vision); an open question's assumption is
   provisional (act on it, prefer the reversible choice); for the checkpoint, an act costly to undo if it proves false
   is a `request` (class `vision`), not an op; never resolve an open question.
5. **`status.vision`** gains `questions` (as the file holds them) and `advances` (the plan in force's).
