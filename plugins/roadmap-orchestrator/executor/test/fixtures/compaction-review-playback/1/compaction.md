## K-1 retire
Items: T-8: The PortLink SOAP bridge retries failed deliveries every ten minutes. I-8: same statement.
Replacement: none
Gives up: the ten-minute retry demand on a bridge that no longer exists
Why: the previous arc removed the bridge and src/ has no trace of it
Approved: 2026-11-01

## K-2 retire
Items: T-33: Dispatch is allowed until 72 hours before the tide (working assumption P-1). I-33: same statement.
Replacement: none. T-72 "Dispatch is allowed until 48 hours before the tide." stays; P-1 `bears` moves from T-33 to T-72.
Gives up: the 72-hour assumption and I-33, the only obligation on the dispatch cutoff; T-72 stays prod-only, so no test demands any cutoff
Why: the owner answered P-1 with 48 hours
Approved: 2026-11-01

## K-3 merge
Items: T-27: The export command refuses invalid dates. I-27: same statement. Into T-41: Every command refuses invalid dates before reading or writing records.
Replacement: T-41, text unchanged. I-41's witness gains test id I-27, with a fresh proof judgment.
Gives up: nothing; T-41 covers export and is stricter about timing
Why: T-27 is a narrower copy of T-41
Approved: 2026-11-01

## K-4 merge
Items: T-14: No two entries in the register have the same berth booking identifier. I-14: same statement. Into T-3: A berth booking identifier is unique across the register.
Replacement: T-3, text unchanged. I-3's witness gains test id I-14, with a fresh proof judgment.
Gives up: nothing; both rules ban the same state
Why: duplicates
Approved: 2026-11-01

## K-5 tighten
Items: T-49: In order to ensure that the operator can rely on the output when things go wrong, every failed command, without exception, prints its diagnostic to stderr rather than to stdout. I-49: same statement.
Replacement: T-49: Every failed command prints its diagnostic to stderr, never stdout. (owner wording) register.md prose gains: Failed commands keep diagnostics off stdout so the operator can rely on the output when things go wrong. I-49 takes the new statement at rev 2, with a fresh proof judgment.
Gives up: nothing; "Every" carries "without exception", "never stdout" carries "rather than to stdout", and the purpose moves to prose
Why: same demand in fewer words
Approved: 2026-11-01

## K-6 retire
Items: I-52: One internal comment is grammatical English.
Replacement: none. T-52 "Comment text is grammatical English." stays; its census state moves from I-52 to untestable.
Gives up: a separate test demanding grammatical English in one internal comment
Why: the owner kept the rule and dropped its separate test; every active rule needs a census state, and untestable is the state for principles
Approved: 2026-11-01

## K-7 retire
Items: T-62: Internal local variable names use lower camel case.
Replacement: none
Gives up: the naming demand; the code can drift from camel case without a rule catching it
Why: style with no effect on the operator, already prod-only
Approved: 2026-11-01

## K-8 retire
Items: T-63: The command must be implemented in executable program instructions.
Replacement: none
Gives up: nothing in practice; a command that runs already meets it
Why: it rules nothing out
Approved: 2026-11-01

## K-9 resolve
Items: B-2: Remove the retry queue in the PortLink SOAP bridge.
Replacement: C-41 — B-2 resolved by compaction K-9: the bridge is gone; retry-queue cleanup is given up.
Gives up: retry-queue cleanup in the removed bridge
Why: the bridge left the product in the previous arc
Approved: 2026-11-01

## K-10 resolve
Items: B-6: Index reserve record lookup; B-1 already tracks the same index.
Replacement: C-42 — B-6 resolved by compaction K-10: B-1 tracks the same reserve record-lookup index; nothing is given up.
Gives up: nothing; B-1 stays open and tracks the same index
Why: B-6 says itself that it duplicates B-1
Approved: 2026-11-01

## K-11 resolve
Items: B-11: Align the success message punctuation with the help footer.
Replacement: C-43 — B-11 resolved by compaction K-11: the product has no help footer and mutating commands print only the record id; the punctuation alignment is given up.
Gives up: the punctuation alignment; T-70 stays
Why: the CLI only has a usage error line, so there is nothing to align with
Approved: 2026-11-01

## K-12 retire
Items: C-23 — The first release demo uses the blue harbour slide template.
Replacement: none; the line is removed
Gives up: the slide template requirement for that demo
Why: nothing in the product or inputs depends on it, and the cut line says the previous release is complete
Approved: 2026-11-01

## K-13 fold
Items: C-4 — The Quaybook archive is append-only; corrections add a new revision.
Replacement: T-?: The Quaybook archive is append-only; corrections add a new revision. The C-4 line is removed; census state out-of-slice.
Gives up: nothing; the text is verbatim and C-4 had no witness to lose
Why: a standing truth per the check-in, and workers never see the ledger
Approved: 2026-11-01

## K-14 fold
Items: C-12 — A request token is accepted once; retries return the stored response. C-17 — Retries with the same request token return the stored response without another mutation.
Replacement: T-?: A request token is accepted once; retries return the stored response without another mutation. (owner wording) Both lines are removed; C-12 leaves slips.json cites.rulings, leaving ["C-38"]; census state out-of-slice.
Gives up: nothing; checked accepted once, retries return the stored response and no second mutation; "same request token" is carried by reading "retries" as retries of the token named in the first clause
Why: a standing truth per the check-in, workers never see the ledger, and the two entries overlap
Approved: 2026-11-01
