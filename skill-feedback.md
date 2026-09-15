# Skill feedback — roadmap-orchestrator

Defects and improvement asks for the ORCHESTRATOR itself (not the product). Carry these back to
the skill's repository; they are not product debt and never archive with an arc.

**ADDRESSED 2026-09-15 v0.16.0** (branch `fix/skill-feedback-2026-09-14`; RATIONALE §21 has the
reasoning), entry by entry against the 2026-09-14 list below:

- **Sandbox preflight** — SKILL.md's Phase-0 smoke now runs with the configured `codexSandbox`
  (default `danger-full-access`), in a scratch directory, and says what a pass-only-with-full-access
  means: the session must run in bypass-permissions mode, told to the user before dispatch. The
  per-wave probe already composed the flag this way; the Phase-0 text did not.
- **`pack-unreadable` on `\"`** — the per-backslash sentinel is gone. The read command rewrites
  every JSON escape **sequence** to its own marker (`\"` → `@q@`, `\\` → `@bs@`, `\n` → `@n@`,
  `\uXXXX` → `@uXXXX@`, …) and the script reverses it before the file's own `cksum` decides: the
  quote of a `\"` pair is inside its marker, and `\\\"` is two different markers, which are the
  two shapes the sentinel broke on. Base64, the suggested fix, was tried first and failed its first
  live run (a courier cannot transcribe 2 KB of high-entropy text — it diverged into repetition at
  1563 characters, twice). The per-sequence markers were probed on real Haiku couriers against a
  14 KB document carrying every escape form, three of three byte-identical, then proven on the
  paid harness fixture. `harness.test.mjs` §13 is re-pinned on the new shape, including the exact
  2026-09-14 document.
- **Expected non-zero exit** — both halves. The lane ledger carries `expectedExit`, the verifier
  grades each lane against it (0 when the clause states none) and never counts a failure that
  happened as specified as red; both gates read a matching lane as green. And a mirrored
  `EXIT_BAR` (harness: both plan-checks, verifier, both gates, closing round; conductor: both
  spec-writing tiers and spec-revise) says to write success as exit 0 — assert a required failure
  inside the command — or state a non-zero expectation explicitly. SKILL.md's Done-when rule says
  the same.
- **Gate round cap** — three brakes in code. Rounds after the first are handed the directives that
  gate issued and told they are re-checking them (a new observation is a directive only if it is a
  correctness defect; everything else banks). The frontier loop ends in a **closing round**
  (`gate:<id>#close`, schema approve/quarantine only) that rules on the last fix instead of
  quarantining work nobody read. A diff of ≥ `largeDiffFiles` (40) files gets `maxGateRoundsLarge`
  (3) rounds.
- **Contract-amendment routing** — the kind is decided in code: `kind:'contract'` only when the
  verifier reported `contractSurfaceTouched` or the report names a contract file; otherwise a major
  NON-contract item (consult and forced frontier gate still fire; the boundary weighs it; the root
  is not woken). `addDebt` refuses `kind:'contract'` from any report. Pending reports settle after
  the pre-gate review or when the unit's result lands — never dropped.
- **Flake band "no flips" over a dead target** — the band reports `exits` per run; a band whose
  every run exited non-zero is `unassessed`: flips emptied, job owed (re-runs next boundary),
  `flake-unassessed` degradation recorded.
- **Side work while the critical path is stalled** — `supersedes` now rides into the plan so a
  lineage can be walked; a quarantined unit whose lineage already holds a quarantine, with in-scope
  work still depending on it, returns **`critical-path-stalled`** to the root before any tier runs
  (`{stalled: [{id, lineage, dependents}]}`). SKILL.md says what to do with it.
- **Scope-growth on the adopted diff** — root cause: a tier-3 respec could not adopt the quarantined
  branch (the skeleton had no `existingBranch`), so it rebuilt from the tip, pulled the work in by
  hand, and every file read as growth. The skeleton carries `existingBranch` now, the Fable prompt
  says when to set it (`unit/<quarantined id>` when the work is sound), and the harness pins the
  diff at entry as scope exactly as for any adopted unit.
- **Explorer re-raises a known blocker** — the explorer brief lists the in-scope units that have not
  landed; a finding it attributes to one (`blockedBy`) is held out of the triaged findings in code
  (`explorer.heldFindings`), checked against the plan (an unknown or merged id holds nothing), until
  the unit lands.

Two more the fixtures surfaced while proving the batch, fixed on the same branch:

- **The smoke must execute a command.** codex exits 0 when its sandbox cannot start — the `bwrap`
  error is its final *message* — so the "reply pong" smoke (SKILL.md and the per-wave probe) passed
  on this box under a flag every real run would die under. Both smokes now make codex run `pwd`
  and the shell checks the answer; the probe names a sandbox failure as a host fact with its fix.
- **Archive dispositions.** The tier-2 triager also filed dispositions for the explorer/health
  renderings it read, and the archive composed `feedback/user/.roadmap/feedback/explorer/wave-2.md`
  from them (six `feedback-unmoved` rows). Only a census-listed file is a user note now.

Ladder, all on the final scripts: `evals/parse.sh` green; `evals/unit/run.sh` **416/416** (17 new
sims). **Harness fixture** `check.sh`: ALL CHECKS PASSED — 6/6 units in their expected end states,
0 degradations, `flake.exits` and `explorer.blockedBy` visible live. **Conductor fixture**
`check-conductor.sh`: ALL CHECKS PASSED twice — first run 3 waves / `max-waves` (the documented
WARN; each extra wave bought by one verified major correctness defect), which surfaced the two
defects above; fresh run on the final scripts 2 waves / `arc-complete`, 0 degradations. The base64
transport this record first shipped with failed its first live run and was replaced before the
fixtures were run (see the pack entry above).

---

# The 2026-09-14 list (arc issue-intake, waves 1–3)

- 2026-09-14 Phase 0: codex's bubblewrap sandbox cannot start in this devcontainer (`bwrap: setting up uid map: Permission denied`); every root-side codex call needs `-s danger-full-access`, which Claude Code's auto-mode classifier refuses. The arc requires bypass-permissions mode on this host. Worth a preflight check in SKILL.md: run the smoke with the configured `codexSandbox` value, not the CLI default.
- 2026-09-14 launch: `pack-unreadable` on a 12 KB plan.json whose only backslashes were two `\"` escapes inside a shell command string. The courier's copy came back with the `@bs@` sentinel doubled (`@bs@@bs@"`), so the reversal produced `\\"` and the cksum failed twice. Contrary to reference.md ("`\"` … travel intact"), JSON escapes do not reliably survive the courier; the workaround was a quote-free command. Suggest the pack reader base64-encode the file instead of a sentinel substitution.
- 2026-09-14 waves 1 and 3 (verifier cannot express an expected non-zero exit): the verify role reads every command in a spec's Done-when and requires exit 0 from all of them. A clause stating that a standalone `make images KIND_CLUSTERS=<missing cluster>` MUST exit 2 was run as a lane, exited 2 as specified, and quarantined `foundation-toolchain-and-kind` with "verification never passed" while its three real lanes were green. The respec `foundation-gate-close` reworded the clause ("a required failure", "the only three lanes") and was quarantined identically. No degradation row records it, so it reads as a unit failure. Suggest either an explicit expected-exit notation the verifier honours, or a SKILL.md rule that Done-when may only contain exit-0 commands (required failures are asserted inside a test script).
- 2026-09-14 wave 2 (gate round cap does not scale): `foundation-kind-toolchain` (adopted branch, 81 files, ~22.6k lines) was quarantined "architect gate did not converge" after two Opus gate rounds, each returning `revise` on disjoint, previously unexamined findings; every directive was implemented and all lanes were green at gate-verify#1, but no third gate ran. `maxGateRounds` is a flat 2 regardless of diff size, and the gate is not told to restrict round N to re-checking round N-1 directives. Suggest scaling rounds with diff size, or a rule that later rounds only verify earlier directives and bank new observations as debt.
- 2026-09-14 wave 3 (contract-amendment routing too coarse): the return reason was `contract-amendment` because an implementer filed `kind: contract` debt for a missing test assertion (ext_authz error/panic paths check status 500 but not the problem+json body). That is test debt, not a frozen-surface mismatch, yet it forced a root wake. The implementer's `contractMismatch` channel accepts any "the spec says X" disagreement; the conductor filter trusts the kind. Suggest classifying against the contract files actually touched before escalating.
- 2026-09-14 wave 3 (flake band reports "no flips" when nothing ran): all three `make verify` re-runs exited 2 because the integration tip had no `verify` target (the foundation had not merged), and the boundary block still reported `runs: 3, flips: []`. A band where every run fails identically on a missing target is unassessed, not clean; it should go `owed` or record a degradation.
- 2026-09-14 waves 1–3 (boundary drafts continue while the arc is blocked): with every product unit blocked behind the quarantined foundation, the health assessor drafted and tiers 1–3 admitted four fix-units against the 40-line `authz/model` (plus two more drafts at wave 3, one of which depends on a foundation file not yet present). Nothing detects that admitted drafts only touch already-merged, low-value areas while the critical path is stalled. Suggest the ladder route to root when the same blocking unit has quarantined twice, instead of minting side work.
- 2026-09-14 waves 1 and 3 (scope-growth on adopted branches): an adopted unit's pinned scope is "the diff at entry", yet `verify:foundation-gate-close#0` recorded scope-growth for 51 files that were the adopted diff itself. The degradation is noise on every adoption.
- 2026-09-14 waves 1–3 (explorer re-raises a known blocker): the runtime explorer reported the same `blocker` ("make estate-up: no rule") at waves 1 and 3 because the estate unit is blocked; each boundary had to dismiss it again. Findings already dismissed with a reason at a prior boundary could be suppressed at the same cause.
