# W3 ride-along implementation report

Worktree: `wt/ridealong`. Binding brief: `certify-unit-loop.md`, W3.
No versions, README, SVG process diagrams, paid evals or other checkouts changed.
Each item has its own commit. Final validation and corrected iteration failures are recorded below.

## Item 18: ordering parks (OP-62)

The operator-log diagnosis cannot be established from the supplied aggregate report.
`src/schedule/ready.ts` admits active units only after their effective `after` prerequisites
merge. The scheduler re-evaluates those waits automatically. The real-process regression
`test/blocker-wake.test.ts` confirms no dependent stage dispatches while its prerequisite
build is held, then both merge without resume or a checkpoint, with the dependent's first
intent after its blocker's snapshot outcome.

An **operator park** is different persisted state: its park record has no blocker-unit field.
`src/holistic/checkpoint.ts: designParkRoute` routes a design park to a checkpoint, a
respecification or an owner item; none of its variants records an ordering wait. Arbitrary
prose from a model's explanation cannot safely identify a prerequisite or prove that a
merge fixes the park. Automatically reopening all design parks after any merge would
invent that relationship and bypass unrelated design failures.

No speculative production wake rule was added. The closest faithful result is the explicit
dependency regression and this diagnosis. OP-62's unit/blocker identities and recorded
park/checkpoint decision are needed to reproduce the reported operator-park case and decide
which producer should record a structured wait. This information was requested while the
other items proceeded. Item 18's operator-park behavior remains unimplemented.

## Per-item result and touched files

Paths in this table are relative to `plugins/roadmap-orchestrator/executor/`.
`SCHEMAS.md` documents the new advisory, timeout records, audit readiness, resume semantics,
flaky outcome and supervisor evidence. No series ordering or build/lanes-loop restructuring.

| Item | Diagnosis and implementation | Production files | Tests added or extended |
| --- | --- | --- | --- |
| 4 | Ordinary candidates already call `runLaneSeries`/`reusablePass`. Pin reuse of the just-passed fast suite on a candidate with matching input. The aggregate report alone does not establish why its 8/19 candidates missed reuse; different IDs, normalised revisions, env.set, tools or input produce different keys. Existing topology tests explicitly establish intentional test-only pass reuse. No speculative production change. | None | `test/candidate-selection.test.ts` |
| 5 | Confirmed: `sameExecution` includes env.set, so those commands run separately. Share execution equality and add `lanes-differ-only-env-set` advisories in the common Phase-0/apply path, retaining separate execution identities. | `src/input/laneexecution.ts`, `src/phase0/rows.ts`, `src/pipeline/lanes.ts` | `test/phase0-apply.test.ts` |
| 9 | Not reproduced: scheduler `startMutations` queues while a scoped task runs; `interrupt` acts only on pause/stop. Add a lane-CPU-only edit classified busy at a running lanes boundary; existing real executor boundary/crash coverage passes. | None | `test/apply.test.ts` |
| 12 | Confirmed fixed six-hour deadline. Add validated optional fractional `timeoutMin`, retain it in the command launch, and produce runner cause/verdict `timeout` as a red lane. Keep red-lane protocol, pressure accounting, fix evidence and historical start reconstruction consistent. Missing limits preserve the old deadline and log a default, without changing older normalised hashes. The binding brief asks for timeoutMin only; the field report's separate repeat-output watchdog was not part of W3. | `src/core/records.ts`, `src/core/upgrade.ts`, `src/runner/runner.ts`, `src/pipeline/lanes.ts`, `src/pipeline/starved.ts`, `src/pipeline/rounds.ts`, `src/pipeline/stages.ts`, `src/git/snapshot.ts`, `src/flow/series.ts` | `test/lanes.test.ts`, `test/records.test.ts`, `test/fixtures/stage-common.ts`, `test/serial/upgrade.test.ts` |
| 13 | Confirmed: cadence ignored unmerged deliverers. Extract status's lineage-aware blocker calculation and use it in both status and `unwitnessedBy`. Retain exemption and latch assertions; add blocked/ready/re-blocked memo behavior using applied revisions. | `src/holistic/blocking.ts`, `src/holistic/cadence.ts`, `src/status.ts` | `test/audit.test.ts` |
| 14 | Already implemented: `stillBusy`, `busyHolds`, `redecides` and `builtOn` wait and activate the held bundle without a new call. Strengthen exact boundary-wait/settlement assertions. Stale fallback remains tested. | None | `test/checkpoint-rev3.test.ts` |
| 16 | Confirmed: only a rolling crash timestamp was durable except at the crash limit. Add `executor.<generation>.exit.json` for every reaped executor: exit code or signal, last stage, open attempts, explicit unreadable-journal diagnostics. Include the file in generation GC. | `src/supervisor.ts` | `test/supervisor.test.ts`, `test/gc.test.ts` |
| 17 | Confirmed: resuming a scope-growth hold cleared the hold without its blocking item. Acknowledge that item through the existing idempotent path before unit or arc-wide `resumed`, leaving scope unchanged. | `src/commands/apply.ts` | `test/scope-growth.test.ts` |
| 18 | Explicit `after` waits already wake on merge. Operator-park case remains unverified and unimplemented for the reasons above. | None | `test/blocker-wake.test.ts` |
| 22 | Confirmed: same-commit diagnostic red/green was lane.flaky but charged as stage red. Add explicit lanes outcome `flaky`, an uncharged fix round retaining both runs, directives and recovery behavior. Preserve pressure handling, deterministic reds, strict verification and historical charges. This does not forgive the flake or proceed directly to gate. | `src/core/events.ts`, `src/pipeline/stages.ts`, `src/pipeline/transitions.ts`, comments in `src/pipeline/lanes.ts` and `src/pipeline/deflake.ts` | `test/lanes-m2.test.ts`, `test/deflake.test.ts`, `test/transitions.test.ts` |

## Verification

All commands below ran from `plugins/roadmap-orchestrator/executor/`. Backends were PATH
shims; git, runners, supervisors and executor processes were real. No test was weakened,
deleted or marked skipped. Expectations changed only where the requested contract changed;
exemption, latching, strict verification and deterministic-red assertions remain covered.

Final successful targeted commands (counts are per invocation, including overlapping tests):

| Exact test command | Pass | Fail |
| --- | ---: | ---: |
| `node --test test/candidate-selection.test.ts test/lanes-topology.test.ts` | 14 | 0 |
| `node --test test/phase0-apply.test.ts test/lanes-suite.test.ts` | 27 | 0 |
| `node --test test/apply.test.ts test/apply-exec.test.ts` | 120 | 0 |
| `node --test test/lanes.test.ts test/records.test.ts test/adapter.test.ts test/runner.test.ts test/lanes-topology.test.ts test/lanes-suite.test.ts test/flow-series.test.ts test/snapshot.test.ts` | 212 | 0 |
| `node --test test/checkpoint-rev3.test.ts` (twice; second after stronger assertions) | 34 each | 0 |
| `node --test test/scope-growth.test.ts test/commands.test.ts` | 45 | 0 |
| `node --test test/lanes-m2.test.ts test/transitions.test.ts test/deflake.test.ts` | 29 | 0 |
| `node --test test/blocker-wake.test.ts` | 1 | 0 |
| `node --test test/supervisor.test.ts test/gc.test.ts` | 21 | 0 |
| `node --test test/audit.test.ts test/status.test.ts test/status-m3.test.ts test/status-rev3.test.ts` | 66 | 0 |
| `node --test test/serial/upgrade.test.ts` (final complete sweep) | 41 | 0 |

`npm run typecheck` passed with zero diagnostics after implementation and after the
upgrade assertions were updated. `git diff --check` passed. All final test invocations
reported zero failures, cancellations and skips. The full serial upgrade run passed
41/41 in 580.36 seconds, including adoption from PREVIOUS_RELEASE (dev.21) and the
older retained compatibility cells.

Earlier iteration results, all subsequently corrected and rerun:

| Exact test command | Pass | Fail | Correction |
| --- | ---: | ---: | --- |
| `node --test test/phase0-apply.test.ts test/lanes-suite.test.ts` | 3 | 24 | Wrong active-lane predicate in the new advisory; fixed it. |
| `node --test test/lanes.test.ts test/records.test.ts test/adapter.test.ts test/runner.test.ts` (first) | 161 | 1 | Fixture discarded timeoutMin; stopped the test workload and preserved the failure, then fixed fixture serialization and bounded the command. |
| Same command (second) | 161 | 1 | Fix-round red filtering omitted the new timeout verdict; switched to canonical isRed. |
| Same command (third) | 152 | 1 | An in-progress direct status import introduced an ESM cycle; factored blockers into their own module. |
| `node --test test/records.test.ts test/lanes-topology.test.ts test/lanes-suite.test.ts test/flow.test.ts test/snapshot.test.ts` | 94 | 3 | Same import cycle; also replaced the mistaken nonexistent flow.test.ts argument with flow-series.test.ts in the successful rerun. |
| `node --test test/audit.test.ts` | 36 | 4 | New revision fixture started with stale owner specs; use retained current spec bytes. |
| `node --test test/audit.test.ts test/status.test.ts` | 47 | 1 | Restore the pending deliverer before its real publication so the latch test still completes that deliverer. |
| `node --test test/supervisor.test.ts` | 10 | 1 | Terminal retire bookkeeping stays in the fold's open field; exclude completed units from open attempts and assert the actual last stage. |
| `node --test test/supervisor.test.ts test/gc.test.ts` | 20 | 1 | New crash test's extra smoke consumed its plan-check step; put each smoke at its generation boundary. |
| `node --test test/serial/upgrade.test.ts` (interrupted iteration) | 3 | 6 | Warning allowlist rejected lane.timeoutMin. One test cancelled when stopping the redundant failed sweep; the complete file is rerun. |
| `node --test test/serial/upgrade.test.ts` (complete intermediate sweep) | 40 | 1 | The legacy checkpoint warning was emitted once by each of the executor and new supervisor reader; assert exactly one in each log instead of one across both processes. |

Earlier `npm run typecheck` iterations caught the advisory predicate, an unnecessary kill-reason
map entry, a nullable snapshot verdict, and extra arguments to the test's openBlocking call;
all were corrected. The first serial upgrade attempt was stopped after repeated failures
because its exact warning allowlist rejected the new required lane.timeoutMin default. The
allowlist now admits that one kind and stop-mid-build explicitly requires its warning.
The subsequent complete sweep's only failure was the observer's additional once-per-process
checkpoint warning; that assertion now pins exactly one in each process log. The entire
file is rerun without filtering.

The full `npm test`, paid role/fixture/compaction evals and backend probe were not run.
The full suite and paid evaluation belong to the merged batch; no backend CLI invocation
or backend output parser changed here. The timeout directive and changed runtime paths
should be included in that batch's applicable evals.

## Remaining questions and merge notes

- Item 4: original lane definitions/spawn identities/input keys are needed to identify the
  historical 8/19 misses. This work verifies the current key's ordinary candidate path.
- Item 18: OP-62's unit/blocker identities and actual park/checkpoint records are needed.
  A safe automatic operator-park wake needs structured blocker provenance first.
- W1 should preserve the new `timeout` verdict and uncharged `lanes:flaky` outcome when
  sharing or reusing lane results in certification. Edits to lanes/stages/transitions are
  local; runLaneSeries and seriesOrder were not restructured.

## Commits

| Item | Commit |
| --- | --- |
| 4 | `ed8cb9b5` |
| 5 | `08ac3ba5` |
| 9 | `92f1c0fd` |
| 12 | `6ddd3bf2`, upgrade expectation `306fa4f5` |
| 13 | `f71d9489` |
| 14 | `fd9a55e6` |
| 16 | `f5374574`, per-reader upgrade assertion `3248bb9d` |
| 17 | `05bf0db9` |
| 18 | `feb3df74` |
| 22 | `69f780c2` |

Every work commit ends with the requested Codex co-author footer. This report is
committed separately after the item-scoped changes.
