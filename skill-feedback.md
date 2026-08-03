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
