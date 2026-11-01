# Backlog

Reconciled for **1.0.0-dev.33**. These are deferred proposals and observations, not implemented contracts. Verify the
current source and reproduce the stated trigger before acting. Completed release history lives in git; runtime/input
contracts live in SCHEMAS.md. Work tied solely to removed producers is retired with those features.

## Command-center follow-up

- Calibrate diagnosis (8 builds/20 judged attempts) and hard-stop (16/40) thresholds from the first field arcs. They are
  fixed in code today, independent of limits. Add a verifier diagnosis role eval when real diagnoses provide cases.
- Restore lane time estimates only when scheduling or summary consumes them; estMin is not a current field.
- Evaluate a design-applied gate, polish-process improvements and token lint against field evidence.
- Measure mixed-profile M1 and UI units' rounds to green and M4 fallback rates; compare with Claude-built units.
  Default permits low/med Codex builds except M2/design; capture-only UI remains eligible. A profile share dial is deferred
  until the two profiles plus eligibility rule prove insufficient.
- Keep summary limitations explicit: caught is an activity aggregate, suite capture spawns are not all screenshots,
  and milestone cost does not allocate every arc-level cost. Add richer attribution only when a decision needs it.
- Compare the first Claude-only milestone's REPORT against the m5 baseline before changing acceptance strategy.
  External efficacy consumers must handle the job-verdict stage-outcome arm (job/milestone/verdict/findings).

## Field reliability and scheduling

- Azure-aks report items 10/19/20: cross-unit failure clustering, merge-fallout attribution and environment flapping.
  Trigger: repeated failures sharing a cause that current per-unit evidence obscures.
- Item 21: a missed numeric budget needs a verifier dev case before prompt changes. Item 23: a ready-made operator
  deflake unit is deferred until a known flaky lane needs manual admission. Item 4: explain candidate reruns from actual
  reuse keys; aggregate counts alone cannot establish their cause.
- Repeated output alone is not a hang (healthy Terraform repeats progress); add a causal signal before per-lane stall
  classification. A per-lane stallMin and backend stream progress watchdog remain possible improvements when fixed
  deadlines demonstrably waste work.
- Memory reservation as a capacity class, cgroup CPU enforcement, async git and persisted arbiter tickets remain
  proposals. Memory pressure already participates in admission backoff; it is not a per-workload memory reservation.
- Interrupted resource-wait history and exact post-recovery grant order remain incomplete. Trigger: fairness or a
  misleading wait report after cancellation/restart. Measure pool utilization before adding ranking policy.
- Retryable backend parks do not get the same six-hour escalation as unit parks/residues. Trigger: an outage lasts a
  working day unnoticed. Job no-verdict episode clocks restart with the executor; inspect a multi-restart incident.
- A failed sweep can leave an instance cleaning until another sweep. Trigger: real failed cleanup; consider handing the
  residue back to probing with explicit state. Residue compaction after GC may retain unreadable-arc pairs; measure index
  growth. GC retention of evidence cited by another repo on the same host needs a real multi-repo case.
- Write-deny paths exist at call start; later-created sibling paths and deliberate process escape are outside the
  current guarantee. Strengthen only with a reproduced boundary violation and suitable host support.
- cgroup containment remains experimental until the real test passes on writable delegated cgroup v2. Read-only-host
  NOT RUN is not evidence of containment. Week-long unattended reliability still needs field observation.

## Target, evidence and publication

- A rule introduced and then retired within one arc can lose history if each re-pin compares only the baseline registry.
  Trigger: same-arc id reuse or a later arc needing that retirement. Preserve high-water/retirement across pins.
- Milestone reference budget is checked per milestone; a unit in several milestones can receive their union. References
  may also grow after initial checking. Trigger: a context overflow despite every individual milestone passing the row.
- Bind additional judgment reads into approval identity when uncited contract reads matter. Current fingerprints bind
  cited contracts, not every file a judge happened to read. File-interface/design break pins need stale detection only
  after a real merge makes a recorded design premise wrong.
- External-state identity for cross-SHA lane reuse (toolchains, image digests, service state) needs richer keys when
  expensive environment runs dominate wall time. Shared execution of equivalent but non-identical suite/witness lanes
  needs evidence of material duplicate execution before adding complexity.
- More witness reporters and a real go-test-json capture remain useful when a target needs them. Test ids/files and proof
  judgments can still miss a distinction: add executed proof/mutant evaluation when a real vacuous witness escapes.
- Gate cited experiments are recorded, not verified against shell-call output. Trigger: an invented experiment in a
  transcript; consider matching argv/output to session evidence and refusing unsupported citations.
- Batch-lane culprit bisection is deferred: current evidence names lane/head and narrows suspects. Batch arc-witness
  cadence is not implemented; external-class attestation is the supported path for proof outside executor cadence.
- Repair batching follows the first blocking finding when detecting cycles. Trigger: approved owners still wait in a
  multi-blocker cycle; then batch the full blocker closure.
- Regeneration follow-up: expose touched generator commands before the first red, rerun regeneration on combined
  candidate outputs if independently consistent units merge inconsistently, and add cost/resources/reuse only when a
  generator is expensive enough to justify them.
- Snapshot closure retains revisions but not the whole incoming/receipt queue. Trigger: needing a rejected command's
  reasons after runtime GC. A stop can wait on a docs publication's lanes; measure a materially delayed stop.
- Richer debt/finding branch/head/time provenance is deferred until historical/current or declared/effective confusion
  affects a real decision. Rules may appear topically rather than numerically within fences; change presentation only
  when readability suffers.

## Experience and environment

- Arc lanes cannot declare environment: their witness/reproduction/smoke sites do not manage that lifecycle. Use external
  proof where appropriate; add direct environment support only for a real unmet need.
- Single-unit pause lets the environment idle clock expire rather than powering it off immediately. Up/down and probe
  timeouts are fixed (30 and 2 minutes); change only when a real environment needs it.
- Direct demo down without a live executor is deferred: the queued command waits for a future start. Trigger: owner needs
  to stop it between arcs. An on-request preview estate slot remains separate future work.
- Automatic PR review/CI ingestion is deferred. Root-mediated fixes and explicit external witnesses are supported;
  only add automatic proposed units after that path has field evidence.
- A pack critical-path advisory could combine DAG length and observed stage times; it should advise rather than refuse.
  Trigger: an avoidably serialized plan despite ample resources.
- A declared contract interface still triggers strong contract-change routing. Revisit only if measured escalation is
  redundant. A gate doing more executable vacuity work needs measured missed vacuity catches first.

## Evals and observation

- Role-eval live trial caps can undercount delegated tokens; between-trial caps and final reported usage are distinct.
  Improve streaming per-agent pricing before calling a live cap exact.
- Gate shell coverage counts named/read paths; a bulk diff can review more than the path metric recognizes. It remains
  informational. A plant read is not sufficient for a catch; revise grading only from a legitimate misgraded transcript.
- Keep holdout classes fresh after acceptance and avoid cross-trial evidence discovery. Trigger: another evidence-needle
  void. Run a clean-product experience check when fixture families change; prior fixtures contained real clean defects.
- Experience classification of CI log wording versus structural breaks needs another field example before sharpening
  prompts. Current evidence distinguishes breaks from deviations and tests false blocking.
- Bounded diff heuristics use path-based kind/package grouping and identifier substitutions. Revisit misleading labels,
  repetitive edits that fill the budget, or per-file process overhead only when a role eval/field run exposes the cost.
- A builder role eval should measure the gate's marginal value over lanes on meaningful traps/controls. Shared brief
  trimming already landed; further thinning needs quality evidence. Codex delegation awaits an unattended tool worth
  using; its current brief has no unsupported Agent-tool instructions.
- Add judgment elapsed-time signals if real calls overread and hit deadlines. A separate refutation pass is justified
  only by measured false blocking. Rate-limit stream pacing is deferred until a weekly-limit park shows avoidable work.
- Paid check-in shape grading remains less direct than the fake story. Trigger: another nudge after a malformed
  check-in. Answer delivery improvements must preserve the answer log as canonical.
- The paid M2 story does not exercise long-waiter promotion; free priority tests cover it. Add paid evidence when a field
  waiter crosses the promotion threshold. Host-load-sensitive CPU benchmarks need a calm-host reproduction before edits.

## Upgrade follow-up

Dev.33 deliberately refuses schema 1. For the next compatible release add the normal previous-schema-2 adoption run
while retaining the schema-1 refusal regression. Include backend parks, Claude-only routing, an already-launched lane,
and queued resume after a spec edit when those records change. Historical schema-1 aliases/default cleanup is complete;
no migration of refused runtime is promised.
