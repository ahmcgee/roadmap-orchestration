# Compaction record

## K-1 merge
Items: T-27 "The export command refuses invalid dates."; T-41 "Every command refuses invalid dates before reading or writing records."
Replacement: T-41 (id kept, text unchanged): "Every command refuses invalid dates before reading or writing records." Census: obligation. One new obligation anchored on T-41, lane `register`, whose witness runs the I-41 and I-27 tests; I-27 and I-41 are removed.
Gives up: nothing. T-41 covers export, and the new witness runs both originals' tests.
Why: T-41 implies T-27.
Approved: 2026-10-29

## K-2 merge
Items: T-3 "A berth booking identifier is unique across the register."; T-14 "No two entries in the register have the same berth booking identifier."
Replacement: T-3 (id kept, text unchanged): "A berth booking identifier is unique across the register." T-14 is deleted. Census: obligation. One new obligation anchored on T-3, lane `register`, whose witness runs the I-3 and I-14 tests; I-3 and I-14 are removed.
Gives up: nothing. T-14 restates T-3, and the new witness runs both originals' tests.
Why: one property stated twice.
Approved: 2026-10-29

## K-3 tighten
Items: T-49 "In order to ensure that the operator can rely on the output when things go wrong, every failed command, without exception, prints its diagnostic to stderr rather than to stdout."
Replacement: T-49: "Every failed command prints its diagnostic to stderr, never stdout." Add to the `docs/corpus/register.md` prose: "Failed commands write diagnostics to stderr so the operator can rely on stdout." Refresh `textSha256` on I-49 and on C-5's rule ref to T-49.
Gives up: nothing. "Without exception" is implied by "every"; the rationale moves to prose.
Why: rationale inside a rule line.
Approved: 2026-10-29

## K-4 retire
Items: T-8 "The PortLink SOAP bridge retries failed deliveries every ten minutes."; obligation I-8.
Replacement: none. Remove T-8, its census entry, and I-8.
Gives up: the retry demand on the PortLink SOAP bridge, which the previous arc removed with all its code.
Why: the product no longer has the bridge (fact-currency).
Approved: 2026-10-29

## K-5 retire
Items: T-33 "Dispatch is allowed until 72 hours before the tide (working assumption P-1)."; obligation I-33.
Replacement: none. Remove T-33, its census entry, and I-33.
Gives up: the 72-hour dispatch cutoff. P-1 was answered with 48 hours, which T-72 records.
Why: an answered working assumption that contradicts T-72 (fact-currency).
Approved: 2026-10-29

## K-6 retire
Items: obligation I-52 "One internal comment is grammatical English." (anchored on T-52 "Comment text is grammatical English.")
Replacement: none. Remove I-52 and its mapping entry; T-52 stays in the corpus unchanged, its census entry becomes prod-only.
Gives up: the witness demanding grammatical English in one internal comment. T-52 itself still holds, unwitnessed.
Why: an obligation witnessing a detail no failure would hinge on.
Approved: 2026-10-29

## K-7 retire
Items: T-62 "Internal local variable names use lower camel case."
Replacement: none. Remove T-62 and its census entry (prod-only, no obligation).
Gives up: the lower-camel-case convention for local variable names.
Why: cosmetic preference; the owner retires a claim still true (structural).
Approved: 2026-10-29

## K-8 retire
Items: T-63 "The command must be implemented in executable program instructions."
Replacement: none. Remove T-63 and its census entry (prod-only, no obligation).
Gives up: nothing any implementation could fail.
Why: true of any reasonable implementation; the owner retires a claim still true (structural).
Approved: 2026-10-29

## K-9 fold
Items: C-4 "The Quaybook archive is append-only; corrections add a new revision." (standing constraint, no obligations)
Replacement: T-86: "The Quaybook archive is append-only; corrections add a new revision." Census: prod-only. Rationale prose in `docs/corpus/register.md` cites C-4 and K-9. C-4 then leaves the ledger.
Gives up: nothing. Same text; C-4 was never witnessed.
Why: a lasting archive policy belongs in the corpus.
Approved: 2026-10-29

## K-10 retire
Items: C-23 "The first release demo uses the blue harbour slide template." (standing constraint, no obligations)
Replacement: none. Remove its ledger line and sidecar.
Gives up: the requirement that the first release demo use the blue harbour slide template.
Why: a one-off presentation detail nothing later depends on.
Approved: 2026-10-29

## K-11 fold
Items: C-12 "A request token is accepted once; retries return the stored response."; C-17 "Retries with the same request token return the stored response without another mutation." (both standing constraints, no obligations)
Replacement: T-87: "A request token is accepted once; retries return the stored response without another mutation." Census: prod-only. Rationale prose in `docs/corpus/register.md` cites C-12, C-17 and K-11. C-17 then leaves the ledger; C-12 stays while the carried `slips.json` cites it, and leaves once nothing names it.
Gives up: nothing. Accepted once, stored response on retry and no second mutation are all demanded; "retries" binds to the token as in C-12's own wording.
Why: two overlapping statements of a lasting token policy belong in the corpus as one rule.
Approved: 2026-10-29

## K-12 resolve
Items: B-2 "Remove the retry queue in the PortLink SOAP bridge."
Replacement: none
Gives up: nothing left to fix; the bridge and all its code were removed in the previous arc.
Why: obsolete.
Approved: 2026-10-29

## K-13 resolve
Items: B-6 "Index reserve record lookup; B-1 already tracks the same index."
Replacement: none. Duplicate of B-1, which survives.
Gives up: nothing; B-1 tracks the same index.
Why: duplicate.
Approved: 2026-10-29

## K-14 resolve
Items: B-11 "Align the success message punctuation with the help footer."
Replacement: none
Gives up: aligning success message punctuation with a help footer; the CLI has no help footer.
Why: obsolete and negligible.
Approved: 2026-10-29
