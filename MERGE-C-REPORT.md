# Merge C report

Branch: `cc/merge-c`. Merge commit: `3550422e` (P3c into P1 + P3d + P2 + P3a + P3b). No push, paid eval, version bump, or P4 documentation change.

## Merge and adapters

Resolved the 63 conflicted paths, retaining the deletion on either side when its producer was retired. P3a's flow tree, prompts, roles, facts, ids and tests remain deleted; `src/flow/waste.ts` remains. P3c's retired seats/stages and scaffold eval remain deleted. The incoming M4a flow-loop named case remains deleted under Fable §8; its generic lane-integrity assertions remain in the ruler-criteria case. The inherited deletion inventories and their individual plan authorities are in [P3A-REPORT.md](P3A-REPORT.md) and [P3C-REPORT.md](P3C-REPORT.md).

Preserved P3b's lane inputs/cost/placement, milestone selection, candidate cadence and attribution, capture leasing/evidence, spike units and their retirement, external witness command, attempt markers and hard caps, and lane base comparisons. In particular:

- `diagnosisDue`, builder attempt notes and cap state consume `JournalView.attemptCounts`, including re-entry lineage. The separate P3c attempt stand-in is deleted.
- `laneFixRound` carries structured lane/base/result/evidence comparisons through live and recovered rounds into the builder's `<base_comparison>`. Original base evidence survives reuse. Base checks retain the spec/suite identity instead of being stamped unconditionally as suite runs. Candidate fix rounds also retain their verified green tip-alone directory and structured comparison; the existing fake builder must actually read both failing and passing output files.
- Experience and campaign results use P3a's `jobStageOutcome`: `{stage, job, milestone|null, verdict, findings:{P1,P2,P3,total}}`. Campaign milestone triggers carry their milestone; the fold refuses duplicate job/stage verdicts. The competing numeric-only recorder and projection are deleted.
- The run-only revision-notice closure test now performs root `apply`, verifies its command source, and seeds a pending revision notice against that command. Root commands intentionally do not auto-raise executor revision notices. Every original count, open-state, ordering, command/choice and closure assertion remains.
- Spike question text is retained in the new builder/gate renderers. Certification fixtures retain alternating distinct reds and all twelve-build, restart, allowance, charging and park assertions, with the M4 diagnosis and Claude fallback scripted.

The merge was committed only after `npm run typecheck` passed in the executor package.

## Residue removal

Removed the unwritten bundle/convergence/digest needs-user reasons and their readers, counters, folds, status and brief fields, close-out step-E remnants, `needs-user-declined`, `plan.limits.convergenceK`, and the obsolete implementer escalation fact/fold. Close-out finding debt and releases remain. M3 fixture closure reporting reads real subject closures without a retired-reason filter; the obsolete bundle-request summary and per-identity inventory reader are removed.

Removed docs-only facts, `DocsOnlySince`, their fold, and the unused carry-over lane path. Removed holistic audit cadence/lens/timer settings, `lensSetOf`, `--lens`, lens-selecting request fields, and cadence/unwitnessed/drift/wall-clock trigger variants. Whole-campaign milestone/request/final audits remain.

Removed `OpportunityId` and the permanently empty opportunity coverage/rendering path, checkpoint obligation authors and unit origins/admissions, and the redirect park outcome. Root obligation edits, split constraints, repair batching, divergence compensation, generic brief acknowledgement/coverage, and gate settled-finding refusal remain.

Schema-2 readers now require spawn-result pressure, audit diff budgets/refusals and gate finding fields without historical defaults or identity upgrade wrappers. Completed lane records require their census/host evidence; the writer's explicit pre-metadata read remains separate. The locked fault rerun reproduced a recovery regression: a lane interrupted during evidence capture was being read as completed history. History now waits for the writer's final durable `host.json` marker. Partial crash artifacts supply no reusable evidence; no missing metadata is defaulted into a completed record. Removed the TUI upgrade-default special case while retaining generic informational diagnostics. Corrected the listed stale comments and removed orphan declarations/imports exposed by the sweep.

Plan authority: Execution P1 requires “SCHEMA_VERSION 2 + no-compat startup refusal + delete upgrade.ts defaults the cut obsoletes”; Fable §1 requires “campaign audit ... replacing lens + checkpoint ... checkpoint BundleOp machinery deleted; root amends via apply --reason”; Fable §4 says “delete ... docsOnlySince (+ docs-only path and verifier role)”; Fable §8 says “Retire M4b flow loop ... keep host:cpu back-off as code”; Owner sign-off says “plan-check retired as a seat” and keeps the gate's re-raise refusal.

## Test changes and deletion inventory

Extended the existing fix-round runtime case with actual repeated lane reds, a green diffBase run, original failing/base evidence directories, structured comparison JSON, preserved builder notes and live cap/allowance assertions. Its existing gate findings and experiment assertions remain. This implements Fable §5: “findings + evidence, failing lane evidence, red-on-unit/green-on-base, notes, cap state”. Added a schema-2 refusal case for all five retired fact kinds.

Exactly four additional whole named cases were removed by this worker, together with their orphaned code:

| File | Removed case | Authority |
| --- | --- | --- |
| `test/m2-fold.test.ts` | `buildTier: the dispatch floor, raised to high by implementer-escalated and kept there` | Execution P1's schema-2/no-compat cut; the fact has no writer. User steps 2/4 explicitly require orphan code and its tests to go together. |
| `test/obligations.test.ts` | `vision.coverage-opportunity: an opportunity's unserved clause is listed apart, never as an advanced gap (paid M4b runs 3 and 5)` | Fable §1: “checkpoint BundleOp machinery deleted”; the opportunity admission producer and path are retired. |
| `test/brief.test.ts` | `brief.ack-nonblocking-only: an ack enqueues one ack per open non-blocking digest and convergence-bound item of a live arc, never a blocking item, another reason or a done arc's` | Fable §1: “campaign audit ... replacing lens + checkpoint ... checkpoint BundleOp machinery deleted”; these notification producers are retired. Generic brief delta, chain acknowledgement and crash/replay tests remain. |
| `test/fsx.test.ts` | `fsx.monotonic-never-decreases` | User step 4 explicitly authorizes orphan code/test cleanup. The surrounding plan cut is Execution P1: “no-compat ... delete ... defaults the cut obsoletes”; the plan does not separately name this helper. The standalone 0.x-derived counter has no production caller. The live `monotonicSince` guard and its regression tests remain. |

One generated pipeline crash cell keyed by `flow.series-before-completed` is also removed with its retired crashpoint (Fable §8: “Retire M4b flow loop”). The final whole-pipeline matrix therefore has **317** passing cases versus P3c's 318; all live crash-row assertions remain.

Mixed cases remove only retired-feature portions: implementer-escalation records; checkpoint split authority; digest binding/ack filtering and convergence counters; docs-only decline fields; opportunity ids/coverage; old audit selectors/triggers and the retired ruling/checkpoint `contractOpDocuments` accessor (Execution P1: “rulings → reasons”); flow brief fields and the retired flow crash label. Generic assertion logic is retained using live reasons and root repairs. The mixed serial M4a case drops only its `ruler-changed` flow-notice count/ack assertions (Fable §8: “Retire M4b flow loop”); its real root-revision-before-run-only-clear assertion remains, and the fixture no longer waits for the deleted writer. Retired M3 cadence/convergence fixture constants are removed. M4a also drops its unplayed arc-1 `audit-2` fake step: the retired flow revision no longer owes another audit (Fable §8: “Retire M4b flow loop”; §1 replaces lenses with one campaign audit). Every assertion that all remaining script steps play exactly once is retained. Legacy missing-census/default checks now assert schema-2 refusal. CLI lens acceptance and its still-documented reference expansion now assert refusal; P4 reference prose is deferred as requested. Status/fold golden shapes drop only deleted flow, convergence and digest fields. Routing retains the seat-count check for the current role set and adds an exact campaign-seat assertion. TUI diagnostics retain their rendering, deduplication, bounds and observer-isolation assertions with a current reader message. No retained case is skipped or has its timing bound increased.

## Sweep

The supplied sweep was run against the final source tree. Its only two `DEAD` exports are executable entrypoints outside its TypeScript caller roots: `installCli` is invoked by `bin/install-roadmap`; `main` is invoked by `bin/roadmap`. These are retained as live CLI entrypoints. Every other unused declaration and every fact without a writer was removed. Final native counts: **DEAD 2** (both justified entrypoints), **TEST-ONLY 30** (the seams below), **LOCAL-EXPORT 1081**, **NOWRITER 0**. There are no unresolved unused declarations or facts without writers.

The remaining test-only exports are existing regression seams, not new runtime switches:

| Exports | Why the existing tests need them |
| --- | --- |
| `adapt` | Runs the real adapter over durable invocation files to verify parsing and recovery. |
| `cgroupContainment`, `opMembers` | Drive the real containment implementation and inspect its process membership for cleanup assertions. The real cgroup host test is separately reported NOT RUN. |
| `flakyLedgerEntry` | Validates the flaky-ledger wire shape exercised by record tests. |
| `journeyIdOf`, `knownDefectIdOf`, `milestoneIdOf` | Checked ID constructors used by real test fixtures; the production ID readers share the same implementation. |
| `gateDiffShownOf`, `specKindOf`, `laneRevMatches` | Direct projections of live gate/spec/lane data used to assert the record and revision contracts. |
| `fold` | Replays fixture events through the actual journal fold, including refusal and crash invariants. |
| `reconcileOnce` | Drives one real demo keeper reconcile without launching its persistent service. |
| `manifestComplete`, `verifyManifest`, `mergeinCompleted`, `collectSnapshot` | Inspect actual git/evidence state in durability, tamper and recovery tests; they use the same readers/verifiers as live operations. |
| `batchable` | Asserts repair-batch eligibility beside the integrated `publishBatch` test, which publishes and retires the same units. |
| `splitCutReason` | Builds real root split proposals whose system/dependency/milestone conservation is checked by the classifier. |
| `milestonesOfUnit`, `activeKnownDefects` | Expose plan and readiness projections for deflake exemption and known-defect lineage assertions. |
| `raiseRisk`, `reserveNow`, `cancel` | Drive real dispatch and resource transitions in isolated fixtures; their assertions inspect durable journal and process/resource cleanup. |
| `ROLE_SCHEMAS`, `validateLensOutput`, `validatePolishJudgeOutput` | Schema catalogue and direct codec seams; campaign/experience codecs use the same underlying readers. |
| `DOCS_NOT_YET` | Existing fixture publisher implementing the production context interface for tests without document publication. |
| `ACTING_ROLES` | Asserts the closed routing seat catalogue against routing fixtures. |
| `document`, `coversReference` | Exercise the live JSON projection and milestone reference-coverage predicates at their pure boundaries. |

No new production test hook was introduced. The sweep was also checked with a local TypeScript 5 compiler while the tree was incomplete; the final native sweep is the reported result.

## Verification

Final full non-serial batch: **202 files, 2676 passed, 0 failed, 0 cancelled, 1 NOT RUN**, concurrency 4 under the shared lock. The NOT RUN is `contain.cgroup-real` (read-only cgroup v2), never counted as a pass. This fresh complete batch includes the unchanged real PTY case and supersedes the shared-host iteration.

Every serial file ran separately under the prescribed shared `flock`, at concurrency 1. Final results:

| Serial file | Passed |
| --- | ---: |
| `calibrate.test.ts` | 1 |
| `concurrent-matrix.test.ts` | 473 |
| `evals-m4a.test.ts` | 22 |
| `evals-m5-reflow.test.ts` | 1 |
| `pipeline-matrix.test.ts` | 317 |
| `pool-crash.test.ts` | 37 |
| `pressure.test.ts` | 1 |
| `probe-crash.test.ts` | 16 |
| `resource-recover.test.ts` | 62 |
| `roles-default-size.test.ts` | 1 |
| `upgrade.test.ts` | 1 |
| `walk-browser.test.ts` | 3 |

Serial total: **935 passed, 0 failed, 0 cancelled, 0 skipped** across all 12 files. Combined final verification: **3611 passed and 1 NOT RUN**, with no failures or cancellations. Extra focused/locked reruns below are not added to that total.

Final `npm run typecheck` and `git diff --check` passed. Verification logs and scratch tools were removed from the worktree.

The corrected affected-file batch passed **397/397**, and the unit/TUI batch passed **83/83**, both with no cancellations or skips. The final locked scheduler rerun passed **21/21**, and the final locked fault rerun passed **5/5**. The first locked fault run reproduced the recovery regression (4 passed / 1 failed) before its fix.

Exploratory failures are not final verification: the first full batch reported 2645 passes, 22 failures, 9 cancellations from failed fixture hooks, and cgroup-real NOT RUN; an early focused run used the incomplete schema migration and timed out in scheduler completion; it was superseded. Its locked scheduler rerun completed with two stale verdict-shape assertions, subsequently corrected. A temporary local-declaration cleanup error was caught by typecheck and restored; an M3 process that loaded that transient source restarted and exhausted its fake smoke replies. That exploratory driver was stopped, and its fixture change was reverted. Final complete verification above supersedes those iterations. Timing-bound failures are rerun under the shared lock before diagnosis.

The shared-host full verification reported a PTY redraw assertion failure while the crash matrix ran. Its complete locked TUI rerun passed **66/66**, without changing assertions or timing bounds. A fresh complete non-serial run under the lock supersedes the shared-host iteration (2675 passed / 1 failed / cgroup-real NOT RUN). The overlapping crash matrix reached its unchanged 45-minute parent deadline after 466 passes, with 7 cancellations and a teardown-hook failure; the hook killed its leftover processes. Its complete quiet locked rerun passed **473/473**, with the original 45-minute bound.

The first M4a serial run passed 20/22: both failures were the exact all-steps-played assertion identifying the same orphaned arc-1 `audit-2` fake call. Removing that retired flow-driven step changes no test assertion. The complete affected non-serial `fakes-m4a.test.ts` rerun passed **10/10**, and typecheck passed; the complete M4a locked rerun passed **22/22**, retaining the exact all-steps-played assertions and every live criterion.
