# Executor schemas and contracts (frozen in M1 step 1a)

The specification every later step compiles against. Each schema names the TypeScript type and the
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

## Owner rulings on model ids (DESIGN-1.0.md §4, Routing profiles)

1. `launch.json` is the only executor-written file allowed to contain a model id, and only inside `argv`.
   Its `terminal` names `{role, routingRev}` and the backend, never the model or triple.
2. The `state.no-model-ids` test scope is: the event log, the state cache, needs-user files, receipts,
   residues, the snapshot ref, `status` output and meter facts. Startup rejections shown in `status`
   therefore name the seat (`role`, `tier`) and routing layer, never the model.

Model ids appear only in routing configuration: built-in profiles, `.roadmap/config.json`, `plan.routing`,
per-unit route layers.

## Input contract

**CLI** (`src/input/cli.ts`: `parseCommand(argv): Command`, `parseStartArgs(argv): StartArgs`). Options are
`--name value` or `--name` switches, each at most once; anything else is a `CliError`.

| Form | `Command` |
|---|---|
| `--version` | `{command:'version'}` |
| `start --repo <path> --plan <plan.json> [--profile default\|claude-only]` | `{command:'start', args:{repo, plan, profile}}`; profile defaults to `default` |
| `status`, `watch`, `stop` `[--repo <p> --arc <a>]` | `{command, run: RunLocator}` |
| `pause (<unit> \| --all)` | `{target: {type:'unit',unit} \| {type:'all'}}` |
| `ack <needs-user-id> [--choice <option>]` | `{id, choice \| null}` |
| `resume [<unit> \| --backend claude\|codex]` | `{target: all \| unit \| backend}` |
| `sweep [--resource <name>]` | `{resource \| null}` |

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
| `rulings` | `PlanPath` | the C-nn ledger |
| `architectureDoc` | `RepoPath` | |
| `direction` | non-empty string | the Direction text |
| `routing?` | `RoutingLayer` | the `plan` routing layer |
| `suite.lanes` | `LaneDef[]` | executor-only suite lanes |
| `resources` | `ResourceDecl[]` | `{name, probe: ToolCommand, teardown: ToolCommand}`; `integration-slot` is built in and may not be declared |
| `units` | `PlanUnit[]` (non-empty) | `{id: UnitId, spec: PlanPath, risk: RiskTier, scope: RepoPattern[] (non-empty), resources: ResourceName[]}` |

`ToolCommand = {argv, cwd: RepoPath, env: LaneEnv}`, run from the repo root. Probe exit contract
(`PROBE_EXIT`): `0` free, `10` occupied under this unit's own label, `11` unlabelled or foreign; any other exit
is a probe process fault. `parsePlan` checks shape and in-file uniqueness only; references that need the
filesystem, git or specs are startup rows.

## Startup rejection table

`src/preflight/startup.ts`: `StartupRejection` (one member per row), `exitCodeFor(rejection)`,
`StartupCheck<K>{kind, check(StartupContext) → rejections[]}`. Each refuses before any pipeline intent and is
shown in `status`. Order of evaluation (lead ruling, 1a): the pure and host rows run first, before the journal
is opened; `backend-smoke` runs last, after host takeover and journal open, and its spawns are journaled as
`proc.spawn{purpose: smoke}` so a refused start still leaves an audit trail. "Before any intent" therefore
means before any *pipeline* intent.

| `kind` | Row | Fields | Exit |
|---|---|---|---|
| `legacy-roadmap-dir` | in-tree `.roadmap/` beyond `contracts/`, `constraints.md`, `invariants.md`, `debt.md`, `config.json` | `path, unexpected[]` | 78 |
| `worktree-root-unusable` | `worktreeRoot` on tmpfs or not writable | `path, problem: tmpfs\|not-writable, detail` | 78 |
| `spec-lane-unrunnable` | lane `argv[0]` unresolvable, env prerequisite missing, estate lane for the implementer | `unit\|null, lane, problem` | 78 |
| `unsupported-routing` | a seat resolves to an unsupported triple (every Codex judgment triple) | `role, tier, layer, unit\|null, why: codex-judgment\|no-prompt` | 78 |
| `undispositioned-residue` | a host residue neither `cleaned` nor `isolated\|transferred` | `residues: ResidueKey[]` | 78 |
| `host-busy` | live host owner, or live recovery-lock holder | `holder: owner\|recovery, arc, generation, pid` | **75** |
| `previous-arc-unreconciled` | previous claim's arc has unreconcilable invocations (R18); durable needs-user | `arc, invocations[]` | 78 |
| `backend-smoke` | smoke missing or failed for a backend the resolved profile uses | `profile, backend, problem: missing\|failed, detail` | 78 |
| `plan-invalid` | schema invalid, unknown spec path, baseline not an ancestor, unknown resource request | `problem: schema{field,detail} \| unknown-spec-path \| baseline-not-ancestor \| unknown-resource` | 78 |
| `recovery-holder-dead` | recovery lock held by a dead process; needs-user | `pid` | 78 |
| `owner-mismatch` | missing or mismatched owner metadata at takeover; needs-user | `detail` | 78 |
| `log-corrupt` | an invalid complete log line; host-level needs-user | `file, offset, detail` | 78 |
| `containment-mode-changed` | detected mode differs from the arc's recorded `containment-mode` fact | `recorded, detected` | 78 |

## Ids (`src/core/ids.ts`)

| Type | Form | Derivation |
|---|---|---|
| `ArcId`, `UnitId`, `ResourceName` | slug: `[a-z0-9]`, inner `-`, 1-64 chars | `INTEGRATION_SLOT = 'integration-slot'` |
| `OpId` | `<arc>/<seq>`, seq = event-log seq of the op's first intent | `opId(arc, seq)`, `parseOpId` |
| `InvocationId` | `<op>#<ordinal>`, ordinal 1 = first intent, +1 per retry | `invocationId(op, n)`, `parseInvocationId`, `invocationDirName` → `<seq>-<ordinal>` |
| `SpecRev` | integer ≥ 1 (a branded number) | |
| `Sha` | 40 lowercase hex | |
| `Sha256Hex` | 64 lowercase hex | |
| `RoutingRev` | 16 lowercase hex | step 5: first 16 hex of sha256 over the canonical resolved `RoutingTable` |
| `CommandId` | `cmd-<16 lowercase hex>` | minted by the CLI |
| `NeedsUserId` | `nu-<seq>` \| `sup-<generation>-<n>` \| `host-<slug>` | `needsUserIdForOp(op)`, `supervisorNeedsUserId`, `hostNeedsUserId` |
| `JudgmentSessionId`, `ImplementerSessionId` | lowercase uuid; **distinct brands** | resume APIs take only `ImplementerSessionId` |
| `LaneId`, `ClauseId` | letter then `[A-Za-z0-9_.-]`, ≤ 64 | |
| `RulingId` | `C-<digits>` | |
| `OpKey` | printable ASCII, no whitespace, ≤ 256 | groups ops that must not overlap |

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
| `meter` | `inv, role, routingRev, unit: {unit, attempt}\|null, usage: TokenUsage` |
| `usage-unavailable` | `inv, role, routingRev, unit: {unit, attempt}\|null, reason: no-result\|absent\|malformed` |
| `dispatch` | `record: DispatchRecord` |
| `stage-outcome` | `unit, stage, attempt, outcome, class, chargeable`: one per `(unit, stage, attempt)`; see below |

**`stage-outcome`** records one stage attempt's outcome as the transition table
(`src/pipeline/transitions.ts`, `outcomeFact`) decided it. `outcome` is one of `STAGE_OUTCOME_KINDS[stage]`
(every stage but `retire`, which is terminal). `chargeable` marks a design-class failure (the plan's C rows).
`class` is what the decision did to the unit: `advance` (on to another stage) \| `redirect` \| `revise` \|
`candidate-red` (a bounded round within its bound) \| `retry` (the stage's one uncharged retry; only at
`plan-check, build, lanes, gate`) \| `route-up` (re-dispatched on the role's high seat; only at `plan-check,
gate`) \| `trigger` (a risk trigger: the next judgment dispatch sits on the high seat) \| `park` \| `stop` \|
`retire`.

The fold derives each unit's `UnitState` from these facts through `afterStageOutcome` (`src/core/state.ts`),
the same function the transition table uses, so a decision's counters are the log's:
`{unit, stage, risk, status: active|park-pending|stop-pending|retired, counters: {attempts,
chargeableFailures, redirects, reviseRounds, candidateReds, retries: {plan-check, build, lanes, gate}},
routedUp: JudgmentStage[], promotion}`. `attempts` counts distinct `(stage, attempt)` pairs named by a
stage-parented intent or a stage-outcome fact. `risk` is the `riskFloor` of the unit's latest `dispatch` fact:
a plan-check that raises the risk re-pins the dispatch. `promotion` is set by a `trigger` and cleared by the
next judgment-stage outcome other than a `retry`. `status` follows the latest outcome's class.

**Append** (step 2). One serialised writer; `writeSync` loop until the full length is written; `fsync`; no act
until fsync returns for the full line.

**Fold invariants** (violation = refuse): contiguous seq; chain intact; ≤ 1 open intent per key; done/abort
match an open intent; ordinal strictly increasing per key; a retry (same op, next ordinal) inherits
`deadlineAt`, `key` and `parent`; counters `monotonic()`; one `stage-outcome` per `(unit, stage, attempt)`;
the chargeable outcome that reaches `CHARGEABLE_BOUND` (3) has class `park`; a later `dispatch` of a unit keeps
its `scope` and does not lower its `riskFloor`. `state.json` is a derived cache, never read for a
decision. Attempts, chargeable failures, stage advancement and meter totals are derived from done records and
facts keyed by op/inv, so they cannot be lost or double-counted.

**Tail rule**. Verify the valid prefix first. Only a terminal suffix lacking `\n`, or an all-NUL suffix, is
discardable: save to `events.torn.<off>.<sha8>` (fsync) → truncate (fsync) → `tail-discarded` fact. A saved
fragment with no matching fact is re-recorded at the next start. Any invalid complete line → refuse
(`log-corrupt`), host-level needs-user, exit 78.

**Durability rule**. Every create or rename is file fsync + parent-dir fsync (`fsx.durable()`).

## Op kinds (`OP_KINDS`, `OP_SCHEMAS`)

`proc.spawn` purposes: `backend | lane | teardown | probe | smoke`. `proc.kill` reasons: `deadline | pause | stop |
recovery | external-unknown`.

| Kind | `expect` (`OpExpect`) | `post` (`OpPost`) | done `outcome` (`OpOutcome`) |
|---|---|---|---|
| `worktree.create` | `path, checkout: branch{branch, at, createBranch} \| detached{at}` | `null` | `created{head}` |
| `worktree.remove` | `path, evidence: OpId` (done `evidence.snapshot`) | `null` | `removed` |
| `resource.transition` | `holder, resources` (lock order), `edge` | `null` | `transitioned` |
| `proc.spawn` | `subject: SpawnSubject, launchSha256` | `null` | `result{resultSha256, summary}` \| `lost{treeEffects}` |
| `proc.kill` | `inv, scope: invocation\|op, reason` | `null` | `quiesced` |
| `evidence.snapshot` | `source, globs, dest` | `{manifest}` | `captured{manifestSha256, files}` |
| `salvage.commit` | see git table | `{new}` | `committed` |
| `mergein.prepare` | see git table | `clean-merged{new}` \| `conflicted` | `clean-merged` \| `conflicted` \| `completed{head}` |
| `spec.patch` | `path, oldSha256, expectRev, patch: SpecPatch` | `{newSha256, newRev = expectRev+1}` | `patched` |
| `candidate.merge` | see git table | `{new}` | `merged` |
| `integration.ff` | see git table | `null` | `published` \| `unpublished{tip}` \| `recovery-required{observed}` |
| `snapshot.publish` | see git table | `{new}` | `published` |
| `needsuser.raise` | `id, path` | `{sha256}` | `raised` |
| `command.apply` | `command, commandSha256` | `null` | `applied{receiptSha256}` \| `rejected{reason}` |

`SpawnSubject`: `backend{role, routingRev, unit, attempt}` \| `lane{unit, lane, set: spec\|suite, at: Sha}` \|
`teardown|probe{unit\|null, resource}` \| `smoke{check, target: backend{backend, role, routingRev} \| command}`.
The invocation is `op#ordinal`; its launch.json is written after the intent is durable and must hash to
`launchSha256`.

`Holder = stage{unit, stage, attempt} | sweep{command}`. `ResourceEdge`: `reserve` (free→reserved), `run`
(reserved→running), `clean{from: reserved|running}` (→cleaning), `release` (cleaning→free), `fail{residues:
[{resource, teardown: InvocationId}]}` (cleaning→cleanup-failed; one residue per transitioned resource,
appended to the host index before this intent's done). Lock order: ascending names, `integration-slot` last.

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
| `spec.patch` | `{path, oldSha256, newSha256, expectRev, newRev}` + the patch | file hash = new |
| `needsuser.raise` | write-once, `{id, path, sha256}` | file hash matches |
| `command.apply` | `{command, commandSha256}` | an **operation-bound `applied` receipt** naming the op and its verified postconditions exists (`accepted` is not done) |

## Runner files (`src/core/records.ts`)

Invocation dir `<runDir>/inv/<seq>-<ordinal>/`. Every file is bound by `{v, arc, op, inv}` (`inv` must be an
invocation of `op`, `op` of `arc`) and written by `fsx.durable()`. Workload stdout and stderr go to files
`stdout` and `stderr` there, never pipes.

| File | Type / reader | Writer, when | Fields |
|---|---|---|---|
| `launch.json` | `LaunchFile` / `launchFile` | executor, after the spawn intent is durable, before the act | `argv, cwd, env` (declared; no `ROADMAP_*`), `stdinPath\|null, deadlineAt, graceMs, containment, test: {crash}\|null, terminal` |
| `runner.json` | `RunnerFile` / `runnerFile` | runner, before spawning (`child: null`); rewritten after | `runner{pid, start, bootId}, child{pid, start, sid}\|null` |
| `cancel.json` | `CancelFile` / `cancelFile` | executor, before signalling the workload | `reason: pause\|stop\|recovery, at` |
| `exit.json` | `ExitFile` / `exitFile` | runner, after workload quiescence | `child: exited{code}\|signalled{signal}\|spawn-failed{error}, cause: exited\|deadline\|cancel\|recovery-kill, endedAt ≤ quiescedAt` |
| `result.json` | `ResultFile` / `resultFile` | executor (the adapter, pure over the files above), after the runner has exited with `exit.json` present; re-run at recovery whenever `exit.json` exists without it (lead ruling, 1a: the runner never runs the adapter, so it needs no backend schema) | union below |
| `runner.log` | none (plain text, not a record) | the runner's own stdout and stderr, opened by the executor when it starts the runner (`RUNNER_LOG`, `src/runner/launch.ts`) | free text; empty on a clean run |

`terminal` = `backend{purpose: backend|smoke, role, routingRev, schemaPath, outputPath, session}` \|
`command{purpose: lane|teardown|probe|smoke, expectedExit}`. Sessions: a judgment role takes only
`{backend:'claude', mode:'fresh', id: JudgmentSessionId}`; `build` takes `claude{fresh|resume, id}` \|
`codex{fresh}` (Codex mints its thread id) \| `codex{resume, id}`, ids `ImplementerSessionId`.

`result.json` = `backend{role, routingRev, session, outcome, usage, backendErrors[]}` \| `command{purpose,
exitCode|null, expectedExit, verdict: pass|fail|process-fault}` (`exitCode: null` ⇒ `process-fault`).
`outcome = success{value} | refusal{stopReason} | malformed{detail} | process-fault{detail}`;
`usage = known{tokens: {inputTokens, outputTokens, cacheReadTokens|null, cacheWriteTokens|null}} |
unavailable{reason}`; `backendErrors[].class = usage-limit | capacity | platform | backend`, classified only from
`turn.failed` / CLI error events. A judgment result's `session` is its assigned id; an implementer's may be
`null` (died before reporting one).

**Precedence** (`classifyTerminal(exit, output, schemaValid): TerminalOutcome`, pure):

1. cause `deadline | cancel | recovery-kill`, a signal, or a failed spawn → `process-fault`, whatever the output;
2. non-zero exit with schema-valid output → `malformed`; non-zero exit without it → `process-fault`;
3. exit 0 without schema-valid output → `malformed`;
4. exit 0 with schema-valid output → `success{value}`.

`refusal` is the adapter's reading of a backend stop reason (step 4). Commands: `classifyCommand(exit,
expectedExit)`, same rule 1, then `exitCode === expectedExit` → `pass`, else `fail`.

## Approval fingerprint and dispatch record

`ApprovalFingerprint = {unitCommit, specRev, contractRevs: [{path, blob}] (ascending path; cited contracts and the
architecture doc at the gated tip), rulingRevs: [{id, rev}] (ascending id)}`; `obligationRevs` arrive in M3.
Recomputed at T before `integration.ff`; any mismatch re-gates.

`DispatchRecord = {unit, specRev, scope: RepoPattern[] (sorted), riskFloor, routingRev, at}`, recorded once per
dispatch as a `dispatch` fact. A redirect cannot widen `scope` or lower `riskFloor`.

## `spec.json` M1 subset and `SpecPatch`

`SpecM1 = {schema:'roadmap/spec-m1', unit, rev: SpecRev, lanes, acceptance (non-empty), scope (non-empty),
resources, decisions, facts}`; item ids unique across all sections.

| Item | Fields |
|---|---|
| `LaneDef` | `id: LaneId, argv[], cwd: RepoPath, env: {set: {NAME: value}, pass: [NAME]}, expectedExit, tier: fast\|estate, resources[], evidenceGlobs[]` |
| `AcceptanceDef` | `id: ClauseId, clause, failLoudIfUndelivered` |
| `NoteDef` (decisions, facts) | `id: ClauseId, text` |

Every stored item adds `state: active | struck | deferred`; ids are never deleted or reused.
`SpecPatch = {expectRev, by: {role:'planCheck', routingRev, inv}, ops (non-empty)}`; ops `add{section, item} |
replace{section, item} | strike{id} | defer{id}`, sections `lanes | acceptance | decisions | facts`. Scope and
resources are not patchable in M1.

## Routing types (`src/routing/types.ts`)

`ModelId = 'claude-opus-5-5' | 'claude-fable-5-1' | 'gpt-5.6-luna' | 'gpt-5.6-sol'` (closed). `Backend = claude |
codex`. `Triple = {backend:'claude', model: ClaudeModelId, effort:'default'} | {backend:'codex', model:
CodexModelId, effort: low|medium|high|xhigh}`. `Role = planCheck | build | gate`; `RiskTier = low | med | high`;
`RoutingTable = {[R in Role]: {[T in RiskTier]: Triple}}`; `RoutingLayer` = any subset of seats (a named role
needs ≥ 1 tier); `RoutingLayerName = builtin | repo-config | plan | unit` (lowest to highest precedence);
`ProfileName = default | claude-only`. `PromptTable<P> = {[R in Role]: {[M in ModelId]: prompt{prompt} |
inherits{from, reviewed} | unsupported{reason}}}`; step 5 fills `PROMPTS` and the profiles.

## Host files (`/var/tmp/roadmap/`)

| File | Type / reader | Content |
|---|---|---|
| `host.lock` | `HostLockClaim` | `{v, nonce, generation, bootId, supervisor{pid,start}, arc, runDir, repo}`; claimed by `link(tmp, host.lock)` |
| `host.generation` | `lastGeneration` (`src/host/lock.ts`) | the last generation issued, as `<positive integer>\n`; `durableWrite` before any claim carrying it is published. Monotonic per host dir: a fresh claim issues last + 1, a takeover max(dead claim, last) + 1, so a generation (and its write-once `handshake.<generation>`) never repeats |
| `host.owner.json` | `HostOwner` | `{v, nonce, generation, executor{pid,start}\|null}`; atomic publish |
| `host.recovery.lock` | `RecoveryLockClaim` | `{v, nonce, bootId, holder{pid,start}, at}`; claimed by `link()` |
| `handshake.<generation>` | `HandshakeFile` | `{v, nonce, generation}` |
| `supervisor.ready.<generation>` / `supervisor.failed.<generation>` | `ReadinessFile` | `{v, generation, state: ready, at}` / `{…, state: failed, reason}` |
| `supervisor.state.json` | `SupervisorState` | `{v, generation, crashes: IsoTime[] ascending}` |
| `exit.reason.json` | `ExecutorExitReason` | `{v, generation, reason: stop\|complete\|refused}` |
| `residues.jsonl` | `ResidueLine` = `ChainEnvelope & ResidueRecord` | envelope `{v, seq, prev, at}` (no `arc`), same chain and tail rules as the event log (`parseChainLine`) |

`ResidueRecord = residue{key, teardown: {argv, cwd, env}, label} | disposition{key, cleaned, by{arc, inv}} |
disposition{key, isolated|transferred, by{arc, needsUser}}`; `ResidueKey = {arc, unit, inv, resource}` (per
resource). Run dir: `heartbeat.json` (`Heartbeat {v, generation, at}`), every 10 s, stale at 5 min.

## Commands, receipts, needs-user

| File (run dir) | Type | Content |
|---|---|---|
| `commands/incoming/<id>.json` | `CommandFile` | `{v, id, arc, at, body}`; `body = pause{target} \| stop \| ack{needsUser, choice\|null} \| resume{target} \| sweep{resource\|null}` |
| `commands/receipts/<id>.<state>.json` | `Receipt` | `accepted{at}` \| `applied{at, op, verified[] (non-empty)}` \| `rejected{at, reason}`; write-once each |
| `needs-user/<id>.json` | `NeedsUserRecord` | `{v, id, arc, raisedAt, blocking, subject: unit{unit}\|arc\|host, reason, summary, recommendation, options[{id, label}], evidence[]}`; write-once |
| `needs-user/<id>.ack.json` | `NeedsUserAck` | `{v, id, command, choice\|null, at}` |

Control commands (`CONTROL_COMMANDS = pause, stop, ack`) apply immediately, waiting only for an
`integration.ff` critical section; mutations (`resume`, `sweep`) apply at safe points. `NeedsUserReason` is a
closed list in `records.ts`; add members by request.

## Cross-module interfaces (`src/core/interfaces.ts`)

| Interface | Shape | Implemented in |
|---|---|---|
| `Journal` | `begin(NewIntent<K>) → Durable{op, inv, seq}` (allocates `op = <arc>/<seq>`, ordinal 1, then calls `body(op, inv)`); `retry(op, kind, body(inv))` (next ordinal; inherits key, parent, deadlineAt); `done`, `abort`, `fact` → durable seq; `view: JournalView` | step 2 |
| `JournalView` | `arc, highWater(), openIntents(), latestIntent(op), doneOf(op), usageRecorded(inv)` | step 2 |
| `Containment` | `mode, launch(launch, invDir), members(WorkloadRef), kill(WorkloadRef, reason, graceMs), empty(WorkloadRef)` | 3a, 3b |
| `RunnerFiles` | `invDir, inv, read(name) → file\|null, write(name, file)`; `RunnerFileMap` keys the five files | 3a |
| `Adapter` | `(AdapterInput{launch, exit, stdoutPath, stderrPath}) → ResultFile`; pure over files | 4 |
| `GitOp<K, Request>` | `kind, prepare(request) → IntentBody<K>, act(intent), verify(intent) → OpOutcome[K], reconcile` | 8a, 8b |
| `Reservations` → `Reserved` → `Running` → `Cleaning` | typestates: `reserve(holder, resources)`, `probe() → OccupancyVerdict clear\|own-label\|foreign`, `run()`, `clean()`, `teardown() → released \| cleanup-failed{failed, released}` | 10 |
| `Reconciler<K>` | `(IntentOf<K>, JournalView) → Disposition` limited to `AllowedDisposition[K]`: `done \| redo \| park \| abort \| adopt \| lost \| recovery-required` | 3c, 7, 8a, 8b, 9, 10, 13 |

`AllowedDisposition`: `proc.spawn` done/adopt/lost; `proc.kill` done/redo; `worktree.*`, `salvage.commit`,
`mergein.prepare`, `spec.patch` done/redo/park; `evidence.snapshot`, `resource.transition`, `needsuser.raise`,
`command.apply` done/redo; `candidate.merge`, `snapshot.publish` done/redo/abort; `integration.ff`
done/redo/recovery-required.

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
   per inv either way. `unit` is `{unit, attempt} | null` (null for smokes).
10. **`dispatch` fact** holds the `DispatchRecord`, so the pin is in the WAL.
11. **`plan.json` gains `resources: ResourceDecl[]`** (probe + teardown per named resource) and the probe exit
    contract `0/10/11`: the startup row "resource request unknown" and the reservation cycle need declarations
    the plan's M1 shape omitted.
12. **Run-input paths in `plan.json` (`rulings`, unit `spec`) are relative to the plan file's directory**;
    product paths (`contracts`, `architectureDoc`) are repo-relative.
13. **Lane `env` = `{set, pass}`**: literal values, plus host variables that must exist (missing →
    `spec-lane-unrunnable`).
14. **Spec items carry `state`**; strike and defer never delete, so ids are never reused. Scope and resources
    are not patchable in M1. `SpecPatch.by` is plan-check only in M1.
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
