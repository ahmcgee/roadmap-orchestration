# Roadmap Orchestrator: operating reference

Lookup companion to [SKILL.md](SKILL.md). Commands and contracts describe the schema-2 command center (1.0.0-dev.33). The parser is `executor/src/input/cli.ts`; exact data readers are indexed in `executor/SCHEMAS.md`.

## Conventions

Use the currently loaded plugin's `executor/bin/roadmap`, not an arbitrary cached installation. Node 24 runs the TypeScript directly. `node <plugin-root>/executor/bin/install-roadmap` installs the owner's managed launcher; `--bin-dir` chooses a writable PATH directory. It refuses unrelated files. Check its reported version and PATH shadowing. The TUI belongs in the owner's separate interactive terminal.

Commands below use `<path>` for a product repo, `<dir>` for an export, and quoted text as **one argv value**. Run commands default to the host's current arc. Their optional `--repo <path> --arc <arc>` locator is a pair; never give just one. Host acts have their own required locator. There is no `--run-dir` flag.

Exit codes: 0 success, 64 CLI/argument error, 73 live watcher contention, 75 live host contention, 78 refused operation or failed validation. An accepted or queued command is not proof that its requested change applied: inspect the receipt. Startup rows and command refusals include the concrete reason and evidence.

## CLI

### Run commands

| Form | Contract |
|---|---|
| `roadmap --version` | Installed executor release. |
| `roadmap start --repo <path> --plan <plan.json> [--profile default|claude-only] [--wait <ms>]` | Validate inputs and backend smoke, claim host, launch detached supervisor/executor, or recover the existing schema-2 run. The input plan supplies baseline/previousHead/chain. On a restart with a plan in force, keep its recorded routing profile; a conflicting `--profile` refuses (use a routing apply to change it). CLI/config/default selection applies only at first start. |
| `roadmap status [--summary] [--repo <path> --arc <arc>]` | Full JSON or compact owner JSON; read-only, no status lock. |
| `roadmap tui [--repo <path> --arc <arc>]` | Read-only terminal observer. Use an interactive terminal. |
| `roadmap watch [--repo <path> --arc <arc>]` | Stream events. |
| `roadmap watch --actionable [--replace] [--heartbeat-min <min>] [--from <seq>] [--repo <path> --arc <arc>]` | Hold the arc’s watcher lease and stream actionable transitions and heartbeat check-ins. Use --replace to stop a live holder and take over, including across plugin versions. |
| `roadmap watch --stop [--repo <path> --arc <arc>]` | Stop the lease holder and remove its lease; succeeds when none exists. |
| `roadmap stop [--repo <path> --arc <arc>]` | Quiesce work and stop. |
| `roadmap pause (<unit> | --all) [--repo <path> --arc <arc>]` | Pause one unit or the arc. |
| `roadmap resume [<unit> | --backend claude|codex] [--repo <path> --arc <arc>]` | Resume a unit, explicitly unpark a backend, or resume all ordinary resumable work. |
| `roadmap ack <needs-user-id> [--choice <option-id>] [--repo <path> --arc <arc>]` | Name the item to close it. Arc-subject items and pack-review items accept optionless ack; unit/host items without options require subject action. Any supplied choice must be offered. |
| `roadmap sweep [--resource <name>] [--repo <path> --arc <arc>]` | Re-probe/clean residual resources using declared protocol. |
| `roadmap apply --from <dir> --rev <n> --reason <text> [--dry-run] [--repo <path> --arc <arc>]` | File-level CAS from a genuine export. Reason is a nonempty single line; N equals export.planRev. |
| `roadmap resolve-edge <edge> --evidence <text> [--repo <path> --arc <arc>]` | Record a contingent condition met, with evidence. |
| `roadmap run-only <unit>... [--repo <path> --arc <arc>]` | Admit only these units temporarily. |
| `roadmap run-only --clear [--repo <path> --arc <arc>]` | Remove that restriction and close its applicable subject notices. |
| `roadmap reverse <D-n> [--repo <path> --arc <arc>]` | Construct a compensating revision from a recorded departure's preimage; normal change validation still applies. |
| `roadmap steer <unit> --brief <file> --budget <min> [--class efficient|frontier|summit] [--resume] [--repo <path> --arc <arc>]` | Steer any unfinished unit, cancelling/quiescing active work first. Save pre-steer state, keep the brief and run one editing round, lanes and gate. Without resume it parks for root review even if green; with resume a green pass proceeds. Class changes its build seat through a routing revision. |
| `roadmap dismiss <finding> --counter-evidence <line> [--repo <path> --arc <arc>]` | Root dismissal of an active F-n finding, including P1, with required non-empty counter-evidence. Unknown or settled findings refuse. |
| `roadmap note <unit> --brief <file> [--repo <path> --arc <arc>]` | Keep the brief as a note for the next build round; no cancellation. |
| `roadmap witness <obligation> --result pass|fail --evidence <file> [--repo <path> --arc <arc>]` | Root attestation for an active external-class witness. Evidence is a regular file or an HTTP(S) URL. File bytes are hashed at submission and kept. |
| `roadmap merge-in <unit> [--repo <path> --arc <arc>]` | Bring the integration tip into this unit through the executor. |
| `roadmap audit [--repo <path> --arc <arc>]` | Request one whole-campaign audit. |
| `roadmap close-admissions [--repo <path> --arc <arc>]` | Drain toward completion without new admissions. |
| `roadmap demo up|down|hold|release [--repo <path> --arc <arc>]` | Start/stop demo or hold/release automatic promotion. |

### Host acts

| Form | Contract |
|---|---|
| `roadmap inputs export --repo <path> --arc <arc> --out <dir>` | Write the exact kept inputs in force to a **new** directory; works with executor down. |
| `roadmap phase0 check --repo <path> (--plan <plan.json> | --from-ref <arc>)` | Validate authored inputs or recorded inputs from a verified snapshot ref without starting an arc. |
| `roadmap corpus pin --repo <path> --commit <ref> --baseline <sha> --out <file>` | Derive a reproducible corpus pin from the guide and rule registry. |
| `roadmap brief --repo <path> [--json] [--ack <briefId>]` | Canonical chain delta, or commit the owner's acknowledgement of that exact payload. |
| `roadmap answer <P-n> --repo <path> --text <text> [--arc <arc>]` | Append an owner answer to the question log. Without arc choose the newest arc holding it open. Apply it to inputs separately. |
| `roadmap pr --repo <path> --arc <arc> [--supersede-previous]` | Open/update a stacked PR; supersede the previous open PR only when intended. |
| `roadmap chain status --repo <path>` | Derive chain state, unanswered/applied answers and next-start eligibility from refs and acknowledgements. |
| `roadmap resume-arc --repo <path>` | Restart a dead owner's supervisor, no-op otherwise; suitable for an authorized devcontainer boot hook. |
| `roadmap witness-check --lane-file <file>` | Run a supplied witness lane in cwd and verify every required test id; 0 pass, 78 fail/refusal. Builder development check, not an external attestation. |
| `roadmap gc --repo <path> [--keep <n>] [--dry-run]` | Compact eligible old runtime/evidence while preserving authoritative snapshots. |

## CAS edits and command lifecycle

Export is the only starting point for changing a running arc. It writes plan, current specs, ledger, obligations, vision and (for corpus arcs) pin/Phase-0 record. Beside-plan paths keep their relative names; repo files go under `repo/`. The corpus guide is read from the committed product, not exported. `export.json` contains `{planRev, specRevs, base}`; base is the full revision manifest. Do not edit that metadata.

Edit intended files, dry-run if useful, then apply with `--from`, exported revision and reason. For every edited file, current in-force bytes must equal its base bytes. Untouched files take current bytes. Independent file edits can land after another revision; two changes to the same file conflict even if different fields changed. Refusal lists every stale file. Export again and reapply the intended change. Code auto-bumps each edited existing spec to current rev + 1, including evidence-only changes.

Root changes can add units, split, cut, re-enter, edit specs/obligations/vision/Phase 0, change routing/bounds and revise the target pin. Change classification still enforces immutable identities, dependency/milestone conservation, frozen contracts, obligation proof and intentional weakening authorization. A reason is required; it is not a way to bypass mechanical safety checks. Executor-authored revisions use CAS with retry and non-blocking revision notices. A root command does not automatically generate that executor revision notice.

Commands are write-once queued files with accepted/queued/applied/rejected receipts. A queued apply waits for the relevant stage boundary. Read its final receipt before relying on a revision. Restart replays from durable command/revision provenance rather than resubmitting the action. Steer/note hash their brief at submission, so preserve its bytes until accepted and kept. Steer cannot revive a finished unit and does not reset attempt caps.

Unit- and host-subject items close after a successful action on that subject. Arc-subject items close only when named with `roadmap ack <needs-user-id>` or through their documented settlement: a later baseline with no problems settles `obligation-baseline` items; a superseding pack review settles `pack-review` items; editing an abandoned walk’s own milestone bring-up/journeys supersedes that walk escalation. Read the evidence and resolve or explicitly accept the item before ack; owner requests still require the actual owner decision within the session's authorization. An apply or arc-wide resume leaves unrelated arc items open, including waste, revision and dropped-apply notices. Finding-subject requests close when all their named findings settle, or a root apply supplies all their repairs. Optionless arc and pack-review items accept ack; other optionless items require action on their subject. Any supplied choice must be offered. Revision and waste notices do not hold execution.

Pack review must end before first admission. Open blocking unit findings hold their targets and transitive dependents through effective `after` edges (including prepared lineage replacements); contingent conditions keep their ordinary readiness checks. Other blocking targets hold the arc. The one arc-subject item states scope; fix the pack for a superseding review or acknowledge it. Scoped holds persist while unrelated work runs. Status names the item on held units; arc `holds` includes pack-review only for arc-wide scope.

## Authoring inputs

Exact types/readers are in `SCHEMAS.md` under the sections named here. The literal schema labels are stable identifiers, separate from runtime `v: 2`.

| File | Contents / label |
|---|---|
| `plan.json` | `roadmap/plan-m1`: target, baseline, integrationBranch, absolute worktreeRoot, contracts, rulings ledger path, direction, suite, resources, units; optional holistic, milestones, environments, routing, limits, capacity, expectations, chain/previousHead, knownDefects, derived. |
| Unit spec | `roadmap/spec-m1`: unit, rev, intent, nonGoals, acceptance, lanes, resources, decisions, facts, cites; optional obligations, repairs, witnesses, design, pins, removes, forces. |
| Obligations | `roadmap/obligations-m3`: cutLine, lanes, obligations, mapping, plus corpus census. |
| Phase-0 record | `roadmap/phase0-m4`: curation, corpusDivergences, questions, debt, slice. |
| Vision | `roadmap/vision-m3`: rev, confirmation, clauses, questions. Corpus arcs use `.roadmap/vision.json`. |
| Corpus pin | `roadmap/corpus-pin-m4`: source identity, included file hashes, rules and history; generated by corpus pin. |
| Ledger | Plain C-n text named by plan.rulings, root-facing. Cites and debt resolution retain C-n references in their wire shapes. |

A plan has exactly one target arm: `corpus` + `phase0` + `holistic` (vision in repo), or `architectureDoc` with optional architectureDigest and holistic vision file. A fresh holistic start requires corpus (`holistic-needs-corpus`), even though the parser retains the architecture-doc holistic shape. PlanPath values resolve relative to the plan directory; RepoPath values resolve in the product. WorktreeRoot is absolute. Use lower-case safe ids, SHA-1 commit ids and SHA-256 content hashes of the required length.

The plain C-n ledger has no partial-supersede, scope or lifetime marks: for partial supersession, withdraw the old ruling by the new one and restate its surviving part with scope/lifetime in the text. For example, mark the old entry `C-1 — withdrawn by C-2` and restate the surviving rule as a fresh C-n entry whose prose names its scope and lifetime.

Every unit requires a nonempty unique systems list, known in systemsMap. Origins are planned, repair, polish, deflake. A spike is a unit with `spike:{question}`; it keeps the normal build/gate safety checks but retires its report without a merge. Specs require nonempty intent and at least one nonGoal. Item states are active, struck or deferred; ids never disappear just because an item is no longer active. An acceptance item's `failLoudIfUndelivered` (required for completion) defaults to true; set false only for a best-effort item. Cites retains `{contracts:[],rulings:[]}` even though seats receive no C-n ledger. Put the rule text relevant to the unit in its authored acceptance/facts rather than relying on discovery of a giant reference file.

A repair names finding/obligation ids in `repairs`; a re-entry names its predecessor and the failure reference it fixes. Re-entry reset and cut carry reasons. Root splits conserve text and systems and preserve the parent's obligations, dependencies and milestone assignment; they cannot split deflake units. Contract documents change through ordinary units. The ledger is not a product-document patch channel.

### Lanes and evidence

A lane requires id, argv, cwd, env `{set,pass}`, expectedExit, cadence, resources and evidenceGlobs; evidenceExcludes is optional. argv has no shell. Pass only required inherited variables. Supply timeoutMin for a real wall timeout; without it the runner backstop is six hours, not a red timeout verdict.

| Kind | Cadences |
|---|---|
| Spec | build, unit, candidate |
| Suite | build, unit, candidate, batch (batch requires holistic) |
| Arc witness | build, candidate |

`cost: cheap|expensive`, `inputs`, `systems`, `placement: local|shared-resource|cross-system`, cpu, testArgv, stochastic and environment refine the lane where allowed. Expensive or explicitly whole-repo lanes at build/unit cadence are refused by contextual validation. Candidate spec lanes run on the current tip's candidate with delivering-unit attribution. Integration/resource-bearing spec checks require a spike where the placement rules demand it. Batch is the only batch/milestone cadence; selected milestone lanes run after member retirement, while plain batch suites still run at batch points and all batch lanes run at close-out.

Reuse binds execution identity and filtered tree bytes. Explicit inputs win; implicit spec input uses the unit systems, otherwise lane systems. Unmapped paths fail safe; shared/contract consumers and dependencies participate. `testArgv` has one exact `{files}` element and enables targeted leaf-test execution. Arc lanes disallow testArgv, stochastic and environment. Stochastic lanes declare runs/minPasses and never enter the flaky protocol. `readsComments` is still accepted but has no special pass-carryover behavior.

Witness lanes add reporter (`node-test`, `go-test-json`, `jsonl`) and testPaths. Witness refs declare lane, exact testIds and test files. Proof pins bind `{obligationRev,witness:{testIds,files},verdict}`, independently of lane revision. Moving unchanged tests to another lane is a re-witness, not a weakened statement. Required tests must all run and pass under their ids; skipped/missing tests are not passes. Mutation smoke retains test files while reverting production changes, then reports killed/survived/inconclusive to the gate.

On repeated reds the executor compares the lane at diffBase, retaining original failure/base evidence even on reuse. Green at base is charged regression evidence; red at base is base-red. A full fix round carries findings and experiments, failing lane directories, base comparisons, notes and remaining allowance/cap state. Ordinary certification charges every fourth red by default; total attempt counting includes uncharged work too.

Integration publication queues a background push to `origin` after every successful `integration.ff` (units, repair batches, docs revisions and close-out). It shares `forge/push.ts` with `roadmap pr --repo <path> --arc <arc>`: user environment for credentials, explicit lease, remote tip must be an ancestor, never `main`, already-current is a no-op. No root/manual branch push is needed to trigger CI for external witnesses. Attempts have a five-minute network deadline and do not hold scheduler stages; normal shutdown joins queued attempts. Startup publishes the current integration head to recover a crash between ff and push, including a crash after the remote accepted but before the result was recorded.

`integration-push` facts retain branch, attempted head, result, git error and explicitly settled notice ids. `push-failed` / `push-diverged` are non-blocking arc notices, once per failure episode. Later ff/startup retries failures; while divergent, it only checks ancestry until safe again or acknowledged by id, and never forces foreign history. A successful push (including up-to-date) settles the named push notices; an unrelated apply/resume does not. No `origin` produces one quiet fact, without notices or repeated noise. The root reviews errors or named acknowledgements and prepares the PR with `roadmap pr --repo <path> --arc <arc>`, whose push is normally a no-op.

An external witness is an arc lane with `witnessClass: external`. Submission attests to the integration head at command creation; stale head or changed file bytes refuse. A pass can latch a delivered future obligation; fail reopens its latest delivering lineage and supplies a kept note. URLs are recorded evidence references, not a claim that code has fetched or validated their contents.

Capture lanes have `kind: capture` and `capture:{up,script,states,port,portBase?}`. The port must be a declared lane resource, normally a pool. Executor leases a slot, binds the workload port, contains stack and script together, and requires every declared PNG state. Only related milestone design/member gates receive those captures. The summary's capture list currently projects suite capture spawns, not every spec capture artifact.

### Systems, memory and protected paths

Config `systemsMap` declares `{systems:{name:{paths,tests?,dependsOn?,traits?}},shared?,contracts?,docs?}`. Traits are `persistent|redacts`. Shared entries map paths to dependents; contracts map path to consuming systems; docs declares a docs class. Every revision records the map it read. Unit systems describe responsibility and lane/witness impact, not an exclusive file write envelope. Actual reach beyond them goes to the gate together with actual/builder-reported traits. Overlap is advisory. Central protectedPaths guards `.roadmap/` except `.roadmap/contracts/`, plus same-repo pinned corpus files at salvage/transient/recovery boundaries.

`systemNotesDir` defaults to `docs/systems`; existing `<system>.md` paths from the checkout commit are supplied as `systemNotes` to build/gate. Notes carry gotchas, seams and rigs. They are non-normative; claims live in the corpus. Note edits merge through a normal unit diff. Salvage/candidate commit bodies contain summaries and decisions from verified captured evidence, including clean builds whose changes were already committed.

### Obligations, vision, census and Phase 0

An obligation carries id/rev/statement/serves, anchor (`rule:{id,textSha256}` or docRef), witness/proof, deliveredBy, activation, contracts and state. Active future obligations name deliverers; must-hold ones protect existing behavior. Mapping is `{systems:[{system,obligations}]}`. States are active; split with children and null witness/proof; or waived/deferred/retired with `{reason,rev}`. Only the root authorizes dispositions. Statement/anchor/activation changes still pass weakening and frozen-contract checks. Keep no-drop split text and vision citations. Observation is code-derived: eligibility, latching, actual test records, environment evidence and external attestation determine held state.

Census gives each active rule one state: obligation with id, out-of-slice, untestable or prod-only. A split family is represented by its parent. The Phase-0 record contains structural/fact-currency curation, reversible semantic corpus divergences, ranked P-n questions with exact answers, dispositions for every open baseline debt item, and slice advances/why. No runtime fact should be hand-authored to simulate a review or witness.

Phase 0 refuses schema/plan-invalid, uncommitted inputs, invalid chains (with corpus drift checked against the supplied baseline), dropped obligations, missing lane cwd and missing spec intent/nonGoals. Advisory rows include system-overlap, milestone-unit-before-design, vacuous-future-witness and spanning-proof. Existing future witness files indicate possible vacuity; the baseline run still determines whether the witness already passes. Multi-unit delivery advises unless its candidate/batch lane covers every delivering system (an undeclared lane systems list spans the whole tree). These rows never change the exit code.

### Resources, environments and derived output

Tool commands are `{argv,cwd,env}`. Resource declarations have name, probe, teardown and optional pool size. Probe exits: 0 free, 10 owned label, 11 foreign/unlabelled; others are faults. Pool slots bind `RESOURCE_INSTANCE_<NAME>`. Code reserves atomically with CPU before work and tears down before release; leftovers block their resource. Environments have probe and optional up/down/idleMinutes as a group, plus resources they power. Declare identity, lifecycle and labeling correctly before start. New spike resources in a later apply produce a refusal and owner request.

Derived entries hold sources, outputs and optional regenerate command. The lanes stage regenerates a touched entry in a clean checkout and compares output bytes. They grant no file exclusion. Evidence globs name disposable outputs; they cannot cover tracked unit-system files or protected paths. Ignored-output capture excludes secrets unless explicitly declared evidence.

## Roles and review

The routed backend roles are `build`, `verifier`, `packReview`, `experienceVerdict`, `campaignAudit`. Verifier modes are pre-build, gate, diagnosis; experience modes walk and compare share a role. Routing layers name classes per role seat. Build seats: low/med/high; verifier adds escalation; arc roles have arc. Classes are efficient/frontier/summit and judgment-only economy. Model ids belong only in config bindings, never the skill or plan's seat values.

Profiles are default and claude-only. Default uses Codex for eligible low/med builds, except M2 and design units; M1 and capture-only units remain eligible. M4 diagnosis falls back to Claude for the remaining builds. Claude builds have a frontier advisor. Judgments stay on Claude. High-risk builds use frontier. The profile recorded in the latest routing provenance is authoritative once a plan is in force. Starts and supervisor respawns retain it; repo config defaults select a profile only on the first start. A matching `start --profile` is accepted; a conflicting flag refuses before claim and names the recorded profile. Change the profile mid-arc through an ordinary routing apply, with effective routing revisions retained in historical records. `start.json` is a startup snapshot, not a profile override.

M1 detects persistent/redacts traits at dispatch and actual reach/touches at gate. M2 detects an active delivered obligation with missing witness/ids/lane, later cadence, or environment-backed proof. External class alone is not an M2 trigger. M3 detects edited/disposed/split linked obligations and changed/retired cited corpus text. `review: always|never` is a root override. Pre-build calls annotate; their standing items require evidence-backed addressed/rebutted answers at gate. Diagnosis begins at 8 builds or 20 judged attempts and supplies a note. Hard park is 16 builds or 40 judged attempts at a boundary, fixed in code; limits do not tune it. `review:never` suppresses the diagnosis call and its M4 fallback marker; attempt caps remain active.

Build output includes summary, blockers, experiments, grounding `{specWrong,touches}`, top-level `tooBig`, notes and final. Structured decisions are captured from `decisions.json`, not a build-output field. Verifier output uses the gate schema (decision/reasons/directives/findings/standing and certification details); diagnosis translates findings/reasons into a note. Settled findings cannot be re-raised without new evidence. Blocking findings need evidence. The defect enum classifies; it is not a mandatory reason for refusal. Gates review reach against intent/nonGoals; out-of-system paths alone are not a refusal.

Milestone experience verdict runs bring-up and journeys, classifies breaks vs deviations, and proposes polish units. Its comparison judges before/after changes. Breaks hold downstream work; bounded rounds eventually need the root. Campaign audit is one fresh whole-range judgment of invariants/vacuity/interactions/doc drift at milestone/request/final boundaries. Large diffs use bounded attachments and durable partial coverage. Requests go to the root; findings do not mutate obligations or inputs. A dismissal request carries dismisses:F-n and non-empty counterEvidence; it creates a finding-subject owner-request, never a dismissal fact. The root assesses it and invokes dismiss. If the finding settled while the audit ran, the request is informational and cannot re-block completion. Wire finding categories and coverage still carry `lens` names for classification, not independent scheduled seats.

## Files and authority

Authoring directory (outside product): plan, specs, ledger, obligations, corpus pin and Phase-0 record. Changes after start do nothing until exported CAS apply. Keep future work, approved compaction records and operator notes outside product too.

`.roadmap/` contains owner-managed config.json, corpus.md and vision.json; owner-managed contract docs in contracts/ that units edit in their own diffs; executor-rendered constraints.md, invariants.md and debt.md. Other top-level entries are refused as a legacy layout. The rules registry is a `json roadmap-rules` block; debt is `json roadmap-debt`. Do not edit executor-rendered files.

Config accepts routing `{profile?,seats?,classes?}`, chain `{k}`, walkthrough `{mcp}`, systemsMap, systemNotesDir. Routing seat overrides name classes; class bindings alone contain backend/model/effort triples. Unknown fields refuse. Config edits must be committed and reach the arc through its revision checks.

Corpus guide `.roadmap/corpus.md` contains prose and exactly one block:

```json roadmap-corpus
{"schema":"roadmap/corpus-guide-m4","source":{"kind":"same-repo","root":"docs/corpus"},"include":["**/*.md"],"vision":"vision.md"}
```

Sources are same-repo `{root}`, other-repo `{path,root}` (absolute checkout path), or checkout `{remote,root}`. Include/vision paths are under root. Example normative block:

````markdown
```rules
T-12: A booking never overlaps another booking of the same berth.
T-13: Cancelling a booking frees its berth immediately.
```
````

Walkthrough MCP config supplies installed stdio servers, with `{evidence}` and `{viewport}` substitutions. Every Claude build gets these servers regardless of milestone membership. Its bring-ups list member/design milestones plus the origin milestones of findings its spec `repairs` cites, once each in plan order, regardless of journey type. An empty bring-up list still gets the servers. Without `walkthrough.mcp`, builds get no servers and no new refusal. Codex builds have no MCP path. Acting judges keep their own tool rules; bootstrap still refuses browser journeys without `walkthrough.mcp`. Example:

```json
{"walkthrough":{"mcp":{"playwright":{"command":"playwright-mcp","args":["--headless","--isolated","--browser","chromium","--output-dir","{evidence}","--viewport-size","{viewport}"]}}}}
```

Use HTTP pages. Install tools and browser in the project's devcontainer; Phase 0 checks actual executable presence and MCP handshake.

The run dir is `<git-common-dir>/roadmap-runtime/<arc>/`. It holds start.json, events.jsonl, kept inputs, command incoming/receipt files, needs-user records/acks, evidence, invocations, heartbeat and watch.lease.json. Invocation dirs contain launch/exit/result records and stdout/stderr; evidence includes lane records and completed host metadata. Host state at `/var/tmp/roadmap/` holds locks, owner handshake, residual resources and supervisor logs. Repo-wide `<git-common-dir>/roadmap/` holds ack/answer logs and cloned corpus sources.

Only the executor writes runtime. The journal's intents/done/facts and immutable kept bytes are authoritative; refs/snapshots are verified projections. `refs/roadmap/<arc>` holds allowlisted records plus a hash manifest, not raw evidence. Product branches and candidate refs belong to the executor. Use your own work branch for corpus changes.

## Status, brief and watch

Full status includes supervision, run/owner/heartbeat, revision and routing provenance, units with active invocations and lane progress, waits/resources, backend parks, spend by role/class/model, findings, obligation observations, census, timings, milestones, demo and completion. Read evidence named by an item before choosing an intervention. TUI observations do not acquire authority or alter the journal.

Summary JSON fields are arc/state/planRev, supervision, progress, spend, milestones, caught, verdicts, captures, needsUser, waste, demo, completion. Spend separates estimated/unavailable calls, compares optional expectations and never stops work on USD. Milestone cost includes member/re-entry/polish units and walk/compare jobs; it is not an allocation of every arc-level cost. `caught.total = laneReds + gateRevisions + uniqueFindings`, with findings deduped by key and classified in byLens. It is not unique-catch attribution across seats. Captures currently lists suite capture spawn ids, not all retained screenshots.

Waste detectors report grinding, red-on-unit/green-on-base, low unique-catch lanes and repeated expensive suites from observed evidence. They raise replay-safe non-blocking items keyed by waste cause. They advise the root; no optimizer rewrites the plan.

The brief hashes the whole canonical payload into briefId and renders Markdown from it. Delta coverage is the last committed acknowledgement's `{arc,snapshotCommit,highWater}` vector. It includes slice, decisions/departures, curation, corpus divergences, debt, ranked questions/assumptions, pack notes, census, timings, PR and demo. Brief acknowledgement records coverage, advances the chain bound, and does not clear optionless runtime items. It never acknowledges blocking items.

Actionable watch streams new open needs-user items, relevant unit/arc transitions and fixed heartbeat check-ins.
Every transition and heartbeat carries `seq` and `openBlocking: [{id, reason}]`: all open blocking items, ascending
id, excluding acknowledged and superseded items. Read the digest on every wake and act on every item in it; a repeated
item can be a missed wake. Raw watch has no lease and streams all events.

Keep one actionable watch per arc with the default 30-minute heartbeat. Start or switch versions with
`watch --actionable --replace`; end with `watch --stop`. Never kill a watch by process pattern. A live holder refuses
another actionable watch with one `watch-busy` JSON line and exit 73; a dead holder is taken over silently. Replacement
and stop use PID/start/boot identity, SIGTERM, a 10-second wait, then SIGKILL and a 2-second wait; failure to stop throws.
`--stop` prints one `watch-stopped` line with state `stopped`, `stale` or `none` and optional pid, then exits 0.
`--stop` cannot be combined with stream options; `--replace` requires `--actionable`.

Full and summary status report `supervision: {state: 'live'|'stale'|'none', pid?, lastPollAt?, executorVersion?}`.
Live means the lease holder is alive; stale means its lease remains after death; none means no lease. The TUI shows
this on its status line, red when supervision is absent or stale, the run is active and a blocking item is open.
Before ending a turn while the arc runs, confirm `status --summary` shows supervision live. On every wake post at most
3 lines (progress, next step, oddities), read status and cited evidence, act and continue from the returned seq if restarting.
The root never patches the plugin or run directory. On supervisor crash-limit, report the cited stderr error/stack to
the owner and stop with reason owner; do not ack or restart around the defect.

## Refusals and recovery

Read the complete row/receipt. Fix the source, then retry the same canonical action.

| Evidence | Resolution |
|---|---|
| schema-version | Dev.32-and-earlier runtime is refused before claim/recovery. Use its original executor; start a fresh schema-2 arc. Never delete state to force adoption. |
| schema / plan-invalid / plan-defect | Correct actual typed input, references, witness reachability, intent/nonGoals or lane placement. Start checks all defects; later revisions refuse newly introduced defects and expose remaining ones as advisories. |
| tree-uncommitted | Commit the owner-managed corpus/config/vision bytes that validation compares to HEAD. |
| corpus-invalid / pin drift | Reconcile through the guide, commit, re-pin and refresh rule hashes/census. |
| chain-invalid | Inspect chain status, previous completion/head, baseline ancestry/allowed between-arc paths and acknowledgement bound. Foreign predecessor uses plan.previousHead without chain. |
| obligation-dropped / weakening / proof stale | Preserve the property or make an explicit root disposition/reason and re-derive its proof. A lane move alone does not weaken unchanged ids/files. |
| stale apply files | Export current inputs and reapply intended edits; do not edit export metadata. |
| owner/resource request | Obtain the actual decision and use its offered option/action; do not fabricate readiness. |
| parked backend | Fix auth/outage or wait for subscription availability, then explicitly resume that backend. No USD cap. |
| attempt-cap / spec wrong / too big | Read history/base comparisons; root revises spec/decomposition/lineage. Steering does not erase cap counts. |
| base-red / known defect / ordering | Repair the actual baseline/fix-unit dependency; ordering parks wake on the declared blockers' merges. |
| residue / ambiguous owner / log-corrupt | Inspect kept evidence and ownership. Use declared cleanup/recovery; never hand-edit runtime or claim another process dead without identity checks. |

Supervisor recovery takes exclusive ownership and verifies pid/start/boot identity. It restarts boundedly; repeated crashes require the owner. Runner reattachment waits for workload quiescence; adapters read terminal files afterward. Session containment excludes deliberate escape, while experimental cgroup containment needs a writable delegated subtree. Missing cgroup support is reported, not silently upgraded into a guarantee.

A boot hook can call resume-arc in the product repo. An input export works with executor down; queue the CAS edit with explicit repo/arc and restart to process it. For a completed arc's PR fix use a new validated lineage/arc as appropriate, never move integration by hand. GC preserves snapshots needed by briefs/chains while reclaiming eligible evidence.

## The operator log

Keep `<repo>/../roadmap-inputs/skill-feedback.md` outside product, one append-only entry per self-initiated intervention.
Routine Phase 0/start/PR/check-ins and following an item recommendation are not interventions. Always log arc-wide pause,
resume-all, backend resume, stop and close-admissions whoever requested it; include when the control ended. Entry ids count up; each heading
names UTC time, arc and action, followed by exactly one nonempty bullet for symptom, evidence, outcome and executor change.
Prefer measured failure patterns over habitual polling.

```operator-log
## OP-1 2026-11-01T06:00:00Z arc=cancel-texts lever=pause
- symptom: notice remained in its lane beyond the observed completion time with no new output.
- evidence: status shows notice running notice-unit; its evidence stdout has not changed since the last wake.
- outcome: paused notice and retained its evidence for inspection before choosing recovery.
- executor change: report stalled progress with the lane evidence and last activity time.
```

The checker recognizes note, witness, dismiss, sweep, resolve-edge, run-only and the four demo actions alongside the
other current controls. Keep actual intervention evidence for grading.

## Chaining

Before chaining, read chain status. A normal next plan names `chain:{previousArc,previousHead}`; the previous arc must be complete and its verified ref/head must match. The baseline is the previous head or permitted single-parent between-arc commit. Foreign-baseline first arcs instead name previousHead at the plan top level; no preceding schema-2 ref is required. Never combine the two forms. Keep future planning detail out of the always-loaded skill.

At completion let final witnesses/audit, batch lanes, close-out documents and snapshots settle. Completion can be active or sealed. P1 needs repair, code-owned not-reproduced dismissal, or root `dismiss F-n --counter-evidence "<line>"`. Dismissal is a durable `finding-dismissed` fact with root role/routingRev, folded as ruled/dismissed. It stops finding gates and status blockers and suppresses the same key on unchanged cited blobs. A fresh command against a closed finding refuses; replay of the same command is idempotent. Finding-subject requests close when all their named findings settle; unrelated arc items remain open. A root apply that supplies repairs for every finding named by a finding-subject request closes that request without dismissing the findings; repair publication still settles them. Successful root actions can also close already-settled finding requests. Close-out can bank substantive remaining P2 debt and release eligible lower findings. Prepare the stacked PR, present the canonical brief/demo/rough edges, and stop or choose another slice within the owner's bound.

Candidate red parks retain the cause, RUN/REUSED grading records and original evidence. Read that diagnosis before revising the work.

Certified journey reuse must cover all current witness test IDs; changed IDs absent from the record rerun the lane. Candidate diagnoses say RUN or REUSED and point to the original record.

Builders add decisions and may revise text they authored last. Root-edited decisions remain authoritative; differing builder proposals are retained as departure notes for the gate.
