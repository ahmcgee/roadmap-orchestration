# Estate compaction record

## K-1 retire
Items: T-8 and I-8: The PortLink SOAP bridge retries failed deliveries every ten minutes.
Replacement: none
Gives up: the ten-minute delivery retry
Why: the PortLink bridge was removed; src/ and test/ no longer mention it
Approved: 2026-11-01

## K-2 retire
Items: T-33 and I-33: Dispatch is allowed until 72 hours before the tide (working assumption P-1).
Replacement: none; T-72 stays unchanged: Dispatch is allowed until 48 hours before the tide. P-1 bears moves from T-33 to T-72 with its recorded answer unchanged. Remove the register.md prose sentence "T-33 is the remaining old assumption."
Gives up: the 72-hour cutoff and the only obligation on any dispatch cutoff; T-72 stays prod-only
Why: the owner's P-1 answer replaced it
Approved: 2026-11-01

## K-3 retire
Items: T-27 and I-27: The export command refuses invalid dates.
Replacement: none; T-41 stays unchanged: Every command refuses invalid dates before reading or writing records. Remove the register.md prose sentence "T-27 is covered by T-41."
Gives up: nothing; T-41 covers export and is stricter. I-41's future test must include export
Why: it duplicates T-41
Approved: 2026-11-01

## K-4 merge
Items: T-3 and I-3: A berth booking identifier is unique across the register. T-14 and I-14: No two entries in the register have the same berth booking identifier.
Replacement: T-3 and I-3 with wording unchanged: A berth booking identifier is unique across the register. T-14 and I-14 retire.
Gives up: nothing; both demand one identifier per entry across the whole register
Why: same claim worded twice
Approved: 2026-11-01

## K-5 retire
Items: I-52: One internal comment is grammatical English.
Replacement: none; T-52 stays unchanged: Comment text is grammatical English. T-52's census state moves from obligation I-52 to untestable.
Gives up: the separate test demanding grammatical English in one internal comment
Why: owner narrowed the proposal to the obligation; the rule stays
Approved: 2026-11-01

## K-6 retire
Items: T-62 (prod-only): Internal local variable names use lower camel case.
Replacement: none
Gives up: the naming requirement; the current code complies, but nothing would hold future code to it
Why: a style preference with no bearing on either vision clause
Approved: 2026-11-01

## K-7 retire
Items: T-63 (prod-only): The command must be implemented in executable program instructions.
Replacement: none
Gives up: nothing
Why: any working command already meets it
Approved: 2026-11-01

## K-8 tighten
Items: T-49: In order to ensure that the operator can rely on the output when things go wrong, every failed command, without exception, prints its diagnostic to stderr rather than to stdout.
Replacement: T-49, same id: Every failed command prints its diagnostic to stderr, never stdout. Rationale prose in register.md: Operators rely on command output when things go wrong, so diagnostics stay off stdout. I-49 keeps its statement through Phase 0, which refuses a statement edit on an active obligation; shortening it to the same wording takes a post-start CAS apply, rev 2 and a fresh proof judgment.
Gives up: nothing; checked every failed command (covers without exception), stderr, and never stdout
Why: same meaning in fewer words; owner-written wording
Approved: 2026-11-01
