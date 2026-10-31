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
