Implemented P3(d) in `f5c3bcd4`.

Salvage commit bodies contain the captured build report summary and decisions.json decision text, including recorded rationale. Candidate messages concatenate the unit’s captured round summaries and decisions; repair batches include every member’s memory. Reports are included in the evidence snapshot, and message preparation reads verified snapshot bytes. Existing clean-worktree salvage behavior stays intact: candidates retain summaries even when the builder committed everything itself.

Added optional `.roadmap/config.json` `systemNotesDir` (default `docs/systems`). Build and gate inputs expose `systemNotes`, a sorted list of existing `<system>.md` paths at their checkout commit. The neutral `<system_notes>` slot carries paths only. Notes edits remain ordinary unit diffs.

Validation passed: `npm run typecheck`; `node --test` covering salvage, integrate, candidate, prompts, systemnotes, stages, unit, routing, and batch test files. Coverage includes ordered message content, changed live evidence, exact commit recreation after SIGKILL/object deletion, clean salvage, notes selection, and notes publication. No tests skipped, weakened, or dropped. No full suite, probe, or paid evals run; merged-batch verification remains separate.

Integration note: this checkout predates P2 and lacked `PlanUnit.systems`. Added a minimal optional parser/type slot for independent compilation; retain P2’s required systems field when merging. P4 owns central documentation and the version bump.

No push performed.
