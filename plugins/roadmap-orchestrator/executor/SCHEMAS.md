# Executor schemas and contracts (frozen in M1 step 1a; M2 additions in M2 step 0a; M3 additions in M3 step 0a)

The specification every later step compiles against. M2's records and scheduling interfaces are in place
below and summarised in "M2: scheduling, resources, parks"; M3's are in "M3: the holistic layer" at the end. Each schema names the TypeScript type and the
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
- `test/upgrade.test.ts` is the guard: it starts the M1 fixture on `PREVIOUS_RELEASE` (extracted with `git
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
warning). `PREVIOUS_RELEASE` for this update is be76132 (B10 moves it). A dev.5 arc runs with no vision and no
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
| `residues.jsonl` | `+ compacted` head (A5a) | none |

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
| `units` | `PlanUnit[]` (non-empty) | `{id: UnitId, spec: PlanPath, risk: RiskTier, scope: RepoPattern[] (non-empty), resources: ResourceName[], after?: UnitId[]}`; `after` (parsed as `[]` when absent) names units earlier in plan order, never the unit itself, each once: the unit is not dispatched while any of them is neither merged nor parked with its needs-user acknowledged (arc-1 feedback item 17; since M2, merged only, D1, except in a legacy arc). M2 optional fields: `origin?: planned\|checkpoint`, `cpu?: positive` (build `@cpu` tokens, default 4), `contingent?: [{id: EdgeId, condition}]` (read as `[]`; ids unique across the plan), `reenters?: {unit (earlier in plan order, not itself), enterAt?: plan-check\|build\|verify, reset?: {ruling: RulingId}}`, `cut?: {reason, ruling?: RulingId}` |
| `holistic?` (M3, A5) | `{vision: PlanPath, obligations?: PlanPath, audit?: {every?: positive, lenses?: LensKind[] (ascending, non-empty), wallClockMin?: positive}}` | present exactly when the arc runs the holistic layer; `vision` names a `roadmap/vision-m3` file, `obligations` a `roadmap/obligations-m3` file (absent: none); `audit.every` N (default 5, D3), `audit.lenses` the required lens set L (default all four, H9, `lensSetOf`), `wallClockMin` (default 360). An apply may add it, never remove it |
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

`Parent = stage{unit, stage, attempt} | command{command} | op{op} | arc`.

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
| `judgment-inputs` (M2) | `unit, stage: plan-check\|gate, attempt, tip: Sha, head: Sha\|null (the unit commit; null exactly for a plan-check), specRev, specSha256, planRev, routingRev`: written after a judgment attempt's entry reservation and before its spawn (F1); one per `(unit, stage, attempt)`. A recovered call is consumed against it (`gateRead` at `tip`/`head`, `fingerprintAt` at `tip`) |
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

`proc.spawn` purposes: `backend | lane | teardown | probe | smoke`. `proc.kill` reasons: `deadline | stall | pause |
stop | recovery | external-unknown`.

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
`teardown|probe{unit\|null, resource: ResourceInstance}` \| `smoke{check, target: backend{backend, role, tier, routingRev} \| command}`.
`(role, tier)` is a seat (`build.escalation` is refused), which the usage fact copies.
The invocation is `op#ordinal`; its launch.json is written after the intent is durable and must hash to
`launchSha256`.

`Holder = stage{unit, stage, attempt} | sweep{command} | retry{unit, stage, attempt} | publication{unit, attempt}`
(M2 adds the last two: a probe reclaiming its unit's own residue, keyed by the stage attempt whose cleanup failed;
the publication transaction, A2). `ResourceEdge`: `reserve` (free→reserved), `run`
(reserved→running), `clean{from: reserved|running}` (→cleaning), `release` (cleaning→free), `fail{residues:
[{resource: ResourceInstance, teardown: InvocationId}]}` (cleaning→cleanup-failed; one residue per transitioned resource,
appended to the host index before this intent's done), `reclaim` (cleanup-failed→cleaning, sweep and retry holders only
(`RECLAIM_HOLDERS`):
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
| `cancel.json` | `CancelFile` / `cancelFile` | executor, before signalling the workload | `reason: pause\|stop\|recovery, at` |
| `exit.json` | `ExitFile` / `exitFile` | runner, after workload quiescence | `child: exited{code}\|signalled{signal}\|spawn-failed{error}, cause: exited\|deadline\|stall\|cancel\|recovery-kill, endedAt ≤ quiescedAt` |
| `result.json` | `ResultFile` / `resultFile` | executor (the adapter, pure over the files above), after the runner has exited with `exit.json` present; re-run at recovery whenever `exit.json` exists without it (lead ruling, 1a: the runner never runs the adapter, so it needs no backend schema) | union below |
| `runner.log` | none (plain text, not a record) | the runner's own stdout and stderr, opened by the executor when it starts the runner (`RUNNER_LOG`, `src/runner/launch.ts`) | free text; empty on a clean run |

`terminal` = `backend{purpose: backend|smoke, role, routingRev, schemaPath, outputPath, session}` \|
`command{purpose: lane|teardown|probe|smoke, expectedExit}`. Sessions: a judgment role takes only
`{backend:'claude', mode:'fresh', id: JudgmentSessionId}`; `build` takes `claude{fresh|resume, id}` \|
`codex{fresh}` (Codex mints its thread id) \| `codex{resume, id}`, ids `ImplementerSessionId`.

`result.json` = `backend{role, routingRev, session, outcome, usage, backendErrors[]}` \| `command{purpose,
exitCode|null, expectedExit, verdict: pass|fail|stall|process-fault|cancelled}`, `reason: pause|stop` beside
`cancelled` only (`exitCode: null` ⇒ not `pass` or `fail`; cause `stall` ⇒ `stall`, whatever the exit: a lane
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
(ascending id; the spec's cited rulings that are active), obligationRevs?: [{id: ObligationId, rev}] (M3: ascending
id; the selected, non-exempt obligations at the gated tip; absent exactly when there are none, non-empty when
present, so a fingerprint with none is byte-identical to a dev.5 one; `obligationRevsOf`)}`. Recorded with the
approval as an `approval` fact. Recomputed at the tip being published onto before `integration.ff`; any mismatch
re-gates. M1's C-nn ledger has no supersede beyond the withdrawn fold, so every active ruling is at rev 1; a cited
ruling that is withdrawn leaves the set, which changes the fingerprint. An uncited contract is outside the
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
| `residues.jsonl` | `ResidueLine` = `ChainEnvelope & ResidueRecord` | envelope `{v, seq, prev, at}` (no `arc`), same chain and tail rules as the event log (`parseChainLine`) |

`ResidueRecord = residue{key, teardown: {argv, cwd, env}, label} | disposition{key, cleaned, by{arc, inv}} |
disposition{key, isolated|transferred, by{arc, needsUser}}`; `ResidueKey = {arc, unit, inv, resource}` (per
resource). Run dir: `heartbeat.json` (`Heartbeat {v, generation, at}`), every 10 s, stale at 5 min; `start.json`
(`RunStart {v, generation, at, repo, planFile, profile}` with the resolved profile, rewritten by every start that
passes, read by `status` to re-resolve routing tables); `status.rejection.json` (`RejectionFile`, above).

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
   blocking needs-user is open;
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
attempt, publication, request{named, pools, cpu, publication}, envBlocked}], drains[{command, scope}]}`, written
by the executor `pid` (atomically, only when it changed): every unit with a task, the arbiter's waiters in the
order it serves them, and the pending mutations' scopes. `status` reads it only while that `pid` is the run's live
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
`run{state: running|held|parked|blocked|complete|refused|no-owner, owner, heartbeatAt}`; `units[…]` (the plan in
force's units, below); `edges`; `runOnly: UnitId[]|null`; `legacy: bool` (`scheduling() = legacy`); `plan{rev,
planSha256}|null` (the plan in force; an arc with none yet reads its plan file, warned); `routing{profile, rev,
seats: ClassTable, sources, bindings}|null` (the latest start's profile resolved under the current repo config and
the plan in force; classes only, no model id); `needsUser[{id, reason, blocking}]` (unacknowledged, the log's items
and the file-only `sup-*`/`host-*` ones, ascending id; step 14b); `commands{pending[{id, type}], receipts[]}` (the
last 10 terminal receipts); `spend{byRole, byModel{models, unresolvedRevs}, bySmoke}` (every total: `calls, input,
output, cacheRead, cacheWrite, turns, costUsd, unavailable`; `bySmoke` per backend and revision, in no role or
model total); `host{…}` (below); `parkedBackends`; `rejection`. The log is read with `readJournal`
(`src/core/log.ts`: fold without lock, repair, fact or cache write; an unterminated tail is left out); what only
the scheduler knows comes from `sched.json` while its writer is the live owner. `byModel` is the only place a model
id appears: seat totals (`meterOf(...).bySeat`) looked up in each revision's table, re-resolved from every plan
revision the log applied and the repo config under every built-in profile.

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
superseded or parked operator, no own-arc residue left, and no blocking needs-user open) or `no-owner`. With one, the first that holds:
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
OpId, failSeq, at}` per instance: set by a done `fail` (its op, seq and done time; the key is this arc's, the
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
`ORIGIN_RANK` (checkpoint 0, planned 1), then `waitStartSeq`; plan index last, so the order is total.

**Admission (A12, A17).** `ADMISSION_STAGES = prepare, plan-check, build, lanes, gate, candidate`; chains
(`BUILD_CHAIN` quiesce → evidence → salvage → teardown, `PUBLICATION_CHAIN` ff → snapshot) run to completion
under pause and drain. `TaskState = idle | awaiting-admission | in-stage | in-chain` (memory only).
`Admit(input: AdmitInput{view, plan, unit, stage, blocking, drains, tripped}) → admit | wait{constraints}` with
`AdmissionConstraint = paused{arc|unit} | drain{command} | run-only | backend-parked{backend, class} |
breaker{target} | base-red | blocking-item{id, reason}`. `CommandScope = arc | units{units} | none`;
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

**Ids** (`src/core/ids.ts`). `VisionClauseId` `V-<n>`, `ObligationId` `I-<n>`, `FindingId` `F-<n>`,
`DivergenceId` `D-<n>`, `JobId` `<audit|ckpt|docs|batch|baseline>-<n>` (`jobId(kind, n)`, `parseJobId`,
`jobIdOfKind(kind)` for a field that names one kind), `LaneRev` and `EnvId` (16 lowercase hex). A numbered id's `n`
is 1 for the first of its kind in the arc and one more each: findings and divergences by the order their facts
open them (`nextFindingId`, `nextDivergenceId`), jobs per kind by the highest the log named (`nextJobId`; a job is
named by a `job` parent or holder, a docs `pub`, a batch candidate, a `witnessed{for: job}` or its opening fact).
Ids are never reused; a withdrawn clause keeps its id (H16).

**Vision** (`roadmap/vision-m3`, `plan.holistic.vision`; `parseVision`). `{schema, rev: positive, confirmation:
{ref, at}|null (the Phase-0 playback's, unverified until M4), clauses: [{id: V-n, kind: purpose|serves|good|
non-negotiable|tradeoff, text, rank: positive|null (exactly for a tradeoff), state: active|withdrawn}]}`, ids unique,
at least one active clause. Owner-only: only an architect `apply` (source `command`) changes it (A14). A new
bundle, ruling or obligation may not cite a withdrawn clause (A1 refuses it); existing citations stay and are
reported (`VisionCoverage{unservedClauses, obligationsServingNone, withdrawnCited[{clause, citedBy}]}`).

**Obligations** (`roadmap/obligations-m3`, `plan.holistic.obligations`; `parseObligations`). `{schema, cutLine,
lanes: ArcLaneDef[], obligations: ObligationDef[], mapping: {paths: [{pattern: RepoPattern, obligations: I-n[]
(ascending, non-empty)}]}}`. `ArcLaneDef = LaneDef & {reporter: node-test|go-test-json|jsonl}` (R1, R3; a node-test
lane may not set or pass `NODE_OPTIONS`); `laneRevOf(lane)` = first 16 hex of sha256 over its canonical definition.
`ObligationDef = {id, rev (normative; evidence refreshes never bump it), statement, docRef{path, anchor, quotedText},
serves: V-n[] (ascending; non-empty in an arc with a vision, checked by A1), witness{lane, testIds (unique,
non-empty)}|null, proofJudgment{verdict: proves|insufficient, obligationRev, laneRev}|null, deliveredBy: UnitId[]
(non-empty for a future one), activation: future|must-hold, parent?, contracts: RepoPath[], state: active |
split{children} | waived{ruling} | deferred{ruling} | retired{ruling}}`. The reader checks: ids unique; `witness`
and `proofJudgment` null exactly on a split parent (H14); a split parent's children exist and name it as `parent`,
and a `parent` is a split parent listing the child; a witness lane is one of the file's lanes; mapping ids exist. A
stale proof judgment (its `obligationRev` or `laneRev` no longer the obligation's or the lane's) is the
classifier's to refuse (A1), not the reader's. `isExempt`: waived, deferred or retired.

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

**Witness records** (`witness.json` in a lane's evidence dir, B1; `witnessRecord`). `{v, lane, laneRev, envId,
treeSha, inv, runner: Reporter, purpose: witness|mutant, records: [{testId, selected: nat, outcome:
pass|fail|skip|zero-selected}] (ascending by testId), malformed}`; malformed ⇒ no records (every declared test
unwitnessed). `ObservationVerdict = held | not-held | partial | unwitnessed`; `ObservationKey = {treeSha, lane,
laneRev, envId}` (`observationKeyText`); `VerdictOf(record, witness) → ObservationVerdict` is B1's (pure).

**Ruling sidecars** (`roadmap/ruling-m3`, `parseRulingSidecar`; `rule <record.json>` and a bundle's `rulings`).
`{schema, id: C-n, statement, kind: constraint|decision|deviation|disposition, ruledBy: architect|checkpoint{job},
trigger, supersedes: [{id, part|null}], condition|null, docRefs: [{path, anchor, quotedText, relation:
consistent|refines|deviates}] (non-empty), contractRefs (ascending), contractOps: [{path, anchor, oldText, newText}],
obligations (ascending), obligationDispositions: [{id, disposition: waived|deferred|retired|amended}] (ascending by
id), cites: V-n[] (ascending), evidence: string[], appliesTo: arc|units{units}, lifetime: arc|standing, status:
active|superseded|withdrawn, consistency}` with **`consistency` required (G21)**: `{verdict: consistent|inconsistent,
judgedRevs: {head, ledgerSha256, obligationsSha256|null, visionSha256|null, contracts: [{path, blob}]}, by:
judgment{role: FreshRole, routingRev}|architect}`. The reader requires contract ops for a `deviates` ref, and cites
and evidence for a checkpoint's ruling; staleness of `judgedRevs` is A1's check at commit.

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
no `revision.commit` is open.

**`plan-applied` (M3 fields, all optional)**: `source` (with `command`: a `command` source names the fact's command,
any other source has `command: null`), `payloadSha256`, `rulingsSha256`, `obligationsSha256` (only with a vision),
`visionSha256` (present exactly while the arc is holistic, A5), `publication{pub: docs-n, head}`, `routingProvenance
= {profile, repoConfig: {seats, classes}, planLayer, unitLayers: {unit: layer} (ascending)}` (H7; every M3 revision
records it). New `PlanChange`s: `obligation{id, edit: added|split|witness|disposed}`, `mapping`, `vision{rev}`,
`limits{unit|null}`, `holistic`; `routing{routingRev, unit?}` (with `unit`: that unit's layer changed, and the rev is
its routing's).

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
no subject); a docs or batch `ff` is `{ref, old, new, subject: docs{pub} | batch{job}}` and has no fingerprint
(`unitFfFingerprint` asks for a unit's). `candidate.merge` `+ batch?{job: batch-n, members: [{unit, unitCommit,
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
job{job}`, G4); `ResidueState.holder` is the stage or job holder (`stageResidueHolder` narrows).

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
`merge-in{unit}` ({u}), `audit{lenses|null}` (none), `close-admissions` (none). Until the step that implements each,
its effect is rejected `<type>: not implemented (step X)`: `rule` A4, `reverse` A2, `steer` and `merge-in` A3, `audit`
and `close-admissions` B7 (`NOT_YET`, `src/commands/apply.ts`); `gc` (A5b) fails in the CLI.

**Needs-user reasons** (M3). Blocking: `obligation-baseline`, `finding-p1-escalated`, `new-finding-draining`,
`steered`, `not-reproduced`, `owner-request`, `respec-second`. Non-blocking (`NON_BLOCKING_M3_REASONS`):
`bundle-request`, `convergence-bound`, `convergence-identity`, `audit-owed`, `divergence-digest`.

**Prompts** (`src/prompts/`). `lens` and `checkpoint` are `unsupported` for every model until B4 writes the
modules (lens/Opus new, lens/Fable inherits Opus; checkpoint/Fable new, checkpoint/Opus inherits Fable; Sonnet and
Codex unsupported), so a holistic plan is refused `unsupported-routing{role: lens|checkpoint, tier: arc, why:
no-prompt}` at startup until then. Inputs (vision first, A14): `LensInputs = {vision: VisionInput{rev, clauses},
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
(A16: no op touches the vision, resource declarations, `.roadmap/config.json`, `gc` or ref deletion). **B4 adds**
(frozen here, not in the 0a code, because every key of a strict schema is required and the modules, fakes and
output change together): plan-check output `visionConflict: [{clauses: V-n[] (non-empty), note}]` (each opens a P3
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
