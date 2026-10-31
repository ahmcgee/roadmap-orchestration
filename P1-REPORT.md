P1 is blocked and **not complete**. No push was made.

Implemented schema 2 and startup refusal of schema 1; removed upgrade defaults, rebase/owner bases, ruling commands/sidecar validation, propagation minting and status locking. Apply uses exported file CAS, reports stale files together and auto-bumps edited specs. Obligation authorization uses reasons and proofs bind test ids/files. Added automatic revision retries/notices, running-unit steering, notes delivered to build inputs, and centralized subject closure with option-only acknowledgement. Updated affected SCHEMAS sections.

Approximately 4,550 source lines were deleted (net reduction about 2,500). Removed historical-adoption, sidecar, propagation, vision-leak and start-base tests; 53 removed cells/suites were tracked, plus the replaced previous-release suite and deleted propagation file. Rewrote schema, CAS, obligation, revision and command fixtures. Added stale-file aggregation, auto-bump, reason weakening, proof lane-move, split-race notice, running-steer, note-delivery, subject-closure, ack-options and previous-schema cases.

Verification:

- Latest `npm run typecheck`, from executor: clean.
- Latest direct 14-file schema/spec/CAS/obligation/CLI/previous-schema run: **335 passed, 0 failed**, no skips/cancellations.
- Targeted split-race and running-steer runs: **1 passed each**.
- Earlier core integration run: **204 passed, 9 failed** (213 total).
- Earlier broad direct run: **569 passed, 76 failed, 1 cancelled** (646 total). It overlapped implementation edits; several child-process failures came from an import error subsequently fixed. These integration groups were not rerun after final fixes.
- New unprepared-reentry steering test: **1 failed** during its apply setup; needs diagnosis.
- Full `npm test` was not run. Serial pressure/eval verification remains outstanding.

Blocking conflict: `skill-lint.cli-forms` parses `plugins/roadmap-orchestrator/skills/orchestrate/reference.md`, which still documents deleted CLI forms and lacks the new forms. Updating that prose belongs to P4; weakening/skipping the test is prohibited. I stopped instead of bypassing it.

Reviewer follow-up: finish integration fixture migration and rerun affected files; diagnose the new re-entry test; audit corpus re-derivation so apply reasons authorize every intended weakening path. Stale-link diagnostics remain; propagation units do not. The existing inherited lineage risk guard remains, while lowering a Phase-0 floor uses apply's reason.


## P1 continuation

This section supersedes the earlier handoff's verification status and blocker. The skill CLI reference now matches schema 2: exported apply requires `--rev` and `--reason`, notes reach the next build round, steer accepts any unfinished unit, and acknowledgement requires offered options. The skill-lint test was not changed. CLAUDE.md was not changed; no push or full `npm test` was run.

The unprepared re-entry test named `u1/gate#2`, while the fixture's actual failed gate was attempt 9. It now derives the failure reference from the decided outcome and still asserts that steering prepares the new branch at the failed lineage's tip. The obligations test now explicitly re-derives the frozen contract after moving identical test IDs to another lane and after changing lane argv: neither edit is a weakening or `obligation-dropped`, and the proof remains valid.

Fixtures now export the current plan before edits and use revision CAS instead of stale-owner rebasing. Expectations deliberately changed by P1 were rewritten: startup ignores unapplied files; every edited spec auto-bumps (including evidence edits); removed report/record defaults fail loud; disposition and receipt provenance uses reasons/revisions; plain ledger edits do not patch contracts or mint sidecars; and successful subject actions close optionless items. Existing publication/crash, gate-dispute, scope, revision, re-entry and terminal assertions remain. No continuation test was skipped, weakened or dropped. The inherited cgroup-v2 read-only cell is **NOT RUN**, never a pass.

Production fixes found during verification: queued apply receipts retain their stage-boundary provenance after recovery; malformed journal JSON reaches the `log-corrupt` startup row; a re-entry apply closes the failed lineage's subject; supervisor-crash and refused-host-claim items offer an explicit `resolved` option so recovery remains possible under option-only acknowledgement; and the fold preserves the current optional certification-counter contract instead of allowing an omitted charged count to become `undefined`. Fake reports and replay fixtures were brought to the fresh schema, and the M2/M3 drivers now export/apply and observe subject closure instead of the deleted command forms.

Every test invocation below used direct `node --test --test-concurrency=8` (some exploratory runs also used `--test-name-pattern` and/or the TAP reporter). Counts are the completed run's own summary, not aggregate estimates. Intermediate failures are recorded to make the iteration auditable; final verification is listed separately below.

| Run log stem / scope | Tests | Pass | Fail | Cancelled | NOT RUN |
| --- | ---: | ---: | ---: | ---: | ---: |
| `steer-repro` | 1 | 0 | 1 | 0 | 0 |
| `steer-fix` | 1 | 1 | 0 | 0 | 0 |
| `skill` | 3 | 3 | 0 | 0 | 0 |
| `run9-repro` | 4 | 0 | 4 | 0 | 0 |
| `run9-fix` | 4 | 0 | 4 | 0 | 0 |
| `run9-fix2` | 4 | 0 | 4 | 0 | 0 |
| `run9-fix3` | 4 | 4 | 0 | 0 | 0 |
| `targeted-1` | 2888 | 2754 | 129 | 4 | 1 |
| `apply-fix1` | 10 | 8 | 2 | 0 | 0 |
| `integration-repro` | 7 | 0 | 7 | 0 | 0 |
| `deflake-scope-repro` | 4 | 2 | 2 | 0 | 0 |
| `compaction-repro` | 12 | 5 | 7 | 0 | 0 |
| `compaction-fix1` | 12 | 10 | 2 | 0 | 0 |
| `integration-fix1` | 14 | 14 | 0 | 0 | 0 |
| `prompts-repro` | 72 | 62 | 10 | 0 | 0 |
| `prompts-fix1` | 72 | 71 | 1 | 0 | 0 |
| `fixtures-fix1` | 49 | 47 | 2 | 0 | 0 |
| `prevented-fix1` | 1 | 1 | 0 | 0 | 0 |
| `edge-fix1` | 6 | 6 | 0 | 0 | 0 |
| `recheck-1` (46 files) | 816 | 814 | 2 | 0 | 0 |
| `closure-fix1` | 3 | 1 | 2 | 0 | 0 |
| `closure-fix2` | 3 | 2 | 1 | 0 | 0 |
| `closure-fix3` | 3 | 3 | 0 | 0 | 0 |
| `skill-fix2` | 3 | 3 | 0 | 0 | 0 |

`targeted-1` covered 197 affected non-serial files. `fixtures-fix1` covered compaction, M2, M3, executor and deflake; its two failures were the old literal compaction-ledger assertion and the prevented M3 scenario waiting for a trigger removed by the root cut. The corrected prevented scenario passed `prevented-fix1`. `edge-fix1` exercised captured-spec preservation, gate-dispute repair, pack-review subject closure and forbidden-plan edits. The two accidentally root-relative test commands found no test files: **0 tests invoked**, not passes.

Typecheck iterations 1–7 exited respectively **0, 2, 2, 2, 2, 2, 0**, with **0, 5, 5, 2, 4, 1, 0** TypeScript diagnostics. Later iterations corrected fixture types; final typecheck is recorded with final verification.

`recheck-1` completed all 46 files. After their failed assertions, the fault-job and teardown test processes retained live schedulers; they were terminated diagnostically, with both failures preserved in the runner summary above. The final rerun includes both complete files. `closure-fix1` caught an exclusive barrier-release cleanup error and the missing re-entered-lineage subject closure; `closure-fix2` caught a missing cleanup import. `closure-fix3` passed all three focused fault-job, teardown-control and re-entry checks. The re-entry test now explicitly asserts that apply closes the failed lineage's item. Typecheck iterations 8–10 each exited **0**, with **0 diagnostics**.


The 197-file topic-based set is reproducible from `plugins/roadmap-orchestrator/executor/` with the command below (197 files; serial files are not in this glob). Containment, evidence and worktree primitives were also run separately to backstop the schema cutover, for 200 distinct non-serial files overall. The remaining exclusions are unchanged pure helpers, host-sample and flow-statistics files.

```bash
node --test --test-concurrency=8 $(printf '%s\n' test/*.test.ts | rg -v '/(barrier|contain|crash|evidence|fakes-m2|flow-constraint|flow-spc|ignored|reap|sample|worktree)\.test\.ts$')
node --test --test-concurrency=8 test/contain.test.ts test/evidence.test.ts test/worktree.test.ts
```


### Final verification

**P1 continuation is complete.** All requested checks passed on the committed code. The exact final runs were:

| Run | Scope | Tests | Pass | Fail | Cancelled | NOT RUN |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `targeted-2` | 197 affected non-serial files | 2888 | 2887 | 0 | 0 | 1 |
| `record-writers` | 3 record-writer files | 37 | 37 | 0 | 0 | 0 |
| `upgrade-final` | serial upgrade alone | 1 | 1 | 0 | 0 | 0 |

The 200 distinct non-serial files contain **2,924 passes, 0 failures, 0 cancellations and 1 NOT RUN** overall. The NOT RUN cell is exclusively `contain.cgroup-real` on this read-only cgroup-v2 host; it is not counted as a pass. The full steering and obligations files passed, including the unprepared re-entry and identical-test-id lane-move assertions. The complete fault and scheduler files passed without diagnostic termination.

After those runs, `node --test --test-concurrency=8 test/serial/upgrade.test.ts` ran **alone** and passed its single loud-refusal cell. Its existing comment states that PREVIOUS_RELEASE will be re-pointed to the first post-break release once one exists. The following final `npm run typecheck` exited **0**, with **0 diagnostics**. `git diff --check` is clean. No full `npm test`, other serial suite, paid merged-batch eval or push was run. All changes are committed to `cc/p1-cutover` with the requested co-author trailer.

## P1 audit fixes

The second continuation restores coverage of behavior retained by schema 2. This section supersedes the earlier report's status-lock removal: the audit explicitly required restoring `STATUS_LOCK`, its schema reader, the CLI single-flight wrapper, and `status.single-flight` (live holder refused, dead holder replaced, lock released). Implementation commit: `67368d14`.

Restored the five non-sidecar M3 schema cells: vision rank/uniqueness/world/question rules; obligation split-parent/parent/deliverer/mapping/environment/lane refusals; malformed witness-record rules; and finding-key identity over lens, obligation and cause. Checkpoint answers again test required `corpusAmendments`, rule-anchored split children and exactly one non-null anchor. These are fresh schema-2 tests, with no upgrade adoption path.

Removed `legacyStringOrder`/`legacyKey`, issue intake/capture facts and amendment sources, checkpoint issue fields, `phase0Issues`/`issuesSha256`, issue-only findings/items, their fold and snapshot read-through, and empty compatibility scaffolding. The status-M4a and brief fixtures now write current facts. Canonical ordering remains covered at the fact level, including a list in neither historical nor canonical order. Added explicit schema-2 refusals for removed issue records/fields. The only two deleted cells cover the now-deleted issue finding lens (schema and attribution); mixed watcher and needs-user cells retain their remaining checks. Overall the audit adds 14 cells, deletes those 2 compatibility-only cells, and strengthens/renames 5 existing cells: **net +12 cells**.

Both docs publication behaviors still exist and are now exercised through plain-ledger `apply`: a red candidate aborts its revision before any docs ff, leaves integration unmoved, frees the slot, removes checkouts and writes nothing back; a docs publication preempts an in-flight candidate uncharged, journals `proc.kill` reason `preempt`, then the unit merges onto the docs head without another gate. The split-parent test again checks that removing its child without a reason is refused. The smoke race now advances a unit to gate approval while the smoke is blocked, and asserts that re-classification refuses the apply before commit, leaving the approved spec/revision in force. Parse-level apply/from/rev/reason/required-flag, note and acknowledgement-choice cases are restored; whether an item offers acknowledgement options is enforced by command execution.

All test invocations use direct `node --test --test-concurrency=8`, with complete files and no test-name filtering. No test was skipped or weakened. `CLAUDE.md` was not edited. No full `npm test`, paid rung, serial suite or push was run.

**P1 audit fixes are complete.** Counts below are each completed runner's exact summary; overlapping runs are not added together.

| Run | Complete files | Tests | Pass | Fail | Cancelled | Skipped / NOT RUN |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial schema run | 4 | 129 | 126 | 3 | 0 | 0 |
| Restored audit files | 8 | 305 | 305 | 0 | 0 | 0 |
| M4a schema refusal additions | 1 | 34 | 34 | 0 | 0 | 0 |
| Direct source coverage | 30 | 606 | 606 | 0 | 0 | 0 |
| Final schemas | 4 | 130 | 130 | 0 | 0 | 0 |

The initial schema failures were newly restored parse fixtures using an unsupported `--run-dir` locator. They now use the actual `--repo`/`--arc` locator and pass. Initial typecheck reported **2 diagnostics** (one stale test field access after deleting checkpoint issues; one local assertion helper referenced outside its scope); the next and final `npm run typecheck` both exited **0**, with **0 diagnostics**.

Final coverage spans **38 distinct complete files and 912 passing tests**, with **0 failures, 0 cancellations and 0 skips/NOT RUN**. This uses the final 130-cell schema run in place of the earlier 129 schema cells inside the 305-cell audit run: `305 - 129 + 130 + 606 = 912`. No contain/cgroup cell belongs to this targeted set. The command groups, from `plugins/roadmap-orchestrator/executor/`, were:

```bash
node --test --test-concurrency=8 test/m3-schemas.test.ts test/m4a-schemas.test.ts test/m4a-rev3-schemas.test.ts test/ids.test.ts test/revision.test.ts test/apply.test.ts test/publish.test.ts test/status.test.ts
node --test --test-concurrency=8 test/admits.test.ts test/amendments.test.ts test/brief.test.ts test/status-m4a.test.ts test/watch.test.ts test/records.test.ts test/log.test.ts test/state.test.ts test/plan.test.ts test/phase0.test.ts test/phase0-apply.test.ts test/snapshot.test.ts test/snapshot-closure.test.ts test/dev17-records.test.ts test/m2-schemas.test.ts test/m4b-schemas.test.ts test/dev13-schemas.test.ts test/cli.test.ts test/needsuser.test.ts test/inputs-export.test.ts test/obligations.test.ts test/witness.test.ts test/findings.test.ts test/spec.test.ts test/status-m3.test.ts test/status-rev3.test.ts test/milestones-plan.test.ts test/plan-defects.test.ts test/commands.test.ts test/prompts.test.ts
node --test --test-concurrency=8 test/m3-schemas.test.ts test/m4a-schemas.test.ts test/m4a-rev3-schemas.test.ts test/ids.test.ts
npm run typecheck
```

The one-file M4a run above used `node --test --test-concurrency=8 test/m4a-schemas.test.ts`. `git diff --check` is clean. All implementation and report changes are committed to `cc/p1-cutover` with the requested co-author trailer.
