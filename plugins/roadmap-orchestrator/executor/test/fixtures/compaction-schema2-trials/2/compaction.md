# Estate compaction record

## K-1 retire
Items: T-8 "The PortLink SOAP bridge retries failed deliveries every ten minutes."; I-8 (same statement, active, must-hold)
Replacement: none
Gives up: The retry demand on the PortLink SOAP bridge. The bridge is gone: `src/` and `test/` have no trace of it.
Why: The previous arc removed the bridge.
Approved: 2026-11-01

## K-2 retire
Items: T-33 "Dispatch is allowed until 72 hours before the tide (working assumption P-1)."; I-33 (same statement, active, must-hold)
Replacement: none. T-72 "Dispatch is allowed until 48 hours before the tide." already records the answer to P-1. Application changes P-1 `bears` from T-33 to T-72 and removes the sentence "T-33 is the remaining old assumption." from the `register.md` prose.
Gives up: The 72-hour cutoff and the only obligation on dispatch timing. T-72 stays prod-only, so no test checks the 48-hour cutoff.
Why: The owner's P-1 answer replaced the assumption.
Approved: 2026-11-01

## K-3 merge
Items: T-3 "A berth booking identifier is unique across the register."; T-14 "No two entries in the register have the same berth booking identifier."; I-3 and I-14 (same statements, active, must-hold)
Replacement: T-3 "A berth booking identifier is unique across the register." (text unchanged). Remove T-14 and I-14. I-3 stays anchored to T-3, and its witness must be a real test that exercises the duplicate refusal.
Gives up: Nothing. Checked: both rules demand one identifier per register with cancelled entries included, and `insert` checks every row.
Why: The two rules state the same property.
Approved: 2026-11-01

## K-4 merge
Items: T-27 "The export command refuses invalid dates."; T-41 "Every command refuses invalid dates before reading or writing records."; I-27 and I-41 (same statements, active, must-hold)
Replacement: T-41 "Every command refuses invalid dates before reading or writing records." (text unchanged). Remove T-27 and I-27, and remove the sentence "T-27 is covered by T-41." from the `register.md` prose. I-41's witness must exercise export.
Gives up: Nothing. Checked: T-41 demands export's refusal of invalid dates and adds an ordering demand.
Why: T-41 fully covers T-27.
Approved: 2026-11-01

## K-5 tighten
Items: T-49 "In order to ensure that the operator can rely on the output when things go wrong, every failed command, without exception, prints its diagnostic to stderr rather than to stdout."; I-49 (same statement, active, must-hold)
Replacement: T-49 "Every failed command prints its diagnostic to stderr, never stdout." (owner wording, id kept). I-49 takes the same statement at rev 2 with a fresh proof judgment. No `register.md` prose addition (owner instruction).
Gives up: Nothing normative. Checked: every failed command without exception, stderr, and not stdout all remain. The dropped purpose clause demanded nothing on its own and moves nowhere.
Why: Same demands in fewer words.
Approved: 2026-11-01

## K-6 retire
Items: I-52 "One internal comment is grammatical English." (active, must-hold, anchored to T-52 "Comment text is grammatical English.")
Replacement: none for I-52. T-52 "Comment text is grammatical English." stays active with its text unchanged, and its census state moves from obligation I-52 to untestable, the state the orchestrate skill assigns to principles.
Gives up: Only the separate test demanding grammatical English in one internal comment (owner's stated limit).
Why: The owner keeps the rule but not the test.
Approved: 2026-11-01

## K-7 retire
Items: T-62 "Internal local variable names use lower camel case." (prod-only, no obligation)
Replacement: none
Gives up: The naming convention as a requirement. Current code conforms, but nothing holds it there.
Why: It is style, not target behaviour.
Approved: 2026-11-01

## K-8 retire
Items: T-63 "The command must be implemented in executable program instructions." (prod-only, no obligation)
Replacement: none
Gives up: Nothing observable. No working command can violate it.
Why: The rule is vacuous.
Approved: 2026-11-01

## K-9 fold
Items: C-4 "The Quaybook archive is append-only; corrections add a new revision."
Replacement: T-? "The Quaybook archive is append-only; corrections add a new revision." Census state out-of-slice. Remove C-4 from the ledger.
Gives up: Nothing. Checked: append-only and corrections as new revisions both remain, with the text unchanged. C-4 had no witness and no citations.
Why: Seats never see C-n text, so a standing truth belongs in the corpus.
Approved: 2026-11-01

## K-10 fold
Items: C-12 "A request token is accepted once; retries return the stored response."; C-17 "Retries with the same request token return the stored response without another mutation."
Replacement: T-? "A request token is accepted once; retries return the stored response without another mutation." (owner wording). Census state out-of-slice. Remove C-12 and C-17 from the ledger, and remove C-12 from `slips.json` `cites.rulings`, leaving C-38. Owner condition: removing the citation must not change T-21; flag it if it does.
Gives up: Nothing. Checked: accepted once, stored response on retry and no second mutation all remain. "With the same request token" is dropped because the first clause sets the subject, and a retry under a different token is a new request. T-21 check on a scratch copy of the approved set: the T-21 pin row, I-21 and T-21's census entry are identical, and `cites` is the only difference in `slips.json`.
Why: The entries overlap, and seats cannot read a standing policy held in the ledger.
Approved: 2026-11-01

## K-11 retire
Items: C-23 "The first release demo uses the blue harbour slide template."
Replacement: none
Gives up: The template choice for that demo. The cut line records the previous release as complete, and nothing cites C-23.
Why: Its one occasion has passed.
Approved: 2026-11-01

## K-12 resolve
Items: B-2 "Remove the retry queue in the PortLink SOAP bridge."
Replacement: none (owner instruction: no ledger entry). Disposition has no ruling to name. Scratch check refuses it: "phase0.debt[1].disposition.ruling: expected RulingId (C-<digits>), got nothing (field missing)". Returned to the owner.
Gives up: Nothing. The work is done, and `src/` and `test/` have no trace of the bridge.
Why: Obsolete.
Approved: 2026-11-01

## K-13 resolve
Items: B-6 "Index reserve record lookup; B-1 already tracks the same index."
Replacement: none (owner instruction: no ledger entry). B-1 stays open. Same refusal as K-12. Returned to the owner.
Gives up: Nothing. B-1 carries the same work.
Why: Duplicate of B-1.
Approved: 2026-11-01

## K-14 resolve
Items: B-11 "Align the success message punctuation with the help footer."
Replacement: none (owner instruction: no ledger entry). Same refusal as K-12. Returned to the owner.
Gives up: The alignment work. Any mismatch stays. Today a success prints only the id, and the code has no help footer.
Why: Negligible.
Approved: 2026-11-01
