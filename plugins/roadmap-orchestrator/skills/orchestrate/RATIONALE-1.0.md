# Roadmap Orchestrator 1.0: rationale

Maintainer background for the command-center release, **1.0.0-dev.33**. Operating instructions live in SKILL.md;
wire contracts live in executor/SCHEMAS.md. Historical designs and the old arc-1 record explain how the system arrived
here, but do not override current code. This document explains the choices that remain.

## 1. An executor owns exact work

Long unattended runs fail when an interactive agent must remember which child, lock, checkout or test still exists.
The executor owns these resources and records effects write-ahead. Runners outlive an executor crash, publish durable
terminal files only after quiescence, and permit reattachment. Judgment belongs to models; lifecycle belongs to code.

This has a deliberately narrow host contract: one executor per single-UID Linux host. Session containment stops ordinary
workload descendants; it cannot promise containment of deliberate escape. Cgroup mode is experimental and depends on
real delegated host support. Reporting the narrower guarantee is more useful than pretending unavailable isolation works.

## 2. Recovery is replay of evidence

An intent records the expected effect before it happens. Deterministic git identities, content hashes, exact refs and
postcondition checks make the effect repeatable. Done/abort records close it. Immutable kept inputs and the journal,
rather than current mutable files, decide what a resumed attempt means. Raw evidence stays out of product branches;
verified allowlisted snapshots remain enough for later briefs and chain validation.

Completed lane evidence needs its final writer marker. A crash halfway through capture is not a completed certificate,
and missing metadata cannot be defaulted into proof. This matters both to sound reuse and to recovering the same git
commit from captured report bytes.

## 3. The root should make decisions

The root already owns target interpretation and the owner conversation. Giving it a real compare-and-swap edit path
lets it act directly without coordinating another autonomous plan author. Export captures a revision and file manifest;
apply accepts edited files only when their bases are still current and takes newer untouched bytes. File-level conflict
is predictable: unrelated files can proceed, overlapping edits refuse together. Edited specs automatically advance their
revision, preventing silent mismatch between text and identity.

Every edit carries a short reason. Frozen-contract checks, obligation proof, no-drop splits, dependency/milestone
conservation and risk floors remain mechanical. Reasons give decisions provenance without adding another consistency
judgment. The C-n ledger remains plain root-facing text because existing references/debt still use it; it has no authority
to patch product contracts. Contract changes are normal units with gates.

## 4. Responsibility is a system, not a file list

A file fence encourages repetitive intervention whenever real implementation discovers a caller, test or generated file
outside the guessed list. Units instead declare systems, intent and non-goals. The gate sees actual reach outside those
systems and decides whether the change serves the unit. The root receives overlap advice during Phase 0.

This does not discard exact protection: one protectedPaths definition guards roadmap and pinned corpus paths at every
write boundary. Systems also drive lane impact and witness selection, while unmapped files select conservatively. Trait
tags supply mechanical persistence/redaction review triggers without banning a capable builder from those units.

## 5. Independent review is conditional

A fresh context is the source of independence; a different vendor is not required. The verifier has pre-build, gate and
diagnosis modes sharing one schema and method base. M1 persistent/redacts traits, M2 non-local proof and M3 changed
meaning justify early annotation. Review findings become standing gate items and need evidence-backed dispositions.
A failed annotation call does not hold an otherwise runnable unit.

Builders ground before editing and can say the spec is wrong or too large. This uses the implementation context for
questions it can actually answer. It does not let a builder waive its acceptance or split the plan. The root decides.
Testing, persistence, redaction, cluster-proof, UI and performance methods are selected from real inputs; they do not
require another agent to negotiate which method applies.

## 6. Count work that did not earn a charge

Chargeable failures undercount grinding: a unit can spend many builds on certification reds that are intentionally
uncharged. Diagnosis therefore counts every build/lanes/gate attempt, including interruption and lineage history.
The measured m5 calibration motivated 8 builds/20 judged attempts for diagnosis and twice those values for a hard stop.
Those thresholds are fixed in code, separate from ordinary limits. A diagnosis adds a note and shifts the remaining mixed
profile builds to Claude. Repeated steering cannot erase the cap and spend indefinitely.

## 7. Certify at the right place

Cheap local checks belong in development and unit certification. Expensive local checks belong on the current candidate
tip, retaining delivering-unit attribution. Shared-resource/cross-system checks belong at batch/milestone boundaries.
This reduces repetitive expensive runs without claiming an untested unit branch is the final merge result.

Explicit lane inputs narrow reuse keys to actual tree inputs; systems are the fallback. Reuse still binds execution/
environment identity and clean completed certificates. Repeated reds are compared at diffBase: red there is an upstream
problem, green there is regression evidence for the fix round. Original failing and passing directories survive reuse.
Observed execution evidence drives waste measurements.

## 8. Evidence must witness a claim

A test name proves nothing by itself. Required witnesses declare exact ids/files, run all of them, and distinguish
missing/skipped/failed from pass. Proof judgments bind statement revision and ids/files, not lane revision: moving the
same tests to a different lane is a re-witness, not weakening. Bounded mutation smoke checks that production removal can
kill the test, while survivors and inconclusive runs remain explicit gate evidence.

External proof cannot be reduced to matching a green phrase. The root attests to an external-class obligation with
head-bound file/URL evidence. File hashes detect tampering; a moved integration head refuses stale submission. A red
submission reopens the delivering lineage. Capture lanes likewise retain declared PNG states from a contained stack and
repo script on a leased port, so related gates judge actual artifacts.

## 9. Test the head that will be published

Candidate-first merge preserves the exact-head invariant. Certification is performed on a candidate of the current
integration tip and unit head. Publication checks that identity again before ff. A moved tip means retry, not permission
to publish another tree. Repair batching amortizes the serial slot while retaining each member's evidence and memory.
Document publication uses the same slot and can preempt uncharged; publication never precedes durable intent.

## 10. Review both the experience and the campaign

Unit gates cannot see every cross-unit interaction or the experience a user meets. Milestones define the smallest usable
end-to-end surfaces, with design references, real bring-up and browser/shell journeys. One experience role walks them and
judges polish comparisons. A break holds downstream work that would need rework; a deviation can improve alongside it.

One fresh campaign audit at milestones, on root request and at the final boundary judges invariants, vacuity,
interactions and cheap document drift together. Bounded attachments/chunks preserve coverage across failures. It reports
findings and root requests rather than silently changing the target. P1 needs repair or evidence-backed dismissal. Root dismiss records counter-evidence and actor/routing provenance;
audit requests leave that decision with the root. Code can also dismiss a mutant that does not reproduce.
Only the root dispositions obligations. This keeps unattended work useful without allowing independent workers to move
the goalposts.

## 11. A command center needs useful summaries

The root needs to know what happened and which action resolves it. Status is read-only and concurrent; its summary shows
progress, spend/expectations, verdicts, captures, needs-user items and advisory waste. The caught total is an activity sum
(lane reds, gate revisions, unique finding keys), not a claim of unique defects. Suite capture spawns are the current
summary projection; gate evidence is the place to inspect related spec captures.

Needs-user closure belongs to the successful subject action. An optionless item is resolved by fixing its cause; ack is
reserved for offered options. This avoids a second bookkeeping action after every real intervention. Waste and executor
revision notices inform without holding. Waste detection does not authorize automatic tuning of the plan.

## 12. Memory should survive without becoming law

A build's report and decisions explain why a commit exists. Salvage and candidate messages retain them from verified
captured bytes, including when the builder committed everything itself. Recovery can reconstruct the same object rather
than invent a fresh message from live files.

System notes at docs/systems (configurable) preserve gotchas, seams and rigs. Build/gate get existing paths at the checkout
commit and note edits are normal gated diffs. Normative claims remain in the corpus. Mixing these two authorities would
make convenience notes a hidden second specification.

## 13. Cost visibility is not a spend cap

The owner's unattended objective calls for useful convergence, not parking at an arbitrary dollar boundary. Expectations
are forecasts; usage limits are actual backend availability and require explicit resume. Codex token usage is preserved
even when native cost is absent, with price-table estimates flagged. Standard-rate estimates cannot recover per-request
long-context billing from aggregated CLI usage. Effective routing revisions record the actual fallback/profile used.

Both profiles keep Claude judgments. Default retains eligible Codex builds to share subscription load; high risk, M2,
design and diagnosis fallback use Claude. M1 and capture-only UI remain eligible. Claude-only provides the acceptance path
for environments that need it, and a mid-arc profile change is an ordinary revision.

## 14. Check-ins and bounded autonomy

A canonical brief hashes the whole payload, uses the last acknowledged coverage vector and renders from that data alone.
The root adds a short explanation and presents owner questions with working assumptions. Exact acknowledgement is
replayable through a pending marker and bounds how many more arcs may start. It is not a generic runtime dismissal.

Corpus windows, stable rule ids, the census, ranked questions and open-debt dispositions make the next arc deliberate.
Estate compaction records explicit owner approval and applies through normal inputs. Foreign predecessors use baseline/
previousHead without pretending a schema-1 runtime was adopted. Dev.33 is a one-off schema-2 breaking exception; future
updates return to upgrade-in-place. The dev.32 refusal regression records that boundary.

## Standing implementation decisions

- **Roles, not models.** State records `{role,routingRev}`; only routing binds model ids. Prompts are explicit per
  (role, model), with declared inheritance/unsupported pairs. `state.no-model-ids` guards the record boundary, so changing
  a provider does not rewrite domain history or silently reuse an untested prompt.
- **Peer backends through files.** Both CLIs run under the same runner/process interface. Launch, stdout/stderr, exit
  and result files survive parent death; pipes alone would lose the evidence needed for adoption. Adapters are pure over
  quiescent files and can rerun. Backend smoke actually asks for a real shell command, testing tool execution and parsing
  rather than accepting a model's claim that the CLI works.
- **DAG plus resource locks.** Independent units progress without sharing checkouts. All-or-none reservations prevent
  partial acquisition deadlocks; reserved → running → cleaning → free ties release to cleanup. Failed cleanup leaves a
  durable residue, withholding the instance until probing/sweep cleans or isolation dispositions it. Startup refuses
  foreign residues so another arc cannot inherit an unaccounted workload.
- **Clean PRs.** Product branches carry product changes and living `.roadmap/` documents. Runtime and raw evidence stay
  outside the tree. `refs/roadmap/<arc>` carries allowlisted records with a SHA-256 manifest, preserving verified chain/
  brief evidence without polluting product review.
- **Failing output survives.** A red lane retains newly written/changed ignored output (bounded, with secret exclusions)
  in its evidence. Otherwise the very report needed for a fix disappears when the disposable checkout is removed.
- **Executable before judged.** `witness-check` checks exact ids, including missing/skipped tests, before a green-looking
  suite becomes proof. Mutation smoke executes a bounded production-removal variant; survivors/inconclusive runs remain
  visible. Reading test source is useful judgment, not evidence that the negative case fails.
- **Clocks are spec guidance (R39).** Specs ask for product clock seams, shifted dates/time zones and injected timeouts.
  The executor does not invent a universal fake clock for arbitrary products; doing so would conceal untested seams.
- **Supervision through levers, with a log (OR-A3).** Actionable watch and a 30-minute heartbeat bound root attention.
  Three-line notes keep the owner informed; supported commands retain provenance. The append-only operator log explains
  self-initiated interventions and all arc-wide controls, including when a pause ended. The root never patches plugin/
  runtime state: a defect is reported with evidence so repairs do not hide the failed experiment.
- **An eval ladder.** Typed/free tests prove deterministic readers, real git/process behavior and crash replay at
  `crashPoint(label[@unit]:n)` boundaries. Real CLI probes prove invocation/adaptation; role trials grade catches and
  false blocks; paid fixtures test orchestration and independent M4a adjudication (with its forge-isolation canary).
  Each tier proves a different claim; none licenses a week-long reliability claim by itself.

A 0.x layout is refused, never converted. Dev.33 separately refuses schema 1; later schema-2 releases return to the
standing upgrade-in-place rule.
