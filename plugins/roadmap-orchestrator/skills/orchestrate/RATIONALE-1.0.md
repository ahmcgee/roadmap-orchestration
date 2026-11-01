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
Estimated lane minutes were removed because neither scheduling nor summary consumes them; observed evidence drives waste.

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
findings and root requests rather than silently changing the target. P1 currently needs repair or code-owned not-reproduced dismissal. An explicit root finding-disposition channel is
missing from the current CLI/apply inputs and remains a gap against the design delta.
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
