# P2 report

Implemented system scope over P1 and P3d. Removed STATUS_LOCK, its reader, CLI wrapper and single-flight test separately in `85b79c63`, retaining the audit's other changes.

Units require declared systems; specs require intent and nonGoals. Build and gate receive them. Systems carry closed persistent/redacts traits. Gate receives neutral reach, declared traits and actual-diff reachTraits. Phase 0 validates names and emits non-blocking system-overlap advisories. Obligation mapping, split children, admissions, deflakes and witness reachability use systems. Derived entries retain regeneration; file envelopes, scope growth, derived widening/exclusion and out-of-scope refusal are removed. Risk, routing, resource, evidence and transient-artifact guards remain.

A single protectedPaths definition supplies roadmap and pinned corpus protection to salvage, transient validation and recovery. Product writes beyond unit systems can merge.

Foreign-baseline start uses equivalent plan inputs: `baseline` and `previousHead`, mutually exclusive with chain. It validates the between-arc commit without a preceding release's arc ref. Fresh corpus-drift checks compare against the supplied baseline.

Verification: typecheck passes. The 210-file non-serial run reported 2,952 passes, 3 failures, 0 cancellations and 1 NOT RUN. Nine complete-file rechecks (brief, evals-m3, deflake-scope, phase0, foreign-baseline, system-scope, status, evals-m4a-harness, evals-m5) passed 91/91, resolving all three failures: 2,955 distinct cases pass, none remain failing. The status resource test now waits for lane launch before its unchanged assertions. Serial files ran individually: pipeline-matrix 363/363, concurrent-matrix 498/498, evals-m4a 23/23. The first M4a run had 21 passes and 2 failures; removing debug artifacts and updating its config oracle resolved both in the complete rerun. Commands from executor/: `npm run typecheck`; `node --test --test-concurrency=8 test/*.test.ts`; serial `node --test --test-concurrency=1 <file>`. Paid rungs, version bump and integrated documentation belong to the merged batch per the execution plan. Full npm test was not run. contain.cgroup-real is NOT RUN on this read-only cgroup host and is never counted as a pass.

The 43 removed cases below cover deliberately deleted features. Other assertions were retained and migrated to systems. Eight new cases cover required fields, reach/traits, protection, out-of-system publication, advisory overlap, foreign baselines and eval tamper detection.

## Removed test cases

- `status.test.ts / status.single-flight` — deliberately deleted status locking.
- `scope-growth.test.ts / scope.resume-unit` — deleted scope-growth hold/resume lifecycle.
- `scope-growth.test.ts / scope.resume-all` — deleted scope-growth hold/resume lifecycle.
- `scope-growth.test.ts / scope.accept` — deleted accepting verified scope growth as a ruled revision and re-pinning before build.
- `scope-growth.test.ts / scope.reject` — deleted rejecting scope growth and releasing its hold without a revision.
- `scope-growth.test.ts / scope.hold-before-patch` — deleted scope-growth holds taking precedence over redirect-patch validation.
- `scope-growth.test.ts / scope.reverted-visible` — deleted out-of-scope reverts being carried to the gate and fix round.
- `scope-growth.test.ts / scope.references-row` — deleted the advisory scan for references outside file scopes.
- `scope-growth.test.ts / scope.revert-repeat-holds (plan defects, 2026-10-16)` — deleted holding after repeated out-of-scope reverts and restoring files after scope acceptance.
- `scope-growth.test.ts / scope.derived-outputs (plan defects, 2026-10-16)` — deleted widening dispatch scope from derived sources to outputs.
- `scope-growth.test.ts / scope.salvage-transient (field report 2026-10-24)` — deleted chargeable salvage refusal of committed out-of-scope paths.
- `scope-growth.test.ts / scope.derived-excluded (regenerate=false)` — deleted generated-output exclusion when the source is outside scope.
- `scope-growth.test.ts / scope.derived-excluded (regenerate=true)` — deleted generated-output exclusion when the source is outside scope.
- `scope-growth.test.ts / scope.accept-derived-field` — deleted scope-growth acceptance alongside an already merged broad-scoped unit.
- `scope-growth.test.ts / scope.excluded-growth (source=false)` — deleted changing derived exclusions when source/output scope grows.
- `scope-growth.test.ts / scope.excluded-growth (source=true)` — deleted changing derived exclusions when source/output scope grows.
- `scope-growth.test.ts / scope.broad-excluded-growth` — deleted preserving exclusions under broad scope-growth patterns.
- `scope-growth.test.ts / scope.accept-excluded-refused (explicit=false)` — deleted refusing growth into generated outputs without their sources.
- `scope-growth.test.ts / scope.accept-excluded-refused (explicit=true)` — deleted refusing growth into generated outputs without their sources.
- `dispatch.test.ts / dispatch.derived-exclusion` — deleted pinning generated-output exclusions on dispatch.
- `prepare.test.ts / prepare.envelope` — deleted refusing a re-entry outside the lineage file envelope.
- `prepare.test.ts / prepare.reentry-widened-envelope` — deleted allowing a re-entry with explicitly ruled envelope widening.
- `prepare.test.ts / prepare.envelope-narrower` — deleted pinning a narrowed lineage file envelope.
- `deflake-scope.test.ts / deflake-scope.unmapped` — deleted the deflake-unscoped refusal when file scope cannot be derived.
- `deflake-scope.test.ts / deflake-scope.gate` — deleted refusing executor-minted file scope overlapping the corpus.
- `deflake-scope.test.ts / deflake-scope.settled` — deleted historical broad deflake scopes blocking unrelated revisions.
- `phase0.test.ts / phase0.scope-overlaps-corpus` — deleted refusing declared file scope overlapping the pinned corpus.
- `prompts.test.ts / prompts.scope-growth` — deleted scope-growth proposals, reference-scan inputs and reverted-path scope inputs.
- `prompts.test.ts / prompts.derived-exclusion` — deleted rendering derived-output scope exclusions.
- `design.test.ts / design.unscoped-growth` — deleted holding a design for verified file-scope growth.
- `design.test.ts / design.derived-exclusion` — deleted derived exclusions in design scope checks.
- `revision.test.ts / apply.scope-growth-ruling` — deleted requiring a cited ruling naming exact file-scope growth patterns.
- `review.test.ts / review.reentry-scope-out` — deleted refusing approval carry when a narrowed file scope excludes the approved diff.
- `startup-checks.test.ts / plan-change-refused` — deleted refusing lane evidence globs that overlap the unit file scope.
- `apply.test.ts / classify.evidence-covers-scope: evidenceGlobs naming the unit's own paths are refused, the lane, entry and scope pattern named` — deleted the file-scope/evidence-glob overlap rule.
- `apply.test.ts / classify.evidence-covers-scope: a spec in force that breaks the rule (an older release's arc) stays readable; an edit not touching its unit applies` — deleted the file-scope/evidence-glob overlap rule.
- `apply.test.ts / classify.evidence-covers-scope: that in-flight unit's evidence edit applies once it fixes the entry, and is refused while it keeps it` — deleted the file-scope/evidence-glob overlap rule.
- `apply.test.ts / rev + 1 changing the spec's scope` — deleted scope-growth protocol or file-scope enforcement.
- `apply.test.ts / apply.reenter-envelope` — deleted requiring an apply reason to widen a lineage file envelope.
- `apply.test.ts / classify.reentry-widen-with-ruling` — deleted recording ruled lineage file-envelope widening.
- `apply.test.ts / classify.reentry-widen-without-reason-refused` — deleted refusing lineage file-envelope growth without an apply reason.
- `transitions.test.ts / plan-check scope-growth → hold` — deleted verified scope-growth hold.
- `transitions.test.ts / lanes scope-growth → hold` — deleted repeated-revert scope-growth hold.

## P2 audit fixes

The separate status-lock correction remains `85b79c63`: STATUS_LOCK, its reader, CLI single-flight wrapper and the single-flight test remain deleted. The other audit restorations are retained.

Restored `evidenceScopeConflicts` as an authoring guard in the spec module, the classifier's touched-unit rows, and fresh-start preflight. Evidence entries cannot match tracked paths belonging to the unit's systems (paths, tests, shared areas and contract consumers), or overlap the single `protectedPaths` definition. Tracked paths come from the integration tip, falling back to the baseline before the branch exists; protection also covers not-yet-created corpus include paths. Unchanged in-force specs remain readable, unrelated edits remain allowed, and a conflicting evidence edit must fix its entry. Restored the three classifier cases and startup `plan-change-refused`; added direct spec coverage of source, tests, shared/contract paths, corpus protection and allowed output/foreign-system carve-outs.

Restored polish coverage in both walkthrough validation and code admission: the proposal must include every system containing each milestone reference. Directory references use prefix-conservative pattern overlap with system paths/tests and shared/contract consumers. An unmapped reference refuses the proposal with an explicit request to declare its system in systemsMap; it is never silently ignored. Walk assertions and admission tests cover full coverage, missing systems and unmapped references. The walk-answer fixture now preserves the proposal's supplied systems, and its default map declares the fake product/design paths.

Restored row 13's non-blocking `derived-unregenerated{outputs,units}` advisory without file scope: a derived entry lacking a generator is advised for live units whose systems may intersect its sources or outputs. Unrelated entries, cut/superseded/settled units and entries with a generator produce no such advisory. Restored the original assertion and added source/output and cut-unit coverage. Split children must be a subset of the parent's systems, enforced by both `splitFaults` and the revision classifier, with tests at both layers. The mixed-system split fixture now declares both parent systems.

Added Phase-0-level checks for missing intent/nonGoals and undeclared mapping.systems, an actual foreign-baseline CLI start through the supervisor (with its plan recorded before a clean stop), explicit gate rendering assertions for traits/reachTraits, and the protected-path equivalent of approval-carry refusal. Restored the non-scope prepare, dispatch and deflake headers, including known-defect preparation, routing/session changes and judgment seats. All-system deflake minting remains accepted. No gate reach prompt wording was added.

The earlier removed-case list's three `classify.evidence-covers-scope` cases, startup `plan-change-refused`, and `review.reentry-scope-out` no longer represent deliberately deleted guard coverage: the first four are restored and the last is covered by `review.reentry-protected-path`. Walk coverage and derived-regeneration assertions are restored as well. No test was skipped, weakened or dropped by these audit fixes.
