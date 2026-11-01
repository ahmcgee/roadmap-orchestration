# Compaction record

## K-1 retire
Items: T-8 "The PortLink SOAP bridge retries failed deliveries every ten minutes." and I-8.
Replacement: none
Gives up: the ten-minute PortLink retry demand.
Why: the previous arc removed the bridge, and src/ has no PortLink code.
Approved: 2026-11-01

## K-2 retire
Items: T-33 "Dispatch is allowed until 72 hours before the tide (working assumption P-1)." and I-33.
Replacement: none. T-72 "Dispatch is allowed until 48 hours before the tide." already holds the P-1 answer.
Gives up: the 72-hour cutoff, and the only obligation on any dispatch cutoff. Owner decision: no obligation on T-72 now; it stays prod-only.
Why: the owner's P-1 answer overrode this assumption.
Approved: 2026-11-01
- Application: repoint P-1 bears to T-72; rewrite the prose naming T-33 in docs/corpus/register.md, README.md and docs/last-check-in.md.

## K-3 merge
Items: T-3 "A berth booking identifier is unique across the register." and T-14 "No two entries in the register have the same berth booking identifier.", with I-3 and I-14.
Replacement: T-3, text unchanged. I-14 is removed.
Gives up: nothing.
Why: both rules state the same property.
Approved: 2026-11-01
- No-loss check: no identifier appears on two entries; insert in src/register.js enforces it. I-3 carries the property.

## K-4 merge
Items: T-27 "The export command refuses invalid dates." and I-27, into T-41 "Every command refuses invalid dates before reading or writing records."
Replacement: T-41, text unchanged. I-27 is removed.
Gives up: nothing.
Why: T-41 includes export and adds a stricter ordering.
Approved: 2026-11-01
- No-loss check: rule text only. I-41's named witness test does not exist in test/register.test.js and src/ has no date validation; I-41's witness must cover export.
- Application: rewrite the prose naming T-27 in docs/corpus/register.md, README.md and docs/last-check-in.md.

## K-5 retire
Items: T-62 "Internal local variable names use lower camel case." (prod-only)
Replacement: none
Gives up: the naming requirement for local variables.
Why: a style preference no vision clause depends on; the current code already complies.
Approved: 2026-11-01

## K-6 retire
Items: T-63 "The command must be implemented in executable program instructions." (prod-only)
Replacement: none
Gives up: only the literal statement, since any running CLI already satisfies it.
Why: it rules nothing out.
Approved: 2026-11-01

## K-7 retire
Items: I-52 "One internal comment is grammatical English." only. T-52 "Comment text is grammatical English." stays in the corpus.
Replacement: none. T-52's census state becomes prod-only.
Gives up: the must-hold obligation and its witness on comment grammar. T-52 still demands the property, unwitnessed.
Why: owner narrowed the proposed retirement to the obligation only.
Approved: 2026-11-01

## K-8 tighten
Items: T-49 "In order to ensure that the operator can rely on the output when things go wrong, every failed command, without exception, prints its diagnostic to stderr rather than to stdout." and I-49.
Replacement: T-49 "Every failed command prints its diagnostic to stderr, never stdout." The purpose clause moves to docs/corpus/register.md prose.
Gives up: nothing.
Why: same demand in fewer words, owner's wording.
Approved: 2026-11-01
- No-loss check: "Every" keeps "without exception"; "never stdout" keeps the stdout prohibition; cli.js writes failures to stderr only.
- Application: I-49 goes to rev 2 with the same text and needs a fresh proof judgment. The C-5 sidecar pins T-49's hash and must be refreshed.

## K-9 resolve
Items: B-2 "Remove the retry queue in the PortLink SOAP bridge."
Replacement: C-41 — B-2 is closed: the PortLink SOAP bridge and its retry queue no longer exist.
Gives up: nothing. No behavior is left unfixed.
Why: src/ has no bridge or retry queue, so the work is already done.
Approved: 2026-11-01

## K-10 resolve
Items: B-6 "Index reserve record lookup; B-1 already tracks the same index."
Replacement: C-42 — B-6 is closed as a duplicate of B-1.
Gives up: nothing. B-1 stays open.
Why: B-6 says it duplicates B-1.
Approved: 2026-11-01

## K-11 resolve
Items: B-11 "Align the success message punctuation with the help footer."
Replacement: C-45 — B-11 is closed: success output is the bare record id and no help footer exists.
Gives up: nothing. No behavior is left unfixed.
Why: neither thing it wants to align exists in cli.js.
Approved: 2026-11-01

## K-12 retire
Items: C-23 "The first release demo uses the blue harbour slide template."
Replacement: none
Gives up: the template requirement for that demo.
Why: the cut line says the previous release is complete, and nothing cites this entry.
Approved: 2026-11-01

## K-13 fold
Items: C-4 "The Quaybook archive is append-only; corrections add a new revision."
Replacement: T-? "The Quaybook archive is append-only; corrections add a new revision." C-4 is removed. Census state prod-only.
Gives up: nothing.
Why: a lasting truth belongs where workers can see it; the plain ledger never reaches them.
Approved: 2026-11-01
- No-loss check: text unchanged. src/ has no archive code, so the rule has no witness today.

## K-14 fold
Items: C-12 "A request token is accepted once; retries return the stored response." and C-17 "Retries with the same request token return the stored response without another mutation."
Replacement: T-? "A request token is accepted once; retries return the stored response without another mutation." C-12 and C-17 are removed. Census state prod-only.
Gives up: nothing.
Why: a lasting truth belongs where workers can see it; owner's wording.
Approved: 2026-11-01
- No-loss check: keeps one acceptance, the stored response on retry, and no second mutation. "Retries" means retries of that token, as C-12 already read. src/ has no token code, so the rule has no witness today.
- Application: remove only C-12 from cites.rulings in slips.json. C-38's citation stays. T-21 and I-21 do not change.
