# Skill feedback — roadmap-orchestrator

Defects and improvement asks for the ORCHESTRATOR itself (not the product). Carry
these back to the skill's repository; they are not product debt and never archive
with an arc. **Cleared 2026-07-29 of everything predating 0.8.6; cleared 2026-08-03
of everything resolved by 0.9.0 and the 0.10.0 combined-hardening branch** (see
"Resolved" below). Only the still-open remainder follows.

## Verify on the next run (not a defect — a pending confirmation)

- **Preview porcelain fix under conductor persist dirt.** The 0.10.0 paid cycle caught the
  new dirty-primary check refusing on the conductor's own `.roadmap/` artifacts (waves 2–3
  preview dead; all structural probes still passed). Fixed with `':(exclude).roadmap'`
  scoping, regression-pinned in sims, and probe-validated against the real failed state —
  but not yet confirmed by a clean multi-wave paid run. **On the next conductor run (fixture
  or real arc): check `state.json` for `preview.status: "live"` on waves ≥ 2, zero
  `preview-failed` degradations, and no owed explorer/design markers.** If it recurs, the
  degradation entry carries the exact porcelain output — diagnose from that, not the network.

## Deferred from 0.11.0 (the codex-executor batch) — revisit with evidence from real arcs

- **`codexScope: 'plan+implement'`**: let a read-only codex phase draft the unit plan too
  (feeding the unchanged Claude plan-check), then resume the same session to build. The resume
  plumbing already exists; deferred so v1 keeps the Opus plan pass as the brief-authoring
  anchor. Worth a probe once a few real arcs show how often plans get redirected.
- **Generated per-worktree AGENTS.md**: standing constraints moved out of the brief into
  Codex's native instruction file. Deferred: the brief must carry the load-bearing guardrails
  anyway (a truncated AGENTS.md may not remove one), and an untracked AGENTS.md in the
  worktree pollutes porcelain/diff surfaces. Revisit only if codex demonstrably underweights
  in-prompt constraints on long runs.
- **Sonnet pre-gate filter**: a bounded four-category Sonnet review between verify and the
  exit gate, if real arcs show the gates carrying too much first-pass load. Deliberately
  absent in v1 — the standalone review stage was a spiral mechanism.
- **`notify` completion hook** instead of disk polling: writes to shared `$CODEX_HOME`
  config, which the orchestrator has no business mutating. Reconsider only if polling proves
  expensive.
- **`gateAuditRate` calibration**: 0.10 carried over; the design memo suggested ~0.25 while
  trust in the new executor builds. Tune on the per-tier `spend` evidence, not vibes.
- **Usage-limit pause/resume UX**: a `codex-usage-limit` return currently ends the run for a
  human relaunch; an auto-scheduled retry at the limit-window boundary would make it fully
  autonomous.

## Still open (value order)

1. **A living codebase primer as a wave-tail product** (method item 3). The health
   assessor reads the whole tip every boundary; its understanding evaporates into
   findings. Have it also maintain a distilled per-package map/idiom primer,
   threaded into every per-unit prompt beside the brief. (0.10.0's plan-evidence
   manifest covers the per-unit slice of this; the standing per-package primer is
   still unbuilt.)
2. **Per-wave Fable synthesis pass at the wave tail** (item 10b). Read the merged
   diff + reports + debt together and amend next-wave specs — the staff-engineer
   cadence that proved the most productive act of the last arc, still only
   available at arc end.
3. **Merge trains for the integration queue** (item 8). Serial merge with a full
   suite per unit remains the largest wall-clock cost; batch-validate, bisect on
   failure (Bors/Zuul shape). Deliberately deferred from 0.10.0 — its own design
   effort and paid cycle.
4. **A `mechanical` unit kind with recipe-grade specs and a cheaper implement
   tier** (item 9). Deferred from 0.10.0.
5. **Event-sourced state** (item 7). Largely defanged by 0.9.0's staged
   `<<<PART k/n>>>` persists + `write-failed` ledgering, but an append-only event
   log with state.json as a projection remains the principled fix — checkpoint
   size would stop scaling with arc size entirely.
6. **Cache-aligned preambles, full version** (item 4 — PARTIALLY shipped). 0.10.0
   shipped cross-script shared-const drift guards and prefix-aligned preambles on
   the new chain prompts only. The full restructure (byte-identical shared prefix
   on every per-wave prompt) was deliberately not attempted before a single paid
   validation cycle; it needs its own cycle with cache-hit measurement.

## Resolved (for the record — remove entries once shipped in a tagged release)

- **0.11.0 branch (codex executor)**: the review spiral, named and killed (pinned scope
  envelope, `diffFiles` growth signal, four-category capped gate policy, banking-by-default
  debt discipline); the standalone review stage removed; Codex CLI as the sole implementer
  with Haiku steering, chain sessions, resume-based fix rounds, hard-stop parking on
  unavailability/usage limits; Fable plan-checks for chains + med/high units with the taste
  charter; cross-model spec critique; per-unit `rounds` counters + fixture ceilings (the
  runaway-loop class is now measurable); plus two latent defects found by the paid cycle:
  the commit-probe quarantine reason filtered degradations by a dead label, and the
  `prefixCollision` merge fence fired on scratchpad reports with no `prefixUniqueGlobs`
  configured (a plain conflict quarantined before the resolver ran) — both fixed and
  sim-pinned.

- **0.9.0**: checkpoint-32k death class (staged verbatim writes + `write-failed`
  degradations); item 10c and beyond (correctness debt never banks through an
  approve; closed-set `bankReason`; in-unit debt-fix round; consolidated per-unit
  debt issues).
- **0.10.0 branch**: owed markers for skipped boundary jobs (the `design:w6`
  no-report class); preview dirty-primary diagnosis + `preview-failed` degradation;
  NOROADMAP made mechanical at merge (strip + contract-debt surfacing); numbered
  prefix uniqueness at merge + Phase-0 pre-allocation mandate; warm-lane chain
  batching (method 1, user-endorsed — one plan+implement call per strict chain,
  cold per-link gates intact); plan-evidence manifest (method 2); numbered rulings
  ledger mandate (arch 5); continuation-brief census (arch 6); implementer-pulled
  consults (10a, `specGap`); plus a latent-defect fix found during the work:
  crashed `running`/`merge-ready` units stranded on relaunch because the documented
  auto-adopt path was unreachable.
