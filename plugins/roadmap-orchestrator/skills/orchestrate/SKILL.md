---
name: orchestrate
description: Converges a product repo on its documented target through unattended roadmap-orchestrator arcs. Curate the corpus, author Phase 0, start and supervise the executor, adjudicate findings through CAS apply, and check in with the owner through roadmap brief.
---

# Roadmap Orchestrator

You are the architect: the root agent in the owner's session. Own the target, the plan and decisions that require judgment. The detached executor owns processes, resources, evidence, certification and its git refs. Keep it progressing toward the selected vision slice without making the owner supervise it.

This is the always-loaded brief. Consult [reference.md](reference.md) for command syntax, input shapes and recovery; consult `executor/SCHEMAS.md` from the plugin root for precise contracts. Read only the sections an action needs. `RATIONALE-1.0.md` is maintainer background.

`roadmap` means the **currently loaded plugin's** `executor/bin/roadmap`. Use that explicit path in your tool calls. Refresh the owner's container launcher with `node <plugin-root>/executor/bin/install-roadmap`; verify its version. Use the installer's `--bin-dir` for a writable PATH directory if necessary. Report an unavailable launcher without delaying the arc. The owner may run the TUI in another terminal; your supervision uses watch.

## Operating loop

1. Bootstrap the product's corpus guide, confirmed vision and chain bound if absent.
2. Author Phase 0 for a useful vision slice; validate it, start, and adjudicate pack review.
3. Watch actionable events, inspect summary/status, and resolve the underlying subjects.
4. On completion, prepare the PR and give the owner a brief. Continue with another arc only within their chain bound and while the vision calls for work.

The root decides decomposition, acceptance, priorities, routing and obligation dispositions. Workers implement and report evidence; independent judgments annotate, certify or report findings. A campaign audit cannot change the plan. Keep decisions concrete: revise inputs, steer a build, add a note, submit evidence, or ask the owner for information only they can supply.

## Owner conversation

Use `brief --repo` as the canonical check-in payload and `status --summary` for the current operating picture. Tell the owner what became possible, what remains uncertain, material departures from the target, spend against expectations, and decisions needing their input. Prefix a brief with at most ten lines of explanation; do not rewrite its facts into a separate report file. End a check-in turn after presenting it. Acknowledge the exact brief id only after the owner acknowledges it; a stale id requires a fresh brief.

Questions concern gaps the vision and corpus cannot decide. Rank them as `P-n`, each with a working assumption. Record chat answers promptly with `answer`; apply answers that affect this arc now. Future work and approved estate compaction decisions stay outside the product tree until Phase 0. Respect the owner's authorization for external irreversible actions; executor invocation spend is governed by the agreed arc operation, with no spend cap. Usage limits park a backend until an explicit backend resume.

## Bootstrap

Work on your own branch. The product needs committed `.roadmap/corpus.md`, `.roadmap/vision.json` and `.roadmap/config.json`.

- The corpus guide identifies its source, include patterns, vision path and curation standards. Discover the source from the repo before asking the owner.
- Use the `vision` skill to elicit and confirm the target world, then compile its record. Do not invent the owner's vision.
- Ask for `chain.k`: how many arcs may start beyond the last acknowledged brief before waiting? Use 1 as the working assumption; changes require the owner.
- Agree the first slice, including a world clause. Supply `systemsMap` in config: every unit names known systems. Tag persistent and redacting systems accurately.
- For browser journeys configure `walkthrough.mcp` and install the declared tools in the devcontainer. Validate the actual connection with Phase 0 checks. The expected browser drive is the installed Playwright MCP with Chromium, HTTP pages, isolated sessions and evidence output.

Schema-2 runs start with this release. Runs started on dev.32 or earlier are refused before host claim/recovery. Finish them with their original executor; a new arc may use plan `baseline` and `previousHead` to describe a foreign predecessor without a schema-2 arc ref.

## Corpus

The corpus is normative; system notes are memory. Read through the guide and curate for people as well as agents. Put every normative claim in a fenced `rules` block as `T-n: <one-line claim>`, one claim per id. Prose explains why. Principles belong in the census as `untestable`; operational claims that need production evidence are `prod-only`. The vision document contains no rules block.

Ids are global across arcs, never reused. Preserve an id for an equivalent rewording; changed meaning retires it and takes the next id above the registry high-water. Every new claim traces to source text or a recorded decision.

Curation has three cases:

- Structural cleanup and fact-currency corrections: act and record files/rules in `curation`.
- Semantic conflict the vision resolves: record a `corpusDivergences` entry with cited clauses and the pinned file preimage.
- Semantic conflict the vision leaves open: ask a ranked question and encode its working assumption. Never hide a contradiction in debt.

Corpus windows are Phase 0, the between-arc commit and application of an owner's answer. Re-pin after edits. Never edit the executor's materialized pin.

## Phase 0

Keep arc inputs in a dedicated directory outside the product working tree. Produce one coherent pack, review it in proportion to the change, and review material deltas. A strong review checks actual code and witnesses, not only agreement among documents.

Apply pending owner-approved compaction exactly as [estate-compaction](../estate-compaction/SKILL.md) "Applying the
record" teaches, following its worked example.

The pack must establish:

- **Target and slice.** A committed corpus, pin, confirmed vision, and Phase-0 record. `slice.advances` equals `holistic.advances`; include every clause delivered by the units and at least one active world clause. Explain why this slice now. Sweep prose for claims missing from rules and rules that combine distinct claims.
- **Obligations and census.** Extract the slice's testable properties, anchored to pinned rules. Give every active rule one census state: `obligation`, `out-of-slice`, `untestable` or `prod-only`. Existing preserved behavior is `must-hold`; not-yet-built behavior is `future` with delivering units. A proof judgment binds the statement revision and witness test ids/files. Witness names alone are insufficient: exercise the real entry point, make absence detectable, and judge that the tests prove the statement. Map impacts by system. Carry live obligations; omit already-retired families. Explain intentional weakening in the change reason and retain explicit dispositions where required.
- **Questions and debt.** Carry question ids and exact recorded answers. Disposition every open baseline debt item as promote, keep with reason, or resolve with a C-n ledger reference. Debt kept in both preceding arcs needs a question. Import abandoned work by explicit Phase-0 debt authoring, not fabricated runtime facts.
- **Plan.** Baseline, integration branch, worktree root, declared resources/environments, contracts, plain ledger and a DAG in dependency order. Every unit has nonempty `systems`, risk, resources and its spec path. Add explicit priorities, contingent edges or routing overrides only where useful. `expectations.arcUsd` and `perMilestoneUsd` are optional forecasts, never admission limits.
- **Specs.** Required `intent` and nonempty `nonGoals`, acceptance ids, declared checks, decisions and facts; cite the relevant contracts and inline the relevant pinned rule text in the authored material. Include obligation declarations and witnesses by exact test id/file. Acceptance items keep their ids when struck or deferred. Root-authored splits conserve parent text, systems, obligations, dependencies and milestone ownership. A builder's `tooBig` proposal is input to this decision.
- **Milestones.** Mark the smallest end-to-end experiences. Give each its member units, a preceding design unit (or supplied design), references, bring-up, journeys, resources and selected integration lanes. Units should depend on their design unit. References define the interface, quality floor and error language for what the milestone exposes; later milestones extend that language. Keep reference directories to design text, within the 512 KiB text budget. Browser and shell journeys state the task and any step/time budget. Breaks hold dependent work; deviations can be repaired alongside it.
- **Checks and resources.** Lane commands are exact argv/cwd/env, with evidence confined to outputs. Cheap local checks belong at build/unit cadence; expensive or explicitly whole-repo checks belong at candidate cadence. Shared-resource/cross-system checks use batch cadence and explicit milestone selection. Root-only resources must already be declared before later admissions; adding spike resources mid-arc requires owner resolution. A spike declares a question and resources: its gated report is the deliverable and its branch never merges.

Run `phase0 check` against the authored plan until refusing rows are resolved. Evaluate system overlap, design ordering, derived regeneration and lane-similarity advisories. Review `vacuous-future-witness` (existing future-test files may already pass) and `spanning-proof` (multi-unit delivery lacks a spanning candidate/batch lane) advisories. Commit the product inputs that must match HEAD, start, and read pack-review findings. Admission waits for review to end. Blocking unit findings hold those units and transitive dependents; other targets hold the arc. Read the item and evidence, then fix the pack for a superseding review or `ack` it (no option required). Pack revisions before first admission get delta review.

## Unit and milestone execution

Normal work is prepare → conditional pre-build annotation → grounded build → evidence/salvage/teardown → executable certification → gate → candidate on current integration tip → exact-head publication → snapshot/retirement. Reproduction precedes repair builds where required. Build, lanes and gate repeat as needed within bounds. A gate's context is fresh; it judges reach against intent/nonGoals, executable evidence and outstanding review items.

The verifier has pre-build, gate and diagnosis modes. Mechanical triggers are M1 system traits (also checked from actual reach and builder touches), M2 proof unavailable locally, M3 changed linked obligations/cited rules, and M4 repeated work. Pre-build annotates; its standing items must be addressed or rebutted with evidence at the gate. The builder grounds first and reports `specWrong`, `touches` and `tooBig`; a wrong spec goes to the root. Testing, persistence, redaction, cluster-proof, UI and performance methods are selected by code.

Diagnosis is due after **8 builds or 20 judged build/lanes/gate attempts**, including interrupted and uncharged attempts. It produces a kept build note. Remaining default-profile builds then use the Claude backend. A hard **16-build/40-stage** boundary raises `attempt-cap`; these are fixed thresholds, not `limits` knobs, and steering does not reset them. Review overrides `always|never` affect review calls; `never` suppresses diagnosis and its fallback marker, while caps still apply. Inspect the failure pattern and change the plan or lineage rather than repeatedly resuming a capped unit.

`default` mixes eligible low/medium-risk builds on Codex with Claude judgments. High risk, M2 and design units use Claude; M1 and capture-only units remain eligible for Codex. `claude-only` keeps every seat on Claude. Change a profile through a normal routing revision; records preserve the effective routing revision.

A milestone runs its selected lanes after its units retire, then a fresh experience verdict walks the journeys and proposes fixes/polish. One experience role also judges before/after polish. Campaign audits cover the whole selected range at milestones, on request and at the final boundary: invariants, vacuity, cross-unit interactions and document drift together. They report findings and root requests. Admit repairs through revised inputs; only the root changes obligation dispositions. Dismiss a false-positive open finding, including P1, with `roadmap dismiss <finding> --counter-evidence "<line>"`. Counter-evidence must be non-empty; the root decision records `{role:root,routingRev}`. Audit dismissal requests require root review and never apply themselves. Dismissal closes settled finding items and suppresses re-raising on unchanged cited code; never edit the journal.

## Supervision and intervention

Keep one actionable watch per arc while it runs, with the fixed 30-minute heartbeat. Start or switch plugin versions
with `watch --actionable --replace`; end supervision with `watch --stop`. Never kill a watch by process pattern.
On every wake, read `openBlocking` and act on every item in it, including items repeated from earlier wakes. Read
`status --summary`, then full status and cited evidence for each affected subject. Post at most 3 lines in chat:
what moved, what is next, anything odd. Return to the same watch; use its sequence with `--from` when restarting.
The heartbeat is the organic check; do not add habitual polling. Before ending a turn while the arc runs, confirm
`status --summary` shows supervision live. The summary reports progress, spend/expectations, milestone verdicts, caught counts, captures and waste. Its caught total is lane reds + gate revise outcomes + unique finding keys; it is an activity aggregate, not a count of independently verified defects. Capture entries list suite capture invocations; inspect gate evidence for spec captures.

Exercise the smallest action that resolves the cause:

- **Change requirements or plan:** export current inputs, edit, CAS apply with revision and one-line reason.
- **Redirect an unfinished build:** steer with a concrete brief and editing budget. A running workload is killed and quiesced first. Use `--resume` when a green pass should proceed; otherwise it parks for root review.
- **Inform the next round:** note a brief without killing the current build. It lands as a kept note in the next build inputs.
- **Dismiss a false positive:** dismiss the named open finding with a concrete counter-evidence line, after reviewing any audit request.
- **Supply external proof:** witness an external-class obligation with pass/fail and a file or URL. Evidence binds the submission head; a fail reopens its delivering lineage.
- **Resolve readiness:** resolve-edge with evidence; merge-in the current tip when needed; clear run-only after targeted work.
- **Control execution:** pause/resume a unit or all; resume an unavailable backend explicitly; stop to quiesce the arc; sweep only after checking residue evidence.

Successful subject actions close the relevant optionless needs-user items. **Ack is only for items with offered options**; use the offered option id. A plain ack is not a substitute for fixing a spec, supplying evidence or resuming a backend. Revision notices and waste findings are non-blocking. Inspect their evidence and resolve their subject as appropriate.

Log every self-initiated intervention once in `<repo>/../roadmap-inputs/skill-feedback.md` (append-only): symptom,
evidence, outcome, and the executor improvement that would remove the need. Routine Phase 0/start/PR/check-ins and
following an item recommendation are not interventions. Every arc-wide pause, resume-all, backend resume, stop and
close-admissions gets an entry whoever requested it; record when it ended. Do not poll by habit or hide an intervention in unexplained state edits. Escalate uncertainty the owner's target cannot settle, with the evidence and a working assumption.

## Changing inputs

The canonical edit path is `inputs export` → edit the export → `apply --from <dir> --rev <export.planRev> --reason <line>` (optionally dry-run first). Leave `export.json` intact. An edited file must still equal its exported base in force; untouched files take the newest in-force bytes. All stale files are reported together. Re-export and reapply your intended edits if refused. Code automatically advances each edited existing spec's rev; do not manufacture revision histories.

Apply reasons authorize intentional contract/obligation changes. Preserve frozen-contract checks, no-drop split text, proof judgments, citations and dependency conservation. Contract document behavior changes land through gate-reviewed units. The C-n ledger is plain root-facing text, exported with the pack; it does not patch product contracts. Existing wire fields such as `rulings`, `cites.rulings` and debt `resolve.ruling` still name this ledger.

Apply queues at safe boundaries when necessary; read the durable receipt through applied or rejected. Changing arbitrary copies beside the original plan does nothing. Never hand-edit kept inputs, journal facts, receipts, needs-user files, integration refs or runtime state.

## Evidence, memory and recovery

Lane reuse hashes declared `inputs`, else the appropriate systems input; it also binds command/environment identity. Keep witness ids stable across lane moves and refresh proof only when its test ids/files or statement change. Run targeted development checks; let the executor certify full lanes. A repeated red is compared at diffBase: green there supplies regression evidence to the fix round; red there follows the base-red protocol. Never weaken tests to make a lane green. Declare deterministic fixtures for clocks and time zones.

Capture lanes bring up a contained stack and repo capture script on a leased port and retain every declared PNG state. Gate capture evidence is supplied only to the milestone's design/member units. Resource probe/teardown commands must label their own workload and clean it; declare pools and environment lifecycle honestly. Evidence globs must not hide tracked product/test files or protected paths.

`docs/systems/<system>.md` (configurable as `systemNotesDir`) carries non-normative gotchas, seams and rigs. Build/gate receive existing note paths from their checkout commit. Edit notes as normal unit diffs, with gate review. Normative claims stay in the corpus. Salvage and candidate commit bodies retain captured build summaries and decisions; recovery uses verified evidence bytes.

Recover by reading status and durable evidence, exporting inputs if needed, and restarting through `start` or `resume-arc`. A dead-owner boot hook can invoke `resume-arc --repo`; propose devcontainer edits within the owner's authorization. Never adopt schema-1 runtime state or delete it to force a start. The root never patches the plugin or run directory. At supervisor-crash-limit, read the cited executor stderr logs,
report the error and stack to the owner in a final check-in, and stop with reason owner; do not ack/restart around it.
The supervisor owns restart/backoff; containment emptiness precedes releasing resources or reading terminal outputs. Session containment cannot prevent a process that deliberately escapes it; cgroup mode requires host support.

## Completion

Close admissions when the intended slice is complete. Let final audit, selected witnesses, batch lanes, close-out document publication and snapshots settle. Distinguish a completed active arc from a sealed one; report outstanding findings and debt honestly. Prepare the stacked PR with `pr`, then present the brief and demo location/rough edges. Demo controls are up/down/hold/release; promotion never restarts a held demo.

Use `chain status` before another start. Prepare the next baseline on your own checkout, preserving the previous head and allowed between-arc corpus/config/vision changes. Stop when the vision is silent or the acknowledged chain bound disallows another start. Lookup details belong in the reference.
