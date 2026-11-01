## K-1 retire
Items: T-8 and I-8, "The PortLink SOAP bridge retries failed deliveries every ten minutes."
Replacement: none
Gives up: the retry requirement for the PortLink SOAP bridge, which no longer exists.
Why: `src` and `test` contain no PortLink code.
Approved: 2026-11-01

## K-2 retire
Items: T-33 and I-33, "Dispatch is allowed until 72 hours before the tide (working assumption P-1)."
Replacement: none. T-72 already holds the owner's answer, "Dispatch is allowed until 48 hours before the tide." P-1's `bears` changes from T-33 to T-72.
Gives up: the 72-hour cutoff and I-33, the only obligation on any dispatch cutoff. T-72 stays `prod-only`; the owner explicitly accepted an untested 48-hour cutoff.
Why: the owner's P-1 answer superseded this working assumption.
Approved: 2026-11-01

## K-3 merge
Items: T-27 and I-27, "The export command refuses invalid dates."; T-41 and I-41, "Every command refuses invalid dates before reading or writing records."
Replacement: T-41, text and id unchanged. I-27 is removed, and I-41's witness must exercise export.
Gives up: nothing; "every command" includes export.
Why: T-41 already demands all of T-27.
Approved: 2026-11-01

## K-4 merge
Items: T-3 and I-3, "A berth booking identifier is unique across the register."; T-14 and I-14, "No two entries in the register have the same berth booking identifier."
Replacement: T-3, "A berth booking identifier is unique across the register." I-14 is removed. I-3's witness moves to the existing test `I-20`, which asserts the duplicate refusal, with a fresh proof judgment.
Gives up: nothing; both rules state the same property.
Why: T-3 and T-14 are duplicates.
Approved: 2026-11-01

## K-5 retire
Items: I-52, "One internal comment is grammatical English."
Replacement: none. T-52, "Comment text is grammatical English.", stays active with text and id unchanged; its census state becomes `untestable`.
Gives up: the I-52 obligation and its witness. The T-52 rule is kept.
Why: the owner accepted losing the I-52 test, not the rule.
Approved: 2026-11-01

## K-6 retire
Items: T-62, "Internal local variable names use lower camel case."
Replacement: none
Gives up: required lower camel case for internal local variable names.
Why: it serves neither V-1 nor V-2.
Approved: 2026-11-01

## K-7 retire
Items: T-63, "The command must be implemented in executable program instructions."
Replacement: none
Gives up: nothing in practice; any working CLI satisfies it.
Why: the rule is vacuous.
Approved: 2026-11-01

## K-8 resolve
Items: B-2, "Remove the retry queue in the PortLink SOAP bridge."; B-6, "Index reserve record lookup; B-1 already tracks the same index."
Replacement: C-41 — B-2 and B-6 are closed: the PortLink bridge and its retry queue are gone, and B-1 tracks the index B-6 asks for.
Gives up: cleanup of the PortLink SOAP bridge retry queue (B-2), which the owner accepted. B-6 gives up no tracking; reserve lookup still scans the register and B-1 stays open.
Why: B-2 is obsolete and B-6 duplicates B-1.
Approved: 2026-11-01

## K-9 tighten
Items: T-49 and I-49, "In order to ensure that the operator can rely on the output when things go wrong, every failed command, without exception, prints its diagnostic to stderr rather than to stdout."
Replacement: T-49: "Every failed command prints its diagnostic to stderr, never stdout." The id stays. The purpose moves to prose: "Failure diagnostics stay off stdout so the operator can rely on it when things go wrong." I-49 goes to rev 2 with the same statement as T-49 and a fresh proof judgment.
Gives up: nothing; "every" covers "without exception", stderr stays, and "never stdout" covers "rather than to stdout".
Why: same meaning in fewer words, with the purpose moved to rationale.
Approved: 2026-11-01

## K-10 retire
Items: C-23, "The first release demo uses the blue harbour slide template."
Replacement: none
Gives up: the first demo slide template requirement, which the owner accepted.
Why: the requirement is not worth carrying in the ledger.
Approved: 2026-11-01

## K-11 fold
Items: C-4, "The Quaybook archive is append-only; corrections add a new revision."
Replacement: T-?: "The Quaybook archive is append-only; corrections add a new revision." The census state is `out-of-slice`. C-4 leaves the ledger.
Gives up: nothing; the text is unchanged.
Why: a lasting truth belongs in the normative corpus.
Approved: 2026-11-01

## K-12 resolve
Items: B-11, "Align the success message punctuation with the help footer."
Replacement: C-44 — B-11 is closed: the CLI has no help footer, and success prints only the record id.
Gives up: nothing, as accepted by the owner. Success output stays as it is.
Why: the footer the debt refers to does not exist.
Approved: 2026-11-01

## K-13 fold
Items: C-12, "A request token is accepted once; retries return the stored response."; C-17, "Retries with the same request token return the stored response without another mutation."
Replacement: T-?: "A request token is accepted once; retries return the stored response without another mutation." "Retries" means retries of that token. The census state is `out-of-slice`. C-12 and C-17 leave the ledger, and `slips.json` drops its C-12 cite.
Gives up: nothing; accepted once, stored response and no further mutation remain, and the owner confirmed "retries" means retries of that token.
Why: a lasting truth belongs in the normative corpus, and C-12 and C-17 overlap.
Approved: 2026-11-01
