# Compaction record

## K-1 retire
Items: T-8 and I-8, "The PortLink SOAP bridge retries failed deliveries every ten minutes."
Replacement: none. Remove I-8 from the mapping and census, and trim the bridge sentence from the register.md prose.
Gives up: the ten-minute delivery retry.
Why: the bridge is gone; no commit has "PortLink" in src or test, and I-8 cannot be witnessed.
Approved: 2026-11-01

## K-2 resolve
Items: B-2, "Remove the retry queue in the PortLink SOAP bridge."
Replacement: new ledger line `C-41 — The PortLink SOAP bridge and its retry queue were removed in arc-previous; B-2 has nothing left to remove.` Disposition `{"type":"resolve","ruling":"C-41"}`.
Gives up: nothing; no behavior is left unfixed.
Why: the product overtook this debt.
Approved: 2026-11-01

## K-3 retire
Items: T-33 and I-33, "Dispatch is allowed until 72 hours before the tide (working assumption P-1)."
Replacement: none. T-72, "Dispatch is allowed until 48 hours before the tide.", stays unchanged. P-1 stays answered and its `bears` moves from T-33 to T-72.
Gives up: the 72-hour cutoff, already overruled by the P-1 answer. This also removes the only obligation on dispatch, because T-72 is prod-only and the product has no dispatch code.
Why: T-33 and T-72 contradict each other.
Approved: 2026-11-01

## K-4 merge
Items: T-27 and I-27, "The export command refuses invalid dates." T-41 and I-41, "Every command refuses invalid dates before reading or writing records."
Replacement: T-41 and I-41 keep their text. Remove T-27 and I-27.
Gives up: nothing. No-loss check: "every command" includes export, and T-41 also sets the timing. The I-41 witness must include an export case, or this becomes a loss. The CLI has no date validation today, so T-41 is unmet with or without this merge.
Why: T-41 is strictly stronger.
Approved: 2026-11-01

## K-5 merge
Items: T-3 and I-3, "A berth booking identifier is unique across the register." T-14 and I-14, "No two entries in the register have the same berth booking identifier."
Replacement: T-3 and I-3 keep their text. Remove T-14 and I-14. Point the I-3 witness at test `I-20`, whose `/duplicate/` assertion covers this property, with a fresh proof judgment.
Gives up: nothing. No-loss check: the two rules state the same property.
Why: exact duplicate.
Approved: 2026-11-01

## K-6 tighten
Items: T-49 and I-49, "In order to ensure that the operator can rely on the output when things go wrong, every failed command, without exception, prints its diagnostic to stderr rather than to stdout."
Replacement: `T-49: Every failed command prints its diagnostic to stderr, never stdout.` I-49 takes the same text at rev 2 and needs a fresh proof judgment. Owner wording; no rationale prose is added.
Gives up: nothing. No-loss check: "every" carries "without exception", the stderr requirement stays, and "never stdout" is at least as strict as "rather than to stdout". The explanatory clause about operators relying on the output demanded nothing and is dropped.
Why: same demand in fewer words.
Approved: 2026-11-01

## K-7 retire
Items: I-52, "One internal comment is grammatical English."
Replacement: none. T-52, "Comment text is grammatical English.", stays with its text and id. Remove I-52 from the mapping. The T-52 census state changes from `obligation` to `untestable`.
Gives up: the separate test demanding grammatical English in one internal comment. T-52 stays active with no obligation, so no test covers it.
Why: owner narrowed the proposed retirement to the obligation only.
Approved: 2026-11-01

## K-8 retire
Items: T-62, "Internal local variable names use lower camel case." Prod-only with no obligation.
Replacement: none
Gives up: the naming requirement for local variables.
Why: serves neither vision clause, and no check enforces it.
Approved: 2026-11-01

## K-9 retire
Items: T-63, "The command must be implemented in executable program instructions." Prod-only with no obligation.
Replacement: none
Gives up: nothing in practice; a CLI that runs already satisfies it.
Why: it cannot fail, so it rules nothing out.
Approved: 2026-11-01

## K-10 retire
Items: C-23, "The first release demo uses the blue harbour slide template."
Replacement: none. The line leaves the ledger.
Gives up: the template instruction.
Why: the cut line says the previous release is complete, so this one-time instruction has expired; nothing cites it.
Approved: 2026-11-01

## K-11 fold
Items: C-4, "The Quaybook archive is append-only; corrections add a new revision."
Replacement: `T-?: The Quaybook archive is append-only; corrections add a new revision.` Census state `out-of-slice`. The C-4 line leaves the ledger.
Gives up: nothing. No-loss check: the text is unchanged, and nothing cites C-4. The product has no archive code and C-4 has no witness today.
Why: a standing truth belongs in the corpus; worker seats cannot see the ledger.
Approved: 2026-11-01

## K-12 resolve
Items: B-6, "Index reserve record lookup; B-1 already tracks the same index."
Replacement: new ledger line `C-42 — B-6 duplicates B-1, which tracks the reserve record lookup index.` Disposition `{"type":"resolve","ruling":"C-42"}`.
Gives up: nothing; B-1 stays open and covers the same work.
Why: the item itself says it is a duplicate.
Approved: 2026-11-01

## K-13 fold
Items: C-12, "A request token is accepted once; retries return the stored response." C-17, "Retries with the same request token return the stored response without another mutation."
Replacement: `T-?: A request token is accepted once; retries return the stored response without another mutation.` Owner wording; "retries" means retries of that same token. Census state `out-of-slice`. Both ledger lines go, and the C-12 citation leaves `cites.rulings` in slips.json, leaving C-38.
Gives up: nothing. No-loss check: single acceptance, the stored response and no second mutation all stay demanded, and the owner confirmed "retries" carries "with the same request token". The product has no token code and neither entry has a witness today.
Why: a standing truth belongs in the corpus, and the two entries overlap.
Approved: 2026-11-01

## K-14 resolve
Items: B-11, "Align the success message punctuation with the help footer."
Replacement: new ledger line `C-43 — The CLI has no help footer and prints a bare record id on success, so B-11 has nothing to align.` Disposition `{"type":"resolve","ruling":"C-43"}`.
Gives up: nothing; no behavior is left unfixed.
Why: one of the two things it aligns does not exist.
Approved: 2026-11-01
