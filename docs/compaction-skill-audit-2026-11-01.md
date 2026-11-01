# Estate-compaction failure audit

Evidence root: `/var/tmp/compaction-eval/2026-11-01T19-34-02-385Z-1064195/`.
Transcript references below are physical JSONL line numbers under that root. Products are under each stage's
`stage/roadmap-inputs/`. The original paid artifacts and summary remain unchanged.

| Failure | Classification | Transcript and product evidence | Change |
|---|---|---|---|
| Trial 1 B, K-9–K-13: curation lacks source or reason | (a) Source-path guidance under-specified | `1/b/application.jsonl:175` first writes empty `files`; line 187 changes them to `rulings.md` or `.roadmap/debt.md` plus `rulings.md`. The final `arc-next/phase0.json` has substantive reasons, but the external input `rulings.md` exists under neither the product nor its corpus root. | Teach nonempty existing corpus source paths, distinct from external input paths; name ledger/debt sources in `what`. Add an exact curation example. Grader unchanged for this criterion. |
| Trial 2 B, K-11–K-13: debt effects and explanatory rulings | (a) Provenance under-specified | `2/b/application.jsonl:203` authors C-42, C-43 and C-44 with B-2/B-6/B-11 and reasons, but no K-n. Final `arc-next/rulings.md:39`–41 matches those lines. The JSON dispositions correctly point at those C-n ids. | Require the referenced active C-n text to name both B-n and K-n, its reason and deliberate loss. Show the record, curation, disposition and ledger line together; repeat the link requirement in orchestrate Phase 0. Grader unchanged for these criteria. |
| Trial 2 A: noncontiguous K-n record | (a) Revocation handling under-specified | `2/a/architect-3.jsonl:42` removes K-2 and K-6 after the owner's record checks revoked them; line 57 explicitly reports the remaining gaps. Final `drafts/compaction.md:3` is K-1 and line 10 is K-3. The old instruction says to append one above the highest existing id, which the model did, but does not explain restoring contiguity after revocations. | State K-1, K-2, … without gaps, separate from proposal numbers. Rebuild an entirely unapplied draft after revocation, preserving the owner exchange. Record parser unchanged. |
| Trial 1 A, K-8: approval fidelity | (c) Grader misreads a compliant result | `1/a/architect-1.jsonl:210` proposes the backticked C-41 line for B-2/B-6. `1/a/owner-1.jsonl:20` explicitly approves “the C-41 wording as written” and separately says to record the loss instead of `"nothing"`. `1/a/architect-2.jsonl:50` writes that exact replacement and the accepted loss; final `drafts/compaction.md:50`–55 is identical. | Fix fidelity extraction to distinguish quoted loss commentary from replacement instructions, and a backticked ledger replacement from subsequent disposition JSON keys. Preserve exact approval/action/items/replacement requirements. Add saved-evidence regression coverage and negative cases for changed wording, removed approval and owner overrides. No skill approval change. |

The last finding complies with the existing skill's explicit-approval and exact-replacement requirements and
SCHEMAS.md's plain `C-n — <text>` ledger contract. The original grader treats every quote in the approval line
as replacement wording, so it demands `nothing` in Replacement. After that is corrected, its fallback also
treats the quoted JSON keys/values in the proposal's following disposition example as replacement wording.
The fix scopes extraction to the replacement, retaining the criterion. The unedited trial-1 A evidence now
passes every A criterion. Changed C-41 wording, withdrawn approval and different owner wording still fail.

No failure above is classified (b): trial 2's gap is created by a revocation case the old append rule did not
cover. Existing explicit approval guidance is sufficient for the compliant trial-1 A record and is left intact.

The skill stays self-contained at 124 lines. Its worked example and direct instructions follow the style of
the [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
and [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)
guides. No tests assert prompt prose. The README process description and both process diagrams reflect the
clarified Phase-0 provenance links.

## Cost and validation scope

Completed trials cost **$12.1604144** and **$15.9443578**. Three at those rates cost **$36.48–$47.83**:
`--cap 50` covers the observed upper rate; `--cap 60` leaves headroom for variation. The partial third trial
spent **$3.1547244** before the $30 cap stopped the run at **$31.2594966**, so it has no completed A/B grade.
Documentation caps remain unchanged.

Only free tests and checks are run for this change. The user's explicit instruction excludes rung 3's real
backend CLIs and all paid eval rungs, including the compaction eval triggered by these skill paths. The saved
trial evidence supplies regression coverage for the grader; it cannot establish real-model success on the new
skill. Version remains **1.0.0-dev.33**. No changes touch prompts, role parsers or `test/fakes/`.

Validation completed:

- Rung 1: `npm run typecheck` passed.
- Focused free run: `node --test test/evals-compaction*.test.ts test/phase0*.test.ts test/rulings.test.ts test/debt.test.ts test/corpus*.test.ts` passed all **123** tests.
- Rung 2: the full `npm test` passed **2,706** parallel-tier tests and **935** serial-tier tests, **3,641** passes and zero failures. `contain.cgroup-real` is **NOT RUN** because cgroup v2 is read-only on this host; it is not counted as a pass. Both real-browser checks passed without models.
- Skill frontmatter validation, both SVGs' XML parsing and `git diff --check` passed. The saved regression record and exchanges match the paid artifacts byte for byte.
- Rung 3 and paid rungs were not run, as explicitly instructed. The new skill's real-model effectiveness remains unmeasured.
